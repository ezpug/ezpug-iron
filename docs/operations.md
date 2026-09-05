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
**Redis** (the stream hub's fan-out; a `PING` for `/healthz`). Nothing listens but the
orchestrator: every server and every node dials *it* (`docs/decisions.md` 5, 23), and the
platform speaks only the Match API (`docs/match-api.md`). Inside the process: the
**providers** (`sim` today; `dathost` and `nodes` with T16 and T12), the **match machine**
with its provisioning walk and deadlines, the **reaper**, the **webhook worker** and the
**stream hub** — "The match machine" below.

Ports and every setting are decided in `.env.example` and nowhere else. Every name is
`EZPUG_IRON_*`, because the platform runs on the same box with `EZPUG_*` names of its own:

| Variable | Default | What |
| -------- | ------- | ---- |
| `EZPUG_IRON_BASE_URL` | `http://localhost:3430` | the orchestrator's own public origin — a client's `baseUrl`, what tokens and webhooks are minted against |
| `EZPUG_IRON_PUBLIC_URL` | — | the same value under the name the dev contract below uses; it wins over `EZPUG_IRON_BASE_URL` when both are set |
| `EZPUG_IRON_HOST` / `EZPUG_IRON_PORT` | `127.0.0.1` / `3430` | where the process binds; the container sets `0.0.0.0` and compose publishes |
| `EZPUG_IRON_PROVIDERS` | `sim` | the providers to register, comma-separated (`sim`, `dathost`, `nodes`; T3/T4/T12/T16) |
| `EZPUG_IRON_DATABASE_URL` | — | `postgres://…`; `EZPUG_IRON_TEST_DATABASE_URL` is the Vitest database beside it |
| `EZPUG_IRON_DATABASE_POOL_MAX`, `…_IDLE_TIMEOUT`, `…_CONNECT_TIMEOUT`, `…_STATEMENT_TIMEOUT`, `…_LOG` | `10`, `30`, `10`, `15000`, `false` | pool tuning; the statement timeout is what keeps a runaway query from wedging the pool |
| `EZPUG_IRON_REDIS_URL` | — | `redis://…` |
| `EZPUG_IRON_RATE_LIMIT_BURST` / `…_PER_SECOND` | `120` / `10` | the per-key token bucket (below) |
| `EZPUG_IRON_MIGRATE_ON_BOOT` | `false` | apply pending migrations before the port opens; the image sets it |
| `EZPUG_IRON_MIGRATIONS_DIR` | beside the code | where the migration SQL is, when it is not (`/app/drizzle` in the image) |
| `EZPUG_IRON_BOOTSTRAP_API_KEY` | — | **dev only**: adopt an API key with this exact secret at boot (below); refused under `NODE_ENV=production` |
| `NODE_ENV` | — | `production` refuses every dev-only door; **the image sets it**, so a dev world that pulls the image overrides it with `NODE_ENV=development` |

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

Running the orchestrator *inside* another project's dev world is the next section.

## The image, and running it inside another project's dev world

```sh
pnpm image:build   # ghcr.io/ezpug/ezpug-iron/orchestrator:dev, from docker/orchestrator/Dockerfile
```

`docker/orchestrator/Dockerfile` builds from the repo root: the workspace is installed
once, `@ezpug/orchestrator` and everything it depends on are built, the internal packages
are bundled into `dist/main.mjs`, and `pnpm deploy --prod` resolves the npm packages that
are left. The result runs as **`node` (uid 1000), never root**, exposes **3430**, carries
its `HEALTHCHECK` (`/healthz` through Node's own `fetch` — the image has no curl) and is
labelled with the commit it was built from. `pnpm image:build` gives it the local `:dev`
tag; CI publishes `ghcr.io/ezpug/ezpug-iron/orchestrator:<tag>` (T34), and a tag is
recorded in `docs/pins.md`.

**The dev contract.** Another project's `pnpm dev:up` — the platform's, today — brings this
service up beside its own. What it may rely on, and what this repo will not break without
a release note:

| What | Value |
| ---- | ----- |
| image | `ghcr.io/ezpug/ezpug-iron/orchestrator:<tag>` (`:dev` when built locally) |
| port | `3430` inside the container; publish it where you like |
| `NODE_ENV` | set it to `development` — the image defaults to `production`, and the bootstrap key is refused there |
| `EZPUG_IRON_PROVIDERS` | `sim` — the simulator needs nothing else in the world |
| `EZPUG_IRON_PUBLIC_URL` | the origin *the other project's containers* reach it on (`http://ezpug-iron:3430`), because it is what webhooks, player tokens and a server's link URL are minted against |
| `EZPUG_IRON_BOOTSTRAP_API_KEY` | an API key of this service's grammar — `ezik_` and 43 base64url characters — that the consumer decides |
| `EZPUG_IRON_DATABASE_URL` / `EZPUG_IRON_REDIS_URL` | its own Postgres and Redis; the image migrates on boot |
| `/healthz` | no key, `200` when the rails and the providers answer |

The bootstrap key is the whole reason a compose file can drive this service unattended: a
minted key is shown **once**, and a compose file has nobody to show it to — so the
consumer decides the secret, puts it in its environment and the orchestrator *adopts* it
at boot. It carries `matches`, `fleet` and `admin`, four concurrent servers and a
four-hour lifetime ceiling — and **no webhook secret**, because the consumer's
secret is the consumer's: register one with the `admin` scope it already holds
(`PUT /v1/keys/:keyId/webhook-secrets`) before the first match request names it
in `callbacks.webhookSecretId`. It is idempotent (a restart adopts the same key), and changing
the value **revokes** the previous one, so the environment is always the one truth about
which key the dev world holds. In production the variable fails the boot with its own name
in the message: mint a key instead.

```yaml
# the consumer's compose.yaml, in outline
ezpug-iron:
  image: ghcr.io/ezpug/ezpug-iron/orchestrator:dev
  environment:
    NODE_ENV: development
    EZPUG_IRON_PUBLIC_URL: http://ezpug-iron:3430
    EZPUG_IRON_PROVIDERS: sim
    EZPUG_IRON_BOOTSTRAP_API_KEY: ${EZPUG_IRON_BOOTSTRAP_API_KEY}
    EZPUG_IRON_DATABASE_URL: postgres://…
    EZPUG_IRON_REDIS_URL: redis://…
  ports: ['127.0.0.1:3430:3430']
```

A key of the right shape is one line: `printf 'ezik_%s\n' "$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=')"`.

## Health

`GET /healthz` needs no key. It answers `200 { ok: true, service: "orchestrator", checks }`
when every rail answers, `503` otherwise, and `503 { state: "draining" }` from the first
moment of a shutdown. `checks` has one entry per rail — `database`, `redis`, and
`providers` by id — each `{ ok, latencyMs, error? }`; a rail that does not answer within
two seconds is `ok: false` with `no answer within 2000ms`. Compose's healthcheck, the
deploy smoke and `pnpm dev:status` all read this one route.

## How it starts and stops

Boot: read the environment → open the pool and the Redis client → register the providers
`EZPUG_IRON_PROVIDERS` names → build the machine, the hub, the worker and the reaper over
them → build the app over the route table → create the server and attach the upgrade
router (the stream, the server link; the node link joins in T12) → arm the drain → ping both rails → **start**
(the hub joins the Redis fan-out, every open match re-arms its deadlines from its row, the
worker and the reaper arm their sweeps) → listen. The port opens **last**, so a probe
during a slow boot gets a refused connection (a starting process) and never a
half-composed API.

Shutdown is an **order**, not a set of `close()` calls (`apps/orchestrator/src/shutdown-steps.ts`):

1. `health` — `/healthz` turns 503, so whatever is in front stops sending work here.
2. `listener` — the port closes; idle keep-alive sockets are hung up; in-flight requests keep running.
3. `links` — every server link is closed `4012`; the plugins reconnect by themselves with backoff (the node links join here in T12).
4. `streams` — every stream socket is closed `1001`; a subscriber replays from the events route when it returns.
5. `requests` — in-flight requests get five seconds to answer, then every socket is destroyed.
6. `reaper`, `webhooks`, `matches`, `hub` — the sweeps disarm, attempts in flight finish, every
   match's deadlines disarm and its chain drains, then the hub leaves the fan-out. A match
   mid-flight is *not* ended: its row says where it was, and the next boot re-arms it.
7. `redis`, then 8. `database` — last, because everything above may still have been writing.

The whole drain is bounded to eight seconds on the clock (compose waits ten and then
SIGKILLs). A step that throws is logged and the drain continues; a second SIGTERM exits at
once. `SIGINT` does the same, so `Ctrl-C` on `pnpm dev` is a real drain.

## The match machine

A match is a row in `matches` and a **chain** in memory: everything about one match — a
server's event, a command, a cancel, a deadline firing — runs on that match's chain one
step at a time, in the order it was asked, so the durable log's order never depends on
which socket answered first or how the clock was advanced. The states are the Match API's
(`pending → allocating → configuring → ready → live → ended | failed | cancelled`,
`recovering` from `live`); the durable log (`match_events`) is written by `emit`, which
also publishes the `event` frame to the stream hub and writes the `webhook_deliveries`
row the worker picks up.

**The door** (`POST /v1/matches`) refuses, in this order: a replay or a `conflict` on
`clientMatchId`; `validation_failed` for a `webhookSecretId` not registered on the key or
an unknown `sim.scenario`; `unknown_gamemode`; `no_capable_server` when no provider can
host the request (every `csgo` request this round, `lan` with no node, a named
`provider` or `region` nobody offers, every provider drained or full) and
`provider_unavailable` when every asked provider failed to answer; `game_unsupported`;
`map_not_allowed`; `budget_exceeded` when the key is at its concurrent-server ceiling,
asks for a `ttlMinutes` above its lifetime ceiling, or the match's projected cost would
cross its month (see *Budgets* below). Then the row is written `pending` and the walk is
kicked.

**The walk** (`provision`): selection filters every eligible provider's offerings on
`game`, `region`, `lan` and `workshopMaps`, then orders them — a node first when the
request asks for `lan`, cheapest first otherwise. The `sim` provider is eligible only
when asked for (`requirements.simulated` or `provider: sim`) or when no other provider
is registered, which is what makes the dev world work and production never simulate by
accident. For each candidate: a ledger row (`servers`, state `allocated`, `server_id`
null) **before** `allocate`; on success the row and the match are filled in and
`match.allocated` is said; then a join password and a server token are minted, the token's
hash stored, `configure` and `start` are called; any failure closes the row `failed`,
deallocates what the candidate left behind and moves to the next one. An exhausted list
fails the match `allocation_failed` with `no_capable_server` in the detail.

**Deadlines**, every one on the injected clock, armed from `state_changed_at` so a
restart re-arms each at the same absolute instant (`DEFAULT_MATCH_DEADLINES`):

| Deadline | From | Default | On expiry |
| -------- | ---- | ------- | --------- |
| allocate | `allocating` | 2 min | `failed: allocation_failed` |
| boot | `configuring` until `server_ready` | 5 min | `failed: provider_error` |
| join | `ready` until `going_live` | 20 min | `ended: ttl_expired` |
| recovery | `recovering` | 5 min | `failed: server_lost` |
| ttl | the request's `ttlMinutes` | — | `ended: ttl_expired` |
| the loss detector | no event from the server for three heartbeat intervals | 30 s | the provider is probed; `gone` or `stopped` opens `recovering` from `live`, fails `provider_error` before it |

**Recovery** this round: a lost server's match says `match.recovering` with the newest
backup's round (`backups`, written by the link — see *The link*) and waits the window; with no
backup it fails `server_lost` at once. Resuming onto the next candidate with the backup
is T14's, and so is the sim's crash door — which is why the conformance flows
`crash-restore` and `crash-lost` are *skipped*, not failed, against the orchestrator today.

**Commands** are idempotent on `correlationId` across a restart (`match_commands`):
`force_end`, `restore` (`no_backup` this round), `profile` and the state checks are the
machine's; everything else is relayed down the server's channel (`link/channels.ts`: the
sim's in-process channel, or the `/link` socket a real plugin holds) and answered with what
the server said. `rcon` needs `admin`. The **`sim.*` family** reaches a simulated server and
nothing else: on any other provider it is `command_unsupported` with the provider named,
before a channel is ever asked.

**The `sim` provider** (`providers/sim/`, decision 9) is the engine of `packages/sim`
behind the provider interface: a handle, an address nobody can connect to
(`sim-1.sim.invalid`), a GOTV relay that does not exist, and — once started — the server
side of the link, whose events reach the machine through the same sink a real plugin's
do. Its knobs are Match API commands, answered with the simulator's state after each:

| Command | What it does |
| ------- | ------------ |
| `sim.step` | deal the next story beat; `invalid_state` unless the match is in `step` mode. The answer names the beat it dealt (`stepped`), or `null` when the story is dry |
| `sim.mode` | `auto` plays the story on the clock, `step` arms no timers at all |
| `sim.speed` | 1 is real time, 60 is a minute of match per second (0.25–600) |
| `sim.chaos` | delay and duplicate *this* server's deliveries; `null` makes it honest again |
| `sim.kill` | pull the plug. Status answers `gone`, heartbeats stop, and the machine's loss detector opens the recovery window on its own — nothing announces it, exactly like a box that lost power |

A request's own `sim` block (`scenario`, `seed`, `mode`, `timeScale`, `chaos`) decides
where a match starts. The story is seeded **per match** (`sim#<matchId>` unless the
request names a seed), not per server, so a replacement server for a match that lost its
box tells the same story the dead one did — which is what makes the provider's `restore`
verb (load a round backup, boot, play on from it) mean anything. Registered when
`EZPUG_IRON_PROVIDERS` names `sim`, which is the dev default; selection never picks it
unasked while another provider is registered.

**The reaper** runs every minute: open rows past `expires_at` end their match
`ttl_expired` (or are deallocated outright when no match holds them); every provider's
`list()` is held against the open rows — an unaccounted-for server is deallocated after a
two-minute grace and `fleet.orphan_found` is said to the match it was obtained for, and an
open row the provider no longer lists is *surfaced* to the machine, which probes and
opens the recovery window itself. A provider that cannot answer is reported and retried
next pass; nothing is reaped on a failed listing.

**The webhook worker** POSTs every `webhook_deliveries` row that is due: signed with the
secret the request named (`X-EZPug-Signature`), `X-EZPug-Delivery`, `X-EZPug-Attempt`; any
`2xx` within ten seconds is `delivered`; anything else is retried on the published
schedule (`WEBHOOK_RETRY_DELAYS_MS`, ten attempts in all, then `given_up`); a `410` marks
the delivery `stopped`, sets `matches.webhooks_stopped_at` and no later envelope of that
match is even queued — the events route still has every fact. A row is attempted the
moment it is written (`kick`) and by a sweep every five seconds that picks up what a
restart or a retry left due; one match's deliveries go out in `seq` order, different
matches side by side.

**The stream hub** is one per process; every frame crosses the Redis fan-out
(`ezpug-iron:stream`) on its way to subscribers, so two replicas would both stream every
match — nothing runs two this round, the seam is where it would go. `event` frames
mirror the durable log, `presence` is re-sent whole on every join and leave,
`command_result` follows every command, `tick` batches position ticks per clock tick and
never stores them. The upgrade (`GET /v1/matches/:id/stream`) is matched on the raw
server before Hono: an API key with `matches` owning the match, or a player token in
`?token=` (T24 mints them; the check against `player_tokens` and the request's
`streamAllowedOrigins` is here). The first frame is `hello`; a match that is over gets
`4000` right after it; a subscriber a megabyte behind is closed `4008`.

**What is running** is `GET /v1/fleet/servers` (open rows), **what did tonight cost** is
`GET /v1/fleet/ledger` with `cost.accruedCents` (hourly cents × the row's open time), and
`POST /v1/fleet/servers/:id/release` (by row id or by the provider's handle) deallocates
now and fails the match `provider_error` — the row itself is `released`, because a person
did it. `GET /v1/capacity` asks every provider's offerings; `POST
/v1/fleet/providers/:id/drain` keeps what it runs and allocates nothing more.

## The link

Every server's plugin opens **one outbound WebSocket** to the orchestrator at `/link`
(decision 5) and everything crosses it: the assignment down, events and heartbeats up,
commands down and their results up, backups up, profiles and player commands down. A
Dathost server, a node-hosted server and the dev container are indistinguishable once
connected; providers only differ in how a server gets started and stopped. The frames are
`@ezpug/protocol`'s (`packages/protocol/README.md`), the C# twins are generated from them,
and the upgrade is matched on the raw server before Hono, attached before the port opens.

**Hello, welcome, assign.** The first frame is `hello` with the server token the provider
planted (`ezpug.json` on Dathost, the container env on a node — minted by the walk, hashed
in `server_tokens`). The token's ledger row must be open; what `hello` reports (plugin,
SDK and CounterStrikeSharp versions, the plugin folders in the image, hostname, map,
state) lands on the row (`versions`, `hostname`, `current_map`, `link_state`) and the
token's `last_used_at` is written. The answer is `welcome` (the provider and server id
the plugin stamps into every event's `source`, the heartbeat interval, and `ackedSeq`);
then, unless the `hello` says the server already holds the row's match, `assign` — the
request, the manifest and every profile pushed since, composed once in
`link/assign.ts`: the manifest minus its map list and widget, the plugins to enable (the
manifest's, plus `WeaponPaints` when a roster entry carries a loadout and the image has
the plugin), the cfg files, the cvars merged flat (a request's `rules.cvars` under the
mode's under what the rules derive: `mp_maxrounds`, the overtime cvars), the map plan,
the rules, the roster, the warmup lines, the branding and the demo upload URL.
`matchzyConfig` arrives with T9, `restore` with T14. A manifest naming a plugin the image
lacks fails the match `provider_error` before anything is sent.

**Refusals are close codes** (`LINK_CLOSE_CODES`): `4001` for an unknown, revoked or
foreign token or a row that is closed; `4002` for a protocol version this build does not
speak; `4003` for a frame that does not parse or a first frame that is not `hello`;
`4005` when a newer socket presented the same token (the older one is told); `4008` for
no `hello` within ten seconds; `4012` when the orchestrator shuts down (every session,
between the listener and the streams in the drain order — the plugins reconnect with
backoff). A draining orchestrator answers the upgrade itself with a 503.

**Events are acked one by one.** Each carries the plugin's own per-server `seq`; the link
keeps the highest *contiguous* acknowledged seq per session and persists it on the row
(`link_acked_seq`) after every batch, so `welcome.ackedSeq` survives a restart on either
side. A seq at or below it, or already taken above it, is `duplicate`; the rest go to the
machine **in order** and its answer is the ack — `accepted`, `ephemeral` for a position
tick, `rejected` (with a reason) for an event naming a match this server does not hold or
one the machine will not take. A plugin whose counter is behind ours started afresh, and
ours follows its `lastSeq` rather than calling every event it sends a duplicate.

**Commands are relayed by `correlationId` with a deadline** (fifteen seconds on the
clock); a server that does not answer is `provider_unavailable` to the client. The
answers — `command_result`, a `console` tail, a `player_command_result` — are resolved
the moment they arrive, off the session's inbound chain, because the machine sends a
command while holding the match's chain and a real plugin reports the event (a pause)
before it answers the command that caused it. The `sim.*` family never reaches a real
server. `release` is sent when the match ends, before the provider stops the server, so
the plugin unloads its mode and says `state: idle` while it still can.

**Silence is a probe.** Every frame re-arms a timer at two heartbeat intervals; past that
the match's server is *suspected* (the provider is probed — `gone` opens the recovery
window from `live`, fails the match before it) and the socket is terminated so the plugin
reconnects. `last_seen_at` is written at most every five seconds. `backup` frames are
persisted (`backups`, the newest eight per match, the same round replaced); a `console`
tail — asked for by the fleet console route (T20) or sent unsolicited on a failure — is
cached on the session.

**The fake server** (`@ezpug/protocol/fake-server`) is what every link test connects: it
sequences, buffers and resends like the C# client must, and the exchanges it had with
the real `/link` are recorded under `packages/protocol/fixtures/link/` — the files the C#
side round-trips. `link/server-link.test.ts` runs the whole thing over a real socket on a
fake clock; `EZPUG_IRON_RECORD=1` rewrites the goldens.

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
the rest; `DELETE /v1/keys/:id` revokes; `POST /v1/keys/:id/rotate` draws a new secret
and kills the old one on the spot (same key, same id, same budget — what you do when a
secret leaked, instead of minting a second key and leaving the first alive);
`PATCH /v1/keys/:id/budget` moves a ceiling; `PUT /v1/keys/:id/webhook-secrets` rotates
the secrets a key's match requests sign with. `EZPUG_IRON_BOOTSTRAP_API_KEY` is the dev
world's known key (see the image section).

## Budgets: the wall in front of the money

Every key carries three ceilings (decision 7) and the orchestrator enforces them against
the **ledger**, never against what the caller says:

| Ceiling | What it counts | Refused when |
| ------- | -------------- | ------------ |
| `maxConcurrentServers` | open ledger rows this key is paying for right now | one more would cross it |
| `maxServerLifetimeMinutes` | the request's own `ttlMinutes` | the request asks for longer |
| `monthlyCents` | this UTC month's spend: each row's `cost_hourly_cents` × its open time, **live rows accruing to now** | the new match's projected cost would cross it |

The refusal is `402 budget_exceeded` with `details.limit` naming which ceiling, and it is
final — a client must not retry it. It happens at the door, before a ledger row exists,
so a refused request costs nothing and leaves nothing.

**`monthlyCents: 0` means no money, not "no ceiling".** A key with a zero ceiling can use
free providers (the sim, a node) forever and is refused the first paid allocation. That
is the safe default and it is why the dev bootstrap key carries it: a dev world pointed
at Dathost by accident stops at the first request instead of at the invoice.

**The month** is the UTC calendar month. `GET /v1/fleet/budget` answers the calling key's
`{ limits, usage: { concurrentServers, monthCents, monthStartedAt } }` — the query a
health tile draws; `GET /v1/fleet/ledger?since=` is the same money row by row.

**Warnings.** When a key crosses 80 % or 95 % of a ceiling that has a ratio (the
concurrent and monthly ones), `fleet.budget_threshold` is appended to each of that key's
open matches — so it reaches the client on the webhook it already listens to. A crossing
is announced **once per ceiling, fraction and month**: the mark is a row in
`api_key_budget_notices`, not a set in this process, so a deploy does not re-announce.
Moving a ceiling clears that key's marks, because a new number is a new crossing. The
check runs when a ledger row opens and on a sweep every minute, which is how accrual on
a live server crosses a line without anybody asking.

Raising a ceiling in the middle of a Saturday:

```sh
curl -sS -X PATCH https://gs.ezpug.com/v1/keys/$KEY_ID/budget \
  -H "authorization: Bearer $ADMIN_KEY" -H 'content-type: application/json' \
  -d '{"monthlyCents": 50000}'
```

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
| `api_key_budget_notices` | which `fleet.budget_threshold` was already said, per key, ceiling, fraction and month — so a restart never repeats a crossing | budgets (T5) |
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

`pnpm verify` needs no database: the machine, the walk, the reaper, the webhook worker
and the stream are proven over the in-memory match store on a fake clock
(`match/machine.test.ts`), and the **conformance suite runs in process** against the whole
composition over memory (`conformance.test.ts`). The orchestrator's database suites — the
key store, the match store contract that both implementations pass, the standing
orchestrator over a real socket, and **the conformance suite against the real service**
(`conformance.extended.test.ts`: system clock, Postgres, Redis, a real port, the stream over
a real `ws` upgrade, every webhook POSTed to a real endpoint that verifies it) — skip with a
printed reason (and the command that fixes it) when the dev world is down. They run against
`EZPUG_IRON_TEST_DATABASE_URL`, a second database on the same server, each test inside a
transaction that is always rolled back; the suites that must commit stamp their rows and
delete them. `pnpm verify:extended` runs `pnpm dev:up` first and sets
`EZPUG_IRON_DATABASE_TESTS=required`, so a missing world is red there, and the conformance
run against the real service is the round's first extended-tier gate.
