import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createApp } from '../src/app.js'
import { openStore } from '../src/store.js'

async function withServer(store, fn) {
    const server = createApp({ store }).listen(0)
    await new Promise(resolve => server.once('listening', resolve))
    try {
        await fn(`http://localhost:${server.address().port}`)
    } finally {
        server.close()
    }
}

test('healthz reports ok when the database responds', async () => {
    const store = openStore({ path: ':memory:' })
    await withServer(store, async baseUrl => {
        const resp = await fetch(`${baseUrl}/healthz`)
        assert.equal(resp.status, 200)
        assert.equal(await resp.text(), 'ok')
    })
})

test('healthz reports 503 when the database is closed', async () => {
    const store = openStore({ path: ':memory:' })
    store.close()
    await withServer(store, async baseUrl => {
        const resp = await fetch(`${baseUrl}/healthz`)
        assert.equal(resp.status, 503)
    })
})
