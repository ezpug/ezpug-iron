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
**stream hub** — "The match machine" below. Beside it, `apps/node` is **`ezpug-node`**, the
agent a venue box runs to become capacity: it enrols once, dials the orchestrator on the
node link and starts server containers from the CS2 image on request — `docs/nodes.md` is
its runbook, and the orchestrator's `nodes` provider that drives it is T12's.

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

Running the orchestrator *inside* another project's dev world is the next section; the
dev CS2 server is its own opt-in lane (`pnpm cs2:*`, "The CS2 server image" below) and
not part of `dev:up` — every clone needs Postgres and Redis, only the boxes that run
matches need 67 GB of game.

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

## The CS2 server image

The other image this repo builds (`ghcr.io/ezpug/ezpug-iron/cs2`,
`docker/cs2/Dockerfile`): one Counter-Strike 2 dedicated server with everything EZPug needs
baked in. It is what `pnpm cs2:up` runs on this box, what `ezpug-node` starts on a venue
box (T11/T12), and where the Dathost template script takes its plugin set from (T18) — one
build, three destinations, because a server that runs a different plugin set than the one
that was tested is not a tested server.

```sh
pnpm cs2:build     # build it (the plugins are compiled inside the build)
pnpm cs2:install   # install/update app 730 into the cs2-data volume — ~67 GB, once
pnpm cs2:up        # run it on this box, host network, ports 27415 + 27420
pnpm cs2:status    # image built? game installed? container running, and what it said
pnpm cs2:logs      # follow it
pnpm cs2:console   # attach to the server console — detach with Ctrl-P Ctrl-Q
pnpm cs2:down      # stop it; the game install stays in the volume
```

**What is in the image, and what is not.** In: Metamod, CounterStrikeSharp (the release
that ships its own .NET runtime — the steamrt base has none), MatchZy, `EZPug.Sdk` and
`EZPug.Core`, and the `gamemodes/*/cfg` set. Every one of them is a pinned version with a
SHA-256 beside it in the Dockerfile and a row in `docs/pins.md`, and `pnpm lint` refuses a
disagreement between the two — including the one pin that lives twice, the
CounterStrikeSharp version the plugins compile against and the release that loads them.
cs2-retakes with its allocator (T23) and the WeaponPaints fork (T28) are the two slots
still empty; the core plugin's loader warns and skips a plugin that is not there, and the
orchestrator refuses an assignment naming one before it is ever sent.

Not in: **the game**. App 730 is ~67 GB installed from a ~71 GB download — measured on this
box in T10, not a guess — so it lives in the `cs2-data` docker volume and is installed once
by `docker/cs2/install-game.sh`, which is a separate entrypoint on purpose: a server that
installs its own game at boot is a server that downloads 67 GB on a Saturday because a
volume was pruned. The entrypoint refuses to start and names the command instead. Nothing
else in this repo downloads anything at runtime (decision 16).

Two things the first real boot taught, both now handled by the image and worth knowing
when one of them resurfaces:

- **`steamclient.so`.** A dedicated server dlopens it from `~/.steam/sdk64` and, without
  it, exits **0** moments after its plugins load — a clean shutdown to every eye, and a
  silent boot loop under a restart policy. steamcmd only writes it on its first run, so
  the image does that run at build time (as the `steam` user; as root steamcmd dies with
  "Failed to load steamconsole.so").
- **The RCON password is never on the command line.** The engine strips `+rcon_password`
  from the line it prints, but CounterStrikeSharp echoes the raw command line at boot, so
  it would land in `docker logs` in clear. It is written to a `0600 cfg/ezpug/rcon.cfg`
  and `+exec`'d instead, which also keeps it out of `/proc/*/cmdline`.

