import { useEffect, useRef, useState } from 'react';
import {
  ArrowDownToLine, ArrowRight, ArrowUpRight, Check, CheckCheck,
  ChevronDown, CircleHelp, Copy, Expand, Eye, FileImage, FileOutput,
  FolderOpen, Layers2, LoaderCircle, Minus, MousePointer2,
  Plus, ScanLine, Scissors, Settings2, ShieldCheck, SlidersHorizontal,
  Sparkles, Upload, X,
} from 'lucide-react';
import { boundsFor, decodeArtwork, ringPath } from './contour';
import { artworkBlob, cleanExpiredWorkspaces, clearArtwork, clearDownloads, deleteArtwork, downloadBlob, ensureStorageAvailable, storeArtwork } from './artwork-store';
import { ARTWORK_PAGE_SIZE, MAX_BATCH_DESIGNS, MAX_WORKSPACE_BYTES, formatBytes } from './batch-limits';
import type { ExportProgress } from './batch-export';
import { samples } from './samples';
import { api, auth, HOSTED, useAccount } from './account';
import { PlansDialog, PresetControls, SignInDialog, ThemeToggle } from './ProductUI';
import { defaultSettings, type ArtworkSummary, type DownloadPart, type Ring, type Settings, type TracedSummary } from './types';

type TraceResult = { id: string; rings: Ring[]; error?: string };
const supported = /\.(png|webp|jpe?g|svg)$/i;

function Logo({ small = false }: { small?: boolean }) {
  return <span className={`logo ${small ? 'small' : ''}`}><span className="logo-mark"><ScanLine size={24} strokeWidth={1.7} /><span /></span>{!small && <>contour<span className="logo-period">.</span></>}</span>;
}

