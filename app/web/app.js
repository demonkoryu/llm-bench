// llm-bench explorer — vanilla JS client for the DuckDB-backed API.
const $ = (s) => document.querySelector(s);
const el = (t, a = {}, ...k) => {
   const n = document.createElement(t);
   for (const p in a)
      p === 'html' ? (n.innerHTML = a[p]) : p.startsWith('on') ? n.addEventListener(p.slice(2), a[p]) : n.setAttribute(p, a[p]);
   for (const c of k) n.append(c?.nodeType ? c : document.createTextNode(c ?? ''));
   return n;
};
const fmt = (v, d = 1) => (v == null || Number.isNaN(v) ? '—' : (+v).toFixed(d));
const ARCH_COLORS = {
   'gated-delta-moe': '#2bd0be',
   'gated-delta-dense': '#e5a54f',
   moe: '#7aa2f7',
   dense: '#e5697b',
   'mamba-hybrid': '#b48ead',
};
const archColor = (a) => ARCH_COLORS[a] || '#8a949b';

const state = { facets: {}, facetValues: {}, meta: {}, view: 'pivot', ctl: {} };
async function api(path, body) {
   const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
   return r.json();
}
const selFacets = () =>
   Object.fromEntries(
      Object.entries(state.facets)
         .filter(([, v]) => v.size)
         .map(([k, v]) => [k, [...v]]),
   );

// ── facet rail ──────────────────────────────────────────────────────────────
function buildRail() {
   const host = $('#facets');
   host.innerHTML = '';
   for (const dim of state.meta.dims) {
      const vals = state.facetValues[dim] || [];
      if (!vals.length) continue;
      const opts = el('div', { class: 'opts' });
      for (const v of vals) {
         const cb = el('input', { type: 'checkbox' });
         cb.checked = state.facets[dim]?.has(v) || false;
         cb.addEventListener('change', () => {
            state.facets[dim] ??= new Set();
            cb.checked ? state.facets[dim].add(v) : state.facets[dim].delete(v);
            refresh();
         });
         opts.append(el('label', {}, cb, String(v)));
      }
      host.append(
         el(
            'details',
            { class: 'facet', ...(state.facets[dim]?.size ? { open: '' } : {}) },
            el('summary', {}, dim, el('span', { class: 'cnt' }, String(vals.length))),
            opts,
         ),
      );
   }
}

// ── tabs + controls ───────────────────────────────────────────────────────────
const VIEWS = ['pivot', 'pareto', 'leaderboard', 'coverage'];
function buildTabs() {
   const t = $('#tabs');
   t.innerHTML = '';
   for (const v of VIEWS)
      t.append(
         el(
            'button',
            {
               class: state.view === v ? 'on' : '',
               onclick: () => {
                  state.view = v;
                  buildTabs();
                  buildCtrls();
                  refresh();
               },
            },
            v,
         ),
      );
}
function selCtl(key, label, options, def) {
   const s = el('select', {
      onchange: () => {
         state.ctl[key] = s.value;
         refresh();
      },
   });
   for (const o of options) s.append(el('option', { value: o, ...(o === (state.ctl[key] ?? def) ? { selected: '' } : {}) }, o));
   state.ctl[key] ??= def;
   return el('label', {}, label, s);
}
function buildCtrls() {
   const c = $('#ctrls');
   c.innerHTML = '';
   const M = state.meta.metrics,
      D = state.meta.pivotDims;
   if (state.view === 'pivot') {
      c.append(
         selCtl('rowsDim', 'rows', D, 'gguf_file'),
         selCtl('colsDim', 'columns', D, 'chat_template'),
         selCtl('metric', 'metric', M, 'reasoning %'),
         selCtl('baseline', 'Δ baseline', ['(none)', ...(state.facetValues[state.ctl.colsDim || 'chat_template'] || [])], '(none)'),
      );
   } else if (state.view === 'pareto') {
      c.append(
         selCtl('xMetric', 'x axis', M, 'decode tok/s'),
         selCtl('yMetric', 'y axis', M, 'reasoning %'),
         selCtl('think', 'think', ['no_think', 'think'], 'no_think'),
      );
   } else if (state.view === 'leaderboard') {
      c.append(selCtl('think', 'think', ['no_think', 'think'], 'no_think'));
   }
}

