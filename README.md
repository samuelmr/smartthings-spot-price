# smartthings-spot-price

A SmartThings [ST Schema](https://developer.smartthings.com/docs/devices/cloud-connected/st-schema-overview)
connector that exposes Nordic and Baltic electricity spot prices as SmartThings devices.

Each linked price area (for example `FI`, `SE3` or `EE`) shows up as a
**Spot Price** device in the SmartThings app. Every 15 minutes it updates two values:

| Attribute | Meaning |
|-----------|---------|
| `price`   | Current spot price in c/kWh |
| `rank`    | Rank of the current 15-minute interval within the day (1 = cheapest) |

Use these values as conditions in ordinary SmartThings Routines, for example:

- *If Spot Price FI price is above 20 c/kWh, set the thermostat to 19 °C.*
- *If Spot Price FI rank is 16 or lower, turn on the water heater.*

Good to know:

- Price areas and VAT are chosen when you link the integration. To change them, remove
  the integration and add it again. The devices are recreated; the SmartThings app flags
  Routines that used them and lets you swap in the new device.
- For prices without VAT, enter 0 as the VAT.
- `rank` is spot-hinta's rank within the calendar day (in the area's time zone) and
  restarts at midnight. Equal prices still get distinct ranks, so rank can change while the
  price stays the same.
- Routine conditions fire when a value crosses the threshold, not while it stays beyond it.

Price data comes from [spot-hinta.fi](https://spot-hinta.fi/), which supports these areas:
FI, EE, LV, LT, SE1–SE4, NO1–NO5, DK1 and DK2.

> **Status:** early development; not yet usable.

## How it works

```
spot-hinta.fi ──(fetch per region, cached)──▶ connector (Node/Express)
                                                 │  ▲
                         state callbacks every   │  │ ST Schema interactions
                         15 min (price, rank)    ▼  │ (discovery, stateRefresh, …)
                                              SmartThings cloud ──▶ Routines
```

- **ST Schema connector** (`POST /st-schema`): handles discovery, state refresh,
  callback-access grants and integration deletion.
- **OAuth 2 account linking** (`/oauth/authorize`, `/oauth/token`): a minimal
  authorization server. When a user links the integration, they choose which
  price areas to add. There are no user accounts or passwords, because the price
  data is public.
- **Scheduler**: at each 15-minute boundary, pushes the new `price` and `rank` to
  every linked installation through the SmartThings state callback API.
- **Custom capability** `<namespace>.spotPrice`: defined in `smartthings/`
  and registered with the SmartThings CLI.

## Repository layout

```
smartthings/          SmartThings platform definitions (registered via CLI)
  capabilities/       custom capability + presentation (spotPrice)
  profiles/           device profile used by discovered devices
  schema-app.yaml     ST Schema connector registration
src/
  server.js           Express entry point
  config.js           environment configuration
  schema/             ST Schema interaction handlers and device mapping
  oauth/              account-linking authorization server
  prices/             spot-hinta.fi client, cache and price/rank lookup
  scheduler.js        15-minute state-callback pushes
  store.js            persistence (node:sqlite)
test/                 node:test unit tests
```

## Requirements

- Node.js 22.13 or newer (uses the built-in `node:sqlite` and `node:test`)
- A public HTTPS URL for the connector
- [SmartThings CLI](https://github.com/SmartThingsCommunity/smartthings-cli) and a
  SmartThings developer account

## Getting started

```sh
npm install
cp .env.example .env   # fill in values
npm start
```

Registering the capability, device profile and Schema app with SmartThings is
covered in [docs/setup.md](docs/setup.md).

## License

Apache-2.0
