// Build-time data loader: snapshot the tidy measurement rows from central-db
// (llmbench.measurements) into a static JSON the client loads with FileAttachment.
// Runs as a plain Node process at build time, so it can import analysis/ freely and
// needs LLMBENCH_DB_PASSWORD in the env (same as the old export). Keep central-db current
// with `npm run pg:sync` before building.
import { query } from '../../../analysis/pg-store.mjs';

const rows = await query('SELECT * FROM $TIDY ORDER BY ALL');
process.stdout.write(JSON.stringify(rows));
