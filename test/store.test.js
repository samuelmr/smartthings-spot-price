import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { openStore } from '../src/store.js'

function memoryStore() {
    const clock = { now: 1_000_000 }
    const store = openStore({ path: ':memory:', now: () => clock.now })
    return { store, clock }
}

test('creates and reads an installation with regions', () => {
    const { store } = memoryStore()
    const id = store.createInstallation([{ region: 'FI', vatPercent: 25.5 }, { region: 'EE', vatPercent: 24 }])
    const installation = store.getInstallation(id)
    assert.deepEqual(installation.regions, [{ region: 'EE', vatPercent: 24 }, { region: 'FI', vatPercent: 25.5 }])
    assert.equal(installation.callbackAuth, null)
    assert.deepEqual(store.regionsInUse(), ['EE', 'FI'])
    assert.equal(store.getInstallation('missing'), null)
})

test('stores callbacks and keeps urls when only auth is refreshed', () => {
    const { store } = memoryStore()
    const id = store.createInstallation([{ region: 'FI', vatPercent: 25.5 }])
    assert.deepEqual(store.listInstallationsWithCallbacks(), [])

    const urls = { oauthToken: 'https://st/token', stateCallback: 'https://st/state' }
    store.setCallback(id, { accessToken: 'a1', refreshToken: 'r1' }, urls)
    store.setCallback(id, { accessToken: 'a2', refreshToken: 'r2' })

    const [installation] = store.listInstallationsWithCallbacks()
    assert.equal(installation.callbackAuth.accessToken, 'a2')
    assert.deepEqual(installation.callbackUrls, urls)
})

test('auth codes are single use and expire', () => {
    const { store, clock } = memoryStore()
    const id = store.createInstallation([{ region: 'FI', vatPercent: 25.5 }])

    store.saveAuthCode('code-1', id, 'https://st/cb', 60_000)
    assert.deepEqual(store.consumeAuthCode('code-1'), { installationId: id, redirectUri: 'https://st/cb' })
    assert.equal(store.consumeAuthCode('code-1'), null)

    store.saveAuthCode('code-2', id, 'https://st/cb', 60_000)
    clock.now += 60_000
    assert.equal(store.consumeAuthCode('code-2'), null)
})

test('access tokens expire and refresh tokens rotate', () => {
    const { store, clock } = memoryStore()
    const id = store.createInstallation([{ region: 'FI', vatPercent: 25.5 }])

    store.saveTokens(id, 'access-1', 'refresh-1', 1000)
    assert.equal(store.findInstallationIdByAccessToken('access-1'), id)
    assert.equal(store.findInstallationIdByAccessToken('nope'), null)

    clock.now += 1000
    assert.equal(store.findInstallationIdByAccessToken('access-1'), null)

    assert.equal(store.consumeRefreshToken('refresh-1'), id)
    assert.equal(store.consumeRefreshToken('refresh-1'), null)
})

test('remembers expired access tokens for a week', () => {
    const { store, clock } = memoryStore()
    const id = store.createInstallation([{ region: 'FI', vatPercent: 25.5 }])
    store.saveTokens(id, 'access-1', 'refresh-1', 1000)
    assert.deepEqual(store.checkAccessToken('access-1'), { status: 'valid', installationId: id })
    assert.deepEqual(store.checkAccessToken('nope'), { status: 'unknown' })

    clock.now += 1000
    assert.deepEqual(store.checkAccessToken('access-1'), { status: 'expired' })
    store.deleteExpired()
    assert.deepEqual(store.checkAccessToken('access-1'), { status: 'expired' })

    clock.now += 7 * 24 * 60 * 60 * 1000 - 1
    store.deleteExpired()
    assert.deepEqual(store.checkAccessToken('access-1'), { status: 'expired' })
    clock.now += 1
    store.deleteExpired()
    assert.deepEqual(store.checkAccessToken('access-1'), { status: 'unknown' })

    store.saveTokens(id, 'access-2', 'refresh-2', 1000)
    clock.now += 1000
    store.deleteExpired()
    store.deleteInstallation(id)
    assert.deepEqual(store.checkAccessToken('access-2'), { status: 'unknown' })
})

test('deleting an installation removes its regions, codes and tokens', () => {
    const { store } = memoryStore()
    const id = store.createInstallation([{ region: 'FI', vatPercent: 25.5 }])
    store.saveAuthCode('code', id, 'https://st/cb', 60_000)
    store.saveTokens(id, 'access', 'refresh', 60_000)

    store.deleteInstallation(id)
    assert.equal(store.getInstallation(id), null)
    assert.deepEqual(store.regionsInUse(), [])
    assert.equal(store.consumeAuthCode('code'), null)
    assert.equal(store.findInstallationIdByAccessToken('access'), null)
    assert.equal(store.consumeRefreshToken('refresh'), null)
})

test('deletes old installations that never got tokens or callbacks', () => {
    const { store, clock } = memoryStore()
    const abandoned = store.createInstallation([{ region: 'FI', vatPercent: 25.5 }])
    store.saveAuthCode('code', abandoned, 'https://st/cb', 60_000)
    const withTokens = store.createInstallation([{ region: 'SE3', vatPercent: 25 }])
    store.saveTokens(withTokens, 'access', 'refresh', 1000)
    const withRefreshOnly = store.createInstallation([{ region: 'SE4', vatPercent: 25 }])
    store.saveTokens(withRefreshOnly, 'access-2', 'refresh-2', 1000)
    const withCallback = store.createInstallation([{ region: 'EE', vatPercent: 24 }])
    store.setCallback(withCallback, { accessToken: 'a', refreshToken: 'r' }, { stateCallback: 'https://st/state' })

    clock.now += 59_999
    assert.deepEqual(store.deleteAbandonedInstallations(60_000), [])

    clock.now += 1
    store.deleteExpired() // access tokens gone; refresh tokens and callbacks still mark a completed link
    const fresh = store.createInstallation([{ region: 'LV', vatPercent: 21 }])
    assert.deepEqual(store.deleteAbandonedInstallations(60_000), [abandoned])
    assert.equal(store.getInstallation(abandoned), null)
    assert.equal(store.consumeAuthCode('code'), null)
    assert.ok(store.getInstallation(fresh))
    assert.deepEqual(store.regionsInUse(), ['EE', 'LV', 'SE3', 'SE4'])
})

test('a failed installation insert leaves nothing behind', () => {
    const { store } = memoryStore()
    assert.throws(() => store.createInstallation([
        { region: 'FI', vatPercent: 25.5 },
        { region: 'FI', vatPercent: 24 },
    ]))
    assert.deepEqual(store.regionsInUse(), [])
})

test('migrations run once on a file database', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spot-price-'))
    const dbPath = path.join(dir, 'nested', 'test.db')
    try {
        const first = openStore({ path: dbPath })
        const id = first.createInstallation([{ region: 'SE3', vatPercent: 25 }])
        first.close()

        const second = openStore({ path: dbPath })
        assert.deepEqual(second.getInstallation(id).regions, [{ region: 'SE3', vatPercent: 25 }])
        second.close()
    } finally {
        fs.rmSync(dir, { recursive: true, force: true })
    }
})
