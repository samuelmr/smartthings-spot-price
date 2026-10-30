# Copilot instructions

SmartThings ST Schema connector that exposes spot-hinta.fi electricity prices as
SmartThings devices with a custom `spotPrice` capability (`price`, `rank`). Read
README.md (how it works, repository layout) before changing code; docs/setup.md
covers SmartThings registration and hosting.

## Stack and constraints

- Node.js >= 22.13, plain JavaScript ES modules. No build step, no TypeScript, no
  transpilers, no bundlers.
- Built-ins first: `node:sqlite` for persistence, `node:test` + `node:assert/strict`
  for tests, global `fetch`. Runtime dependencies are only `express` and `st-schema`;
  don't add new ones (runtime or dev) without saying why in the PR.
- Production runs one long-lived process under pm2. There is no other infrastructure.

## Style

- 4-space indentation, no semicolons, single quotes, template literals for
  interpolation. Match the surrounding code; there is no linter config.
- Small modules with factory functions (`createApp`, `createScheduler`, `openStore`)
  that take their dependencies as an options object. Inject `now`, `fetch`, `log`
  and SDK classes so tests can replace them; don't call `Date.now()` directly in
  logic that tests need to control.
- Comments are sparse and explain why, not what.
- Logging: `log.info|warn|error(message, fields)` from `src/log.js` (JSON lines).
  Messages are short sentences in sentence case; details go in fields. Never log
  tokens, secrets or auth codes.

## Persistence

- `src/store.js` owns all SQL. Other modules call store methods, never `db` directly.
- Schema changes are append-only entries in the `MIGRATIONS` array, applied in
  order via `PRAGMA user_version`. Never edit an existing migration; add a new one.
  Production has data, so migrations must work on an existing database.
- Tokens are stored hashed (sha256), never in clear text.

## Tests

- `npm test` must pass on Node 22 and 24 (CI runs both). Tests must not need network
  access: use the recorded spot-hinta responses in `test/fixtures/` and fake
  `fetch`/`StateUpdateRequest` implementations as the existing tests do.
- Use in-memory stores (`openStore({ path: ':memory:', now })`) and injected clocks
  rather than real timers or sleeps.
- Every behaviour change comes with tests. Add to the existing `test/*.test.js` file
  for the module you change.

## Domain rules that are easy to get wrong

- Price = spot-hinta `PriceNoTax` × (1 + VAT). Never use `PriceWithTax` (it includes
  Finnish VAT for every region).
- Look prices up by absolute instant; regions have different UTC offsets and DST days
  have 92 or 100 quarter-hour intervals. `rank` is spot-hinta's per-local-day rank.
- `/st-schema` requests are authenticated by our own access token middleware before
  the `st-schema` SDK sees them; the SDK does no auth.
- SmartThings callback 404/410 answers delete an installation only after
  `GONE_LIMIT` consecutive answers.

## Don't change without the maintainer

- Files under `smartthings/` (capability, presentation, device profile). Changing
  them requires registering a new capability version in SmartThings, which only the
  maintainer can do. If an issue needs it, say so in the PR and stop at the code.
- The capability namespace (`beachprepare14195`), OAuth redirect-host allowlist,
  `ecosystem.config.cjs` and deployment details in docs/setup.md.

## Pull requests

- One issue per PR, focused diff, no unrelated refactoring or reformatting.
- Update README.md or docs/setup.md when user-visible behaviour, configuration
  (`.env.example`) or operations change.
- Describe what changed, how it was tested, and anything the maintainer must do on
  deploy (new env variables, migrations, SmartThings registration).
