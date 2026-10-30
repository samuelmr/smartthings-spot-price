// Persistence for installations (one per SmartThings account link), their regions,
// OAuth codes/tokens we issue, and the SmartThings callback credentials we receive.
// Tokens we issue are stored as SHA-256 hashes; callers pass and receive plaintext.

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const MIGRATIONS = [
    `
    CREATE TABLE installations (
        id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        callback_auth TEXT,
        callback_urls TEXT
    );
    CREATE TABLE installation_regions (
        installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
        region TEXT NOT NULL,
        vat_percent REAL NOT NULL,
        PRIMARY KEY (installation_id, region)
    );
    CREATE TABLE auth_codes (
        code_hash TEXT PRIMARY KEY,
        installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
        redirect_uri TEXT NOT NULL,
        expires_at INTEGER NOT NULL
    );
    CREATE TABLE access_tokens (
        token_hash TEXT PRIMARY KEY,
        installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
        expires_at INTEGER NOT NULL
    );
    CREATE TABLE refresh_tokens (
        token_hash TEXT PRIMARY KEY,
        installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE
    );
    `,
    `
    ALTER TABLE installations ADD COLUMN gone_count INTEGER NOT NULL DEFAULT 0;
    `,
]

const hash = value => crypto.createHash('sha256').update(value).digest('hex')

export function openStore({ path: dbPath, now = Date.now } = {}) {
    if (dbPath !== ':memory:') {
        fs.mkdirSync(path.dirname(dbPath), { recursive: true })
    }
    const db = new DatabaseSync(dbPath)
    db.exec('PRAGMA foreign_keys = ON')
    db.exec('PRAGMA journal_mode = WAL')
    migrate(db)

    function transaction(fn) {
        db.exec('BEGIN')
        try {
            const result = fn()
            db.exec('COMMIT')
            return result
        } catch (error) {
            db.exec('ROLLBACK')
            throw error
        }
    }

    function regionsOf(installationId) {
        return db.prepare('SELECT region, vat_percent FROM installation_regions WHERE installation_id = ? ORDER BY region')
            .all(installationId)
            .map(row => ({ region: row.region, vatPercent: row.vat_percent }))
    }

    function toInstallation(row) {
        if (!row) return null
        return {
            id: row.id,
            createdAt: row.created_at,
            regions: regionsOf(row.id),
            callbackAuth: row.callback_auth ? JSON.parse(row.callback_auth) : null,
            callbackUrls: row.callback_urls ? JSON.parse(row.callback_urls) : null,
            goneCount: row.gone_count,
        }
    }

    return {
        close: () => db.close(),

        ping: () => db.prepare('SELECT 1 AS ok').get().ok === 1,

        // regions: [{ region: 'FI', vatPercent: 25.5 }]
        createInstallation(regions) {
            const id = crypto.randomUUID()
            transaction(() => {
                db.prepare('INSERT INTO installations (id, created_at) VALUES (?, ?)').run(id, now())
                const insert = db.prepare('INSERT INTO installation_regions (installation_id, region, vat_percent) VALUES (?, ?, ?)')
                for (const { region, vatPercent } of regions) {
                    insert.run(id, region, vatPercent)
                }
            })
            return id
        },

        getInstallation(id) {
            return toInstallation(db.prepare('SELECT * FROM installations WHERE id = ?').get(id))
        },

        listInstallationsWithCallbacks() {
            return db.prepare('SELECT * FROM installations WHERE callback_auth IS NOT NULL ORDER BY created_at')
                .all()
                .map(toInstallation)
        },

        // callbackAuth/callbackUrls as received from SmartThings (see st-schema SDK)
        setCallback(id, callbackAuth, callbackUrls) {
            db.prepare('UPDATE installations SET callback_auth = ?, callback_urls = COALESCE(?, callback_urls) WHERE id = ?')
                .run(JSON.stringify(callbackAuth), callbackUrls ? JSON.stringify(callbackUrls) : null, id)
        },

        // Consecutive "integration gone" answers from SmartThings; returns the new count
        recordGone(id) {
            db.prepare('UPDATE installations SET gone_count = gone_count + 1 WHERE id = ?').run(id)
            return db.prepare('SELECT gone_count FROM installations WHERE id = ?').get(id)?.gone_count ?? 0
        },

        resetGone(id) {
            db.prepare('UPDATE installations SET gone_count = 0 WHERE id = ? AND gone_count > 0').run(id)
        },

        deleteInstallation(id) {
            db.prepare('DELETE FROM installations WHERE id = ?').run(id)
        },

        regionsInUse() {
            return db.prepare('SELECT DISTINCT region FROM installation_regions ORDER BY region')
                .all()
                .map(row => row.region)
        },

        saveAuthCode(code, installationId, redirectUri, ttlMs) {
            db.prepare('INSERT INTO auth_codes (code_hash, installation_id, redirect_uri, expires_at) VALUES (?, ?, ?, ?)')
                .run(hash(code), installationId, redirectUri, now() + ttlMs)
        },

        // Single use: returns { installationId, redirectUri } or null if unknown/expired
        consumeAuthCode(code) {
            return transaction(() => {
                const row = db.prepare('SELECT * FROM auth_codes WHERE code_hash = ?').get(hash(code))
                if (!row) return null
                db.prepare('DELETE FROM auth_codes WHERE code_hash = ?').run(row.code_hash)
                if (row.expires_at <= now()) return null
                return { installationId: row.installation_id, redirectUri: row.redirect_uri }
            })
        },

        saveTokens(installationId, accessToken, refreshToken, accessTtlMs) {
            transaction(() => {
                db.prepare('INSERT INTO access_tokens (token_hash, installation_id, expires_at) VALUES (?, ?, ?)')
                    .run(hash(accessToken), installationId, now() + accessTtlMs)
                db.prepare('INSERT INTO refresh_tokens (token_hash, installation_id) VALUES (?, ?)')
                    .run(hash(refreshToken), installationId)
            })
        },

        // Returns the installation id, or null if the token is unknown or expired
        findInstallationIdByAccessToken(accessToken) {
            const row = db.prepare('SELECT installation_id, expires_at FROM access_tokens WHERE token_hash = ?')
                .get(hash(accessToken))
            if (!row || row.expires_at <= now()) return null
            return row.installation_id
        },

        // Single use (rotated on refresh): returns the installation id or null
        consumeRefreshToken(refreshToken) {
            return transaction(() => {
                const row = db.prepare('SELECT installation_id FROM refresh_tokens WHERE token_hash = ?').get(hash(refreshToken))
                if (!row) return null
                db.prepare('DELETE FROM refresh_tokens WHERE token_hash = ?').run(hash(refreshToken))
                return row.installation_id
            })
        },

        deleteExpired() {
            const at = now()
            db.prepare('DELETE FROM auth_codes WHERE expires_at <= ?').run(at)
            db.prepare('DELETE FROM access_tokens WHERE expires_at <= ?').run(at)
        },
    }
}

function migrate(db) {
    const { user_version: version } = db.prepare('PRAGMA user_version').get()
    for (let i = version; i < MIGRATIONS.length; i++) {
        db.exec('BEGIN')
        try {
            db.exec(MIGRATIONS[i])
            db.exec(`PRAGMA user_version = ${i + 1}`)
            db.exec('COMMIT')
        } catch (error) {
            db.exec('ROLLBACK')
            throw error
        }
    }
}
