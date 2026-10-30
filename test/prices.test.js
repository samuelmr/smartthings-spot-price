import assert from 'node:assert/strict'
import fs from 'node:fs'
import { test } from 'node:test'
import { createPrices } from '../src/prices/index.js'
import { findCurrent } from '../src/prices/current.js'
import { fetchPrices, parsePrices } from '../src/prices/spotHinta.js'
import { priceCents } from '../src/prices/vat.js'

const fixture = name => JSON.parse(fs.readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'))
const FI = fixture('FI-2026-10-30')
const SE3 = fixture('SE3-2026-10-30')
const FI_TODAY_ONLY = FI.slice(0, 96)
const silentLog = { info() {}, warn() {}, error() {} }
const at = iso => Date.parse(iso)

// Answers each request with the next item of `responses`: a body (200), a number (status) or an Error
function fakeFetch(responses) {
    const calls = []
    const fetch = async url => {
        calls.push(url)
        const next = responses.length > 1 ? responses.shift() : responses[0]
        if (next instanceof Error) throw next
        if (typeof next === 'number') return new Response('error', { status: next })
        return Response.json(next)
    }
    return { fetch, calls }
}

function pricesAt(iso, responses) {
    const clock = { now: at(iso) }
    const { fetch, calls } = fakeFetch(responses)
    const prices = createPrices({ apiBase: 'https://api.test', fetch, now: () => clock.now, log: silentLog, retryDelayMs: 0 })
    return { prices, clock, calls }
}

test('parses offsets generically (FI +02:00, SE3 Z)', () => {
    const fi = parsePrices(FI)
    assert.equal(fi.length, 192)
    assert.equal(fi[0].start, at('2026-10-29T22:00:00Z'))
    assert.equal(fi[0].end - fi[0].start, 15 * 60 * 1000)
    assert.equal(fi.at(-1).end, at('2026-10-31T22:00:00Z'))

    const se3 = parsePrices(SE3)
    assert.equal(se3[0].start, at('2026-10-29T23:00:00Z'))
    assert.equal(se3.at(-1).end, at('2026-10-31T23:00:00Z'))
})

test('rejects malformed responses', () => {
    const item = { Rank: 1, DateTime: '2026-10-30T00:00:00+02:00', PriceNoTax: 0.01 }
    assert.throws(() => parsePrices([]), /non-empty array/)
    assert.throws(() => parsePrices({ error: 'x' }), /non-empty array/)
    assert.throws(() => parsePrices([{ ...item, DateTime: '2026-10-30T00:00:00' }]), /index 0/)
    assert.throws(() => parsePrices([item, { ...item, PriceNoTax: '0.01' }]), /index 1/)
    assert.throws(() => parsePrices([{ ...item, Rank: 0 }]), /index 0/)
    assert.equal(parsePrices([{ ...item, PriceNoTax: -0.002 }])[0].priceNoTax, -0.002)
})

test('autumn DST day has 100 intervals and the repeated hour resolves by instant', () => {
    const intervals = parsePrices(fixture('FI-2026-10-25-dst-synthetic'))
    assert.equal(intervals.length, 100)
    assert.deepEqual(intervals.map(i => i.rank).sort((a, b) => a - b), Array.from({ length: 100 }, (_, i) => i + 1))
    intervals.slice(1).forEach((interval, i) => assert.equal(interval.start, intervals[i].end))

    // 03:15 local happens twice: first at +03:00, then at +02:00
    const first = findCurrent(intervals, at('2026-10-25T00:20:00Z'))
    const second = findCurrent(intervals, at('2026-10-25T01:20:00Z'))
    assert.equal(first.start.toISOString(), '2026-10-25T00:15:00.000Z')
    assert.equal(second.start.toISOString(), '2026-10-25T01:15:00.000Z')
    assert.notDeepEqual(first, second)
})

test('spring DST day has 92 intervals', () => {
    const intervals = parsePrices(fixture('FI-2026-03-29-dst-synthetic'))
    assert.equal(intervals.length, 92)
    assert.equal(Math.max(...intervals.map(i => i.rank)), 92)
    assert.equal(intervals.at(-1).end - intervals[0].start, 23 * 3600 * 1000)
})

test('findCurrent picks the interval covering now, start inclusive and end exclusive', () => {
    const intervals = parsePrices(FI)
    const start = at('2026-10-30T12:00:00Z')
    assert.deepEqual(findCurrent(intervals, start), {
        priceNoTax: FI[56].PriceNoTax,
        rank: FI[56].Rank,
        start: new Date(start),
        end: new Date(start + 15 * 60 * 1000),
    })
    assert.equal(findCurrent(intervals, start - 1).start.getTime(), start - 15 * 60 * 1000)
    assert.equal(findCurrent(intervals, at('2026-10-29T21:59:59Z')), null)
    assert.equal(findCurrent(intervals, at('2026-10-31T22:00:00Z')), null)
})

test('priceCents applies VAT to PriceNoTax and rounds to 2 decimals', () => {
    assert.equal(priceCents(0.01541, 25.5), 1.93) // spot-hinta's PriceWithTax: 0.01934
    assert.equal(priceCents(0.10132, 25), 12.67)
    assert.equal(priceCents(0.10132, 0), 10.13)
    assert.equal(priceCents(-0.00213, 24), -0.26)
    for (const item of FI) {
        assert.ok(Math.abs(priceCents(item.PriceNoTax, 25.5) - item.PriceWithTax * 100) <= 0.006)
    }
})

test('fetchPrices requests 15-minute prices for the region', async () => {
    const { fetch, calls } = fakeFetch([SE3])
    const intervals = await fetchPrices('SE3', { apiBase: 'https://api.test', fetch })
    assert.equal(intervals.length, 192)
    assert.deepEqual(calls, ['https://api.test/TodayAndDayForward?region=SE3&priceResolution=15'])
})

test('fetchPrices retries once on 5xx, 429 and network errors, not on 4xx', async () => {
    const options = { apiBase: 'https://api.test', retryDelayMs: 0 }
    for (const failure of [503, 429, new TypeError('fetch failed')]) {
        const { fetch, calls } = fakeFetch([failure, FI])
        assert.equal((await fetchPrices('FI', { ...options, fetch })).length, 192)
        assert.equal(calls.length, 2)
    }

    const twice = fakeFetch([500])
    await assert.rejects(fetchPrices('FI', { ...options, fetch: twice.fetch }), /HTTP 500/)
    assert.equal(twice.calls.length, 2)

    const badRequest = fakeFetch([400])
    await assert.rejects(fetchPrices('FI', { ...options, fetch: badRequest.fetch }), /HTTP 400/)
    assert.equal(badRequest.calls.length, 1)
})

test('fetchPrices times out a hanging request', async () => {
    let calls = 0
    const fetch = (url, { signal }) => {
        calls++
        return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason)))
    }
    await assert.rejects(fetchPrices('FI', { apiBase: 'https://api.test', fetch, timeoutMs: 10, retryDelayMs: 0 }), /Request failed/)
    assert.equal(calls, 2)
})

