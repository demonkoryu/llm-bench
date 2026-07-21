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
      // Metric glossary (components/metric-help.js): an always-visible name → description list.
      '.metric-help{margin:.6rem 0;font-size:13px;border-left:2px solid var(--theme-foreground-faint,#3a3a3a);padding-left:.7rem}' +
      '.metric-help-title{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--theme-foreground-muted)}' +
      '.metric-help dl{margin:.25rem 0 0;display:grid;grid-template-columns:max-content 1fr;gap:2px 12px}' +
      '.metric-help dt{font-family:var(--monospace,ui-monospace,monospace);white-space:nowrap;color:var(--theme-foreground)}' +
      '.metric-help dd{margin:0;color:var(--theme-foreground-muted)}</style>',
   header: '',
   footer: 'llm-bench · reads central-db (llmbench.measurements) at build time',
   pages: [
      { name: 'Leaderboard', path: '/' },
      { name: 'Pareto frontier', path: '/pareto' },
      { name: 'Compromise', path: '/compromise' },
      { name: 'Pivot', path: '/pivot' },
      { name: 'Coverage', path: '/coverage' },
   ],
   // The measurement snapshot is one build-time JSON; no client-side search index needed.
   search: false,
};
