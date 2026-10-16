import { describe, expect, it } from 'vitest';
import { boundsFor, signedArea, traceArtwork } from './contour';
import { defaultSettings, type Artwork } from './types';

function image(width: number, height: number, pixel: (x: number, y: number) => [number, number, number, number]): Artwork {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) pixels.set(pixel(x, y), (y * width + x) * 4);
  return { id: 'test', name: 'test.png', image: '', width, height, pixels };
}
const solid: [number, number, number, number] = [0, 0, 0, 255];
const clear: [number, number, number, number] = [0, 0, 0, 0];

describe('print-scale contour geometry', () => {
  it('adds a 2 mm border around a known silhouette at one pixel per millimeter', () => {
    const art = image(40, 30, (x, y) => x >= 5 && x < 35 && y >= 5 && y < 25 ? solid : clear);
    const traced = traceArtwork(art, { ...defaultSettings, widthMm: 40, offsetMm: 2, smoothing: 0.05 });
    expect(traced.error).toBeUndefined();
    expect(traced.rings).toHaveLength(1);
    const points = traced.rings.flat();
    expect(Math.min(...points.map(p => p[0]))).toBeCloseTo(3, 1);
    expect(Math.max(...points.map(p => p[0]))).toBeCloseTo(37, 1);
    expect(Math.min(...points.map(p => p[1]))).toBeCloseTo(3, 1);
    expect(Math.max(...points.map(p => p[1]))).toBeCloseTo(27, 1);
  });

  it('retains interior holes only when inner cutouts are enabled', () => {
    const donut = image(40, 40, (x, y) => x >= 3 && x < 37 && y >= 3 && y < 37 && !(x >= 13 && x < 27 && y >= 13 && y < 27) ? solid : clear);
    const outer = traceArtwork(donut, { ...defaultSettings, offsetMm: 0, holes: false });
    const cutouts = traceArtwork(donut, { ...defaultSettings, offsetMm: 0, holes: true });
    expect(outer.rings).toHaveLength(1);
    expect(cutouts.rings).toHaveLength(2);
    expect(cutouts.rings.some(ring => signedArea(ring) > 0)).toBe(true);
    expect(cutouts.rings.some(ring => signedArea(ring) < 0)).toBe(true);
    const offset = traceArtwork(donut, { ...defaultSettings, widthMm: 40, offsetMm: 2, holes: true });
    const hole = offset.rings.find(ring => signedArea(ring) < 0)!;
    expect(Math.min(...hole.map(p => p[0]))).toBeCloseTo(15, 1);
    expect(Math.max(...hole.map(p => p[0]))).toBeCloseTo(25, 1);
  });

  it('merges colliding offsets so the cutter does not double-cut overlaps', () => {
    const islands = image(60, 30, (x, y) => y > 8 && y < 22 && ((x > 5 && x < 25) || (x > 28 && x < 48)) ? solid : clear);
    expect(traceArtwork(islands, { ...defaultSettings, widthMm: 60, offsetMm: 0 }).rings).toHaveLength(2);
    expect(traceArtwork(islands, { ...defaultSettings, widthMm: 60, offsetMm: 3 }).rings).toHaveLength(1);
  });

  it('closes silhouettes touching image borders and retains the full print bounds', () => {
    const art = image(20, 10, () => solid);
    const traced = traceArtwork(art, { ...defaultSettings, widthMm: 20, offsetMm: 2 });
    expect(traced.rings).toHaveLength(1);
    expect(boundsFor(traced).width).toBeCloseTo(24, 1);
    expect(boundsFor(traced).height).toBeCloseTo(14, 1);
  });

  it('ignores white background while retaining dark artwork', () => {
    const art = image(30, 30, (x, y) => x > 8 && x < 22 && y > 8 && y < 22 ? solid : [255, 255, 255, 255]);
    const traced = traceArtwork(art, { ...defaultSettings, widthMm: 30, offsetMm: 0, background: 'white' });
    const xs = traced.rings.flat().map(p => p[0]);
    expect(Math.min(...xs)).toBeCloseTo(9, 1);
    expect(Math.max(...xs)).toBeCloseTo(22, 1);
  });

  it('returns an actionable error for transparent or white-only images', () => {
    expect(traceArtwork(image(20, 20, () => clear), defaultSettings).error).toContain('No visible artwork');
    expect(traceArtwork(image(20, 20, () => [255, 255, 255, 255]), { ...defaultSettings, background: 'white' }).rings).toHaveLength(0);
  });
});
