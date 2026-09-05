# Operations

The operator's reference for the orchestrator: what runs, what it reads, what it stores,
how it starts and stops. Written for someone standing at a terminal on the box at eleven
on a Saturday. Deploying (`scripts/deploy.sh`), budgets, the Dathost template, the GSLT
pool and the "a provider died" runbook arrive with the tasks that build them (PRD-02
T5, T18, T19, T31, T35); this file grows a section per task, and T38 adds the test that
checks every route, command and version it names.

## The pieces

One process, `apps/orchestrator` (Hono on Node 22), over its own **Postgres** (the
ledger, the keys, the durable log — every table in "The schema" below) and its own
**Redis** (the stream hub's fan-out from T3; a `PING` for `/healthz` today). Nothing
listens but the orchestrator: every server and every node dials *it*
(`docs/decisions.md` 5, 23), and the platform speaks only the Match API
(`docs/match-api.md`).

Ports and every setting are decided in `.env.example` and nowhere else. Every name is
`EZPUG_IRON_*`, because the platform runs on the same box with `EZPUG_*` names of its own:

| Variable | Default | What |
| -------- | ------- | ---- |
| `EZPUG_IRON_BASE_URL` | `http://localhost:3430` | the orchestrator's own public origin — a client's `baseUrl`, what tokens and webhooks are minted against |
| `EZPUG_IRON_HOST` / `EZPUG_IRON_PORT` | `127.0.0.1` / `3430` | where the process binds; the container sets `0.0.0.0` and compose publishes |
| `EZPUG_IRON_PROVIDERS` | `sim` | the providers to register, comma-separated (`sim`, `dathost`, `nodes`; T3/T4/T12/T16) |
| `EZPUG_IRON_DATABASE_URL` | — | `postgres://…`; `EZPUG_IRON_TEST_DATABASE_URL` is the Vitest database beside it |
| `EZPUG_IRON_DATABASE_POOL_MAX`, `…_IDLE_TIMEOUT`, `…_CONNECT_TIMEOUT`, `…_STATEMENT_TIMEOUT`, `…_LOG` | `10`, `30`, `10`, `15000`, `false` | pool tuning; the statement timeout is what keeps a runaway query from wedging the pool |
| `EZPUG_IRON_REDIS_URL` | — | `redis://…` |
| `EZPUG_IRON_RATE_LIMIT_BURST` / `…_PER_SECOND` | `120` / `10` | the per-key token bucket (below) |
| `NODE_ENV` | — | `production` refuses every dev-only door |

A missing or malformed variable fails the boot with its name in the message; the process
pings Postgres and Redis once before it listens, so a wrong URL is a boot failure, never a
first-request surprise. Connection strings are printed with the password masked.

## The dev world

```sh
pnpm dev:up      # Postgres and Redis from compose.yaml, waited healthy, both databases migrated
pnpm dev         # the orchestrator on the host, tsx watch, restarting on change
pnpm dev:status  # `docker compose ps`, a real query per service, and whether /healthz answers
pnpm dev:logs    # follow the stack
pnpm dev:down    # stop, keep the volumes
pnpm dev:reset   # drop the volumes and boot clean — asks first; a volume is a human's to destroy
```

`dev:up` copies `.env.example` to `.env` on a fresh clone and warns when
`EZPUG_IRON_DATABASE_URL` disagrees with the `EZPUG_IRON_POSTGRES_*` parts the container
reads. The compose project is `ezpug-iron-dev`, its containers `ezpug-iron-postgres` and
`ezpug-iron-redis`, published on loopback only, on the ports `.env.example` decides (5443,
6383 — the platform's world holds 5442 and 6382 on the same box).

Running the orchestrator *inside* another project's dev world (the platform's compose
pulling this repo's image) is T4's section.

## Health

`GET /healthz` needs no key. It answers `200 { ok: true, service: "orchestrator", checks }`
when every rail answers, `503` otherwise, and `503 { state: "draining" }` from the first
moment of a shutdown. `checks` has one entry per rail — `database`, `redis`, and
`providers` by id — each `{ ok, latencyMs, error? }`; a rail that does not answer within
two seconds is `ok: false` with `no answer within 2000ms`. Compose's healthcheck, the
deploy smoke and `pnpm dev:status` all read this one route.

## How it starts and stops

Boot: read the environment → open the pool and the Redis client → build the app over the
route table → create the server the links attach to → arm the drain → ping both rails →
listen. The port opens **last**, so a probe during a slow boot gets a refused connection
(a starting process) and never a half-composed API.

Shutdown is an **order**, not a set of `close()` calls (`apps/orchestrator/src/shutdown-steps.ts`):

1. `health` — `/healthz` turns 503, so whatever is in front stops sending work here.
2. `listener` — the port closes; idle keep-alive sockets are hung up; in-flight requests keep running.
3. *(T6, T12)* the server links and node links are closed; their peers reconnect by themselves.
4. `requests` — in-flight requests get five seconds to answer, then every socket is destroyed.
5. *(T3)* the reaper, the webhook worker and the match machines drain, before the hub they publish into.
6. `redis`, then 7. `database` — last, because everything above may still have been writing.

The whole drain is bounded to eight seconds on the clock (compose waits ten and then
SIGKILLs). A step that throws is logged and the drain continues; a second SIGTERM exits at
once. `SIGINT` does the same, so `Ctrl-C` on `pnpm dev` is a real drain.

## Keys, scopes, rate limits, logs

An **API key** is `ezik_` and 43 characters, shown once at mint; only its SHA-256 is
stored, and a request is authenticated by looking that hash up. Every route declares the
scope it needs (`matches`, `fleet`, `admin` — `admin` implies the other two) in the
Match API's own route table, and the orchestrator decides from that declaration; there
is no second permission mechanism. A revoked key is `unauthorized` from the moment of
the revoke. `lastUsedAt` is written at most once a minute per key — a liveness signal
for the list, not an access log.

The first key on a fresh database comes from the box:

```sh
pnpm --filter @ezpug/orchestrator keys:mint -- --name root --scopes admin
pnpm --filter @ezpug/orchestrator keys:mint -- --name platform --scopes matches,fleet \
  --max-concurrent 4 --max-lifetime-minutes 240 --monthly-cents 0
```

The secret is the one line on stdout. From there `POST /v1/keys` (an `admin` key) mints
the rest; `DELETE /v1/keys/:id` revokes; `PUT /v1/keys/:id/webhook-secrets` rotates the
secrets a key's match requests sign with. T4 adds `EZPUG_IRON_BOOTSTRAP_API_KEY` for a
dev world that boots with a known key; T5 adds rotation and budget enforcement.

**Rate limits** are a token bucket per key — `EZPUG_IRON_RATE_LIMIT_BURST` deep,
refilled at `EZPUG_IRON_RATE_LIMIT_PER_SECOND` — answering `429 rate_limited` with a
`Retry-After`. The bucket is keyed by the *presented* key's hash before any lookup, and
requests with no key share one bucket, so a stranger hammering the door is refused from
memory. Per process, in memory: the ceiling stops a runaway client, it does not meter one.

**The request log** is one line per request: method, path *without the query string*
(the stream route carries a player token there), status, duration, the key's public
prefix (`key=ezik_abc…`, twelve characters, never more), and a request id. The id is
echoed as `x-request-id` — yours when you sent a plausible one, minted otherwise — and
travels in every error envelope's `details.requestId`, so a client's log and this one
name the same request. Every line goes through a redactor that turns any token of ours
into its prefix and an ellipsis; nothing should put one there, and if something does,
the log still holds nothing usable.

## The schema

Designed once for the round (PRD-02 T2); later tasks add tables only where this list
names none, and every change is an additive migration. Postgres, Drizzle, snake_case;
ids come from the application (no `gen_random_uuid()`), timestamps are `timestamptz`
from the injected clock.

| Table | What | Written by |
| ----- | ---- | ---------- |
| `api_keys` | a key: name, public prefix, secret hash, scopes, the three budget ceilings, the per-key fleet webhook (T31), created / last used / revoked | keys (T2), budgets (T5) |
| `api_key_webhook_secrets` | the HMAC secrets a key registered, by id, **in clear** — they sign | keys |
| `matches` | the Match API resource as a row, plus the request whole, its hash (the `clientMatchId` conflict check), when the state was entered (deadlines re-arm from it), and `webhooks_stopped_at` (a `410`) | the match machine (T3) |
| `match_events` | the per-match durable log: `(match, seq)` unique, the payload, the `delivery_id`; what the events route replays and the webhooks carry | the machine, the link (T6) |
| `webhook_deliveries` | one row per envelope: attempts, next try on the clock, status | the webhook worker (T3) |
| `match_commands` | commands by `correlationId`, with their result — a retry answers the first result across a restart | commands (T3) |
| `servers` | **the ledger**: one row per server ever asked for — provider, handle, node, match, key, state, address (never a password), hourly cost, the GSLT lease, the link's facts (`last_seen_at`, versions, acked seq), the RCON audit (T20), allocated / released / expires | the provisioning walk and the reaper (T3), the link (T6) |
| `server_tokens` | the per-server link credential, hashed; one live token per row | providers (T3, T12, T16) |
| `nodes` | every `ezpug-node` enrolled: region, labels, capacity, connection facts, the node token's hash | the node link (T11, T12) |
| `node_enrolments` | the one-time enrolment tokens, hashed, spent on first hello | enrolment (T12) |
| `gslt_tokens` | the Steam game server accounts this deployment minted, the login token **in clear**, the lease | the GSLT pool (T17) |
| `backups` | round backups, small text, the latest few per match | the link (T6), recovery (T14) |
| `player_tokens` | a widget's key to one match and one SteamID64, hashed, with its expiry | player tokens (T24) |

### What this database holds in clear, and why

Everything the orchestrator *verifies* is hashed: API keys, server tokens, node tokens,
enrolment tokens, player tokens. Two things it has to *present* cannot be: the webhook
secrets it signs deliveries with, and the GSLT login tokens it hands a provider. Both
live in this database in clear. What that means for the box: the production Postgres is
on a named volume, published to nobody (T35's compose gives it no host port), and a dump
of it is a dump of those two secrets — treat a backup like a credential. A client that
wants to limit the blast radius registers a webhook secret per environment and rotates
it (`PUT /v1/keys/:id/webhook-secrets`; the signature carries `kid`, so a rotation has
no gap). Encrypting these two columns at rest with a key from the environment is a
possible hardening this round did not need.

A join password is on the match (`matches.connect`) because the client is handed it by
contract. An RCON password is *not* stored: the provider knows it (Dathost answers it,
a node holds it) and the process asks at the moment it needs one (T20).

## Migrations

Drizzle generates them, this repo applies them, and `main` stays deployable throughout:

```sh
# 1. edit apps/orchestrator/src/db/schema/*.ts
pnpm --filter @ezpug/orchestrator db:generate --name <what-changed>
#    → apps/orchestrator/drizzle/NNNN_<what-changed>.sql and its snapshot
# 2. read the generated SQL. It is a code artifact; review it like one.
pnpm db:migrate                                        # apply to EZPUG_IRON_DATABASE_URL
pnpm --filter @ezpug/orchestrator db:migrate --target=test   # …or to the test database (dev:up does both)
```

- `runMigrations()` holds a Postgres advisory lock, so two deploys (or two Vitest
  workers) cannot apply a file twice, and is idempotent — re-running is a no-op. A
  failed migration rolls back whole.
- Migration files are **immutable once committed**. Fixing a mistake is a new migration,
  because someone's database already ran the old one. Never `drizzle-kit push`.
- **Additive-safe, guarded.** A migration runs while the previous release is still
  serving, so it may not remove or reshape anything that release reads. A test
  (`apps/orchestrator/src/db/additive-safe.test.ts`, in `pnpm verify`) refuses `DROP
  TABLE`, `DROP COLUMN`, `DROP SCHEMA`, `DROP TYPE`, any `RENAME`, `ALTER COLUMN … TYPE`,
  `SET NOT NULL` and `TRUNCATE` in any committed file. Do it in three releases instead —
  **expand → migrate → contract** — and acknowledge the contract phase on the line above
  the statement, which covers that one statement and nothing else:

  ```sql
  -- ezpug:contract-phase hostname unread since the 2026-10 release
  ALTER TABLE "servers" DROP COLUMN "hostname";
  ```

## Tests and the tiers

`pnpm verify` needs no database: the orchestrator's database suites skip with a printed
reason (and the command that fixes it) when the dev world is down. They run against
`EZPUG_IRON_TEST_DATABASE_URL`, a second database on the same server, each test inside a
transaction that is always rolled back; the one suite that must commit (the standing
orchestrator over a real socket) stamps its rows and deletes them. `pnpm verify:extended`
runs `pnpm dev:up` first and sets `EZPUG_IRON_DATABASE_TESTS=required`, so a missing world
is red there.
