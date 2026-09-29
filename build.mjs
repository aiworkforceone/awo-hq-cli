// Bundle the `hq` CLI to ONE file with ZERO runtime dependencies (FEATURE.md decision 13, S2).
//
// Run from the kpa-app root (`node cli/build.mjs`) or from `cli/` (`npm run build`): esbuild and `ws`
// resolve from the repo root's node_modules, and `@kpa/shared/*` is aliased to the shared SOURCE so
// the published file carries the same wire contract the server was built with.
//
// No source maps (they would carry internal paths into a PUBLIC tarball), no minification (the file is
// read by people who want to know what they installed), and `bufferutil` / `utf-8-validate` stay
// external: they are OPTIONAL native accelerators of `ws`, and the CLI ships no native module.
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const pkg = (await import(path.join(here, 'package.json'), { with: { type: 'json' } })).default;

await build({
  entryPoints: [path.join(here, 'src', 'main.ts')],
  // `.cjs`: the package is `type: module` (so tsc checks the sources as ESM) but the bundle is CommonJS.
  outfile: path.join(here, 'dist', 'hq.cjs'),
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  sourcemap: false,
  minify: false,
  legalComments: 'none',
  banner: { js: '#!/usr/bin/env node' },
  define: { __HQ_VERSION__: JSON.stringify(pkg.version) },
  external: ['bufferutil', 'utf-8-validate'],
  alias: { '@kpa/shared': path.join(root, 'shared', 'src') },
  nodePaths: [path.join(root, 'node_modules')],
  logLevel: 'info',
});
