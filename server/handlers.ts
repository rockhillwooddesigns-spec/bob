import { randomUUID } from 'node:crypto';
import { authenticate, body, entitlements, handle, HttpError, json, originCheck, stripe, uuid, admin } from './core';
import { manifest, settings, validatePart } from './validation';
import { createPdf } from '../src/export';
import type { ExportJob } from '../src/hosted-types';
import type Stripe from 'stripe';

function method(request: Request, allowed: string[]) { if (!allowed.includes(request.method)) throw new HttpError(405, 'Method not allowed.'); originCheck(request); }
function databaseError(message: string): never {
  if (message.includes('FREE_LIMIT_REACHED')) throw new HttpError(402, 'You have used your 5 free exports this month. Upgrade to Pro or wait until next month.');
  if (message.includes('PRO_REQUIRED')) throw new HttpError(402, 'This feature requires Pro.');
  if (message.includes('IDEMPOTENCY_MISMATCH')) throw new HttpError(409, 'This export changed. Start a new export.');
  if (message.includes('PRESET_LIMIT')) throw new HttpError(400, 'You can save up to 50 presets. Delete one before adding another.');
  throw new HttpError(503, 'The account database could not complete this request. Please retry.');
}

export function account(request: Request) { return handle(async () => {
  method(request, ['GET']);
  const { db, user } = await authenticate(request);
  const allowance = await entitlements(db, user.id);
  const profile = await db.from('billing_profiles').select('stripe_customer_id').eq('user_id', user.id).maybeSingle();
  if (profile.error) databaseError(profile.error.message);
  return json({ ...allowance, canManageBilling: !!profile.data?.stripe_customer_id });
}); }

export function exportJobs(request: Request) { return handle(async () => {
  method(request, ['POST', 'DELETE']);
  const { db, user } = await authenticate(request), input = await body(request);
  if (request.method === 'DELETE') {
    if (!uuid(input.id)) throw new HttpError(400, 'Invalid export job.');
    const { error } = await db.from('export_jobs').update({ status: 'canceled' }).eq('id', input.id).eq('user_id', user.id).eq('status', 'reserved');
    if (error) databaseError(error.message);
    return json({ canceled: true });
  }
  if (!uuid(input.clientId)) throw new HttpError(400, 'Invalid export identifier.');
  const { data, error } = await db.rpc('reserve_export', { p_user_id: user.id, p_client_id: input.clientId, p_manifest: manifest(input.manifest), p_settings: settings(input.settings) });
  if (error) databaseError(error.message);
  const job = data as ExportJob;
  if (job.status === 'canceled' || new Date(job.expires_at).getTime() <= Date.now()) throw new HttpError(409, 'This export expired. Start a new export.');
  return json({ id: job.id });
}); }

export function renderExport(request: Request) { return handle(async () => {
  method(request, ['POST']);
  const { db, user } = await authenticate(request), input = await body(request);
  if (!uuid(input.jobId)) throw new HttpError(400, 'Invalid export job.');
  const { data, error } = await db.from('export_jobs').select('*').eq('id', input.jobId).eq('user_id', user.id).single();
  const job = data as ExportJob | null;
  if (error || !job || job.status === 'canceled' || new Date(job.expires_at).getTime() <= Date.now()) throw new HttpError(409, 'This export is unavailable or expired. Start a new export.');
  if (job.plan === 'pro' && !(await entitlements(db, user.id)).pro) throw new HttpError(402, 'Your Pro subscription is inactive. Renew to finish this export.');
  const artworks = validatePart(input.artworks, job.manifest, job.settings);
  const pdf = await createPdf(artworks, { ...job.settings, includeArtwork: false });
  const finished = await db.rpc('finish_export', { p_user_id: user.id, p_job_id: job.id });
  if (finished.error) databaseError(finished.error.message);
  if (!finished.data) throw new HttpError(409, 'This export was canceled or expired. Start a new export.');
  return new Response(new Uint8Array(pdf), { headers: { 'content-type': 'application/pdf', 'cache-control': 'no-store' } });
}); }

