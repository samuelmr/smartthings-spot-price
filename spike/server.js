// Phase 0 spike: hard-coded FI connector to verify that a custom capability on an
// ST Schema device works in the SmartThings app and in Routine conditions.
// Throwaway code; replaced by src/ in Phase 1+.

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import express from 'express'
import stSchema from 'st-schema'

const { SchemaConnector, StateUpdateRequest } = stSchema

const config = {
    port: process.env.PORT || 7768,
    stClientId: process.env.ST_CLIENT_ID || '',
    stClientSecret: process.env.ST_CLIENT_SECRET || '',
    oauthClientId: process.env.OAUTH_CLIENT_ID || '',
    oauthClientSecret: process.env.OAUTH_CLIENT_SECRET || '',
    dataFile: process.env.SPIKE_DATA_FILE || './data/spike.json',
    spotApi: process.env.SPOT_API_BASE || 'https://api.spot-hinta.fi',
}

const PROFILE_ID = '9df37123-e82b-4ce6-a195-83f2163a4341'
const CAPABILITY = 'beachprepare14195.spotPrice'
const REGION = 'FI'
const VAT = 0.255
const DEVICE_ID = `spot-price-${REGION}`
const QUARTER_HOUR = 15 * 60 * 1000

// { codes: { code: installationId }, tokens: { accessToken: installationId },
//   refreshTokens: { refreshToken: installationId }, installations: { id: { callbackAuth, callbackUrls } } }
let db = { codes: {}, tokens: {}, refreshTokens: {}, installations: {} }

function load() {
    try {
        db = JSON.parse(fs.readFileSync(config.dataFile, 'utf8'))
    } catch (error) {
        if (error.code !== 'ENOENT') throw error
    }
}

function save() {
    fs.mkdirSync(path.dirname(config.dataFile), { recursive: true })
    fs.writeFileSync(config.dataFile, JSON.stringify(db, null, 2))
}

const randomToken = () => crypto.randomBytes(32).toString('hex')

async function currentPrice() {
    const resp = await fetch(`${config.spotApi}/TodayAndDayForward?region=${REGION}&priceResolution=15`)
    if (!resp.ok) throw new Error(`spot-hinta ${resp.status}`)
    const items = await resp.json()
    const now = Date.now()
    const item = items.find(i => {
        const start = new Date(i.DateTime).getTime()
        return start <= now && now < start + QUARTER_HOUR
    })
    if (!item) return null
    return {
        price: Math.round(item.PriceNoTax * (1 + VAT) * 10000) / 100, // c/kWh
        rank: item.Rank,
    }
}

async function deviceStates() {
    const current = await currentPrice().catch(error => {
        console.error('Failed to get price', error)
        return null
    })
    if (!current) {
        return [{ component: 'main', capability: 'st.healthCheck', attribute: 'healthStatus', value: 'offline' }]
    }
    return [
        { component: 'main', capability: CAPABILITY, attribute: 'price', value: current.price, unit: 'c/kWh' },
        { component: 'main', capability: CAPABILITY, attribute: 'rank', value: current.rank },
        { component: 'main', capability: 'st.healthCheck', attribute: 'healthStatus', value: 'online' },
    ]
}

const connector = new SchemaConnector()
    .clientId(config.stClientId)
    .clientSecret(config.stClientSecret)
    .enableEventLogging(2)
    .discoveryHandler((accessToken, response) => {
        response.addDevice(DEVICE_ID, `Spot Price ${REGION}`, PROFILE_ID)
            .manufacturerName('spot-hinta.fi')
            .modelName(`Spot price ${REGION}`)
    })
    .stateRefreshHandler(async (accessToken, response) => {
        response.addDevice(DEVICE_ID, await deviceStates())
    })
    .commandHandler((accessToken, response, devices) => {
        for (const device of devices) {
            response.addDevice(device.externalDeviceId).setError('No commands supported', 'CAPABILITY-NOT-SUPPORTED')
        }
    })
    .callbackAccessHandler((accessToken, callbackAuth, callbackUrls) => {
        const installationId = db.tokens[accessToken]
        db.installations[installationId] = { callbackAuth, callbackUrls }
        save()
        console.log('Callback access granted for installation', installationId)
    })
    .integrationDeletedHandler(accessToken => {
        const installationId = db.tokens[accessToken]
        delete db.installations[installationId]
        for (const table of [db.tokens, db.refreshTokens]) {
            for (const [token, id] of Object.entries(table)) {
                if (id === installationId) delete table[token]
            }
        }
        save()
        console.log('Integration deleted for installation', installationId)
    })
    .interactionResultHandler((accessToken, body) => {
        console.log('Interaction result', JSON.stringify(body))
    })

