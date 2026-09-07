# Operations

The operator's reference for the orchestrator: what runs, what it reads, what it stores,
how it starts and stops. Written for someone standing at a terminal on the box at eleven
on a Saturday. The deploy itself has a runbook of its own beside this one —
**`ralph/DEPLOY.md`**, the first deploy, the backups, the rollback and what to do when
`gs.ezpug.com` is down; "Deploying" below is the reference around it. Budgets, the Dathost
template and the GSLT pool have their own sections; T38 adds the test that checks every
route, command and version this file names.

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
its runbook, and the orchestrator's `nodes` provider that drives it is T12's. And
`apps/cli` is **`ezpug-iron`** (`pnpm iron`), the operator's terminal over the same Match
API the platform speaks — the section "`ezpug-iron`, the command" below.

Ports and every setting are decided in `.env.example` and nowhere else. Every name is
`EZPUG_IRON_*`, because the platform runs on the same box with `EZPUG_*` names of its own:

| Variable | Default | What |
| -------- | ------- | ---- |
| `EZPUG_IRON_BASE_URL` | `http://localhost:3430` | the orchestrator's own public origin — a client's `baseUrl`, what tokens and webhooks are minted against |
| `EZPUG_IRON_PUBLIC_URL` | — | the same value under the name the dev contract below uses; it wins over `EZPUG_IRON_BASE_URL` when both are set |
| `EZPUG_IRON_HOST` / `EZPUG_IRON_PORT` | `127.0.0.1` / `3430` | where the process binds; the container sets `0.0.0.0` and compose publishes |
| `EZPUG_IRON_PROVIDERS` | `sim` | the providers to register, comma-separated (`sim`, `dathost`, `nodes`; T3/T4/T12/T16) |
| `EZPUG_IRON_DEPLOYMENT` | `ezpug` | which deployment this process is: the stamp on every ledger row and the Dathost `user_data` tag (below) |
| `EZPUG_IRON_DATABASE_URL` | — | `postgres://…`; `EZPUG_IRON_TEST_DATABASE_URL` is the Vitest database beside it |
| `EZPUG_IRON_DATABASE_POOL_MAX`, `…_IDLE_TIMEOUT`, `…_CONNECT_TIMEOUT`, `…_STATEMENT_TIMEOUT`, `…_LOG` | `10`, `30`, `10`, `15000`, `false` | pool tuning; the statement timeout is what keeps a runaway query from wedging the pool |
| `EZPUG_IRON_REDIS_URL` | — | `redis://…` |
| `EZPUG_IRON_RATE_LIMIT_BURST` / `…_PER_SECOND` | `120` / `10` | the per-key token bucket (below) |
| `EZPUG_IRON_MIGRATE_ON_BOOT` | `false` | apply pending migrations before the port opens; the image sets it |
| `EZPUG_IRON_MIGRATIONS_DIR` | beside the code | where the migration SQL is, when it is not (`/app/drizzle` in the image) |
| `EZPUG_IRON_BOOTSTRAP_API_KEY` | — | **dev only**: adopt an API key with this exact secret at boot (below); refused under `NODE_ENV=production` |
| `EZPUG_IRON_API_KEY` | — | read by the **CLI**, not by the orchestrator: the key `ezpug-iron` authenticates with, environment only (below) |
| `EZPUG_IRON_CLI_URL` | `EZPUG_IRON_BASE_URL` | read by the **CLI**: which orchestrator to talk to; `--url` beats it |
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
that ships its own .NET runtime — the steamrt base has none), MatchZy, cs2-retakes with its
allocator, the WeaponPaints fork, `EZPug.Sdk` and `EZPug.Core`, and the `gamemodes/*/cfg` set. Every one of them is a pinned version with a
SHA-256 beside it in the Dockerfile and a row in `docs/pins.md`, and `pnpm lint` refuses a
disagreement between the two — including the one pin that lives twice, the
CounterStrikeSharp version the plugins compile against and the release that loads them.
Every plugin folder a manifest can name is there (the retakes pair since T23, the
WeaponPaints fork since T28); the core plugin's loader still warns and skips a plugin that
is not, and the orchestrator refuses an assignment naming one before it is ever sent.

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

**`FollowCS2ServerGuidelines: false`.** CounterStrikeSharp ships a flag that refuses to
read or write a handful of controller fields, `m_iCompetitiveRanking` and
`m_iCompetitiveRankType` among them — the two EZ Rating is drawn with (decision 21). The
image writes a `core.json` from the pinned release's own `core.example.json` with that one
key flipped, so every other key stays whatever upstream ships and a rename upstream fails
the build rather than passing quietly. **The risk is Valve's to take:** the guideline asks a
server not to alter what a client shows about a player's *Valve* rank, and a server that
flouts the guidelines can be refused a GSLT — which would cost the Dathost half of the fleet
its public listing. What EZPug draws is its own number, on a private league's servers, on a
scoreboard nobody mistakes for matchmaking, and nothing is ever written back to Steam.
**The skins layer needs the same flag** (PRD-02 T28): the WeaponPaints fork writes the
inventory and attribute fields the guidelines cover, which is what upstream's README asks
for too, so decision 20 buys no new risk — the one already taken for the rating covers both.
Turning the flag back on is one line here and costs the rating and the skins: the plugin
warns once and draws nothing (T27), and every player keeps default items.

**No GSLT.** A Steam Game Server Login Token is leased per running server and the pool
exists for Dathost (T17); without one CS2 accepts LAN connections, which is all this box and
a venue node ever need. Bots are allowed — `bot_quota` is a cfg and a request's cvar, not an
image decision.

## Releasing: CI and the tags

Every push and every pull request runs `pnpm verify` in GitHub Actions
(`.github/workflows/verify.yml`): strict typecheck, Biome with the lint guards, Vitest,
`turbo boundaries`, `dotnet build -warnaserror` and `dotnet test`. No CS2, no Dathost, no
database — those tiers are local and opt-in, and CI is the tier every clone can reproduce.
That workflow is also *reusable*: the release workflows call it with `uses:`, so there is
one definition of green and a tag runs exactly what a pull request ran.

Nothing is released by pushing to a branch. Five tag prefixes, one artifact each:

| Tag | What it publishes | Workflow |
| --- | ----------------- | -------- |
| `match-api@x.y.z` | `@ezpug/match-api` to npm, with provenance, after `pnpm verify:extended` | `release.yml` |
| `orchestrator@x.y.z` | `ghcr.io/ezpug/ezpug-iron/orchestrator`, `linux/amd64` + `linux/arm64` | `images.yml` |
| `node@x.y.z` | `ghcr.io/ezpug/ezpug-iron/node`, `linux/amd64` + `linux/arm64` | `images.yml` |
| `cs2@x.y.z` | `ghcr.io/ezpug/ezpug-iron/cs2`, `linux/amd64` (the only platform Valve ships a server for) | `images.yml` |
| `plugins@x.y.z` | `ezpug-plugins-x.y.z.zip` on the tag's GitHub release | `plugins.yml` |

