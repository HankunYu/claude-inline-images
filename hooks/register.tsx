import type { EngineInterface, Register, RenderElement, RenderInput, RenderNode } from 'claude-code'

import { fitCells, fitPixels, prepareFromBase64, prepareFromPath } from './prepare'
import type { Prepared } from './prepare'
import { Shared } from './shared'

const ToolName = 'show_image'
const FullToolName = 'mcp__inline-images__show_image'
// Largest box an inline image may take, in terminal cells; /img-size changes them.
const Limits = {
    rows: { storeKey: 'maxRows', fallback: 20, min: 2, max: 255 },
    columns: { storeKey: 'maxColumns', fallback: 120, min: 8, max: 255 },
} as const
type Limit = keyof typeof Limits

// Cached copies of the stored settings; a hot reload drops them and the store is read again.
const limitCache: Partial<Record<Limit, number>> = {}

function isValidLimit(name: Limit, value: number): boolean
{
    return Number.isInteger(value) && value >= Limits[name].min && value <= Limits[name].max
}

async function limitOf($: EngineInterface, name: Limit): Promise<number>
{
    let value = limitCache[name]
    if (value === undefined)
    {
        const stored = Number(await $.store.get(Limits[name].storeKey))
        value = isValidLimit(name, stored) ? stored : Limits[name].fallback
        limitCache[name] = value
    }

    return value
}

async function setLimit($: EngineInterface, name: Limit, value: number): Promise<void>
{
    await $.store.set(Limits[name].storeKey, value)
    limitCache[name] = value
}

type Mode = 'auto' | 'inline' | 'pane'
type Backend = 'inline' | 'pane' | 'open' | 'none'
type Source =
    | { kind: 'path'; path: string; alt: string }
    | { kind: 'bytes'; base64: string; mimeType?: string; alt: string }

type Terminal = { canInline: boolean; isRex: boolean; isMac: boolean }
const terminals = new Shared<Terminal>()

// Whether Claude Code will draw kitty placeholder images here, read once per load.
function terminal($: EngineInterface): Promise<Terminal>
{
    return terminals.get('terminal', async () =>
    {
        const program = ((await $.env.get('TERM_PROGRAM')) ?? '').toLowerCase()
        const term = (await $.env.get('TERM')) ?? ''
        const isForced = (await $.env.get('CLAUDE_CODE_FORCE_TERMINAL_IMAGES')) === '1'
        const isMultiplexed = (await $.env.get('TMUX')) !== undefined || term.startsWith('screen')
        const isKnown = program === 'ghostty' || program === 'kitty' || term === 'xterm-kitty'
        const isRex = (await $.env.get('REX_SESSION')) !== undefined && (await $.env.get('REX_BLOCK')) !== undefined
        const { stdout } = await $.process.run(['uname', '-s'])

        // Claude Code snapshots its env at startup, so setting the force flag from here
        // is too late: Rex needs CLAUDE_CODE_FORCE_TERMINAL_IMAGES=1 before `claude` starts.
        return { canInline: isForced || (isKnown && !isMultiplexed), isRex, isMac: stdout.trim() === 'Darwin' }
    })
}

function backendFor(mode: Mode, t: Terminal): Backend
{
    if (mode === 'inline' || (mode === 'auto' && t.canInline))
    {
        return 'inline'
    }
    if (t.isRex)
    {
        return 'pane'
    }

    return t.isMac ? 'open' : 'none'
}

function asRecord(value: unknown): Record<string, unknown> | undefined
{
    return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : undefined
}

function modeOf(input: unknown): Mode
{
    const mode = asRecord(input)?.mode

    return mode === 'inline' || mode === 'pane' ? mode : 'auto'
}

function baseName(path: string): string
{
    return path.split('/').pop() ?? path
}

// Image content blocks in a tool result: MCP style ({ data, mimeType }) or Anthropic style ({ source }).
function imageBlocksOf(output: unknown): Source[]
{
    const record = asRecord(output)
    const blocks = Array.isArray(output) ? output : Array.isArray(record?.content) ? (record.content as unknown[]) : []
    const sources: Source[] = []
    for (const block of blocks)
    {
        const b = asRecord(block)
        if (b?.type !== 'image')
        {
            continue
        }
        const source = asRecord(b.source)
        const data = typeof b.data === 'string' ? b.data : typeof source?.data === 'string' ? source.data : undefined
        const mimeType = typeof b.mimeType === 'string' ? b.mimeType : typeof source?.media_type === 'string' ? source.media_type : undefined
        if (data)
        {
            sources.push({ kind: 'bytes', base64: data, mimeType, alt: `[image ${mimeType ?? ''}]`.replace(' ]', ']') })
        }
    }

    return sources
}

