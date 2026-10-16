// UI/API wiring test using a test session and routed provider/account responses.
// Real quota/RLS and signed webhook rules are covered separately in npm test.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { PDFDocument, PDFDict, PDFName } from 'pdf-lib';
import JSZip from 'jszip';

await build({ stdin: { contents: "export { createPdf } from './src/export'; export { validatePart } from './server/validation';", resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'cjs', outfile: '.local/hosted-backend.cjs', logLevel: 'silent' });
const { createPdf, validatePart } = createRequire(import.meta.url)('../.local/hosted-backend.cjs');
const base = process.env.BASE_URL || 'http://127.0.0.1:5176';
const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 1440, height: 1050 } });
const user = { id: '11111111-1111-4111-8111-111111111111', email: 'fixture@example.test', aud: 'authenticated', role: 'authenticated', created_at: new Date().toISOString() };
const jwt = `${Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify({ sub: user.id, email: user.email, exp: Math.floor(Date.now() / 1000) + 3600, aud: 'authenticated', role: 'authenticated' })).toString('base64url')}.test-fixture-only`;
const session = { access_token: jwt, refresh_token: 'fixture-only', token_type: 'bearer', expires_at: Math.floor(Date.now() / 1000) + 3600, expires_in: 3600, user };
await context.addInitScript(value => localStorage.setItem('sb-contour-accounts-auth-token', JSON.stringify(value)), session);
await context.route('https://contour-accounts.example.test/**', route => route.fulfill({ json: user }));
let pro = false, used = 0, checkoutPlan, portalOpened = false;
const jobs = new Map(), completed = new Set(), saved = new Map();
const account = () => ({ pro, used, limit: 5, remaining: 5 - used, resetAt: '2026-11-01T00:00:00Z', canManageBilling: pro });
await context.route('**/api/**', async route => {
  const request = route.request(), path = new URL(request.url()).pathname;
  assert.equal(request.headers().authorization, `Bearer ${jwt}`);
  const input = request.method() === 'GET' ? {} : request.postDataJSON();
  if (path === '/api/account') return route.fulfill({ json: account() });
  if (path === '/api/checkout') { checkoutPlan = input.plan; return route.fulfill({ json: { url: `${base}/?checkout=fixture` } }); }
  if (path === '/api/portal') { portalOpened = true; return route.fulfill({ json: { url: `${base}/?portal=fixture` } }); }
  if (path === '/api/presets') {
    if (request.method() === 'GET') return route.fulfill({ json: [...saved.values()] });
    const preset = { id: crypto.randomUUID(), name: input.name, settings: input.settings }; saved.set(preset.id, preset); return route.fulfill({ json: preset });
  }
  if (path === '/api/export-jobs' && request.method() === 'POST') {
    if (!pro && used >= 5) return route.fulfill({ status: 402, json: { error: 'You have used your 5 free exports this month. Upgrade to Pro or wait until next month.' } });
    assert.ok(!JSON.stringify(input).includes('data:image'));
    assert.ok(!JSON.stringify(input).includes('pixels'));
    assert.ok(pro || input.manifest.length === 1);
    const id = crypto.randomUUID(); jobs.set(id, input); return route.fulfill({ json: { id } });
  }
  if (path === '/api/export-jobs') return route.fulfill({ json: { canceled: true } });
  if (path === '/api/render-export') {
    assert.ok(!JSON.stringify(input).includes('pixels'));
    const job = jobs.get(input.jobId); assert.ok(job);
    const artworks = validatePart(input.artworks, job.manifest, job.settings);
    const bytes = await createPdf(artworks, { ...job.settings, includeArtwork: false });
    if (!pro && !completed.has(input.jobId)) used++;
    completed.add(input.jobId);
    return route.fulfill({ contentType: 'application/pdf', body: Buffer.from(bytes) });
  }
  throw new Error(`Unexpected API call: ${path}`);
});
const page = await context.newPage();
const errors = []; page.on('pageerror', error => errors.push(error.message));
async function ready(count) { await page.getByText(`${count} ${count === 1 ? 'design' : 'designs'} ready to go`, { exact: true }).waitFor(); }
async function download() {
  const wait = page.waitForEvent('download'); await page.getByRole('button', { name: /Export batch/ }).click();
  const stream = await (await wait).createReadStream(); const buffers = []; for await (const buffer of stream) buffers.push(buffer); return Buffer.concat(buffers);
}
try {
  await page.goto(base); await ready(1);
  await page.getByText('5 of 5 free exports remaining this month').waitFor();
  assert.equal(await page.getByLabel('Path smoothing', { exact: true }).isDisabled(), true);
  await page.getByRole('button', { name: 'Plans & pricing' }).click();
  await page.getByRole('button', { name: 'Start annual Pro', exact: true }).click();
  await page.waitForURL(/checkout=fixture/); await ready(1);
  assert.equal(checkoutPlan, 'annual');
  console.log('PASS customer account, Free controls, and annual checkout API wiring');

  const single = await PDFDocument.load(await download());
  assert.equal(single.getPageCount(), 1);
  assert.ok(single.getPages()[0].node.Resources().lookup(PDFName.of('ColorSpace'), PDFDict).has(PDFName.of('CS0')));
  assert.ok(single.getPages()[0].node.Resources().lookup(PDFName.of('XObject'), PDFDict).keys().length);
  await page.getByText('4 of 5 free exports remaining this month').waitFor();
  console.log('PASS authorized cut-path service plus locally composited print artwork and quota refresh');

  used = 5; await page.reload(); await ready(1);
  await page.getByRole('button', { name: /Export batch/ }).click();
  await page.getByRole('heading', { name: 'More making. Less manual work.' }).waitFor();
  await page.getByRole('alert').filter({ hasText: '5 free exports' }).waitFor();
  await page.getByRole('button', { name: 'Close plans' }).click();
  console.log('PASS server quota rejection opens upgrade UI without a download');

  pro = true; await page.reload(); await ready(3);
  await page.getByText('Pro · unlimited exports · 500 designs per batch').waitFor();
  assert.equal(await page.getByLabel('Path smoothing', { exact: true }).isDisabled(), false);
  await page.getByRole('button', { name: 'Saved presets' }).click();
  await page.getByLabel('Preset name').fill('Account preset');
  await page.getByRole('button', { name: 'Save current' }).click();
  await page.getByRole('button', { name: /^Account preset/ }).waitFor();
  assert.equal(saved.size, 1);
  await page.getByRole('button', { name: 'Close presets' }).click();
  const zip = await JSZip.loadAsync(await download()); assert.equal(Object.keys(zip.files).length, 3);
  for (const file of Object.values(zip.files)) assert.equal((await PDFDocument.load(await file.async('uint8array'))).getPageCount(), 1);
  console.log('PASS Pro batching and account-preset API wiring');

  await page.getByRole('button', { name: 'Plans & pricing' }).click();
  await page.getByRole('button', { name: 'Manage billing or cancel renewal' }).click();
  await page.waitForURL(/portal=fixture/); assert.equal(portalOpened, true);
  assert.deepEqual(errors, []);
  console.log('PASS billing portal API wiring and no browser runtime errors');
  console.log('All hosted UI checks passed with routed test account/provider responses; no real checkout or payment was performed.');
} finally { await browser.close(); }
