import { useEffect, useRef, useState } from 'react';
import { ArrowRight, Bookmark, Check, CreditCard, LoaderCircle, LockKeyhole, Mail, Moon, Plus, Sun, Trash2, X } from 'lucide-react';
import { api, auth, type Account } from './account';
import type { Preset } from './hosted-types';
import type { Settings } from './types';

export function ThemeToggle() {
  const [theme, setTheme] = useState(() => document.documentElement.dataset.theme || 'dark');
  function toggle() { const next = theme === 'dark' ? 'light' : 'dark'; setTheme(next); document.documentElement.dataset.theme = next; try { localStorage.setItem('contour-theme', next); } catch { /* Theme still works when storage is disabled. */ } }
  return <button className="theme-toggle" title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`} aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`} onClick={toggle}>{theme === 'dark' ? <Sun size={17} /> : <Moon size={17} />}</button>;
}

function useDialog() {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { ref.current?.showModal(); return () => ref.current?.close(); }, []);
  return ref;
}

export function PlansDialog({ account, onClose, onSignIn }: { account: Account; onClose: () => void; onSignIn: () => void }) {
  const dialog = useDialog();
  const [pending, setPending] = useState(''), [error, setError] = useState('');
  async function subscribe(plan: 'monthly' | 'annual') {
    if (!account.session) { onClose(); onSignIn(); return; }
    setPending(plan); setError('');
    try { const response = await api<{ url: string }>('/api/checkout', account.token, 'POST', { plan }); location.assign(response.url); }
    catch (error) { setError(error instanceof Error ? error.message : 'Could not start checkout.'); setPending(''); }
  }
  async function manage() {
    setPending('portal'); setError('');
    try { const response = await api<{ url: string }>('/api/portal', account.token, 'POST', {}); location.assign(response.url); }
    catch (error) { setError(error instanceof Error ? error.message : 'Could not open billing.'); setPending(''); }
  }
  const unavailable = account.owner || !account.configured;
  const plans = [
    { name: 'Free', amount: '0', term: 'forever', label: 'A clean start for your next idea.', features: ['5 single-design exports per month', 'Basic contour generation', 'Live artwork preview', 'PDF output'], action: 'Get started', kind: 'free' },
    { name: 'Pro', amount: '7.99', term: 'CAD / month', label: 'For hobbyists and small print shops.', features: ['Unlimited exports', 'Batch processing · up to 500 designs', 'Advanced contour settings', 'Saved presets'], action: 'Start monthly Pro', kind: 'monthly' },
    { name: 'Annual Pro', amount: '79.99', term: 'CAD / year', label: 'The same Pro tools. A better yearly rate.', features: ['Everything in Pro', 'Save CAD $15.89 per year', 'About two months free', 'One simple annual payment'], action: 'Start annual Pro', kind: 'annual' },
  ];
  return <dialog ref={dialog} className="plans-dialog" onCancel={onClose} aria-labelledby="plans-title"><button className="guide-close icon-button" aria-label="Close plans" onClick={onClose}><X size={20} /></button><div className="eyebrow">SMALL PRICE. BIGGER PRINT RUNS.</div><h2 id="plans-title">More making. Less manual work.</h2><p className="plans-intro">Start free. Go Pro when your print runs grow.</p><div className="plan-grid">{plans.map(plan => <article key={plan.kind} className={`plan-card ${plan.kind === 'monthly' ? 'featured' : ''}`}>
    <div className="plan-card-heading"><h3>{plan.name}</h3>{plan.kind === 'monthly' ? <span>POPULAR</span> : plan.kind === 'annual' ? <span>SAVE 16.6%</span> : null}</div><div className="plan-price"><span>$</span>{plan.amount}</div><div className="plan-term">{plan.term}</div><p>{plan.label}</p><ul>{plan.features.map(feature => <li key={feature}><Check size={14} />{feature}</li>)}</ul>
    <button className={`button ${plan.kind === 'monthly' ? 'button-green' : 'button-white'}`} disabled={!!pending || unavailable || (plan.kind === 'free' && !!account.session)} onClick={() => plan.kind === 'free' ? (onClose(), onSignIn()) : account.allowance.pro ? void manage() : void subscribe(plan.kind as 'monthly' | 'annual')}>{pending === plan.kind || pending === 'portal' ? <LoaderCircle size={15} className="spin" /> : null}{account.allowance.pro && plan.kind !== 'free' ? 'Manage subscription' : plan.kind === 'free' && account.session ? 'Your free account' : plan.action}<ArrowRight size={14} /></button>
    </article>)}</div>{account.session && account.allowance.canManageBilling && <button className="text-button manage-billing" disabled={!!pending} onClick={() => void manage()}>Manage billing or cancel renewal <ArrowRight size={14} /></button>}{error && <p className="product-error" role="alert">{error}</p>}{unavailable ? <p className="plans-footnote setup-note"><LockKeyhole size={15} />This is the owner workspace. Payments and customer accounts become available after the hosted Stripe/Supabase setup. No charges are enabled here.</p> : <p className="plans-footnote"><CreditCard size={15} />Secure checkout by Stripe. CAD pricing; applicable taxes may be added. Manage or cancel renewal through your billing portal.</p>}<p className="quota-footnote">Free exports reset on the first day of each month at 00:00 UTC. A successful single-design export uses one free export; retries of the same authorized job do not use another. Pro has no monthly export quota, with up to 500 designs per batch.</p></dialog>;
}

