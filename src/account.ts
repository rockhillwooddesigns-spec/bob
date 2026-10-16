import { useCallback, useEffect, useState } from 'react';
import { createClient, type Session } from '@supabase/supabase-js';
import type { Entitlements } from './hosted-types';

export const HOSTED = import.meta.env.VITE_BILLING_ENABLED === 'true';
const authUrl = import.meta.env.VITE_SUPABASE_URL;
const authKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
export const auth = HOSTED && authUrl && authKey ? createClient(authUrl, authKey) : null;
const free: Entitlements = { pro: false, used: 0, limit: 5, remaining: 5, resetAt: '' };

export { api } from './http-api';
import { api } from './http-api';

export function useAccount() {
  const [session, setSession] = useState<Session | null>(null);
  const [allowance, setAllowance] = useState<Entitlements>(free);
  const [loading, setLoading] = useState(HOSTED && !!auth);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!auth) return;
    let active = true;
    void auth.auth.getSession().then(({ data, error }) => { if (active) { setSession(data.session); if (error) setError('Could not restore your sign-in.'); setLoading(false); } });
    const { data } = auth.auth.onAuthStateChange((_event, value) => { setSession(value); if (!value) setAllowance(free); });
    return () => { active = false; data.subscription.unsubscribe(); };
  }, []);
  const token = session?.access_token || '';
  const refresh = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try { setAllowance(await api<Entitlements>('/api/account', token)); setError(''); }
    catch (error) { setError(error instanceof Error ? error.message : 'Could not check your account.'); }
    finally { setLoading(false); }
  }, [token]);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    if (!token) return;
    const reload = () => { void refresh(); };
    window.addEventListener('focus', reload);
    let timer: ReturnType<typeof setInterval> | undefined;
    if (!allowance.pro && new URLSearchParams(location.search).get('checkout') === 'success') {
      let retries = 0;
      timer = setInterval(() => { if (++retries > 20) { clearInterval(timer); return; } void refresh(); }, 3000);
    }
    return () => { window.removeEventListener('focus', reload); if (timer) clearInterval(timer); };
  }, [token, refresh, allowance.pro]);
  return { owner: !HOSTED, configured: !!auth, session, token, allowance, loading, error, refresh };
}

export type Account = ReturnType<typeof useAccount>;
