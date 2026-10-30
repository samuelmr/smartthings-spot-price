// OAuth 2 authorization server for ST Schema account linking. There are no user accounts:
// the authorize step creates an installation from the regions/VAT the user picks, and the
// tokens we issue identify that installation in later Schema requests.

import express from 'express'
import { log } from '../log.js'
import { getRegion } from '../prices/regions.js'
import { MAX_VAT_PERCENT, renderAuthorizePage, renderErrorPage } from './form.js'
import { issueAuthCode, issueTokens, safeEqual } from './tokens.js'

// SmartThings' regional OAuth callback hosts (c2c-us, c2c-eu, c2c-ap, ...). Linking was
// observed with https://c2c-eu.smartthings.com/oauth/callback; smartthingsgcp.com is
// the documented older domain.
const SMARTTHINGS_REDIRECT_HOST = /^c2c-[a-z0-9-]+\.smartthings(gcp)?\.com$/

export function isSmartThingsRedirect(redirectUri) {
    let url
    try {
        url = new URL(redirectUri)
    } catch {
        return false
    }
    return url.protocol === 'https:' && !url.port && !url.username && !url.password
        && SMARTTHINGS_REDIRECT_HOST.test(url.hostname)
}

const SECURITY_HEADERS = {
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
}

// Accepts "25.5" and "25,5"; returns a number in 0..MAX_VAT_PERCENT or null
export function parseVatPercent(value) {
    if (typeof value !== 'string') return null
    const normalized = value.trim().replace(',', '.')
    if (!/^\d{1,2}(\.\d{1,2})?$/.test(normalized)) return null
    const percent = Number(normalized)
    return percent <= MAX_VAT_PERCENT ? percent : null
}

// Returns { regions: [{ region, vatPercent }], values, errors } from the posted form
export function parseRegionForm(body) {
    const selected = [body.region ?? []].flat().filter(code => typeof code === 'string')
    const values = {
        regions: new Set(selected),
        vat: Object.fromEntries(Object.entries(body)
            .filter(([name, value]) => name.startsWith('vat_') && typeof value === 'string')
            .map(([name, value]) => [name.slice(4), value])),
    }
    const errors = {}
    const regions = []
    for (const code of values.regions) {
        if (!getRegion(code)) {
            errors.form = `Unknown price area: ${code}`
            continue
        }
        const vatPercent = parseVatPercent(values.vat[code])
        if (vatPercent === null) {
            errors[code] = `${code}: VAT must be a number between 0 and ${MAX_VAT_PERCENT}.`
            continue
        }
        regions.push({ region: code, vatPercent })
    }
    if (values.regions.size === 0) {
        errors.form = 'Choose at least one price area.'
    }
    return { regions, values, errors }
}

// RFC 6749 §2.3.1: Basic auth (form-urlencoded id/secret) or client_id/client_secret in the body
function clientCredentials(req) {
    const header = req.get('authorization')
    if (header?.startsWith('Basic ')) {
        const decoded = Buffer.from(header.slice(6), 'base64').toString()
        const separator = decoded.indexOf(':')
        if (separator < 0) return {}
        try {
            return {
                id: decodeURIComponent(decoded.slice(0, separator).replaceAll('+', ' ')),
                secret: decodeURIComponent(decoded.slice(separator + 1).replaceAll('+', ' ')),
            }
        } catch {
            return {}
        }
    }
    return { id: req.body?.client_id, secret: req.body?.client_secret }
}

export function createOAuthRouter({ config, store, isAllowedRedirect = isSmartThingsRedirect }) {
    const router = express.Router()

    // Returns an error message, or null when client_id/redirect_uri/response_type are acceptable.
    // Never redirect on these errors (RFC 6749 §4.1.2.1): the redirect target is untrusted.
    function checkAuthorizeParams(params) {
        if (!safeEqual(params.client_id, config.oauthClientId)) return 'Unknown client.'
        if (typeof params.redirect_uri !== 'string' || !isAllowedRedirect(params.redirect_uri)) {
            log.warn('OAuth authorize rejected redirect_uri', { redirectUri: originOf(params.redirect_uri) })
            return 'Invalid redirect URI.'
        }
        if (params.response_type !== undefined && params.response_type !== 'code') {
            return 'Unsupported response type.'
        }
        return null
    }

    function pickParams(source) {
        const params = {}
        for (const name of ['client_id', 'redirect_uri', 'state', 'response_type']) {
            if (typeof source[name] === 'string') params[name] = source[name]
        }
        return params
    }

    router.get('/authorize', (req, res) => {
        res.set(SECURITY_HEADERS)
        const params = pickParams(req.query)
        const error = checkAuthorizeParams(params)
        if (error) return res.status(400).type('html').send(renderErrorPage(error))
        res.type('html').send(renderAuthorizePage({ params }))
    })

    router.post('/authorize', (req, res) => {
        res.set(SECURITY_HEADERS)
        const body = req.body ?? {}
        const params = pickParams(body)
        const error = checkAuthorizeParams(params)
        if (error) return res.status(400).type('html').send(renderErrorPage(error))

        const { regions, values, errors } = parseRegionForm(body)
        if (Object.keys(errors).length > 0) {
            return res.status(400).type('html').send(renderAuthorizePage({ params, values, errors }))
        }

        const installationId = store.createInstallation(regions)
        const code = issueAuthCode(store, installationId, params.redirect_uri)
        log.info('OAuth installation created', { installationId, regions: regions.map(r => r.region) })

        const url = new URL(params.redirect_uri)
        url.searchParams.set('code', code)
        if (params.state) url.searchParams.set('state', params.state)
        res.redirect(303, url.toString())
    })

    router.post('/token', (req, res) => {
        res.set({ 'Cache-Control': 'no-store', Pragma: 'no-cache' })
        const fail = (status, error, fields = {}) => {
            log.warn('OAuth token request rejected', { error, grantType: req.body?.grant_type, ...fields })
            res.status(status).json({ error })
        }

        const { id, secret } = clientCredentials(req)
        if (!safeEqual(id, config.oauthClientId) || !safeEqual(secret, config.oauthClientSecret)) {
            res.set('WWW-Authenticate', 'Basic realm="oauth"')
            return fail(401, 'invalid_client')
        }

        store.deleteExpired()
        const body = req.body ?? {}
        let installationId = null
        if (body.grant_type === 'authorization_code') {
            if (typeof body.code !== 'string') return fail(400, 'invalid_request')
            const grant = store.consumeAuthCode(body.code)
            if (!grant) return fail(400, 'invalid_grant')
            if (body.redirect_uri !== undefined && body.redirect_uri !== grant.redirectUri) {
                return fail(400, 'invalid_grant', { reason: 'redirect_uri mismatch' })
            }
            installationId = grant.installationId
        } else if (body.grant_type === 'refresh_token') {
            if (typeof body.refresh_token !== 'string') return fail(400, 'invalid_request')
            installationId = store.consumeRefreshToken(body.refresh_token)
            if (!installationId) return fail(400, 'invalid_grant')
        } else {
            return fail(400, 'unsupported_grant_type')
        }

        if (!store.getInstallation(installationId)) return fail(400, 'invalid_grant', { installationId })
        log.info('OAuth tokens issued', { installationId, grantType: body.grant_type })
        res.json(issueTokens(store, installationId))
    })

    return router
}

function originOf(value) {
    try {
        return new URL(value).origin
    } catch {
        return typeof value === 'string' ? value.slice(0, 100) : null
    }
}