**Every boot** (`docker/cs2/entrypoint.sh`): the image's `addons/` is copied over the
volume's, the Metamod line is put back into `gameinfo.gi` if a game update removed it, the
cfg set is copied into `game/csgo/cfg/` (each gamemode's `cfg/` by name — a bind mount of
the checkout's `gamemodes/` wins, so editing a cfg here is a restart and not a rebuild),
Steam's client libraries are put where the server looks for them, and `cs2` is `exec`'d so
it is PID 1: signals reach the game and `docker attach` is a real console.

**Where home is.** The container passes `EZPUG_IRON_URL` and `EZPUG_SERVER_TOKEN` through
to the plugin, which also accepts `game/csgo/ezpug.json` (what the Dathost provider uploads,
T16). With neither, the plugin loads **unlinked**: it works, every event is dropped, and
both the boot log and `ezpug_status` say so. The boot log names the orchestrator's host and
never the token; `-usercon` gets a password that is minted per boot and not logged unless
`EZPUG_IRON_CS2_RCON_PASSWORD` chose one.

**No GSLT.** A Steam Game Server Login Token is leased per running server and the pool
exists for Dathost (T17); without one CS2 accepts LAN connections, which is all this box and
a venue node ever need. Bots are allowed — `bot_quota` is a cfg and a request's cvar, not an
image decision.

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
router (the stream, the server link, the node link) → arm the drain → ping both rails → **start**
(the hub joins the Redis fan-out, every open match re-arms its deadlines from its row, the
worker and the reaper arm their sweeps) → listen. The port opens **last**, so a probe
during a slow boot gets a refused connection (a starting process) and never a
half-composed API.

Shutdown is an **order**, not a set of `close()` calls (`apps/orchestrator/src/shutdown-steps.ts`):

1. `health` — `/healthz` turns 503, so whatever is in front stops sending work here.
2. `listener` — the port closes; idle keep-alive sockets are hung up; in-flight requests keep running.
3. `links` — every server link is closed `4012`; the plugins reconnect by themselves with backoff.
4. `node-links` — then every node link, so a container's last `state` frame still lands on a
   link this process is listening to. The agents reconnect with backoff too, and the
   containers they run never stop.
5. `streams` — every stream socket is closed `1001`; a subscriber replays from the events route when it returns.
6. `requests` — in-flight requests get five seconds to answer, then every socket is destroyed.
7. `reaper`, `webhooks`, `matches`, `hub` — the sweeps disarm, attempts in flight finish, every
   match's deadlines disarm and its chain drains, then the hub leaves the fan-out. A match
   mid-flight is *not* ended: its row says where it was, and the next boot re-arms it.
8. `redis`, then 9. `database` — last, because everything above may still have been writing.

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
| recovery | `recovering` until the replacement's `server_ready` | 5 min | `failed: server_lost` |
| join, again | the replacement's `server_ready` until `going_live` | 20 min | `failed: server_lost` |
| ttl | the request's `ttlMinutes` | — | `ended: ttl_expired` |
| the loss detector | no event from the server for three heartbeat intervals | 30 s | the provider is probed; `gone` or `stopped` opens `recovering` from `live`, fails `provider_error` before it, and fails `server_lost` when it is the replacement that died |

**Recovery** (T14) is the walk a second time. A live match whose server the probe finds
`gone` says `match.recovering` with the newest backup's round (`backups`, written by
`matches.backup` from a plugin's `backup` frame — see *The link* — or from the sim after
its `backup_written`), closes the dead row `failed` (stopped and deallocated on the spot;
the reaper backs that up), clears presence, and, when there is a backup, queues the
replacement walk behind the step that noticed: the same candidates and rules as a fresh
match, a new ledger row and `match.allocated`, and the backup handed over — through the
provider's `restore` verb where that is its way (the sim loads the story point), and in
`assign.restore` down the link for every server whose plugin does the loading (a node
today, Dathost when T16 exists). The match stays `recovering` throughout: the recovery
window is the deadline for the replacement's `server_ready`, which re-announces the
connect facts as `match.server_ready` with `restored: true` and the round, and re-arms
the join deadline; the replacement's `going_live` says `match.recovered`
(`resumedFromRound`) and the match is `live` again, on its second server. No backup, an
exhausted candidate list, the window or the join deadline running out, or the
replacement dying too: `failed: server_lost`, with everything recorded kept. Events the
dead server sends late are rejected by handle; a restart with the window open re-arms
what fits (`resume`: a running replacement waits for players, a booting one has the
window, none at all re-runs the walk). The conformance flows `crash-restore` and
`crash-lost` run against the orchestrator through the sim provider's `setFaults`, the
same knobs the published fake takes.

