// Observable Framework config for the llm-bench dashboard.
// Deployed at pages.xor0.de/llm-bench/ (Caddy file_server over /srv/pages/llm-bench),
// so the base path must match. Dark theme to echo the previous explorer's look.
export default {
   title: 'llm-bench',
   root: 'src',
   base: '/llm-bench/',
   theme: ['dark', 'near-midnight'],
   // Plain Caddy file_server can't rewrite /pareto -> pareto.html, so keep .html in links.
   cleanUrls: false,
   // Full-width dashboard: no per-page table-of-contents column (pages have no sub-headings),
   // and a generous content max-width so wide tables/charts use the screen.
   toc: false,
   head:
      '<style>:root{--observablehq-max-width:2000px}#observablehq-center{margin-left:1rem;margin-right:1rem}' +
      // Wide charts scroll horizontally on narrow screens instead of scaling to unreadable —
      // override Plot's default max-width:100% so the SVG keeps its width and the box scrolls.
      '.scroll-x{overflow-x:auto}.scroll-x svg{max-width:none;height:auto}' +
      // Metric glossary (components/metric-help.js): term above description, stacked.
      //
      // NOT a two-column grid. It was `grid-template-columns: max-content 1fr`, which stretched
      // each description across the full 2000px content width — one unreadable 200-character line
      // per metric on a large monitor. Capping the second column and letting the term wrap made it
      // far worse: `overflow-wrap:anywhere` on a `max-content` column resolves that column's
      // intrinsic width to a SINGLE CHARACTER, so "ctx peak" rendered vertically, one letter per
      // line, and the grid row grew tall enough to contain it.
      //
      // Stacking sidesteps intrinsic sizing altogether: the term is its own block, the description
      // is capped at a readable measure, and the result behaves identically at 380px and 2560px.
      '.metric-help{margin:.6rem 0;font-size:13px;border-left:2px solid var(--theme-foreground-faint,#3a3a3a);padding-left:.7rem}' +
      '.metric-help-title{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--theme-foreground-muted)}' +
      '.metric-help dl{margin:.4rem 0 0;display:block}' +
      '.metric-help dt{font-family:var(--monospace,ui-monospace,monospace);color:var(--theme-foreground);margin:.55rem 0 .1rem}' +
      '.metric-help dt:first-of-type{margin-top:0}' +
      '.metric-help dd{margin:0;max-width:74ch;line-height:1.5;color:var(--theme-foreground-muted)}' +
            '</style>',
   header: '',
   footer: 'llm-bench · reads central-db (llmbench.measurements) at build time',
   pages: [
      { name: 'Leaderboard', path: '/' },
      { name: 'Pareto frontier', path: '/pareto' },
      { name: 'Compromise', path: '/compromise' },
      { name: 'Pivot', path: '/pivot' },
      { name: 'SWE-bench-Live', path: '/swe-bench-live' },
      { name: 'IFEval-FC', path: '/ifeval-fc' },
      { name: 'Coverage', path: '/coverage' },
   ],
   // The measurement snapshot is one build-time JSON; no client-side search index needed.
   search: false,
};
