import { createApp } from './app.js'
import { loadConfig } from './config.js'
import { log } from './log.js'
import { openStore } from './store.js'

const config = loadConfig()
const store = openStore({ path: config.dbPath })
const app = createApp({ config, store })

const server = app.listen(config.port, () => {
    log.info('Listening', { port: config.port, publicUrl: config.publicUrl })
})

function shutdown(signal) {
    log.info('Shutting down', { signal })
    server.close(() => {
        store.close()
        process.exit(0)
    })
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
