import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// 只服务本 Demo 目录，端口固定在本机回环地址，不对外网开放。
const defaultRoot = resolve(fileURLToPath(new URL('../', import.meta.url)));
const root = resolve(process.env.PREVIEW_ROOT || defaultRoot);
const port = Number(process.env.PORT || 4176);
const host = '127.0.0.1';
const types = {
  '.html': 'text/html; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webmanifest': 'application/manifest+json'
};

const server = createServer(async (request, response) => {
  try {
    const path = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
    const relative = path === '/' ? 'index.html' : path.replace(/^\/+/, '');
    if (!relative || relative.split('/').some(part => !part || part.startsWith('.'))) { response.writeHead(404); response.end(); return; }
    const file = resolve(root, relative);
    if (!file.startsWith(root + sep)) { response.writeHead(403); response.end(); return; }
    if (!(await stat(file)).isFile()) { response.writeHead(404); response.end(); return; }
    // 源码目录里的测试和脚本不在站点范围内，即使路径存在也不提供。
    if (/(^|[\\/])(tests|scripts|node_modules)([\\/]|$)/.test(relative)) { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { 'content-type': types[extname(file).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store' });
    response.end(await readFile(file));
  } catch {
    response.writeHead(404);
    response.end();
  }
});

server.listen(port, host, () => console.log(`Local: http://${host}:${port}/  (${root})`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
