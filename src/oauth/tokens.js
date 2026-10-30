// Opaque tokens we issue to SmartThings. Plaintext leaves this process only in the
// token response; the store keeps SHA-256 hashes.

import crypto from 'node:crypto'

export const AUTH_CODE_TTL_MS = 10 * 60 * 1000
export const ACCESS_TOKEN_TTL_MS = 24 * 60 * 60 * 1000

export const randomToken = () => crypto.randomBytes(32).toString('base64url')

// Returns the OAuth token response body
export function issueTokens(store, installationId) {
    const accessToken = randomToken()
    const refreshToken = randomToken()
    store.saveTokens(installationId, accessToken, refreshToken, ACCESS_TOKEN_TTL_MS)
    return {
        access_token: accessToken,
        refresh_token: refreshToken,
        token_type: 'Bearer',
        expires_in: ACCESS_TOKEN_TTL_MS / 1000,
    }
}

export function issueAuthCode(store, installationId, redirectUri) {
    const code = randomToken()
    store.saveAuthCode(code, installationId, redirectUri, AUTH_CODE_TTL_MS)
    return code
}

// Constant-time string comparison (lengths may differ)
export function safeEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false
    const hashA = crypto.createHash('sha256').update(a).digest()
    const hashB = crypto.createHash('sha256').update(b).digest()
    return crypto.timingSafeEqual(hashA, hashB)
}
