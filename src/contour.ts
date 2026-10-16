import { contours } from 'd3-contour';
import ClipperLib from 'clipper-lib';
import type { Artwork, Point, Ring, Settings, TracedArtwork } from './types';

const SCALE = 1000;
const MAX_EDGE = 1400;

/** Decode to a bounded local canvas; the same pixels are used for tracing and PDF artwork. */
export async function decodeArtwork(file: Blob, name: string, demo = false): Promise<Artwork> {
  if (file.size > 30 * 1024 * 1024) throw new Error(`${name}: maximum file size is 30 MB.`);
  const url = URL.createObjectURL(file);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error(`${name}: could not read this image. Use PNG, WebP, JPG, or a self-contained SVG.`));
      img.src = url;
    });
    if (!image.naturalWidth || !image.naturalHeight) throw new Error(`${name}: image has no dimensions.`);
    const scale = Math.min(1, MAX_EDGE / Math.max(image.naturalWidth, image.naturalHeight));
    const width = Math.max(1, Math.round(image.naturalWidth * scale));
    const height = Math.max(1, Math.round(image.naturalHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(image, 0, 0, width, height);
    return { id: crypto.randomUUID(), name, image: canvas.toDataURL('image/png'), width, height, pixels: ctx.getImageData(0, 0, width, height).data, demo };
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function signedArea(ring: Ring): number {
  let sum = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    sum += a[0] * b[1] - b[0] * a[1];
  }
  return sum / 2;
}

function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const t = dx || dy ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy))) : 0;
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

function simplifyOpen(points: Ring, tolerance: number): Ring {
  if (points.length <= 2) return points;
  // Iterative RDP avoids overflowing the stack on very detailed silhouettes.
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop()!;
    let maximum = tolerance, index = -1;
    for (let i = first + 1; i < last; i++) {
      const distance = distanceToSegment(points[i], points[first], points[last]);
      if (distance > maximum) { maximum = distance; index = i; }
    }
    if (index !== -1) { keep[index] = 1; stack.push([first, index], [index, last]); }
  }
  return points.filter((_, index) => keep[index]);
}

function simplifyRing(ring: Ring, tolerance: number): Ring {
  let far = 1;
  for (let i = 2; i < ring.length; i++) {
    if (Math.hypot(ring[i][0] - ring[0][0], ring[i][1] - ring[0][1]) > Math.hypot(ring[far][0] - ring[0][0], ring[far][1] - ring[0][1])) far = i;
  }
  return [...simplifyOpen(ring.slice(0, far + 1), tolerance).slice(0, -1), ...simplifyOpen([...ring.slice(far), ring[0]], tolerance).slice(0, -1)];
}

export function traceArtwork(art: Artwork, settings: Settings): TracedArtwork {
  const { width, height, pixels } = art;
  const paddedWidth = width + 2;
  const mask = new Float32Array(paddedWidth * (height + 2));
  let foreground = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const alpha = pixels[i + 3];
      // White removal respects transparency and removes neutral near-white pixels.
      const whiteness = Math.min(pixels[i], pixels[i + 1], pixels[i + 2]);
      const on = alpha >= settings.threshold && (settings.background === 'alpha' || whiteness < 255 - settings.threshold / 4);
      mask[(y + 1) * paddedWidth + x + 1] = on ? 1 : 0;
      if (on) foreground++;
    }
  }
  if (!foreground) return { ...art, rings: [], error: 'No visible artwork found. Adjust the threshold or background mode.' };
  // d3-contour accepts typed arrays at runtime; its type declarations only list arrays.
  const shape = contours().size([paddedWidth, height + 2]).smooth(true).thresholds([0.5])(mask as unknown as number[])[0];
  const paths: ClipperLib.Paths = [];
  for (const polygon of shape.coordinates) {
    const candidates = settings.holes ? polygon : polygon.slice(0, 1);
    candidates.forEach((coords, index) => {
      let ring = coords.slice(0, -1).map(([x, y]) => [x - 1, y - 1] as Point);
      if (Math.abs(signedArea(ring)) < 4) return;
      ring = simplifyRing(ring, settings.smoothing);
      if (ring.length < 3) return;
      // Clipper expects positive outer rings and negative holes.
      if ((signedArea(ring) > 0) !== (index === 0)) ring.reverse();
      paths.push(ring.map(([x, y]) => ({ X: Math.round(x * SCALE), Y: Math.round(y * SCALE) })));
    });
  }
  if (!paths.length) return { ...art, rings: [], error: 'Artwork is too small to trace. Try a higher resolution image.' };
  // Always union first: overlapping offset islands must become one cut path.
  const clipper = new ClipperLib.Clipper();
  clipper.AddPaths(paths, ClipperLib.PolyType.ptSubject, true);
  const united: ClipperLib.Paths = [];
  clipper.Execute(ClipperLib.ClipType.ctUnion, united, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
  let result = united;
  if (settings.offsetMm > 0) {
    const offset = new ClipperLib.ClipperOffset(2, 0.1 * SCALE);
    offset.AddPaths(united, ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedPolygon);
    result = [];
    offset.Execute(result, settings.offsetMm * width / settings.widthMm * SCALE);
  }
  // An outer-only cut also excludes holes created by merging separate islands.
  const rings = result.filter(path => settings.holes || ClipperLib.Clipper.Area(path) > 0).map(path => path.map(p => [p.X / SCALE, p.Y / SCALE] as Point));
  return { ...art, rings, error: rings.length ? undefined : 'No usable cut paths found.' };
}

export function ringPath(rings: Ring[]): string {
  return rings.map(ring => `M${ring.map(p => p.map(v => +v.toFixed(3)).join(',')).join('L')}Z`).join(' ');
}

export function boundsFor(art: TracedArtwork) {
  let minX = 0, minY = 0, maxX = art.width, maxY = art.height;
  for (const ring of art.rings) for (const [x, y] of ring) {
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  }
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}
