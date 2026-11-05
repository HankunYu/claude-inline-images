#!/usr/bin/env python3
"""Display an image at full resolution via the kitty graphics protocol.

Unlike chafa, which downsamples to (cells x assumed cell pixels) before sending,
this sends the original PNG and only tells the terminal how many cells to cover,
so the terminal scales it with the display's real (Retina) pixel density.

By default the image is scaled to fill the current pane while keeping its aspect
ratio; --cols / --rows cap the size instead.

Usage: kitty-img.py IMAGE [--cols N] [--rows N] [--max-px N]
"""
import argparse
import base64
import json
import os
import re
import select
import shutil
import struct
import subprocess
import sys
import tempfile
import termios
import tty

PngMagic = b"\x89PNG\r\n\x1a\n"
ChunkSize = 4096


def sips_longest_side(path):
    """Longest side in pixels as reported by sips; 0 if unknown."""
    result = subprocess.run(["sips", "-g", "pixelWidth", "-g", "pixelHeight", path],
                            capture_output=True, text=True)
    sides = [int(n) for n in re.findall(r"pixel(?:Width|Height):\s*(\d+)", result.stdout)]
    return max(sides, default=0)


def to_png(path, max_px, workdir):
    """Return PNG bytes for path, converting and capping the longest side if needed."""
    with open(path, "rb") as f:
        data = f.read()
    is_png = data.startswith(PngMagic)
    if is_png and (not max_px or max(png_size(data)) <= max_px):
        return data

    out = os.path.join(workdir, "image.png")
    if shutil.which("sips"):
        cmd = ["sips", "-s", "format", "png"]
        # sips -Z also upscales, so only pass it when the image exceeds the cap
        if max_px and sips_longest_side(path) > max_px:
            cmd += ["-Z", str(max_px)]
        cmd += [path, "--out", out]
    elif shutil.which("magick") or shutil.which("convert"):
        cmd = [shutil.which("magick") or shutil.which("convert"), path]
        if max_px:
            cmd += ["-resize", f"{max_px}x{max_px}>"]
        cmd += [out]
    elif data.startswith(PngMagic):
        return data  # cannot resize, but PNG is still displayable
    else:
        return None
    subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    with open(out, "rb") as f:
        return f.read()


def png_size(png):
    """Width and height from the PNG IHDR chunk."""
    return struct.unpack(">II", png[16:24])


def cell_aspect():
    """Cell height / width in pixels, asked from the terminal (CSI 16 t); 2.0 if unknown."""
    if not sys.stdin.isatty():
        return 2.0
    fd = sys.stdin.fileno()
    old = termios.tcgetattr(fd)
    try:
        tty.setraw(fd)
        os.write(sys.stdout.fileno(), b"\x1b[16t")
        reply = b""
        while select.select([fd], [], [], 0.5)[0]:
            reply += os.read(fd, 64)
            if reply.endswith(b"t"):
                break
    finally:
        termios.tcsetattr(fd, termios.TCSADRAIN, old)
    match = re.search(rb"\x1b\[6;(\d+);(\d+)t", reply)
    if match and int(match.group(2)):
        return int(match.group(1)) / int(match.group(2))
    return 2.0


def rex_cmd(*args):
    """Run the rex CLI and parse its JSON output; None on any failure."""
    rex = shutil.which("rex") or os.path.join(os.environ.get("REX_BIN_DIR", ""), "rex")
    try:
        out = subprocess.run([rex, *args], check=True, capture_output=True, text=True, timeout=5).stdout
        return json.loads(out) if out.strip() else {}
    except (OSError, subprocess.SubprocessError, ValueError):
        return None


def layout_leaves(node):
    """Yield (rect, block_id) for every block in a Rex layout tree."""
    if "block_id" in node:
        yield node["rect"], node["block_id"]
    split = node.get("split")
    if split:
        yield from layout_leaves(split["before"])
        yield from layout_leaves(split["after"])


