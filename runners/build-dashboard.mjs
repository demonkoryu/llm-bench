#!/usr/bin/env node
/**
 * Build a single self-contained results/dashboard.html.
 *
 * The dashboard re-ranks live as you turn weight DIALS. To guarantee the in-browser
 * numbers can't drift from the canonical report, the actual shared/scoring.mjs source
 * is inlined (exports stripped) and the browser calls the same scoreGroups/computeFleet.
 * computeMetrics runs here at build time; its normalized `models` table is inlined as
 * data, so the browser only re-scores (cheap) on each dial change.
 *
 * Dials only — no formula editing. The group STRUCTURE is fixed in shared/scoring.mjs
 * (GROUPS); the UI exposes within-group weights + group-contribution/strength + the
 * fleet memory dials. Explore-only: nothing is written back into the canonical report.
 *
 * Usage: node runners/build-dashboard.mjs [--input <run-id>...] [--output results/dashboard.html]
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { BENCH_REGISTRY, benchMatches, FLEET_REQUIRED } from '../shared/bench-registry.mjs';
import { baseModel, computeMetrics, DEFAULT_DIALS, GROUPS, loadCapabilities, loadRuns, mergeResultRows } from '../shared/results-store.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RESULTS_DIR = join(ROOT, 'results');
const { values: flags } = parseArgs({
   options: {
      input: { type: 'string', multiple: true },
      output: { type: 'string', default: join(RESULTS_DIR, 'dashboard.html') },
   },
});

const CSS = `
:root{--bg:#0f0f13;--panel:#18181f;--text:#e0e0e0;--dim:#888;--accent:#c8b6ff;--good:#82dc82;--warn:#ffc850}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:13px/1.4 'Segoe UI',Arial,sans-serif}
header{padding:12px 18px;border-bottom:1px solid #26262f}
h1{font-size:18px;margin:0 0 4px;color:var(--accent)}
#env{color:var(--dim);font-size:11px}
.warn{margin-top:6px;color:#1a1a1a;background:var(--warn);padding:4px 8px;border-radius:4px;display:inline-block}
main{display:flex;align-items:flex-start;gap:16px;padding:16px}
#controls{flex:0 0 290px;position:sticky;top:8px}
.ctl-head{display:flex;gap:8px;align-items:center;margin-bottom:6px}
button{background:#26262f;color:var(--text);border:1px solid #3a3a47;border-radius:4px;padding:3px 10px;cursor:pointer}
button:hover{border-color:var(--accent)}
.note{color:var(--dim);font-size:11px}
fieldset{border:1px solid #2a2a35;border-radius:6px;margin:8px 0;padding:6px 10px}
legend{color:var(--accent);font-size:11px;text-transform:capitalize}
.dial-row{display:grid;grid-template-columns:1fr 96px 40px;gap:6px;align-items:center;margin:3px 0;font-size:11px}
.dial-name{color:var(--dim);text-transform:capitalize}
input[type=range]{width:100%}
input[type=number]{width:96px;background:#0f0f13;color:var(--text);border:1px solid #3a3a47;border-radius:3px}
output{color:var(--accent);text-align:right;font-variant-numeric:tabular-nums}
#panels{flex:1;min-width:0;display:flex;flex-direction:column;gap:16px}
.panel{background:var(--panel);border:1px solid #26262f;border-radius:8px;padding:10px 14px;overflow-x:auto}
h2{font-size:14px;margin:0 0 8px;color:#a0a0c0}
table{width:100%;border-collapse:collapse;font-size:12px}
th,td{text-align:left;padding:3px 8px;border-bottom:1px solid #23232c;font-variant-numeric:tabular-nums;white-space:nowrap}
th{color:var(--dim);font-weight:600;font-size:10px;text-transform:uppercase}
code{color:#9fe7d6;font-size:11px}
.dim{color:var(--dim)} .warn-t{color:var(--warn)} .ok-t{color:var(--good)}
.stars{color:#ffd54a;letter-spacing:1px;white-space:nowrap}
tr.top5 td{background:rgba(255,213,74,0.06)}
`;

const UI_JS = `
const $ = (id) => document.getElementById(id);
const fmt = (n,d=1) => (n==null||!isFinite(n))?'–':Number(n).toFixed(d);
const pct = (n) => (n==null||!isFinite(n))?'–':(n*100).toFixed(1)+'%';
const esc = (s) => String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
// Capability-rank star badges (top 5): rank 1 → ★★★★★ … rank 5 → ★☆☆☆☆. Shown in every table.
let CAPRANK={};
const mkey=(m)=>m.model+'|'+m.think;
function stars(rank){ if(!rank||rank>5) return ''; let s=''; for(let i=0;i<5;i++) s+=(i<(6-rank)?'★':'☆'); return '<span class="stars" title="capability rank #'+rank+'">'+s+'</span>'; }
const topClass=(m)=>CAPRANK[mkey(m)]?'top5':'';
function num(id,def){ const e=$(id); if(!e) return def; const v=parseFloat(e.value); return isFinite(v)?v:def; }
function getDials(){
  const d = JSON.parse(JSON.stringify(DATA.defaultDials));
  for (const g of ['comprehension','coding']){
    if (d[g].strength!==undefined) d[g].strength = num('d_'+g+'_strength', d[g].strength);
    for (const k in d[g].weights) d[g].weights[k] = num('d_w_'+g+'_'+k, d[g].weights[k]);
  }
  for (const k in d.speed.weights) d.speed.weights[k] = num('d_w_speed_'+k, d.speed.weights[k]);
  for (const k in d.fleet) d.fleet[k] = num('d_fleet_'+k, d.fleet[k]);
  return d;
}
function table(headers, rows, rowClasses){
  let h='<table><thead><tr>';
  for (const x of headers) h+='<th>'+esc(x)+'</th>';
  h+='</tr></thead><tbody>';
  rows.forEach((r,i)=>{ const cls=(rowClasses&&rowClasses[i])?' class="'+rowClasses[i]+'"':''; h+='<tr'+cls+'>'; for (const c of r) h+='<td>'+(c==null?'':c)+'</td>'; h+='</tr>'; });
  return h+'</tbody></table>';
}
function renderEnv(){
  const e=DATA.environment;
  const s = e ? ('runner '+esc(e.runner)+' · '+esc(e.gpu)+' · '+esc(e.backend)+' · fa='+esc(e.server_flags&&e.server_flags.flash_attn)+' · kv='+esc(e.server_flags&&e.server_flags.cache_type_k)) : 'no server fingerprint (pre-fingerprint data)';
  $('env').innerHTML = s+' · sources: '+DATA.sources.map(esc).join(', ');
  const envs=DATA.environments.filter(Boolean); let consistent=true;
  for (let i=1;i<envs.length;i++){ if (JSON.stringify(envs[i])!==JSON.stringify(envs[0])) consistent=false; }
  $('banner').innerHTML = consistent ? '' : '<div class="warn">⚠ merged runs have different server configs — numbers may not be comparable.</div>';
}
function recompute(){
  const dials=getDials();
  const ranking=scoreGroups(DATA.models, dials);
  // Capability rank drives the star badges shown in EVERY table (top 5 only).
  CAPRANK={}; ranking.forEach((m,i)=>{ if(i<5) CAPRANK[mkey(m)]=i+1; });
  const fleetRes=computeFleet(DATA.models, dials);
  renderCap(ranking); renderFleet(fleetRes); renderCtx(); renderBreakdown(); renderRequired(dials);
}
function renderCap(ranking){
  const rows=ranking.map((m,i)=>[i+1, stars(i+1), esc(m.label), fmt(m.score), pct(m.comprehension), pct(m.coding), pct(m.codingCompetence)]);
  $('cap').innerHTML=table(['#','★','model','capability','comprehension','coding','competence'], rows, ranking.map(topClass));
}
function renderFleet(res){
  // Ranked by the blended fleet_suitability score: capability^w_cap × ctx_norm^w_ctx ×
  // slots_norm^w_slots × throughput^w_thru. Capability dominates (w_cap=2 default) so
  // capable all-rounders rise, while context reach (ctx clamped at the 100k tier) and
  // slot count strongly modulate. Tune the exponents in the fleet dials at left.
  const fv=(p)=>p.fleet_suitability==null?-Infinity:p.fleet_suitability;
  const sorted=res.fleet.slice().sort((a,b)=>fv(b)-fv(a));
  const mainCtx=(p)=>p.main_ctx==null?'–':p.main_ctx.toLocaleString();
  const workers=(p)=>p.n_workers==null?'–':('+'+p.n_workers+'×'+Math.round((p.worker_ctx||0)/1024)+'k');
  const rows=sorted.map((p,i)=>{
    const st=stars(CAPRANK[mkey(p)]);
    const fleetCell=p.fleet_suitability==null?'<span class="dim">'+esc(p.reason||'–')+'</span>':fmt(p.fleet_suitability,3);
    return [i+1, st, esc(p.label), pct(p.capability), fleetCell, mainCtx(p), workers(p), p.agg_tps==null?'–':fmt(p.agg_tps,0), pct(p.capacity_norm), pct(p.latency_norm)];
  });
  $('fleet').innerHTML=table(['#','★','model','cap','fleet','main ctx','+workers','agg tok/s','capacity','latency'], rows, sorted.map(topClass));
}
function renderCtx(){
  const list=DATA.models.slice().filter(m=>m.maxctx).sort((a,b)=>(b.maxctx||0)-(a.maxctx||0));
  const rows=list.map(m=>[stars(CAPRANK[mkey(m)]), esc(m.label), m.maxctx.toLocaleString(), m.maxctxVram==null?'–':Math.round(m.maxctxVram)+'M', m.kvPerTokMiB==null?'–':(m.kvPerTokMiB*1024).toFixed(1)]);
  $('ctx').innerHTML=table(['★','model','max ctx','vram@max','KV KiB/tok'], rows, list.map(topClass));
}
const BKEYS=['triage','summarization','docqa','reasoning','grade','agentic_loop','instruction_following','toolcalling','struct_output','e2e_throughput','cold_ttft','warm_ttft'];
function renderBreakdown(){
  const list=DATA.models.slice().sort((a,b)=>(b.capability==null?-1:b.capability)-(a.capability==null?-1:a.capability));
  const rows=list.map(m=>[stars(CAPRANK[mkey(m)]), esc(m.label)].concat(BKEYS.map(k=> m.norm[k]==null?'<span class="dim">–</span>':pct(m.norm[k]))));
  $('breakdown').innerHTML=table(['★','model'].concat(BKEYS), rows, list.map(topClass));
}
function renderRequired(dials){
  const used=new Set();
  for (const g of ['comprehension','coding','speed']) for (const k in (dials[g].weights||{})) if (dials[g].weights[k]>0) used.add(k);
  ['toolcalling','struct_output'].forEach(k=>used.add(k));
  DATA.fleetRequired.forEach(k=>used.add(k));
  const byRunner={};
  for (const k of used){ const e=DATA.registry[k]; if(!e) continue; byRunner[e.runner]=byRunner[e.runner]||{command:e.command,metrics:new Set(),missing:new Set()}; byRunner[e.runner].metrics.add(k); }
  for (const base in DATA.coverage){ for (const k of DATA.coverage[base].missing){ if(used.has(k)){ const e=DATA.registry[k]; if(e&&byRunner[e.runner]) byRunner[e.runner].missing.add(base); } } }
  let h='<table><thead><tr><th>runner</th><th>command</th><th>feeds</th><th>missing for</th></tr></thead><tbody>';
  for (const r in byRunner){ const o=byRunner[r]; const miss=[...o.missing]; h+='<tr><td>'+esc(r)+'</td><td><code>'+esc(o.command)+'</code></td><td>'+[...o.metrics].map(esc).join(', ')+'</td><td>'+(miss.length?('<span class="warn-t">'+miss.length+': '+miss.map(esc).join(', ')+'</span>'):'<span class="ok-t">complete</span>')+'</td></tr>'; }
  $('required').innerHTML=h+'</tbody></table>';
}
const RAWOF={triage:'triage',summarization:'summ',docqa:'docqa',reasoning:'reasoning',grade:'codingGrade',agentic_loop:'agenticScore',instruction_following:'ifScore',toolcalling:'toolcall',struct_output:'structScore',e2e_throughput:'e2eThroughput',cold_ttft:'ttft8kMs',decode_retention:'decodeRetentionPct',maxctx:'maxctx'};
function exportCSV(){
  const keys=BKEYS.concat(['decode_retention','maxctx']);
  const lines=['model,think,metric,raw,norm'];
  for (const m of DATA.models){ for (const k of keys){ const norm=m.norm[k]; let raw=RAWOF[k]?m[RAWOF[k]]:(k==='warm_ttft'?(m.prefixCache&&m.prefixCache.warm):null); lines.push([JSON.stringify(m.model),JSON.stringify(m.think),k,(raw==null?'':raw),(norm==null?'':norm)].join(',')); } }
  const blob=new Blob([lines.join('\\n')],{type:'text/csv'});
  const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download='dashboard-data.csv'; a.click();
}
function resetDials(){
  const d=DATA.defaultDials;
  const set=(id,v)=>{ const e=$(id); if(e){ e.value=v; const o=$(id+'_out'); if(o)o.textContent=v; } };
  for (const g of ['comprehension','coding']){ if(d[g].strength!==undefined) set('d_'+g+'_strength', d[g].strength); for(const k in d[g].weights) set('d_w_'+g+'_'+k, d[g].weights[k]); }
  for (const k in d.speed.weights) set('d_w_speed_'+k, d.speed.weights[k]);
  for (const k in d.fleet) set('d_fleet_'+k, d.fleet[k]);
}
function wire(){
  document.querySelectorAll('.dial').forEach(inp=>{ inp.addEventListener('input', ()=>{ const o=$(inp.id+'_out'); if(o)o.textContent=inp.value; recompute(); }); });
  $('reset').addEventListener('click', ()=>{ resetDials(); recompute(); });
  $('csv').addEventListener('click', exportCSV);
}
renderEnv(); wire(); recompute();
`;

const runs = loadRuns(RESULTS_DIR, flags.input);
if (!runs.length) {
   console.error('No runs found. Run consolidate-checkpoint (or the suite) first.');
   process.exit(1);
}
const rows = mergeResultRows(runs.flatMap((r) => r.results));
const { models } = computeMetrics(rows);
const caps = loadCapabilities(join(ROOT, 'config/models.yaml'));

// Per-base-model coverage of registry metrics (drives the required-runs panel).
const okByBase = new Map();
for (const r of rows) {
   if (r.status !== 'ok') {
      continue;
   }
   const b = baseModel(r.model);
   if (!okByBase.has(b)) {
      okByBase.set(b, new Set());
   }
   okByBase.get(b).add(String(r.bench));
}
const coverage = {};
for (const [base, present] of okByBase) {
   const missing = [];
   for (const [metric, e] of Object.entries(BENCH_REGISTRY)) {
      const has = e.benches.some((p) => [...present].some((b) => benchMatches(p, b)));
      if (!has) {
         missing.push(metric);
      }
   }
   coverage[base] = { present: [...present].sort(), missing };
}

// Attach capability_note/tools per model for the breakdown.
for (const m of models) {
   const c = caps.get(m.base_model);
   m.tools = c?.tools ?? null;
   m.capability_note = c?.note ?? null;
}

const data = {
   generated: new Date().toISOString(),
   sources: runs.map((r) => `${r.run_id} (${r.kind}/${r.status})`),
   environment: runs[0]?.environment ?? null,
   environments: runs.map((r) => r.environment ?? null),
   models,
   registry: BENCH_REGISTRY,
   groups: GROUPS,
   defaultDials: DEFAULT_DIALS,
   fleetRequired: FLEET_REQUIRED,
   coverage,
};

// Inline the canonical scoring module (exports stripped) so the browser re-scores with
// the exact same code path as Node — the no-drift guarantee.
const scoringSrc = readFileSync(join(ROOT, 'shared/scoring.mjs'), 'utf8').replace(/^(\s*)export\s+/gm, '$1');

// ── Controls: generate dial inputs from DEFAULT_DIALS (mirrors getDials in the UI) ──
function slider(id, value, { min = 0, max = 1, step = 0.01 } = {}) {
   return `<label class="dial-row"><span class="dial-name">${id.replace(/^d_(w_)?/, '').replace(/_/g, ' ')}</span>
     <input class="dial" type="range" id="${id}" min="${min}" max="${max}" step="${step}" value="${value}">
     <output id="${id}_out">${value}</output></label>`;
}
function numField(id, value, step) {
   return `<label class="dial-row"><span class="dial-name">${id.replace('d_fleet_', '').replace(/_/g, ' ')}</span>
     <input class="dial" type="number" id="${id}" value="${value}" step="${step}"></label>`;
}
function groupControls(name) {
   const g = DEFAULT_DIALS[name];
   let h = `<fieldset><legend>${name}${g.strength !== undefined ? ' · contribution' : ''}</legend>`;
   if (g.strength !== undefined) {
      h += slider(`d_${name}_strength`, g.strength, { min: 0, max: 2, step: 0.05 });
   }
   for (const [k, v] of Object.entries(g.weights ?? {})) {
      h += slider(`d_w_${name}_${k}`, v);
   }
   h += '</fieldset>';
   return h;
}
const fleetControls = (() => {
   const f = DEFAULT_DIALS.fleet;
   let h = '<fieldset><legend>fleet</legend>';
   h += numField('d_fleet_worker_ctx', f.worker_ctx, 1024);
   h += numField('d_fleet_parallel_overhead', f.parallel_overhead, 64);
   h += numField('d_fleet_reserve', f.reserve, 64);
   h += slider('d_fleet_w_thru', f.w_thru);
   h += slider('d_fleet_w_lat', f.w_lat);
   h += '</fieldset>';
   return h;
})();
const controlsHtml = groupControls('comprehension') + groupControls('coding') + groupControls('speed') + fleetControls;

const html = buildHtml({ data, scoringSrc, controlsHtml });
writeFileSync(flags.output, html, 'utf8');
console.log(`Dashboard written: ${flags.output}  (${(html.length / 1024).toFixed(1)} KB, ${models.length} model variants)`);

// ── HTML assembly ────────────────────────────────────────────────────────────────
function buildHtml({ data, scoringSrc, controlsHtml }) {
   return [
      '<!doctype html><html lang="en"><head><meta charset="utf-8">',
      '<meta name="viewport" content="width=device-width, initial-scale=1">',
      '<title>llm-bench dashboard</title>',
      `<style>${CSS}</style></head><body>`,
      '<header><h1>llm-bench dashboard</h1><div id="env"></div><div id="banner"></div></header>',
      '<main>',
      '<aside id="controls"><div class="ctl-head"><strong>Dials</strong><button id="reset">reset</button><button id="csv">CSV</button></div>',
      `<p class="note">Structure is fixed: <code>capability = coding × comprehension</code>; fleet = capability × speed_term. Dials only.</p>`,
      controlsHtml,
      '</aside>',
      '<section id="panels">',
      '<div class="panel"><h2>Capability ranking</h2><div id="cap"></div></div>',
      '<div class="panel"><h2>Fleet suitability</h2><div id="fleet"></div></div>',
      '<div class="panel"><h2>Context size</h2><div id="ctx"></div></div>',
      '<div class="panel"><h2>Per-model breakdown</h2><div id="breakdown"></div></div>',
      '<div class="panel"><h2>Data sources / required runs</h2><div id="required"></div></div>',
      '</section></main>',
      `<script type="module">`,
      scoringSrc,
      `\nconst DATA = ${JSON.stringify(data)};\n`,
      UI_JS,
      '</script></body></html>',
   ].join('\n');
}