```sh
node scripts/release.mjs version 0.9.0        # the package: bump + CHANGELOG, then commit
git tag match-api@0.9.0     && git push origin match-api@0.9.0
node scripts/release-image.mjs plan cs2@0.1.0 # an image: what that tag would publish
git tag cs2@0.1.0           && git push origin cs2@0.1.0
git tag plugins@0.1.0       && git push origin plugins@0.1.0
```

**The images.** `scripts/release-image.mjs` is the table — which Dockerfile, which
platforms, which registry tags — and the workflow parses no tag itself. A release publishes
`x.y.z`, the moving `x.y` and `latest` (a prerelease only its exact version), refuses a
version the registry already serves rather than overwriting a released artifact, builds
each platform on its *own native runner* rather than under qemu, writes the human-readable
tag once as a manifest list over the per-platform digests, and attests build provenance
against it. Each image carries the commit it was built from as
`org.opencontainers.image.revision`, which is what a rollback asks an image about. A
`workflow_dispatch` run is the dry run: the same build, no push.

**The plugin zip** is `plugins/publish.sh`'s tree — `EZPug.Core`, one copy of `EZPug.Sdk`
in `shared/`, the SDK gamemodes under `plugins/disabled/` — zipped as an `addons/` tree
that unpacks into a server's `game/csgo/`. It is for a server this repo does not build the
image for; ours have it baked in. The tag has to name the version
`plugins/EZPug.Core/EZPug.Core.csproj` carries, and the check reads it out of the
`build.json` in the tree that was just built, so the artifact itself is the witness.

**What pins what** is `docs/pins.md`: the image names, their platforms, and which tag a
deployment is on. The platform pins the orchestrator image in its own compose
(`EZPUG_IRON_IMAGE`); production here pins it with the same variable in
`.env.production`, which `compose.prod.yaml` reads; a node pulls the node image and the CS2
image it starts servers from (`docs/nodes.md`). A bump is a commit in the consumer, never a
moving tag.

## Deploying

`gs.ezpug.com` runs on this box, in its own compose project, behind the Traefik that
already fronts everything else on it (decision 11). **`./scripts/deploy.sh` is the whole
deploy**, and its smoke step is what "deployed" means. `ralph/DEPLOY.md` is the runbook —
the first deploy on a fresh box, the backups, the rollback, the Saturday. What follows is
the shape of it.

```sh
pnpm verify && pnpm verify:extended   # the gate; the deploy does not run it for you
./scripts/deploy.sh                   # preflight → build → migrate → up → routes → smoke
./scripts/deploy.sh smoke             # …or any one step, alone
pnpm prod:ps                          # what is running
pnpm prod:logs                        # follow
pnpm prod:down                        # stop; the volumes stay
```

Every step is idempotent — running the whole thing twice in a row is a no-op the second
time, which is what makes re-running a failed deploy the normal way to finish it.

**The three files.** `compose.prod.yaml` is the stack (its own Postgres and Redis on named
volumes, the orchestrator published on `172.17.0.1:3431` and nowhere else, no CS2 — nodes
are elsewhere). `docker/traefik/ezpug-iron.yml` is the front door, installed by the
`routes` step at `/opt/traefik/routes/ezpug-iron.yml`, the one path outside this repo a
deploy writes. `.env.production` (gitignored, `.env.production.example` is its template) is
every production value, read twice: compose interpolates from it and the orchestrator
container takes it verbatim, so a value is written once and the hostnames in it are compose
service names.

**Where the image comes from.** By default the deploy builds this checkout into
`ezpug-iron/orchestrator:latest` and keeps the one it replaced as `:previous`, which is
what `deploy.sh rollback` puts back. Set `EZPUG_IRON_IMAGE` in `.env.production` to a
published tag (`ghcr.io/ezpug/ezpug-iron/orchestrator:x.y.z`) and the `build` step *pulls*
it instead — a released tag can never be quietly overwritten by a local build, and rolling
back becomes bumping that line.

