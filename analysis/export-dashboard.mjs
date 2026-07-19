#!/usr/bin/env node
// Static export — snapshots the tidy store into ONE self-contained, responsive
// results/dashboard.html for pages.xor0.de + mobile. No server: the data, the pure
// scorer (analysis/score.mjs), the shared query engine (analysis/query-engine.mjs — the SAME
// module app/server.mjs uses, so the two dashboards can't drift), and a tiny fetch() shim are
// all inlined so the SAME app/web/app.js runs unchanged. `npm run dashboard:export`.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { query } from '../shared/tidy-store.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RESULTS = join(ROOT, 'results');
const WEB = join(ROOT, 'app', 'web');

// Inline an ES module as a classic script: strip its `import` lines and `export` keywords so its
// top-level consts/functions land in the page's global scope. Modules are concatenated in
// dependency order (config -> score -> query-engine), so cross-module references resolve as
// globals. NOTE: names must be unique across the inlined modules (e.g. query-engine uses CELL_SEP
// to avoid colliding with score.mjs's SEP).
function inlineModule(rel) {
   return readFileSync(join(ROOT, rel), 'utf8')
      .replace(/^import[^\n]*\n/gm, '')
      .replace(/^export /gm, '');
}
function inlineEngine() {
   return [inlineModule('analysis/scoring-config.mjs'), inlineModule('analysis/score.mjs'), inlineModule('analysis/query-engine.mjs')].join(
      '\n',
   );
}

// Fetch shim: answer /api/* from the inlined engine over the baked-in rows (window.__ROWS__),
// so app/web/app.js runs unchanged with no server.
const SHIM = `
const ROWS = window.__ROWS__;
const _resp = (o) => ({ ok:true, json: async()=>o });
const _origFetch = window.fetch ? window.fetch.bind(window) : null;
window.fetch = async (url, opts) => { const u=String(url); const body = (opts&&opts.body)?JSON.parse(opts.body):{};
  if (u.endsWith('/api/meta')) return _resp(meta());
  if (u.endsWith('/api/facets')) return _resp(facets(ROWS));
  if (u.endsWith('/api/pivot')) return _resp(pivot(ROWS, body));
  if (u.endsWith('/api/pareto')) return _resp(pareto(ROWS, body));
  if (u.endsWith('/api/leaderboard')) return _resp(leaderboard(ROWS, body));
  if (u.endsWith('/api/coverage')) return _resp(coverage(ROWS, body));
  return _origFetch ? _origFetch(url,opts) : _resp({}); };
`;

async function main() {
   const rows = await query(RESULTS, `SELECT * FROM $TIDY`);
   const html = readFileSync(join(WEB, 'index.html'), 'utf8');
   const appJs = readFileSync(join(WEB, 'app.js'), 'utf8');
   const dataScript = `<script>window.__ROWS__=${JSON.stringify(rows)};</script>`;
   const inlined = [dataScript, `<script>${inlineEngine()}\n${SHIM}</script>`, `<script>${appJs}</script>`].join('\n');
   // add mobile-friendliness note + a generated stamp, replace the external app.js include
   const out = html
      .replace('<script src="/app.js"></script>', inlined)
      .replace(
         '<title>llm-bench explorer</title>',
         `<title>llm-bench explorer</title>\n<meta name="description" content="llm-bench results — generated ${new Date().toISOString()}">`,
      );
   const dest = join(RESULTS, 'dashboard.html');
   writeFileSync(dest, out);
   console.error(`[export] ${rows.length} rows → ${dest} (${(out.length / 1024).toFixed(0)} KiB, self-contained)`);
}
main().catch((e) => {
   console.error(e);
   process.exit(1);
});