// ── views ─────────────────────────────────────────────────────────────────────
async function refresh() {
   const facets = selFacets();
   const v = $('#view');
   v.innerHTML = '<div class="muted">querying…</div>';
   try {
      if (state.view === 'pivot')
         return renderPivot(
            await api('/api/pivot', {
               facets,
               rowsDim: state.ctl.rowsDim,
               colsDim: state.ctl.colsDim,
               metric: state.ctl.metric,
               baseline: state.ctl.baseline === '(none)' ? null : state.ctl.baseline,
            }),
         );
      if (state.view === 'pareto')
         return renderPareto(
            await api('/api/pareto', { facets, xMetric: state.ctl.xMetric, yMetric: state.ctl.yMetric, think: state.ctl.think }),
         );
      if (state.view === 'leaderboard') return renderBoard(await api('/api/leaderboard', { facets, think: state.ctl.think }));
      if (state.view === 'coverage') return renderCoverage(await api('/api/coverage', { facets }));
   } catch (e) {
      v.innerHTML = `<div class="muted">error: ${e.message}</div>`;
   }
}

function renderPivot(d) {
   const lower = d.lower;
   const head = el('tr', {}, el('th', {}, d.metric));
   d.cols.forEach((c) => head.append(el('th', { class: 'num' }, String(c))));
   const body = d.cells.map((row) => {
      const tr = el('tr', {}, el('td', {}, row.r.replace('.gguf', '')));
      row.vals.forEach((cell) => {
         let chip = '';
         if (cell.delta != null && Math.abs(cell.delta) > 0.05) {
            const good = lower ? cell.delta < 0 : cell.delta > 0;
            chip = ` <span class="chip ${good ? 'win' : 'loss'}">${cell.delta > 0 ? '+' : ''}${fmt(cell.delta)}</span>`;
         }
         tr.append(el('td', { class: 'num', html: `${fmt(cell.v)}${chip}` }));
      });
      return tr;
   });
   $('#view').replaceChildren(el('table', {}, el('thead', {}, head), el('tbody', {}, ...body)));
}

function renderBoard(d) {
   const cols = [
      ['capability', 'cap', 2, 1],
      ['comprehension', 'comp', 3, 1],
      ['coding', 'code', 3, 1],
      ['speed', 'speed', 2, 1],
      ['fleet_suitability', 'fleet', 1, 1],
   ];
   const head = el(
      'tr',
      {},
      el('th', {}, 'model'),
      el('th', {}, 'template'),
      el('th', {}, 'kv'),
      ...cols.map(([, l]) => el('th', { class: 'num' }, l)),
   );
   const body = d.entities.map((e) =>
      el(
         'tr',
         {},
         el('td', {}, e.dims.gguf_file.replace('.gguf', '')),
         el('td', {}, e.dims.chat_template),
         el('td', {}, e.dims.kv_quant ?? '—'),
         ...cols.map(([k, , dec]) => el('td', { class: 'num cap' }, fmt(e[k], dec))),
      ),
   );
   $('#view').replaceChildren(
      el('div', { class: 'muted' }, `${d.count} rows · ${d.entities.length} configs · normalized within this selection`),
      el('table', {}, el('thead', {}, head), el('tbody', {}, ...body)),
   );
}

function renderCoverage(d) {
   if (!d.configs.length) {
      $('#view').innerHTML = '<div class="muted">no data in selection</div>';
      return;
   }
   const head = el('tr', {}, el('th', {}, 'config'));
   d.benches.forEach((b) => head.append(el('th', {}, b)));
   const body = d.cells.map((row) =>
      el(
         'tr',
         {},
         el('td', {}, row.cfg.replace(/\|/g, ' · ')),
         ...row.has.map((h) => el('td', {}, el('span', { class: `cov ${h ? 'y' : 'n'}`, title: h ? 'run' : 'missing' }))),
      ),
   );
   const wrap = el('div', { style: 'overflow-x:auto' }, el('table', {}, el('thead', {}, head), el('tbody', {}, ...body)));
   $('#view').replaceChildren(wrap);
}

