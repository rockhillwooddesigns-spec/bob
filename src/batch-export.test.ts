import { describe, expect, it } from 'vitest';
import { PDFDocument, PDFName, PDFDict, PDFRawStream, decodePDFRawStream } from 'pdf-lib';
import JSZip from 'jszip';
import { exportLargeBatch } from './batch-export';
import { addRasterArtwork, createPdf } from './export';
import { defaultSettings, type Artwork, type TracedSummary } from './types';

const art: TracedSummary = { id: 'art', name: 'same.png', width: 20, height: 10, image: '', rings: [[[0, 0], [20, 0], [20, 10], [0, 10]]] };
const pixels = new Uint8ClampedArray(Array.from({ length: 200 }, () => [40, 80, 120, 128]).flat());

describe('large export volumes', () => {
  it('exports all 500 designs without filename collisions and keeps each ZIP at 50 designs or fewer', async () => {
    const saved = new Map<string, Blob>();
    let loads = 0, lastProgress = 0;
    const parts = await exportLargeBatch(Array.from({ length: 500 }, (_, i) => ({ ...art, id: `art-${i}` })), defaultSettings, {
      loadArtwork: async summary => { loads++; return { ...summary, pixels }; },
      savePart: async (id, blob) => { saved.set(id, blob); },
      progress: progress => { lastProgress = progress.completed; },
    });
    expect(parts).toHaveLength(10); expect(loads).toBe(500); expect(lastProgress).toBe(500);
    const names = new Set<string>();
    for (const part of parts) {
      const zip = await JSZip.loadAsync(await saved.get(part.id)!.arrayBuffer());
      expect(Object.keys(zip.files).length).toBeLessThanOrEqual(50);
      for (const name of Object.keys(zip.files)) { expect(names.has(name)).toBe(false); names.add(name); }
    }
    expect(names.size).toBe(500);
  }, 30000);
  it('splits A4 jobs by the raster pixel budget before accumulating a large PDF', async () => {
    const groups: number[] = [];
    const large = Array.from({ length: 25 }, (_, i) => ({ ...art, id: `${i}`, width: 1400, height: 1400 }));
    const parts = await exportLargeBatch(large, { ...defaultSettings, layout: 'a4', includeArtwork: false }, {
      loadArtwork: async () => { throw new Error('Cut-only exports must not load source rasters.'); },
      savePart: async (_id, blob) => { groups.push((await PDFDocument.load(await blob.arrayBuffer())).getPageCount()); },
      progress: () => {},
    });
    expect(parts).toHaveLength(4);
    expect(parts.map(part => part.designCount)).toEqual([8, 8, 8, 1]);
    expect(groups.every(count => count > 0)).toBe(true);
  });
});

describe('hosted cut PDF plus local artwork', () => {
  it('places local artwork below the authorized vector paths and preserves a usable spot color on every A4 page', async () => {
    const summaries = Array.from({ length: 15 }, (_, i) => ({ ...art, id: `${i}`, pixels }));
    const settings = { ...defaultSettings, layout: 'a4' as const };
    const cuts = await createPdf(summaries, { ...settings, includeArtwork: false });
    let loaded = 0;
    const result = await addRasterArtwork(cuts, summaries, settings, async summary => { loaded++; return { ...summary, pixels } as Artwork; }, () => {});
    const doc = await PDFDocument.load(result);
    expect(doc.getPageCount()).toBe(2); expect(loaded).toBe(15);
    for (const page of doc.getPages()) {
      expect(page.node.Resources()!.lookup(PDFName.of('ColorSpace'), PDFDict).has(PDFName.of('CS0'))).toBe(true);
      const commands = new TextDecoder().decode(decodePDFRawStream(page.node.Contents() as PDFRawStream).decode());
      expect(commands.indexOf(' Do')).toBeLessThan(commands.indexOf('/CS0 CS'));
      expect(commands).toContain('h\nS');
    }
    expect(new TextDecoder().decode(result.slice(0, 8))).toBe('%PDF-1.3');
  });
});
