import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import JSZip from 'jszip';
import { PDFDict, PDFDocument, PDFName } from 'pdf-lib';

await mkdir('.local', { recursive: true });
const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  args: ['--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const base = process.env.BASE_URL || 'http://127.0.0.1:5173';
let checks = 0;
function checked(description) { checks++; console.log(`PASS ${description}`); }
async function download(name) {
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: /Export batch/ }).click();
  const file = await pending;
  await file.saveAs(`.local/${name}`);
  return readFile(`.local/${name}`);
}
async function assertSpotPdf(bytes) {
  const doc = await PDFDocument.load(bytes);
  for (const pdfPage of doc.getPages()) {
    const colors = pdfPage.node.Resources().lookup(PDFName.of('ColorSpace'), PDFDict);
    assert.ok(colors.has(PDFName.of('CutContour')));
  }
  return doc;
}

try {
  await page.goto(base);
  await page.getByText('3 designs ready to go').waitFor();
  await page.screenshot({ path: '.local/desktop.png', fullPage: true });
  checked('sample artwork is decoded, traced in a worker, and ready');

  const sampleZip = await JSZip.loadAsync(await download('sample-batch.zip'));
  assert.equal(Object.keys(sampleZip.files).length, 3);
  for (const file of Object.values(sampleZip.files)) await assertSpotPdf(await file.async('uint8array'));
  checked('sample batch downloads as three valid spot-color PDFs');

  await page.getByRole('button', { name: 'How it works' }).click();
  await page.getByRole('dialog').waitFor();
  assert.match(await page.getByRole('dialog').innerText(), /0.25 pt/);
  await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('dialog').count(), 0);
  checked('VersaWorks guide opens and closes with Escape');

  await page.getByLabel('Artwork width', { exact: true }).fill('100');
  await page.getByText('3 designs ready to go').waitFor();
  assert.equal(await page.locator('.dimension-line').innerText(), '100.0 mm artwork');
  await page.getByLabel('Cut offset', { exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  await page.getByText('3 designs ready to go').waitFor();
  assert.match(await page.locator('.batch-status').innerText(), /2.1 mm offset/);
  await page.getByRole('button', { name: 'Reset', exact: true }).click();
  await page.getByText('3 designs ready to go').waitFor();
  checked('size, offset, retracing, and reset update the batch');

  const donut = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><path fill="#225540" fill-rule="evenodd" d="M10 10H90V90H10Z M35 35H65V65H35Z"/></svg>`;
  const png = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 100; canvas.height = 80;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#b47244'; ctx.fillRect(10, 10, 80, 60);
    return canvas.toDataURL('image/png').split(',')[1];
  });
  await page.getByLabel('Upload artwork files').setInputFiles([
    { name: 'donut.svg', mimeType: 'image/svg+xml', buffer: Buffer.from(donut) },
    { name: 'tile.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') },
  ]);
  await page.getByText('2 designs ready to go').waitFor();
  assert.equal(await page.locator('.artwork-item').count(), 2);
  assert.equal(await page.getByText('stay-wild.svg', { exact: true }).count(), 0);
  await page.getByLabel('Include inner cutouts').check();
  await page.getByText('2 designs ready to go').waitFor();
  await page.getByText('3 closed cut paths', { exact: false }).waitFor();
  assert.match(await page.locator('.batch-status').innerText(), /3 closed cut paths/);
  checked('batch SVG/PNG upload replaces samples and preserves optional inner cutouts');

  await page.getByRole('button', { name: 'Deselect all' }).click();
  assert.equal(await page.getByRole('button', { name: /Export batch/ }).isDisabled(), true);
  await page.getByRole('button', { name: 'Select all', exact: true }).click();
  await page.getByLabel('Include artwork', { exact: true }).uncheck();
  const cutZip = await JSZip.loadAsync(await download('cut-only.zip'));
  for (const file of Object.values(cutZip.files)) {
    const pdf = await assertSpotPdf(await file.async('uint8array'));
    const images = pdf.getPages()[0].node.Resources().lookup(PDFName.of('XObject'), PDFDict);
    assert.equal(images.keys().length, 0);
  }
  checked('batch selection and artwork-free cut-only PDF export work');

  await page.getByLabel('Include artwork', { exact: true }).check();
  await page.getByLabel('Include tile.png').uncheck();
  const single = await assertSpotPdf(await download('single-design.pdf'));
  assert.equal(single.getPageCount(), 1);
  await page.getByLabel('Include tile.png').check();
  await page.getByLabel('Export layout').selectOption('a4');
  const sheet = await assertSpotPdf(await download('a4-sheet.pdf'));
  assert.equal(sheet.getPageCount(), 1);
  assert.ok(Math.abs(sheet.getPages()[0].getWidth() * 25.4 / 72 - 210) < 0.01);
  checked('single-design PDF and combined A4 print sheet exports work');

  await page.getByLabel('Artwork width', { exact: true }).fill('250');
  await page.getByText('2 designs ready to go').waitFor();
  await page.getByRole('button', { name: /Export batch/ }).click();
  await page.getByRole('alert').filter({ hasText: 'too large for A4' }).waitFor();
  await page.getByLabel('Artwork width', { exact: true }).fill('80');
  await page.getByText('2 designs ready to go').waitFor();
  checked('oversize sheet exports show an actionable error');

  const black = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 10;
    return canvas.toDataURL('image/png').split(',')[1];
  });
  await page.getByLabel('Upload artwork files').setInputFiles([{ name: 'empty.png', mimeType: 'image/png', buffer: Buffer.from(black, 'base64') }]);
  await page.getByText('No visible artwork found.', { exact: false }).waitFor();
  assert.equal(await page.getByRole('button', { name: /Export batch/ }).isDisabled(), true);
  await page.getByRole('button', { name: 'Remove empty.png', exact: true }).click();
  await page.getByText('2 designs ready to go').waitFor();
  checked('empty artwork blocks export and removal recovers the batch');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: '.local/mobile.png', fullPage: true });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await page.getByRole('button', { name: 'Quick guide' }).click();
  await page.getByRole('dialog').waitFor();
  await page.getByRole('button', { name: 'Back to the workspace' }).click();
  checked('mobile workspace fits the viewport and guide remains usable');

  assert.deepEqual(errors, []);
  checked('no browser runtime errors');
  console.log(`\n${checks} browser checks passed.`);
} finally {
  await browser.close();
}
