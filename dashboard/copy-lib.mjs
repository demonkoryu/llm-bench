#!/usr/bin/env node
// Copy the shared pure engine (analysis/{scoring-config,score,query-engine}.mjs) into
// src/lib/*.js so the Framework client can import it. Runs on every dev/build (pre* scripts),
// so the copy is ALWAYS fresh from the single source — it can't drift. src/lib/ is git-ignored.
// The only rewrite: sibling import specifiers .mjs -> .js (Framework serves .js modules).
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, '..', 'analysis');
const DST = join(here, 'src', 'lib');

mkdirSync(DST, { recursive: true });
for (const name of ['scoring-config', 'score', 'query-engine']) {
   const code = readFileSync(join(SRC, `${name}.mjs`), 'utf8')
      .replaceAll(".mjs'", ".js'")
      .replaceAll('.mjs"', '.js"');
   writeFileSync(join(DST, `${name}.js`), code);
}
console.error('[copy-lib] engine → dashboard/src/lib/{scoring-config,score,query-engine}.js');

// Drop the cached data-loader output before every dev/build.
//
// Framework's build passes useStale:true to the loader, and that path returns the CACHED file
// without running the loader whenever the cache is older than the loader script
// (node_modules/@observablehq/framework/dist/loader.js — the "[using stale]" branch). The
// measurements loader reads central-db at build time, so its output goes stale the moment any
// bench writes a row, while the loader script itself rarely changes. The result is a build that
// silently republishes an old snapshot and reports "success".
//
// Observed 2026-08-26: a local build served src/.observablehq/cache/data/measurements.json from
// 21 July — 2288 rows including RX 7900 XT / vulkan measurements that had been deleted from the
// store months earlier — instead of the 1269 live V100 rows. Nothing in the build output said so
// beyond a faint "[using stale]".
//
// CI is unaffected (it clones fresh and .observablehq/ is git-ignored, so the loader always runs),
// which is exactly why this stayed invisible: it only bites the person checking their work locally
// before pushing. Deleting just the data cache is enough — the module/npm caches beside it are
// keyed by content and safe to keep.
const CACHE = join(here, 'src', '.observablehq', 'cache', 'data');
rmSync(CACHE, { recursive: true, force: true });
