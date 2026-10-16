import { createClient } from '@supabase/supabase-js';
import Stripe from 'stripe';
import type { Entitlements } from '../src/hosted-types';

export class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }
export const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
export function originCheck(request: Request) {
  if (request.method !== 'GET' && request.headers.get('origin') !== new URL(process.env.APP_URL || request.url).origin) throw new HttpError(403, 'This request must come from the Contour website.');
}
export function admin() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) throw new HttpError(503, 'Account service is not configured yet.');
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
}
export function stripe() {
  if (!process.env.STRIPE_SECRET_KEY) throw new HttpError(503, 'Stripe is not connected yet.');
  return new Stripe(process.env.STRIPE_SECRET_KEY);
}
export async function authenticate(request: Request) {
  const token = request.headers.get('authorization')?.match(/^Bearer (.+)$/)?.[1];
  if (!token) throw new HttpError(401, 'Sign in to export or manage your subscription.');
  const db = admin();
  const { data, error } = await db.auth.getUser(token);
  if (error || !data.user) throw new HttpError(401, 'Your sign-in has expired. Please sign in again.');
  return { db, user: data.user };
}
export async function entitlements(db: ReturnType<typeof admin>, userId: string): Promise<Entitlements> {
  const { data, error } = await db.rpc('account_entitlements', { p_user_id: userId });
  if (error) throw new HttpError(503, 'Could not check your export allowance. Please retry shortly.');
  return data as Entitlements;
}
export async function body(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (Buffer.byteLength(text) > 4 * 1024 * 1024) throw new HttpError(413, 'This export part is too large. Try fewer or simpler designs.');
  try { const value = JSON.parse(text); if (typeof value !== 'object' || !value || Array.isArray(value)) throw new Error(); return value; }
  catch { throw new HttpError(400, 'Invalid request data.'); }
}
export async function handle(action: () => Promise<Response>): Promise<Response> {
  try { return await action(); }
  catch (error) { return json({ error: error instanceof HttpError ? error.message : 'The service could not complete this request. Please retry.' }, error instanceof HttpError ? error.status : 500); }
}
export const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
