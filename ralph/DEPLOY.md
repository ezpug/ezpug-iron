# Deploying EZPug Iron

The orchestrator runs on one box — the same machine this repo is checked out on, the same
machine the platform runs on — and is served at **`gs.ezpug.com`** through the Traefik
that already fronts everything else there. A deploy is `scripts/deploy.sh`, run from
`/root/ezpug-iron`.

```bash
pnpm verify && pnpm verify:extended   # the gate — the deploy does not run it for you
./scripts/deploy.sh
```

That is the whole happy path. Everything below is what to do when it is not happy.

There is no CS2 on this box in production. Capacity is Dathost (decision 7) and the
`ezpug-node` agents at a venue (`docs/nodes.md`); this stack is one Node process, its
Postgres and its Redis.

## What a deploy consists of

| step | what happens |
| ---- | ------------ |
| `preflight` | tooling, `.env.production`, no placeholders, no dev door, `NODE_ENV=production`, the host/port drift against the route file, the database and Redis naming compose services, the Dathost trio if `dathost` is a provider, a writable backup directory outside the checkout |
| `build` | the orchestrator image from this checkout; the outgoing one becomes `:previous`. With `EZPUG_IRON_IMAGE` set it **pulls** that tag instead and builds nothing |
| `migrate` | a dump first, then pending migrations, on their own, before any running container is replaced |
| `up` | compose starts/replaces the stack and waits for healthy |
| `routes` | `docker/traefik/ezpug-iron.yml` → `/opt/traefik/routes/ezpug-iron.yml` (only if it differs), then waits for the host to serve a trusted certificate |
| `smoke` | `/healthz` on the bridge and over public TLS, the http→https redirect, `GET /v1/capacity` with the operator key and without one |

Each is also a subcommand — `./scripts/deploy.sh smoke` after a Traefik change,
`./scripts/deploy.sh migrate` when only the schema moved. Every step is idempotent, so
running the whole thing twice in a row is a no-op the second time and re-running a failed
deploy is the normal way to finish it. Two more subcommands are not deploy steps at all:
`backup` and `key`.

**A failed migration is the safe failure.** It exits non-zero before the orchestrator
container is touched, so the previous release keeps serving. Fix it and re-run.

## The first deploy on a fresh box

1. `cp .env.production.example .env.production` and fill in every `CHANGE_ME`. The
   Postgres password is `openssl rand -base64 24 | tr -d '=+/'`; the Dathost trio and the
   Steam Web API key are the owner's. `chmod 600 .env.production` — it is the one file on
   the box that holds them.
2. `./scripts/deploy.sh` — it will get all the way to the smoke and fail one check:
   `GET /v1/capacity` has no key yet.
3. Mint the deployment's **first** API key:

   ```bash
   ./scripts/deploy.sh key --name operator --scopes admin,matches,fleet \
     --max-concurrent 4 --max-lifetime-minutes 240 --monthly-cents 0
   ```

   The secret is printed once, to stdout, and never again. Paste it into
   `.env.production` as `EZPUG_IRON_API_KEY`.
4. `./scripts/deploy.sh smoke` — green.

**Why that step exists at all.** `EZPUG_IRON_BOOTSTRAP_API_KEY` — the environment-adopted
key another project's compose hands the dev image — is refused under `NODE_ENV=production`
on purpose: a key nobody minted is a key nobody can rotate. And `ezpug-iron keys create`
needs an `admin` key to already exist. So the first key comes from the image
(`node dist/mint-key.mjs`, which is what `deploy.sh key` runs) and **every key after it
comes from the CLI**:

```bash
EZPUG_IRON_CLI_URL=https://gs.ezpug.com pnpm iron keys create \
  --name platform --scopes matches,fleet --max-concurrent 2 --monthly-cents 5000
```

The platform gets its own key with its own budget; the operator's key is not shared with
anybody. Neither ever appears in a flag, a log line or a commit.

## What is on the box afterwards

| container | what | published |
| --------- | ---- | --------- |
| `ezpug-iron-prod-orchestrator` | the service, `:3430` inside | `172.17.0.1:3431` — Traefik only |
| `ezpug-iron-prod-postgres` | the ledger, the keys, the durable log | nothing |
| `ezpug-iron-prod-redis` | the stream hub's fan-out | nothing |
| `ezpug-iron-prod-migrate` | ran once, exited 0 | — |

