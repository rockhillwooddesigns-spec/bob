import { exportLargeBatch } from './batch-export';
import { loadArtwork, saveDownload } from './artwork-store';
import type { Settings, TracedSummary } from './types';
import { remoteExport } from './remote-export';

self.onmessage = async (event: MessageEvent<{ workspace: string; artworks: TracedSummary[]; settings: Settings; token?: string; clientId: string }>) => {
  const { workspace, artworks, settings } = event.data;
  let remote: Awaited<ReturnType<typeof remoteExport>> | undefined;
  try {
    if (import.meta.env.VITE_BILLING_ENABLED === 'true') {
      remote = await remoteExport(artworks, settings, event.data.token || '', event.data.clientId, art => loadArtwork(workspace, art));
      self.postMessage({ jobId: remote.id });
    }
    const parts = await exportLargeBatch(artworks, settings, {
      loadArtwork: art => loadArtwork(workspace, art),
      savePart: (id, blob) => saveDownload(workspace, id, blob),
      progress: progress => self.postMessage({ progress }),
      makePdf: remote?.render,
    });
    self.postMessage({ parts });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : 'Batch export failed.' });
  }
};
