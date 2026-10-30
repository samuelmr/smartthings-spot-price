import express from 'express'
import { createOAuthRouter } from './oauth/router.js'

export const HOMEPAGE = 'https://github.com/samuelmr/smartthings-spot-price#readme'

// config (enables /oauth) and schemaHandler are optional so /healthz can be tested alone
export function createApp({ config, store, schemaHandler }) {
    const app = express()
    app.disable('x-powered-by')
    app.set('trust proxy', 'loopback')
    app.use(express.json({ limit: '1mb' }))
    app.use(express.urlencoded({ extended: false }))

    app.get('/', (req, res) => res.redirect(HOMEPAGE))

    app.get('/healthz', (req, res) => {
        try {
            store.ping()
            res.send('ok')
        } catch {
            res.status(503).send('db unavailable')
        }
    })

    if (config) {
        app.use('/oauth', createOAuthRouter({ config, store }))
    }
    if (schemaHandler) {
        app.post('/st-schema', schemaHandler)
    }

    return app
}
