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

# 3. enrol — the token is shown once, from the platform's admin console or from
#    `ezpug-iron nodes enrol-token --id saarlan-1 --region eu-central` (`nodes remove` undoes it)
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

**`--restart unless-stopped` is right for a box that reboots and wrong for a node you have
un-enrolled.** The agent treats a revoked token as a decision — it stops dialling and exits
`2` — and no docker restart policy can tell that exit from a crash, so docker starts it
again and the decision is spent once per restart (eight dials in the first minute, measured
in T37's rehearsal, each refused at the handshake). A node removed at the orchestrator
(`ezpug-iron nodes remove <nodeId>`) is `docker stop ezpug-node` on the box; a box being
rebuilt is `ezpug-node forget` and a fresh enrolment token.

Two things about that `docker run` line. `--network host` because the server containers
the agent starts use the host network anyway (a game server's clients read the address
out of its UDP packets, `compose.cs2.yaml` says why), and because on this box the
orchestrator is `127.0.0.1:3430`. `--group-add` because the docker socket is owned by the
host's `docker` group and the agent runs as uid 1000, not root — one file descriptor is
not a reason to run a daemon as root.

On this box, from the checkout, `pnpm dev:node up` does the whole dance in one command —
mint a fleet key, `POST /v1/fleet/nodes`, enrol with the one-time token it hands back, run
the agent in the background — and `pnpm dev:up` calls it for you when the orchestrator is
already running and `EZPUG_IRON_PROVIDERS` names `nodes`. It is opt-in on purpose:
registering a real provider takes the simulator out of selection for every request that did
not ask for it (`providers/selection.ts`), which is right at a venue and wrong on an
offline afternoon. `pnpm dev:node down|status|logs|forget` are the rest of it; by hand it is
still `pnpm node enrol <token>` and `pnpm node run` with the `EZPUG_NODE_*` lines from
`.env.example`.

**Exactly one agent per node identity.** Two agents holding the same identity replace each
other's socket about once a second and never settle — one of them is always the newer
`hello` — and it is quiet enough to be missed: whichever socket won looks perfectly
healthy. On this box it cost two recorded runs (PRD-02 T21b), one buried under 1910
`fleet.node_disconnected` facts and the next answering `503 no_capable_server` against a
node that was doing nothing. So `up` **adopts** a live agent rather than starting a second
one (and stops all of them first if it ever finds more than one), `down` ends every agent
this checkout owns by process group rather than the one pid a file remembered, and
`status` counts them and says so in red when the answer is not one. Discovery is by
working directory (`apps/node`, which nothing else runs in), not by the pid file, because
the pid file held the outermost `pnpm` of three and killing it left the agent behind.

The orchestrator does not rely on any of that. A `hello` that replaces a socket younger
than one heartbeat is logged as the warning it is, a replaced socket says nothing on its
way out (the row belongs to whoever holds the identity now), and a close is only an
incident worth a `fleet.node_disconnected` after fifteen seconds of real silence — with
the node having to stay on the wire for the same fifteen before the next absence can raise
a second one. A flapping identity therefore costs one fact, not one per flap.

## What the orchestrator does with it

The other half of the story lives in the orchestrator (`docs/operations.md`, "Nodes"), and
these are the parts a venue operator can see:

- **`POST /v1/fleet/nodes`** writes the row and mints the **one-time** enrolment token,
  shown once. The node spends it on its first `hello` and is handed its long-lived node
  token in the `welcome`. So the secret that travels to the venue is worth nothing after
  the box has used it, and losing it costs one `POST`.
- **Re-enrolling an existing id** (the box is being rebuilt) mints a fresh one-time token
  *and* revokes the node token in force, hanging up on whatever is connected — two agents
  answering for one node would have the pool counting its capacity twice.
- **`DELETE /v1/fleet/nodes/:id`** revokes the token and closes the socket the agent holds
  (`4009`); every dial after that is refused `4001`, because the row the token named is
  gone — both are fatal to the agent, which stops dialling and says to run `forget` (and is
  restarted by docker anyway unless the container is stopped: see the restart policy above).
  The containers it was running keep running: they belong to the orchestrator's ledger, not
  to the agent. `ezpug-iron nodes remove <nodeId>` is the verb (T37b); the platform's
  console pulls the same route.
- **`POST …/drain`** stops new work landing here and tells the agent so; live matches
  finish. `…/undrain` takes it back.
- **Capacity.** A connected, undrained node offers what it can still run. One that is not
  answering offers **zero and stays in the list** — "the venue exists and is not answering"
  is a different fact from "there is no venue", and only the first one is actionable.
- **The warm pool.** `EZPUG_NODE_WARM` is what the node *advertises*; the orchestrator is
  what fills it, because a warm instance is a server with a server token and only the
  orchestrator mints those. Each warm container gets a ledger row of its own, charged to
  the key that enrolled the node at a price of zero, and dials `/link` and sits idle. When
  a match claims it, that row closes ("claimed by match …"), the match's own row takes over
  — charged to the match's key, which is what makes the concurrency ceiling count a node
  match — and the container keeps the credential it booted with. Nothing restarts, which is
  the entire point: a `lan` request is ready in seconds instead of a CS2 boot.
- **Ports.** The orchestrator assigns each instance the lowest free game/GOTV pair from
  `27415` up, per node, avoiding whatever the node already reports running.
- **The address players are told** is the `address` label when the node carries one
  (`EZPUG_NODE_LABELS=address=saarlan-1.example.com`), else the peer address the node's own
  socket came from. Set the label whenever the box is behind NAT from the orchestrator's
  point of view.
- **A node that drops off the wire** does not end its matches. Its containers keep running
  and the agent adopts them when it dials back; the orchestrator says
  `fleet.node_disconnected` into every match the node was holding and keeps listing those
  servers, so the reaper does not call a live match lost. Only after a minute away are its
  servers reported gone — and then the recovery window takes over: the match comes back on
  the next candidate with its newest backup (`docs/operations.md`, "Recovery"). A container
  that vanishes while the node is fine (a `docker kill`, an OOM) is the same story sooner:
  the plugin's link goes quiet, the orchestrator probes, the node's snapshot no longer
  lists the container, and a replacement is started — on this node when it has room.
  Measured on hardware in T37's rehearsal: **38 seconds** from the `docker kill` to a
  replacement whose plugin had already loaded the backup, and **30 seconds** to an honest
  `failed: server_lost` ("no server to restore onto") when the node was drained and the
  walk had nowhere to go. What that replacement does not do yet is *finish* the recovery on
  a `matchzy` flow — MatchZy plays on from the checkpoint without saying `going_live` a
  second time, so the window can only run out. The whole finding is under "What a rehearsal
  found" below.
- **A container that outlived its ledger row is stopped when the node dials back.** The
  other half of the same story: while the agent was away, the match it was holding failed,
  its row was closed, and the `stop` that closing sent had no socket to go out on. The
  orchestrator sweeps every snapshot a node sends and the ledger is the warrant — an
  **open** row of this deployment is adopted, a **closed** one is stopped (again on every
  later snapshot that still reports the container: a `stop` is idempotent, and re-sending
  it is the whole retry policy), and a container with **no row of this deployment at all**
  is never touched. That last one matters on a box that has served two worlds: `nodes` is
  not deployment-scoped, so a node re-enrolled from a dev orchestrator to production still
  runs the dev world's containers, and a restored database is a row that no longer exists.
  The orchestrator says so once in its log, names the deployment it was looking in, and
  leaves the container to you — it still occupies a slot of the node's capacity, so
  `docker rm -f ezpug-node-<id>` on the box is how it goes.

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
- **A container the orchestrator says belongs to no ledger row of its deployment.** It is
  from another world — the box was enrolled elsewhere before, or the orchestrator's
  database was restored past the row. Nothing will ever stop it and it holds a capacity
  slot: check `docker inspect` for the `com.ezpug.node.match-id` label, make sure nobody
  is playing on it, and `docker rm -f ezpug-node-<id>`.
- **Two nodes on one host.** Each enrols with its own token and its own state directory;
  the containers carry the node's id in a label, so neither adopts the other's. Give them
  different port ranges through the orchestrator (T12).
- **Moving a node to another orchestrator.** `run` refuses an identity enrolled against a
  different origin than `EZPUG_NODE_ORCHESTRATOR_URL` rather than silently reusing it:
  `forget`, then enrol again there.

## What a rehearsal found

One venue night, rehearsed on this box against the **production** orchestrator
(`wss://gs.ezpug.com/node`, real TLS, the `ghcr.io/ezpug/ezpug-iron/{node,cs2}:dev` images
of the day) with `ezpug-iron` as the only client — PRD-02 T37, 2026-09-07. A node
`saarlan-rehearsal`, `EZPUG_NODE_MAX_INSTANCES=2`, `EZPUG_NODE_WARM=0`, three `lan` pugs
with ten bots each. What it changed in this file is above; what it measured is here.

- **A `lan` request lands on the box in twenty seconds and plays.** `pending` →
  `configuring` → `ready` at +20 s (a cold CS2 boot out of the game volume), `live` at
  +40 s, `ended` six minutes later on four rounds with a side swap: 49 events on the
  match's own route, 50 signed webhook deliveries, four `backup_written`, the ledger row
  `released` at €0.00 and no container left behind. Nothing about the path was simulated
  except the venue.
- **A bots-only pug needs four RCON lines a venue never types.** `matchzy` is the one flow
  that waits for players to ready up, so a run with nobody in it goes
  `bot_kick; bot_quota 0` → `css_start` at `ready`, then `bot_quota <n>` → `mp_warmup_end`
  once live (the order is `scripts/iron-match.mjs`'s and its reasons are written there).
  Every other flow starts and fills itself. A real LAN night types none of this.
- **Drain does what it says.** `ezpug-iron nodes drain <id>` leaves the live match alone
  and refuses the next `lan` request `no_capable_server: no LAN node has free capacity`
  (exit 1); `nodes list` reads `drained yes` and the agent's own `status` agrees;
  `--undrain` takes work again.
- **A `docker kill` mid-match is answered in thirty seconds.** The plugin's link goes
  quiet, the node's snapshot drops the container, and the orchestrator says
  `match.recovering` ("silent for 30000 ms; nodes reports the server gone") with the newest
  backup's round. With the node undrained and room for a second instance the walk comes
  straight back to it: a new ledger row, a container on the next port pair, the plugin's
  `backup_restored`, and `match.server_ready` with `restored` — 38 seconds from the kill.
  With the node **drained** there is nowhere to go and the match is `failed: server_lost`
  ("no server to restore onto: no_capable_server") 30 seconds after the kill, which is the
  honest answer a venue with one box should get.
- **…and then the recovery did not finish on a `matchzy` flow.** The replacement loads the
  round backup and MatchZy resumes from it ("Loaded server checkpoint …, starting match
  with score 1:1 after round 2"), but it never says `going_live` a second time — that event
  belongs to the start of the series — and `going_live` was all that closed the
  orchestrator's window. So the match sat in `recovering` while the server was up and
  playing, the API's `unpause` was refused before it (`invalid_state — unpause only while
  live`) so only an `rcon` command could reach the pause MatchZy takes after a restore, and
  twenty minutes later the match was `failed: server_lost` — "no going_live within 1200000
  ms of the replacement being ready" — with both ledger rows closed and the container
  stopped. The ledger and the clean-up were right; the outcome was not. T14 proved this
  path against the simulator and a fake node, where the replacement's `going_live` is
  scripted; hardware is where the real MatchZy disagreed.
- **The same kill, after T37a: forty seconds from `docker kill` to `match.recovered`.**
  Rehearsed the same way (a `lan` `pug`, ten bots, the node against production, 2026-09-07):
  `match.recovering` at +30 s with `backupRound 2`, `match.allocated` in the same second,
  and at +40 s the replacement said all three of `backup_restored`, `server_ready` and —
  because the window now closes on the first sign of play (`docs/operations.md`,
  "Recovery") — `match.recovered` with `resumedFromRound 2`, in that order, the plugin's
  word having been held until the connect facts had gone out. MatchZy then resumed from the
  file by its own log ("Loaded server checkpoint …, starting match with score 1:0 after
  round 1") and paused itself (`matchzy_pause_after_restore`) — and **that pause was lifted
  by `ezpug-iron matches command <id> unpause`**, which is only legal because the match is
  `live` again from the restore rather than twenty minutes after it. The bots-only dance
  (`bot_kick; bot_quota 0` → `css_start` → `bot_quota 10` → `mp_warmup_end`) has to be typed
  a second time on the replacement, for the same reason it is typed at all: MatchZy waits
  for players to ready up and there are none. A venue with players types neither.
- **Un-enrolling is two close codes and one docker habit.** `DELETE /v1/fleet/nodes/:id`
  closes the socket in force with `4009`; every dial after it is `4001`, the row being gone.
  Both are fatal by design and the agent exits `2` — and `--restart unless-stopped` then
  starts it again, which is why the runbook now ends a removed node with `docker stop`.

## What is proven, and where

`apps/node/src/*.test.ts` run the real agent over a scripted `/node` endpoint on a real
socket and a fake docker on a fake clock: enrolment and the token on disk, hello and
welcome, heartbeats on the interval, backoff with its exact delays, the fatal codes,
start/stop/drain/undrain in order, snapshots on every change, capacity and port and
drained refusals, a container that exits and one that vanishes, adoption after a restart,
the CLI's every verb with no token in its output. `docker/dockerode.test.ts` proves the
one adapter that touches a daemon against the real one when this box has a socket, with a
tiny image and nothing left behind, and skips with a printed reason when it does not
(`EZPUG_NODE_DOCKER_TESTS=required` makes that red; an interrupted run's busybox containers
are swept at the *start* of the next one, by a suite label that is on this test's
containers and on nothing else — T37b, after three of them were found on this box 35 hours
old). The orchestrator's side of
the link and the `nodes` provider are T12's, the first real `lan` match through a node is
T13's, and the venue night against production — enrolment, a `lan` match, drain, a kill,
un-enrolment — is T37's, written up above.