export function presets(request: Request) { return handle(async () => {
  method(request, ['GET', 'POST', 'DELETE']);
  const { db, user } = await authenticate(request);
  if (!(await entitlements(db, user.id)).pro) throw new HttpError(402, 'Saved presets require Pro.');
  if (request.method === 'GET') {
    const result = await db.from('saved_presets').select('id,name,settings').eq('user_id', user.id).order('name');
    if (result.error) databaseError(result.error.message);
    return json(result.data);
  }
  const input = await body(request);
  if (request.method === 'DELETE') {
    if (!uuid(input.id)) throw new HttpError(400, 'Invalid preset.');
    const result = await db.from('saved_presets').delete().eq('id', input.id).eq('user_id', user.id);
    if (result.error) databaseError(result.error.message);
    return json({ deleted: true });
  }
  if (typeof input.name !== 'string' || !input.name.trim() || input.name.trim().length > 50) throw new HttpError(400, 'Use a preset name between 1 and 50 characters.');
  const result = await db.rpc('save_pro_preset', { p_user_id: user.id, p_name: input.name.trim(), p_settings: settings(input.settings) });
  if (result.error) databaseError(result.error.message);
  return json(result.data);
}); }

const prices = { monthly: { amount: 799, interval: 'month', env: 'STRIPE_PRICE_MONTHLY' }, annual: { amount: 7999, interval: 'year', env: 'STRIPE_PRICE_ANNUAL' } } as const;

export function checkout(request: Request) { return handle(async () => {
  method(request, ['POST']);
  const { db, user } = await authenticate(request), input = await body(request);
  if (input.plan !== 'monthly' && input.plan !== 'annual') throw new HttpError(400, 'Choose monthly or annual Pro.');
  const selected = prices[input.plan], priceId = process.env[selected.env];
  if (!priceId || !process.env.APP_URL) throw new HttpError(503, 'Subscription checkout is not configured yet.');
  if ((await entitlements(db, user.id)).pro) throw new HttpError(409, 'You already have Pro. Use Manage subscription to change your billing plan.');
  const payments = stripe();
  const price = await payments.prices.retrieve(priceId);
  if (!price.active || price.currency !== 'cad' || price.unit_amount !== selected.amount || price.recurring?.interval !== selected.interval || price.recurring.interval_count !== 1) throw new HttpError(503, 'The Stripe price does not match the advertised CAD plan. The owner must correct its configuration.');
  const inserted = await db.from('billing_profiles').upsert({ user_id: user.id }, { onConflict: 'user_id', ignoreDuplicates: true });
  if (inserted.error) databaseError(inserted.error.message);
  const claimed = await db.rpc('claim_checkout', { p_user_id: user.id });
  if (claimed.error) databaseError(claimed.error.message);
  if (!claimed.data) throw new HttpError(409, 'Another checkout request is in progress. Wait briefly and retry.');
  try {
    let customer: string = claimed.data.stripe_customer_id;
    if (!customer) {
      customer = (await payments.customers.create({ email: user.email, metadata: { contour_user_id: user.id } }, { idempotencyKey: `contour-customer-${user.id}` })).id;
      const saved = await db.from('billing_profiles').update({ stripe_customer_id: customer }).eq('user_id', user.id);
      if (saved.error) databaseError(saved.error.message);
    }
    const subscriptions = await payments.subscriptions.list({ customer, status: 'all', limit: 100 });
    if (subscriptions.data.some(subscription => ['active', 'trialing', 'past_due', 'unpaid', 'incomplete'].includes(subscription.status))) throw new HttpError(409, 'A subscription already exists for this account. Use Manage subscription instead.');
    let attemptId = claimed.data.checkout_attempt_id;
    if (claimed.data.checkout_session_id) {
      const previous = await payments.checkout.sessions.retrieve(claimed.data.checkout_session_id);
      if (previous.status === 'open' && previous.metadata?.contour_plan === input.plan && previous.url) return json({ url: previous.url });
      if (previous.status === 'open') await payments.checkout.sessions.expire(previous.id);
      attemptId = randomUUID();
      const saved = await db.from('billing_profiles').update({ checkout_attempt_id: attemptId, checkout_session_id: null }).eq('user_id', user.id);
      if (saved.error) databaseError(saved.error.message);
    }
    const origin = new URL(process.env.APP_URL).origin;
    const session = await payments.checkout.sessions.create({
      mode: 'subscription', customer, client_reference_id: user.id, allowed_payment_method_types: ['card'],
      automatic_tax: { enabled: process.env.STRIPE_AUTOMATIC_TAX === 'true' },
      customer_update: { address: 'auto' },
      line_items: [{ price: priceId, quantity: 1 }], metadata: { contour_plan: input.plan },
      subscription_data: { metadata: { contour_user_id: user.id } },
      success_url: `${origin}/?checkout=success`, cancel_url: `${origin}/?checkout=canceled`,
    }, { idempotencyKey: `contour-checkout-${user.id}-${attemptId}` });
    if (!session.url) throw new HttpError(503, 'Stripe did not return a checkout link. Please retry.');
    const saved = await db.from('billing_profiles').update({ checkout_session_id: session.id }).eq('user_id', user.id);
    if (saved.error) databaseError(saved.error.message);
    return json({ url: session.url });
  } finally {
    await db.from('billing_profiles').update({ checkout_lock_until: new Date(0).toISOString() }).eq('user_id', user.id);
  }
}); }

