# Nodes

`ezpug-node` turns a docker host into EZPug Iron capacity (`docs/decisions.md` 23): a box
at the venue, a spare machine in a rack, this dev box. It enrols once, dials the
orchestrator on **the node link** (`/node`, `packages/protocol`), and from then on starts
and stops CS2 server containers from the one server image when the orchestrator says so.
The servers it starts open server links of their own; the node link never carries a match,
it carries containers. To the orchestrator a node is a provider like Dathost with a price
of zero (T12), and during a live event a `lan` request lands on a node first.

This is the runbook: install on a venue box in five commands, then what the agent does and
what to do when something is wrong. `apps/node` is the code; `ezpug-node --help` says the
same in twenty lines.

## Install on a venue box

Five commands, on a Debian or Ubuntu box with the tags `docs/pins.md` names for the two
images (`<tag>` below; until the first publish, `pnpm node:build` and `pnpm cs2:build`
make `:dev` tags on this box).

```sh
# 1. docker
curl -fsSL https://get.docker.com | sh

# 2. the game, once, into a volume (~67 GB installed from a ~71 GB download; hours on a slow line)
docker run --rm -v cs2-data:/serverdata/serverfiles \
  --entrypoint install-game.sh ghcr.io/ezpug/ezpug-iron/cs2:<tag>

# 3. enrol — the token comes from the platform's admin console (POST /v1/fleet/nodes) and is shown once
docker run --rm --network host \
  -v ezpug-node:/var/lib/ezpug-node \
  -v /var/run/docker.sock:/var/run/docker.sock --group-add "$(stat -c %g /var/run/docker.sock)" \
  -e EZPUG_NODE_ORCHESTRATOR_URL=https://gs.ezpug.com \
  -e EZPUG_NODE_IMAGE=ghcr.io/ezpug/ezpug-iron/cs2:<tag> \
  -e EZPUG_NODE_GAME_VOLUME=cs2-data \
  -e EZPUG_NODE_LABELS=venue=saarlan,tickrate=128 \
  ghcr.io/ezpug/ezpug-iron/node:<tag> enrol <token>

# 4. run (the same mounts and environment; `run` is the image's default command)
docker run -d --name ezpug-node --restart unless-stopped --network host \
  -v ezpug-node:/var/lib/ezpug-node \
  -v /var/run/docker.sock:/var/run/docker.sock --group-add "$(stat -c %g /var/run/docker.sock)" \
  -e EZPUG_NODE_ORCHESTRATOR_URL=https://gs.ezpug.com \
  -e EZPUG_NODE_IMAGE=ghcr.io/ezpug/ezpug-iron/cs2:<tag> \
  -e EZPUG_NODE_GAME_VOLUME=cs2-data \
  -e EZPUG_NODE_LABELS=venue=saarlan,tickrate=128 \
  -e EZPUG_NODE_MAX_INSTANCES=2 -e EZPUG_NODE_WARM=1 \
  ghcr.io/ezpug/ezpug-iron/node:<tag>

# 5. look
docker exec ezpug-node node dist/main.mjs status
```

`docker ps` shows the agent `healthy` once the link is up (the image's `HEALTHCHECK` is
`ezpug-node health`: exit 0 iff a heartbeat went out within the last three intervals).
The venue's firewall has to let UDP in on the game and GOTV ports the orchestrator
assigns each server (`27415`/`27420` and up on this box); the agent itself opens no port.

Two things about that `docker run` line. `--network host` because the server containers
the agent starts use the host network anyway (a game server's clients read the address
out of its UDP packets, `compose.cs2.yaml` says why), and because on this box the
orchestrator is `127.0.0.1:3430`. `--group-add` because the docker socket is owned by the
host's `docker` group and the agent runs as uid 1000, not root — one file descriptor is
not a reason to run a daemon as root.

On this box, from the checkout, the same thing without the image is `pnpm node enrol
<token>` and `pnpm node run` with `.env` carrying the `EZPUG_NODE_*` lines from
`.env.example` (from T12, `pnpm dev:up` starts it beside the orchestrator).

## What the agent does

