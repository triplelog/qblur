/**
 * Dev server for the demo: `npm run serve` → http://localhost:8016/demo/
 *
 * Serves this folder, including node_modules, so the demo's import map can
 * reach mathzetta through the `file:../mathzetta` link. Read-only, localhost.
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sendFile } from './send-file.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT) || 8016;
const TYPES = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.md': 'text/markdown; charset=utf-8',
    '.png': 'image/png', '.mp4': 'video/mp4', '.webm': 'video/webm', '.jpg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml',
};

createServer(async (req, res) => {
    let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (path === '/') path = '/demo/';
    if (path.endsWith('/')) path += 'index.html';
    const file = normalize(join(ROOT, path));
    if (!file.startsWith(ROOT)) {
        res.writeHead(403).end();
        return;
    }
    try {
        const body = await readFile(file);
        sendFile(req, res, body, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    } catch {
        res.writeHead(404).end('Not found');
    }
}).listen(PORT, '127.0.0.1', () => console.log(`qblur demo: http://localhost:${PORT}/demo/`));
