#!/usr/bin/env node
// CLI: report identity forks in the live store. `npm run audit:forks`
//
// The same check the dashboard data loader runs on every publish, available ad hoc — after any change
// to how an identity dimension is stamped (a probe that starts recording the ctx it measured, a model
// entry gaining spec_decode, a template rename), run this before trusting the numbers.
import { findIdentityForks, formatForks } from './identity-forks.mjs';
import { query } from './pg-store.mjs';

const scope = process.argv.includes('--all') ? '' : " AND status IS DISTINCT FROM 'partial'";
const rows = await query(`SELECT * FROM $LATEST WHERE 1=1${scope}`);
const forks = findIdentityForks(rows);
const rowForks = forks.filter((f) => f.kind === 'ROW FORK');
const entityForks = forks.filter((f) => f.kind === 'ENTITY FORK');

console.log(`live rows: ${rows.length}`);
console.log(`ROW FORKS    ${rowForks.length}  (both rows land in ONE entity → score.mjs averages them; always wrong)`);
console.log(`ENTITY FORKS ${entityForks.length}  (config splits into two dashboard rows; may be a deliberate A/B)`);
if (forks.length) {
   console.log('');
   for (const l of formatForks([...rowForks, ...entityForks], { limit: Number(process.env.LIMIT ?? 25) })) {
      console.log(l);
   }
   console.log('\nA time-disjoint fork means one variant superseded the other in intent but not in identity.');
   console.log('To remove one: delete every row at that identity, not just the live one — deleting the tip');
   console.log('promotes the superseded row beneath it.');
}
process.exit(rowForks.length ? 1 : 0);
