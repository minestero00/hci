import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {build} from 'esbuild';
const sdk=(await build({entryPoints:[fileURLToPath(new URL('../client/firebase-sdk.mjs',import.meta.url))],bundle:true,format:'esm',platform:'browser',target:'es2022',minify:true,write:false})).outputFiles[0].contents;

const root = resolve(fileURLToPath(new URL('../web/', import.meta.url)));
const port = Number(process.env.PORT || 4173);
const types = { '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml' };
createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    let relative = decodeURIComponent(url.pathname).replace(/^\/hci(?=\/|$)/, '').replace(/^\/+/, '');
    if (!relative || relative.endsWith('/')) relative += 'index.html';
    if(relative==='firebase-sdk.mjs'){res.writeHead(200,{'Content-Type':'text/javascript; charset=utf-8','Cache-Control':'no-store'});res.end(req.method==='HEAD'?undefined:sdk);return;}
    const target = resolve(root, relative);
    if (!target.startsWith(root + sep) && target !== root) { res.writeHead(403); res.end('Forbidden'); return; }
    if (!(await stat(target)).isFile()) throw new Error('not a file');
    const body = await readFile(target);
    res.writeHead(200, { 'Content-Type': types[extname(target)] || 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Not found'); }
}).listen(port, '127.0.0.1', () => console.log(`Local: http://127.0.0.1:${port}/hci/`));
