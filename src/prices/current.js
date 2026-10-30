// Intervals are absolute instants, so DST days (92 or 100 intervals, ranks up to that
// count) need no special handling here.

export function findCurrent(intervals, time) {
    const interval = intervals.find(i => i.start <= time && time < i.end)
    if (!interval) return null
    return {
        priceNoTax: interval.priceNoTax,
        rank: interval.rank,
        start: new Date(interval.start),
        end: new Date(interval.end),
    }
}
