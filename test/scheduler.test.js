import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ABANDONED_AFTER_MS, createScheduler, GONE_LIMIT, nextTickAt, QUARTER_HOUR_MS } from '../src/scheduler.js'
import { openStore } from '../src/store.js'

const config = { stClientId: 'st-client', stClientSecret: 'st-secret' }
const quietLog = { info() {}, warn() {}, error() {} }
const T0 = Date.parse('2026-10-30T12:00:00Z')
const urls = id => ({ oauthToken: `https://st/${id}/token`, stateCallback: `https://st/${id}/state` })

// behaviour(callbackUrls, callbackAuth, refreshedCallback) → Promise, per call
function fakeStateUpdateRequest(behaviour = async () => {}) {
    const calls = []
    class FakeStateUpdateRequest {
        constructor(clientId, clientSecret) {
            this.credentials = { clientId, clientSecret }
        }
        updateState(callbackUrls, callbackAuth, deviceState, refreshedCallback) {
            calls.push({ ...this.credentials, callbackUrls, callbackAuth, deviceState })
            return behaviour(callbackUrls, callbackAuth, refreshedCallback)
        }
    }
    return { calls, FakeStateUpdateRequest }
}

function setup({ behaviour, prices, ...options } = {}) {
    let storeClock = T0
    const store = openStore({ path: ':memory:', now: () => storeClock++ }) // distinct created_at keeps order stable
    const ensured = []
    prices ??= {
        current: region => (region === 'FI' ? { priceNoTax: 0.1, rank: 5, start: new Date(T0), end: new Date(T0 + QUARTER_HOUR_MS) } : null),
        ensure: async regions => { ensured.push(regions) },
    }
    const { calls, FakeStateUpdateRequest } = fakeStateUpdateRequest(behaviour)
    const scheduler = createScheduler({
        config, store, prices, now: () => T0, log: quietLog, StateUpdateRequest: FakeStateUpdateRequest, ...options,
    })
    return { store, scheduler, calls, ensured }
}

function link(store, regions, name) {
    const id = store.createInstallation(regions)
    store.setCallback(id, { accessToken: `${name}-access`, refreshToken: `${name}-refresh` }, urls(name))
    return id
}

test('nextTickAt aligns to quarter-hour boundaries plus the offset', () => {
    assert.equal(nextTickAt(T0), T0 + 5000)
    assert.equal(nextTickAt(T0 + 4999), T0 + 5000)
    assert.equal(nextTickAt(T0 + 5000), T0 + QUARTER_HOUR_MS + 5000)
    assert.equal(nextTickAt(T0 + 7 * 60_000), T0 + QUARTER_HOUR_MS + 5000)
    assert.equal(nextTickAt(T0 + QUARTER_HOUR_MS - 1, 0), T0 + QUARTER_HOUR_MS)
})

test('pushAll ensures prices and sends one update per installation with all its devices', async () => {
    const { store, scheduler, calls, ensured } = setup()
    const a = link(store, [{ region: 'FI', vatPercent: 25.5 }, { region: 'SE3', vatPercent: 25 }], 'a')
    link(store, [{ region: 'FI', vatPercent: 0 }], 'b')
    store.createInstallation([{ region: 'EE', vatPercent: 24 }]) // no callback yet

    const results = await scheduler.pushAll()
    assert.deepEqual(results, ['ok', 'ok'])
    assert.deepEqual(ensured, [['EE', 'FI', 'SE3']])
    assert.equal(calls.length, 2)
    const first = calls.find(call => call.callbackAuth.accessToken === 'a-access')
    assert.deepEqual(first.callbackUrls, store.getInstallation(a).callbackUrls)
    assert.equal(first.clientId, 'st-client')
    assert.deepEqual(first.deviceState.map(device => device.externalDeviceId), ['spot-price-FI', 'spot-price-SE3'])
    assert.equal(first.deviceState[0].states[0].value, 12.55)
    assert.equal(first.deviceState[1].states[0].value, 'offline')
    const second = calls.find(call => call.callbackAuth.accessToken === 'b-access')
    assert.equal(second.deviceState[0].states[0].value, 10)
})

test('a failing prices.ensure does not stop the push', async () => {
    const prices = { current: () => null, ensure: async () => { throw new Error('network down') } }
    const { store, scheduler, calls } = setup({ prices })
    link(store, [{ region: 'FI', vatPercent: 25.5 }], 'a')
    assert.deepEqual(await scheduler.pushAll(), ['ok'])
    assert.equal(calls[0].deviceState[0].states[0].value, 'offline')
})

test('refreshed callback tokens are persisted and urls kept', async () => {
    const { store, scheduler } = setup({
        behaviour: async (callbackUrls, callbackAuth, refreshed) => {
            refreshed({ accessToken: 'new-access', refreshToken: 'new-refresh', expiresIn: 86400 })
        },
    })
    const id = link(store, [{ region: 'FI', vatPercent: 25.5 }], 'a')
    await scheduler.pushAll()
    const installation = store.getInstallation(id)
    assert.equal(installation.callbackAuth.accessToken, 'new-access')
    assert.equal(installation.callbackAuth.refreshToken, 'new-refresh')
    assert.deepEqual(installation.callbackUrls, urls('a'))
})