def rex_geometry():
    """Real (cols, rows, cell_aspect) of this Rex pane, or None outside Rex.

    A pane Rex created in the background often keeps the default 80x24 until a
    client takes it over, so derive its size from a client-owned sibling pane in
    the same window and the layout's rect fractions, then resize this terminal to
    match (allowed while no client owns it).
    """
    session, block = os.environ.get("REX_SESSION"), os.environ.get("REX_BLOCK")
    if not session or not block:
        return None
    own = rex_cmd("block", "call", "-s", session, "-b", block, "size")
    if own is None:
        return None

    def aspect(size):
        cw, ch = size.get("cell_width_px"), size.get("cell_height_px")
        return ch / cw if cw and ch else 2.0

    if own.get("owner") and own.get("desired"):
        return own["columns"], own["rows"], aspect(own)

    view = rex_cmd("api", "call", "-s", session, "session.view", "{}")
    for window in (view or {}).get("windows", []):
        leaves = [leaf for layer in window.get("layers", []) for leaf in layout_leaves(layer["layout"])]
        own_rect = next((rect for rect, bid in leaves if bid == block), None)
        if not own_rect:
            continue
        for rect, bid in leaves:
            if bid == block:
                continue
            size = rex_cmd("block", "call", "-s", session, "-b", bid, "size")
            if not size or not size.get("owner") or not size.get("desired"):
                continue
            total_cols = size["columns"] / rect[2]
            total_rows = size["rows"] / rect[3]
            cols = max(int(total_cols * own_rect[2]) - 1, 1)
            rows = max(int(total_rows * own_rect[3]) - 1, 1)
            rex_cmd("block", "call", "-s", session, "-b", block, "resize",
                    json.dumps({"columns": cols, "rows": rows}))
            return cols, rows, aspect(size)
    return None


def fit_cells(png, cols, rows):
    """Largest cols x rows that fits the requested (or pane) box and keeps aspect ratio."""
    if cols and rows:
        return cols, rows
    geometry = rex_geometry()
    if geometry:
        pane_cols, pane_rows, ratio = geometry
    else:
        term = shutil.get_terminal_size((80, 24))
        pane_cols, pane_rows, ratio = term.columns, term.lines, cell_aspect()
    max_cols = cols or pane_cols
    max_rows = rows or max(pane_rows - 2, 1)  # leave room for a header line and the prompt
    width, height = png_size(png)
    # Image aspect expressed in cells: cells are taller than wide
    cells_ratio = (width / height) * ratio
    fit_cols = min(max_cols, round(max_rows * cells_ratio))
    fit_rows = min(max_rows, round(fit_cols / cells_ratio))
    return max(fit_cols, 1), max(fit_rows, 1)


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("image")
    parser.add_argument("--cols", type=int, help="max width in cells (default: fill the pane)")
    parser.add_argument("--rows", type=int, help="max height in cells (default: fill the pane)")
    parser.add_argument("--max-px", type=int, default=2400,
                        help="cap the longest side in pixels before sending (0 = send as-is)")
    parser.add_argument("-v", "--verbose", action="store_true", help="print the chosen size to stderr")
    args = parser.parse_args()

    with tempfile.TemporaryDirectory() as workdir:
        path = args.image
        if path == "-":
            # Image piped in, e.g. `ssh host cat img.png | kitty-img.py -`
            path = os.path.join(workdir, "stdin-image")
            with open(path, "wb") as f:
                f.write(sys.stdin.buffer.read())
        png = to_png(path, args.max_px, workdir)
        if png is None:
            # No converter for a non-PNG input: fall back to chafa (lower resolution)
            size = f"{args.cols or 80}x{args.rows or 40}"
            sys.stdout.flush()
            subprocess.run(["chafa", "-f", "kitty", "-s", size, path])
            return

    cols, rows = fit_cells(png, args.cols, args.rows)
    if args.verbose:
        width, height = png_size(png)
        print(f"kitty-img: {width}x{height}px -> {cols}x{rows} cells", file=sys.stderr)
    payload = base64.standard_b64encode(png).decode()
    size = f"c={cols},r={rows}"
    out = sys.stdout
    chunks = [payload[i:i + ChunkSize] for i in range(0, len(payload), ChunkSize)]
    for i, chunk in enumerate(chunks):
        more = 1 if i < len(chunks) - 1 else 0
        head = f"a=T,f=100,{size},q=2," if i == 0 else ""
        out.write(f"\x1b_G{head}m={more};{chunk}\x1b\\")
    out.write("\n")
    out.flush()


if __name__ == "__main__":
    main()
