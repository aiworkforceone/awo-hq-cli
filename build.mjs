// Bundle the `hq` CLI to ONE file with ZERO runtime dependencies (FEATURE.md decision 13, S2).
//
// Run from the kpa-app root (`node cli/build.mjs`) or from `cli/` (`npm run build`): esbuild and `ws`
// resolve from the repo root's node_modules, and `@kpa/shared/*` is aliased to the shared SOURCE so
// the published file carries the same wire contract the server was built with.
//
// No source maps (they would carry internal paths into a PUBLIC tarball), no minification (the file is
// read by people who want to know what they installed), and `bufferutil` / `utf-8-validate` stay
// external: they are OPTIONAL native accelerators of `ws`, and the CLI ships no native module.
//
// One source, one build per brand (shared/src/dev-brands.ts):
//
//   node cli/build.mjs                          the AWO CLI, exactly as before: cli/dist/hq.cjs
//                                               (cli/ itself is the package).
//   node cli/build.mjs --out <dir>              the same, staged as a COMPLETE package directory
//                                               (package.json, README.md, LICENSE, dist/hq.cjs):
//                                               what `npm pack` and the public mirror read.
//   node cli/build.mjs --brand <id> [--out <dir>]
//                                               another brand's package (default
//                                               cli/dist/brands/<id>/), its files from
//                                               cli/brand-files/<id>/. Minified, its modules keyed
//                                               by number: it ships no source, so nothing in it
//                                               names a source path.
//
// The brand reaches the code at build time (scripts/dev-brand-build.mjs): the active brand's data,
// and, for another brand, our copy rewritten in its words.
import * as esbuild from 'esbuild';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import ts from 'typescript';
import {
  devBrandPlugin,
  loadDevBrand,
  neutralizeModulePaths,
} from '../scripts/dev-brand-build.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const pkg = (await import(path.join(here, 'package.json'), { with: { type: 'json' } })).default;

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}
const brandId = arg('brand') ?? 'awo';
const brand = await loadDevBrand(root, brandId, { esbuild });
const brandPlugin = await devBrandPlugin(root, brandId, { esbuild, ts });

const isAwo = brandId === 'awo';
const outArg = arg('out');
const outDir = outArg
  ? path.resolve(outArg)
  : isAwo
    ? here
    : path.join(here, 'dist', 'brands', brandId);
const bundleFile = path.join(outDir, 'dist', brand.cli.bundleFile);

const result = await esbuild.build({
  entryPoints: [path.join(here, 'src', 'main.ts')],
  // `.cjs`: the package is `type: module` (so tsc checks the sources as ESM) but the bundle is CommonJS.
  outfile: bundleFile,
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  sourcemap: false,
  // AWO's is read by people who want to know what they installed; another brand's ships no source.
  minify: !isAwo,
  metafile: !isAwo,
  legalComments: 'none',
  banner: { js: '#!/usr/bin/env node' },
  define: { __HQ_VERSION__: JSON.stringify(pkg.version) },
  external: ['bufferutil', 'utf-8-validate'],
  alias: {
    '@kpa/shared': path.join(root, 'shared', 'src'),
    // hq-vscode decision 4: the client code the CLI shares with the VS Code extension.
    '@hq/client': path.join(root, 'hq-client', 'src'),
  },
  plugins: [brandPlugin],
  nodePaths: [path.join(root, 'node_modules')],
  logLevel: 'info',
});

if (!isAwo) {
  writeFileSync(
    bundleFile,
    neutralizeModulePaths(readFileSync(bundleFile, 'utf8'), result.metafile),
  );
}

if (isAwo && outDir !== here) {
  // The AWO package, staged: its own manifest and files, unchanged.
  for (const f of ['package.json', 'README.md', 'LICENSE']) {
    copyFileSync(path.join(here, f), path.join(outDir, f));
  }
  console.log(`${pkg.name}@${pkg.version} → ${outDir}`);
} else if (!isAwo) {
  // The brand's package: the AWO manifest's shape with the brand's names, at the SAME version (one
  // source, one release train). No scripts: it is published from its mirror with --ignore-scripts.
  const branded = {
    name: brand.cli.packageName,
    version: pkg.version,
    description: brand.cli.description,
    license: pkg.license,
    repository: { type: 'git', url: `git+https://github.com/${brand.cli.repository}.git` },
    homepage: `https://github.com/${brand.cli.repository}#readme`,
    type: pkg.type,
    bin: { [brand.cli.command]: `dist/${brand.cli.bundleFile}` },
    files: [`dist/${brand.cli.bundleFile}`, 'README.md', 'LICENSE'],
    engines: pkg.engines,
  };
  writeFileSync(path.join(outDir, 'package.json'), `${JSON.stringify(branded, null, 2)}\n`);
  // Written for the brand by hand (cli/brand-files/<brand>/), never our README run through a regex.
  for (const f of ['README.md', 'LICENSE']) {
    copyFileSync(path.join(here, 'brand-files', brandId, f), path.join(outDir, f));
  }
  console.log(`${brand.cli.packageName}@${pkg.version} → ${outDir}`);
}
