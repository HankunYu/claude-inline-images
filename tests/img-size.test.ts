import { expect, mock, test } from 'claude-code/testing'

// /img-size as the person would type it
const typed = (args: string) => ({
    command: 'img-size',
    args,
    origin: { kind: 'composer' as const },
    presentation: { isFullscreen: false, columns: 120 },
})

test('/img-size sets the height, the width, and resets both', async ($, on) => {
    mock.store(on)
    const run = async (args: string) => (await $.command.run(typed(args))).text

    expect(await run('')).toBe('Inline images are at most 20 rows tall and 120 columns wide.')
    expect(await run('40 40')).toBe('Inline images are now at most 40 rows tall and 40 columns wide.')
    // Rows alone keep the width
    expect(await run('30')).toBe('Inline images are now at most 30 rows tall and 40 columns wide.')
    expect(await run('reset')).toBe('Inline images are now at most 20 rows tall and 120 columns wide.')
})

test('/img-size refuses values out of range', async ($, on) => {
    mock.store(on)
    const run = async (args: string) => (await $.command.run(typed(args))).text

    expect(await run('1')).toContain('Usage:')
    expect(await run('40 4')).toContain('Usage:')
    expect(await run('40 40 40')).toContain('Usage:')
})