**Commands** are idempotent on `correlationId` across a restart (`match_commands`):
`force_end`, `restore` (`no_backup` with nothing to restore from, `invalid_state` while
the orchestrator's own restore is under way — it always is, unless a restart left the
window open with no walk running, which is the gap this door exists for), `profile` and
the state checks are the machine's; everything else is relayed down the server's channel (`link/channels.ts`: the
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
| `sim.kill` | pull the plug. Status answers `gone`, heartbeats stop, and the machine's loss detector opens the recovery window on its own — nothing announces it, exactly like a box that lost power. With a backup written by then the match comes back on `sim-N+1` |

A request's own `sim` block (`scenario`, `seed`, `mode`, `timeScale`, `chaos`) decides
where a match starts. The story is seeded **per match** (`sim#<matchId>` unless the
request names a seed), not per server, so a replacement server for a match that lost its
box tells the same story the dead one did — which is what makes the provider's `restore`
verb (load a round backup, boot, play on from it) mean anything. A simulated server has
no backup file, so the provider reports a small stand-in through the machine's `backup`
verb after every `backup_written` — the same door a plugin's `backup` frame takes.
`setFaults({ crash: { afterRound, backup } })` is the conformance suite's crash door:
the `server-crash` scenario after that round, and with `backup: false` a box that keeps
its files, so the loss is a real one. Registered when
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
`streamAllowedOrigins` is here). The first frame is `hello`, and a frame published while
the greeting was being read waits behind it — dropped rather than written when it is an
event at or below the hello's `seq`, because replaying from that cursor already covers
it; a match that is over gets `4000` right after the hello; a subscriber a megabyte
behind is closed `4008`.

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
For a `matchzy` flow `matchzyConfig` is the match file MatchZy loads, built from the same
request (`match-config/matchzy.ts`, "The MatchZy door" below); `restore` is the backup the
match resumes from when this server is the replacement (*The match machine*, "Recovery").
A manifest naming a plugin the image lacks fails the match `provider_error` before anything
is sent.

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

## Nodes

