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
import {
   baseModel,
   computeMetrics,
   DEFAULT_DIALS,
   GROUPS,
   loadCapabilities,
   loadRuns,
   mergeResultRows,
   stripVariant,
} from '../shared/results-store.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RESULTS_DIR = join(ROOT, 'results');
const { values: flags } = parseArgs({
   options: {
      input: { type: 'string', multiple: true },
      output: { type: 'string', default: join(RESULTS_DIR, 'dashboard.html') },
   },
});

// ── Build-time html tagged template ───────────────────────────────────────────
// Auto-escapes all ${} interpolations. Nested html`…` calls (HRaw instances) are
// inserted verbatim. Arrays of HRaw/strings are joined without separator.
class HRaw {
   constructor(s) {
      this.s = s;
   }
   toString() {
      return this.s;
   }
   valueOf() {
      return this.s;
   }
}
const esc = (s) =>
   String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
function html(strings, ...vals) {
   let out = strings[0];
   for (let i = 0; i < vals.length; i++) {
      const v = vals[i];
      out +=
         v instanceof HRaw
            ? v.s
            : Array.isArray(v)
              ? v.map((x) => (x instanceof HRaw ? x.s : esc(String(x ?? '')))).join('')
              : esc(String(v ?? ''));
      out += strings[i + 1];
   }
   return new HRaw(out);
}
html.raw = (s) => new HRaw(String(s ?? ''));

const CSS = `
:root{--bg:#0f0f13;--panel:#18181f;--text:#e0e0e0;--dim:#888;--accent:#c8b6ff;--good:#82dc82;--warn:#ffc850}
*{box-sizing:border-box}
html,body{max-width:100%;overflow-x:hidden}
body{margin:0;background:var(--bg);color:var(--text);font:13px/1.4 'Segoe UI',Arial,sans-serif}
header{padding:12px 18px;border-bottom:1px solid #26262f}
h1{font-size:18px;margin:0 0 4px;color:var(--accent)}
#env{color:var(--dim);font-size:11px}
.warn{margin-top:6px;color:#1a1a1a;background:var(--warn);padding:4px 8px;border-radius:4px;display:inline-block}
/* Single column: no sidebar. Controls live above the section they drive. */
main{width:80%;margin:0 auto;display:flex;flex-direction:column;gap:16px;padding:16px}
@media(max-width:900px){main{width:100%}}
.toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
button{background:#26262f;color:var(--text);border:1px solid #3a3a47;border-radius:4px;padding:4px 12px;cursor:pointer}
button:hover{border-color:var(--accent)}
.note{color:var(--dim);font-size:11px;margin:0;flex-basis:100%}
.panel{background:var(--panel);border:1px solid #26262f;border-radius:8px;padding:10px 14px;min-width:0}
h2{font-size:14px;margin:0 0 8px;color:#a0a0c0}
/* Collapsible per-section controls (replaces the sidebar). */
details.controls{margin:0 0 10px;border:1px solid #2a2a35;border-radius:6px;background:#14141a;padding:2px 10px}
details.controls>summary{cursor:pointer;color:var(--accent);font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;padding:5px 0;list-style:none}
details.controls>summary::-webkit-details-marker{display:none}
details.controls>summary::before{content:'▸ ';color:var(--dim)}
details.controls[open]>summary::before{content:'▾ '}
.dials{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:0 18px;padding-bottom:4px}
fieldset{border:1px solid #2a2a35;border-radius:6px;margin:6px 0;padding:6px 10px;min-width:0}
legend{color:var(--accent);font-size:11px;text-transform:capitalize}
.dial-row{display:grid;grid-template-columns:1fr 84px 38px;gap:6px;align-items:center;margin:3px 0;font-size:11px}
.dial-name{color:var(--dim);text-transform:capitalize}
input[type=range]{width:100%;min-width:0}
input[type=number]{width:84px;min-width:0;background:#0f0f13;color:var(--text);border:1px solid #3a3a47;border-radius:3px}
output{color:var(--accent);text-align:right;font-variant-numeric:tabular-nums}
/* Wide tables scroll WITHIN their panel so the page itself never scrolls sideways. */
.tbl{overflow-x:auto;-webkit-overflow-scrolling:touch}
table{width:100%;border-collapse:collapse;font-size:12px}
th,td{text-align:left;padding:3px 8px;border-bottom:1px solid #23232c;font-variant-numeric:tabular-nums;white-space:nowrap}
th{color:var(--dim);font-weight:600;font-size:10px;text-transform:uppercase}
th[title],dt[title],.raw-title[title]{cursor:help;text-decoration:underline dotted var(--dim)}
code{color:#9fe7d6;font-size:11px}
.dim{color:var(--dim)} .warn-t{color:var(--warn)} .ok-t{color:var(--good)}
.rf{font-size:9px;color:var(--dim);margin-left:1px;cursor:help} .rf-t{color:var(--accent)}
.stars{color:#ffd54a;letter-spacing:1px;white-space:nowrap}
tr.top5 td{background:rgba(255,213,74,0.06)}
tr.model-row{cursor:pointer}
tr.model-row:hover td{background:rgba(200,182,255,0.04)}
tr.raw-row{display:none}
tr.raw-row.open{display:table-row}
tr.raw-row>td{padding:8px 14px 12px;border-top:none;background:#111118}
.raw-grid{display:flex;flex-wrap:wrap;gap:10px 20px}
.raw-section{min-width:150px}
.raw-title{color:var(--accent);font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;margin:0 0 4px}
.raw-dl{margin:0;display:grid;grid-template-columns:auto 1fr;gap:1px 8px;font-size:11px}
.raw-dl dt{color:var(--dim);white-space:nowrap}
.raw-dl dd{margin:0;font-variant-numeric:tabular-nums}
.depth-pills{display:flex;flex-wrap:wrap;gap:3px}
.depth-pill{display:flex;flex-direction:column;align-items:center;background:#1a1a22;border:1px solid #2a2a38;border-radius:4px;padding:2px 6px;min-width:34px}
.depth-pill .dk{font-size:9px;color:var(--dim)}
.depth-pill .dv{font-size:11px;font-variant-numeric:tabular-nums}
@media(max-width:640px){
  header{padding:10px 12px}
  h1{font-size:16px}
  main{padding:10px;gap:12px}
  .panel{padding:8px 10px}
  .dials{grid-template-columns:1fr}
}
`;