test('404/410 deletes the installation after repeated answers; other failures are isolated and logged', async () => {
    const warnings = []
    const errors = []
    const log = { info() {}, warn: (message, fields) => warnings.push({ message, ...fields }), error: (message, fields) => errors.push({ message, ...fields }) }
    const statusFor = { gone: 404, deleted: 410, broken: 500 }
    const { store, scheduler, calls } = setup({
        log,
        behaviour: async callbackUrls => {
            const name = callbackUrls.stateCallback.split('/')[3]
            if (statusFor[name]) throw { statusCode: statusFor[name], message: `${statusFor[name]} - x` }
        },
    })
    const gone = link(store, [{ region: 'FI', vatPercent: 25.5 }], 'gone')
    const deleted = link(store, [{ region: 'FI', vatPercent: 25.5 }], 'deleted')
    const broken = link(store, [{ region: 'FI', vatPercent: 25.5 }], 'broken')
    const fine = link(store, [{ region: 'FI', vatPercent: 25.5 }], 'fine')

    for (let i = 1; i < GONE_LIMIT; i++) {
        assert.deepEqual(await scheduler.pushAll(), ['failed', 'failed', 'failed', 'ok'])
        assert.equal(store.getInstallation(gone).goneCount, i)
    }
    const results = await scheduler.pushAll()
    assert.deepEqual(results, ['deleted', 'deleted', 'failed', 'ok'])
    assert.equal(calls.length, 4 * GONE_LIMIT)
    assert.equal(store.getInstallation(gone), null)
    assert.equal(store.getInstallation(deleted), null)
    assert.notEqual(store.getInstallation(broken), null)
    assert.notEqual(store.getInstallation(fine), null)
    assert.deepEqual(warnings.slice(-2).map(warning => warning.installationId), [gone, deleted])
    assert.equal(warnings.length, 2 * GONE_LIMIT)
    assert.deepEqual(errors.slice(0, 1).map(error => [error.installationId, error.statusCode]), [[broken, 500]])
    assert.equal(JSON.stringify([warnings, errors]).includes('-access'), false)
})

test('a successful push resets the gone count', async () => {
    let status = 404
    const { store, scheduler } = setup({
        behaviour: async () => { if (status) throw { statusCode: status, message: 'gone' } },
    })
    const id = link(store, [{ region: 'FI', vatPercent: 25.5 }], 'a')
    for (let i = 1; i < GONE_LIMIT; i++) await scheduler.pushAll()
    assert.equal(store.getInstallation(id).goneCount, GONE_LIMIT - 1)

    status = 0
    assert.deepEqual(await scheduler.pushAll(), ['ok'])
    assert.equal(store.getInstallation(id).goneCount, 0)

    status = 404
    assert.deepEqual(await scheduler.pushAll(), ['failed'])
    assert.notEqual(store.getInstallation(id), null)
})

test('pushAll deletes abandoned linkings before choosing regions to fetch', async () => {
    const clock = { now: T0 }
    const store = openStore({ path: ':memory:', now: () => clock.now })
    const ensured = []
    const prices = { current: () => null, ensure: async regions => { ensured.push(regions) } }
    const infos = []
    const log = { ...quietLog, info: (message, fields) => infos.push({ message, ...fields }) }
    const { FakeStateUpdateRequest } = fakeStateUpdateRequest()
    const scheduler = createScheduler({ config, store, prices, now: () => clock.now, log, StateUpdateRequest: FakeStateUpdateRequest })
    const abandoned = store.createInstallation([{ region: 'EE', vatPercent: 24 }])
    link(store, [{ region: 'FI', vatPercent: 25.5 }], 'a')

    clock.now += ABANDONED_AFTER_MS - 1
    await scheduler.pushAll()
    clock.now += 1
    await scheduler.pushAll()
    assert.deepEqual(ensured, [['EE', 'FI'], ['FI']])
    assert.equal(store.getInstallation(abandoned), null)
    assert.deepEqual(infos.filter(info => info.message.startsWith('Abandoned')).map(info => info.installationIds), [[abandoned]])
})

test('pushInstallation pushes one installation and ensures its regions', async () => {
    const { store, scheduler, calls, ensured } = setup()
    link(store, [{ region: 'EE', vatPercent: 24 }], 'other')
    const id = link(store, [{ region: 'FI', vatPercent: 25.5 }], 'a')
    assert.equal(await scheduler.pushInstallation(id), 'ok')
    assert.deepEqual(ensured, [['FI']])
    assert.equal(calls.length, 1)
    assert.equal(calls[0].callbackAuth.accessToken, 'a-access')
    assert.equal(await scheduler.pushInstallation('missing'), 'skipped')
})

test('start pushes immediately, then on aligned ticks without drift; stop clears the timer', async () => {
    const clock = { now: T0 + 7 * 60_000 }
    const timers = []
    const fakeSetTimeout = (fn, delay) => {
        const timer = { fn, delay, cleared: false, unref() { this.unrefed = true } }
        timers.push(timer)
        return timer
    }
    const { store, scheduler, calls } = setup({
        now: () => clock.now,
        setTimeout: fakeSetTimeout,
        clearTimeout: timer => { timer.cleared = true },
    })
    link(store, [{ region: 'FI', vatPercent: 25.5 }], 'a')

    scheduler.start()
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(calls.length, 1)
    assert.equal(timers.length, 1)
    assert.equal(timers[0].delay, 8 * 60_000 + 5000)
    assert.equal(timers[0].unrefed, true)

    // Fires a bit late: the next tick still lands on the boundary
    clock.now = T0 + QUARTER_HOUR_MS + 5000 + 250
    await timers[0].fn()
    assert.equal(calls.length, 2)
    assert.equal(timers[1].delay, QUARTER_HOUR_MS - 250)

    // Fires a bit early: no double push, next target is a full quarter later
    clock.now = T0 + 2 * QUARTER_HOUR_MS + 5000 - 3
    await timers[1].fn()
    assert.equal(timers[2].delay, QUARTER_HOUR_MS + 3)

    scheduler.stop()
    assert.equal(timers[2].cleared, true)
    assert.equal(timers.length, 3)
})
