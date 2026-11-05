import { expect, test } from 'claude-code/testing'

import { Shared } from '../hooks/shared'

async function failureOf(promise: Promise<unknown>): Promise<string | undefined>
{
    try
    {
        await promise

        return undefined
    }
    catch (error)
    {
        return (error as Error).message
    }
}

test('a result is kept once it succeeds', async () => {
    const shared = new Shared<string>()
    let runs = 0
    const work = async () => `run ${++runs}`

    expect(await shared.get('k', work)).toBe('run 1')
    expect(await shared.get('k', work)).toBe('run 1')
    expect(runs).toBe(1)
})

test('a failure is not kept: the next call runs the work again', async () => {
    const shared = new Shared<string>()
    let runs = 0
    const work = async () =>
    {
        runs++
        if (runs === 1)
        {
            throw new Error('aborted')
        }

        return 'ok'
    }

    expect(await failureOf(shared.get('k', work))).toBe('aborted')
    expect(await shared.get('k', work)).toBe('ok')
    expect(runs).toBe(2)
})

test('a caller that joined work cut by its starter runs it again on its own', async () => {
    const shared = new Shared<string>()
    let cut!: (error: Error) => void
    const started = shared.get('k', () => new Promise<string>((_, reject) => { cut = reject }))
    const joinedA = shared.get('k', async () => 'retried')
    const joinedB = shared.get('k', async () => 'second retry')
    cut(new Error('aborted'))

    // The starter's own abort is its own failure
    expect(await failureOf(started)).toBe('aborted')
    // The joiners retry together: the first one's attempt is shared
    expect(await joinedA).toBe('retried')
    expect(await joinedB).toBe('retried')
    expect(await shared.get('k', async () => 'later')).toBe('retried')
})
