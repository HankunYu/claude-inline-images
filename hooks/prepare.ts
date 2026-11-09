import type { EngineInterface } from 'claude-code'

import { Shared } from './shared'

// A picture ready for the terminal's Image element: whole PNG bytes plus its size,
// the identity it is cached under, and the PNG file it was read from, if any.
export type Prepared = { png: string; width: number; height: number; key: string; file?: string }

// Image element takes at most 2 MiB of decoded bytes.
const MaxBytes = 2 * 1024 * 1024
// Longest side sent to the terminal; larger pictures are shrunk first.
const MaxPixels = 2000
const PngMagic = [0x89, 0x50, 0x4e, 0x47]
// Device pixels one terminal cell shows: a ~13pt font on a 2x (Retina) display.
// Pictures are shrunk to their cell box at this density before they are sent, as the
// terminal rescales the whole picture on every frame it draws (scrolling included).
const PixelsPerColumn = 16
const PixelsPerRow = 32
// Not worth a re-encode when the picture is already within this much of its box.
const MinShrink = 0.9

type Converter = 'sips' | 'magick' | 'convert' | 'none'

const converters = new Shared<Converter>()
const cacheDirs = new Shared<string>()
// Keyed by source identity; a hot reload empties it, which only costs a re-convert.
const images = new Shared<Prepared>()

const Base64Alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

// Decode only the head of a base64 string: enough for a PNG header.
function headBytes(base64: string, count: number): Uint8Array
{
    const chars = base64.slice(0, Math.ceil(count / 3) * 4)
    const out: number[] = []
    for (let i = 0; i + 3 < chars.length; i += 4)
    {
        const n = [0, 1, 2, 3].map(k => Math.max(0, Base64Alphabet.indexOf(chars[i + k] ?? 'A')))
        const bits = (n[0]! << 18) | (n[1]! << 12) | (n[2]! << 6) | n[3]!
        out.push((bits >> 16) & 0xff, (bits >> 8) & 0xff, bits & 0xff)
    }

    return new Uint8Array(out.slice(0, count))
}

// Decoded byte count of a base64 string.
function decodedLength(base64: string): number
{
    const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0

    return Math.floor((base64.length * 3) / 4) - padding
}

export function pngSize(base64: string): { width: number; height: number } | undefined
{
    const bytes = headBytes(base64, 24)

    if (bytes.length < 24 || PngMagic.some((b, i) => bytes[i] !== b))
    {
        return undefined
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

    return { width: view.getUint32(16), height: view.getUint32(20) }
}

function detectConverter($: EngineInterface): Promise<Converter>
{
    return converters.get('converter', async () =>
    {
        for (const name of ['sips', 'magick', 'convert'] as const)
        {
            const { exitCode } = await $.process.run(['sh', '-c', `command -v ${name}`])
            if (exitCode === 0)
            {
                return name
            }
        }

        return 'none' as const
    })
}

function cacheDir($: EngineInterface): Promise<string>
{
    return cacheDirs.get('dir', async () =>
    {
        const tmp = ((await $.env.get('TMPDIR')) ?? '/tmp').replace(/\/+$/, '')
        const dir = `${tmp}/claude-inline-images`
        await $.process.run(['mkdir', '-p', dir])

        return dir
    })
}

async function hashOf(text: string): Promise<string>
{
    const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(text))

    return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('')
}

async function readPng($: EngineInterface, path: string, key: string): Promise<Prepared | undefined>
{
    const { base64 } = await $.fs.read(path, { as: 'bytes' })
    const size = pngSize(base64)

    return size ? { png: base64, ...size, key, file: path } : undefined
}

// Write base64 bytes to a file through base64 -d (fs.write takes text only).
async function spill($: EngineInterface, base64: string, path: string): Promise<void>
{
    const { exitCode } = await $.process.run(['sh', '-c', 'base64 -d > "$1"', 'sh', path], { stdin: base64 })
    if (exitCode !== 0)
    {
        throw new Error('cannot decode image bytes')
    }
}

async function pixelSize($: EngineInterface, converter: Converter, path: string)
{
    const argv = converter === 'sips'
        ? ['sips', '-g', 'pixelWidth', '-g', 'pixelHeight', path]
        : converter === 'magick'
            ? ['magick', 'identify', '-format', '%w %h', `${path}[0]`]
            : ['identify', '-format', '%w %h', `${path}[0]`]
    const { stdout } = await $.process.run(argv)
    const numbers = (stdout.match(/\d+/g) ?? []).map(Number)
    const width = converter === 'sips' ? Number(stdout.match(/pixelWidth:\s*(\d+)/)?.[1]) : (numbers[0] ?? 0)
    const height = converter === 'sips' ? Number(stdout.match(/pixelHeight:\s*(\d+)/)?.[1]) : (numbers[1] ?? 0)

    return width > 0 && height > 0 ? { width, height } : undefined
}

