import { useEffect, useRef, useState } from 'react';
import {
  ArrowDownToLine, ArrowRight, ArrowUpRight, Check, CheckCheck,
  ChevronDown, CircleHelp, Copy, Expand, Eye, FileImage, FileOutput,
  FolderOpen, Layers2, LoaderCircle, Minus, MousePointer2,
  Plus, ScanLine, Scissors, Settings2, ShieldCheck, SlidersHorizontal,
  Sparkles, Upload, X,
} from 'lucide-react';
import { boundsFor, decodeArtwork, ringPath } from './contour';
import { samples } from './samples';
import { defaultSettings, type Artwork, type Ring, type Settings, type TracedArtwork } from './types';

type TraceResult = { id: string; rings: Ring[]; error?: string };
const supported = /\.(png|webp|jpe?g|svg)$/i;

function Logo({ small = false }: { small?: boolean }) {
  return <span className={`logo ${small ? 'small' : ''}`}><span className="logo-mark"><ScanLine size={24} strokeWidth={1.7} /><span /></span>{!small && <>contour<span className="logo-period">.</span></>}</span>;
}

export default function App() {
  const [artworks, setArtworks] = useState<Artwork[]>([]);
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
  const input = useRef<HTMLInputElement>(null);
  const init = useRef(false);
  const uploadLock = useRef(false);

  function notify(text: string, error = false) { setNotice({ text, error }); }
  function update<K extends keyof Settings>(key: K, value: Settings[K]) { setSettings(old => ({ ...old, [key]: value })); }

  async function loadSamples() {
    if (uploadLock.current) return;
    uploadLock.current = true;
    setLoading(true);
    try {
      const loaded = await Promise.all(samples.map(sample => decodeArtwork(new Blob([sample.svg], { type: 'image/svg+xml' }), sample.name, true)));
      setArtworks(loaded); setSelectedId(loaded[0].id); setIncluded(new Set(loaded.map(art => art.id)));
    } catch (error) { notify(error instanceof Error ? error.message : 'Could not load samples.', true); }
    finally { setLoading(false); uploadLock.current = false; }
  }

  useEffect(() => { if (!init.current) { init.current = true; void loadSamples(); } }, []);
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
    if (!artworks.length) { setTraces({}); setCompletedTraceKey(requestKey); setBusy(false); return; }
    setBusy(true);
    let worker: Worker | undefined;
    const timer = window.setTimeout(() => {
      worker = new Worker(new URL('./trace.worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = (event: MessageEvent<{ results?: TraceResult[]; error?: string }>) => {
        if (event.data.results) setTraces(Object.fromEntries(event.data.results.map(result => [result.id, result])));
        if (event.data.error) { setTraces({}); notify(event.data.error, true); }
        setCompletedTraceKey(requestKey);
        setBusy(false);
        worker?.terminate();
      };
      worker.onerror = () => { setTraces({}); setCompletedTraceKey(requestKey); setBusy(false); notify('Contour processing failed. Please reload and try a smaller image.', true); worker?.terminate(); };
      worker.postMessage({ artworks: artworks.map(art => ({ ...art, image: '' })), settings });
    }, 180);
    return () => { window.clearTimeout(timer); worker?.terminate(); };
  // Only geometry settings require a new trace.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [artworks, traceKey]);

  async function upload(files: FileList | File[]) {
    if (uploadLock.current) return;
    const list = Array.from(files);
    if (!list.length) return;
    const retained = artworks.filter(art => !art.demo);
    if (retained.length + list.length > 25) { notify('A batch can contain up to 25 designs. Export this batch first.', true); return; }
    uploadLock.current = true;
    setLoading(true);
    const loaded: Artwork[] = [], errors: string[] = [];
    try {
      for (const file of list) {
        if (!supported.test(file.name)) { errors.push(`${file.name}: use PNG, SVG, JPG, or WebP.`); continue; }
        try { loaded.push(await decodeArtwork(file, file.name)); }
        catch (error) { errors.push(error instanceof Error ? error.message : `Could not read ${file.name}.`); }
      }
      if (loaded.length) {
        setArtworks([...retained, ...loaded]);
        setSelectedId(loaded[0].id);
        setIncluded(old => new Set([...retained.filter(art => old.has(art.id)).map(art => art.id), ...loaded.map(art => art.id)]));
        setZoom(100);
      }
      if (errors.length) notify(errors.join(' '), true);
      else if (loaded.length) notify(`${loaded.length} ${loaded.length === 1 ? 'design added' : 'designs added'}. Your artwork stays in this browser.`);
    } finally { setLoading(false); uploadLock.current = false; if (input.current) input.current.value = ''; }
  }

  function remove(id: string) {
    const remaining = artworks.filter(art => art.id !== id);
    setArtworks(remaining); setIncluded(old => { const next = new Set(old); next.delete(id); return next; });
    if (selectedId === id) setSelectedId(remaining[0]?.id || '');
  }
  function toggleIncluded(id: string) { setIncluded(old => { const next = new Set(old); if (next.has(id)) next.delete(id); else next.add(id); return next; }); }
  const traced = artworks.map(art => ({ ...art, rings: traces[art.id]?.rings || [], error: traces[art.id]?.error })) as TracedArtwork[];
  const selected = traced.find(art => art.id === selectedId);
  const batch = traced.filter(art => included.has(art.id));
  const ready = !processing && !loading && batch.length > 0 && batch.every(art => art.rings.length > 0 && !art.error);
  const pathCount = geometryCurrent ? batch.reduce((sum, art) => sum + art.rings.length, 0) : 0;
  const bounds = selected ? boundsFor(selected) : null;
  const padding = bounds ? Math.max(bounds.width, bounds.height) * 0.13 : 0;
  const viewbox = bounds ? `${bounds.minX - padding} ${bounds.minY - padding} ${bounds.width + padding * 2} ${bounds.height + padding * 2}` : '0 0 600 600';
  const allDemo = artworks.length > 0 && artworks.every(art => art.demo);

  async function exportBatch() {
    if (!ready || exporting) return;
    setExporting(true);
    try {
      const { createBatchDownload } = await import('./export');
      const result = await createBatchDownload(batch, settings);
      const url = URL.createObjectURL(result.blob);
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = result.name;
      document.body.appendChild(anchor); anchor.click(); anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 60000);
      notify(`${batch.length} ${batch.length === 1 ? 'design' : 'designs'} exported with CutContour spot-color paths.`);
    } catch (error) { notify(error instanceof Error ? error.message : 'Export failed. Please try again.', true); }
    finally { setExporting(false); }
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
      <header className="topbar"><Logo /><span className="topbar-divider" /><span className="workspace-name">Your print workspace <ChevronDown size={13} /></span><div className="topbar-end"><span className="private-badge"><span /> Local & private</span><button className="text-button" onClick={() => setGuide(true)}>Quick guide <ArrowUpRight size={15} /></button></div></header>

      <main>
        <div className="breadcrumb"><span>Workspace</span><span>/</span><span>Batch contour</span></div>
        <section className="page-heading"><div><div className="eyebrow"><span /> MADE FOR YOUR NEXT PRINT RUN</div><h1>Great artwork. <span>Clean cuts.</span></h1><p>Turn your designs into print-ready contour cut files, all in one batch.</p></div><button className="button button-white heading-help" onClick={() => setGuide(true)}><CircleHelp size={16} /> How it works</button></section>

        <div className="workflow-strip"><div className="workflow-step current"><span className="step-number">1</span><strong>Add artwork</strong><span className="step-caption">PNG, SVG, JPG, WebP</span></div><div className="step-line" /><div className="workflow-step"><span className="step-number">2</span><strong>Fine-tune contours</strong></div><div className="step-line" /><div className="workflow-step"><span className="step-number">3</span><strong>Export for VersaWorks</strong></div><span className="workflow-note"><ShieldCheck size={15} /> Files never leave your browser</span></div>

        <section className="studio" aria-label="Contour workspace">
          <aside className="artwork-panel">
            <div className="panel-heading"><div><h2>Artwork <span className="count-badge">{artworks.length}</span></h2><p>Your batch, all in one place.</p></div><button className="icon-button" title="Add artwork" aria-label="Add artwork" disabled={loading} onClick={() => input.current?.click()}><Plus size={18} /></button></div>
            <button className="upload-zone" onClick={() => input.current?.click()} disabled={loading}><span className="upload-icon">{loading ? <LoaderCircle className="spin" size={21} /> : <Upload size={21} />}</span><strong>{loading ? 'Reading your artwork…' : 'Drop your artwork here'}</strong><span>or <u>browse files</u></span><small>Up to 25 files · 30 MB each</small></button>
            <div className="batch-label"><span>{allDemo ? 'SAMPLE BATCH' : 'BATCH ARTWORK'}</span><button onClick={() => setIncluded(included.size === artworks.length ? new Set() : new Set(artworks.map(art => art.id)))} disabled={!artworks.length}>{included.size === artworks.length && artworks.length ? 'Deselect all' : 'Select all'}</button></div>
            <div className="artwork-list">{traced.map(art => <div key={art.id} className={`artwork-item ${selectedId === art.id ? 'selected' : ''}`}>
              <input type="checkbox" aria-label={`Include ${art.name}`} checked={included.has(art.id)} onChange={() => toggleIncluded(art.id)} />
              <button className="artwork-select" onClick={() => { setSelectedId(art.id); setZoom(100); }}><span className="artwork-thumb checker"><img src={art.image} alt="" /></span><span className="artwork-info"><strong>{art.name}</strong><span>{settings.widthMm} × {(settings.widthMm * art.height / art.width).toFixed(1)} mm</span><small className={art.error ? 'error-text' : ''}>{processing ? 'Tracing…' : art.error ? 'Needs attention' : <><span className="tiny-dot" />{art.rings.length} {art.rings.length === 1 ? 'cut path' : 'cut paths'}</>}</small></span></button>
              <button className="remove-artwork" title={`Remove ${art.name}`} aria-label={`Remove ${art.name}`} onClick={() => remove(art.id)}><X size={14} /></button>
            </div>)}</div>
            {!artworks.length && <div className="empty-list"><FileImage size={28} /><p>Your next print run starts here.</p><button className="text-button" onClick={() => void loadSamples()}>Try sample artwork <ArrowRight size={14} /></button></div>}
            <div className="artwork-panel-footer"><span className="mini-icon"><Copy size={15} /></span><p>One setting. Your whole batch.<br /><span>Contour settings apply to every design.</span></p></div>
          </aside>

          <section className="preview-panel" aria-label="Artwork preview">
            <div className="preview-toolbar"><div className="preview-title"><Eye size={16} /><strong>Live preview</strong><span className="live-dot" /></div><div className="preview-tools"><button aria-label="Toggle artwork visibility" title="Toggle artwork visibility" aria-pressed={showArt} className={`icon-button ${showArt ? 'toggled' : ''}`} onClick={() => setShowArt(!showArt)}><FileImage size={16} /></button><button aria-label="Toggle contour visibility" title="Toggle contour visibility" aria-pressed={showCut} className={`icon-button ${showCut ? 'toggled' : ''}`} onClick={() => setShowCut(!showCut)}><ScanLine size={17} /></button><span className="toolbar-divider" /><button className="icon-button" title="Fit artwork to preview" aria-label="Fit artwork to preview" onClick={() => setZoom(100)}><Expand size={16} /></button></div></div>
            <div className="preview-stage checker">
              <div className="stage-label"><span className="stage-file">{selected?.name || 'Your artwork goes here'}</span>{selected?.demo && <span className="sample-tag">SAMPLE</span>}</div>
              {selected ? <div className="artboard-wrap"><svg aria-label={`Contour preview of ${selected.name}`} className="artboard" viewBox={viewbox} style={{ transform: `scale(${zoom / 100})` }}>
                {showArt && <image href={selected.image} width={selected.width} height={selected.height} />}
                {showCut && geometryCurrent && <path d={ringPath(selected.rings)} fill="none" stroke="#ed2688" strokeWidth="1.25" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />}
              </svg><div className="dimension-line"><span />{settings.widthMm.toFixed(1)} mm artwork<span /></div></div> : <div className="empty-preview"><ScanLine size={48} strokeWidth={1} /><h3>A clean cut starts here.</h3><p>Add artwork to preview your contour.</p><button className="button button-green" onClick={() => input.current?.click()}><Plus size={16} /> Add artwork</button></div>}
              {processing && <span className="processing-pill"><LoaderCircle size={13} className="spin" /> Updating contours</span>}
              {selected?.error && !processing && <div className="preview-error">{selected.error}</div>}
              <div className="stage-bottom"><span className="cut-legend"><i /> CutContour</span><div className="zoom-controls"><button aria-label="Zoom out" disabled={zoom <= 50} onClick={() => setZoom(Math.max(50, zoom - 25))}><Minus size={14} /></button><button aria-label="Reset zoom" onClick={() => setZoom(100)}>{zoom}%</button><button aria-label="Zoom in" disabled={zoom >= 200} onClick={() => setZoom(Math.min(200, zoom + 25))}><Plus size={14} /></button></div></div>
            </div>
            <div className="preview-footer"><span><MousePointer2 size={13} /> Select a design to inspect its contour</span><span><span className="pink-dot" /> Spot color preview</span></div>
          </section>

          <aside className="settings-panel"><div className="panel-heading"><div><h2><SlidersHorizontal size={16} /> Contour settings</h2><p>A little precision goes a long way.</p></div><button className="reset-button" onClick={() => { setSettings(defaultSettings); notify('Contour settings reset to defaults.'); }}>Reset</button></div>
            <div className="settings-body"><div className="setting-group"><div className="field-label"><label htmlFor="width">Artwork width</label><span>Proportional height</span></div><div className="number-input"><input id="width" type="number" min="5" max="1000" step="1" value={settings.widthMm} onChange={event => update('widthMm', Math.max(5, Math.min(1000, Number(event.target.value) || 5)))} /><span>mm</span></div></div>
              <div className="setting-group offset-group"><div className="field-label"><label htmlFor="offset">Cut offset</label><span className="value-chip">{settings.offsetMm.toFixed(1)} mm</span></div><input className="range" id="offset" type="range" min="0" max="10" step="0.1" value={settings.offsetMm} onChange={event => update('offsetMm', Number(event.target.value))} style={{ '--range-progress': `${settings.offsetMm * 10}%` } as React.CSSProperties} /><div className="range-labels"><span>On the edge</span><span>10 mm</span></div><p className="field-hint">Adds a border outside your artwork.</p></div>
              <div className="setting-group"><div className="field-label"><label htmlFor="smoothing">Path smoothing</label><span className="value-chip">{settings.smoothing <= 0.2 ? 'Precise' : settings.smoothing < 1 ? 'Balanced' : 'Smooth'}</span></div><input className="range" id="smoothing" type="range" min="0.05" max="2" step="0.05" value={settings.smoothing} onChange={event => update('smoothing', Number(event.target.value))} style={{ '--range-progress': `${(settings.smoothing - 0.05) / 1.95 * 100}%` } as React.CSSProperties} /><div className="range-labels"><span>More detail</span><span>Fewer nodes</span></div></div>
              <div className="settings-divider" /><div className="setting-group"><div className="field-label"><label htmlFor="background">Trace from</label></div><div className="select-wrap"><select id="background" value={settings.background} onChange={event => update('background', event.target.value as Settings['background'])}><option value="alpha">Transparent background</option><option value="white">Ignore white background</option></select><ChevronDown size={14} /></div></div>
              <div className="toggle-row"><div><label htmlFor="holes">Include inner cutouts</label><p>Cut holes inside your design</p></div><input id="holes" className="switch" type="checkbox" checked={settings.holes} onChange={event => update('holes', event.target.checked)} /></div>
              <details className="advanced"><summary><Settings2 size={14} /> Advanced settings <ChevronDown size={13} /></summary><div className="field-label"><label htmlFor="threshold">Alpha threshold</label><span>{settings.threshold}</span></div><input id="threshold" type="range" className="range" min="1" max="254" value={settings.threshold} onChange={event => update('threshold', Number(event.target.value))} /><p className="field-hint">Lower values include more transparent edge pixels. White mode also ignores pixels near white.</p></details>
              <div className="spot-card"><span className="spot-icon"><ScanLine size={18} /></span><div><strong>CutContour <span>SPOT COLOR</span></strong><p>Named for Roland VersaWorks.</p></div><span className="spot-swatch" /></div>
            </div>
          </aside>
        </section>

        <section className="export-bar" aria-label="Export batch"><div className="batch-status"><span className={`status-icon ${!ready ? 'waiting' : ''}`}>{processing || loading ? <LoaderCircle size={20} className="spin" /> : <CheckCheck size={21} />}</span><div><strong>{processing || loading ? 'Preparing your contours…' : ready ? `${batch.length} ${batch.length === 1 ? 'design' : 'designs'} ready to go` : batch.length ? 'Check your artwork' : 'Select artwork to export'}</strong><p>{pathCount} closed cut {pathCount === 1 ? 'path' : 'paths'} <span>·</span> {settings.offsetMm.toFixed(1)} mm offset <span>·</span> CutContour spot color</p></div></div><div className="export-options"><label className="include-artwork"><input type="checkbox" checked={settings.includeArtwork} onChange={event => update('includeArtwork', event.target.checked)} /> Include artwork</label><div className="select-wrap export-layout"><FileOutput size={16} /><select aria-label="Export layout" value={settings.layout} onChange={event => update('layout', event.target.value as Settings['layout'])}><option value="individual">Separate PDFs</option><option value="a4">A4 cut sheets</option></select><ChevronDown size={13} /></div><button className="button button-green export-button" onClick={() => void exportBatch()} disabled={!ready || exporting}>{exporting ? <LoaderCircle size={17} className="spin" /> : <ArrowDownToLine size={17} />}{exporting ? 'Creating files…' : 'Export batch'}<span>{batch.length}</span></button></div></section>

        <div className="below-studio"><div className="tip"><Sparkles size={16} /><p>{allDemo ? <><strong>Take it for a test cut.</strong> You’re viewing sample artwork. Drop in your own designs to start a new batch.</> : <><strong>Made for your workflow.</strong> Export your batch, open the PDFs in VersaWorks, and check the cut-line preview.</>}</p></div><button className="text-button" onClick={() => setGuide(true)}>VersaWorks setup guide <ArrowUpRight size={14} /></button></div>
        <footer className="page-footer"><span>From artwork to a perfect outline.</span><span><ShieldCheck size={13} /> Browser-based. No uploads. No sign-up.</span><span>CONTOUR STUDIO <span className="version">V1.0.1</span></span></footer>
      </main>
    </div>

    {dragging && <div className="drop-overlay" onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragging(false); }} onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); setDragging(false); void upload(event.dataTransfer.files); }}><div><Upload size={42} /><h2>Good art deserves a clean cut.</h2><p>Drop your files to add them to the batch.</p></div></div>}
    {notice && <div className={`toast ${notice.error ? 'toast-error' : ''}`} role={notice.error ? 'alert' : 'status'}>{notice.error ? <CircleHelp size={18} /> : <Check size={18} />}<span>{notice.text}</span><button aria-label="Dismiss notification" onClick={() => setNotice(null)}><X size={16} /></button></div>}
    {guide && <Guide onClose={() => setGuide(false)} />}
  </div>;
}