export default function App() {
  const account = useAccount();
  const isPro = account.owner || account.allowance.pro;
  const batchLimit = isPro ? MAX_BATCH_DESIGNS : 1;
  const [plansOpen, setPlansOpen] = useState(false);
  const [signInOpen, setSignInOpen] = useState(false);
  const [artworks, setArtworks] = useState<ArtworkSummary[]>([]);
  const [traces, setTraces] = useState<Record<string, TraceResult>>({});
  const [selectedId, setSelectedId] = useState('');
  const [included, setIncluded] = useState<Set<string>>(new Set());
  const [settings, setSettings] = useState<Settings>(defaultSettings);
  const [busy, setBusy] = useState(false);
  const [completedTraceKey, setCompletedTraceKey] = useState('');
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [notice, setNotice] = useState<{ text: string; error?: boolean } | null>(null);
  const [guide, setGuide] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [showArt, setShowArt] = useState(true);
  const [showCut, setShowCut] = useState(true);
  const [zoom, setZoom] = useState(100);
  const [selectedImage, setSelectedImage] = useState('');
  const [importProgress, setImportProgress] = useState({ completed: 0, total: 0 });
  const [traceProgress, setTraceProgress] = useState({ completed: 0, total: 0 });
  const [exportProgress, setExportProgress] = useState<ExportProgress>({ completed: 0, total: 0, phase: 'Creating PDFs' });
  const [downloadParts, setDownloadParts] = useState<DownloadPart[]>([]);
  const [downloadsOpen, setDownloadsOpen] = useState(false);
  const [artworkPage, setArtworkPage] = useState(0);
  const [search, setSearch] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const init = useRef(false);
  const uploadLock = useRef(false);
  const cancelImport = useRef(false);
  const workspace = useRef(crypto.randomUUID()).current;
  const storedBytes = useRef(new Map<string, number>());
  const exportWorker = useRef<Worker | null>(null);
  const exportRun = useRef(0);
  const exportJob = useRef<string | null>(null);
  const exportAttempt = useRef<{ key: string; clientId: string; jobId?: string } | null>(null);
  const traceCache = useRef(new Map<string, { key: string; result: TraceResult }>());

  function notify(text: string, error = false) { setNotice({ text, error }); }
  function update<K extends keyof Settings>(key: K, value: Settings[K]) { setSettings(old => ({ ...old, [key]: value })); }

  async function loadSamples() {
    if (uploadLock.current) return;
    uploadLock.current = true;
    setLoading(true);
    try {
      await cleanExpiredWorkspaces();
      const loaded: ArtworkSummary[] = [];
      for (const sample of samples) {
        const stored = await storeArtwork(workspace, await decodeArtwork(new Blob([sample.svg], { type: 'image/svg+xml' }), sample.name, true));
        storedBytes.current.set(stored.summary.id, stored.bytes);
        loaded.push(stored.summary);
      }
      setArtworks(loaded); setSelectedId(loaded[0].id); setIncluded(new Set(loaded.map(art => art.id)));
    } catch (error) { notify(error instanceof Error ? error.message : 'Could not load samples.', true); }
    finally { setLoading(false); uploadLock.current = false; }
  }

  useEffect(() => { if (!init.current) { init.current = true; void loadSamples(); } }, []);
  useEffect(() => () => exportWorker.current?.terminate(), []);
  useEffect(() => {
    if (!isPro) {
      setSettings(old => ({ ...old, smoothing: defaultSettings.smoothing, holes: false, threshold: defaultSettings.threshold, layout: 'individual' }));
    }
  }, [isPro]);
  useEffect(() => {
    if (!isPro) setIncluded(old => old.size > 1 ? new Set([artworks.find(art => old.has(art.id))?.id || ''].filter(Boolean)) : old);
  }, [isPro, artworks]);
  useEffect(() => {
    if (!selectedId) { setSelectedImage(''); return; }
    let cancelled = false, url = '';
    setSelectedImage('');
    void artworkBlob(workspace, selectedId).then(blob => {
      if (!cancelled) { url = URL.createObjectURL(blob); setSelectedImage(url); }
    }).catch(error => { if (!cancelled) notify(error instanceof Error ? error.message : 'Could not preview this image.', true); });
    return () => { cancelled = true; if (url) URL.revokeObjectURL(url); };
  }, [selectedId, workspace]);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), notice.error ? 12000 : 6000);
    return () => window.clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    if (!guide) return;
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') setGuide(false); };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [guide]);

  const traceKey = JSON.stringify([settings.widthMm, settings.offsetMm, settings.threshold, settings.smoothing, settings.background, settings.holes]);
  const requestKey = JSON.stringify([artworks.map(art => art.id), traceKey]);
  const geometryCurrent = completedTraceKey === requestKey;
  const processing = busy || (artworks.length > 0 && !geometryCurrent);
  useEffect(() => {
    if (loading) return;
    if (!artworks.length) { setTraces({}); setCompletedTraceKey(requestKey); setBusy(false); return; }
    setBusy(true);
    const cached: Record<string, TraceResult> = {};
    const pending = artworks.filter(art => {
      const entry = traceCache.current.get(art.id);
      if (entry?.key === traceKey) { cached[art.id] = entry.result; return false; }
      return true;
    });
    setTraces(cached);
    setTraceProgress({ completed: artworks.length - pending.length, total: artworks.length });
    if (!pending.length) { setCompletedTraceKey(requestKey); setBusy(false); return; }
    let worker: Worker | undefined;
    const timer = window.setTimeout(() => {
      worker = new Worker(new URL('./trace.worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = (event: MessageEvent<{ result?: TraceResult; completed?: number; done?: boolean }>) => {
        if (event.data.result) {
          const result = event.data.result;
          traceCache.current.set(result.id, { key: traceKey, result });
          setTraces(old => ({ ...old, [result.id]: result }));
          setTraceProgress({ completed: artworks.length - pending.length + (event.data.completed || 0), total: artworks.length });
        }
        if (event.data.done) { setCompletedTraceKey(requestKey); setBusy(false); worker?.terminate(); }
      };
      worker.onerror = () => { setCompletedTraceKey(requestKey); setBusy(false); notify('Contour processing failed. Try a smaller batch or re-import the affected image.', true); worker?.terminate(); };
      worker.postMessage({ workspace, artworks: pending, settings });
    }, 180);
    return () => { window.clearTimeout(timer); worker?.terminate(); };
  }, [artworks, traceKey, loading]);

  async function upload(files: FileList | File[]) {
    if (uploadLock.current || exporting) return;
    const list = Array.from(files);
    if (!list.length) return;
    const retained = isPro ? artworks.filter(art => !art.demo) : [];
    if (retained.length + list.length > batchLimit) { notify(isPro ? `A batch can contain up to ${batchLimit} designs. Export this batch first.` : 'Batch processing is a Pro feature. Free accounts can work with one design at a time.', true); if (!isPro) setPlansOpen(true); return; }
    uploadLock.current = true;
    cancelImport.current = false;
    setLoading(true);
    setImportProgress({ completed: 0, total: list.length });
    const loaded: ArtworkSummary[] = [], errors: string[] = [];
    try {
      for (let i = 0; i < list.length; i++) {
        if (cancelImport.current) break;
        const file = list[i];
        if (!supported.test(file.name)) errors.push(`${file.name}: use PNG, SVG, JPG, or WebP.`);
        else try {
          await ensureStorageAvailable(Math.max(file.size, 8 * 1024 * 1024));
          const art = await decodeArtwork(file, file.name);
          if (cancelImport.current) break;
          const stored = await storeArtwork(workspace, art);
          const totalBytes = [...storedBytes.current.values()].reduce((sum, bytes) => sum + bytes, 0);
          if (totalBytes + stored.bytes > MAX_WORKSPACE_BYTES) {
            await deleteArtwork(workspace, art.id);
            throw new Error('This workspace reached its 1 GB artwork budget. Export it before starting another batch.');
          }
          storedBytes.current.set(art.id, stored.bytes);
          loaded.push(stored.summary);
          if (loaded.length === 1) {
            for (const demo of artworks.filter(item => !retained.some(kept => kept.id === item.id))) { await deleteArtwork(workspace, demo.id); storedBytes.current.delete(demo.id); traceCache.current.delete(demo.id); }
            setSelectedId(art.id); setZoom(100); setArtworkPage(0); setSearch('');
          }
          if (loaded.length % 10 === 0) setArtworks([...retained, ...loaded]);
        } catch (error) {
          errors.push(error instanceof Error ? error.message : `Could not read ${file.name}.`);
          if (error instanceof DOMException && error.name === 'QuotaExceededError' || errors.at(-1)?.includes('storage') || errors.at(-1)?.includes('1 GB')) break;
        }
        setImportProgress({ completed: i + 1, total: list.length });
      }
      if (loaded.length) {
        setArtworks([...retained, ...loaded]);
        setIncluded(old => new Set([...retained.filter(art => old.has(art.id)).map(art => art.id), ...loaded.map(art => art.id)]));
      }
      if (errors.length) notify(`${errors.slice(0, 3).join(' ')}${errors.length > 3 ? ` Plus ${errors.length - 3} more unreadable files.` : ''}`, true);
      else if (cancelImport.current) notify(`Import stopped. Kept ${loaded.length} completed designs.`);
      else if (loaded.length) notify(`${loaded.length} ${loaded.length === 1 ? 'design added' : 'designs added'}. Your artwork stays in this browser.`);
    } finally { setLoading(false); uploadLock.current = false; if (input.current) input.current.value = ''; }
  }

  function remove(id: string) {
    if (loading || exporting) return;
    const remaining = artworks.filter(art => art.id !== id);
    traceCache.current.delete(id); storedBytes.current.delete(id);
    void deleteArtwork(workspace, id).catch(() => notify('Could not clear this image from browser storage.', true));
    setArtworks(remaining); setIncluded(old => { const next = new Set(old); next.delete(id); return next; });
    if (selectedId === id) setSelectedId(remaining[0]?.id || '');
  }
  function toggleIncluded(id: string) { setIncluded(old => { const next = isPro ? new Set(old) : new Set<string>(); if (old.has(id)) next.delete(id); else next.add(id); return next; }); }
  async function clearBatch() {
    if (loading || exporting) return;
    setArtworks([]); setIncluded(new Set()); setSelectedId(''); setSearch(''); setArtworkPage(0);
    storedBytes.current.clear(); traceCache.current.clear();
    try { await clearArtwork(workspace); notify('Batch cleared. Completed downloads are still available.'); }
    catch { notify('Could not remove all temporary artwork. Reload the page before a new batch.', true); }
  }
  const traced = artworks.map(art => ({ ...art, rings: traces[art.id]?.rings || [], error: traces[art.id]?.error })) as TracedSummary[];
  const selected = traced.find(art => art.id === selectedId);
  const batch = traced.filter(art => included.has(art.id));
  const ready = !processing && !loading && batch.length > 0 && batch.every(art => art.rings.length > 0 && !art.error);
  const pathCount = geometryCurrent ? batch.reduce((sum, art) => sum + art.rings.length, 0) : 0;
  const bounds = selected ? boundsFor(selected) : null;
  const padding = bounds ? Math.max(bounds.width, bounds.height) * 0.13 : 0;
  const viewbox = bounds ? `${bounds.minX - padding} ${bounds.minY - padding} ${bounds.width + padding * 2} ${bounds.height + padding * 2}` : '0 0 600 600';
  const allDemo = artworks.length > 0 && artworks.every(art => art.demo);

  const filteredArtworks = traced.filter(art => art.name.toLowerCase().includes(search.toLowerCase()));
  const pageCount = Math.max(1, Math.ceil(filteredArtworks.length / ARTWORK_PAGE_SIZE));
  const currentPage = Math.min(artworkPage, pageCount - 1);
  const visibleArtworks = filteredArtworks.slice(currentPage * ARTWORK_PAGE_SIZE, (currentPage + 1) * ARTWORK_PAGE_SIZE);

  async function downloadPart(part: DownloadPart) {
    try {
      const url = URL.createObjectURL(await downloadBlob(workspace, part.id));
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = part.name;
      document.body.appendChild(anchor); anchor.click(); anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch (error) { notify(error instanceof Error ? error.message : 'Could not open this download.', true); }
  }

  function stopExport() {
    exportRun.current++;
    exportWorker.current?.terminate(); exportWorker.current = null;
    setExporting(false); setDownloadsOpen(false); setDownloadParts([]);
    void clearDownloads(workspace).catch(() => {});
    if (exportJob.current && account.token) void api('/api/export-jobs', account.token, 'DELETE', { id: exportJob.current }).finally(() => { void account.refresh(); }).catch(() => {});
    exportJob.current = null;
    exportAttempt.current = null;
    notify('Export stopped. Your artwork and contour settings are unchanged.');
  }

  async function exportBatch() {
    if (!ready || exporting) return;
    if (HOSTED && !account.session) { setSignInOpen(true); return; }
    if (HOSTED && account.loading) { notify('Checking your account. Please retry in a moment.'); return; }
    const run = ++exportRun.current;
    setExporting(true); setDownloadsOpen(true); setDownloadParts([]);
    setExportProgress({ completed: 0, total: batch.length, phase: 'Creating PDFs' });
    try {
      await clearDownloads(workspace);
      if (run !== exportRun.current) return;
      const key = JSON.stringify([requestKey, batch.map(art => art.id), settings.layout, settings.includeArtwork]);
      if (exportAttempt.current?.key !== key) {
        if (exportAttempt.current?.jobId && account.token) await api('/api/export-jobs', account.token, 'DELETE', { id: exportAttempt.current.jobId });
        exportAttempt.current = { key, clientId: crypto.randomUUID() };
      }
      if (run !== exportRun.current) return;
      const worker = new Worker(new URL('./export.worker.ts', import.meta.url), { type: 'module' });
      exportWorker.current = worker;
      exportJob.current = null;
      worker.onmessage = (event: MessageEvent<{ progress?: ExportProgress; parts?: DownloadPart[]; error?: string; jobId?: string }>) => {
        if (run !== exportRun.current) return;
        if (event.data.jobId) { exportJob.current = event.data.jobId; if (exportAttempt.current) exportAttempt.current.jobId = event.data.jobId; }
        if (event.data.progress) setExportProgress(event.data.progress);
        if (event.data.error) { notify(event.data.error, true); if (event.data.error.includes('5 free exports')) setPlansOpen(true); setDownloadsOpen(false); setExporting(false); worker.terminate(); exportWorker.current = null; void account.refresh(); }
        if (event.data.parts) {
          const parts = event.data.parts;
          setDownloadParts(parts); setExporting(false); worker.terminate(); exportWorker.current = null;
          exportAttempt.current = null; exportJob.current = null;
          if (parts.length === 1) { void downloadPart(parts[0]); setDownloadsOpen(false); }
          notify(parts.length === 1 ? `${batch.length} ${batch.length === 1 ? 'design' : 'designs'} exported with CutContour spot-color paths.` : `${batch.length} designs exported into ${parts.length} download parts.`);
          void account.refresh();
        }
      };
      worker.onerror = () => { notify('Export processing failed. Try fewer designs or close other browser tabs.', true); setExporting(false); setDownloadsOpen(false); worker.terminate(); exportWorker.current = null; };
      worker.postMessage({ workspace, artworks: batch, settings, token: account.token, clientId: exportAttempt.current!.clientId });
    } catch (error) { notify(error instanceof Error ? error.message : 'Export failed.', true); setExporting(false); setDownloadsOpen(false); }
  }

  return <div className="app-shell" onDragOver={event => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); setDragging(true); } }}>
    <input ref={input} type="file" multiple accept=".png,.svg,.jpg,.jpeg,.webp" className="visually-hidden" aria-label="Upload artwork files" onChange={event => { if (event.target.files) void upload(event.target.files); }} />
    <aside className="rail" aria-label="Main navigation">
      <Logo small />
      <div className="rail-divider" />
      <button className="rail-button active" title="Batch workspace" aria-label="Batch workspace" onClick={() => setGuide(false)}><Layers2 size={21} /></button>
      <button className="rail-button" title="Upload artwork" aria-label="Upload artwork" onClick={() => input.current?.click()}><FolderOpen size={21} /></button>
      <div className="rail-bottom"><button className="rail-button" title="VersaWorks guide" aria-label="Open VersaWorks guide" onClick={() => setGuide(true)}><CircleHelp size={21} /></button><div className="avatar">CW</div></div>
    </aside>

    <div className="main-shell">
      <header className="topbar"><Logo /><span className="topbar-divider" /><span className="workspace-name">Your print workspace <ChevronDown size={13} /></span><div className="topbar-end"><ThemeToggle /><button className="plan-badge" onClick={() => setPlansOpen(true)}>{account.owner ? 'Owner edition' : isPro ? 'Pro' : 'Free'}<ChevronDown size={12} /></button><button className="text-button plans-link" onClick={() => setPlansOpen(true)}>Plans & pricing</button>{HOSTED && <button className="text-button account-link" onClick={() => account.session ? void auth?.auth.signOut() : setSignInOpen(true)}>{account.session ? 'Sign out' : 'Sign in'}</button>}<button className="text-button" onClick={() => setGuide(true)}>Quick guide <ArrowUpRight size={15} /></button></div></header>

      <main>
        <div className="breadcrumb"><span>Workspace</span><span>/</span><span>Batch contour</span></div>
        <section className="page-heading"><div><div className="eyebrow"><span /> MADE FOR YOUR NEXT PRINT RUN</div><h1>Great artwork. <span>Clean cuts.</span></h1><p>Turn your designs into print-ready contour cut files, all in one batch.</p></div><button className="button button-white heading-help" onClick={() => setGuide(true)}><CircleHelp size={16} /> How it works</button></section>

        <div className="workflow-strip"><div className="workflow-step current"><span className="step-number">1</span><strong>Add artwork</strong><span className="step-caption">PNG, SVG, JPG, WebP</span></div><div className="step-line" /><div className="workflow-step"><span className="step-number">2</span><strong>Fine-tune contours</strong></div><div className="step-line" /><div className="workflow-step"><span className="step-number">3</span><strong>Export for VersaWorks</strong></div><span className="workflow-note"><ShieldCheck size={15} /> {HOSTED ? 'Artwork stays on your device' : 'Files never leave your browser'}</span></div>

        {HOSTED && <div className="account-usage"><span>{account.session ? isPro ? 'Pro · unlimited exports · 500 designs per batch' : `${account.allowance.remaining} of 5 free exports remaining this month` : 'Free · 5 exports per month after sign-in'}</span>{account.error && <span role="alert">{account.error}</span>}{!account.configured && <span>Hosted account setup is incomplete.</span>}<button onClick={() => isPro ? setPlansOpen(true) : account.session ? setPlansOpen(true) : setSignInOpen(true)}>{isPro ? 'Manage plan' : account.session ? 'Upgrade to Pro' : 'Sign in free'}<ArrowRight size={13} /></button></div>}
        <section className="studio" aria-label="Contour workspace">
          <aside className="artwork-panel">
            <div className="panel-heading"><div><h2>Artwork <span className="count-badge">{artworks.length}</span></h2><p>Your batch, all in one place.</p></div><button className="icon-button" title="Add artwork" aria-label="Add artwork" disabled={loading} onClick={() => input.current?.click()}><Plus size={18} /></button></div>
            <button className="upload-zone" onClick={() => input.current?.click()} disabled={loading}><span className="upload-icon">{loading ? <LoaderCircle className="spin" size={21} /> : <Upload size={21} />}</span><strong>{loading ? `Importing ${importProgress.completed} / ${importProgress.total}` : 'Drop your artwork here'}</strong><span>or <u>browse files</u></span><small>{isPro ? `Up to ${MAX_BATCH_DESIGNS} files` : 'One design at a time'} · 30 MB each</small></button>
            {loading && <button className="cancel-import" onClick={() => { cancelImport.current = true; }}>Stop import · keep completed files</button>}
            {artworks.length > ARTWORK_PAGE_SIZE && <input className="artwork-search" type="search" aria-label="Search artwork" placeholder="Find a design…" value={search} onChange={event => { setSearch(event.target.value); setArtworkPage(0); }} />}
            <div className="batch-label"><span>{allDemo ? 'SAMPLE BATCH' : 'BATCH ARTWORK'}</span><span className="batch-actions"><button onClick={() => !isPro && artworks.length > 1 ? setPlansOpen(true) : setIncluded(included.size === artworks.length ? new Set() : new Set(artworks.map(art => art.id)))} disabled={!artworks.length || loading}>{included.size === artworks.length && artworks.length ? 'Deselect all' : 'Select all'}</button><button aria-label="Clear batch" disabled={!artworks.length || loading || exporting} onClick={() => void clearBatch()}>Clear</button></span></div>
            <div className="artwork-list">{visibleArtworks.map(art => <div key={art.id} className={`artwork-item ${selectedId === art.id ? 'selected' : ''}`}>
              <input type="checkbox" aria-label={`Include ${art.name}`} checked={included.has(art.id)} onChange={() => toggleIncluded(art.id)} />
              <button className="artwork-select" onClick={() => { setSelectedId(art.id); setZoom(100); }}><span className="artwork-thumb checker"><img src={art.image} alt="" /></span><span className="artwork-info"><strong>{art.name}</strong><span>{settings.widthMm} × {(settings.widthMm * art.height / art.width).toFixed(1)} mm</span><small className={art.error ? 'error-text' : ''}>{processing ? 'Tracing…' : art.error ? 'Needs attention' : <><span className="tiny-dot" />{art.rings.length} {art.rings.length === 1 ? 'cut path' : 'cut paths'}</>}</small></span></button>
              <button className="remove-artwork" title={`Remove ${art.name}`} aria-label={`Remove ${art.name}`} disabled={loading} onClick={() => remove(art.id)}><X size={14} /></button>
            </div>)}</div>
            {pageCount > 1 && <nav className="artwork-pagination" aria-label="Artwork pages"><button disabled={currentPage === 0} onClick={() => setArtworkPage(currentPage - 1)}>Previous</button><span>{currentPage + 1} / {pageCount}</span><button disabled={currentPage >= pageCount - 1} onClick={() => setArtworkPage(currentPage + 1)}>Next</button></nav>}
            {!artworks.length && <div className="empty-list"><FileImage size={28} /><p>Your next print run starts here.</p><button className="text-button" onClick={() => void loadSamples()}>Try sample artwork <ArrowRight size={14} /></button></div>}
            <div className="artwork-panel-footer"><span className="mini-icon"><Copy size={15} /></span><p>One setting. Your whole batch.<br /><span>Contour settings apply to every design.</span></p></div>
          </aside>

          <section className="preview-panel" aria-label="Artwork preview">
            <div className="preview-toolbar"><div className="preview-title"><Eye size={16} /><strong>Live preview</strong><span className="live-dot" /></div><div className="preview-tools"><button aria-label="Toggle artwork visibility" title="Toggle artwork visibility" aria-pressed={showArt} className={`icon-button ${showArt ? 'toggled' : ''}`} onClick={() => setShowArt(!showArt)}><FileImage size={16} /></button><button aria-label="Toggle contour visibility" title="Toggle contour visibility" aria-pressed={showCut} className={`icon-button ${showCut ? 'toggled' : ''}`} onClick={() => setShowCut(!showCut)}><ScanLine size={17} /></button><span className="toolbar-divider" /><button className="icon-button" title="Fit artwork to preview" aria-label="Fit artwork to preview" onClick={() => setZoom(100)}><Expand size={16} /></button></div></div>
            <div className="preview-stage checker">
              <div className="stage-label"><span className="stage-file">{selected?.name || 'Your artwork goes here'}</span>{selected?.demo && <span className="sample-tag">SAMPLE</span>}</div>
              {selected ? <div className="artboard-wrap"><svg aria-label={`Contour preview of ${selected.name}`} className="artboard" viewBox={viewbox} style={{ transform: `scale(${zoom / 100})` }}>
                {showArt && <image href={selectedImage || selected.image} width={selected.width} height={selected.height} />}
                {showCut && geometryCurrent && <path d={ringPath(selected.rings)} fill="none" stroke="#ed2688" strokeWidth="1.25" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />}
              </svg><div className="dimension-line"><span />{settings.widthMm.toFixed(1)} mm artwork<span /></div></div> : <div className="empty-preview"><ScanLine size={48} strokeWidth={1} /><h3>A clean cut starts here.</h3><p>Add artwork to preview your contour.</p><button className="button button-green" onClick={() => input.current?.click()}><Plus size={16} /> Add artwork</button></div>}
              {processing && <span className="processing-pill"><LoaderCircle size={13} className="spin" /> Tracing {traceProgress.completed} / {traceProgress.total}</span>}
              {selected?.error && !processing && <div className="preview-error">{selected.error}</div>}
              <div className="stage-bottom"><span className="cut-legend"><i /> CutContour</span><div className="zoom-controls"><button aria-label="Zoom out" disabled={zoom <= 50} onClick={() => setZoom(Math.max(50, zoom - 25))}><Minus size={14} /></button><button aria-label="Reset zoom" onClick={() => setZoom(100)}>{zoom}%</button><button aria-label="Zoom in" disabled={zoom >= 200} onClick={() => setZoom(Math.min(200, zoom + 25))}><Plus size={14} /></button></div></div>
            </div>
            <div className="preview-footer"><span><MousePointer2 size={13} /> Select a design to inspect its contour</span><span><span className="pink-dot" /> Spot color preview</span></div>
          </section>

          <aside className="settings-panel"><div className="panel-heading"><div><h2><SlidersHorizontal size={16} /> Contour settings</h2><p>A little precision goes a long way.</p></div><button className="reset-button" onClick={() => { setSettings(defaultSettings); notify('Contour settings reset to defaults.'); }}>Reset</button></div>
            <div className="settings-body"><div className="setting-group"><div className="field-label"><label htmlFor="width">Artwork width</label><span>Proportional height</span></div><div className="number-input"><input id="width" type="number" min="5" max="1000" step="1" value={settings.widthMm} onChange={event => update('widthMm', Math.max(5, Math.min(1000, Number(event.target.value) || 5)))} /><span>mm</span></div></div>
              <div className="setting-group offset-group"><div className="field-label"><label htmlFor="offset">Cut offset</label><span className="value-chip">{settings.offsetMm.toFixed(1)} mm</span></div><input className="range" id="offset" type="range" min="0" max="10" step="0.1" value={settings.offsetMm} onChange={event => update('offsetMm', Number(event.target.value))} style={{ '--range-progress': `${settings.offsetMm * 10}%` } as React.CSSProperties} /><div className="range-labels"><span>On the edge</span><span>10 mm</span></div><p className="field-hint">Adds a border outside your artwork.</p></div>
              <div className="setting-group"><div className="field-label"><label htmlFor="smoothing">Path smoothing</label><span className="value-chip">{settings.smoothing <= 0.2 ? 'Precise' : settings.smoothing < 1 ? 'Balanced' : 'Smooth'}</span></div><input className="range" id="smoothing" disabled={!isPro} type="range" min="0.05" max="2" step="0.05" value={settings.smoothing} onChange={event => update('smoothing', Number(event.target.value))} style={{ '--range-progress': `${(settings.smoothing - 0.05) / 1.95 * 100}%` } as React.CSSProperties} /><div className="range-labels"><span>More detail</span><span>Fewer nodes</span></div></div>
              <div className="settings-divider" /><div className="setting-group"><div className="field-label"><label htmlFor="background">Trace from</label></div><div className="select-wrap"><select id="background" value={settings.background} onChange={event => update('background', event.target.value as Settings['background'])}><option value="alpha">Transparent background</option><option value="white">Ignore white background</option></select><ChevronDown size={14} /></div></div>
              <div className="toggle-row"><div><label htmlFor="holes">Include inner cutouts</label><p>Cut holes inside your design</p></div><input id="holes" disabled={!isPro} className="switch" type="checkbox" checked={settings.holes} onChange={event => update('holes', event.target.checked)} /></div>
              <details className="advanced"><summary><Settings2 size={14} /> Advanced settings <ChevronDown size={13} /></summary><div className="field-label"><label htmlFor="threshold">Alpha threshold</label><span>{settings.threshold}</span></div><input id="threshold" disabled={!isPro} type="range" className="range" min="1" max="254" value={settings.threshold} onChange={event => update('threshold', Number(event.target.value))} /><p className="field-hint">Lower values include more transparent edge pixels. White mode also ignores pixels near white.</p></details>
              {!isPro && <button className="unlock-advanced" onClick={() => setPlansOpen(true)}>Unlock advanced settings <span className="pro-chip">PRO</span></button>}
              <div className="spot-card"><span className="spot-icon"><ScanLine size={18} /></span><div><strong>CutContour <span>SPOT COLOR</span></strong><p>Named for Roland VersaWorks.</p></div><span className="spot-swatch" /></div>
              <PresetControls account={account} settings={settings} onApply={setSettings} onUpgrade={() => setPlansOpen(true)} notify={notify} />
            </div>
          </aside>
        </section>

        <section className="export-bar" aria-label="Export batch"><div className="batch-status"><span className={`status-icon ${!ready ? 'waiting' : ''}`}>{processing || loading ? <LoaderCircle size={20} className="spin" /> : <CheckCheck size={21} />}</span><div><strong>{loading ? `Importing ${importProgress.completed} / ${importProgress.total} designs…` : processing ? `Tracing ${traceProgress.completed} / ${traceProgress.total} designs…` : ready ? `${batch.length} ${batch.length === 1 ? 'design' : 'designs'} ready to go` : batch.length ? 'Check your artwork' : 'Select artwork to export'}</strong><p>{pathCount} closed cut {pathCount === 1 ? 'path' : 'paths'} <span>·</span> {settings.offsetMm.toFixed(1)} mm offset <span>·</span> CutContour spot color</p></div></div><div className="export-options">{downloadParts.length > 0 && <button className="text-button saved-downloads" onClick={() => setDownloadsOpen(true)}>Downloads ({downloadParts.length})</button>}<label className="include-artwork"><input type="checkbox" checked={settings.includeArtwork} onChange={event => update('includeArtwork', event.target.checked)} /> Include artwork</label><div className="select-wrap export-layout"><FileOutput size={16} /><select aria-label="Export layout" value={settings.layout} onChange={event => update('layout', event.target.value as Settings['layout'])}><option value="individual">Separate PDFs</option><option value="a4" disabled={!isPro}>A4 cut sheets</option></select><ChevronDown size={13} /></div><button className="button button-green export-button" onClick={() => void exportBatch()} disabled={!ready || exporting}>{exporting ? <LoaderCircle size={17} className="spin" /> : <ArrowDownToLine size={17} />}{exporting ? 'Creating files…' : 'Export batch'}<span>{batch.length}</span></button></div></section>

        <div className="below-studio"><div className="tip"><Sparkles size={16} /><p>{allDemo ? <><strong>Take it for a test cut.</strong> You’re viewing sample artwork. Drop in your own designs to start a new batch.</> : <><strong>Made for your workflow.</strong> Export your batch, open the PDFs in VersaWorks, and check the cut-line preview.</>}</p></div><button className="text-button" onClick={() => setGuide(true)}>VersaWorks setup guide <ArrowUpRight size={14} /></button></div>
        <footer className="page-footer"><span>From artwork to a perfect outline.</span><span><ShieldCheck size={13} /> {HOSTED ? 'Local artwork. Secure accounts. Stripe billing.' : 'Private by design. Built for your print workflow.'}</span><span>CONTOUR STUDIO <span className="version">V1.2.0</span></span></footer>
      </main>
    </div>

    {dragging && <div className="drop-overlay" onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragging(false); }} onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); setDragging(false); void upload(event.dataTransfer.files); }}><div><Upload size={42} /><h2>Good art deserves a clean cut.</h2><p>Drop your files to add them to the batch.</p></div></div>}
    {notice && <div className={`toast ${notice.error ? 'toast-error' : ''}`} role={notice.error ? 'alert' : 'status'}>{notice.error ? <CircleHelp size={18} /> : <Check size={18} />}<span>{notice.text}</span><button aria-label="Dismiss notification" onClick={() => setNotice(null)}><X size={16} /></button></div>}
    {(downloadsOpen || exporting) && <ExportDialog exporting={exporting} progress={exportProgress} parts={downloadParts} onCancel={stopExport} onClose={() => setDownloadsOpen(false)} onDownload={part => void downloadPart(part)} />}
    {plansOpen && <PlansDialog account={account} onClose={() => setPlansOpen(false)} onSignIn={() => setSignInOpen(true)} />}
    {signInOpen && <SignInDialog account={account} onClose={() => setSignInOpen(false)} />}
    {guide && <Guide onClose={() => setGuide(false)} />}
  </div>;
}

