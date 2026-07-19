#!/usr/bin/env node
// Copy the shared pure engine (analysis/{scoring-config,score,query-engine}.mjs) into
// src/lib/*.js so the Framework client can import it. Runs on every dev/build (pre* scripts),
// so the copy is ALWAYS fresh from the single source — it can't drift. src/lib/ is git-ignored.
// The only rewrite: sibling import specifiers .mjs -> .js (Framework serves .js modules).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