export function portal(request: Request) { return handle(async () => {
  method(request, ['POST']);
  const { db, user } = await authenticate(request);
  if (!process.env.APP_URL) throw new HttpError(503, 'Billing is not configured yet.');
  const profile = await db.from('billing_profiles').select('stripe_customer_id').eq('user_id', user.id).single();
  if (profile.error || !profile.data?.stripe_customer_id) throw new HttpError(404, 'No Stripe customer exists for this account yet.');
  const session = await stripe().billingPortal.sessions.create({ customer: profile.data.stripe_customer_id, return_url: new URL(process.env.APP_URL).origin });
  return json({ url: session.url });
}); }

export function webhook(request: Request) { return handle(async () => {
  if (request.method !== 'POST') throw new HttpError(405, 'Method not allowed.');
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) throw new HttpError(503, 'Stripe webhooks are not configured yet.');
  const payments = stripe();
  let event: Stripe.Event;
  try { event = payments.webhooks.constructEvent(await request.text(), request.headers.get('stripe-signature') || '', secret); }
  catch { throw new HttpError(400, 'Invalid Stripe webhook signature.'); }
  if (!['customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted'].includes(event.type)) return json({ received: true });
  // Fetch current state instead of trusting event arrival order or stale payloads.
  const subscription = await payments.subscriptions.retrieve((event.data.object as Stripe.Subscription).id);
  const userId = subscription.metadata.contour_user_id;
  const item = subscription.items.data.find(item => [process.env.STRIPE_PRICE_MONTHLY, process.env.STRIPE_PRICE_ANNUAL].includes(item.price.id));
  if (!uuid(userId) || !item) return json({ received: true });
  const db = admin();
  const result = await db.rpc('apply_subscription_event', {
    p_event_id: event.id, p_event_created: event.created, p_user_id: userId,
    p_customer_id: typeof subscription.customer === 'string' ? subscription.customer : subscription.customer.id,
    p_subscription_id: subscription.id, p_status: subscription.status,
    p_access_until: new Date(item.current_period_end * 1000).toISOString(),
  });
  if (result.error) databaseError(result.error.message);
  return json({ received: true });
}); }
