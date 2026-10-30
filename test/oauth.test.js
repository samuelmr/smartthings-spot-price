import assert from 'node:assert/strict'
import { test } from 'node:test'
import express from 'express'
import { createOAuthRouter, isSmartThingsRedirect, parseVatPercent } from '../src/oauth/router.js'
import { ACCESS_TOKEN_TTL_MS } from '../src/oauth/tokens.js'
import { openStore } from '../src/store.js'

const config = { oauthClientId: 'st-client', oauthClientSecret: 's3cret' }
const REDIRECT = 'https://c2c-eu.smartthingsgcp.com/oauth/callback'
const basic = (id, secret) => `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`

async function withServer(fn) {
    const clock = { now: 1_000_000 }
    const store = openStore({ path: ':memory:', now: () => clock.now })
    const app = express()
    app.use(express.json())
    app.use(express.urlencoded({ extended: false }))
    app.use('/oauth', createOAuthRouter({ config, store }))
    const server = app.listen(0)
    await new Promise(resolve => server.once('listening', resolve))
    try {
        await fn({ baseUrl: `http://localhost:${server.address().port}`, store, clock })
    } finally {
        server.close()
        store.close()
    }
}

const authorizeQuery = (overrides = {}) => new URLSearchParams({
    client_id: config.oauthClientId,
    redirect_uri: REDIRECT,
    response_type: 'code',
    state: 'st-state',
    ...overrides,
})

function postForm(url, fields, headers = {}) {
    return fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
        body: new URLSearchParams(fields),
        redirect: 'manual',
    })
}

// Fills in the authorize form and returns the auth code from the redirect
async function link(baseUrl, regionFields = [['region', 'FI'], ['vat_FI', '25.5']]) {
    const resp = await postForm(`${baseUrl}/oauth/authorize`, [...authorizeQuery(), ...regionFields])
    assert.equal(resp.status, 303)
    return new URL(resp.headers.get('location')).searchParams.get('code')
}

function exchangeCode(baseUrl, code, extra = {}) {
    return postForm(`${baseUrl}/oauth/token`, { grant_type: 'authorization_code', code, redirect_uri: REDIRECT, ...extra },
        { authorization: basic(config.oauthClientId, config.oauthClientSecret) })
}

test('parseVatPercent accepts 0–50 with dot or comma', () => {
    assert.equal(parseVatPercent('25.5'), 25.5)
    assert.equal(parseVatPercent(' 25,5 '), 25.5)
    assert.equal(parseVatPercent('0'), 0)
    assert.equal(parseVatPercent('50'), 50)
    for (const bad of ['50.01', '-1', '', 'abc', '1e1', '25.555', undefined, ['25']]) {
        assert.equal(parseVatPercent(bad), null, `rejects ${JSON.stringify(bad)}`)
    }
})

test('only https SmartThings callback hosts are allowed as redirect_uri', () => {
    assert.ok(isSmartThingsRedirect(REDIRECT))
    assert.ok(isSmartThingsRedirect('https://c2c-us.smartthingsgcp.com/oauth/callback'))
    for (const bad of [
        'http://c2c-eu.smartthingsgcp.com/oauth/callback',
        'https://c2c-eu.smartthingsgcp.com.evil.example/oauth/callback',
        'https://evil.example/?c2c-eu.smartthingsgcp.com',
        'https://user@c2c-eu.smartthingsgcp.com/oauth/callback',
        'https://c2c-eu.smartthingsgcp.com:8443/oauth/callback',
        'not a url',
    ]) {
        assert.equal(isSmartThingsRedirect(bad), false, bad)
    }
})

test('authorize page lists regions with default VAT and keeps state', async () => {
    await withServer(async ({ baseUrl }) => {
        const resp = await fetch(`${baseUrl}/oauth/authorize?${authorizeQuery({ state: '"><script>' })}`)
        assert.equal(resp.status, 200)
        assert.match(resp.headers.get('content-security-policy'), /default-src 'none'/)
        const html = await resp.text()
        assert.match(html, /name="region" value="SE3"/)
        assert.match(html, /name="vat_FI" value="25.5"/)
        assert.match(html, /name="vat_NO4" value="0"/)
        assert.match(html, /name="state" value="&quot;&gt;&lt;script&gt;"/)
        assert.doesNotMatch(html, /<script>/)
    })
})

test('authorize rejects unknown clients and foreign redirect URIs without redirecting', async () => {
    await withServer(async ({ baseUrl }) => {
        for (const overrides of [{ client_id: 'other' }, { redirect_uri: 'https://evil.example/cb' }, { response_type: 'token' }]) {
            const resp = await fetch(`${baseUrl}/oauth/authorize?${authorizeQuery(overrides)}`, { redirect: 'manual' })
            assert.equal(resp.status, 400, JSON.stringify(overrides))
        }
        const resp = await postForm(`${baseUrl}/oauth/authorize`, [...authorizeQuery({ redirect_uri: 'https://evil.example/cb' }), ['region', 'FI'], ['vat_FI', '25.5']])
        assert.equal(resp.status, 400)
    })
})

