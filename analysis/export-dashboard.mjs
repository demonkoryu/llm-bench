#!/usr/bin/env node
// Static export — snapshots the tidy store into ONE self-contained, responsive
// results/dashboard.html for pages.xor0.de + mobile. No server: the data, the pure
// scorer (analysis/score.mjs), a metric catalog, and a client-side query engine are
// all inlined. A fetch() shim answers /api/* from in-browser compute so the SAME
// app/web/app.js runs unchanged. `npm run dashboard:export`.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { query } from '../shared/tidy-store.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RESULTS = join(ROOT, 'results');
const WEB = join(ROOT, 'app', 'web');

// Inline the pure scorer as classic script: strip its import line + `export`s so
// scoring-config's consts and score's functions share the page's global scope.
function inlineScorer() {
   const cfg = readFileSync(join(ROOT, 'analysis/scoring-config.mjs'), 'utf8').replace(/^export /gm, '');
   const score = readFileSync(join(ROOT, 'analysis/score.mjs'), 'utf8')
      .replace(/^import[^\n]*\n/gm, '')
      .replace(/^export /gm, '');
   return cfg + '\n' + score;
}

// Client engine + metric catalog + fetch shim (mirrors app/server.mjs in JS over ROWS).
const ENGINE = `
const ROWS = window.__ROWS__;
const FACET_DIMS = ['family','arch','type','finetune','quant','kv_quant','chat_template','think_mode','backend','gpu','llamacpp_build','sampling_profile'];
const PIVOT_DIMS = ['gguf_file', ...FACET_DIMS];
const _n = v => (typeof v === 'number' && isFinite(v)) ? v : null;
const sumF = (rows, p) => rows.reduce((a,r)=> (p(r) && _n(r.metric_value)!=null) ? a+r.metric_value : a, 0);
const cntF = (rows, p) => rows.reduce((a,r)=> (p(r) && _n(r.metric_value)!=null) ? a+1 : a, 0);
const avgF = (rows, p) => { const c=cntF(rows,p); return c ? sumF(rows,p)/c : null; };
const maxF = (rows, p) => { const xs=rows.filter(r=>p(r)&&_n(r.metric_value)!=null).map(r=>r.metric_value); return xs.length?Math.max(...xs):null; };
const M = {
  'toolcalling %': {fn: r => { const t=sumF(r,x=>x.metric==='toolcall_total'); return t?100*sumF(r,x=>x.metric==='toolcall_pass')/t:null; }},
  'reasoning %': {fn: r => { const t=sumF(r,x=>x.metric==='reasoning_total'); return t?100*sumF(r,x=>x.metric==='reasoning_correct')/t:null; }},
  'triage': {fn: r => { const v=avgF(r,x=>/^triage_[RC]\\d+$/.test(x.metric)); return v==null?null:100*v; }},
  'summarization': {fn: r => { const v=avgF(r,x=>/^summ_/.test(x.metric)); return v==null?null:100*v; }},
  'docqa': {fn: r => { const v=avgF(r,x=>/^docqa_/.test(x.metric)); return v==null?null:10*v; }},
  'struct_output %': {fn: r => avgF(r,x=>x.bench==='struct_output'&&x.metric==='score')},
  'instruction %': {fn: r => avgF(r,x=>x.bench==='instruction_following'&&x.metric==='score')},
  'agentic %': {fn: r => avgF(r,x=>x.bench==='agentic_loop'&&x.metric==='score')},
  'coding pass@1 %': {fn: r => { const t=sumF(r,x=>x.metric==='coding_total'); return t?100*sumF(r,x=>x.metric==='coding_pass_at_1')/t:null; }},
  'decode tok/s': {fn: r => avgF(r,x=>x.bench==='e2e-8k'&&x.metric==='tok_s')},
  'e2e tok/s': {fn: r => avgF(r,x=>x.bench==='e2e-8k'&&x.metric==='score')},
  'ttft ms': {fn: r => avgF(r,x=>x.bench==='ttft-8k'&&x.metric==='score'), lower:true},
  'maxctx': {fn: r => maxF(r,x=>x.bench==='maxctx'&&x.metric==='score')},
  'VRAM MiB': {fn: r => maxF(r,x=>x.bench==='maxctx'&&x.metric==='vram_mib'), lower:true},
  'KV bytes/tok': {fn: r => { const v=avgF(r,x=>x.bench==='kv_per_tok'&&x.metric==='score'); return v==null?null:1024*v; }, lower:true},
};
const filt = (facets) => ROWS.filter(r => Object.entries(facets||{}).every(([d,vs]) => !vs || !vs.length || vs.includes(r[d])));
const groupBy = (rows, keyFn) => { const m=new Map(); for (const r of rows){ const k=keyFn(r); if(!m.has(k))m.set(k,[]); m.get(k).push(r);} return m; };
function meta(){ return { metrics:Object.keys(M), lowerMetrics:Object.entries(M).filter(([,m])=>m.lower).map(([k])=>k), dims:FACET_DIMS, pivotDims:PIVOT_DIMS }; }
function facets(){ const o={}; for(const d of FACET_DIMS){ o[d]=[...new Set(ROWS.map(r=>r[d]).filter(v=>v!=null))].sort(); } return o; }
function pivot(b){ const rows=filt(b.facets); const mfn=M[b.metric].fn; const rset=new Set(),cset=new Set(),cm=new Map();
  for(const [k,grp] of groupBy(rows, r=>JSON.stringify([r[b.rowsDim],r[b.colsDim]]))){ const [rr,cc]=JSON.parse(k); if(cc==null)continue; rset.add(rr); cset.add(cc); cm.set(rr+'\\u241f'+cc, mfn(grp)); }
  const rows2=[...rset].sort(), cols=[...cset].sort();
  const cells=rows2.map(rr=>{ const base=b.baseline!=null?cm.get(rr+'\\u241f'+b.baseline):null; return { r:rr, vals:cols.map(cc=>{ const v=cm.get(rr+'\\u241f'+cc)??null; return {c:cc,v,delta:(base!=null&&v!=null)?v-base:null}; }) }; });
  return { rows:rows2, cols, cells, metric:b.metric, lower:!!M[b.metric].lower, baseline:b.baseline }; }
function paretoPts(rows, xf, yf, vf, think){ const rs=rows.filter(r=>r.think_mode==='n/a'||r.think_mode===think); const out=[];
  for(const [k,grp] of groupBy(rs, r=>JSON.stringify([r.gguf_file,r.quant,r.kv_quant,r.chat_template,r.arch,r.active_params,r.total_params]))){
    const [g,q,kv,ct,arch,ap,tp]=JSON.parse(k); const x=xf(grp),y=yf(grp); if(x==null||y==null)continue;
    out.push({x,y,vram:vf(grp),arch,think,cfg:{gguf_file:g,quant:q,kv_quant:kv,chat_template:ct,think},label:(g.replace('.gguf','')+' '+(kv||'')+' '+ct+' ['+think+']').replace(/\\s+/g,' ').trim(),dims:{gguf_file:g,arch,active_params:ap,total_params:tp}}); }
  return out; }
function pareto(b){ const think=b.think||'both'; const rows=filt(b.facets); const xf=M[b.xMetric].fn, yf=M[b.yMetric].fn, vf=M['VRAM MiB'].fn;
  const modes=think==='both'?['no_think','think']:[think]; const points=modes.flatMap(m=>paretoPts(rows,xf,yf,vf,m));
  return { points, xMetric:b.xMetric, yMetric:b.yMetric, think }; }
function leaderboard(b){ const think=b.think||'both'; const rows=filt(b.facets); const dials=b.dials||DEFAULT_DIALS;
  if(think!=='both'){ const {entities,denom}=scoreSelection(rows,{think,dials}); return {entities,denom,count:rows.length}; }
  const variants=new Map();
  for(const r of rows){ const k=entityKey(r); const tm=r.think_mode||'n/a'; if(!variants.has(k))variants.set(k,new Set()); if(tm!=='n/a')variants.get(k).add(tm); }
  const noT=scoreSelection(rows,{think:'no_think',dials}); const yesT=scoreSelection(rows,{think:'think',dials}); const entities=[];
  for(const e of noT.entities){ const v=variants.get(e.key)||new Set(); if(v.size===0){e.think='n/a';entities.push(e);} else if(v.has('no_think'))entities.push(e); }
  for(const e of yesT.entities){ if((variants.get(e.key)||new Set()).has('think'))entities.push(e); }
  return {entities,denom:noT.denom,count:rows.length}; }
function coverage(b){ const rows=filt(b.facets); const cfg=r=>r.gguf_file.replace('.gguf','')+'|'+(r.kv_quant||'')+'|'+r.chat_template;
  const configs=[...new Set(rows.map(cfg))].sort(), benches=[...new Set(rows.map(r=>r.bench))].sort();
  const have=new Set(rows.map(r=>cfg(r)+'\\u241f'+r.bench));
  return { configs, benches, cells:configs.map(c=>({cfg:c,has:benches.map(bn=>have.has(c+'\\u241f'+bn))})) }; }
const ROUTES = { '/api/pivot':pivot, '/api/pareto':pareto, '/api/leaderboard':leaderboard, '/api/coverage':coverage };
const _resp = (o) => ({ ok:true, json: async()=>o });
const _origFetch = window.fetch ? window.fetch.bind(window) : null;
window.fetch = async (url, opts) => { const u=String(url);
  if (u.endsWith('/api/meta')) return _resp(meta());
  if (u.endsWith('/api/facets')) return _resp(facets());
  for (const [p,fn] of Object.entries(ROUTES)) if (u.endsWith(p)) return _resp(fn(opts&&opts.body?JSON.parse(opts.body):{}));
  return _origFetch ? _origFetch(url,opts) : _resp({}); };
`;

async function main() {
   const rows = await query(RESULTS, `SELECT * FROM $TIDY`);
   const html = readFileSync(join(WEB, 'index.html'), 'utf8');
   const appJs = readFileSync(join(WEB, 'app.js'), 'utf8');
   const dataScript = `<script>window.__ROWS__=${JSON.stringify(rows)};</script>`;
   const inlined = [dataScript, `<script>${inlineScorer()}</script>`, `<script>${ENGINE}</script>`, `<script>${appJs}</script>`].join('\n');
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
