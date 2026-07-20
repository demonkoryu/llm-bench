// Manual marker-size ("r") legend — Observable Plot has no built-in radius legend. Draws a row of
// ✕ crosses (matching the pareto markers) sized by the chart's OWN r-scale (pass `chart.scale("r")`)
// so they match the plotted crosses: bottom-aligned on a common baseline, with a value label under each.
import { svg } from 'npm:htl';

const defaultFmt = (v) => (v >= 1024 ? `${(v / 1024).toFixed(v % 1024 === 0 ? 0 : 1)} GiB` : `${Math.round(v)} MiB`);

export function sizeLegend(rscale, values, { label = 'VRAM', fmt = defaultFmt } = {}) {
   const rOf = (v) => Math.max(1, rscale.apply(v));
   const maxR = Math.max(6, ...values.map(rOf));
   const gap = 30;
   const base = 3 + 2 * maxR; // y of the cross bottoms (common baseline)
   const cxs = [];
   let x = 48; // leave room for the leading "VRAM" label
   for (const v of values) {
      cxs.push(x + rOf(v));
      x += 2 * rOf(v) + gap;
   }
   const W = x;
   const H = base + 20;
   return svg`<svg width=${W} height=${H} viewBox="0 0 ${W} ${H}" style="max-width:100%;height:auto;color:var(--theme-foreground)">
    <text x="0" y=${base} font-size="11" fill="currentColor" fill-opacity="0.6">${label}</text>
    ${values.map(
       (v, i) => svg`<g stroke="currentColor" stroke-opacity="0.75" stroke-width="1.4">
      <line x1=${cxs[i] - rOf(v)} y1=${base - 2 * rOf(v)} x2=${cxs[i] + rOf(v)} y2=${base}/>
      <line x1=${cxs[i] - rOf(v)} y1=${base} x2=${cxs[i] + rOf(v)} y2=${base - 2 * rOf(v)}/>
      <text x=${cxs[i]} y=${base + 14} text-anchor="middle" font-size="10.5" stroke="none" fill="currentColor" fill-opacity="0.75">${fmt(v)}</text>
    </g>`,
    )}
  </svg>`;
}
