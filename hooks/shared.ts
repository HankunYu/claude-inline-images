// Work shared between concurrent callers, keyed; a result is kept once it succeeds.
//
// The work runs on the `$` of the caller that started it, and `$` calls are cut when that
// caller's dispatch is abandoned (a redraw that was superseded, an interrupted turn). So a
// failure is never kept, and a caller that only joined someone else's work runs the work
// again on its own `$` rather than failing with an abort that was not its own.
export class Shared<T>
{
    private readonly entries = new Map<string, Promise<T>>()

    get(key: string, work: () => Promise<T>): Promise<T>
    {
        const joined = this.entries.get(key)

        return joined ? joined.catch(() => this.start(key, work)) : this.start(key, work)
    }

    private start(key: string, work: () => Promise<T>): Promise<T>
    {
        // Joiners of a failed attempt retry together: the first one's attempt is shared.
        // The failed one is already gone, as its own handler below was attached first.
        const retrying = this.entries.get(key)
        if (retrying)
        {
            return retrying
        }

        const own = work()
        this.entries.set(key, own)
        own.catch(() =>
        {
            if (this.entries.get(key) === own)
            {
                this.entries.delete(key)
            }
        })

        return own
    }
}