async function pushState() {
    const states = await deviceStates()
    for (const [installationId, installation] of Object.entries(db.installations)) {
        if (!installation.callbackAuth) continue
        try {
            await new StateUpdateRequest(config.stClientId, config.stClientSecret).updateState(
                installation.callbackUrls,
                installation.callbackAuth,
                [{ externalDeviceId: DEVICE_ID, states }],
                refreshed => {
                    installation.callbackAuth = refreshed
                    save()
                }
            )
            console.log(new Date().toISOString(), 'Pushed state to', installationId, JSON.stringify(states))
        } catch (error) {
            console.error('State push failed for', installationId, error.message)
        }
    }
}

function scheduleNextPush() {
    const delay = QUARTER_HOUR - (Date.now() % QUARTER_HOUR) + 5000
    setTimeout(async () => {
        await pushState()
        scheduleNextPush()
    }, delay)
}

function clientAuthorized(req) {
    let id = req.body.client_id
    let secret = req.body.client_secret
    const header = req.get('authorization')
    if (header?.startsWith('Basic ')) {
        [id, secret] = Buffer.from(header.slice(6), 'base64').toString().split(':')
    }
    return id === config.oauthClientId && secret === config.oauthClientSecret
}

const app = express()
app.use(express.json())
app.use(express.urlencoded({ extended: false }))

app.get('/healthz', (req, res) => res.send('ok'))

// Auto-approves; the real version shows a region/VAT form
app.get('/oauth/authorize', (req, res) => {
    const { client_id, redirect_uri, state } = req.query
    if (client_id !== config.oauthClientId || !redirect_uri) {
        return res.status(400).send('Invalid client')
    }
    const code = randomToken()
    db.codes[code] = crypto.randomUUID()
    save()
    const url = new URL(redirect_uri)
    url.searchParams.set('code', code)
    if (state) url.searchParams.set('state', state)
    console.log('Authorize: redirecting to', url.origin + url.pathname)
    res.redirect(url.toString())
})

app.post('/oauth/token', (req, res) => {
    if (!clientAuthorized(req)) {
        return res.status(401).json({ error: 'invalid_client' })
    }
    let installationId
    if (req.body.grant_type === 'authorization_code') {
        installationId = db.codes[req.body.code]
        delete db.codes[req.body.code]
    } else if (req.body.grant_type === 'refresh_token') {
        installationId = db.refreshTokens[req.body.refresh_token]
        delete db.refreshTokens[req.body.refresh_token]
    }
    if (!installationId) {
        return res.status(400).json({ error: 'invalid_grant' })
    }
    const accessToken = randomToken()
    const refreshToken = randomToken()
    db.tokens[accessToken] = installationId
    db.refreshTokens[refreshToken] = installationId
    save()
    console.log('Token issued for installation', installationId, 'grant', req.body.grant_type)
    res.json({ access_token: accessToken, refresh_token: refreshToken, token_type: 'Bearer', expires_in: 7 * 24 * 3600 })
})

app.post('/st-schema', (req, res) => {
    const token = req.body?.authentication?.token
    if (!db.tokens[token]) {
        console.warn('Rejected Schema request with unknown token', req.body?.headers?.interactionType)
        return res.status(401).json({ error: 'invalid_token' })
    }
    connector.handleHttpCallback(req, res)
})

load()
app.listen(config.port, () => {
    console.log(`Spike connector listening on port ${config.port}`)
    scheduleNextPush()
})
