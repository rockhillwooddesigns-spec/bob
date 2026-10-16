import { boundsFor } from './contour';
import type { Settings, TracedSummary } from './types';

export interface LayoutPage { widthMm: number; heightMm: number; items: { index: number; leftMm: number; topMm: number }[] }
export function planPdfLayout(artworks: TracedSummary[], settings: Settings): LayoutPage[] {
  if (settings.layout === 'individual') return artworks.map((art, index) => {
    const bounds = boundsFor(art), mmPerPixel = settings.widthMm / art.width;
    return { widthMm: bounds.width * mmPerPixel + 6, heightMm: bounds.height * mmPerPixel + 6, items: [{ index, leftMm: 3, topMm: 3 }] };
  });
  const pages: LayoutPage[] = [{ widthMm: 210, heightMm: 297, items: [] }];
  let x = 8, y = 8, rowHeight = 0;
  artworks.forEach((art, index) => {
    const bounds = boundsFor(art), scale = settings.widthMm / art.width;
    const width = bounds.width * scale, height = bounds.height * scale;
    if (width > 194 || height > 281) throw new Error(`${art.name} is too large for A4. Reduce the artwork width or export separate PDFs.`);
    if (x + width > 202.001) { x = 8; y += rowHeight + 6; rowHeight = 0; }
    if (y + height > 289.001) { pages.push({ widthMm: 210, heightMm: 297, items: [] }); x = 8; y = 8; rowHeight = 0; }
    pages.at(-1)!.items.push({ index, leftMm: x, topMm: y });
    rowHeight = Math.max(rowHeight, height); x += width + 6;
  });
  return pages;
}
