#!/usr/bin/env node
// Build the froggeric chat-template A/B comparison from the run manifest.
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const MAN = join(ROOT, 'results', 'ab-froggeric-manifest.tsv');

const OWNER = {
  'run-suite': ['toolcalling', 'triage', 'reasoning'],
  'agentic-loop': ['agentic_loop'],
  'struct-output': ['struct_output', 'power_eff'],
  'instruction-following': ['instruction_following'],
};
// higher-is-better metric per bench + any secondary signals we surface
const num = (v) => (v === '-' || v === undefined || v === null || v === 'n/a' ? null : Number(v));
function metric(bench, r) {
  switch (bench) {
    case 'toolcalling': return { pct: 100 * r.toolcall_pass / r.toolcall_total, extra: `${r.toolcall_pass}/${r.toolcall_total}` };
    case 'reasoning': return { pct: 100 * r.reasoning_correct / r.reasoning_total, extra: `${r.reasoning_correct}/${r.reasoning_total}`, tok_s: num(r.tok_s) };
    case 'triage': {
      const dims = ['triage_R1','triage_R2','triage_R3','triage_R4','triage_R5','triage_R6','triage_R7','triage_C1','triage_C2'].map((k) => r[k]).filter((x) => typeof x === 'number');
      const rubric = dims.length ? 100 * dims.reduce((a, b) => a + b, 0) / dims.length : null;
      return { pct: rubric, extra: `halls=${r.halls} jf=${r.json_fail}`, halls: num(r.halls), tok_s: num(r.tok_s) };
    }
    case 'agentic_loop': return { pct: num(r.score), extra: (r.notes || '').replace(/·/g, '·') };
    case 'struct_output': return { pct: num(r.score), extra: r.notes || '' };
    case 'instruction_following': return { pct: num(r.score), extra: r.notes || '' };
    case 'power_eff': return { pct: num(r.score), extra: `tps=${r.tok_s}`, tok_s: num(r.tok_s) };
    default: return { pct: num(r.score), extra: r.notes || '' };
  }
}
const baseModel = (m) => m.replace(/--(nothi|think)$/, '');
const shortModel = (m) => baseModel(m).replace(/--kvq5_0$/, '').replace(/-A3B/, '');

const rows = readFileSync(MAN, 'utf8').trim().split('\n').filter(Boolean).map((l) => l.split('\t'));
const cells = new Map(); // key model|think|bench -> {baseline, treatment}
for (const [arch, arm, runner, runId] of rows) {
  const p = join(ROOT, 'results', 'runs', runId, 'run.json');
  if (!existsSync(p)) { console.error(`missing ${runId}`); continue; }
  const j = JSON.parse(readFileSync(p, 'utf8'));
  const owned = OWNER[runner] || [];
  for (const r of j.results) {
    if (!owned.includes(r.bench)) { continue; }
    if (r.status !== 'ok') { continue; }
    const key = `${shortModel(r.model)}|${r.think}|${r.bench}`;
    if (!cells.has(key)) { cells.set(key, {}); }
    cells.get(key)[arm] = metric(r.bench, r);
  }
}

const BENCH_ORDER = ['toolcalling', 'agentic_loop', 'struct_output', 'instruction_following', 'triage', 'reasoning', 'power_eff'];
const keys = [...cells.keys()].sort((a, b) => {
  const [ma, ta, ba] = a.split('|'); const [mb, tb, bb] = b.split('|');
  return ma.localeCompare(mb) || BENCH_ORDER.indexOf(ba) - BENCH_ORDER.indexOf(bb) || ta.localeCompare(tb);
});

console.log('| model | bench | think | baseline | treatment | Δ | notes (base→treat) |');
console.log('|---|---|---|--:|--:|--:|---|');
let wins = 0, losses = 0, ties = 0;
for (const k of keys) {
  const [m, t, b] = k.split('|');
  const c = cells.get(k);
  const base = c.baseline, treat = c.treatment;
  if (!base || !treat) { continue; }
  const bv = base.pct, tv = treat.pct;
  const d = (bv != null && tv != null) ? tv - bv : null;
  const fmt = (x) => (x == null ? '—' : x.toFixed(1));
  const dstr = d == null ? '—' : (d > 0 ? '+' : '') + d.toFixed(1);
  if (d != null) { if (d > 0.5) { wins++;  }else if (d < -0.5) { losses++;  }else { ties++;  }}
  const note = `${base.extra || ''} → ${treat.extra || ''}`;
  console.log(`| ${m} | ${b} | ${t} | ${fmt(bv)} | ${fmt(tv)} | ${dstr} | ${note} |`);
}
console.error(`\nTreatment vs baseline (Δ>0.5 wins): wins=${wins} losses=${losses} ties=${ties}`);