**Migrations run with a dump in front of them.** `deploy.sh migrate` brings up Postgres and
Redis, takes a `pg_dump` into `EZPUG_IRON_BACKUP_DIR` on the host, then applies what is
pending — as its own step, with its own exit code, before any serving container is
replaced. A failed migration therefore leaves the previous release serving. Migrations are
additive-safe by rule, so the dump is not a plan for undoing one; it is the answer to the
failure additivity does not cover, and it is a credential in its own right (see "What this
database holds in clear, and why").

**The first API key of a deployment** is the one thing production cannot get over the Match
API: `EZPUG_IRON_BOOTSTRAP_API_KEY` is refused under `NODE_ENV=production`, and
`ezpug-iron keys create` needs an `admin` key to already exist. So the image carries
`dist/mint-key.mjs` and `./scripts/deploy.sh key --name operator --scopes admin,matches,fleet`
runs it: the secret is printed once, goes into `.env.production` as `EZPUG_IRON_API_KEY`,
and every key after it — the platform's, with its own budget — is minted by the CLI.

**The smoke** is what the deploy calls done: `/healthz` on the bridge (the container,
past Traefik and past DNS) and over public TLS, `http` redirecting to `https`, and
`GET /v1/capacity` answering `200` with the operator key and `401` without one. The key
reaches curl on stdin (`--config -`), never in argv — the same rule the CLI holds itself to.

## Health

`GET /healthz` needs no key. It answers `200 { ok: true, service: "orchestrator", checks }`
when every rail answers, `503` otherwise, and `503 { state: "draining" }` from the first
moment of a shutdown. `checks` has one entry per rail — `database`, `redis`, and
`providers` by id — each `{ ok, latencyMs, error? }`; a rail that does not answer within
two seconds is `ok: false` with `no answer within 2000ms`. Compose's healthcheck, the
deploy smoke and `pnpm dev:status` all read this one route.

### Provider health and the fleet facts

`GET /v1/fleet/providers` answers `{ id, healthy, drained, lastCheckedAt, lastError,
servers }` per provider, and it is a **read of something a timer keeps fresh**, not a call
that might hang. Every 30 seconds the probe loop
(`apps/orchestrator/src/providers/probes.ts`) asks each provider the cheapest question it
has — Dathost `GET /account`, the node provider how long ago its nodes were heard from,
the sim in-process and therefore always up — bounded to five seconds, and writes the
answer into the registry. A provider with no probe of its own is asked for its
`offerings()`. `/healthz` asks the same question live, so an orchestrator whose Dathost
credentials stopped working is not healthy even while its offering cache is warm.

The first pass that finds a provider unreachable says **`fleet.provider_unreachable`
once** — into every open match with a ledger row on it, carrying when the incident began
and the error that proved it. A pass that finds it still unreachable says nothing more; a
successful probe closes the incident, and the next outage is a new one worth a new fact.
The adapters already swallow a blip (Dathost retries a 5xx and a dropped socket three
times inside one call), so a probe that fails here has failed for long enough to matter.

The node provider is unhealthy only when **every** enrolled node is off the wire: one
venue box being off on a Tuesday is capacity news (`available: 0`, and
`fleet.node_disconnected` for a match that was on it), not a provider outage. A deployment
with no node enrolled is healthy and empty.

The other three fleet facts come from where they happen: `fleet.node_disconnected` from
the node provider once a node has been silent for its grace window,
`fleet.orphan_found` from the reaper, `fleet.budget_threshold` from the budget sweep.

**Where they are POSTed.** A key that registered a fleet webhook hears all four there,
signed with the secret that registration named — one endpoint for the console tile that
watches the fleet, instead of a subscription to every open match:

```sh
curl -sS -X PUT https://gs.ezpug.com/v1/keys/$KEY_ID/fleet-webhook \
  -H "authorization: Bearer $ADMIN_KEY" -H 'content-type: application/json' \
  -d '{"fleetWebhook": {"url": "https://ezpug.com/hooks/fleet", "secretId": "whsec-2026-09"}}'
```

The envelope is unchanged — same `matchId`, same `seq`, same signature scheme — and
`GET /v1/matches/:id/events` still replays it on the match. `{"fleetWebhook": null}`
clears it and the facts go back to each match's own callback. A `secretId` the key never
registered is refused: an endpoint whose envelopes carry a `kid` nothing can verify fails
silently at three in the morning.

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
7. `reaper`, `probes`, `budgets`, `gslt`, `webhooks`, `matches`, `hub` — the sweeps disarm, attempts in flight finish, every
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
| join, again | the replacement's `server_ready` until it shows a sign of play | 20 min | `failed: server_lost` |
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
the join deadline; **the first sign the replacement is playing** says `match.recovered`
(`resumedFromRound`) and the match is `live` again, on its second server. No backup, an
exhausted candidate list, the window or the join deadline running out, or the
replacement dying too: `failed: server_lost`, with everything recorded kept. Events the
dead server sends late are rejected by handle; a restart with the window open re-arms
what fits (`resume`: a running replacement waits for players, a booting one has the
window, none at all re-runs the walk). The conformance flows `crash-restore` and
`crash-lost` run against the orchestrator through the sim provider's `setFaults`, the
same knobs the published fake takes.

**Three signs close that window, and hardware is why** (T37, T37a). Everything up to
`match.server_ready` was real and fast on a node against production — 38 seconds from a
`docker kill` to a replacement whose plugin had loaded the round backup, 30 seconds to
`failed: server_lost` when the walk had no candidate left — and then the recovery did not
finish, because **a `matchzy` flow never says `going_live` a second time**: MatchZy
resumes from the checkpoint it loaded (its own log says so) without repeating the event
that belongs to the start of a series. The window used to close on that event alone, so a
match whose server was up and playing ended `failed: server_lost` twenty minutes later.
It now closes on the first of three, whichever the flow gives:

1. **`going_live`** — a flow that restarts its series, and every simulated one.
2. **the plugin's `backup_restored`** (`plugin_event`, `@ezpug/protocol`'s
   `BACKUP_RESTORED_EVENT`) — said the moment `matchzy_loadbackup` has been given the file
   the assignment carried. A plugin loads the backup on its way up, so this usually
   arrives *before* the replacement's `server_ready`; it is then held until the connect
   facts have gone out, and `match.recovered` never precedes the `match.server_ready` it
   belongs to.
3. **the first `round_end` on the replacement** — the sign no flow can withhold, for the
   case where the plugin is older than this or its frame was lost.

The deadlines are unchanged, so a replacement that truly never came still fails
`server_lost` — "no sign of play within 1200000 ms of the replacement being ready". And
because the match is `live` again from the restore rather than twenty minutes after it,
`unpause` is legal where a venue needs it: MatchZy pauses after a restore
(`matchzy_pause_after_restore`), and lifting that pause used to need `rcon` because
`unpause` is refused outside `live`.

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

**What the reaper cannot see, the `nodes` provider sweeps** (T32a). A provider's `list()`
is what the process holds in memory, so a container the orchestrator forgot is invisible
to the reconciliation above: an agent that goes away mid-match comes back to a match that
failed and a row that was closed while it was gone, and the `stop` that closing sent had
no socket to be written on. So every snapshot a node sends is held against the ledger —
an open row of this deployment is adopted, a closed one is stopped and stopped again
until the container is gone, and a container no row of this deployment accounts for is
logged once and never touched, because `nodes` is not deployment-scoped and a venue box
can have served another world before this one (`docs/nodes.md`).

**Everything a process does on its own initiative is one deployment's**
(`EZPUG_IRON_DEPLOYMENT`, T21c). Provider truth is per-deployment — the Dathost
`user_data` tag says which clones on a shared account are ours, a `sim` server lives in
the process that made it, a node dials exactly one orchestrator — so a row another
deployment opened is one this process cannot judge. Three reads used to ignore that and
each of them acts on what it finds:

- **the reaper**, which would find no server behind a neighbour's ledger row, call it
  lost and end that match `provider_error: server lost before going live`;
- **the boot's `resume()`**, which would re-arm a neighbour's open matches and restart
  the walks it believed had died — two machines on one row, and a second server allocated
  for a match that already has one;
- **the webhook worker**, which would POST a neighbour's due deliveries and race it for
  the row.

