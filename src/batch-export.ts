import JSZip from 'jszip';
import { createPdf, safeName } from './export';
import { PDF_DESIGNS_PER_PART, PDF_PIXELS_PER_PART, ZIP_BYTES_PER_PART, ZIP_DESIGNS_PER_PART } from './batch-limits';
import type { Artwork, DownloadPart, Settings, TracedSummary, TracedArtwork } from './types';

export type ExportProgress = { completed: number; total: number; phase: 'Creating PDFs' | 'Packaging downloads' };
type ExportAdapter = {
  loadArtwork: (art: TracedSummary) => Promise<Artwork>;
  savePart: (id: string, blob: Blob) => Promise<void>;
  progress: (progress: ExportProgress) => void;
  makePdf?: (artworks: TracedSummary[], onArtwork: () => void) => Promise<Uint8Array>;
};

/** Bound working memory: at most one source raster and one small PDF/ZIP volume. */
export async function exportLargeBatch(artworks: TracedSummary[], settings: Settings, adapter: ExportAdapter): Promise<DownloadPart[]> {
  if (!artworks.length) throw new Error('Select at least one design.');
  const parts: DownloadPart[] = [];
  let completed = 0;
  const progress = () => adapter.progress({ completed: ++completed, total: artworks.length, phase: 'Creating PDFs' });
  const placeholder = (art: TracedSummary): TracedArtwork => ({ ...art, pixels: new Uint8ClampedArray() });
  const pdf = (group: TracedSummary[]) => {
    if (import.meta.env.VITE_BILLING_ENABLED === 'true') {
      if (!adapter.makePdf) throw new Error('The hosted export service is not connected.');
      return adapter.makePdf(group, progress);
    }
    return createPdf(group.map(placeholder), settings, { loadArtwork: adapter.loadArtwork, onArtwork: progress });
  };
  async function save(blob: Blob, name: string, designCount: number) {
    const id = crypto.randomUUID();
    await adapter.savePart(id, blob);
    parts.push({ id, name, bytes: blob.size, designCount });
  }
  if (settings.layout === 'a4') {
    let group: TracedSummary[] = [], pixels = 0, nodes = 0;
    async function flush() {
      if (!group.length) return;
      const bytes = await pdf(group);
      await save(new Blob([new Uint8Array(bytes)], { type: 'application/pdf' }), `contour-a4-part-${String(parts.length + 1).padStart(3, '0')}.pdf`, group.length);
      group = []; pixels = 0; nodes = 0;
    }
    for (const art of artworks) {
      const count = art.rings.reduce((sum, ring) => sum + ring.length, 0);
      if (group.length && (group.length >= PDF_DESIGNS_PER_PART || pixels + art.width * art.height > PDF_PIXELS_PER_PART || nodes + count > 80_000)) await flush();
      group.push(art); pixels += art.width * art.height; nodes += count;
    }
    await flush();
    if (parts.length === 1) parts[0].name = 'contour-a4-sheets.pdf';
    return parts;
  }
  if (artworks.length === 1) {
    const bytes = await pdf(artworks);
    await save(new Blob([new Uint8Array(bytes)], { type: 'application/pdf' }), `${safeName(artworks[0].name)}-CutContour.pdf`, 1);
    return parts;
  }
  const used = new Set<string>();
  let zip = new JSZip(), bytesInZip = 0, designsInZip = 0;
  async function flush() {
    if (!designsInZip) return;
    adapter.progress({ completed, total: artworks.length, phase: 'Packaging downloads' });
    const blob = await zip.generateAsync({ type: 'blob', streamFiles: true });
    await save(blob, `contour-batch-part-${String(parts.length + 1).padStart(3, '0')}.zip`, designsInZip);
    zip = new JSZip(); bytesInZip = 0; designsInZip = 0;
  }
  for (const art of artworks) {
    const bytes = await pdf([art]);
    if (designsInZip && (designsInZip >= ZIP_DESIGNS_PER_PART || bytesInZip + bytes.length > ZIP_BYTES_PER_PART)) await flush();
    const base = safeName(art.name);
    let name = base, suffix = 2;
    while (used.has(name.toLowerCase())) name = `${base}-${suffix++}`;
    used.add(name.toLowerCase());
    zip.file(`${name}-CutContour.pdf`, bytes);
    bytesInZip += bytes.length; designsInZip++;
  }
  await flush();
  if (parts.length === 1) parts[0].name = `contour-batch-${artworks.length}-designs.zip`;
  return parts;
}
