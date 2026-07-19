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
   header: '',
   footer: 'llm-bench · reads central-db (llmbench.measurements) at build time',
   pages: [
      { name: 'Leaderboard', path: '/' },
      { name: 'Pareto frontier', path: '/pareto' },
      { name: 'Pivot', path: '/pivot' },
      { name: 'Coverage', path: '/coverage' },
   ],
   // The measurement snapshot is one build-time JSON; no client-side search index needed.
   search: false,
};
