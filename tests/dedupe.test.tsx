import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

const ShowImage = 'mcp__inline-images__show_image'
// 1x1 PNG
const OnePixel = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

type World = { mtimeMs: number; readResult: unknown; ran: string[][] }

// A kitty terminal inside Rex, one PNG on disk whatever its path, and a Read that answers `readResult`.
function world(on: Parameters<TestBody>[1]): World
{
    const w: World = {
        mtimeMs: 1000,
        readResult: { type: 'image', file: { base64: OnePixel, type: 'image/png', originalSize: 70 } },
        ran: [],
    }
    mock.store(on)
    mock.env(on, { TERM_PROGRAM: 'kitty', TERM: 'xterm-kitty', HOME: '/home/u', REX_SESSION: 's', REX_BLOCK: 'block:own' })
    on('fs.exists', () => ({ value: true }))
    on('fs.stat', () => ({ value: { kind: 'file', size: 70, mtimeMs: w.mtimeMs, isLink: false } }))
    on('fs.read', () => ({ value: { base64: OnePixel } }))
    on('process.run', (_, e) =>
    {
        w.ran.push([...e.argv])

        const stdout = e.argv[0] === 'rex' ? '{"id":"block:new"}' : 'Linux\n'

        return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    })
    on('tool.call', { tool: 'Read' }, () => ({ result: w.readResult }))

    return w
}

test('show_image after a Read of the same unchanged file draws nothing', async ($, on) => {
    world(on)
    const path = '/pics/same.png'

    await $.tool.call({ tool: 'Read', file_path: path })
    const shown = await $.tool.call({ tool: ShowImage, path })

    expect(String(shown.result)).toContain('Not drawn again:')
    expect(String(shown.result)).toContain(path)
})

test('show_image draws when the file was written again after the Read', async ($, on) => {
    const w = world(on)
    const path = '/pics/regenerated.png'

    await $.tool.call({ tool: 'Read', file_path: path })
    w.mtimeMs = 2000
    const shown = await $.tool.call({ tool: ShowImage, path })

    expect(String(shown.result)).toContain('Shown inline under this call (1x1px)')
})

test('show_image draws a file no Read showed', async ($, on) => {
    const w = world(on)

    // Never read
    expect(String((await $.tool.call({ tool: ShowImage, path: '/pics/unread.png' })).result)).toContain('Shown inline')

    // Read as text, so no picture was drawn
    w.readResult = { type: 'text', file: { filePath: '/pics/text.png', content: '', numLines: 0, startLine: 1, totalLines: 0 } }
    await $.tool.call({ tool: 'Read', file_path: '/pics/text.png' })
    expect(String((await $.tool.call({ tool: ShowImage, path: '/pics/text.png' })).result)).toContain('Shown inline')

    // Read by a subagent, whose row the conversation does not show
    w.readResult = { type: 'image', file: { base64: OnePixel, type: 'image/png', originalSize: 70 } }
    await $.tool.call({ tool: 'Read', file_path: '/pics/agent.png', agentId: 'a1' })
    expect(String((await $.tool.call({ tool: ShowImage, path: '/pics/agent.png' })).result)).toContain('Shown inline')
})

test('mode "pane" opens the pane even after a Read of the same file', async ($, on) => {
    const w = world(on)
    const path = '/pics/pane.png'

    await $.tool.call({ tool: 'Read', file_path: path })
    const shown = await $.tool.call({ tool: ShowImage, path, mode: 'pane' })

    expect(String(shown.result)).toContain('Shown in a new Rex pane (block:new')
    expect(w.ran.some(argv => argv[0] === 'rex' && argv[1] === 'split')).toBe(true)
})

test('the row of a repeat call carries no picture, and stays so when drawn again', async ($, on) => {
    world(on)
    const row = (output: string) => ({
        plugin: 'inline-images',
        surface: 'terminal',
        component: 'ToolUse',
        props: {
            tool_use_id: 't1',
            tool: ShowImage,
            input: { path: '/pics/row.png' },
            isRunning: false,
            isErrored: false,
            isInterrupted: false,
            output,
        },
    } as const)

    // Drawn from the stored result alone, twice over
    for (let i = 0; i < 2; i++)
    {
        const repeat = await $.ui.mount(row('Not drawn again: the earlier Read of /pics/row.png already shows this picture.'))
        expect(await repeat.find({ type: 'Image' })).toBeUndefined()
        await repeat.unmount()
    }

    const first = await $.ui.mount(row('Shown inline under this call (1x1px).'))
    expect((await first.find({ type: 'Image' })) !== undefined).toBe(true)
    await first.unmount()
})
