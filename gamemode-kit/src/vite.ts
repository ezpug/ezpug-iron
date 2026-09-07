import { existsSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import vue from '@vitejs/plugin-vue'
import type { InlineConfig } from 'vite'

/**
 * **The library preset** — what turns a gamemode's `widget/` into the one
 * file the orchestrator serves (`gamemodes/<id>/dist/widget.js`, decision
 * 17). Library mode, one ES module, no code splitting, every asset inlined,
 * Vue's custom-element mode on so an SFC's `<style>` lands in the shadow
 * root, and production Vue (no devtools hook, no warnings) — a phone loads
 * this over a venue's wifi.
 *
 * `ezpug-widget build` runs it; `ezpug-widget dev` runs the same Vue plugin
 * under Vite's dev server with the kit's harness around it. A gamemode does
 * not carry a `vite.config.ts`: the preset is the config, and the kit is
 * where it changes.
 */

/** The output file a manifest's `widget.entry` points at, relative to the mode's directory. */
export const WIDGET_BUNDLE = 'dist/widget.js'
/** The source a gamemode keeps beside its manifest. */
export const WIDGET_SOURCE_ENTRY = 'widget/index.ts'

export interface WidgetPaths {
  /** The gamemode's id — its directory's name. */
  id: string
  /** `gamemodes/<id>`, absolute. */
  dir: string
  /** `gamemodes/<id>/widget/index.ts`. */
  entry: string
  /** `gamemodes/<id>/dist`. */
  outDir: string
}

/** Where a gamemode's widget lives, from the mode's directory; `null` when it has no `widget/index.ts`. */
export function widgetPaths(gamemodeDir: string): WidgetPaths | null {
  const dir = resolve(gamemodeDir)
  const entry = join(dir, WIDGET_SOURCE_ENTRY)
  if (!existsSync(entry)) return null
  return { id: basename(dir), dir, entry, outDir: join(dir, 'dist') }
}

export interface WidgetLibraryOptions {
  /** `sourcemap` beside the bundle — never in the image, useful on a dev box. */
  sourcemap?: boolean
}

/** The Vue plugin as every widget build and the harness run it. */
export function widgetVuePlugin() {
  return vue({ customElement: true })
}

export function widgetLibraryConfig(
  paths: WidgetPaths,
  options: WidgetLibraryOptions = {},
): InlineConfig {
  return {
    configFile: false,
    root: paths.dir,
    logLevel: 'warn',
    plugins: [widgetVuePlugin()],
    define: {
      'process.env.NODE_ENV': JSON.stringify('production'),
      __VUE_OPTIONS_API__: 'false',
      __VUE_PROD_DEVTOOLS__: 'false',
      __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false',
    },
    build: {
      outDir: paths.outDir,
      emptyOutDir: true,
      target: 'es2022',
      sourcemap: options.sourcemap ?? false,
      cssCodeSplit: false,
      assetsInlineLimit: () => true,
      lib: {
        entry: paths.entry,
        formats: ['es'],
        fileName: () => basename(WIDGET_BUNDLE),
      },
      rolldownOptions: {
        output: { codeSplitting: false },
      },
    },
  }
}
