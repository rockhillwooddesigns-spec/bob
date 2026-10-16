import { traceArtwork } from './contour';
import type { Artwork, Settings } from './types';

self.onmessage = (event: MessageEvent<{ artworks: Artwork[]; settings: Settings }>) => {
  try {
    const results = event.data.artworks.map(art => {
      const { id, rings, error } = traceArtwork(art, event.data.settings);
      return { id, rings, error };
    });
    self.postMessage({ results });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : 'Could not generate contours.' });
  }
};
