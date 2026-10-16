import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { defaultSettings } from '../src/types';

const user = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
let pg: PGlite;
const manifest = (count = 1) => Array.from({ length: count }, (_, i) => ({ id: `art-${i}`, name: 'sticker.png', width: 100, height: 100, hash: 'a'.repeat(64) }));
async function reserve(count = 1, client = randomUUID(), settings = defaultSettings) {
  const result = await pg.query<{ job: { id: string; plan: string } }>('select reserve_export($1,$2,$3::jsonb,$4::jsonb) as job', [user, client, JSON.stringify(manifest(count)), JSON.stringify(settings)]);
  return result.rows[0].job;
}
async function allowance(id = user) { return (await pg.query<{ value: { pro: boolean; used: number; remaining: number } }>('select account_entitlements($1) as value', [id])).rows[0].value; }
async function pro() { await pg.query("insert into billing_profiles(user_id,subscription_status,access_until) values($1,'active',now()+interval '1 month')", [user]); }

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`create role anon; create role authenticated; create role service_role bypassrls; create schema auth; create table auth.users(id uuid primary key); create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$; grant usage on schema auth to authenticated;`);
  await pg.exec(await readFile(new URL('../supabase/migrations/001_billing.sql', import.meta.url), 'utf8'));
}, 30000);
beforeEach(async () => {
  await pg.exec('reset role; truncate auth.users cascade;');
  await pg.query('insert into auth.users values($1),($2)', [user, other]);
});
afterAll(async () => { await pg.close(); });

describe('subscription and quota database rules', () => {
  it('allows exactly five free monthly exports and rejects the sixth', async () => {
    for (let i = 0; i < 5; i++) { const job = await reserve(); await pg.query('select finish_export($1,$2)', [user, job.id]); }
    expect(await allowance()).toMatchObject({ used: 5, remaining: 0, pro: false });
    await expect(reserve()).rejects.toThrow('FREE_LIMIT_REACHED');
  });
  it('counts a retry only once and rejects changed content under the same request ID', async () => {
    const client = randomUUID();
    const first = await reserve(1, client), retry = await reserve(1, client);
    expect(retry.id).toBe(first.id);
    expect((await allowance()).used).toBe(1);
    await expect(reserve(1, client, { ...defaultSettings, widthMm: 90 })).rejects.toThrow('IDEMPOTENCY_MISMATCH');
  });
  it('releases canceled and expired reservations but refuses to deliver them later', async () => {
    const job = await reserve();
    await pg.query("update export_jobs set status='canceled' where id=$1", [job.id]);
    expect((await allowance()).used).toBe(0);
    expect((await pg.query<{ ok: boolean }>('select finish_export($1,$2) as ok', [user, job.id])).rows[0].ok).toBe(false);
    const expired = await reserve();
    await pg.query("update export_jobs set expires_at=now()-interval '1 minute' where id=$1", [expired.id]);
    expect((await allowance()).remaining).toBe(5);
  });
  it('resets usage by UTC calendar month rather than a rolling 30 days', async () => {
    const old = await reserve();
    await pg.query("update export_jobs set status='completed',created_at=(date_trunc('month',now() at time zone 'UTC') at time zone 'UTC')-interval '1 minute' where id=$1", [old.id]);
    expect((await allowance()).used).toBe(0);
  });
  it('rejects Free batching and advanced settings in the database', async () => {
    await expect(reserve(2)).rejects.toThrow('PRO_REQUIRED');
    await expect(reserve(1, randomUUID(), { ...defaultSettings, holes: true })).rejects.toThrow('PRO_REQUIRED');
    await expect(reserve(1, randomUUID(), { ...defaultSettings, smoothing: 1 })).rejects.toThrow('PRO_REQUIRED');
  });
  it('allows 500-design Pro batches without consuming free allowance', async () => {
    await pro();
    for (let i = 0; i < 6; i++) expect((await reserve(500)).plan).toBe('pro');
    expect(await allowance()).toMatchObject({ used: 0, remaining: 5, pro: true });
    await expect(reserve(501)).rejects.toThrow('INVALID_BATCH');
  });
  it('removes Pro entitlement when its paid period ends', async () => {
    await pro();
    await pg.query("update billing_profiles set access_until=now()-interval '1 second' where user_id=$1", [user]);
    expect((await allowance()).pro).toBe(false);
    await expect(reserve(500)).rejects.toThrow('PRO_REQUIRED');
  });
  it('handles duplicate and older Stripe events without reactivating a canceled plan', async () => {
    const call = (id: string, created: number, status: string) => pg.query("select apply_subscription_event($1,$2,$3,'cus_fixture','sub_fixture',$4,now()+interval '1 month')", [id, created, user, status]);
    await call('evt_active', 100, 'active');
    expect((await allowance()).pro).toBe(true);
    await call('evt_canceled', 200, 'canceled');
    await call('evt_old', 150, 'active');
    await call('evt_active', 100, 'active');
    expect((await allowance()).pro).toBe(false);
    expect((await pg.query<{ count: number }>('select count(*)::int as count from stripe_processed_events')).rows[0].count).toBe(3);
  });
  it('requires Pro for presets and updates an existing preset without duplicating it', async () => {
    const save = () => pg.query('select save_pro_preset($1,$2,$3::jsonb)', [user, 'Vinyl', JSON.stringify(defaultSettings)]);
    await expect(save()).rejects.toThrow('PRO_REQUIRED');
    await pro(); await save(); await save();
    expect((await pg.query<{ count: number }>('select count(*)::int as count from saved_presets')).rows[0].count).toBe(1);
  });
  it('prevents simultaneous checkout creation for the same customer', async () => {
    await pro();
    const first = await pg.query<{ lease: unknown }>('select claim_checkout($1) as lease', [user]);
    const second = await pg.query<{ lease: unknown }>('select claim_checkout($1) as lease', [user]);
    expect(first.rows[0].lease).toBeTruthy();
    expect(second.rows[0].lease).toBeNull();
  });
  it('does not let browser roles grant Pro, reserve another user’s exports, or read another account', async () => {
    await pro();
    await pg.query("select set_config('request.jwt.claim.sub',$1,false)", [other]);
    await pg.exec('set role authenticated');
    expect((await pg.query('select * from billing_profiles')).rows).toHaveLength(0);
    await expect(pg.query("update billing_profiles set subscription_status='active'")).rejects.toThrow('permission denied');
    await expect(reserve()).rejects.toThrow('permission denied');
    await pg.exec('reset role');
  });
});