test('authorize form re-renders with errors and keeps the input', async () => {
    await withServer(async ({ baseUrl, store }) => {
        let resp = await postForm(`${baseUrl}/oauth/authorize`, [...authorizeQuery()])
        assert.equal(resp.status, 400)
        assert.match(await resp.text(), /Choose at least one price area/)

        resp = await postForm(`${baseUrl}/oauth/authorize`, [...authorizeQuery(), ['region', 'EE'], ['vat_EE', '60'], ['region', 'FI'], ['vat_FI', '24']])
        assert.equal(resp.status, 400)
        const html = await resp.text()
        assert.match(html, /EE: VAT must be a number between 0 and 50/)
        assert.match(html, /value="EE" checked/)
        assert.match(html, /name="vat_EE" value="60"/)
        assert.match(html, /name="vat_FI" value="24"/)

        resp = await postForm(`${baseUrl}/oauth/authorize`, [...authorizeQuery(), ['region', 'XX']])
        assert.equal(resp.status, 400)
        assert.deepEqual(store.regionsInUse(), [])
    })
})

test('authorize creates an installation and redirects back with code and state', async () => {
    await withServer(async ({ baseUrl, store }) => {
        const resp = await postForm(`${baseUrl}/oauth/authorize`, [
            ...authorizeQuery(), ['region', 'FI'], ['vat_FI', '25,5'], ['region', 'SE3'], ['vat_SE3', '0'], ['vat_EE', '24'],
        ])
        assert.equal(resp.status, 303)
        const location = new URL(resp.headers.get('location'))
        assert.equal(location.origin + location.pathname, REDIRECT)
        assert.equal(location.searchParams.get('state'), 'st-state')

        const grant = store.consumeAuthCode(location.searchParams.get('code'))
        assert.deepEqual(store.getInstallation(grant.installationId).regions, [
            { region: 'FI', vatPercent: 25.5 },
            { region: 'SE3', vatPercent: 0 },
        ])
    })
})

test('token endpoint exchanges a code once and issues tokens bound to the installation', async () => {
    await withServer(async ({ baseUrl, store, clock }) => {
        const code = await link(baseUrl)
        const resp = await exchangeCode(baseUrl, code)
        assert.equal(resp.status, 200)
        assert.equal(resp.headers.get('cache-control'), 'no-store')
        const tokens = await resp.json()
        assert.equal(tokens.token_type, 'Bearer')
        assert.equal(tokens.expires_in, 24 * 3600)
        assert.match(tokens.access_token, /^[\w-]{43}$/)

        const installationId = store.findInstallationIdByAccessToken(tokens.access_token)
        assert.deepEqual(store.getInstallation(installationId).regions, [{ region: 'FI', vatPercent: 25.5 }])

        const again = await exchangeCode(baseUrl, code)
        assert.equal(again.status, 400)
        assert.equal((await again.json()).error, 'invalid_grant')

        clock.now += ACCESS_TOKEN_TTL_MS
        assert.equal(store.findInstallationIdByAccessToken(tokens.access_token), null)
    })
})

test('token endpoint accepts client credentials in the body', async () => {
    await withServer(async ({ baseUrl }) => {
        const code = await link(baseUrl)
        const resp = await postForm(`${baseUrl}/oauth/token`, {
            grant_type: 'authorization_code', code, client_id: config.oauthClientId, client_secret: config.oauthClientSecret,
        })
        assert.equal(resp.status, 200)
    })
})

test('token endpoint rejects bad clients, mismatched redirect URIs and unknown grants', async () => {
    await withServer(async ({ baseUrl }) => {
        const code = await link(baseUrl)
        let resp = await postForm(`${baseUrl}/oauth/token`, { grant_type: 'authorization_code', code },
            { authorization: basic(config.oauthClientId, 'wrong') })
        assert.equal(resp.status, 401)
        assert.equal((await resp.json()).error, 'invalid_client')

        resp = await exchangeCode(baseUrl, code, { redirect_uri: 'https://c2c-us.smartthingsgcp.com/oauth/callback' })
        assert.equal(resp.status, 400)
        assert.equal((await resp.json()).error, 'invalid_grant')

        resp = await exchangeCode(baseUrl, code, { grant_type: 'password' })
        assert.equal((await resp.json()).error, 'unsupported_grant_type')

        resp = await exchangeCode(baseUrl, 'expired-or-unknown')
        assert.equal((await resp.json()).error, 'invalid_grant')
    })
})

test('auth codes expire after 10 minutes', async () => {
    await withServer(async ({ baseUrl, clock }) => {
        const code = await link(baseUrl)
        clock.now += 10 * 60 * 1000
        const resp = await exchangeCode(baseUrl, code)
        assert.equal(resp.status, 400)
    })
})

test('refresh rotates the refresh token and stops working after the installation is deleted', async () => {
    await withServer(async ({ baseUrl, store }) => {
        const first = await (await exchangeCode(baseUrl, await link(baseUrl))).json()
        const refresh = token => postForm(`${baseUrl}/oauth/token`, { grant_type: 'refresh_token', refresh_token: token },
            { authorization: basic(config.oauthClientId, config.oauthClientSecret) })

        let resp = await refresh(first.refresh_token)
        assert.equal(resp.status, 200)
        const second = await resp.json()
        assert.notEqual(second.access_token, first.access_token)
        const installationId = store.findInstallationIdByAccessToken(second.access_token)
        assert.equal(installationId, store.findInstallationIdByAccessToken(first.access_token))

        resp = await refresh(first.refresh_token)
        assert.equal((await resp.json()).error, 'invalid_grant')

        // integrationDeleted (Phase 5) calls store.deleteInstallation, which revokes everything
        store.deleteInstallation(installationId)
        resp = await refresh(second.refresh_token)
        assert.equal((await resp.json()).error, 'invalid_grant')
        assert.equal(store.findInstallationIdByAccessToken(second.access_token), null)
    })
})
