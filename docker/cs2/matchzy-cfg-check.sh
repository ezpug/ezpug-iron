#!/bin/sh
# What MatchZy-Enhanced may never have switched on in a cfg of ours (PRD-03 T2,
# docs/decisions.md 19). The fork reaches out by itself in ways stock MatchZy
# never did; each of those paths has one switch, and this is the list of them.
#
#   matchzy-cfg-check.sh <config.cfg> [<database.json>]
#
# Reads the cfg the way the engine does — a line is `name value`, `//` starts a
# comment, the last line that sets a name wins — and exits 1 naming every
# switch that is on. The image build runs it over the file as it ships (the
# pinned release's config.cfg with `cfg/MatchZy/ezpug.cfg` appended), so a
# release that turns one on is a red build; `cs2-image.test.ts` runs it over
# ours, so a line that goes missing is a red verify.
#
# POSIX sh and awk: it runs in the image's `debian:bookworm-slim` build stage.
set -eu

cfg=${1:?usage: matchzy-cfg-check.sh <config.cfg> [<database.json>]}
database=${2:-}

awk '
  # name → the value it must have, exactly, once the whole file is read.
  # A name that is absent falls to the code default, and these defaults are on
  # (or, for the report, one upstream edit away from it): absent is a failure.
  BEGIN {
    must["matchzy_safeautoupdater_enabled"] = "false"      # Steam UpToDateCheck, every 5 min
    must["matchzy_safeautoupdater_action"] = "warn_only"   # `restart` kicks and quits
    must["matchzy_autoready_simulation_enabled"] = "false" # spawns two bots into warmup
    must["matchzy_report_endpoint"] = ""                   # POSTs the match report there
    must["matchzy_report_server_id"] = ""                  # the report, and server_configured
    must["matchzy_report_token"] = ""                      # the report

    # Console commands, not cvars: each one *persists* a value in matchzy.db and
    # starts a fetch or a timer with it, so off means never given one. The
    # pinned release writes five of them with `""`, which every one of these
    # commands refuses or reads as "unset"; anything between the quotes fails.
    never["matchzy_bootstrap_url"] = "fetches a list of console commands and runs them"
    never["matchzy_bootstrap_token"] = "the bootstrap fetch"
    never["matchzy_heartbeat_url"] = "MatHeartbeat, every 15 s"
    never["matchzy_webhook_url"] = "a second name for the remote log, which the core plugin owns"
    never["matchzy_match_token"] = "arms the heartbeat, the bootstrap fetch and the report at once"
    never["matchzy_admins_url"] = "polls an admin list"
    never["matchzy_server_id"] = "the match report upload, and the server_configured event"
    never["matchzy_remote_log_url"] = "the core plugin sets it per match, with the token of this server"
    never["matchzy_remote_log_header_key"] = "the core plugin sets it per match"
    never["matchzy_remote_log_header_value"] = "a token in a cfg is a secret on disk"
    never["matchzy_remote_backup_url"] = "backups cross the link, scrubbed"
    never["matchzy_demo_upload_url"] = "the core plugin sets it per match"
    never["matchzy_loadmatch_url"] = "a match arrives over the link"
    never["get5_remote_log_url"] = "see matchzy_remote_log_url"
    never["get5_remote_backup_url"] = "see matchzy_remote_backup_url"
    never["get5_demo_upload_url"] = "see matchzy_demo_upload_url"
    never["get5_loadmatch_url"] = "see matchzy_loadmatch_url"
  }
  {
    line = $0
    sub(/\r$/, "", line)
    sub(/^[ \t]+/, "", line)
    if (line == "" || line ~ /^\/\//) next
    name = line
    sub(/[ \t].*$/, "", name)
    value = substr(line, length(name) + 1)
    sub(/^[ \t]+/, "", value)
    if (value ~ /^"/) { sub(/^"/, "", value); sub(/".*$/, "", value) }
    else { sub(/[ \t]*\/\/.*$/, "", value); sub(/[ \t]+$/, "", value) }
    name = tolower(name)
    if (name in never && value != "") { said[name] = NR }
    if (name in must) { seen[name] = 1; last[name] = tolower(value) }
  }
  END {
    bad = 0
    for (name in said) {
      printf "matchzy-cfg-check: %s:%d sets %s (%s)\n", FILENAME, said[name], name, never[name]
      bad = 1
    }
    for (name in must) {
      want = must[name]
      if (!(name in seen)) {
        printf "matchzy-cfg-check: %s never sets %s; it has to say \"%s\" itself, whatever the code defaults to\n", FILENAME, name, want
        bad = 1
      } else {
        got = last[name]
        if (want == "false" && got == "0") got = "false"
        if (got != want) {
          printf "matchzy-cfg-check: %s leaves %s at \"%s\", it has to be \"%s\"\n", FILENAME, name, last[name], want
          bad = 1
        }
      }
    }
    exit bad
  }
' "$cfg"

# The database MatchZy keeps its stats, its persisted config and its event
# queue in is a file beside the plugin. MySQL is the multi-server setup — a
# socket to a database that is not ours.
if [ -n "$database" ]; then
  if ! grep -Eq '"DatabaseType"[[:space:]]*:[[:space:]]*"SQLite"' "$database"; then
    echo "matchzy-cfg-check: $database does not say \"DatabaseType\": \"SQLite\""
    exit 1
  fi
fi
