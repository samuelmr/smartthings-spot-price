import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createApp } from '../src/app.js'
import { createSchemaHandler } from '../src/schema/connector.js'
import { openStore } from '../src/store.js'

const config = {
    publicUrl: 'https://spot-price.example.com',
    stClientId: 'st-id',
    stClientSecret: 'st-secret',
    oauthClientId: 'oauth-id',
    oauthClientSecret: 'oauth-secret',
}
const REDIRECT = 'https://c2c-eu.smartthings.com/oauth/callback'

const prices = {
    current: region => region === 'FI' ? { priceNoTax: 0.15, rank: 7, start: new Date(), end: new Date() } : null,
    ensure: async () => {},
}

const silent = { info() {}, warn() {}, error() {} }

function schemaRequest(interactionType, token, extra = {}) {
    return {
        headers: { schema: 'st-schema', version: '1.0', interactionType, requestId: 'req-1' },
        authentication: { tokenType: 'Bearer', token },
        ...extra,
    }
}

test('link FI + SE3, then discover and refresh state through the app', async () => {
    const store = openStore({ path: ':memory:' })
    const schemaHandler = createSchemaHandler({ config, store, prices, log: silent })
    const server = createApp({ config, store, schemaHandler }).listen(0)
    await new Promise(resolve => server.once('listening', resolve))
    const base = `http://localhost:${server.address().port}`
    const post = (path, body, headers = {}) => fetch(`${base}${path}`, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
    })

    try {
        const query = new URLSearchParams({ client_id: 'oauth-id', redirect_uri: REDIRECT, response_type: 'code', state: 's1' })
        const page = await fetch(`${base}/oauth/authorize?${query}`)
        assert.equal(page.status, 200)

        const form = new URLSearchParams(query)
        form.append('region', 'FI')
        form.append('region', 'SE3')
        form.set('vat_FI', '25,5')
        form.set('vat_SE3', '25')
        const authorized = await fetch(`${base}/oauth/authorize`, { method: 'POST', redirect: 'manual', body: form })
        assert.equal(authorized.status, 303)
        const callback = new URL(authorized.headers.get('location'))
        assert.equal(callback.origin + callback.pathname, REDIRECT)
        assert.equal(callback.searchParams.get('state'), 's1')

        const basic = 'Basic ' + Buffer.from('oauth-id:oauth-secret').toString('base64')
        const tokenResp = await fetch(`${base}/oauth/token`, {
            method: 'POST',
            headers: { authorization: basic },
            body: new URLSearchParams({ grant_type: 'authorization_code', code: callback.searchParams.get('code'), redirect_uri: REDIRECT }),
        })
        assert.equal(tokenResp.status, 200)
        const { access_token: accessToken } = await tokenResp.json()

        const discovery = await (await post('/st-schema', schemaRequest('discoveryRequest', accessToken))).json()
        assert.deepEqual(discovery.devices.map(device => device.externalDeviceId), ['spot-price-FI', 'spot-price-SE3'])

        const refresh = await (await post('/st-schema', schemaRequest('stateRefreshRequest', accessToken))).json()
        const byId = Object.fromEntries(refresh.deviceState.map(device => [device.externalDeviceId, device.states]))
        assert.equal(byId['spot-price-FI'].find(state => state.attribute === 'price').value, 18.83)
        assert.equal(byId['spot-price-FI'].find(state => state.attribute === 'rank').value, 7)
        assert.equal(byId['spot-price-SE3'].find(state => state.attribute === 'healthStatus').value, 'offline')

        const rejected = await (await post('/st-schema', schemaRequest('discoveryRequest', 'bogus'))).json()
        assert.equal(rejected.globalError.errorEnum, 'TOKEN-EXPIRED')
    } finally {
        server.close()
        store.close()
    }
})
