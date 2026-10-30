import express from 'express'

// Routers for /oauth (Phase 4) and /st-schema (Phase 5) are mounted here
export function createApp({ store }) {
    const app = express()
    app.disable('x-powered-by')
    app.set('trust proxy', 'loopback')
    app.use(express.json({ limit: '1mb' }))
    app.use(express.urlencoded({ extended: false }))

    app.get('/healthz', (req, res) => {
        try {
            store.ping()
            res.send('ok')
        } catch {
            res.status(503).send('db unavailable')
        }
    })

    return app
}
