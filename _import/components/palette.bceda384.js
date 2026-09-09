// Shared colour palettes (carried over from the previous explorer) + Plot colour-scale helpers.
export const ARCH_COLORS = {
   'gated-delta-moe': '#2bd0be',
   'gated-delta-dense': '#e5a54f',
   moe: '#7aa2f7',
   dense: '#e5697b',
   'mamba-hybrid': '#b48ead',
};
export const KV_COLORS = { q4_0: '#e5697b', q4_1: '#e5a54f', q5_0: '#7aa2f7', q5_1: '#2bd0be', q8_0: '#b48ead', f16: '#88c0d0' };
const FALLBACK = '#8a949b';

export const archColor = (a) => ARCH_COLORS[a] || FALLBACK;
export const kvColor = (kv) => KV_COLORS[kv] || FALLBACK;

// A Plot color scale ({domain,range}) for the categories actually present, using `palette`.
export function colorScale(cats, palette) {
   const domain = [...new Set(cats)].filter((c) => c != null).sort();
   return { domain, range: domain.map((c) => palette[c] || FALLBACK) };
}