function Guide({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); return () => dialog.current?.close(); }, []);
  return <dialog ref={dialog} className="guide-dialog" onCancel={onClose} onClick={event => { if (event.target === event.currentTarget) onClose(); }} aria-labelledby="guide-title"><button className="guide-close icon-button" aria-label="Close guide" onClick={onClose}><X size={20} /></button><div className="guide-eyebrow"><Scissors size={17} /> YOUR NEXT PRINT RUN</div><h2 id="guide-title">From pixels to precise cuts.</h2><p className="guide-intro">A quick guide to your Contour → VersaWorks workflow.</p><ol className="guide-steps"><li><span>01</span><div><h3>Add your artwork</h3><p>Drop in transparent PNGs, WebP files, or self-contained SVGs. Each design can have multiple separate shapes. For JPGs, choose “Ignore white background” to trace around nonwhite pixels.</p></div></li><li><span>02</span><div><h3>Check your outline and size</h3><p>Set the printed artwork width in millimeters. The offset adds a border beyond that width. Pink lines show the closed cut paths. Enable inner cutouts only when you want holes cut too.</p></div></li><li><span>03</span><div><h3>Export your batch</h3><p>Separate PDFs download as a ZIP when you select multiple designs. A4 sheets arrange your designs over as many pages as needed. Artwork is rasterized at up to 1,400 pixels on its longest edge; cut paths remain vectors. Transparent artwork is flattened onto white for RIP compatibility; cut lines stay vector. Very large print sizes may need a higher-resolution workflow.</p></div></li><li><span>04</span><div><h3>Open in Roland VersaWorks</h3><p>Extract the ZIP, add the PDFs to your queue, and inspect the preview for the animated dotted cut lines. The PDF uses a case-sensitive <code>CutContour</code> spot color and a 0.25 pt overprinted stroke. Use 100% scale and choose Print & Cut in your queue’s cutting controls.</p></div></li></ol><div className="guide-note"><ShieldCheck size={20} /><p>Run a small test cut before production. Confirm size, offset, cut-line recognition, and your media’s cutting force. VersaWorks compatibility must be verified on your own printer and software version.</p></div><button className="button button-green guide-done" onClick={onClose}>Back to the workspace <ArrowRight size={16} /></button></dialog>;
}

