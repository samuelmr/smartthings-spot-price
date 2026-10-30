// Per-region price cache. A region is fetched only when asked for (i.e. when it's in use).
// Refetch policy: once the cache covers less than REFRESH_AHEAD_MS, poll every POLL_MS
// until a fetch extends it. That starts at local noon, so it covers the day-ahead
// publication (about 13:00 CET) and keeps polling if publication is late.

import { log as defaultLog } from '../log.js'

const MINUTE = 60 * 1000
export const REFRESH_AHEAD_MS = 12 * 60 * MINUTE
export const POLL_MS = 30 * MINUTE
export const RETRY_AFTER_FAILURE_MS = 5 * MINUTE

export function createCache({ fetchRegion, now = Date.now, log = defaultLog }) {
    // region → { intervals, lastAttempt, failed, inFlight }
    const entries = new Map()

    function entryFor(region) {
        let entry = entries.get(region)
        if (!entry) {
            entry = { intervals: [], lastAttempt: null, failed: false, inFlight: null }
            entries.set(region, entry)
        }
        return entry
    }

    function isDue(entry, time) {
        if (entry.lastAttempt === null) return true
        const coveredUntil = entry.intervals.at(-1)?.end ?? 0
        if (coveredUntil >= time + REFRESH_AHEAD_MS) return false
        return time - entry.lastAttempt >= (entry.failed ? RETRY_AFTER_FAILURE_MS : POLL_MS)
    }

    function refreshRegion(region) {
        const entry = entryFor(region)
        if (entry.inFlight) return entry.inFlight
        if (!isDue(entry, now())) return Promise.resolve()
        entry.lastAttempt = now()
        entry.inFlight = fetchRegion(region)
            .then(intervals => {
                entry.intervals = intervals
                entry.failed = false
                log.info('Prices fetched', {
                    region,
                    intervals: intervals.length,
                    coveredUntil: new Date(intervals.at(-1).end).toISOString(),
                })
            }, error => {
                // Keep serving what we have; it may still cover now
                entry.failed = true
                log.warn('Price fetch failed', { region, error: error.message })
            })
            .finally(() => {
                entry.inFlight = null
            })
        return entry.inFlight
    }

    return {
        intervals: region => entries.get(region)?.intervals ?? [],
        // Never rejects: failures are logged and leave the cached data in place
        refresh: async regions => {
            await Promise.all(regions.map(refreshRegion))
        },
    }
}
