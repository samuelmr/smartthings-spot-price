# Setup

How to register the connector with SmartThings, host it, and test it in the
SmartThings app. The steps below are the ones used for the reference deployment at
`https://spot-price.ctrldash.app`; to run your own copy, follow them in your own
SmartThings developer account and substitute your own values.

Placeholders used throughout:

| Placeholder | Meaning | Where it comes from |
|-------------|---------|---------------------|
| `<org>` | Developer organization id | `smartthings organizations` |
| `<namespace>` | Your capability namespace (the reference one is `beachprepare14195`) | `smartthings capabilities:namespaces -O <org>` or the `capabilities:create` output |
| `<profileId>` | Device profile id | `deviceprofiles:create` output |
| `<vid>` | Device presentation id | `deviceprofiles:create` output (`metadata.vid`) |
| `<endpointAppId>` | Schema app id (`viper_…`) | `schema:create` output |
| `<host>` | Public hostname of the connector, e.g. `spot-price.example.com` | your DNS |

Never commit real client ids or secrets. Only `*.local.yaml` and `.env` files
(both gitignored) hold them.

## 1. Prerequisites

- Node.js 22.13 or newer (the connector uses `node:sqlite`).
- A SmartThings developer account (Samsung account) and the
  [SmartThings CLI](https://github.com/SmartThingsCommunity/smartthings-cli) v2.x.
- A server with a public HTTPS hostname, a reverse proxy in front of the
  connector, and pm2.
- The SmartThings app on a phone, signed in with a Samsung account.

## 2. SmartThings CLI and organization

The CLI logs in through a browser on the first command that needs it.

```sh
smartthings organizations          # note the id of your developer organization: <org>
```

The CLI's default context is **not** your developer organization. Pass
`-O <org>` to every `capabilities*`, `deviceprofiles*` and `schema:create` command
below; otherwise the capability ends up in a different, personal namespace.
`presentation:*` and `invites:schema*` commands do not accept `-O`.

## 3. Use your own namespace

Skip this section if you are the repo owner (namespace `beachprepare14195`).

The capability id is `<namespace>.spotPrice`, and the namespace is assigned per
account. The repo files reference the owner's namespace. Find every occurrence and
replace it with yours once you know it (after step 4.1 at the latest):

```sh
grep -rn beachprepare14195 smartthings src
```

This covers `smartthings/capabilities/spotPrice.presentation.json`,
`smartthings/profiles/spot-price.yaml`,
`smartthings/profiles/spot-price.device-config.json` and the capability id
constant in the connector code. The device profile id (step 4.3) is also a constant
in the connector code (it is sent as `deviceHandlerType` at discovery), so update it
too.

## 4. Register capability, device profile and presentation

Run from the repository root.

### 4.1 Capability

```sh
smartthings capabilities:create -O <org> -j -i smartthings/capabilities/spotPrice.json
```

The output contains the id `<namespace>.spotPrice` (version 1). Then attach the
presentation (detail view and Routine conditions for `price` and `rank`). The version
is a flag, not a positional argument:

```sh
smartthings capabilities:presentation:create -O <org> <namespace>.spotPrice \
  --capability-version 1 -j -i smartthings/capabilities/spotPrice.presentation.json
```

### 4.2 Device profile

```sh
smartthings deviceprofiles:create -O <org> -y -i smartthings/profiles/spot-price.yaml
```

Note the profile `id` (`<profileId>`) and `metadata.vid` (`<vid>`) from the output.

### 4.3 Device presentation

The profile gets a `vid`, but no presentation exists behind it yet. Generate the
default device config, trim it, and create it:

```sh
smartthings presentation:device-config:generate <profileId> -j \
  -o smartthings/profiles/spot-price.device-config.json
```

Remove the `healthCheck` entries from `automation.conditions`,
`automation.actions` and `detailView` (the committed copy already has them removed;
`git diff` shows what to drop). Then:

```sh
smartthings presentation:device-config:create -j -i smartthings/profiles/spot-price.device-config.json
```

For the reference deployment this returned the same `vid` as the profile (manufacturer
name `SmartThingsCommunity`), so the profile did not need an update. If you get a
different `vid`, the profile's `metadata.vid` has to point at it
(`smartthings deviceprofiles:update`).

Verify that the presentation resolves and lists Price and Rank as conditions:

```sh
smartthings presentation <vid>
```

## 5. Register the Schema app

Generate the OAuth client credentials that SmartThings will present to the
connector's account-linking server:

```sh
openssl rand -hex 32   # OAUTH_CLIENT_ID
openssl rand -hex 32   # OAUTH_CLIENT_SECRET
```

Create a local, gitignored copy of the registration and fill it in:

```sh
cp smartthings/schema-app.yaml smartthings/schema-app.local.yaml
chmod 600 smartthings/schema-app.local.yaml
```

In `schema-app.local.yaml`:

- `oAuthClientId` / `oAuthClientSecret`: the two generated values. They must equal
  `OAUTH_CLIENT_ID` / `OAUTH_CLIENT_SECRET` in the server `.env` (step 6.3).
- `userEmail`: the Samsung account email of the developer account.
- `webhookUrl`, `oAuthAuthorizationUrl`, `oAuthTokenUrl`: change the host if you are
  not using `spot-price.ctrldash.app`.

Register it:

```sh
smartthings schema:create -O <org> -i smartthings/schema-app.local.yaml -j
```

Do not pass both `-y` and `-j`: the format flags apply to input and output
together and are mutually exclusive.

The output contains:

| Field | Use |
|-------|-----|
| `endpointAppId` | the Schema app id (`viper_…`), needed for invitations |
| `stClientId` | `ST_CLIENT_ID` in the server `.env` |
| `stClientSecret` | `ST_CLIENT_SECRET` in the server `.env` |

Copy the two values straight into the server `.env` and don't keep the output around.

> Warning: `smartthings schema` (listing or showing an app) prints the OAuth client
> secret in clear text. Don't run it where the output is recorded or shared.

## 6. Hosting

The reference deployment runs on ctrldash.app behind Apache, with pm2 managing the
Node process on port 7768.

### 6.1 DNS and TLS

1. Add a DNS A record `spot-price.ctrldash.app` → server IP.
2. The Apache vhost for `*.ctrldash.app` already proxies hostnames starting with
   `spot` to `http://localhost:7768` (mod_rewrite rule with `[P]`). For another server,
   add an equivalent reverse-proxy rule for `<host>`.
3. Add the hostname to the existing Let's Encrypt certificate. `--expand` needs the
   full list of names: every name already on the certificate plus the new one, and
   every name must resolve, or issuance fails.

   ```sh
   sudo certbot certificates          # lists the names currently on the cert
   sudo certbot certonly --apache --cert-name ctrldash.app --expand \
     -d <existing names, comma-separated>,spot-price.ctrldash.app
   sudo systemctl reload apache2
   ```

After adding the DNS record, local resolvers may cache the earlier NXDOMAIN for a
while. On macOS:

```sh
sudo dscacheutil -flushcache; sudo killall -HUP mDNSResponder
```

### 6.2 Deploy by git push

One-time setup on the server: a non-bare repository that updates its working tree
on push.

```sh
# on the server
mkdir -p ~/github/smartthings-spot-price && cd ~/github/smartthings-spot-price
git init
git config receive.denyCurrentBranch updateInstead
```

Locally:

```sh
git remote add ctrldash ctrldash.app:github/smartthings-spot-price
```

### 6.3 Server `.env`

Create `~/github/smartthings-spot-price/.env` on the server from `.env.example`,
mode 600:

```sh
cp .env.example .env && chmod 600 .env
```

| Variable | Required | Value |
|----------|----------|-------|
| `PUBLIC_URL` | yes | `https://<host>` |
| `PORT` | no (default 7768) | must match the reverse proxy target |
| `ST_CLIENT_ID` | yes | `stClientId` from `schema:create` |
| `ST_CLIENT_SECRET` | yes | `stClientSecret` from `schema:create` |
| `OAUTH_CLIENT_ID` | yes | the `oAuthClientId` you generated |
| `OAUTH_CLIENT_SECRET` | yes | the `oAuthClientSecret` you generated |
| `DB_PATH` | no (default `./data/spot-price.db`) | SQLite database file |
| `SPOT_API_BASE` | no (default `https://api.spot-hinta.fi`) | price API base URL |

The server refuses to start if a required variable is missing.

### 6.4 Deploy and run

```sh
git push ctrldash main
```

Then on the server:

```sh
cd ~/github/smartthings-spot-price
npm ci
pm2 start ecosystem.config.cjs     # first time
pm2 reload ecosystem.config.cjs    # every later deploy
pm2 save                           # optional: keep it in pm2's saved process list
```

The pm2 app is named `Spot price connector` and runs `src/server.js` with `.env`
loaded. (Until the integration step, `ecosystem.config.cjs` points at the Phase 0
`spike/server.js` instead.)

The SQLite database (`DB_PATH`) holds the linked installations and their tokens.
Back it up if you don't want to re-link after losing the server.

## 7. Test in the SmartThings app

### 7.1 Enable Developer mode

1. In the SmartThings app, open Settings and **long-press** "About SmartThings" for
   about 5–10 seconds.
   If a password prompt appears, you opened the internal Test Mode instead: cancel
   and don't enter anything.
2. Toggle **Developer mode** on.
3. Restart the app.

### 7.2 Link the integration

Add device → **My Testing Devices** → **Spot Price**. The connector's authorize page
opens: tick the price areas and set VAT % for each, then submit. One Spot Price
device is created per area.

"My Testing Devices" only lists Schema apps owned by the Samsung account signed in
to the app. To test with a different account, create a single-use invitation:

```sh
cat > invite.json <<'EOF'
{ "schemaAppId": "<endpointAppId>", "description": "Spot Price tester", "acceptLimit": 1 }
EOF
smartthings invites:schema:create -i invite.json
```

Open the returned `acceptUrl` on the phone while signed in with the other account.
List and revoke invitations with:

```sh
smartthings invites:schema --schema-app <endpointAppId>
smartthings invites:schema:delete --schema-app <endpointAppId>   # pick from a list
smartthings invites:schema:delete <invitationId>
```

### 7.3 Verify

Watch the server logs while linking:

```sh
pm2 logs 'Spot price connector'
```

Expected order: OAuth authorize → token → `grantCallbackAccess` →
`discoveryRequest` → `stateRefreshRequest`. After that, the connector pushes a state
update every 15 minutes.

In the app, the device shows the current price on the dashboard and price and rank
in the detail view. Both are available as Routine conditions. Keep in mind when
testing Routines:

- A threshold condition (for example "price above 20") fires only when the value
  **crosses** the threshold, not while it stays above it.
- `rank` can change while `price` stays the same: spot-hinta gives tied prices
  distinct ranks.

## 8. Changing price areas or VAT

There is no settings page. To change the areas or VAT, remove the integration in the
SmartThings app and link it again (step 7.2). The devices are recreated, so Routines that use them must be rebuilt.
