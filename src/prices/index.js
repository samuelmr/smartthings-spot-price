import { log as defaultLog } from '../log.js'
import { createCache } from './cache.js'
import { findCurrent } from './current.js'
import { fetchPrices } from './spotHinta.js'

const TICK_MS = 60 * 1000

export function createPrices({
    apiBase,
    fetch = globalThis.fetch,
    now = Date.now,
    log = defaultLog,
    tickMs = TICK_MS,
    retryDelayMs,
}) {
    const fetchRegion = region => fetchPrices(region, { apiBase, fetch, retryDelayMs })
    const cache = createCache({ fetchRegion, now, log })
    let timer = null
    let running = false

    const prices = {
        current: region => findCurrent(cache.intervals(region), now()),

        ensure: regions => cache.refresh(regions),

        // The cache decides when a fetch is due; ticking often only makes it react sooner
        start(getRegions) {
            if (running) return
            running = true
            const tick = async () => {
                try {
                    await prices.ensure(getRegions())
                } catch (error) {
                    log.error('Price refresh tick failed', { error: error.message })
                }
                if (running) {
                    timer = setTimeout(tick, tickMs)
                    timer.unref?.()
                }
            }
            tick()
        },

        stop() {
            running = false
            clearTimeout(timer)
            timer = null
        },
    }
    return prices
}
