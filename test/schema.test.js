import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createSchemaHandler } from '../src/schema/connector.js'
import { CAPABILITY, PROFILE_ID, statesFor } from '../src/schema/devices.js'
import { openStore } from '../src/store.js'

const config = { stClientId: 'st-client', stClientSecret: 'st-secret' }
const quietLog = { info() {}, warn() {}, error() {} }

function recordingLog() {
    const lines = []
    const entry = level => (message, fields = {}) => lines.push({ level, message, ...fields })
    return { lines, info: entry('info'), warn: entry('warn'), error: entry('error') }
}

function stubPrices(table = {}) {
    const ensured = []
    return {
        ensured,
        current: region => table[region] ?? null,
        ensure: async regions => { ensured.push(regions) },
    }
}

function setup({ prices = stubPrices(), log = quietLog, ...options } = {}) {
    const clock = { now: 1_000_000 }
    const store = openStore({ path: ':memory:', now: () => clock.now })
    const id = store.createInstallation([{ region: 'FI', vatPercent: 25.5 }, { region: 'SE3', vatPercent: 0 }])
    store.saveTokens(id, 'access-1', 'refresh-1', 60_000)
    const handler = createSchemaHandler({ config, store, prices, log, ...options })
    async function call(interactionType, extra = {}, token = 'access-1') {
        const body = {
            headers: { schema: 'st-schema', version: '1.0', interactionType, requestId: 'req-1' },
            authentication: { tokenType: 'Bearer', token },
            ...extra,
        }
        const res = {
            statusCode: 200,
            status(code) { this.statusCode = code; return this },
            json(payload) { this.body = JSON.parse(JSON.stringify(payload)); return this },
        }
        await handler({ body }, res)
        return res
    }
    return { store, id, call, clock }
}

test('statesFor computes price with VAT and reports offline without a price', () => {
    const current = { priceNoTax: 0.0812, rank: 7, start: new Date(0), end: new Date(900_000) }
    assert.deepEqual(statesFor('FI', 25.5, current), [
        { component: 'main', capability: CAPABILITY, attribute: 'price', value: 10.19, unit: 'c/kWh' },
        { component: 'main', capability: CAPABILITY, attribute: 'rank', value: 7 },
        { component: 'main', capability: 'st.healthCheck', attribute: 'healthStatus', value: 'online' },
    ])
    assert.deepEqual(statesFor('FI', 25.5, null), [
        { component: 'main', capability: 'st.healthCheck', attribute: 'healthStatus', value: 'offline' },
    ])
})

test('rejects unknown tokens with a global error', async () => {
    const log = recordingLog()
    const { call } = setup({ log })
    const res = await call('discoveryRequest', {}, 'wrong-token')
    assert.equal(res.statusCode, 200)
    assert.equal(res.body.headers.interactionType, 'discoveryResponse')
    assert.equal(res.body.globalError.errorEnum, 'INVALID-TOKEN')
    assert.equal(res.body.devices, undefined)
    assert.equal(JSON.stringify(log.lines).includes('wrong-token'), false)
    assert.deepEqual(log.lines.at(-1), {
        level: 'warn', message: 'ST Schema interaction', interactionType: 'discoveryRequest', installationId: null, outcome: 'INVALID-TOKEN',
    })

    const store = openStore({ path: ':memory:', now: () => 1_000_000 })
    const handler = createSchemaHandler({ config, store, prices: stubPrices(), log: quietLog })
    const missing = { status() { return this }, json(payload) { this.body = payload } }
    await handler({ body: { headers: { interactionType: 'discoveryRequest', requestId: 'r' } } }, missing)
    assert.equal(missing.body.globalError.errorEnum, 'BAD-REQUEST')
})

test('rejects expired tokens with TOKEN-EXPIRED, also after cleanup', async () => {
    const { store, call, clock } = setup()
    clock.now += 60_000
    assert.equal((await call('discoveryRequest')).body.globalError.errorEnum, 'TOKEN-EXPIRED')

    store.deleteExpired()
    assert.equal((await call('discoveryRequest')).body.globalError.errorEnum, 'TOKEN-EXPIRED')
    assert.equal((await call('discoveryRequest', {}, 'wrong-token')).body.globalError.errorEnum, 'INVALID-TOKEN')
})

test('discovery returns one device per installation region', async () => {
    const log = recordingLog()
    const { id, call } = setup({ log })
    const res = await call('discoveryRequest')
    assert.equal(res.body.headers.interactionType, 'discoveryResponse')
    assert.deepEqual(res.body.devices, [
        {
            externalDeviceId: 'spot-price-FI',
            friendlyName: 'Spot Price FI',
            deviceHandlerType: PROFILE_ID,
            manufacturerInfo: { manufacturerName: 'spot-hinta.fi', modelName: 'Spot price FI' },
        },
        {
            externalDeviceId: 'spot-price-SE3',
            friendlyName: 'Spot Price SE3',
            deviceHandlerType: PROFILE_ID,
            manufacturerInfo: { manufacturerName: 'spot-hinta.fi', modelName: 'Spot price SE3' },
        },
    ])
    assert.deepEqual(log.lines.at(-1), {
        level: 'info', message: 'ST Schema interaction', interactionType: 'discoveryRequest', installationId: id, outcome: 'ok',
    })
    assert.equal(JSON.stringify(log.lines).includes('access-1'), false)
})