// What one tool call's row should show, given its tool, input and stored result.
function sourcesOf(tool: string, input: unknown, output: unknown, t: Terminal): Source[]
{
    const args = asRecord(input)
    if (tool === 'Read')
    {
        const path = args?.file_path
        const isImage = asRecord(output)?.type === 'image'

        return isImage && typeof path === 'string' ? [{ kind: 'path', path, alt: `[image ${baseName(path)}]` }] : []
    }
    if (tool === FullToolName)
    {
        const path = args?.path

        return typeof path === 'string' && backendFor(modeOf(input), t) === 'inline'
            ? [{ kind: 'path', path, alt: `[image ${baseName(path)}]` }]
            : []
    }
    if (tool.startsWith('mcp__'))
    {
        return imageBlocksOf(output)
    }

    return []
}

async function prepare($: EngineInterface, source: Source): Promise<Prepared>
{
    return source.kind === 'path'
        ? prepareFromPath($, source.path)
        : prepareFromBase64($, source.base64, source.mimeType)
}

async function absolutePath($: EngineInterface, path: string): Promise<string>
{
    if (path.startsWith('/'))
    {
        return path
    }
    if (path.startsWith('~/'))
    {
        return `${(await $.env.get('HOME')) ?? ''}/${path.slice(2)}`
    }

    return `${await $.session.cwd()}/${path}`
}

