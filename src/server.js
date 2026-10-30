import { createApp } from './app.js'
import { loadConfig } from './config.js'
import { log } from './log.js'
import { createPrices } from './prices/index.js'
import { createScheduler } from './scheduler.js'
import { createSchemaHandler } from './schema/connector.js'
import { openStore } from './store.js'

const HOUR_MS = 60 * 60 * 1000

const config = loadConfig()
const store = openStore({ path: config.dbPath })
const prices = createPrices({ apiBase: config.spotApiBase })
const scheduler = createScheduler({ config, store, prices })
const schemaHandler = createSchemaHandler({
    config,
    store,
    prices,
    onCallbackGranted: id => scheduler.pushInstallation(id),
})
const app = createApp({ config, store, schemaHandler })

const cleanup = setInterval(() => store.deleteExpired(), HOUR_MS)
cleanup.unref()

const server = app.listen(config.port, () => {
    log.info('Listening', { port: config.port, publicUrl: config.publicUrl })
    prices.start(() => store.regionsInUse())
    scheduler.start()
})

function shutdown(signal) {
    log.info('Shutting down', { signal })
    scheduler.stop()
    prices.stop()
    clearInterval(cleanup)
    server.close(() => {
        store.close()
        process.exit(0)
    })
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
