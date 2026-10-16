import { beforeEach, describe, expect, it, vi } from 'vitest';
import Stripe from 'stripe';
import { createHash } from 'node:crypto';
import { account, checkout, renderExport, webhook } from './handlers';
import { defaultSettings } from '../src/types';
import { validatePart } from './validation';
import { HttpError } from './core';

const fixtures = vi.hoisted(() => ({ authenticate: vi.fn(), admin: vi.fn(), entitlements: vi.fn(), stripe: vi.fn() }));
vi.mock('./core', async importOriginal => ({ ...await importOriginal<typeof import('./core')>(), ...fixtures }));
const user = { id: '11111111-1111-4111-8111-111111111111', email: 'test@example.test' };
const request = (path: string, value?: unknown, origin = 'https://contour.example.test') => new Request(`https://contour.example.test/api/${path}`, { method: value === undefined ? 'GET' : 'POST', headers: { origin, 'content-type': 'application/json', authorization: 'Bearer fixture' }, ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
const thenable = (data: unknown = null) => {
  const result: Record<string, unknown> = { then: (resolve: (value: unknown) => void) => resolve({ data, error: null }) };
  for (const method of ['upsert', 'select', 'update', 'eq', 'single']) result[method] = () => result;
  return result;
};
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('APP_URL', 'https://contour.example.test');
  vi.stubEnv('STRIPE_PRICE_MONTHLY', 'price_monthly_fixture');
  vi.stubEnv('STRIPE_PRICE_ANNUAL', 'price_annual_fixture');
  fixtures.entitlements.mockResolvedValue({ pro: false, used: 0, remaining: 5 });
});

describe('hosted export and billing routes', () => {
  it('refuses export service access without verified authentication', async () => {
    fixtures.authenticate.mockRejectedValue(new HttpError(401, 'Sign in first.'));
    const response = await renderExport(request('render-export', { jobId: user.id }));
    expect(response.status).toBe(401);
    expect(fixtures.admin).not.toHaveBeenCalled();
  });
  it('rejects cross-site mutations before account or payment operations', async () => {
    expect((await checkout(request('checkout', { plan: 'monthly' }, 'https://other.example.test'))).status).toBe(403);
    expect(fixtures.authenticate).not.toHaveBeenCalled();
  });
  it('returns the authenticated user’s allowance rather than a supplied user ID', async () => {
    const db = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }) };
    fixtures.authenticate.mockResolvedValue({ db, user });
    const response = await account(request(`account?userId=someone-else`));
    expect(response.status).toBe(200);
    expect(fixtures.entitlements).toHaveBeenCalledWith(db, user.id);
  });
  it.each([['monthly', 799, 'month'], ['annual', 7999, 'year']] as const)('uses the advertised CAD %s Stripe price and a single customer checkout lease', async (plan, amount, interval) => {
    const create = vi.fn().mockResolvedValue({ id: 'cs_fixture', url: 'https://checkout.stripe.com/fixture' });
    const payments = { prices: { retrieve: vi.fn().mockResolvedValue({ active: true, currency: 'cad', unit_amount: amount, recurring: { interval, interval_count: 1 } }) }, subscriptions: { list: vi.fn().mockResolvedValue({ data: [] }) }, checkout: { sessions: { create } } };
    const db = { from: () => thenable(), rpc: vi.fn().mockResolvedValue({ data: { stripe_customer_id: 'cus_fixture', checkout_attempt_id: 'attempt_fixture' }, error: null }) };
    fixtures.authenticate.mockResolvedValue({ db, user }); fixtures.stripe.mockReturnValue(payments);
    expect((await checkout(request('checkout', { plan }))).status).toBe(200);
    expect(create.mock.calls[0][0]).toMatchObject({ mode: 'subscription', customer: 'cus_fixture', line_items: [{ price: `price_${plan}_fixture`, quantity: 1 }], subscription_data: { metadata: { contour_user_id: user.id } } });
    expect(db.rpc).toHaveBeenCalledWith('claim_checkout', { p_user_id: user.id });
  });
  it('does not send a customer to checkout if the configured amount or currency is wrong', async () => {
    fixtures.authenticate.mockResolvedValue({ db: {}, user });
    const create = vi.fn();
    fixtures.stripe.mockReturnValue({ prices: { retrieve: vi.fn().mockResolvedValue({ active: true, currency: 'usd', unit_amount: 799, recurring: { interval: 'month', interval_count: 1 } }) }, checkout: { sessions: { create } } });
    expect((await checkout(request('checkout', { plan: 'monthly' }))).status).toBe(503);
    expect(create).not.toHaveBeenCalled();
  });
  it('rejects invalid webhook signatures before granting any entitlement', async () => {
    vi.stubEnv('STRIPE_WEBHOOK_SECRET', 'webhook-fixture-secret');
    const sdk = new Stripe('test-fixture-only');
    fixtures.stripe.mockReturnValue(sdk);
    expect((await webhook(request('stripe-webhook', { type: 'customer.subscription.updated' }))).status).toBe(400);
    expect(fixtures.admin).not.toHaveBeenCalled();
  });
  it('verifies a signed event and fetches current subscription state before applying it', async () => {
    vi.stubEnv('STRIPE_WEBHOOK_SECRET', 'webhook-fixture-secret');
    const sdk = new Stripe('test-fixture-only');
    vi.spyOn(sdk.subscriptions, 'retrieve').mockResolvedValue({ id: 'sub_fixture', metadata: { contour_user_id: user.id }, customer: 'cus_fixture', status: 'active', items: { data: [{ price: { id: 'price_annual_fixture' }, current_period_end: Math.floor(Date.now() / 1000) + 86400 }] } } as never);
    fixtures.stripe.mockReturnValue(sdk);
    const rpc = vi.fn().mockResolvedValue({ error: null }); fixtures.admin.mockReturnValue({ rpc });
    const payload = JSON.stringify({ id: 'evt_signed_fixture', created: 10, type: 'customer.subscription.updated', data: { object: { id: 'sub_fixture' } } });
    const signature = sdk.webhooks.generateTestHeaderString({ payload, secret: 'webhook-fixture-secret' });
    const response = await webhook(new Request('https://contour.example.test/api/stripe-webhook', { method: 'POST', headers: { 'stripe-signature': signature }, body: payload }));
    expect(response.status).toBe(200);
    expect(sdk.subscriptions.retrieve).toHaveBeenCalledWith('sub_fixture');
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_user_id: user.id, p_customer_id: 'cus_fixture', p_status: 'active' });
  });
});

describe('authorized artwork binding', () => {
  const rings: [number, number][][] = [[[0, 0], [100, 0], [100, 100], [0, 100]]];
  const meta = { id: 'art', name: 'sticker.png', width: 100, height: 100, hash: createHash('sha256').update(JSON.stringify({ id: 'art', width: 100, height: 100, rings })).digest('hex') };
  it('accepts only the cut geometry authorized in the original job', () => {
    expect(validatePart([{ id: 'art', rings }], [meta], defaultSettings)[0].rings).toEqual(rings);
    expect(() => validatePart([{ id: 'art', rings: [[[0, 0], [99, 0], [99, 100]]] }], [meta], defaultSettings)).toThrow('Artwork changed');
  });
  it('rejects another design ID or nonfinite coordinates', () => {
    expect(() => validatePart([{ id: 'other', rings }], [meta], defaultSettings)).toThrow('does not belong');
    expect(() => validatePart([{ id: 'art', rings: [[[0, 0], [NaN, 0], [100, 100]]] }], [meta], defaultSettings)).toThrow('coordinates');
  });
});
