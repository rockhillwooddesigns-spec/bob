import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import JSZip from 'jszip';
import { PDFArray, PDFDict, PDFDocument, PDFName } from 'pdf-lib';

await mkdir('.local', { recursive: true });
const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 1440, height: 1050 } });
const page = await context.newPage();
const errors = []; page.on('pageerror', error => errors.push(error.message));
const base = process.env.BASE_URL || 'http://127.0.0.1:5174';
const started = Date.now();
const marks = {};
const mark = text => { marks[text] = +((Date.now() - started) / 1000).toFixed(2); console.log(`PASS ${text} (${marks[text]} s elapsed)`); };
try {
  await page.goto(base);
  await page.getByText('3 designs ready to go').waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark');
  await page.getByRole('button', { name: 'Switch to light mode', exact: true }).click();
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'light');
  await page.screenshot({ path: '.local/light-workspace.png', fullPage: true });
  await page.reload(); await page.getByText('3 designs ready to go').waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'light');
  await page.getByRole('button', { name: 'Switch to dark mode', exact: true }).click();
  mark('dark/light mode persists across reloads');

  await page.getByRole('button', { name: 'Plans & pricing' }).click();
  await page.getByRole('heading', { name: 'More making. Less manual work.' }).waitFor();
  assert.equal(await page.locator('.plan-card').count(), 3);
  assert.match(await page.getByRole('dialog').innerText(), /7.99/);
  assert.match(await page.getByRole('dialog').innerText(), /79.99/);
  assert.match(await page.getByRole('dialog').innerText(), /5 single-design exports/);
  await page.screenshot({ path: '.local/pricing-dark.png' });
  await page.getByRole('button', { name: 'Close plans' }).click();
  mark('exact CAD plan prices and owner-mode payment disclosure');

  await page.getByLabel('Artwork width', { exact: true }).fill('90');
  await page.getByRole('button', { name: 'Saved presets' }).click();
  await page.getByLabel('Preset name').fill('Vinyl production');
  await page.getByRole('button', { name: 'Save current' }).click();
  await page.getByRole('button', { name: 'Close presets' }).click();
  await page.getByRole('button', { name: 'Reset', exact: true }).click();
  await page.getByRole('button', { name: 'Saved presets' }).click();
  await page.getByRole('button', { name: /^Vinyl production/ }).click();
  assert.equal(await page.getByLabel('Artwork width', { exact: true }).inputValue(), '90');
  await page.getByRole('button', { name: 'Reset', exact: true }).click();
  mark('presets save and restore the actual contour settings');

  const png = Buffer.from(await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1400;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#327d65'; ctx.beginPath(); ctx.roundRect(100, 100, 1200, 1200, 180); ctx.fill();
    ctx.fillStyle = '#f5ddac'; ctx.font = 'bold 160px sans-serif'; ctx.textAlign = 'center'; ctx.fillText('PRINT RUN', 700, 740);
    return canvas.toDataURL('image/png').split(',')[1];
  }), 'base64');
  const files = Array.from({ length: 500 }, (_, index) => ({ name: `stress-${String(index + 1).padStart(3, '0')}.png`, mimeType: 'image/png', buffer: png }));
  await page.getByLabel('Upload artwork files').setInputFiles([...files, { ...files[0], name: 'over-limit.png' }]);
  await page.getByRole('alert').filter({ hasText: 'up to 500 designs' }).waitFor();
  assert.equal(await page.locator('.count-badge').innerText(), '3');
  mark('501-design input is rejected before altering the existing batch');

  await page.getByLabel('Upload artwork files').setInputFiles(files);
  await page.getByText('500 designs ready to go').waitFor({ timeout: 300000 });
  assert.equal(await page.locator('.count-badge').innerText(), '500');
  assert.equal(await page.locator('.artwork-item').count(), 25);
  assert.match(await page.getByRole('navigation', { name: 'Artwork pages' }).innerText(), /1 \/ 20/);
  await page.getByLabel('Search artwork').fill('stress-500');
  assert.equal(await page.locator('.artwork-item').count(), 1);
  await page.getByRole('button', { name: /stress-500.png/ }).first().click();
  await page.getByLabel('Search artwork').fill('');
  mark('500 full-resolution images import, trace, paginate, and search');

  await page.getByRole('button', { name: /Export batch/ }).click();
  await page.getByRole('button', { name: 'Cancel export', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Cancel export', exact: true }).click();
  assert.equal(await page.getByRole('dialog').count(), 0);
  await page.getByText('500 designs ready to go').waitFor();
  mark('large export can be canceled without losing artwork');

  await page.getByRole('button', { name: /Export batch/ }).click();
  await page.getByRole('heading', { name: 'Your batch is ready.' }).waitFor({ timeout: 300000 });
  const buttons = page.locator('.download-part');
  assert.equal(await buttons.count(), 10);
  const names = new Set();
  for (let i = 0; i < 10; i++) {
    const waiting = page.waitForEvent('download'); await buttons.nth(i).click();
    const file = await waiting;
    const stream = await file.createReadStream(); const buffers = []; for await (const buffer of stream) buffers.push(buffer);
    const zip = await JSZip.loadAsync(Buffer.concat(buffers));
    assert.equal(Object.keys(zip.files).length, 50);
    for (const name of Object.keys(zip.files)) { assert.ok(!names.has(name)); names.add(name); }
    const first = await Object.values(zip.files)[0].async('uint8array');
    const doc = await PDFDocument.load(first);
    const spot = doc.getPages()[0].node.Resources().lookup(PDFName.of('ColorSpace'), PDFDict).lookup(PDFName.of('CS0'), PDFArray);
    assert.equal(spot.get(1).toString(), '/CutContour');
  }
  assert.equal(names.size, 500);
  mark('all 500 print-and-cut PDFs download across ten bounded ZIP volumes');
  await page.getByRole('button', { name: 'Back to workspace', exact: true }).click();
  const cdp = await context.newCDPSession(page);
  await cdp.send('HeapProfiler.collectGarbage');
  const heap = await cdp.send('Runtime.getHeapUsage');
  marks.mainThreadHeapMbAfterExport = +(heap.usedSize / 1024 / 1024).toFixed(1);
  await page.screenshot({ path: '.local/large-batch-dark.png', fullPage: true });
  assert.deepEqual(errors, []);
  mark('no browser runtime errors');
  await writeFile('.local/large-batch-results.json', JSON.stringify(marks, null, 2));
  console.log(JSON.stringify(marks, null, 2));
} finally { await browser.close(); }
