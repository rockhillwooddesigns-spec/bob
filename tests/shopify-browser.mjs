// Render the real Liquid section, then exercise the hosted app in its sandbox.
// Email, account and Stripe responses are fixtures, not live provider checks.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { Liquid } from 'liquidjs';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
await build({ stdin: { contents: "export { createPdf } from './src/export'; export { validatePart } from './server/validation';", resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'cjs', outfile: '.local/shopify-backend.cjs', logLevel: 'silent' });
const { createPdf, validatePart } = createRequire(import.meta.url)('../.local/shopify-backend.cjs');
import { chromium } from 'playwright';

const base = process.env.BASE_URL || 'http://127.0.0.1:5176';
const source = await readFile('shopify/sections/contour-studio.liquid', 'utf8');
const schema = JSON.parse(source.match(/{% schema %}([\s\S]*?){% endschema %}/)[1]);
assert.equal(schema.name, 'Contour Studio');
const liquid = new Liquid();
const template = source.replace(/{% schema %}[\s\S]*?{% endschema %}/, '');
const render = (url, design = false) => liquid.parseAndRender(template, { section: { id: 'fixture', settings: { app_url: url, heading: '<Contour>', workspace_height: 1000 } }, request: { design_mode: design } });
assert.ok(!(await render('javascript:alert(1)')).includes('<iframe'));
assert.ok(!(await render('http://insecure.test')).includes('<iframe'));
assert.ok((await render('', true)).includes('Add your hosted'));
let html = await render('https://contour.example.test');
assert.ok(html.includes('&lt;Contour&gt;'));
assert.ok(html.includes('allow-downloads'));
html = html.replaceAll('https://contour.example.test', base); // Local preview uses HTTP only.
const server = createServer((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(html); });
await new Promise(resolve => server.listen(0, resolve));
const store = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), args: ['--no-sandbox'] });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1200 } });
  const user = { id: '11111111-1111-4111-8111-111111111111', email: 'shopper@example.test', aud: 'authenticated', role: 'authenticated', created_at: new Date().toISOString() };
  const token = `${Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: user.id, exp: Math.floor(Date.now()/1000)+3600, aud: 'authenticated' })).toString('base64url')}.fixture`;
  const session = { access_token: token, refresh_token: 'fixture', token_type: 'bearer', expires_in: 3600, user };
  let sent = false, verified = false, plan, failed = false, checkoutCalls = 0, job;
  await context.route('https://contour-accounts.example.test/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/otp')) { assert.equal(route.request().postDataJSON().email, user.email); sent = true; return route.fulfill({ json: {} }); }
    if (path.endsWith('/verify')) {
      const input = route.request().postDataJSON(); assert.equal(input.type, 'email');
      if (input.token !== '123456') return route.fulfill({ status: 403, json: { msg: 'Invalid sign-in code' } });
      verified = true; return route.fulfill({ json: session });
    }
    return route.fulfill({ json: user });
  });
  await context.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    assert.equal(route.request().headers().authorization, `Bearer ${token}`);
    if (path === '/api/export-jobs') { job = route.request().postDataJSON(); return route.fulfill({ json: { id: '22222222-2222-4222-8222-222222222222' } }); }
    if (path === '/api/render-export') {
      const input = route.request().postDataJSON();
      const arts = validatePart(input.artworks, job.manifest, job.settings);
      return route.fulfill({ contentType: 'application/pdf', body: Buffer.from(await createPdf(arts, { ...job.settings, includeArtwork: false })) });
    }
    if (path === '/api/account') return route.fulfill({ json: { pro: false, used: 0, remaining: 5, limit: 5, resetAt: '2026-11-01T00:00:00Z', canManageBilling: true } });
    if (path === '/api/checkout') { checkoutCalls++; plan = route.request().postDataJSON().plan; if (failed) return route.fulfill({ status: 503, json: { error: 'Checkout temporarily unavailable' } }); return route.fulfill({ json: { url: `${base}/?checkout=fixture` } }); }
    if (path === '/api/portal') return route.fulfill({ json: { url: `${base}/?portal=fixture` } });
    throw new Error(`Unexpected API ${path}`);
  });
  const page = await context.newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(store.replace('127.0.0.1', 'localhost'));
  await page.frameLocator('iframe').getByRole('heading', { name: 'Open your workspace in a new tab' }).waitFor();
  assert.equal(await page.frameLocator('iframe').getByRole('link', { name: 'Open Contour Studio' }).getAttribute('target'), '_blank');
  console.log('PASS: Cross-site storage restrictions show an actionable full-workspace fallback');
  await page.goto(store);
  const frame = page.frameLocator('iframe');
  await frame.getByText('1 design ready to go', { exact: true }).waitFor();
  assert.equal(await frame.getByRole('link', { name: 'Open full workspace' }).getAttribute('target'), '_blank');
  assert.equal(await frame.locator('html').getAttribute('data-theme'), 'dark');
  await frame.getByRole('button', { name: 'Sign in', exact: true }).click();
  await frame.getByLabel('Your email').fill(user.email);
  await frame.getByRole('button', { name: 'Send sign-in code', exact: true }).click();
  await frame.getByLabel('Email sign-in code').fill('000000');
  await frame.getByRole('button', { name: 'Verify code', exact: true }).click();
  await frame.getByRole('alert').filter({ hasText: 'Invalid sign-in code' }).waitFor();
  await frame.getByLabel('Email sign-in code').fill('123456');
  await frame.getByRole('button', { name: 'Verify code', exact: true }).click();
  await frame.getByRole('button', { name: 'Sign out', exact: true }).waitFor();
  assert.ok(sent && verified);
  console.log('PASS: Liquid settings/escaping, sandboxed same-site preview, email-code sign-in and invalid-code recovery');

  const downloading = page.waitForEvent('download');
  await frame.getByRole('button', { name: /Export batch/ }).click();
  const download = await downloading;
  const pdf = await readFile(await download.path());
  assert.equal(pdf.subarray(0, 8).toString(), '%PDF-1.3');
  assert.ok(pdf.includes(Buffer.from('/CutContour')));
  console.log('PASS: Sandboxed PDF download retains PDF 1.3 and CutContour spot color');
  await frame.getByRole('button', { name: 'Plans & pricing' }).click();
  for (const [label, expected] of [['Start monthly Pro', 'monthly'], ['Start annual Pro', 'annual'], ['Manage billing or cancel renewal', 'portal']]) {
    const popupWait = context.waitForEvent('page');
    await frame.getByRole('button', { name: label, exact: true }).click();
    const popup = await popupWait;
    await popup.waitForURL(expected === 'portal' ? /portal=fixture/ : /checkout=fixture/);
    if (expected !== 'portal') assert.equal(plan, expected);
    assert.equal(await popup.evaluate(() => window.opener), null);
    assert.equal(page.url(), `${store}/`);
    assert.equal(await frame.locator('body').evaluate(() => location.href), `${base}/`);
    await popup.close();
  }
  console.log('PASS: Monthly, annual and portal billing open outside the iframe without replacing the Shopify page');
  failed = true;
  const popupWait = context.waitForEvent('page');
  await frame.getByRole('button', { name: 'Start monthly Pro', exact: true }).click();
  const failedPopup = await popupWait;
  await frame.getByRole('alert').filter({ hasText: 'Checkout temporarily unavailable' }).waitFor();
  await new Promise(resolve => failedPopup.isClosed() ? resolve() : failedPopup.once('close', resolve));
  const calls = checkoutCalls;
  await frame.locator('body').evaluate(() => { window.open = () => null; });
  await frame.getByRole('button', { name: 'Start annual Pro', exact: true }).click();
  await frame.getByRole('alert').filter({ hasText: 'Allow pop-ups' }).waitFor();
  assert.equal(checkoutCalls, calls);
  assert.deepEqual(errors, []);
  console.log('PASS: Billing failures close the reserved tab; blocked popups show a recovery action before creating checkout');
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
