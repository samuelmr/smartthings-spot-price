// POST /st-schema. The SDK does no request authentication, so every request is resolved
// to an installation through our OAuth access token before it reaches the SDK handlers.

import stSchema from 'st-schema'
import { log as defaultLog } from '../log.js'
import { discoveryFields, deviceStateFor } from './devices.js'

const { SchemaConnector, STBase, GlobalErrorTypes, DeviceErrorTypes } = stSchema

const RESPONSE_TYPES = {
    discoveryRequest: 'discoveryResponse',
    stateRefreshRequest: 'stateRefreshResponse',
    commandRequest: 'commandResponse',
}

const ENSURE_TIMEOUT_MS = 5000

function globalError(headers, detail, errorEnum) {
    const type = RESPONSE_TYPES[headers?.interactionType] ?? headers?.interactionType
    return new STBase(type, headers?.requestId).setError(detail, errorEnum)
}

// onCallbackGranted(installationId): e.g. scheduler.pushInstallation, called after the
// response is sent. requestCallbackToken overrides the SDK's code → token exchange (tests).
export function createSchemaHandler({
    config,
    store,
    prices,
    log = defaultLog,
    onCallbackGranted = () => {},
    requestCallbackToken,
    ensureTimeoutMs = ENSURE_TIMEOUT_MS,
}) {
    // request body → installation, set after authentication
    const installations = new WeakMap()
    const afterResponse = new WeakMap()

    async function ensurePrices(regions) {
        let timer
        const timeout = new Promise(resolve => { timer = setTimeout(resolve, ensureTimeoutMs) })
        try {
            await Promise.race([prices.ensure(regions), timeout])
        } catch (error) {
            log.warn('Price refresh failed', { regions, error: error.message })
        } finally {
            clearTimeout(timer)
        }
    }

    const connector = new SchemaConnector()
        .clientId(config.stClientId)
        .clientSecret(config.stClientSecret)
        .discoveryHandler((accessToken, response, body) => {
            for (const { region } of installations.get(body).regions) {
                const fields = discoveryFields(region)
                response.addDevice(fields.externalDeviceId, fields.friendlyName, fields.deviceHandlerType)
                    .manufacturerName(fields.manufacturerName)
                    .modelName(fields.modelName)
            }
        })
        .stateRefreshHandler(async (accessToken, response, body) => {
            const { regions } = installations.get(body)
            const byDeviceId = new Map(regions.map(entry => [discoveryFields(entry.region).externalDeviceId, entry]))
            const requested = body.devices?.length
                ? body.devices.map(device => device.externalDeviceId)
                : [...byDeviceId.keys()]
            await ensurePrices(requested.filter(id => byDeviceId.has(id)).map(id => byDeviceId.get(id).region))
            for (const id of requested) {
                const entry = byDeviceId.get(id)
                if (entry) {
                    const { states } = deviceStateFor(entry, prices)
                    response.addDevice(id, states)
                } else {
                    response.addDevice(id).setError('Unknown device', DeviceErrorTypes.DEVICE_DELETED)
                }
            }
        })
        .commandHandler((accessToken, response, devices) => {
            for (const device of devices ?? []) {
                response.addDevice(device.externalDeviceId)
                    .setError('No commands supported', DeviceErrorTypes.CAPABILITY_NOT_SUPPORTED)
            }
        })
        .callbackAccessHandler((accessToken, callbackAuth, callbackUrls, body) => {
            const { id } = installations.get(body)
            store.setCallback(id, callbackAuth, callbackUrls)
            afterResponse.set(body, () => onCallbackGranted(id))
        })
        .integrationDeletedHandler((accessToken, body) => {
            store.deleteInstallation(installations.get(body).id)
        })
        .interactionResultHandler((accessToken, body) => {
            log.info('ST Schema interaction result', {
                installationId: installations.get(body).id,
                originatingInteractionType: body.originatingInteractionType,
                globalError: body.globalError,
                deviceErrors: body.deviceState?.filter(device => device.deviceError)
                    .map(device => ({ externalDeviceId: device.externalDeviceId, deviceError: device.deviceError })),
            })
        })

    if (requestCallbackToken) {
        connector.callbackTokenRequestHandler(requestCallbackToken)
    }

    return async function handleSchemaRequest(req, res) {
        const body = req.body
        const interactionType = body?.headers?.interactionType
        const done = (response, installationId, level = 'info') => {
            log[level]('ST Schema interaction', {
                interactionType,
                installationId,
                outcome: response.globalError?.errorEnum ?? 'ok',
            })
            res.status(200).json(response)
        }

        if (!body?.headers || !body.authentication?.token) {
            return done(globalError(body?.headers, 'Invalid ST Schema request', GlobalErrorTypes.BAD_REQUEST), null, 'warn')
        }

        // TOKEN-EXPIRED makes SmartThings refresh; INVALID-TOKEN means the link has to be redone.
        // An unknown token may still be refreshable while legacy installations exist (see checkAccessToken).
        const token = store.checkAccessToken(body.authentication.token)
        if (token.status === 'expired' || token.legacy) {
            return done(globalError(body.headers, 'Token expired', GlobalErrorTypes.TOKEN_EXPIRED), token.installationId ?? null, 'warn')
        }
        const installation = token.status === 'valid' && store.getInstallation(token.installationId)
        if (token.status === 'valid' && !installation) {
            log.error('Valid access token without an installation', { installationId: token.installationId })
        }
        if (!installation) {
            return done(globalError(body.headers, 'Token invalid', GlobalErrorTypes.INVALID_TOKEN), null, 'warn')
        }
        const installationId = installation.id
        installations.set(body, installation)

        // The SDK returns thrown errors (e.g. a failed callback token exchange) instead of rejecting
        const response = await connector.handleCallback(body)
        if (!(response instanceof STBase)) {
            log.error('ST Schema request failed', {
                interactionType,
                installationId,
                error: response?.message ?? String(response),
                statusCode: response?.statusCode,
            })
            const failure = globalError(body.headers, 'Internal error', 'UNKNOWN-ERROR')
            log.info('ST Schema interaction', { interactionType, installationId, outcome: 'UNKNOWN-ERROR' })
            return res.status(500).json(failure)
        }
        done(response, installationId, response.isError() ? 'warn' : 'info')

        const after = afterResponse.get(body)
        if (after) {
            Promise.resolve().then(after).catch(error => {
                log.error('Push after callback grant failed', { installationId, error: error.message })
            })
        }
    }
}