test('current is null until ensure has fetched, then served from cache', async () => {
    const { prices, calls } = pricesAt('2026-10-30T12:05:00Z', [FI])
    assert.equal(prices.current('FI'), null)
    await prices.ensure(['FI'])
    assert.equal(prices.current('FI').rank, FI[56].Rank)
    assert.equal(prices.current('SE3'), null)

    await prices.ensure(['FI'])
    assert.equal(calls.length, 1)
})

test('concurrent ensure calls share one in-flight request per region', async () => {
    const { prices, calls } = pricesAt('2026-10-30T12:05:00Z', [FI])
    await Promise.all([prices.ensure(['FI']), prices.ensure(['FI']), prices.ensure(['FI'])])
    assert.equal(calls.length, 1)
})

test('polls every 30 min once coverage drops below 12 h, until tomorrow appears', async () => {
    // FI today ends 22:00Z; 09:00Z leaves 13 h, so no polling yet
    const { prices, clock, calls } = pricesAt('2026-10-30T09:00:00Z', [FI_TODAY_ONLY, FI_TODAY_ONLY, FI])
    const ensureAt = async iso => {
        clock.now = at(iso)
        await prices.ensure(['FI'])
        return calls.length
    }
    assert.equal(await ensureAt('2026-10-30T09:00:00Z'), 1)
    assert.equal(await ensureAt('2026-10-30T10:00:00Z'), 1)
    assert.equal(await ensureAt('2026-10-30T10:30:00Z'), 2) // 11.5 h left
    assert.equal(await ensureAt('2026-10-30T10:45:00Z'), 2)
    assert.equal(await ensureAt('2026-10-30T11:00:00Z'), 3) // tomorrow published
    assert.equal(await ensureAt('2026-10-30T11:30:00Z'), 3)
    assert.equal(await ensureAt('2026-10-31T09:59:00Z'), 3)
    assert.equal(prices.current('FI').start.toISOString(), '2026-10-31T09:45:00.000Z')
})

test('a failed fetch keeps cached prices and is retried after 5 min', async () => {
    const { prices, clock, calls } = pricesAt('2026-10-30T11:00:00Z', [FI_TODAY_ONLY, 503, 503, FI])
    await prices.ensure(['FI'])
    clock.now = at('2026-10-30T11:30:00Z')
    await prices.ensure(['FI']) // fails twice (retry)
    assert.equal(calls.length, 3)
    assert.equal(prices.current('FI').start.toISOString(), '2026-10-30T11:30:00.000Z')

    clock.now = at('2026-10-30T11:34:00Z')
    await prices.ensure(['FI'])
    assert.equal(calls.length, 3)
    clock.now = at('2026-10-30T11:35:00Z')
    await prices.ensure(['FI'])
    assert.equal(calls.length, 4)
    assert.ok(prices.current('FI'))
})

test('start fetches only the regions in use and stop ends the loop', async () => {
    const { prices, calls } = pricesAt('2026-10-30T12:05:00Z', [SE3])
    prices.start(() => ['SE3'])
    await prices.ensure(['SE3']) // joins the request start() made
    prices.stop()
    assert.deepEqual(calls, ['https://api.test/TodayAndDayForward?region=SE3&priceResolution=15'])
    assert.equal(prices.current('SE3').start.toISOString(), '2026-10-30T12:00:00.000Z')
    assert.equal(prices.current('FI'), null)
})