// Browser JS — runs entirely client-side. Uses the same html`` helper (inlined below)
// so render functions are template-driven rather than raw string concatenation.
const UI_JS = `
const $ = (id) => document.getElementById(id);
const fmt = (n,d=1) => (n==null||!isFinite(n))?'–':Number(n).toFixed(d);
const pct = (n) => (n==null||!isFinite(n))?'–':(n*100).toFixed(1)+'%';
const esc = (s) => String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

// html tagged template — auto-escapes strings, passes HRaw instances through verbatim.
// Use html.raw(s) to mark already-safe HTML. Nested html\`…\` calls are HRaw and compose correctly.
class HRaw { constructor(s){this.s=s} toString(){return this.s} valueOf(){return this.s} }
function html(strings,...vals){
  let out=strings[0];
  for(let i=0;i<vals.length;i++){
    const v=vals[i];
    out += v instanceof HRaw ? v.s
         : Array.isArray(v) ? v.map(x=>x instanceof HRaw?x.s:esc(String(x??''))).join('')
         : esc(String(v??''));
    out += strings[i+1];
  }
  return new HRaw(out);
}
html.raw = (s) => new HRaw(String(s??''));

// Capability-rank star badges (top 5): rank 1 → ★★★★★ … rank 5 → ★☆☆☆☆.
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
  if (d.quality_decay) d.quality_decay.weight = num('d_quality_decay_weight', d.quality_decay.weight);
  return d;
}

function toggleRaw(el){
  const id=el.dataset.rawid; const r=document.getElementById(id); if(r) r.classList.toggle('open');
}

// ── HTML helpers ──────────────────────────────────────────────────────────────

function pill(label, val){
  return html\`<span class="depth-pill"><span class="dk">\${label}</span><span class="dv">\${val}</span></span>\`;
}

// headers: array of strings or [label, tooltip] pairs.
function th(x){
  return Array.isArray(x)
    ? html\`<th title="\${x[1]}">\${x[0]}</th>\`
    : html\`<th>\${x}</th>\`;
}

// Cells may be strings (will be escaped), HRaw instances (inserted verbatim), or
// html\`…\` results. Callers are responsible for wrapping trusted HTML in html.raw().
function tbl(headers, rows, rowClasses){
  return html\`<table>
    <thead><tr>\${headers.map(th)}</tr></thead>
    <tbody>\${rows.map((r,i)=>html\`<tr\${rowClasses?.[i]?html\` class="\${rowClasses[i]}"\`:html.raw('')}>
      \${r.map(c=>html\`<td>\${c instanceof HRaw?c:html.raw(String(c??''))}</td>\`)}
    </tr>\`)}</tbody>
  </table>\`;
}

function renderRawMetrics(m){
  return html\`<div class="raw-grid">
    <div class="raw-section">
      <p class="raw-title" title="Token generation and prompt-processing speeds measured at various context depths">Speed</p>
      <dl class="raw-dl">
        \${m.speedTg!=null?html\`<dt title="Token generation speed at zero KV-cache depth (empty context)">Decode</dt><dd>\${fmt(m.speedTg)} tok/s</dd>\`:''}
        \${m.prefill4k!=null?html\`<dt title="Prompt processing speed with a 4 k-token context (prefill phase)">Prefill @4k</dt><dd>\${fmt(m.prefill4k,0)} tok/s</dd>\`:''}
        \${m.prefill12k!=null?html\`<dt title="Prompt processing speed with a 12 k-token context — longer prompts benefit most from high prefill speed">Prefill @12k</dt><dd>\${fmt(m.prefill12k,0)} tok/s</dd>\`:''}
        \${m.decodeRetentionPct!=null?html\`<dt title="Decode speed retained at this KV-cache depth vs baseline (100% = no slowdown as context fills)">Decay@\${m.decodeRefDepth!=null?Math.round(m.decodeRefDepth/1024)+'k':'?'}</dt><dd>\${m.decodeRetentionPct}% · \${m.decodeRef!=null?fmt(m.decodeRef):'–'} tok/s</dd>\`:''}
      </dl>
    </div>
    <div class="raw-section">
      <p class="raw-title" title="Context window size, latency and caching characteristics">Context</p>
      <dl class="raw-dl">
        \${m.maxctx?html\`<dt title="Maximum tokens that fit coherently in VRAM, confirmed by a coherence probe">Max ctx</dt><dd>\${m.maxctx.toLocaleString()} tok</dd>\`:''}
        \${m.ttft8kMs!=null?html\`<dt title="Time-to-first-token with an 8 k prompt, cold KV cache (no prefix cached)">TTFT @8k</dt><dd>\${(m.ttft8kMs/1000).toFixed(1)} s</dd>\`:''}
        \${m.prefixCache?.speedup!=null?html\`<dt title="Cold vs warm TTFT ratio — how much faster repeated prompts are once the prefix is cached">Cache speedup</dt><dd>\${fmt(m.prefixCache.speedup,0)}×</dd>\`:''}
        \${m.pargenCurve?.length?html\`<dt title="Aggregate tokens/second at K simultaneous requests (K=1 is single-stream decode speed)">Parallel gen</dt><dd>\${html.raw(m.pargenCurve.map(p=>fmt(p.tps,0)+'@K'+p.conc).join(' · '))} tok/s</dd>\`:''}
      </dl>
    </div>
    <div class="raw-section">
      <p class="raw-title" title="VRAM usage and power draw during inference">Memory</p>
      <dl class="raw-dl">
        \${m.kvPerTokMiB!=null?html\`<dt title="KV-cache memory per token (KiB). Lower = more context fits in the same VRAM.">KV/tok</dt><dd>\${(m.kvPerTokMiB*1024).toFixed(1)} KiB</dd>\`:''}
        \${m.maxctxVram!=null?html\`<dt title="GPU memory used when running at the maximum supported context">VRAM @max ctx</dt><dd>\${Math.round(m.maxctxVram)} MiB</dd>\`:''}
        \${m.powerEff!=null?html\`<dt title="GPU power draw during inference (watts). Measured via struct-output bench.">Power</dt><dd>\${fmt(m.powerEff,0)} W</dd>\`:''}
      </dl>
    </div>
    \${m.qualityCurve?.length?html\`<div class="raw-section">
      <p class="raw-title" title="Recall accuracy at each tested context depth. Values drop as the target information is buried deeper in the context.">Quality at depth</p>
      <div class="depth-pills">\${m.qualityCurve.map(({depth,acc})=>pill(Math.round(depth/1024)+'k',Math.round(acc)+'%'))}</div>
    </div>\`:''}
    \${m.ttftCurve?.length>1?html\`<div class="raw-section">
      <p class="raw-title" title="Time-to-first-token (seconds) at each tested prompt depth. Grows with prompt length because prefill is O(n).">TTFT</p>
      <div class="depth-pills">\${m.ttftCurve.map(({depth,ms})=>pill(Math.round(depth/1024)+'k',(ms/1000).toFixed(1)+'s'))}</div>
    </div>\`:''}
  </div>\`;
}

function renderEnv(){
  const e=DATA.environment;
  const s = e ? ('runner '+esc(e.runner)+' · '+esc(e.gpu)+' · '+esc(e.backend)+' · fa='+esc(e.server_flags&&e.server_flags.flash_attn)+' · kv='+esc(e.server_flags&&e.server_flags.cache_type_k)) : 'no server fingerprint (pre-fingerprint data)';
  $('env').innerHTML = s+' · sources: '+DATA.sources.map(esc).join(', ');
  const envs=DATA.environments.filter(Boolean); let consistent=true;
  // KV cache type (cache_type_k/v) is an INTENDED per-configuration axis now — q8 and q4
  // rank as separate rows — so ignore it when judging whether merged runs are comparable.
  const envKey=(e)=>{ const c=JSON.parse(JSON.stringify(e)); if(c&&c.server_flags){ delete c.server_flags.cache_type_k; delete c.server_flags.cache_type_v; } return JSON.stringify(c); };
  for (let i=1;i<envs.length;i++){ if (envKey(envs[i])!==envKey(envs[0])) consistent=false; }
  $('banner').innerHTML = consistent ? '' : '<div class="warn">⚠ merged runs have different server configs — numbers may not be comparable.</div>';
}

function recompute(){
  const dials=getDials();
  const ranking=scoreGroups(DATA.models, dials);
  const fleetRes=computeFleet(DATA.models, dials);
  const excl=new Set(fleetRes.fleet.filter(p=>p.n_workers===0).map(p=>mkey(p)));
  const keep=(m)=>!excl.has(mkey(m));
  const filtered=ranking.filter(keep);
  CAPRANK={}; filtered.forEach((m,i)=>{ if(i<5) CAPRANK[mkey(m)]=i+1; });
  renderCap(filtered); renderFleet(fleetRes); renderCtx(DATA.models.filter(keep)); renderBreakdown(DATA.models.filter(keep)); renderRequired(dials);
}

const CAP_HEADERS=[
  ['#','Overall capability rank (1 = best)'],
  ['★','Top-5 capability badge — ★★★★★ = rank 1'],
  ['model','Model name and think-mode variant'],
  ['score','Overall capability score: 80% × √(comprehension × coding) + 20% × quality-decay retention'],
  ['compr.','Comprehension: weighted blend of triage, summarization, docqa and reasoning'],
  ['coding','Coding pass rate: fraction of coding problems with all tests passing'],
  ['competence','Coding competence: pass rate × solution quality grade (penalises low-quality solutions that happen to pass)'],
  ['quality↓','Quality at depth: mean recall accuracy across all tested context lengths (0 k–96 k). Higher = retains quality deeper into long contexts. Click row to see per-depth breakdown.'],
];

function renderCap(ranking){
  const openIds=new Set([...document.querySelectorAll('.raw-row.open')].map(r=>r.id));
  $('cap').innerHTML=html\`<table>
    <thead><tr>\${CAP_HEADERS.map(th)}</tr></thead>
    <tbody>\${ranking.map((m,i)=>{
      const rid='raw_'+slugify(m.model+'_'+m.think);
      const cls=[topClass(m),'model-row'].filter(Boolean).join(' ');
      return html\`
        <tr class="\${cls}" data-rawid="\${rid}" onclick="toggleRaw(this)">
          <td>\${i+1}</td>
          <td>\${html.raw(stars(i+1))}</td>
          <td>\${m.label}</td>
          <td>\${fmt(m.score)}</td>
          <td>\${pct(m.comprehension)}</td>
          <td>\${pct(m.coding)}</td>
          <td>\${pct(m.codingCompetence)}</td>
          <td>\${m.qualityMean!=null?html\`\${fmt(m.qualityMean,1)}%\`:html\`<span class="dim">–</span>\`}</td>
        </tr>
        <tr class="raw-row\${openIds.has(rid)?' open':''}" id="\${rid}">
          <td colspan="8">\${renderRawMetrics(m)}</td>
        </tr>\`;
    })}</tbody>
  </table>\`;
}

function renderFleet(res){
  const fv=(p)=>p.fleet_suitability==null?-Infinity:p.fleet_suitability;
  const sorted=res.fleet.filter(p=>p.n_workers==null||p.n_workers>0).sort((a,b)=>fv(b)-fv(a));
  const mainCtx=(p)=>p.main_ctx==null?'–':p.main_ctx.toLocaleString();
  const workers=(p)=>p.n_workers==null?'–':'+'+p.n_workers+'×'+Math.round((p.worker_ctx||0)/1024)+'k';
  const rows=sorted.map((p,i)=>[
    String(i+1),
    html.raw(stars(CAPRANK[mkey(p)])),
    p.label,
    pct(p.capability),
    p.fleet_suitability==null
      ? html\`<span class="dim">\${p.reason||'–'}</span>\`
      : html.raw(fmt(p.fleet_suitability,3)),
    mainCtx(p),
    workers(p),
    p.agg_tps==null?'–':fmt(p.agg_tps,0),
    pct(p.capacity_norm),
    pct(p.latency_norm),
  ]);
  $('fleet').innerHTML=tbl([
    ['#','Fleet-suitability rank'],
    ['★','Top-5 capability badge'],
    ['model','Model name and variant'],
    ['cap','Capability score from the main ranking'],
    ['fleet','Fleet suitability score: capability × context reach × throughput × concurrency. Tune the dials above.'],
    ['main ctx','Tokens allocated to the primary inference slot'],
    ['+workers','Additional parallel slots: count × context each (e.g. +4×32k = 4 extra 32k slots)'],
    ['agg tok/s','Aggregate tokens per second at K=8 concurrent requests (from parallel-gen bench)'],
    ['capacity','Normalised capacity: total concurrent context fit vs fleet baseline'],
    ['latency','Normalised latency: decode speed + TTFT at depth (higher = faster responses)'],
  ], rows, sorted.map(topClass));
}

function renderCtx(models){
  const list=models.slice().filter(m=>m.maxctx).sort((a,b)=>(b.maxctx||0)-(a.maxctx||0));
  const rows=list.map(m=>[
    html.raw(stars(CAPRANK[mkey(m)])),
    m.label,
    m.maxctx.toLocaleString(),
    m.maxctxVram==null?'–':Math.round(m.maxctxVram)+'M',
    m.kvPerTokMiB==null?'–':(m.kvPerTokMiB*1024).toFixed(1),
  ]);
  $('ctx').innerHTML=tbl([
    ['★','Top-5 capability badge'],
    ['model','Model name and variant'],
    ['max ctx','Maximum tokens that fit coherently in VRAM, verified by coherence probe (OOM or incoherent outputs cut it lower)'],
    ['vram@max','VRAM used when running at max context (MiB)'],
    ['KV KiB/tok','KV-cache memory per token (KiB). Lower = more context fits in the same VRAM.'],
  ], rows, list.map(topClass));
}

const BKEYS=['triage','summarization','docqa','reasoning','grade','agentic_loop','instruction_following','toolcalling','struct_output','e2e_throughput','cold_ttft','warm_ttft'];
const BKEY_TIPS={
  triage:'Triage: structured JSON extraction + hallucination detection across varied prompts. Scores penalise missing fields and hallucinated content.',
  summarization:'Summarization: deterministic rubric — keyword coverage (25%), area classification (30%), tag format (30%), length check (15%). Score is fleet-normalised.',
  docqa:'Document Q&A: accuracy on long-document questions including recall at or near the maximum context limit.',
  reasoning:'Reasoning: accuracy on logic, math and multi-step deduction problems.',
  grade:'Coding grade: average quality score (0–10) for solutions that pass all tests — separates elegant from barely-passing code.',
  agentic_loop:'Agentic loop: success rate on multi-step tool-call chains, including tasks that require error recovery.',
  instruction_following:'Instruction following: fraction of explicit formatting/content constraints obeyed (e.g. word limits, forbidden phrases, output structure).',
  toolcalling:'Tool calling: schema conformance on function-call outputs (argument names, types, required fields).',
  struct_output:'Structured output: valid + schema-conformant JSON rate under unconstrained sampling (no grammar forcing).',
  e2e_throughput:'End-to-end throughput at 8 k prefill: tokens/s including TTFT. High prefill speed boosts this; low TTFT matters most for short responses.',
  cold_ttft:'Cold TTFT: time-to-first-token at 8 k depth with empty KV cache. Normalised: higher = faster.',
  warm_ttft:'Warm TTFT: time-to-first-token with prefix already cached. Measures prefix-cache effectiveness. Normalised: higher = faster.',
};

// Per-metric routing badge for [best-of] rows: ᵀ = think won this task, ᴺ = no-think won.
// Only the per-variant capability metrics are routed (grade is no_think-only, not a choice).
const ROUTED_BKEYS=new Set(['triage','summarization','docqa','reasoning','toolcalling']);
function rfBadge(m,k){
  const src=m.routedFrom&&ROUTED_BKEYS.has(k)?m.routedFrom[k]:null;
  if(!src) return '';
  const t=src==='think';
  return '<sup class="rf'+(t?' rf-t':'')+'" title="routed from '+(t?'think':'no-think')+'">'+(t?'ᵀ':'ᴺ')+'</sup>';
}
function renderBreakdown(models){
  const list=models.slice().sort((a,b)=>(b.capability==null?-1:b.capability)-(a.capability==null?-1:a.capability));
  const rows=list.map(m=>[
    html.raw(stars(CAPRANK[mkey(m)])),
    m.label,
    ...BKEYS.map(k=>m.norm[k]==null?html\`<span class="dim">–</span>\`:html.raw(pct(m.norm[k])+rfBadge(m,k))),
  ]);
  const headers=[['★','Top-5 capability badge'],['model','Model name and variant'],...BKEYS.map(k=>[k,BKEY_TIPS[k]||k])];
  const legend=list.some(m=>m.routedFrom)
    ? '<p class="note"><b>[best-of]</b> rows route each task to its better mode: <sup class="rf rf-t">ᵀ</sup> think won, <sup class="rf">ᴺ</sup> no-think won. Oracle upper bound — assumes perfect per-task selection, not a single achievable config.</p>'
    : '';
  $('breakdown').innerHTML=tbl(headers, rows, list.map(topClass))+legend;
}

function renderRequired(dials){
  const used=new Set();
  for (const g of ['comprehension','coding','speed']) for (const k in (dials[g].weights||{})) if (dials[g].weights[k]>0) used.add(k);
  ['toolcalling','struct_output'].forEach(k=>used.add(k));
  DATA.fleetRequired.forEach(k=>used.add(k));
  const byRunner={};
  for (const k of used){ const e=DATA.registry[k]; if(!e) continue; byRunner[e.runner]=byRunner[e.runner]||{command:e.command,metrics:new Set(),missing:new Set()}; byRunner[e.runner].metrics.add(k); }
  for (const base in DATA.coverage){ for (const k of DATA.coverage[base].missing){ if(used.has(k)){ const e=DATA.registry[k]; if(e&&byRunner[e.runner]) byRunner[e.runner].missing.add(base); } } }
  $('required').innerHTML=html\`<table>
    <thead><tr><th>runner</th><th>command</th><th>feeds</th><th>missing for</th></tr></thead>
    <tbody>\${Object.entries(byRunner).map(([r,o])=>{
      const miss=[...o.missing];
      return html\`<tr>
        <td>\${r}</td>
        <td><code>\${o.command}</code></td>
        <td>\${html.raw([...o.metrics].join(', '))}</td>
        <td>\${miss.length
          ?html\`<span class="warn-t">\${miss.length}: \${html.raw(miss.map(esc).join(', '))}</span>\`
          :html\`<span class="ok-t">complete</span>\`}
        </td>
      </tr>\`;
    })}</tbody>
  </table>\`;
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
  if(d.quality_decay) set('d_quality_decay_weight', d.quality_decay.weight);
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
   const c = caps.get(m.base_model) ?? caps.get(stripVariant(m.base_model));
   m.tools = c?.tools ?? null;
   m.capability_note = c?.note ?? null;
   m.disabled = c?.disabled ?? false;
   if (c?.label) {
      m.label = m.think !== 'n/a' ? `${c.label} [${m.think}]` : c.label;
   }
}

// Drop disabled models. Think variants are kept — each (model, think) pair ranks as its
// own row, matching report.json (the prior --skip-think-era filter hid the think pass).
const visibleModels = models.filter((m) => !m.disabled);
models.length = 0;
models.push(...visibleModels);

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

// ── Controls: generate dial inputs from DEFAULT_DIALS ─────────────────────────
function slider(id, value, { min = 0, max = 1, step = 0.01 } = {}) {
   const name = id.replace(/^d_(w_)?/, '').replace(/_/g, ' ');
   return html`<label class="dial-row">
      <span class="dial-name">${name}</span>
      <input class="dial" type="range" id="${id}" min="${min}" max="${max}" step="${step}" value="${value}">
      <output id="${id}_out">${value}</output>
   </label>`;
}

function numField(id, value, step) {
   const name = id.replace('d_fleet_', '').replace(/_/g, ' ');
   return html`<label class="dial-row">
      <span class="dial-name">${name}</span>
      <input class="dial" type="number" id="${id}" value="${value}" step="${step}">
   </label>`;
}

function groupControls(name) {
   const g = DEFAULT_DIALS[name];
   return html`<fieldset>
      <legend>${name}${g.strength !== undefined ? ' · contribution' : ''}</legend>
      ${g.strength !== undefined ? slider(`d_${name}_strength`, g.strength, { min: 0, max: 2, step: 0.05 }) : ''}
      ${Object.entries(g.weights ?? {}).map(([k, v]) => slider(`d_w_${name}_${k}`, v))}
   </fieldset>`;
}

const fleetControls = (() => {
   const f = DEFAULT_DIALS.fleet;
   return html`<fieldset>
      <legend>fleet</legend>
      ${numField('d_fleet_worker_ctx', f.worker_ctx, 1024)}
      ${numField('d_fleet_parallel_overhead', f.parallel_overhead, 64)}
      ${numField('d_fleet_reserve', f.reserve, 64)}
      ${slider('d_fleet_w_thru', f.w_thru)}
   </fieldset>`;
})();

const qdWeight = DEFAULT_DIALS.quality_decay.weight;
const qdControls = html`<fieldset><legend>quality decay blend</legend>${slider('d_quality_decay_weight', qdWeight)}</fieldset>`;
const capControls = html`${groupControls('comprehension')}${groupControls('coding')}${qdControls}`;
const fleetControlsHtml = html`${groupControls('speed')}${fleetControls}`;

const htmlOut = buildHtml({ data, scoringSrc, capControls, fleetControlsHtml });
writeFileSync(flags.output, String(htmlOut), 'utf8');
console.log(`Dashboard written: ${flags.output}  (${(String(htmlOut).length / 1024).toFixed(1)} KB, ${models.length} model variants)`);

// ── HTML assembly ─────────────────────────────────────────────────────────────
function buildHtml({ data, scoringSrc, capControls, fleetControlsHtml }) {
   return html`<!doctype html><html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>llm-bench dashboard</title>