Every match and every ledger row now carries the deployment that wrote it, and those
three (and `GET /v1/fleet/servers`) ask only for their own. Read-only history —
`GET /v1/fleet/ledger`, a key's matches, a month's spend — is not narrowed: money and the
past belong to the key, not to the process. One world per database needs no setting; two
that share one — dev beside production, two Vitest suites on the test database — each need
their own name, and `src/deployments.extended.test.ts` is what holds that true.

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
`?token=` (minted by `POST /v1/matches/:id/player-tokens`, checked against `player_tokens`
and the request's `streamAllowedOrigins` here). The first frame is `hello`, and a frame published while
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
the rules, the roster, the warmup lines (printed one every eight seconds while the
server waits, cycling — `docs/sdk.md`, "Warmup lines"), the branding and the demo upload
URL.
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

## The widget socket

Decision 17, T24: a gamemode's widget opens **its own socket** to the orchestrator, `GET
/v1/widget` (`widget/upgrade.ts`), with a player token — a `POST
/v1/matches/:id/player-tokens` mints one for a rostered player, a player the server has
seen join, or anyone on an open-join mode (`matches.mintPlayerToken`), fifteen minutes by
default and an hour at most, stored as a hash in `player_tokens` and shown once. The token
travels in the widget's first frame, `hello`, never in the URL: the request log would have
it otherwise. Everything after the greeting is `widget/service.ts`, which the conformance
target drives in-process the way the socket does: the answer is a `hello` with the mode's
declared verbs and what this process last learned about their charges and cooldown for
this player (a hint for the buttons; the SDK is the truth), then every durable fact of the
match as an `event` frame — the widget subscribes to the hub like a stream socket, so it
sees its own tap land — and a `command_result` per tap.

**A tap is a `player_command` frame over the link.** The service checks the token's
expiry and a bucket per token (`WIDGET_COMMAND_RATE_LIMIT`: ten taps, two more a second —
`rate_limited`, with how long to wait), then `matches.playerCommand` refuses what needs no
server (`not_live` before the match is live or after it ended; `unknown_command` for a
verb the manifest lacks) and relays the rest to the match's channel with the widget's own
`correlationId`; the SDK's `player_command_result` comes back as it was said, in the
player's language, and a server that does not answer inside the relay deadline is
`unavailable`. The relay never holds the match's chain — a real plugin reports the tap's
`plugin_event` before it answers the tap. On a simulated server the engine's stand-in
mode (`@ezpug/sim`'s command table) enforces the manifest and deals a `player_command`
`plugin_event`, so the platform proves the round trip without CS2. What the orchestrator
refuses itself it says in DE or EN from the roster profile, German by default.

**A push goes the other way** (T26): a plugin's `widget_push` frame on the link names a
match and one SteamID64, and `server-link.ts` hands it to `widgets.push` — which delivers
it to that player's open widget sockets and to nobody else's, then forgets it. Nothing is
stored, logged or replayed; a push for a match the server does not hold is warned about
and dropped, one over `WIDGET_PUSH_DATA_MAX` (16 KiB of JSON) is dropped, and one nobody
is listening for is simply gone — the normal case for a player with no phone open.
`powerup-dm`'s `radar_peek` is ten of them over five seconds and is why no position is
ever written down.

**Refusals are close codes** (`WIDGET_CLOSE_CODES`): `4001` for no token, one that does
not verify, one that expired (also on the next tap of an open session), or a match that
does not exist; `4005` for a browser origin not in `streamAllowedOrigins`; `4002` for a
`hello` on another protocol; `4003` for a frame that does not parse or a first frame that
is not `hello`; `4009` for no `hello` within ten seconds on the clock; `4008` for a widget
a megabyte behind. **A token dies with the match**: the hub's close for the match ends
every session on it with `4000` after the `match.ended` frame, a `hello` after the end gets
the terminal state and the `4000` at once, and nothing new is minted for a match that is
over (`invalid_state`). The drain closes the widget sockets in the stream's step.
`widget/upgrade.test.ts` runs the whole thing over a real socket against a real link with
the protocol's fake server as the plugin.

## The widget bundles

Decision 17, T25: a gamemode's widget is a file the orchestrator serves, not code it
bundles. `gamemode-kit` builds `gamemodes/<id>/dist/widget.js` for every `sdk` mode with a
widget (`@ezpug/gamemodes`'s own `build`; `pnpm build`, and `pnpm dev` builds its
dependencies first), `widget/bundles.ts` reads each at boot from `EZPUG_IRON_GAMEMODES_DIR`
— the workspace's `gamemodes/` through `@ezpug/gamemodes` on a dev box, `/app/gamemodes` in
the image, where the Dockerfile collects every `gamemodes/*/dist` — hashes it, logs one
line per bundle, and `app.ts` serves three paths without a key:

| Path | Answer | Cache |
| ---- | ------ | ----- |
| `GET /gamemodes/:id/widget/:hash/index.html` | the document the platform mounts: one module script, `./widget.js`, a CSP that allows scripts and a socket to this orchestrator alone (`widgetCsp`: the host the request came to — `x-forwarded-host` behind Traefik — and `EZPUG_IRON_BASE_URL`'s, `ws://` and `wss://` of each) | a year, immutable; a hash that is not this boot's is `404` |
| `GET /gamemodes/:id/widget/:hash/widget.js` | the bundle, `Access-Control-Allow-Origin: *` because a sandboxed frame's module script is a CORS request from the origin `null` | a year, immutable |
| `GET /gamemodes/:id/widget.js` | the current bundle under its stable name | `no-cache`, the hash as `ETag`, `304` on `If-None-Match` |

The catalog advertises the document's URL as `widget.url` on the served manifest
(`@ezpug/match-api` 0.6.0); the platform mounts by that address and never builds one. A mode
whose bundle is missing is a `warn` line at boot naming the file and a manifest without a
`url` — the platform then mounts nothing for it, which is honest; `pnpm build` makes the
bundle. The widget door greets a socket whose `Origin` is the literal `null` (the sandbox's
opaque origin) instead of holding it against `streamAllowedOrigins`; the player token is the
credential there.

Nothing here touches the ledger, the machine or a key: the bundles are public source from
this repo, read once, served from memory.

## The console and RCON

Two operator doors, both behind the `fleet` scope, both on `GET`/`POST
/v1/fleet/servers/:id/…`. `:id` is the ledger row's uuid **or** the provider's own handle.

**`GET …/console`** answers the tail of what the server has been printing, oldest first,
at most 500 lines. Where it comes from, in order:

1. **The plugin's own tail**, relayed over the link and cached on the session (*The link*,
   above). This is the good answer — it is the game's console whoever rents the box. A
   server that has never sent one is asked for one now; the round trip is a single frame.
2. **The provider's backlog**, for the minutes before the link is up: Dathost keeps a
   console log and the provider reads it. A node keeps none (the container *is* the
   server), and the sim has no console at all.
3. **Nothing**, as `{"lines": []}` — an empty tail, not an error. A server that has said
   nothing has said nothing.

**`POST …/rcon`** runs one line and answers what the server printed. The order is not the
obvious one, and the reason is worth knowing: the **provider's** RCON door goes first,
because it is the only one that hands back *output*. Dathost reads its console around the
command; a node opens a Source RCON socket on the game port (`apps/orchestrator/src/rcon/`
— our own framing, ~150 lines, every deadline on the injected clock) with the password it
put in the container's environment. Only when a provider has no door at all does the line
go down the **link** instead: a plugin can run a command but cannot capture the engine's
answer, so it applies the line and answers with nothing. A simulated server refuses with
`command_unsupported`, which is what the route's contract promises. An unreachable door is
`provider_unavailable`; a row the ledger has closed is `invalid_state`.

The whole point of RCON here is that it is the *fallback* (decision 5). A server's real
relationship with this process is its link; RCON is for a human and for the moment before
the link is up.

**Nothing from either route carries a credential.** Every line served and every line
written to the audit passes through `rcon/redact.ts`, which masks the value after a
password-ish cvar — `rcon_password`, `sv_password`, `sv_setsteamaccount`, MatchZy's
remote-log header value, a presigned upload URL — and shortens any token of ours that
somehow reached a line. What was run, by which key, and what came back is appended to the
ledger row's `rcon_audit` column, atomically and bounded to the last 200 lines, so two
operators typing at once both leave a trace.

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

## Dathost

The rented half of the fleet (`providers/dathost/provider.ts`, PRD-02 T16). EZPug uses
Dathost's **raw server API**, never their match API: we orchestrate MatchZy ourselves, so
a box in Frankfurt and a node at the venue are the same thing to everything above the
provider, and the same plugin runs on both. `references/dathost.md` is the digest of the
vendor's pages the adapter was written from.

**It is registered iff the account is configured** — `EZPUG_IRON_DATHOST_EMAIL`,
`EZPUG_IRON_DATHOST_PASSWORD` and `EZPUG_IRON_DATHOST_TEMPLATE_SERVER_ID`, with
`EZPUG_IRON_DATHOST_LOCATION` defaulting to `dusseldorf` (which is how Dathost spells
Frankfurt). The PRD's unprefixed `EZPUG_DATHOST_*` names work as aliases. All three or
none: half a credential set fails at boot with the missing names, and *no* credentials
with `dathost` in `EZPUG_IRON_PROVIDERS` is a warning at startup and a fleet that runs on
`sim` and `nodes` — which is exactly the deploy that goes out while the owner is finding
the password. Neither the password nor the Basic-auth header is ever logged, put in an
error or written into the ledger's `provider_meta`.

**Allocation is a clone of one template.** `scripts/dathost-image.mjs` (T18) builds the
template server once — Metamod, CounterStrikeSharp, MatchZy, retakes, our plugins, our
cfgs — and its id is the environment variable above. Then, per match:

| verb | what it does at Dathost |
| --- | --- |
| `offerings` | one `GET` of the template per minute: `cs2`, region `frankfurt`, workshop maps, `hourlyCents` from its `cost_per_hour`. Capacity is unbounded — the wall is the API key's budget, not a number Dathost publishes. |
| `allocate` | `sync-files` on the template (at most once per ten minutes), `duplicate`, then one `PUT`: a readable name, the ledger tag in `user_data`, `autostop` and `reboot_on_crash` **off**, a freshly minted RCON password, the GSLT lease (T17). |
| `configure` | the join password (`cs2_settings.password`) and `ezpug.json` — the link URL and this server's token — uploaded through the files API. Nothing else: the assignment travels over the link. |
| `start` | `POST …/start`; the walk's boot deadline covers the boot. |
| `status` | one `GET` (the *list* does not refresh `booting`). Off means **stopped**, which during a live match is the loss the probe is looking for. |
| `deallocate` | `stop` + `delete`, idempotent on a 404, and the GSLT lease goes back. |
| `list` | every server on the account carrying our tag, **or** untagged and cloned from our template (the window between `duplicate` and the `PUT`). A server wearing another deployment's tag is never claimed — two orchestrators may share an account. |
| `rcon` / `console` | the vendor's console endpoint — a log, not a request/response channel — for the moment before the link is up (the fleet console and RCON routes, above). |

**What it deliberately does not touch.** `cs2_settings.slots` and GOTV are the template's:
slots are part of a pay-as-you-go price and the ledger snapshots `cost_per_hour` at
allocate, so a clone that re-priced itself would make the budget a fiction. The template
carries `deletion_protection` and is refused by every verb — it is the image, never a
match's server.

**Money rules.** A `duplicate` is never retried (a repeated clone is a second server on the
bill); a 429 is backed off and retried on the injected clock; a 5xx or a dropped socket is
retried only where repeating the call is safe. An allocation that fails after the clone
exists deletes the clone before the walk moves on, and a clone it could not delete is
still claimed by `list()` — cloned-from-our-template is a tag the vendor writes itself —
so the reaper takes it within a grace window instead of billing quietly for it.
`providers/dathost/provider.test.ts` proves each of those against the fake Dathost (T15);
the one live lane is T19's smoke behind `EZPUG_DATHOST_TESTS=required`.

### The template server (`pnpm dathost:image`)

Dathost has no image registry. A server there is a box with files on it, and the only way
to get a second one carrying our plugins is `duplicate`, which copies the source's files
along with its settings. So the "image" for the rented half of the fleet is **one server
that never runs a match** — Metamod, CounterStrikeSharp, MatchZy, `EZPug.Core`, the SDK and
the cfg set on disk, `deletion_protection` on — and `EZPUG_IRON_DATHOST_TEMPLATE_SERVER_ID`
names it. `scripts/dathost-image.mjs` (PRD-02 T18) is what builds and refreshes it.

```bash
pnpm cs2:build                  # the artifacts, once — this script never downloads a plugin
pnpm dathost:image --dry-run    # what would change
pnpm dathost:image              # create or refresh; prints the id to paste into .env
pnpm dathost:image --check      # is the template what this checkout says it is?
```

**One build, two destinations.** The files it uploads are read out of
`ghcr.io/ezpug/ezpug-iron/cs2` — the same image `pnpm cs2:up` runs here and a node runs at
a venue — from `/opt/ezpug`, the directory the image's entrypoint overlays onto
`game/csgo`. `docker create` + `docker cp`, so nothing boots; the extraction is cached
per image id under `.cache/`. The mapping is the entrypoint's: `addons/**` and `cfg/**`
land where they are, `gamemodes/<id>/cfg/**` lands in `cfg/`, and the gamemode *manifests*
are not uploaded at all — they travel over the link inside the assignment. Roughly 510
files and 165 MB on a first build; every version comes from `docker/cs2/Dockerfile`, whose
numbers `docs/pins.md` copies and `pnpm lint` keeps honest. If the image is older than a
pin bump, the plugins' own `build.json` says so and the script stops before touching the
account.

**A second run is nearly free.** The last file written is `ezpug-image.json` at the game
root: the pins, the git revision the plugins were built from, and a sha-256 per file. A
refresh uploads only what the hash (or the file listing, for something edited in the
control panel) says has moved, then `sync-files` — **always last**, because `duplicate`
copies the API's *cache*, and an upload without a sync is a template that clones
yesterday's plugin, which looks exactly like a plugin bug. The one edit neither a hash
nor a listing can see is one that kept the byte count exactly; `--force` re-uploads
everything and is the answer to "I do not trust what is on it".

**What it enforces on the template**, each with a consequence: `deletion_protection` on
(it is the image, and it is also what stands between a misconfigured deployment's reaper
and a rebuild from scratch); `autostop` and `reboot_on_crash` off (the reaper is ours, a
crash is a `server_lost` we want to see); Dathost's *managed* Metamod off (ours is in the
image, pinned and checksummed — two loaders are one too many); GOTV on (the provider reads
the relay off a clone and never turns one on); and **no GSLT**, ever, because a token is
one per running server and every clone would inherit the template's. `cs2_settings.slots`
is set on create (`--slots`, default 12) and left alone afterwards: on a pay-as-you-go
account the slot count is part of `cost_per_hour`, and the ledger snapshots that at
allocate.

**It refuses what is not the template.** Every write is preceded by a `GET` and a check of
the `user_data` marker — a server carrying a match's tag, a clone of the template, or
anything unmarked is refused by name (`--adopt` claims one deliberately), and a template
that is currently *on* is refused unless `--force`. The account's password is read from
the environment only, never from a flag.

**`gameinfo.gi`.** Metamod loads because that file says so, and a game update rewrites it.
In the container the entrypoint re-checks it every boot; on Dathost nothing does, so the
script adds the loader line when it is missing and `--check` goes red when it has gone —
if a whole fleet suddenly boots with no plugins, that is the first thing to look at.

**The tests.** `providers/dathost/image-script.test.ts` runs the script against the fake
Dathost (T15) with a hand-written artifact tree: the dry run, the create, idempotence, the
refusals, `--check` red on a drifted file, pin, setting or `gameinfo.gi`, and — the one
that matters — a `duplicate` after the build whose clone carries the plugin.

### The live smoke (`pnpm dathost:smoke`)

The one command in this repo that spends money. Everything else about Dathost — the
provider's every verb, the template script, the fault suite — runs against the fake vendor
(`providers/dathost/fake.ts`), which is a *reading* of the vendor's OpenAPI, and a reading
can be wrong. This is what finds out:

```bash
pnpm dathost:smoke            # against $EZPUG_IRON_BASE_URL, with the account in .env
pnpm dathost:smoke --json     # the summary and nothing else, for a script
pnpm dathost:smoke --help
```

Nine steps, in this order, and the order is the point:

1. `GET /account` — the credentials are the credentials.
2. `dathost-image --check` — the template is what this tree builds (`--no-image-check`
   skips it; it needs docker or a `--tree`).
3. The orchestrator answers and its fleet lists a `dathost` provider that is not drained.
4. The account is counted **before**, so a stray afterwards is attributable.
5. One match is created with `requirements.provider: dathost` — not `lan`, not `simulated`,
   this provider and no other, so a box that also has nodes cannot answer it.
6. It reaches `ready`, which happens only when the clone booted, the plugin dialled the
   link out of Düsseldorf and said `server_ready`. This is the step the round is aimed at.
7. `ezpug_status` goes down that link as an `rcon` command and its answer comes back, so
   the link is proven in both directions.
8. The connect facts and the GOTV relay are read off the match.
9. The server is released — and **then** the ledger row is checked closed and the account
   is counted again.

**The money.** Exactly one server is ever allocated; the release is a `finally`; the run is
bounded by `--budget-minutes` (default 60, the PRD's one server-hour) and the run's own key
by `--budget-cents` (default 500) and one concurrent server; the match carries
`ttlMinutes: 60` so the reaper takes the box back even if this process is killed. If a
clone is still on the account when the run ends, the script deletes it itself, says so, and
exits non-zero — a live test that leaves a server running is a P1.

Nothing it prints is a secret: the summary carries the connect host and port and
`passwordSet: true`, never the password, never the API key, never the server token. The run
mints its own key and revokes it as its last act.

**The lane.** `apps/orchestrator/src/dathost.extended.test.ts` runs the script and asserts
the summary; it is skipped with a printed reason unless `EZPUG_DATHOST_TESTS` is set, and
`EZPUG_DATHOST_TESTS=required` turns a missing account or a missing orchestrator into a red
run instead of a skip. It is never set by `pnpm verify:extended` by default — it costs real
euros. **The plugin dials the orchestrator from a datacentre**, so the lane needs an
orchestrator the internet can reach: `EZPUG_IRON_BASE_URL=https://gs.ezpug.com` after T35,
or a tunnel to a dev one before it. Against a remote orchestrator, pass `--key` (or set
`EZPUG_IRON_ADMIN_KEY`); on this box the script mints one from the database itself.

**Rehearsed offline.** `providers/dathost/smoke-script.test.ts` runs all nine steps in
`pnpm verify` against the fake vendor, a real provider, a real orchestrator, the real link
on a real port and the fake server dialling in — including the release after a failure, the
stray clone the provider could not delete, and a grep of the summary for every secret the
run knows.

## The GSLT pool

A CS2 server started without a **Steam Game Server Login Token** logs in anonymously and
prints, in its own console, that *connections will be restricted to LAN only*. So every
**rented** server needs one and a **node** at a venue needs none — which is why only the
Dathost provider holds the pool's seam, and why a dev box that only ever runs `sim` and
`nodes` never notices the pool is empty.

`gslt_tokens` is the pool: one row per Steam game server account this deployment owns,
holding the account's SteamID, its login token, and the ledger row currently using it.

**Configure it** with `STEAM_WEB_API_KEY` (`EZPUG_IRON_STEAM_WEB_API_KEY` is the prefixed
alias) — a Steam Web API key from <https://steamcommunity.com/dev/apikey> belonging to an
account that may manage game servers. `EZPUG_IRON_GSLT_POOL_MAX` (default 16) is the
ceiling. On a developer's box, `EZPUG_IRON_STEAM_FAKE_TOKENS=true` mints against the
in-process fake Steam instead, so the leasing is exercised without a partner key; it is
refused under `NODE_ENV=production`, and so is setting it beside a real key.

**How a token moves.** `allocate` asks the pool for a lease keyed by the **ledger row**;
the pool hands back a free account's token, or mints one from `IGameServersService`
`CreateAccount` when it is short of the ceiling, and the Dathost provider writes it into
`cs2_settings.steam_game_server_login_token` on the clone. `deallocate` gives the lease
back. The row's `gslt_token_id` says which account it holds, so "which server has which
token" is one query.

The rules, each with a test in `gslt/pool.test.ts`:

- **One token, one running server.** Valve evicts the first login when a token appears
  twice, so a lease is a single atomic claim and the pool hands out the *longest-idle*
  free account — the one whose last holder has had the most time to disappear.
- **The ceiling is a wall, not a target.** Nothing is minted until a lease asks for a
  token there is none of; the pool grows to peak concurrency and stops. `CreateAccount`
  is never retried — a repeated create is a Steam account nobody tracks.
- **A dry pool is a warning, never a refusal.** The lease answers nothing, the provider
  says "LAN connections only" once in the log, and the match still runs. Read
  `GET /v1/fleet/gslt` (`fleet` scope: `{ total, inUse }`, never a token) and raise the
  ceiling, or find out why nothing is releasing.
- **A lost server's token is reset.** A box that vanished before it could be stopped may
  still be logged in with its token, so the release runs `ResetLoginToken` before the
  account goes back into the pool. A reset that fails is logged and the account is kept:
  the old token still works.
- **A crash cannot leak a lease.** Every five minutes the sweep frees each lease whose
  ledger row has closed or gone, then reconciles with `GetAccountList`: an account Steam
  no longer knows is dropped, one Steam let expire is reset, one carrying this
  deployment's memo (`ezpug-iron <public host>`) that this database does not know is
  adopted. Two deployments may share a Steam key; neither ever touches the other's memo.

**When a Saturday goes wrong**: servers boot but nobody outside the datacentre can join →
check `GET /v1/fleet/gslt` first. `total: 0` means no key, a wrong key (the log says
`STEAM_WEB_API_KEY is wrong`) or a ceiling of zero; `inUse == total` means the pool is
saturated — raise `EZPUG_IRON_GSLT_POOL_MAX` and restart, and the next allocation mints.

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

## Demos

The orchestrator never stores a demo byte (decision 10). What it does is wait for one and
relay a fact about it.

**On the server.** For a `records: demo` gamemode MatchZy records its own flow's demo into
`game/csgo/MatchZy/` and stops a `tv_delay` after the last round (GOTV records the
*delayed* broadcast, so stopping on the win panel would cut the last rounds off the file);
for any other flow the core plugin runs `tv_record` and `tv_stoprecord` itself. **The
upload is always the core plugin's**, because MatchZy's own uploader POSTs a multipart form
and a presigned PUT will not take one. Nothing in CS2 says when a `.dem` is finished, so
from the win panel on the plugin watches the newest one until its length has stopped moving
for fifteen seconds, then hashes it, streams it at the request's `demoUploadUrl` (retried
four times on a backoff) and emits `demo_available` with its size and hash. The plugin
gives up four minutes after the win panel.

**In the orchestrator.** A `demo_available` carrying a hash becomes `demo.uploaded` with
the object key read out of the presigned URL's path. And because `series_end` would
otherwise end the match — releasing the very server the demo is still being written on —
**a match that records a demo stays `live` past `series_end`** until the demo is announced
or the demo window (`deadlines.demoMs`, six minutes) runs out. Either way `match.ended`
carries `demo: { uploaded, skipped? }`, so "there is no demo" is always a reason and never
a silence.

When a demo does not arrive, `match.ended.demo.skipped` says which of these it was:

| `skipped` | What happened |
| --------- | ------------- |
| `no_upload_url` | the request carried no `callbacks.demoUploadUrl` |
| `not_recorded` | the gamemode's `records` is not `demo` |
| `no_demo` | recording was on and nothing was ever announced — the match never went live, the server was lost with the file on it, or GOTV was evicted before it wrote one (see `bot_quota_mode` above) |
| `upload_failed` | the server found its demo and the storage refused it; the bytes are still on the server, and the orchestrator's log says what the plugin was told |

A presigned URL that has expired by the time the demo is finished is an `upload_failed`:
the demo lands a couple of minutes after the last round, so mint the PUT with hours of
validity, not minutes.

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
pnpm iron:match --write-fixtures                # 15-25 minutes, one CS2 container
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
- **`bot_quota_mode` decides whether the match records a demo, and whether the bots play
  at all.** The engine counts the GOTV client as one of the bots it may evict, and the
  mode in force decides what happens to it: measured on this box against CS2 1.41.7.8, a
  `bot_quota` that *drops* while bots are standing kicks SourceTV along with them under
  `normal` and under `fill`, and CS2 will not bring SourceTV back without a level change —
  so the map records no demo at all. Under `competitive`, the mode
  `gamemode_competitive.cfg` sets at every map load, the purge spares GOTV — but those
  bots never fire a shot: ten of them played seven rounds with no kills and no damage
  between them, every round to the CT side on the clock, so the map cannot be decided and
  no `series_end` ever comes. `gamemodes/pug/cfg/ezpug/pug.cfg` therefore puts the server
  in `normal` while the quota is zero (behind a `bot_kick`, because a cfg is one frame and
  the eviction pass runs at the end of it), and the match's own `bot_quota` only ever goes
  up. The measurement is in that file; PRD-02 T21a is where it was made. The request's own
  `bot_quota` arrives a beat after that cfg and not inside its frame, which is what makes
  it a change at all (`GamemodeLoader.CvarSettleMs`, PRD-02 T22a) — so for every flow but
  `matchzy` the bots are simply standing when the map is up, and the script asks for
  nothing.
- **The bots have to be standing when warmup ends, and MatchZy's `live.cfg` opens with a
  `bot_quota 0`.** Those two are in tension — the drop is exactly the one that takes GOTV
  — so the script empties the server *before* `css_start`, which makes that drop a
  no-change and a no-op, and asks for its bots once the match is live and the only way
  left is up. The cost is that `live.cfg`'s own `mp_warmup_end` runs on an empty server
  and ends nothing, so the script sends `mp_warmup_end` itself a poll later; outside
  warmup it does nothing, which is what makes it safe to send.
- **Bots draw.** Ten of them split a four-round map 2–2 more often than they win it, and
  the overtime that follows is most of the difference between a twelve-minute run and a
  twenty-five-minute one. The script's force-end wall is thirty-five minutes for that
  reason and not because a match should take that long: a match ended in the middle cuts
  GOTV off mid-file and the run records no demo, which is the one thing it exists to
  produce.
- **A drawn map in a Bo1 does not end the series.** With an even `mp_maxrounds` and no
  overtime a map can finish 2–2; MatchZy's `HandleMatchEnd` then reports `remainingMaps: 1`
  and replays the same map instead of sending `series_end`. The script asks for overtime by
  default; `--no-overtime` is there for whoever wants to watch that happen.

**The trace path is relative to whoever resolves it.** The orchestrator resolves
`EZPUG_IRON_TRACE_FILE` against the directory it was started in, and every way of starting
it here (`pnpm dev`, `pnpm --filter @ezpug/orchestrator start`) runs in
`apps/orchestrator/`; `pnpm iron:match` runs in the repo root. The script therefore looks in
both, repo root first, and **stops** when it finds a trace in neither — a run that played a
whole match and then wrote an empty conversation over a good fixture is worse than no run.
An absolute path in `.env` avoids the question entirely.

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

## `ezpug-iron`, the command (`pnpm iron`)

Every lever the orchestrator has, from a terminal (PRD-02 T33). `apps/cli` is one call on
the typed client generated from `@ezpug/match-api`'s route table per verb — so a lever
here is a route the platform can also pull, and a capability that is not a route does not
exist here either. There is no admin surface that skips the API.

```sh
pnpm iron --help                       # the map
pnpm iron keys create --name platform --scopes matches,fleet --webhook-secret whsec-2026-09
pnpm iron gamemodes list               # what this orchestrator will play
pnpm iron matches create --file req.json
pnpm iron matches watch <matchId>      # the live stream until it closes
pnpm iron servers list --all --since 2026-09-07T18:00:00Z   # what tonight cost
pnpm iron nodes enrol-token --id saarlan-1 --region eu-central
pnpm iron nodes remove saarlan-1        # un-enrol at the end of the venue night
pnpm iron budget
pnpm iron dathost image --check
```

| Group | Verbs |
| ----- | ----- |
| `keys` | `create`, `list`, `revoke` — the `admin` scope's own. The mint's flags and defaults are `keys:mint`'s, so the two doors agree. `--webhook-secret <id>` (repeatable, up to 8) registers a webhook secret on the new key: the flag takes the **id**, the secret is drawn here and shown once. |
| `gamemodes` | `list` — the catalog, titles in DE and EN (`--locale` narrows to one). |
| `matches` | `create`, `list`, `get`, `watch`, `cancel`, `command` |
| `servers` | `list` (`--all` reads the ledger, closed rows included), `kill`, `console` |
| `nodes` | `enrol-token`, `list`, `drain` (`--undrain`), `remove` (un-enrol) |
| `budget` | the calling key's three ceilings and this month against them |
| `dathost` | `image --check` and `image --build` — a thin wrapper over `scripts/dathost-image.mjs` |

**Configuration is two variables**, both in `.env.example`. `EZPUG_IRON_API_KEY` is the
key, read from the environment and **never** from a flag: a flag lands in the shell's
history file and in `/proc/<pid>/cmdline` while the command runs.
`EZPUG_IRON_CLI_URL` points it at an orchestrator (falling back to `EZPUG_IRON_BASE_URL`,
then to `http://127.0.0.1:3430`); `--url` beats both, which is how one terminal talks to
the dev world and to `gs.ezpug.com` in the same minute.

**`--json` on everything.** The human channel is a table or a paragraph; the machine
channel is one JSON document — one per *line* for `matches watch`, which is a stream, and
under `--json` that pipe carries stream frames and nothing else, so `| jq` never meets a
line that is not a frame. Note `pnpm --silent iron … --json` when piping: without
`--silent`, pnpm's own banner is on stdout too.

```sh
pnpm --silent iron servers list --json | jq '.servers[] | .provider'
pnpm --silent iron matches watch <id> --json | jq -c 'select(.type == "event") | .envelope.payload.type'
```

**Secrets leave by one door, once.** `keys create` and `nodes enrol-token` mint; both
print the secret at the mint and nowhere else, and every other line the command writes is
run through a redactor first, so an `ezi*_` token that reaches a line by accident comes
out as its prefix and an ellipsis. No route serves a secret again — lose one and rotate.

**Exit codes** an operator can branch on: `0` it worked, `1` the orchestrator said no (an
error code from the Match API's closed set, or a command the server *rejected* — the call
was a 200 and the command still did not happen), `64` the line was wrong, `69` nothing
answered. A refusal is never a `69`: "budget exceeded" is an answer, and a script that
retried it would only waste the ceiling that just refused it.

`dathost image` is the one verb that is not an HTTP call: it wraps the T18 script, which
reads `docker/cs2/Dockerfile` for its pins and extracts artifacts out of the CS2 image, so
it only means anything inside a checkout. Run from anywhere else it says so and exits
`69`; every other verb works from anywhere.

**Three edges T37's rehearsal hit, and what T37b did about them.** All three were the
terminal's rather than the API's, and all three cost a venue operator time.

- **A relative `--file` is resolved where you typed it.** `pnpm iron` is `pnpm --filter
  @ezpug/cli start`, so the command runs with `apps/cli` as its working directory and
  `--file request.json` used to look for `apps/cli/request.json`. pnpm sets `INIT_CWD` to
  the directory the command was typed in, and that is what the CLI resolves a relative path
  against; an installed `ezpug-iron` has no `INIT_CWD` and its `process.cwd()` already is
  that directory. A path that is not there is refused with the **absolute** path it looked
  for, so "which file did it want" is in the line itself.
- **`keys create --webhook-secret <id>`** registers a webhook secret on the key being
  minted — repeat it for up to eight. Every match request must name one
  (`callbacks.webhookSecretId`), so before this the one key a venue actually needs could
  not be minted from a terminal at all. The flag takes the **id**; the secret behind it is
  drawn from the CSPRNG here (`eziw_` and 43 characters, the same grammar as every other
  secret in this system) and shown once beside the key's own. A client that already owns
  its secret still registers it through `PUT /v1/keys/:keyId/webhook-secrets`, which is
  the door for rotating one without a gap.
- **`nodes remove <nodeId>`** un-enrols a node (`DELETE /v1/fleet/nodes/:id`): the token is
  revoked, the agent's socket is closed in force and the row is gone. What it does *not*
  do is stop anything that is playing — those containers belong to the ledger, not to the
  agent — so `drain` first, and `docker stop` the agent on the venue box afterwards or its
  restart policy dials it straight back into a refusal (`docs/nodes.md`).

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
health tile draws; `GET /v1/fleet/ledger?since=` is the same money row by row. `since` is
the window a bill is asked over, not the window a row was born in: every row still open,
plus every row released at or after it. "What did tonight cost" is one query —

```sh
curl -sS -H "authorization: Bearer $FLEET_KEY" \
  "https://gs.ezpug.com/v1/fleet/ledger?since=2026-09-06T18:00:00Z&limit=100" \
  | jq '[.items[].cost.accruedCents] | add'
```

— and a server that started before the window and is still running is in it, because it
is still being paid for.

**Warnings.** When a key crosses 80 % or 95 % of a ceiling that has a ratio (the
concurrent and monthly ones), `fleet.budget_threshold` is appended to each of that key's
open matches — so it reaches the client on the webhook it already listens to, or on the
key's fleet webhook where one is registered. A crossing
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
(the stream route carries a player token there; the widget socket never does), status,
duration, the key's public
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
| `matches` | the Match API resource as a row, plus the deployment running it (T21c), the request whole, its hash (the `clientMatchId` conflict check), when the state was entered (deadlines re-arm from it), and `webhooks_stopped_at` (a `410`) | the match machine (T3) |
| `match_events` | the per-match durable log: `(match, seq)` unique, the payload, the `delivery_id`; what the events route replays and the webhooks carry | the machine, the link (T6) |
| `webhook_deliveries` | one row per envelope: attempts, next try on the clock, status | the webhook worker (T3) |
| `match_commands` | commands by `correlationId`, with their result — a retry answers the first result across a restart | commands (T3) |
| `servers` | **the ledger**: one row per server ever asked for — the deployment that opened it (T21c), provider, handle, node, match, key, state, address (never a password), hourly cost, the GSLT lease, the link's facts (`last_seen_at`, versions, acked seq), the RCON audit (T20), allocated / released / expires | the provisioning walk and the reaper (T3), the link (T6) |
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
contract. An RCON password is *not* stored: the provider knows it — Dathost answers it
from the server's settings, and the `nodes` provider mints one per container, delivers it
in the container's environment and keeps it in memory for the life of the process (T20).
A restart therefore loses the password of every container it adopts, and RCON on such a
server honestly says there is no door rather than guessing.

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

**Fifty matches with fault injection** (`faults.extended.test.ts`) is the tier that asks
what a bad night leaves behind. One world — the orchestrator over memory on a fake clock,
`/link` and `/node` on a real port, the simulator, the fake Dathost and a fake node behind
it — plays fifty matches from a deck one seed shuffles: an allocation refused, a boot that
never ends, a crash with a restorable backup and one without, duplicate and out-of-order
link frames, an agent that disconnects mid-match, the vendor's API down for a minute, a
webhook endpoint that fails ten times, a key at its budget. Then it asserts the wreckage:
every ledger row closed, every provider listing nothing of ours, every match terminal with
a reason, the events route replaying every webhook the endpoint accepted, no GSLT still
leased, and each key's month equal to the sum of its closed rows. It needs no world of its
own, so it runs in `pnpm verify` too; `pnpm faults --seed <seed>` replays a different night
and is how a red run is reproduced — the summary names the seed either way.

The **`EZPUG_CS2_TESTS` lane** is the third tier and is nobody's default: ten minutes, a
CS2 container and a node on this box (see "One real match, recorded"). `pnpm verify` never
runs it, `pnpm verify:extended` runs it only when the variable is set, and
`EZPUG_CS2_TESTS=required` makes a missing dev node red instead of a printed skip.
