// Defaults are the reference deployment's: the shared capability and its device profile
const DEFAULT_CAPABILITY = 'beachprepare14195.spotPrice'
const DEFAULT_PROFILE_ID = '9df37123-e82b-4ce6-a195-83f2163a4341'

const REQUIRED = ['PUBLIC_URL', 'ST_CLIENT_ID', 'ST_CLIENT_SECRET', 'OAUTH_CLIENT_ID', 'OAUTH_CLIENT_SECRET']

export function loadConfig(env = process.env) {
    const missing = REQUIRED.filter(name => !env[name])
    if (missing.length > 0) {
        throw new Error(`Missing required environment variables: ${missing.join(', ')}`)
    }
    const port = parseInt(env.PORT || '7768', 10)
    if (Number.isNaN(port)) {
        throw new Error(`Invalid PORT: ${env.PORT}`)
    }
    return {
        publicUrl: env.PUBLIC_URL.replace(/\/$/, ''),
        port,
        stClientId: env.ST_CLIENT_ID,
        stClientSecret: env.ST_CLIENT_SECRET,
        oauthClientId: env.OAUTH_CLIENT_ID,
        oauthClientSecret: env.OAUTH_CLIENT_SECRET,
        dbPath: env.DB_PATH || './data/spot-price.db',
        spotApiBase: (env.SPOT_API_BASE || 'https://api.spot-hinta.fi').replace(/\/$/, ''),
        inviteUrl: env.INVITE_URL || null,
        capability: env.CAPABILITY || DEFAULT_CAPABILITY,
        profileId: env.PROFILE_ID || DEFAULT_PROFILE_ID,
    }
}