```bash
pnpm prod:ps            # what is running
pnpm prod:logs          # follow
pnpm prod:down          # stop; the volumes stay
```

Volumes: `ezpug-iron_postgres-data`, `ezpug-iron_redis-data`. The compose project is
`ezpug-iron`; the **dev** world is `ezpug-iron-dev` and shares nothing with it — not a
name, not a volume, not a port.

`/opt/traefik/routes/ezpug-iron.yml` is the one path outside this repo the deploy writes.
Traefik watches that directory, so the copy is the reload.

## Backups

```bash
./scripts/deploy.sh backup    # dump now, rotate, list
```

Dumps land on the **host** at `EZPUG_IRON_BACKUP_DIR` (default `/var/backups/ezpug-iron`),
outside the checkout and outside the compose volumes, because `docker compose down -v` is
the one command that destroys this ledger. `EZPUG_IRON_BACKUP_KEEP` (default 14) is how
many are kept; the name is an ISO-8601 UTC timestamp, so newest-first is name order.
Every migration takes one first.

**A dump of this database is a credential.** It holds the webhook secrets and the GSLT
login tokens in clear — everything else is hashed (`docs/operations.md`, "What this
database holds in clear, and why"). The files are written `0600`. Treat them like the
`.env.production` beside them.

Restoring one:

```bash
gunzip -c /var/backups/ezpug-iron/ezpug-iron-<stamp>.sql.gz \
  | docker compose -f compose.prod.yaml --env-file .env.production \
      exec -T postgres psql -U ezpug_iron -d ezpug_iron
```

Restore into a scratch database first and count what came back before you point the
orchestrator at it.

## Rollback

### A bad release

```bash
./scripts/deploy.sh rollback
```

`:previous` becomes `:latest`, compose replaces the container, the smoke runs again. It is
**images only**: migrations are additive-safe by rule (CLAUDE.md), so the previous release
can read the newer schema — which is exactly why there is no down-migration to run. Fix
forward soon, because the next `build` makes *this* image `:previous`.

When `.env.production` pins `EZPUG_IRON_IMAGE` to a published tag, `rollback` refuses and
says so: rolling back is naming the previous tag on that line and re-deploying, which is
the whole point of pinning one.

### A bad route

Traefik's file provider watches the directory and the deploy leaves the previous file
beside the new one as `ezpug-iron.yml.bak-<stamp>`:

```bash
cp /opt/traefik/routes/ezpug-iron.yml.bak-<stamp> /opt/traefik/routes/ezpug-iron.yml
```

Deleting `/opt/traefik/routes/ezpug-iron.yml` takes `gs.ezpug.com` off the internet
entirely and leaves the container running on the bridge — which is the right move if the
front door is what is wrong.

## When it is down on a Saturday

1. `curl -sS http://172.17.0.1:3431/healthz` — the container, past Traefik and past DNS.
   It names the failing rail: `database`, `redis`, or a provider by id.
2. Green there and red on `https://gs.ezpug.com/healthz` is Traefik or the certificate.
   `docker logs traefik --tail 50`, and check `/opt/traefik/routes/ezpug-iron.yml` is
   still the repo's copy.
3. Red there too: `pnpm prod:logs`. The boot pings Postgres and Redis before it listens,
   so a wrong URL is a boot failure with the variable's name in the message, never a
   first-request surprise.
4. **A live match survives a restart of this process** — the servers reconnect on their
   own link and the machine resumes from the ledger — but nothing is served while it is
   down. `docker compose -f compose.prod.yaml --env-file .env.production restart
   orchestrator` is cheaper than a redeploy and is the first thing to try.
5. A server that outlives its match is money. `pnpm iron servers list` and the reaper
   (`docs/operations.md`) are how that gets found and closed.

## The platform, on the same box

The platform (`/root/ezpug`) reaches this orchestrator over **public TLS like any other
client** — `https://gs.ezpug.com` with its own API key — and never through a docker
network (decision 11). Its dev world pulls the orchestrator *image* and runs its own copy
in `sim` mode on `127.0.0.1:3431`; that is a different process, a different database and a
different port binding from this one, and the two never meet.

When this repo changes the Match API, the platform learns by bumping its pin
(`docs/pins.md`, `@ezpug/match-api`), not by anything this deploy does.
