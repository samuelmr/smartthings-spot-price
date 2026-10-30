// Pushes price/rank state to every installation with callback credentials, at each
// quarter-hour boundary plus a few seconds, so the new interval's price is in the cache.

import stSchema from 'st-schema'
import { log as defaultLog } from './log.js'
import { deviceStateFor } from './schema/devices.js'

export const QUARTER_HOUR_MS = 15 * 60 * 1000
export const TICK_OFFSET_MS = 5000

// First boundary + offset strictly after `at` (epoch ms)
export function nextTickAt(at, offsetMs = TICK_OFFSET_MS) {
    const next = Math.floor(at / QUARTER_HOUR_MS) * QUARTER_HOUR_MS + offsetMs
    return next > at ? next : next + QUARTER_HOUR_MS
}

// SmartThings answers these when the integration no longer exists. A single answer could
// be a SmartThings glitch, so delete only after this many consecutive ones (~45 min).
const GONE = new Set([404, 410])
export const GONE_LIMIT = 3

// Linking that hasn't reached the token exchange by then was abandoned (auth codes live 10 min)
export const ABANDONED_AFTER_MS = 60 * 60 * 1000

export function createScheduler({
    config,
    store,
    prices,
    now = Date.now,
    log = defaultLog,
    StateUpdateRequest = stSchema.StateUpdateRequest,
    setTimeout = globalThis.setTimeout,
    clearTimeout = globalThis.clearTimeout,
    offsetMs = TICK_OFFSET_MS,
}) {
    let timer = null
    let running = false

    async function ensure(regions) {
        try {
            await prices.ensure(regions)
        } catch (error) {
            log.warn('Price refresh failed', { regions, error: error.message })
        }
    }

    // → 'ok' | 'skipped' | 'deleted' | 'failed'
    async function push(installation) {
        const { id, callbackAuth, callbackUrls } = installation
        if (!callbackAuth || !callbackUrls) return 'skipped'
        const deviceState = installation.regions.map(entry => deviceStateFor(entry, prices))
        try {
            await new StateUpdateRequest(config.stClientId, config.stClientSecret).updateState(
                callbackUrls,
                callbackAuth,
                deviceState,
                refreshed => {
                    store.setCallback(id, refreshed)
                    log.info('Callback token refreshed', { installationId: id })
                },
            )
            store.resetGone(id)
            return 'ok'
        } catch (error) {
            if (GONE.has(error?.statusCode)) {
                const count = store.recordGone(id)
                if (count >= GONE_LIMIT) {
                    store.deleteInstallation(id)
                    log.warn('Integration gone, installation deleted', { installationId: id, statusCode: error.statusCode, count })
                    return 'deleted'
                }
                log.warn('Integration gone?', { installationId: id, statusCode: error.statusCode, count, limit: GONE_LIMIT })
                return 'failed'
            }
            log.error('State push failed', { installationId: id, statusCode: error?.statusCode, error: error?.message ?? String(error) })
            return 'failed'
        }
    }

    function deleteAbandoned() {
        try {
            const ids = store.deleteAbandonedInstallations(ABANDONED_AFTER_MS)
            if (ids.length > 0) log.info('Abandoned installations deleted', { installationIds: ids })
        } catch (error) {
            log.error('Deleting abandoned installations failed', { error: error.message })
        }
    }

    async function pushAll() {
        deleteAbandoned()
        await ensure(store.regionsInUse())
        const installations = store.listInstallationsWithCallbacks()
        const results = await Promise.all(installations.map(push))
        const count = outcome => results.filter(result => result === outcome).length
        log.info('State push', {
            installations: installations.length,
            ok: count('ok'),
            failed: count('failed'),
            deleted: count('deleted'),
        })
        return results
    }

    async function pushInstallation(id) {
        const installation = store.getInstallation(id)
        if (!installation) return 'skipped'
        await ensure(installation.regions.map(entry => entry.region))
        return push(installation)
    }

    function schedule(target) {
        timer = setTimeout(async () => {
            try {
                await pushAll()
            } catch (error) {
                log.error('Scheduled push failed', { error: error.message })
            }
            // From the target, not from now(): no drift, and an early wake-up can't double fire
            if (running) schedule(nextTickAt(Math.max(now(), target), offsetMs))
        }, Math.max(0, target - now()))
        timer.unref?.()
    }

    return {
        start() {
            if (running) return
            running = true
            pushAll().catch(error => log.error('Startup push failed', { error: error.message }))
            schedule(nextTickAt(now(), offsetMs))
        },
        stop() {
            running = false
            if (timer) clearTimeout(timer)
            timer = null
        },
        pushAll,
        pushInstallation,
    }
}