async function showInPane($: EngineInterface, path: string): Promise<string>
{
    const session = (await $.env.get('REX_SESSION')) ?? ''
    const block = (await $.env.get('REX_BLOCK')) ?? ''
    const script = `${$.plugin.root}/scripts/kitty-img.py`
    const { exitCode, stdout, stderr } = await $.process.run([
        'rex', 'split', '-s', session, '-b', block, '--split=right', '--ratio', '55',
        '--label', 'image', '--keep-open', '--focus=false', '--json', '--',
        'python3', script, path,
    ])
    if (exitCode !== 0)
    {
        throw new Error(`rex split failed: ${stderr.trim() || stdout.trim()}`)
    }
    const blockId = (stdout.match(/"(block:[^"]+)"/g) ?? []).map(s => s.slice(1, -1)).find(id => id !== block)

    return `Shown in a new Rex pane${blockId ? ` (${blockId}; close it with \`rex block close ${blockId}\` when the user is done)` : ''}. You cannot see the picture yourself; ask the user whether it looks right.`
}

// Draw the row as the engine does, then the pictures it carries below it.
async function drawUnder(
    $: EngineInterface,
    e: RenderInput<'ToolUse' | 'ToolGroup', 'terminal'>,
    row: RenderNode | null | undefined,
    sources: Source[],
): Promise<RenderElement>
{
    const { Box, Image, Text } = $.ui.resolve(e)
    const room = {
        columns: Math.max(Limits.columns.min, Math.min(await limitOf($, 'columns'), (e.viewport?.columns ?? 80) - 6)),
        maxRows: await limitOf($, 'rows'),
    }
    const pictures = await Promise.all(sources.map(async (source, index) =>
    {
        try
        {
            const prepared = await prepare($, source)
            const cells = fitCells(prepared, room)
            const shown = await fitPixels($, prepared, cells)

            return <Image key={`img-${index}`} source={{ png: shown.png }} columns={cells.columns} rows={cells.rows} alt={source.alt} />
        }
        catch (error)
        {
            return <Text dimColor>{`${source.alt} not drawn: ${(error as Error).message}`}</Text>
        }
    }))

    return (
        <Box flexDirection="column">
            {row}
            {pictures.map(picture => <Box paddingLeft={5}>{picture}</Box>)}
        </Box>
    )
}

export const register: Register = on =>
{
    on('session.start', async ($, e, next) =>
    {
        await $.tool.register({
            name: ToolName,
            description:
                'Display an image file to the user in the terminal conversation. Use it whenever the user wants to '
                + 'see an image (a chart, render, screenshot, downloaded picture) that you do not need to look at '
                + 'yourself: unlike Read it puts no image into your context. Read results that are images are '
                + 'already drawn inline automatically, so do not call this after reading the same file.',
            inputSchema: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Image file path (absolute, ~/, or relative to the cwd). Any format sips or ImageMagick reads.' },
                    mode: {
                        type: 'string',
                        enum: ['auto', 'inline', 'pane'],
                        description: 'auto (default): inline when the terminal can draw it, else a Rex pane. pane: a full-size Rex pane beside the chat.',
                    },
                },
                required: ['path'],
            },
            isDeferred: false,
        })
        await $.command.register({
            name: 'img-size',
            description: 'Set the max height (rows) and width (columns) of inline images',
            argumentHint: '[rows [columns] | reset]',
        })

        return next(e)
    })

    on('command.run', { command: 'img-size' }, async ($, e) =>
    {
        const args = e.args.trim().split(/\s+/).filter(Boolean)
        const describe = async () =>
            `at most ${await limitOf($, 'rows')} rows tall and ${await limitOf($, 'columns')} columns wide`
        if (args.length === 0)
        {
            return { text: `Inline images are ${await describe()}.` }
        }

        const reset = args.length === 1 && args[0] === 'reset'
        const rows = reset ? Limits.rows.fallback : Number(args[0])
        const columns = reset ? Limits.columns.fallback : args[1] === undefined ? undefined : Number(args[1])
        if (args.length > 2 || !isValidLimit('rows', rows) || (columns !== undefined && !isValidLimit('columns', columns)))
        {
            return {
                text: `Usage: /img-size <rows ${Limits.rows.min}-${Limits.rows.max}> `
                    + `[columns ${Limits.columns.min}-${Limits.columns.max}] | reset`,
            }
        }

        await setLimit($, 'rows', rows)
        if (columns !== undefined)
        {
            await setLimit($, 'columns', columns)
        }
        // Redraw the images already on screen at the new size.
        $.ui.invalidate('ui.render')

        return { text: `Inline images are now ${await describe()}.` }
    })

    // A RegExp matcher: the generated MCP tool types predate this tool's registration.
    on('tool.call', { tool: /^mcp__inline-images__show_image$/ }, async ($, e) =>
    {
        const input = e as unknown as { path?: unknown; mode?: unknown }
        if (typeof input.path !== 'string' || input.path === '')
        {
            return { deny: 'show_image needs a path.' }
        }
        const path = await absolutePath($, input.path)
        if (!(await $.fs.exists(path)))
        {
            return { deny: `No such file: ${path}` }
        }
        const backend = backendFor(modeOf(input), await terminal($))
        try
        {
            if (backend === 'pane')
            {
                return { result: await showInPane($, path) }
            }
            if (backend === 'open')
            {
                await $.process.run(['open', path])

                return { result: `This terminal cannot draw images inline; opened ${path} in Preview.` }
            }
            if (backend === 'none')
            {
                return { result: `This terminal cannot draw images; tell the user the path: ${path}` }
            }
            const { width, height } = await prepareFromPath($, path)

            return { result: `Shown inline under this call (${width}x${height}px). You cannot see it yourself; do not Read it unless asked.` }
        }
        catch (error)
        {
            return { deny: `show_image failed: ${(error as Error).message}` }
        }
    }).catch(($, e, next) =>
        next.called ? next(e) : { deny: 'inline-images: show_image failed unexpectedly.' },
    )

    on('ui.render', { component: 'ToolUse' }, async ($, e, next) =>
    {
        const { tool, input, output, isRunning, isErrored } = e.props
        if (e.surface !== 'terminal' || isRunning || isErrored || output === undefined)
        {
            return next(e)
        }
        const t = await terminal($)
        const sources = t.canInline ? sourcesOf(tool, input, output, t) : []
        if (sources.length === 0)
        {
            return next(e)
        }

        return drawUnder($, e, await next(e), sources)
    })

    // Image reads folded into "Read 3 files": show them under the group line.
    on('ui.render', { component: 'ToolGroup' }, async ($, e, next) =>
    {
        if (e.surface !== 'terminal' || e.props.isExpanded)
        {
            return next(e)
        }
        const t = await terminal($)
        const sources = t.canInline
            ? e.props.calls
                .filter(call => !call.isRunning && !call.isErrored && call.output !== undefined)
                .flatMap(call => sourcesOf(call.tool, call.input, call.output, t))
            : []
        if (sources.length === 0)
        {
            return next(e)
        }

        return drawUnder($, e, await next(e), sources)
    })
}
