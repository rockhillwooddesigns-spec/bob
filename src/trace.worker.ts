import { traceArtwork } from './contour';
import { loadArtwork } from './artwork-store';
import type { ArtworkSummary, Settings } from './types';

self.onmessage = async (event: MessageEvent<{ workspace: string; artworks: ArtworkSummary[]; settings: Settings }>) => {
  let completed = 0;
  for (const summary of event.data.artworks) {
    try {
      const art = await loadArtwork(event.data.workspace, summary);
      const { id, rings, error } = traceArtwork(art, event.data.settings);
      self.postMessage({ result: { id, rings, error }, completed: ++completed });
    } catch (error) {
      self.postMessage({ result: { id: summary.id, rings: [], error: error instanceof Error ? error.message : 'Could not trace this design.' }, completed: ++completed });
    }
  }
  self.postMessage({ done: true });
};