export function SignInDialog({ account, onClose }: { account: Account; onClose: () => void }) {
  const dialog = useDialog();
  const [email, setEmail] = useState(''), [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [error, setError] = useState('');
  useEffect(() => { if (account.session) onClose(); }, [account.session]);
  async function signIn(event: React.FormEvent) {
    event.preventDefault(); if (!auth) return;
    setBusy(true); setError('');
    try { const result = await auth.auth.signInWithOtp({ email: email.trim(), options: { emailRedirectTo: location.origin } }); if (result.error) throw result.error; setMessage('Check your email for a secure sign-in link. You can close this window after opening it.'); }
    catch (error) { setError(error instanceof Error ? error.message : 'Could not send your sign-in link.'); }
    finally { setBusy(false); }
  }
  return <dialog ref={dialog} className="guide-dialog auth-dialog" onCancel={onClose} aria-labelledby="signin-title"><button className="guide-close icon-button" aria-label="Close sign in" onClick={onClose}><X size={20} /></button><span className="product-dialog-icon"><Mail size={24} /></span><h2 id="signin-title">A little less setup.</h2><p className="guide-intro">Sign in with an email link. No password to remember.</p>{!account.configured ? <p className="product-error">Customer sign-in is not connected in this owner workspace. Complete the hosted launch setup first.</p> : <form onSubmit={event => void signIn(event)}><label htmlFor="signin-email">Your email</label><input id="signin-email" type="email" autoComplete="email" required value={email} onChange={event => setEmail(event.target.value)} placeholder="you@yourprintshop.com" /><button className="button button-green" disabled={busy}>{busy ? <LoaderCircle size={16} className="spin" /> : <Mail size={16} />}Send sign-in link</button></form>}{message && <p className="product-success" role="status">{message}</p>}{error && <p className="product-error" role="alert">{error}</p>}<p className="quota-footnote">Your account tracks your export allowance and saved presets. In the hosted service, artwork pixels stay in your browser; cut-path geometry is sent to the export service.</p></dialog>;
}

export function PresetControls({ account, settings, onApply, onUpgrade, notify }: { account: Account; settings: Settings; onApply: (value: Settings) => void; onUpgrade: () => void; notify: (text: string, error?: boolean) => void }) {
  const [open, setOpen] = useState(false);
  const enabled = account.owner || account.allowance.pro;
  return <><button className="preset-launch" onClick={() => enabled ? setOpen(true) : onUpgrade()}><Bookmark size={15} /><span>Saved presets</span>{!enabled ? <span className="pro-chip">PRO</span> : <Plus size={13} />}</button>{open && <PresetDialog account={account} settings={settings} onApply={onApply} notify={notify} onClose={() => setOpen(false)} />}</>;
}

function PresetDialog({ account, settings, onApply, notify, onClose }: { account: Account; settings: Settings; onApply: (value: Settings) => void; notify: (text: string, error?: boolean) => void; onClose: () => void }) {
  const dialog = useDialog();
  const [items, setItems] = useState<Preset[]>([]), [name, setName] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const ownerKey = 'contour-owner-presets-v1';
  useEffect(() => { void (async () => { try { const stored = account.owner ? JSON.parse(localStorage.getItem(ownerKey) || '[]') : await api<Preset[]>('/api/presets', account.token); if (!Array.isArray(stored)) throw new Error(); setItems(stored.filter((item): item is Preset => item && typeof item.id === 'string' && typeof item.name === 'string' && item.settings && Number.isFinite(item.settings.widthMm) && item.settings.widthMm >= 5 && item.settings.widthMm <= 1000 && Number.isFinite(item.settings.offsetMm) && item.settings.offsetMm >= 0 && item.settings.offsetMm <= 10 && Number.isFinite(item.settings.smoothing) && Number.isInteger(item.settings.threshold) && typeof item.settings.holes === 'boolean'));  } catch { setError('Could not load your presets.'); } })(); }, [account.owner, account.token]);
  async function save(event: React.FormEvent) {
    event.preventDefault(); const trimmed = name.trim(); if (!trimmed) return;
    setBusy(true); setError('');
    try {
      const saved = account.owner ? { id: items.find(item => item.name === trimmed)?.id || crypto.randomUUID(), name: trimmed, settings: { ...settings } } : await api<Preset>('/api/presets', account.token, 'POST', { name: trimmed, settings });
      const updated = [...items.filter(item => item.id !== saved.id), saved].sort((a, b) => a.name.localeCompare(b.name));
      if (updated.length > 50) throw new Error('You can save up to 50 presets.');
      if (account.owner) localStorage.setItem(ownerKey, JSON.stringify(updated));
      setItems(updated); setName(''); notify(`Preset “${trimmed}” saved.`);
    } catch (error) { setError(error instanceof Error ? error.message : 'Could not save this preset.'); }
    finally { setBusy(false); }
  }
  async function remove(id: string) {
    setBusy(true); setError('');
    try { if (!account.owner) await api('/api/presets', account.token, 'DELETE', { id }); const updated = items.filter(item => item.id !== id); if (account.owner) localStorage.setItem(ownerKey, JSON.stringify(updated)); setItems(updated); }
    catch (error) { setError(error instanceof Error ? error.message : 'Could not delete this preset.'); }
    finally { setBusy(false); }
  }
  return <dialog ref={dialog} className="guide-dialog preset-dialog" onCancel={onClose} aria-labelledby="preset-title"><button className="guide-close icon-button" aria-label="Close presets" onClick={onClose}><X size={20} /></button><span className="product-dialog-icon"><Bookmark size={23} /></span><h2 id="preset-title">Dial it in. Save it.</h2><p className="guide-intro">Keep your favorite contour settings ready for the next batch.</p><form className="preset-save" onSubmit={event => void save(event)}><input aria-label="Preset name" placeholder="e.g. Vinyl stickers · 2 mm" required maxLength={50} value={name} onChange={event => setName(event.target.value)} /><button className="button button-green" disabled={busy} type="submit"><Plus size={15} />Save current</button></form><div className="preset-list">{items.map(item => <div key={item.id}><button className="preset-apply" disabled={busy} onClick={() => { onApply({ ...item.settings }); notify(`Preset “${item.name}” applied.`); onClose(); }}><strong>{item.name}</strong><span>{item.settings.widthMm} mm artwork · {item.settings.offsetMm} mm offset</span></button><button className="icon-button" aria-label={`Delete preset ${item.name}`} disabled={busy} onClick={() => void remove(item.id)}><Trash2 size={16} /></button></div>)}</div>{!items.length && <p className="export-explanation">No presets yet. Save your current settings above.</p>}{error && <p className="product-error" role="alert">{error}</p>}<p className="quota-footnote">{account.owner ? 'Owner presets are saved on this device. Clearing browser data removes them.' : 'Presets are saved privately to your account. Artwork files are never included.'}</p></dialog>;
}
