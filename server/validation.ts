import { createHash } from 'node:crypto';
import { HttpError } from './core';
import type { Settings, Ring, TracedArtwork } from '../src/types';
import type { ExportManifest } from '../src/hosted-types';

export function settings(value: unknown): Settings {
  const s = value as Settings;
  if (!s || !Number.isFinite(s.widthMm) || s.widthMm < 5 || s.widthMm > 1000 || !Number.isFinite(s.offsetMm) || s.offsetMm < 0 || s.offsetMm > 10 || !Number.isFinite(s.smoothing) || s.smoothing < .05 || s.smoothing > 2 || !Number.isInteger(s.threshold) || s.threshold < 1 || s.threshold > 254 || !['alpha', 'white'].includes(s.background) || !['individual', 'a4'].includes(s.layout) || typeof s.holes !== 'boolean' || typeof s.includeArtwork !== 'boolean') throw new HttpError(400, 'Invalid contour settings.');
  return { widthMm: s.widthMm, offsetMm: s.offsetMm, smoothing: s.smoothing, threshold: s.threshold, background: s.background, layout: s.layout, holes: s.holes, includeArtwork: s.includeArtwork };
}
export function manifest(value: unknown): ExportManifest[] {
  if (!Array.isArray(value) || !value.length || value.length > 500) throw new HttpError(400, 'Select between 1 and 500 designs.');
  const seen = new Set<string>();
  return value.map(item => {
    if (!item || typeof item.id !== 'string' || item.id.length > 80 || seen.has(item.id) || typeof item.name !== 'string' || item.name.length > 255 || !Number.isInteger(item.width) || item.width < 1 || item.width > 1400 || !Number.isInteger(item.height) || item.height < 1 || item.height > 1400 || typeof item.hash !== 'string' || !/^[a-f0-9]{64}$/.test(item.hash)) throw new HttpError(400, 'Invalid artwork manifest.');
    seen.add(item.id);
    return { id: item.id, name: item.name, width: item.width, height: item.height, hash: item.hash };
  });
}
export function validatePart(value: unknown, expected: ExportManifest[], jobSettings: Settings): TracedArtwork[] {
  if (!Array.isArray(value) || !value.length || value.length > 50) throw new HttpError(400, 'An export part must contain 1–50 designs.');
  let points = 0;
  const seen = new Set<string>();
  return value.map(item => {
    const meta = expected.find(art => art.id === item?.id);
    if (!meta || seen.has(meta.id) || !Array.isArray(item.rings) || !item.rings.length) throw new HttpError(400, 'This design does not belong to the authorized export.');
    seen.add(meta.id);
    const rings: Ring[] = item.rings;
    const border = jobSettings.offsetMm * meta.width / jobSettings.widthMm + 2;
    for (const ring of rings) {
      if (!Array.isArray(ring) || ring.length < 3) throw new HttpError(400, 'Invalid cut path.');
      points += ring.length;
      if (points > 100_000) throw new HttpError(413, 'This export part has too many path nodes. Increase smoothing or export fewer designs.');
      for (const point of ring) if (!Array.isArray(point) || point.length !== 2 || !Number.isFinite(point[0]) || !Number.isFinite(point[1]) || point[0] < -border || point[1] < -border || point[0] > meta.width + border || point[1] > meta.height + border) throw new HttpError(400, 'Invalid cut-path coordinates.');
    }
    const hash = createHash('sha256').update(JSON.stringify({ id: meta.id, width: meta.width, height: meta.height, rings })).digest('hex');
    if (hash !== meta.hash) throw new HttpError(409, 'Artwork changed after export authorization. Start a new export.');
    return { ...meta, image: '', pixels: new Uint8ClampedArray(), rings };
  });
}