function renderPareto(d) {
   const W = 720,
      H = 460,
      P = 54;
   const pts = d.points.filter((p) => p.x != null && p.y != null);
   const view = $('#view');
   if (!pts.length) {
      view.innerHTML = '<div class="muted">no configs have both axes in this selection (need overlapping benches)</div>';
      return;
   }
   const xs = pts.map((p) => p.x),
      ys = pts.map((p) => p.y);
   const xmin = Math.min(...xs) * 0.95,
      xmax = Math.max(...xs) * 1.05,
      ymin = Math.min(...ys, 0),
      ymax = Math.max(...ys) * 1.02;
   const sx = (x) => P + ((x - xmin) / (xmax - xmin || 1)) * (W - 2 * P);
   const sy = (y) => H - P - ((y - ymin) / (ymax - ymin || 1)) * (H - 2 * P);
   const vmax = Math.max(...pts.map((p) => p.vram || 0), 1);
   const rOf = (v) => 5 + 9 * Math.sqrt((v || vmax / 2) / vmax);
   const NS = 'http://www.w3.org/2000/svg';
   const svg = document.createElementNS(NS, 'svg');
   svg.setAttribute('id', 'pareto');
   svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
   svg.setAttribute('width', '100%');
   svg.style.maxWidth = W + 'px';
   const mk = (t, a) => {
      const n = document.createElementNS(NS, t);
      for (const k in a) n.setAttribute(k, a[k]);
      return n;
   };
   // Node.append() returns undefined, so set textContent BEFORE appending.
   const mkt = (a, s) => {
      const n = mk('text', a);
      n.textContent = s;
      svg.append(n);
      return n;
   };
   // grid + axes
   for (let i = 0; i <= 4; i++) {
      const gy = P + (i * (H - 2 * P)) / 4;
      svg.append(mk('line', { x1: P, y1: gy, x2: W - P, y2: gy, stroke: 'var(--line)' }));
      mkt({ x: 8, y: gy + 4, fill: 'var(--faint)', 'font-size': 10, 'font-family': 'var(--mono)' }, fmt(ymax - (i * (ymax - ymin)) / 4, 0));
   }
   mkt(
      { x: W / 2, y: H - 12, fill: 'var(--dim)', 'font-size': 11, 'text-anchor': 'middle', 'font-family': 'var(--mono)' },
      d.xMetric + ' →',
   );
   mkt({ x: 14, y: 20, fill: 'var(--dim)', 'font-size': 11, 'font-family': 'var(--mono)' }, '↑ ' + d.yMetric);
   const tip = $('#tip');
   for (const p of pts) {
      const c = mk('circle', {
         cx: sx(p.x),
         cy: sy(p.y),
         r: rOf(p.vram),
         fill: archColor(p.arch),
         'fill-opacity': 0.75,
         stroke: archColor(p.arch),
         'stroke-width': 1,
      });
      c.addEventListener('mousemove', (ev) => {
         tip.style.display = 'block';
         tip.style.left = ev.clientX + 12 + 'px';
         tip.style.top = ev.clientY + 12 + 'px';
         tip.innerHTML = `${p.label}<br>${d.xMetric}: ${fmt(p.x)} · ${d.yMetric}: ${fmt(p.y)}<br>${p.arch} · active ${p.dims.active_params}B · VRAM ${fmt(p.vram, 0)}MiB`;
      });
      c.addEventListener('mouseleave', () => {
         tip.style.display = 'none';
      });
      svg.append(c);
   }
   const archs = [...new Set(pts.map((p) => p.arch))];
   const legend = el(
      'div',
      { class: 'legend' },
      ...archs.map((a) => el('span', {}, el('span', { class: 'dot', style: `background:${archColor(a)}` }), a)),
      el('span', {}, '○ size = VRAM · up-and-left = smarter+faster'),
   );
   view.replaceChildren(svg, legend);
}

// ── boot ────────────────────────────────────────────────────────────────────
(async () => {
   state.meta = await (await fetch('/api/meta')).json();
   state.facetValues = await (await fetch('/api/facets')).json();
   const board = await api('/api/leaderboard', { facets: {}, think: 'no_think' });
   $('#rowcount').textContent = `${board.count} measurements`;
   $('#clear').addEventListener('click', () => {
      state.facets = {};
      buildRail();
      refresh();
   });
   buildRail();
   buildTabs();
   buildCtrls();
   refresh();
})();
