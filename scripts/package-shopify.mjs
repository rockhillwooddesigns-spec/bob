import { readFile, writeFile, mkdir } from 'node:fs/promises';
import JSZip from 'jszip';
const zip = new JSZip();
zip.file('sections/contour-studio.liquid', await readFile('shopify/sections/contour-studio.liquid'));
zip.file('README.md', (await readFile('docs/SHOPIFY.md', 'utf8')).replaceAll('../shopify/sections/contour-studio.liquid', 'sections/contour-studio.liquid').replaceAll('(PAID-LAUNCH.md)', '(https://github.com/rockhillwooddesigns-spec/bob/blob/main/docs/PAID-LAUNCH.md)'));
await mkdir('downloads', { recursive: true });
await writeFile('downloads/contour-shopify.zip', await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
console.log('Created downloads/contour-shopify.zip — section and instructions; not a complete Shopify theme.');
