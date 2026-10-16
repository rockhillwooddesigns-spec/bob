import { execFileSync } from 'node:child_process';
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import JSZip from 'jszip';

const root = path.resolve(import.meta.dirname, '..');
execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build'], { cwd: root, stdio: 'inherit', env: { ...process.env, VITE_BILLING_ENABLED: 'false' } });
const edition = JSON.parse(await readFile(path.join(root, 'dist/build-info.json'), 'utf8'));
if (edition.edition !== 'owner') throw new Error('Refusing to package a customer build as an owner website.');
const zip = new JSZip();
async function add(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) await add(file);
    else if (entry.isFile()) zip.file(`contour-site/${path.relative(path.join(root, 'dist'), file).split(path.sep).join('/')}`, await readFile(file));
  }
}
await add(path.join(root, 'dist'));
await mkdir(path.join(root, 'downloads'), { recursive: true });
const output = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
await writeFile(path.join(root, 'downloads/contour-site.zip'), output);
console.log(`Packaged owner workspace ${edition.version}: ${(output.length / 1024).toFixed(0)} KB. This archive does not enforce paid customer access.`);