function ExportDialog({ exporting, progress, parts, onCancel, onClose, onDownload }: { exporting: boolean; progress: ExportProgress; parts: DownloadPart[]; onCancel: () => void; onClose: () => void; onDownload: (part: DownloadPart) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [downloaded, setDownloaded] = useState(new Set<string>());
  useEffect(() => { dialog.current?.showModal(); return () => dialog.current?.close(); }, []);
  return <dialog ref={dialog} className="guide-dialog export-dialog" aria-labelledby="export-title" onCancel={event => { if (exporting) event.preventDefault(); else onClose(); }}>
    <h2 id="export-title">{exporting ? 'Preparing your print run.' : 'Your batch is ready.'}</h2>
    {exporting ? <><p className="guide-intro">{progress.phase} · {progress.completed} of {progress.total} designs</p><progress className="batch-progress" max={progress.total || 1} value={progress.completed} /><p className="export-explanation">Large batches are processed in small groups to keep memory use manageable. You can stop without losing your artwork.</p><button className="button button-white" onClick={onCancel}>Cancel export</button></> : <><p className="guide-intro">{parts.length} {parts.length === 1 ? 'file' : 'parts'} · {parts.reduce((sum, part) => sum + part.designCount, 0)} designs. Download each part below.</p><div className="download-part-list">{parts.map(part => <button key={part.id} className="download-part" onClick={() => { onDownload(part); setDownloaded(old => new Set([...old, part.id])); }}><span>{downloaded.has(part.id) ? <Check size={18} /> : <ArrowDownToLine size={18} />}</span><span><strong>{part.name}</strong><small>{part.designCount} designs · {formatBytes(part.bytes)}</small></span><ArrowDownToLine size={16} /></button>)}</div><p className="export-explanation">Downloads are temporary and stay in this browser. Save every part before starting another export or closing the workspace.</p><button className="button button-green guide-done" onClick={onClose}>Back to workspace</button></>}
  </dialog>;
}
