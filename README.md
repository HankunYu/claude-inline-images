# inline-images

A Claude Code mod that draws images **inside the conversation**. Out of the box the
terminal UI only shows `[Image #1]`; with this mod you see the picture itself.

- **Read results**: when Claude reads an image file, the picture is drawn under the
  tool call (also under folded "Read 3 files" groups).
- **MCP screenshots**: image blocks returned by MCP tools (browser screenshots and
  the like) are drawn under the call.
- **`show_image` tool**: Claude can show you an image without loading it into its
  own context (cheaper than Read). Inline when the terminal can draw it, otherwise a
  [Rex](https://www.superlogical.com/rex) pane beside the chat, otherwise macOS Preview.
- **`/img-size <rows> [columns]`**: sets the maximum height and, optionally, width of
  inline images (default 20 rows and 120 columns, remembered across sessions); the width
  never exceeds the terminal's. `/img-size` shows the current limits, `/img-size reset`
  restores the defaults.

Non-PNG images are converted with `sips` (macOS) or ImageMagick (`magick` /
`convert`), and pictures are shrunk to the box they are drawn in (about 16x32 px per
cell, a Retina display's density) before sending, so the terminal does not rescale a
large picture on every frame while you scroll.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install inline-images --marketplace HankunYu/claude-inline-images
```

Answer `y` to add the marketplace, then pick a scope (user scope loads it in every
session). From a shell:

```
claude plugin install inline-images --marketplace HankunYu/claude-inline-images
```

## Requirements

- A Claude Code build with mods (function hooks); developed and tested on 2.1.318.
- A terminal Claude Code draws images in: **kitty** (0.28+) and **Ghostty** are
  detected automatically.
- **Rex** draws them too (kitty Unicode placeholders), but is not detected: export
  `CLAUDE_CODE_FORCE_TERMINAL_IMAGES=1` **before** starting `claude`, e.g. in `~/.zshrc`:

  ```sh
  [[ "$TERM_PROGRAM" == "rex" ]] && export CLAUDE_CODE_FORCE_TERMINAL_IMAGES=1
  ```

  Claude Code reads its environment once at startup, so setting it later (or
  `/restart`) has no effect: start a new shell, then `claude --continue`.
- Other terminals (or tmux/screen): inline drawing is off; `show_image` falls back to
  a Rex pane (`scripts/kitty-img.py`, needs `python3`) or `open` on macOS.

## Limitations

- Images you paste into your own prompt are not drawn (the message row carries no
  image data for a mod to read).
- The mods API is early access and may change between Claude Code releases.

## Development

```
claude plugin validate .
claude plugin test .
claude --plugin-dir .
```

## License

MIT
