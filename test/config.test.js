import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadConfig } from '../src/config.js'

const env = {
    PUBLIC_URL: 'https://spot-price.example.com/',
    ST_CLIENT_ID: 'st-id',
    ST_CLIENT_SECRET: 'st-secret',
    OAUTH_CLIENT_ID: 'oauth-id',
    OAUTH_CLIENT_SECRET: 'oauth-secret',
}

test('applies defaults and trims trailing slashes', () => {
    const config = loadConfig(env)
    assert.equal(config.publicUrl, 'https://spot-price.example.com')
    assert.equal(config.port, 7768)
    assert.equal(config.dbPath, './data/spot-price.db')
    assert.equal(config.spotApiBase, 'https://api.spot-hinta.fi')
    assert.equal(config.inviteUrl, null)
    assert.equal(config.capability, 'beachprepare14195.spotPrice')
    assert.equal(config.profileId, '9df37123-e82b-4ce6-a195-83f2163a4341')
})

test('reads capability and profile id overrides', () => {
    const config = loadConfig({ ...env, CAPABILITY: 'ns.spotPrice', PROFILE_ID: 'profile-1' })
    assert.equal(config.capability, 'ns.spotPrice')
    assert.equal(config.profileId, 'profile-1')
})

test('lists all missing required variables', () => {
    assert.throws(
        () => loadConfig({ PUBLIC_URL: 'https://x' }),
        /ST_CLIENT_ID, ST_CLIENT_SECRET, OAUTH_CLIENT_ID, OAUTH_CLIENT_SECRET/
    )
})

test('rejects a non-numeric port', () => {
    assert.throws(() => loadConfig({ ...env, PORT: 'abc' }), /Invalid PORT/)
})
