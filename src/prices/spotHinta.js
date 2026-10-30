// spot-hinta.fi client. Timestamps carry the region's own offset (FI "+02:00", SE3 "Z"),
// so they're parsed into absolute instants and never compared as local times.

export const INTERVAL_MS = 15 * 60 * 1000

const OFFSET = /(Z|[+-]\d\d:\d\d)$/

class FetchError extends Error {
    constructor(message, { retryable }) {
        super(message)
        this.retryable = retryable
    }
}

// → [{ start, end (epoch ms), priceNoTax (EUR/kWh), rank }] sorted by start
export function parsePrices(body) {
    if (!Array.isArray(body) || body.length === 0) {
        throw new Error('Expected a non-empty array of prices')
    }
    const intervals = body.map((item, index) => {
        const start = typeof item?.DateTime === 'string' && OFFSET.test(item.DateTime) ? Date.parse(item.DateTime) : NaN
        if (Number.isNaN(start) || !Number.isFinite(item.PriceNoTax) || !Number.isInteger(item.Rank) || item.Rank < 1) {
            throw new Error(`Invalid price item at index ${index}: ${JSON.stringify(item)}`)
        }
        return { start, end: start + INTERVAL_MS, priceNoTax: item.PriceNoTax, rank: item.Rank }
    })
    return intervals.sort((a, b) => a.start - b.start)
}

async function fetchOnce(url, fetch, timeoutMs) {
    let resp
    try {
        resp = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json' } })
    } catch (error) {
        throw new FetchError(`Request failed: ${error.message}`, { retryable: true })
    }
    if (!resp.ok) {
        throw new FetchError(`HTTP ${resp.status}`, { retryable: resp.status === 429 || resp.status >= 500 })
    }
    return parsePrices(await resp.json())
}

export async function fetchPrices(region, {
    apiBase,
    fetch = globalThis.fetch,
    timeoutMs = 10_000,
    retryDelayMs = 5_000,
    sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
}) {
    const url = `${apiBase}/TodayAndDayForward?region=${encodeURIComponent(region)}&priceResolution=15`
    try {
        return await fetchOnce(url, fetch, timeoutMs)
    } catch (error) {
        if (!error.retryable) throw error
        await sleep(retryDelayMs)
        return fetchOnce(url, fetch, timeoutMs)
    }
}
