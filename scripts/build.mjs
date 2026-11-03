import { readdir, mkdir, rm, copyFile, writeFile, readFile } from 'node:fs/promises';
import { resolve, join, extname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = resolve(root, 'web');
const destination = resolve(root, 'dist');
const allowed = new Set(['.html', '.css', '.mjs', '.js', '.json', '.svg', '.ico', '.woff2']);
await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
let count = 0;
async function copyDirectory(from, to) {
  for (const entry of await readdir(from, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const input = join(from, entry.name), output = join(to, entry.name);
    if (entry.isDirectory()) { await mkdir(output, { recursive: true }); await copyDirectory(input, output); }
    else if (allowed.has(extname(entry.name))) {
      if (['.mjs', '.js'].includes(extname(entry.name))) {
        const check = spawnSync(process.execPath, ['--check', input], { encoding: 'utf8' });
        if (check.status !== 0) throw new Error(check.stderr || `Syntax check failed: ${input}`);
      }
      await copyFile(input, output); count++;
    }
  }
}
await copyDirectory(source, destination);
for (const name of ['index.html', 'research.html', 'app.mjs', 'core.mjs', 'content.mjs', 'styles.css']) {
  await readFile(join(destination, name));
}
await writeFile(join(destination, '.nojekyll'), '');
console.log(`Built ${count} static files in dist/. All module syntax checks passed.`);