<style>${html.raw(CSS)}</style>
</head>
<body>
<header><h1>llm-bench dashboard</h1><div id="env"></div><div id="banner"></div></header>
<main>
<div class="toolbar">
   <button id="reset">reset dials</button><button id="csv">CSV</button>
   <p class="note">Structure: <code>score = 0.8×(coding×comprehension) + 0.2×quality_decay_norm</code>; fleet = score × speed_term. Dials only re-rank — nothing is written back. Click any row to expand raw metrics.</p>
</div>
<section class="panel"><h2>Capability ranking</h2>
   <details class="controls" open><summary>Adjust capability weights</summary><div class="dials">${capControls}</div></details>
   <div id="cap" class="tbl"></div>
</section>
<section class="panel"><h2>Fleet suitability</h2>
   <details class="controls" open><summary>Adjust fleet &amp; speed weights</summary><div class="dials">${fleetControlsHtml}</div></details>
   <div id="fleet" class="tbl"></div>
</section>
<section class="panel"><h2>Context size</h2><div id="ctx" class="tbl"></div></section>
<section class="panel"><h2>Per-model breakdown</h2><div id="breakdown" class="tbl"></div></section>
<section class="panel"><h2>Data sources / required runs</h2><div id="required" class="tbl"></div></section>
</main>
<script type="module">
${html.raw(scoringSrc)}
const DATA = ${html.raw(JSON.stringify(data))};
${html.raw(UI_JS)}
</script>
</body>
</html>`;
}