// Convert any readable picture to a PNG whose longest side is at most `limit`.
async function convert($: EngineInterface, source: string, out: string, limit: number): Promise<boolean>
{
    const converter = await detectConverter($)
    if (converter === 'none')
    {
        return false
    }
    if (converter === 'sips')
    {
        const size = await pixelSize($, converter, source)
        const shrink = size !== undefined && Math.max(size.width, size.height) > limit
        const argv = ['sips', '-s', 'format', 'png', ...(shrink ? ['-Z', String(limit)] : []), source, '--out', out]

        return (await $.process.run(argv)).exitCode === 0
    }
    const argv = [converter, `${source}[0]`, '-resize', `${limit}x${limit}>`, out]

    return (await $.process.run(argv)).exitCode === 0
}

async function prepareFile($: EngineInterface, path: string, key: string): Promise<Prepared>
{
    const stat = await $.fs.stat(path)
    if (stat.kind !== 'file')
    {
        throw new Error(`${path} is not a file`)
    }
    if (/\.png$/i.test(path) && stat.size <= MaxBytes)
    {
        const direct = await readPng($, path, key)
        if (direct && Math.max(direct.width, direct.height) <= MaxPixels)
        {
            return direct
        }
    }
    const out = `${await cacheDir($)}/${await hashOf(key)}.png`
    for (const limit of [MaxPixels, 1400, 1000, 700])
    {
        if (!(await convert($, path, out, limit)))
        {
            throw new Error(`cannot convert ${path} to PNG (no sips or ImageMagick, or unreadable)`)
        }
        const { size } = await $.fs.stat(out)
        if (size <= MaxBytes)
        {
            const prepared = await readPng($, out, key)
            if (prepared)
            {
                return prepared
            }
        }
    }
    throw new Error(`${path} stays over 2 MiB as PNG`)
}

// A picture on disk, by absolute path.
export async function prepareFromPath($: EngineInterface, path: string): Promise<Prepared>
{
    const stat = await $.fs.stat(path)
    const key = `file:${path}:${stat.mtimeMs}:${stat.size}`

    return images.get(key, () => prepareFile($, path, key))
}

// A picture held as base64 bytes (an MCP or tool result block).
export async function prepareFromBase64($: EngineInterface, base64: string, mimeType: string | undefined): Promise<Prepared>
{
    const key = `bytes:${await hashOf(base64)}`

    return images.get(key, async () =>
    {
        const size = pngSize(base64)
        if (size && decodedLength(base64) <= MaxBytes && Math.max(size.width, size.height) <= MaxPixels)
        {
            return { png: base64, ...size, key }
        }
        // Spill to disk, then convert.
        const ext = (mimeType ?? 'image/png').split('/')[1]?.replace(/[^a-z0-9]/gi, '') || 'bin'
        const raw = `${await cacheDir($)}/${key.slice(6)}.src.${ext}`
        await spill($, base64, raw)

        return prepareFile($, raw, key)
    })
}

// Cell box for a picture: fit the width, keep the aspect ratio, cap the height.
export function fitCells(
    size: { width: number; height: number },
    room: { columns: number; maxRows: number },
): { columns: number; rows: number }
{
    // A terminal cell is about half as wide as it is tall.
    const cellAspect = 0.5
    // Small pictures are not blown up past ~10 px per column.
    const natural = Math.max(1, Math.ceil(size.width / 10))
    let columns = Math.max(1, Math.min(room.columns, natural, 255))
    let rows = Math.ceil((columns * cellAspect * size.height) / size.width)
    if (rows > room.maxRows)
    {
        rows = room.maxRows
        columns = Math.max(1, Math.min(columns, Math.ceil((rows * size.width) / (size.height * cellAspect))))
    }

    return { columns, rows: Math.max(1, Math.min(rows, 255)) }
}

// Longest side, in pixels, of a picture shrunk into its cell box; undefined when it
// already fits (or nearly does) and is sent as it is.
export function shrunkSide(
    size: { width: number; height: number },
    cells: { columns: number; rows: number },
): number | undefined
{
    const scale = Math.min((cells.columns * PixelsPerColumn) / size.width, (cells.rows * PixelsPerRow) / size.height)

    return scale < MinShrink ? Math.max(1, Math.ceil(Math.max(size.width, size.height) * scale)) : undefined
}

// The picture as the terminal should get it for this cell box: no larger than the box
// at PixelsPerColumn x PixelsPerRow, so the terminal does not rescale a huge picture
// on every frame. Cached per source and size, so a redraw at the same size is free.
export async function fitPixels(
    $: EngineInterface,
    prepared: Prepared,
    cells: { columns: number; rows: number },
): Promise<Prepared>
{
    const side = shrunkSide(prepared, cells)
    if (side === undefined)
    {
        return prepared
    }
    const key = `${prepared.key}@${side}`

    return images.get(key, async () =>
    {
        const dir = await cacheDir($)
        let source = prepared.file
        if (source === undefined)
        {
            source = `${dir}/${await hashOf(prepared.key)}.src.png`
            await spill($, prepared.png, source)
        }
        const out = `${dir}/${await hashOf(key)}.png`
        const shrunk = (await convert($, source, out, side)) ? await readPng($, out, key) : undefined

        // Shrinking only saves work: a picture that will not shrink is shown as it is.
        return shrunk ?? prepared
    })
}
