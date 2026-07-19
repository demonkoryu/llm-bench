#!/usr/bin/env node
// Local dashboard server — Postgres-backed query API for the unified explorer, plus it
// serves the single-file frontend. Reads central-db (llmbench.measurements) through
// DuckDB's postgres extension; needs LLMBENCH_DB_PASSWORD in the env. Keep it current with
// `npm run pg:sync`. No build step; run `npm run dashboard`.
//
// Endpoints (all POST JSON unless noted):
//   GET  /api/facets              -> { dim: [values...] } for the facet rail
//   POST /api/pivot               -> { rows, cols, cells } (rows-dim x cols-dim x metric, delta vs baseline)
//   POST /api/pareto              -> { points:[{x,y,arch,vram,label,dims}] }
//   POST /api/leaderboard         -> scored entities (via analysis/score.mjs, over the selection)
//   POST /api/coverage            -> { configs, benches, cells } run-vs-not matrix
//   GET  /                        -> app/web/index.html
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pgInfo, query } from '../analysis/pg-store.mjs';
import * as engine from '../analysis/query-engine.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WEB = join(ROOT, 'app', 'web');
const PORT = Number(process.env.PORT || 5178);

// The metric catalog + pivot/pareto/leaderboard/coverage/meta/facets logic lives in
// analysis/query-engine.mjs — the SAME pure module the static export inlines, so the two
// dashboards can't drift. This server is a thin shell: pull the tidy rows from Postgres once
// per request and hand them to the shared engine. (Dataset is small — a few thousand rows —
// so a full SELECT * per request is cheap.)
const allRows = () => query('SELECT * FROM $TIDY');

const HANDLERS = {
   '/api/pivot': async (b) => engine.pivot(await allRows(), b),
   '/api/pareto': async (b) => engine.pareto(await allRows(), b),
   '/api/leaderboard': async (b) => engine.leaderboard(await allRows(), b),
   '/api/coverage': async (b) => engine.coverage(await allRows(), b),
};

function send(res, code, body, type = 'application/json') {
   res.writeHead(code, { 'Content-Type': type, 'Access-Control-Allow-Origin': '*' });
   res.end(typeof body === 'string' ? body : JSON.stringify(body));
}
function readBody(req) {
   return new Promise((r) => {
      let d = '';
      req.on('data', (c) => (d += c));
      req.on('end', () => r(d ? JSON.parse(d) : {}));
   });
}

const server = createServer(async (req, res) => {
   try {
      const url = new URL(req.url, `http://localhost:${PORT}`);
      if (url.pathname === '/api/meta') return send(res, 200, engine.meta());
      if (url.pathname === '/api/facets') return send(res, 200, engine.facets(await allRows()));
      if (HANDLERS[url.pathname] && req.method === 'POST') return send(res, 200, await HANDLERS[url.pathname](await readBody(req)));
      if (url.pathname === '/' || url.pathname === '/index.html')
         return send(res, 200, readFileSync(join(WEB, 'index.html'), 'utf8'), 'text/html');
      if (url.pathname === '/app.js') return send(res, 200, readFileSync(join(WEB, 'app.js'), 'utf8'), 'text/javascript');
      return send(res, 404, { error: 'not found' });
   } catch (e) {
      return send(res, 500, { error: String(e.message || e) });
   }
});
server.listen(PORT, () => console.error(`[dashboard] http://localhost:${PORT}  (Postgres: ${pgInfo()})`));