test('stateRefresh returns VAT-adjusted prices, offline states and flags foreign devices', async () => {
    const prices = stubPrices({ FI: { priceNoTax: 0.1, rank: 3, start: new Date(0), end: new Date(1) } })
    const { call } = setup({ prices })

    const all = await call('stateRefreshRequest')
    assert.equal(all.body.headers.interactionType, 'stateRefreshResponse')
    assert.deepEqual(prices.ensured, [['FI', 'SE3']])
    const [fi, se3] = all.body.deviceState
    assert.equal(fi.externalDeviceId, 'spot-price-FI')
    assert.deepEqual(fi.states.map(state => [state.attribute, state.value]), [['price', 12.55], ['rank', 3], ['healthStatus', 'online']])
    assert.deepEqual(se3, {
        externalDeviceId: 'spot-price-SE3',
        states: [{ component: 'main', capability: 'st.healthCheck', attribute: 'healthStatus', value: 'offline' }],
    })

    const some = await call('stateRefreshRequest', { devices: [{ externalDeviceId: 'spot-price-FI' }, { externalDeviceId: 'spot-price-EE' }] })
    assert.deepEqual(some.body.deviceState.map(device => device.externalDeviceId), ['spot-price-FI', 'spot-price-EE'])
    assert.equal(some.body.deviceState[0].states.length, 3)
    assert.deepEqual(some.body.deviceState[1].deviceError, [{ errorEnum: 'DEVICE-DELETED', detail: 'Unknown device' }])
    assert.deepEqual(prices.ensured.at(-1), ['FI'])
})

test('stateRefresh does not wait forever for prices', async () => {
    const prices = { current: () => null, ensure: () => new Promise(() => {}) }
    const { call } = setup({ prices, ensureTimeoutMs: 10 })
    const res = await call('stateRefreshRequest')
    assert.equal(res.body.deviceState.length, 2)
})

test('commands are rejected per device', async () => {
    const { call } = setup()
    const res = await call('commandRequest', { devices: [{ externalDeviceId: 'spot-price-FI', commands: [] }] })
    assert.equal(res.body.headers.interactionType, 'commandResponse')
    assert.deepEqual(res.body.deviceState, [
        { externalDeviceId: 'spot-price-FI', deviceError: [{ errorEnum: 'CAPABILITY-NOT-SUPPORTED', detail: 'No commands supported' }] },
    ])
})

test('grantCallbackAccess exchanges the code, persists callbacks and triggers a push', async () => {
    const exchanges = []
    const granted = []
    const callbackUrls = { oauthToken: 'https://st/token', stateCallback: 'https://st/state' }
    const { store, id, call } = setup({
        requestCallbackToken: async (clientId, clientSecret, body) => {
            exchanges.push({ clientId, clientSecret, code: body.callbackAuthentication.code })
            return { callbackAuthentication: { accessToken: 'cb-access', refreshToken: 'cb-refresh', expiresIn: 86400 } }
        },
        onCallbackGranted: installationId => granted.push(installationId),
    })

    const res = await call('grantCallbackAccess', {
        callbackAuthentication: { grantType: 'authorization_code', code: 'cb-code', clientId: 'st-client' },
        callbackUrls,
    })
    assert.equal(res.statusCode, 200)
    assert.equal(res.body.globalError, undefined)
    assert.deepEqual(exchanges, [{ clientId: 'st-client', clientSecret: 'st-secret', code: 'cb-code' }])
    const installation = store.getInstallation(id)
    assert.equal(installation.callbackAuth.accessToken, 'cb-access')
    assert.deepEqual(installation.callbackUrls, callbackUrls)
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(granted, [id])
})

test('grantCallbackAccess with a foreign client id or failed exchange stores nothing', async () => {
    const granted = []
    const { store, id, call } = setup({
        requestCallbackToken: async () => { throw Object.assign(new Error('400 - Bad Request'), { statusCode: 400 }) },
        onCallbackGranted: installationId => granted.push(installationId),
    })
    const extra = clientId => ({
        callbackAuthentication: { grantType: 'authorization_code', code: 'cb-code', clientId },
        callbackUrls: { oauthToken: 'https://st/token', stateCallback: 'https://st/state' },
    })

    const foreign = await call('grantCallbackAccess', extra('someone-else'))
    assert.equal(foreign.body.globalError.errorEnum, 'INVALID-CLIENT')

    const failed = await call('grantCallbackAccess', extra('st-client'))
    assert.equal(failed.statusCode, 500)
    assert.equal(failed.body.globalError.detail, 'Internal error')

    await new Promise(resolve => setImmediate(resolve))
    assert.equal(store.getInstallation(id).callbackAuth, null)
    assert.deepEqual(granted, [])
})

test('integrationDeleted removes the installation and its tokens', async () => {
    const { store, id, call } = setup()
    const res = await call('integrationDeleted')
    assert.equal(res.body.globalError, undefined)
    assert.equal(store.getInstallation(id), null)
    assert.equal(store.findInstallationIdByAccessToken('access-1'), null)

    const again = await call('discoveryRequest')
    assert.equal(again.body.globalError.errorEnum, 'INVALID-TOKEN')
})

test('interactionResult is logged without the token', async () => {
    const log = recordingLog()
    const { id, call } = setup({ log })
    await call('interactionResult', {
        originatingInteractionType: 'stateRefreshResponse',
        globalError: { errorEnum: 'BAD-REQUEST', detail: 'oops' },
    })
    const result = log.lines.find(line => line.message === 'ST Schema interaction result')
    assert.equal(result.installationId, id)
    assert.equal(result.originatingInteractionType, 'stateRefreshResponse')
    assert.deepEqual(result.globalError, { errorEnum: 'BAD-REQUEST', detail: 'oops' })
    assert.equal(JSON.stringify(log.lines).includes('access-1'), false)
})
