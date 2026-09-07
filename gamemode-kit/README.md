# `@ezpug/gamemode-kit`

The widget toolchain of EZPug Iron (decision 17): the runtime a gamemode's phone widget is
written on, the Vite preset that builds `gamemodes/<id>/widget/` into one bundle the
orchestrator serves, and a dev harness that mounts the widget the way the platform does —
against the published fake orchestrator, with a simulated match and a real socket.

`docs/gamemodes.md` "Building a widget" and "The widget host" are the guide; this file is
the map.

| Where | What |
| ----- | ---- |
| `src/index.ts` | the runtime a widget imports: `defineWidget`, `useWidget()` / `useT()`, `useWidgetLink()`, the tokens with fallbacks, `createT` and `KIT_COPY` |
| `src/link.ts` | the socket to `GET /v1/widget` as a composable: hello, verbs, taps, events, reconnect |
| `src/host.ts`, `src/mount.ts` | the `postMessage` handshake with the platform's host, and the shell that mounts the element inside the served document |
| `src/element.ts` | `<ezpug-widget>`: props in, context out, the kit's base `:host` rules |
| `src/tokens.ts` | the platform's token names, their fallbacks, `applyWidgetTokens` |
| `src/protocol.ts` | the socket and host constants, mirrored from `@ezpug/match-api` and pinned equal by a test |
| `src/vite.ts`, `src/build.ts` | the library preset and the build with its "no way out but the socket" check |
| `src/dev.ts`, `harness/` | `ezpug-widget dev`: Vite, the fake orchestrator, the host page |
| `src/cli.ts` | `ezpug-widget build [id …]` and `ezpug-widget dev <id>` |

```
pnpm --filter @ezpug/gamemodes build                          # every widget → gamemodes/<id>/dist/widget.js
pnpm --filter @ezpug/gamemodes exec ezpug-widget dev powerup-dm   # the harness on http://127.0.0.1:3432
```

`@ezpug/match-api` is a *peer* of this package, not a dependency edge (`turbo.json`): the
published package depends on the manifests and the manifests depend on this kit, and a
third edge would close the cycle. The runtime imports only types from it; the CLI's dev
harness runs the published fake, bundled from source by `tsdown`.