**Enrol once.** `ezpug-node enrol <token>` opens the node link with the one-time enrolment
token; the orchestrator answers `welcome` with the node's id and **the node token**, which
it never shows again (it stores only the hash, `node_enrolments` and `nodes` in the
orchestrator's schema). The agent writes both to `node.json` in `EZPUG_NODE_STATE_DIR`
(`0600`, in a `0700` directory, by rename so a crash mid-write leaves the old file) and
hangs up. The token is never printed — not by `enrol`, not by `status`, not in a log line
(every writer redacts anything shaped like one of the orchestrator's tokens). Enrolling
also checks docker and pulls the server image when it is absent, so a box with no docker
or no image fails at step 3, not on the first match.

**Say hello, keep dialling.** `ezpug-node run` reads the identity, adopts the containers a
previous agent left running (below), pulls the server image if it is not on the host, and
dials `/node`. The first frame is `hello`: the node token, the agent's version, `region`,
`lan`, the labels (`cores` filled in from the host when the operator set none), the
capacity (`maxInstances`, `warm`), the digest of the server image it holds, and every
instance it runs. `welcome` names the node, says whether it is drained, and sets the
heartbeat interval; a heartbeat goes out on it from then on. A lost socket, a refused
handshake (a draining orchestrator's 503), a `4005 replaced` or a `4012 shuttingDown`
are retried with backoff — one second doubling to thirty, reset by the next `welcome`.
`4001 unauthorized`, `4002 protocolMismatch`, `4003 malformed` and `4009 revoked` are
decisions: the agent stops and exits `2` saying what to do, because a revoked node
hammering the orchestrator every second helps nobody.

**Start, stop, drain.** A `start` frame is an instance spec — id, purpose (`warm` or
`match`), the image, the server id, **the server token**, the two ports, the environment
(the orchestrator's URL among it), the match where there is one. The agent runs one
container from it: the server image, on the host network, with the game volume at
`/serverdata/serverfiles` (and a checkout's `gamemodes/` read-only over the image's cfg
set when `EZPUG_NODE_GAMEMODES_DIR` names one), the spec's environment plus
`EZPUG_SERVER_TOKEN` and the two port variables the image's entrypoint reads, a tty so
`docker attach` is a real server console, and labels naming the node, the instance, its
purpose, server id, match and ports. The container's plugin dials the orchestrator with the
token and the server link takes over. `stop` stops it with `EZPUG_NODE_STOP_TIMEOUT`
seconds of grace and removes it; stopping what is already gone is nothing. `drain` lets
live matches finish and starts nothing; `undrain` takes work again; `welcome.drained` sets
the same switch after a reconnect.

**Every change is a snapshot.** Whenever an instance changes state the agent sends an
`instances` frame carrying every instance it runs — never a delta, so a lost frame is
superseded by the next and a reconnect's `hello` carries the same list. States are
docker's view: `starting` (created), `running`, `stopping`, `failed` with the reason.
The protocol has no "no" frame, so a `start` the agent will not honour becomes a `failed`
instance with the reason in `error`: past `EZPUG_NODE_MAX_INSTANCES`, on a port another
instance holds, while drained, before enrolment, for an image that cannot be pulled, or
because docker refused. A failed instance stays in the snapshot until the orchestrator
`stop`s it, which is idempotent by contract. Docker is polled every
`EZPUG_NODE_POLL_INTERVAL_MS`: a container that exited is `failed` with its exit code, a
container that vanished (`docker rm -f` by hand, a host that lost it) is `failed` and says
so. The orchestrator's ledger, not the node, is the truth about which server belongs to
which match; the node reports what docker says.

**The warm pool is the orchestrator's to fill.** `EZPUG_NODE_WARM` is advertised in
`hello` as `capacity.warm`, and the orchestrator sends `start` frames with `purpose: warm`
to keep that many idle servers dialled in ahead of demand, so a `lan` request is ready in
seconds rather than a boot. The node cannot start one itself: a warm instance is a server
with a server token, and only the orchestrator mints those.

**Restarting the agent restarts the agent.** Stopping it (SIGTERM, `docker stop`) closes
the link and leaves every container running; the orchestrator notices the node is gone
(T12's `fleet.node_disconnected`, critical while it holds a live match). A restarted agent
reads its containers back from their labels — the warm pool and the live matches are where
it left them — and carries them in its `hello`. A node that *dies* mid-match is a server
that dies mid-match: the orchestrator's recovery flow (T14) moves the match to the next
candidate with the newest backup, or ends it honestly.

## Configuration

Every name is `EZPUG_NODE_*`; `.env.example` documents each with its default. The ones an
operator sets:

| Variable | Default | What |
| -------- | ------- | ---- |
| `EZPUG_NODE_ORCHESTRATOR_URL` | — | the orchestrator's origin; the link is `ws(s)://…/node` from it |
| `EZPUG_NODE_STATE_DIR` | `~/.ezpug-node` (the image: `/var/lib/ezpug-node`) | `node.json` and `health.json` |
| `EZPUG_NODE_REGION` / `EZPUG_NODE_LAN` | `eu-central` / `true` | a region id the fleet groups by; whether this is LAN capacity (a venue box is) |
| `EZPUG_NODE_LABELS` | — | `key=value,…`; `cores` is filled in from the host |
| `EZPUG_NODE_MAX_INSTANCES` / `EZPUG_NODE_WARM` | `2` / `1` | servers at once; idle ones the orchestrator keeps started (never above the maximum) |
| `EZPUG_NODE_IMAGE` | `ghcr.io/ezpug/ezpug-iron/cs2:dev` | the server image this node holds and reports; pulled at boot when absent |
| `EZPUG_NODE_GAME_VOLUME` | `ezpug-iron-cs2_cs2-data` (this box's) | the docker volume with the game install |
| `EZPUG_NODE_GAMEMODES_DIR` | — | a checkout's `gamemodes/` to bind read-only over the image's cfg set |
| `EZPUG_NODE_DOCKER_SOCKET` | `/var/run/docker.sock` | the daemon |
| `EZPUG_NODE_POLL_INTERVAL_MS` / `EZPUG_NODE_STOP_TIMEOUT` | `2000` / `20` | how often docker is asked; seconds between SIGTERM and SIGKILL on stop |

## When something is wrong

- **`status` says `docker … not reachable`.** The socket is not mounted, or the agent's
  user is not in its group: check the `-v /var/run/docker.sock` and `--group-add` lines.
- **`status` says `image … not pulled yet`.** The box cannot reach ghcr, or the tag is
  wrong. `enrol` and `run` both try the pull and say why it failed.
- **The container is `unhealthy`.** No heartbeat for three intervals: the orchestrator is
  down or unreachable from the box, and the agent is redialling with backoff (`docker logs
  ezpug-node` shows the closes and the delays). Nothing to do on the node unless the URL is
  wrong.
- **The agent exited `2`.** The orchestrator refused the node for good: the token was
  revoked (`DELETE /v1/fleet/nodes/:id`), or this is a build that speaks another protocol.
  A revoked node is `ezpug-node forget` and a fresh enrolment token; a protocol mismatch
  is a newer image.
- **An instance is `failed`.** `status` shows the reason beside it: a port in use, an image
  that would not pull, a server that exited with a code (`docker logs ezpug-node-<id>` is
  the server's own boot log, `docker attach` its console). The orchestrator clears it with
  a `stop`; by hand, `docker rm -f ezpug-node-<id>` and the next poll notices.
- **Two nodes on one host.** Each enrols with its own token and its own state directory;
  the containers carry the node's id in a label, so neither adopts the other's. Give them
  different port ranges through the orchestrator (T12).
- **Moving a node to another orchestrator.** `run` refuses an identity enrolled against a
  different origin than `EZPUG_NODE_ORCHESTRATOR_URL` rather than silently reusing it:
  `forget`, then enrol again there.

## What is proven, and where

`apps/node/src/*.test.ts` run the real agent over a scripted `/node` endpoint on a real
socket and a fake docker on a fake clock: enrolment and the token on disk, hello and
welcome, heartbeats on the interval, backoff with its exact delays, the fatal codes,
start/stop/drain/undrain in order, snapshots on every change, capacity and port and
drained refusals, a container that exits and one that vanishes, adoption after a restart,
the CLI's every verb with no token in its output. `docker/dockerode.test.ts` proves the
one adapter that touches a daemon against the real one when this box has a socket, with a
tiny image and nothing left behind, and skips with a printed reason when it does not
(`EZPUG_NODE_DOCKER_TESTS=required` makes that red). The orchestrator's side of the link
and the `nodes` provider are T12's, and the first real `lan` match through a node is T13's.
