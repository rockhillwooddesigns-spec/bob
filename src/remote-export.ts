import { api } from './http-api';
import { addRasterArtwork } from './export';
import type { Artwork, Settings, TracedSummary } from './types';

export async function remoteExport(artworks: TracedSummary[], settings: Settings, token: string, clientId: string, load: (art: TracedSummary) => Promise<Artwork>) {
  if (!token) throw new Error('Sign in before exporting.');
  const manifest = [];
  for (const art of artworks) {
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify({ id: art.id, width: art.width, height: art.height, rings: art.rings })));
    manifest.push({ id: art.id, name: art.name, width: art.width, height: art.height, hash: [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join('') });
  }
  const job = await api<{ id: string }>('/api/export-jobs', token, 'POST', { clientId, manifest, settings });
  return {
    id: job.id,
    cancel: () => api('/api/export-jobs', token, 'DELETE', { id: job.id }),
    render: async (group: TracedSummary[], onArtwork: () => void) => {
      const response = await fetch('/api/render-export', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ jobId: job.id, artworks: group.map(({ id, rings }) => ({ id, rings })) }) });
      if (!response.ok) { const error = await response.json().catch(() => ({})); throw new Error(error.error || 'The export service could not process this part.'); }
      const cuts = new Uint8Array(await response.arrayBuffer());
      return addRasterArtwork(cuts, group.map(art => ({ ...art, pixels: new Uint8ClampedArray() })), settings, load, onArtwork);
    },
  };
}