A **node** is a docker host running the `ezpug-node` agent (decision 23; `docs/nodes.md`
is the venue runbook and covers the operator's side of everything below). To the
orchestrator every enrolled node together is one provider, `nodes`, whose servers cost
nothing and are `lan: true` — which is why a `requirements.lan` request lands on venue
hardware first (`providers/selection.ts`, `lanFirst`).

**`/node`** (`link/node-link.ts`) is the server link's smaller twin: the same raw `ws`
upgrade on the router in front of Hono, the same "every listener before anything is
awaited" rule, the same `hello`-first handshake and the same `LINK_CLOSE_CODES`. What
travels is different — this link carries *containers*, never a match. Nothing is acked:
an `instances` frame is a whole snapshot, so a lost one is superseded by the next and a
reconnecting node resends its state in `hello`.

**Enrolment is two steps, and only the second one produces a lasting secret.**
`POST /v1/fleet/nodes` writes the `nodes` row and mints a one-time **enrolment** token
(`ezie_`, 24 hours, hashed into `node_enrolments`), shown once in the response. The node
presents it in its first `hello`; the link spends the enrolment, mints the **node** token
(`ezin_`, hashed onto the row) and hands it over in the `welcome` — the only time it is
ever readable. `DELETE` revokes the token and closes the socket `4009`. Re-`POST`ing an id
that already exists is a rebuild: a fresh one-time token *and* the node token in force
revoked, because two agents answering for one node would have the pool counting its
capacity twice. What the `hello` says (region, labels, capacity, version, image digest)
lands on the row, so a node that re-labels itself needs no re-enrolment.

**Capacity.** One offering per enrolled node. Connected and undrained: what it can still
run, `hourlyCents: 0`, `lan` and `region` as the node reports them, `tickrate` from its
`tickrate` label. Every other node: `available: 0`, and it stays in the list — "the venue
exists and is not answering" is a different fact from "there is no venue". Instances take
the lowest free game/GOTV port pair from `27415` up, per node, avoiding whatever the node
already reports. The address players are told is the node's `address` label, else the peer
address its own socket came from.

**The warm pool is the orchestrator's to fill.** `EZPUG_NODE_WARM` is what the node
*advertises*; a warm instance is a server with a server token, and only this process mints
those. So each warm container gets a ledger row of its own — provider `nodes`, no match,
cost 0, charged to the key that enrolled the node (`nodes.enrolled_by_key_id`) — and a
server token minted against it, and it dials `/link` and sits `idle`. A node with no
enrolling key warms nothing and says so once.

**A claim is the one place two rows meet.** `allocate` prefers a free warm instance;
`configure` then moves the container from its warm row to the walk's row — the token is
**re-pointed** (`reassignServerToken`) rather than replaced, because there is no way to
hand a running CS2 server a new credential, and the warm row is closed `released`,
"claimed by match …". The walk's own freshly minted token stays on the row unused and dies
with it. `start` rebinds the live link session to the new row and match and sends the
assignment down the socket the container is already holding — **after** returning, because
composing an assignment runs on the match's chain and the walk that called `start` is
still holding it. Cold instances are the ordinary path: `start` sends the node a container
spec carrying the walk's token, and the boot deadline covers the CS2 boot.

The upshot in the ledger is one open row per container, always, charged to the key that is
using it: a warm row from the moment the container booted to the moment a match claimed
it, then the match's row — which is what makes a node match count against that key's
concurrency ceiling even though it costs nothing.

**A node that drops off the wire does not end its matches.** Its containers keep running
and the agent adopts them from their labels when it dials back (`apps/node`); the provider
keeps listing them, so the reaper does not call a live match lost, and says
`fleet.node_disconnected` into every match the node was holding. Only after
`NODE_LOST_MS` (a minute) does `status` report those servers `gone` — from there the
machine's recovery window takes over (T14). After a restart of *this* process the provider
rebuilds its instance map from the open ledger rows on the node's first `hello`, for the
same reason.

`nodes/nodes.test.ts` runs all of it over real sockets on a fake clock: the fake node from
`@ezpug/protocol/fake-node` as the agent, the fake server as the containers it starts.

## The MatchZy door

The one HTTP path a server speaks to besides its link: `POST /matchzy/log`
(`MATCHZY_LOG_PATH` in `@ezpug/protocol`). MatchZy 0.8.15 has no in-process forwards —
its match-flow events leave it only as one POST per event to `matchzy_remote_log_url`,
with one custom header, a fifteen-second timeout and no retry — so the core plugin points
that URL here and puts the server's own link token in the `x-ezpug-server-token` header,
both from its sidecar (decision 19; `docs/gamemodes.md`, "The `matchzy` flow"). No API key,
no scope: the token is the server's identity exactly as on the link. It travels in a
header, never the path, so neither the request log nor a proxy's access log holds it.

The door hashes the token, finds the `server_tokens` row, the open ledger row it was
minted for and the match that row holds, translates the payload (`matchzy/translate.ts`:
`going_live`, `round_end`, `map_result` → `map_end`, `series_end`; the veto trio,
`series_start`, `demo_upload_ended` and `player_disconnect` dropped) and hands the events
to the same sink the link feeds, attributed to the same `provider/serverId` — the machine
cannot tell which door a fact came through. `going_live` still moves the match to `live`
and `series_end` still ends it. A payload naming another `matchid` than the serial the
config gave this match (`matchzySerial`) is a stale plugin and is dropped.

Answers: `200` with `{ accepted, statuses }` for anything the door could read, dropped
events included (`{ accepted: 0, dropped: <why> }` — MatchZy only logs the status);
`401` for no or an unknown token, `409` when the row holds no open match, `400` for a body
that is not JSON, `413` past `MATCHZY_PAYLOAD_MAX`, `429` from the same token bucket the
Match API uses, keyed by the token's hash. The last score seen per match (how the round
winner is found: MatchZy's `winner.team` names the map leader) lives in the process; a
restart between rounds falls back to the map plan's side schedule and logs it.

## One real match, recorded (`pnpm iron:match`)

`scripts/iron-match.mjs` plays a whole match on real hardware through nothing but the
Match API, and writes down everything it said. It is how the fixtures under
`packages/protocol/fixtures/recorded/`, `packages/match-api/fixtures/recorded/real-*.json`
and `apps/orchestrator/src/matchzy/fixtures/` came to hold what a real MatchZy sends
rather than what its schema documentation claims (PRD-02 T13), and it is the client the
`EZPUG_CS2_TESTS` lane runs.

```
pnpm dev:up                                     # Postgres, Redis, migrations
# .env: EZPUG_IRON_PROVIDERS=sim,nodes
EZPUG_IRON_TRACE_FILE=.cache/trace/dev.ndjson pnpm dev
pnpm dev:node up                                # this box becomes a node
pnpm iron:match --write-fixtures                # ~10 minutes, one CS2 container
```

What it does, in order: mints an admin key from the box (`keys:mint`), mints the run's own
key with a webhook secret nobody else holds, opens a webhook endpoint on loopback that
**verifies every delivery with the published verifier** before writing it down, mints a
presigned PUT into the platform's dev MinIO for `callbacks.demoUploadUrl`, `POST`s a `pug`
with `requirements.lan`, subscribes to the match's stream, fills the server with bots,
forces the start, waits for a terminal state, replays the events route page by page, reads
the ledger, and writes the run to `.cache/iron-match/<run>/`. Its key is revoked and its
server released in a `finally` **and on a signal** — a Ctrl-C does not leave a container
running.

Three things it learned on this box that are not in anybody's documentation, and that the
script and the plugin now encode:

- **`//` is a console comment.** `matchzy_remote_log_url http://host/path` reaches MatchZy
  as the single argument `http`; it answers "Invalid URL: http", the door is never wired,
  and every MatchZy event of that match is lost silently. `MatchZyRemoteLog` quotes all
  three values.
- **The bots have to be standing before the match starts.** MatchZy's `warmup.cfg` runs
  `bot_kick; bot_quota 0` and its `live.cfg` ends with `mp_warmup_end`; on an empty server
  that ends nothing, so the engine stays in warmup and the match never plays a round. The
  script fills during warmup, waits, and only then sends `css_start` — a dwell and not a
  barrier, because a bot emits no `player_connected` (the vocabulary's players are people).
- **A drawn map in a Bo1 does not end the series.** With an even `mp_maxrounds` and no
  overtime a map can finish 2–2; MatchZy's `HandleMatchEnd` then reports `remainingMaps: 1`
  and replays the same map instead of sending `series_end`. The script asks for overtime by
  default; `--no-overtime` is there for whoever wants to watch that happen.

**The trace** (`EZPUG_IRON_TRACE_FILE`) is the only part of this the orchestrator itself
does: with the variable set it appends one scrubbed NDJSON line per `/link` frame, per
`/node` frame and per MatchZy payload, so the script can record the two conversations no
client can see. It is off unless the variable names a file and is **refused outright under
`NODE_ENV=production`** — a production orchestrator does not write the servers'
conversations to disk. Tokens, passwords and presigned queries are replaced as the line is
written, not when it is read.

**No `position_tick` reaches a file.** Decision 6 makes ticks stream-only — never stored,
never replayed — so the recorder drops them and the `ack` frames they earned before
anything is written; a five-minute match's ticks are nine tenths of the bytes and none of
the meaning. Both fixture tests assert no file names one.

A recording costs ten minutes of real hardware, so changing how a fixture is *shaped* must
not cost another match: every run writes `raw.json` beside its output, and
`pnpm iron:match --rebuild .cache/iron-match/<run>` writes every file again from it.

### The `EZPUG_CS2_TESTS` lane

`apps/orchestrator/src/cs2.extended.test.ts` runs that script and asserts the summary:
the match reached `ended`, MatchZy went live, rounds were played, `series_end` and
`match.ended` reached the client, the link and the door both carried the match, **and the
ledger row is closed with no server left running**. It is opt-in twice over — nothing
happens unless `EZPUG_CS2_TESTS` is set, and `EZPUG_CS2_TESTS=required` turns "there is no
dev node" from a printed skip into a failure. It is never part of `pnpm verify`.

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
| `nodes` | every `ezpug-node` enrolled: region, labels, capacity, connection facts, the node token's hash, and the key that enrolled it (whose warm containers are charged to it) | enrolment and the node link (T12) |
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

**Waiting is a barrier, never a sleep.** In process the world only moves when the fake
clock is turned, and `createTestApp`'s `settle()` may return only once nothing is left
moving: every match chain drained, every webhook attempt finished, no zero-delay timer
armed, and no event a simulated server spoke still on its way into the machine — the sim
provider counts those (`pending()`), because a server speaks from a timer callback and the
promise that becomes is nobody's to await. Against the real service there is no fake clock:
the story plays on real timers while the client talks over a real socket, so the extended
suite asks the orchestrator itself when it has caught up (its `matches.settle()`,
its `webhooks.settle()`, nothing due) instead of sleeping, and runs the story slowly enough
(twenty times real time, not sixty) that a two-round map still has a dozen seconds of live
match in it when a loaded box makes a client's own round trips slow. Both rules were paid
for in red suites — a `settle()` that hoped returned while the last envelopes were queued,
and a story that outran its client saw a `pause` refused `invalid_state` on a match that had
already ended.

The **`EZPUG_CS2_TESTS` lane** is the third tier and is nobody's default: ten minutes, a
CS2 container and a node on this box (see "One real match, recorded"). `pnpm verify` never
runs it, `pnpm verify:extended` runs it only when the variable is set, and
`EZPUG_CS2_TESTS=required` makes a missing dev node red instead of a printed skip.
