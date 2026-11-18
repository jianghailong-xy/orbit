import { createServer } from 'node:http'; import { readFileSync, existsSync, statSync } from 'node:fs'; import { extname, join } from 'node:path';
const root = process.argv[2]; const T = { '.js':'text/javascript', '.css':'text/css', '.html':'text/html', '.svg':'image/svg+xml', '.png':'image/png', '.woff2':'font/woff2', '.json':'application/json', '.ico':'image/x-icon' };
createServer((q, r) => { let p = join(root, decodeURIComponent(q.url.split('?')[0])); if (!existsSync(p) || statSync(p).isDirectory()) p = join(root, 'index.html');
  r.writeHead(200, { 'content-type': T[extname(p)] ?? 'application/octet-stream' }); r.end(readFileSync(p)); }).listen(5874, '127.0.0.1');