function Guide({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); return () => dialog.current?.close(); }, []);
  return <dialog ref={dialog} className="guide-dialog" onCancel={onClose} onClick={event => { if (event.target === event.currentTarget) onClose(); }} aria-labelledby="guide-title"><button className="guide-close icon-button" aria-label="Close guide" onClick={onClose}><X size={20} /></button><div className="guide-eyebrow"><Scissors size={17} /> YOUR NEXT PRINT RUN</div><h2 id="guide-title">From pixels to precise cuts.</h2><p className="guide-intro">A quick guide to your Contour → VersaWorks workflow.</p><ol className="guide-steps"><li><span>01</span><div><h3>Add your artwork</h3><p>Drop in transparent PNGs, WebP files, or self-contained SVGs. Each design can have multiple separate shapes. For JPGs, choose “Ignore white background” to trace around nonwhite pixels.</p></div></li><li><span>02</span><div><h3>Check your outline and size</h3><p>Set the printed artwork width in millimeters. The offset adds a border beyond that width. Pink lines show the closed cut paths. Enable inner cutouts only when you want holes cut too.</p></div></li><li><span>03</span><div><h3>Export your batch</h3><p>Separate PDFs download as a ZIP when you select multiple designs. A4 sheets arrange your designs over as many pages as needed. Artwork is rasterized at up to 1,400 pixels on its longest edge; cut paths remain vectors. Transparent artwork is flattened onto white for RIP compatibility; cut lines stay vector. Very large print sizes may need a higher-resolution workflow.</p></div></li><li><span>04</span><div><h3>Open in Roland VersaWorks</h3><p>Extract the ZIP, add the PDFs to your queue, and inspect the preview for the animated dotted cut lines. The PDF uses a case-sensitive <code>CutContour</code> spot color and a 0.25 pt overprinted stroke. Use 100% scale and choose Print & Cut in your queue’s cutting controls.</p></div></li></ol><div className="guide-note"><ShieldCheck size={20} /><p>Run a small test cut before production. Confirm size, offset, cut-line recognition, and your media’s cutting force. VersaWorks compatibility must be verified on your own printer and software version.</p></div><button className="button button-green guide-done" onClick={onClose}>Back to the workspace <ArrowRight size={16} /></button></dialog>;
}
