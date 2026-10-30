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
