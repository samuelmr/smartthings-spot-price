# smartthings-spot-price

[![test](https://github.com/samuelmr/smartthings-spot-price/actions/workflows/test.yml/badge.svg)](https://github.com/samuelmr/smartthings-spot-price/actions/workflows/test.yml)

Nordic and Baltic electricity spot prices as SmartThings devices, so you can use the
price in ordinary SmartThings Routines.

Each price area you link (for example `FI`, `SE3` or `EE`) shows up as a
**Spot Price** device in the SmartThings app. Every 15 minutes it updates two values:

| Attribute | Meaning |
|-----------|---------|
| `price`   | Current spot price in c/kWh, including the VAT you chose |
| `rank`    | Rank of the current 15-minute interval within the day (1 = cheapest) |

Use them as Routine conditions, for example:

- *If Spot Price FI price is above 20 c/kWh, set the thermostat to 19 °C.*
- *If Spot Price FI rank is 16 or lower, turn on the water heater* (the cheapest 4 hours
  of the day).

Price data comes from [spot-hinta.fi](https://spot-hinta.fi/). Supported areas: FI, EE,
LV, LT, SE1–SE4, NO1–NO5, DK1 and DK2.

Technically, this is an [ST Schema](https://developer.smartthings.com/docs/devices/cloud-connected/st-schema-overview)
cloud connector with a custom capability. A hosted instance runs at
`https://spot-price.ctrldash.app`; you can use it or run your own.

## Using the hosted connector

The SmartThings app isn't published in the SmartThings catalog. You add it as a
testing device after accepting an invitation.

1. **Accept the invitation.** Open <https://spot-price.ctrldash.app/invite> in a
   **desktop browser**, sign in with your Samsung account and accept. (Accepting on a
   phone browser has failed in testing.)
2. **Enable Developer mode** in the SmartThings app: open Settings, **long-press**
   "About SmartThings" for 5–10 seconds, toggle Developer mode on and restart the app.
   If a password prompt appears instead, cancel: that's a different, internal menu.
3. **Add the device.** Add device → **My Testing Devices** → **Spot Price**. Tick the
   price areas you want and set the VAT % for each (pre-filled with the area's standard
   rate; enter 0 for prices without VAT). One Spot Price device is created per area.
4. **Create Routines** with the device's `price` or `rank` as a condition.

Good to know:

- **Conditions trigger on change.** A Routine with "price above 20" runs when the price
  crosses 20, not every 15 minutes while it stays above.
- **Rank restarts at midnight** in the area's time zone. Equal prices still get distinct
  ranks, so the rank can change while the price stays the same.
- **Changing areas or VAT:** remove the integration and add it again. The devices are
  recreated; the SmartThings app flags Routines that used the old device and lets you
  swap in the new one.
- **If the invitation link doesn't work,** it may have just been renewed (invitations
  expire monthly) or run out. Try again later or
  [open an issue](https://github.com/samuelmr/smartthings-spot-price/issues).
- **Privacy:** there are no user accounts. The connector stores the areas and VAT you
  chose and the tokens SmartThings needs to receive updates; nothing else about you.
- The hosted connector is a hobby project with no uptime guarantee. If it's unreachable
  or prices are missing, the device shows as offline.

## Running your own connector

Running your own copy means registering your own capability, device profile and Schema
app in your SmartThings developer account, and hosting the connector at a public
HTTPS URL.

Requirements:

- Node.js 22.13 or newer (uses the built-in `node:sqlite` and `node:test`)
- A public HTTPS URL, typically a reverse proxy in front of the Node process
- [SmartThings CLI](https://github.com/SmartThingsCommunity/smartthings-cli) and a
  SmartThings developer account

```sh
npm install
cp .env.example .env   # fill in the values
npm start
```

[docs/setup.md](docs/setup.md) covers the rest step by step: SmartThings registration,
your own capability namespace, environment variables, deployment with pm2, invitations,
and testing in the app.

## How it works

```
spot-hinta.fi ──(fetch per region, cached)──▶ connector (Node/Express)
                                                 │  ▲
                         state callbacks every   │  │ ST Schema interactions
                         15 min (price, rank)    ▼  │ (discovery, stateRefresh, …)
                                              SmartThings cloud ──▶ Routines
```

- **ST Schema connector** (`POST /st-schema`): discovery, state refresh, callback
  access grants and integration deletion.
- **OAuth 2 account linking** (`/oauth/authorize`, `/oauth/token`): a minimal
  authorization server. The "login" page is the area and VAT picker; there are no
  passwords, because the price data is public.
- **Scheduler:** at each quarter hour, pushes the new `price` and `rank` to every
  linked installation through the SmartThings state callback API.
- **Prices:** fetched from spot-hinta.fi per area at 15-minute resolution, cached, and
  refetched when less than 12 hours of prices are known. The price is spot-hinta's
  price without tax, multiplied by (1 + VAT).
- **Custom capability** `<namespace>.spotPrice`, defined in `smartthings/` and
  registered with the SmartThings CLI.

## Contributing

Issues and pull requests are welcome. For anything bigger than a fix, open an issue
first to discuss it.

### Repository layout

```
src/
  server.js           entry point: wiring, startup, shutdown
  app.js              Express routes
  config.js           environment configuration
  log.js              JSON-lines logging
  store.js            persistence (node:sqlite, migrations via PRAGMA user_version)
  scheduler.js        quarter-hour state-callback pushes
  schema/             ST Schema interaction handlers and device mapping
  oauth/              account-linking authorization server and area/VAT form
  prices/             spot-hinta.fi client, cache, regions, VAT, current price/rank
smartthings/          SmartThings definitions registered via the CLI
  capabilities/       spotPrice capability and its presentation
  profiles/           device profile and device config
  schema-app.yaml     Schema app registration template
test/                 node:test tests; fixtures/ holds recorded spot-hinta responses
docs/setup.md         registration, hosting and testing guide
```

### Development

```sh
npm install
npm test        # node:test, no network access needed
npm run dev     # restarts on file changes; needs a filled-in .env
```

- Plain JavaScript ES modules, no build step and no TypeScript. Keep dependencies few.
- Tests use `node:test` and `node:assert` with recorded fixtures. Add or update tests
  with every change.
- Match the existing style: 4-space indentation, no semicolons, single quotes.
- Changing the capability (new attributes, for example) means registering a new
  capability version in SmartThings, which only the maintainer can do for the hosted
  connector. Mention it in your pull request.

## License

[Apache-2.0](LICENSE)
