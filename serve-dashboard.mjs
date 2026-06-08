/**
 * Minimal static server for results/dashboard.html.
 * Used by .claude/launch.json so the preview pane opens the dashboard directly.
 * PORT env var is injected by the preview runner when autoPort kicks in.
 */
import { createServer } from 'node:http';
import { createReadStream, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), 'results');
const PORT = Number(process.env.PORT ?? 8099);

createServer((req, res) => {
   const url = req.url.replace(/\?.*/, '');
   const file = url === '/' ? 'dashboard.html' : url.replace(/^\//, '');
   const filePath = join(ROOT, file);
   if (!existsSync(filePath)) {
      res.writeHead(404);
      res.end('Not found');
      return;
   }
   const ct = file.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/octet-stream';
   res.writeHead(200, { 'Content-Type': ct });
   createReadStream(filePath).pipe(res);
}).listen(PORT, () => console.log(`Dashboard → http://localhost:${PORT}`));
