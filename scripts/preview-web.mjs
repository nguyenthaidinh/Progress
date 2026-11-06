// Serve only the exported public website on loopback. No PC API, AI credentials or task runner is exposed.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(fileURLToPath(new URL('../web-site', import.meta.url))), port = Number(process.env.WEB_PORT || 4311);
if (!fs.existsSync(path.join(root, 'index.html'))) throw new Error('Run npm run build:web first');
const realRoot = fs.realpathSync(root);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json' };
http.createServer((req, res) => {
  if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405).end(); return; }
  try {
    const pathname = decodeURIComponent(new URL(req.url, `http://127.0.0.1:${port}`).pathname);
    let file = path.resolve(root, `.${pathname}`), relative = path.relative(root, file);
    if (relative.startsWith('..') || path.isAbsolute(relative)) { res.writeHead(403).end(); return; }
    if (fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    file = fs.realpathSync(file); relative = path.relative(realRoot, file);
    if (relative.startsWith('..') || path.isAbsolute(relative) || !fs.statSync(file).isFile()) { res.writeHead(403).end(); return; }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-cache' });
    if (req.method === 'HEAD') res.end(); else { const stream = fs.createReadStream(file); stream.on('error', () => res.destroy()); stream.pipe(res); }
  } catch { res.writeHead(404).end('Not found'); }
}).listen(port, '127.0.0.1', () => console.log(`LioOps public website preview: http://127.0.0.1:${port}`));
