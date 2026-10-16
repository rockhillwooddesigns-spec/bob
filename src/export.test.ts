import { describe, expect, it } from 'vitest';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, PDFRef, decodePDFRawStream } from 'pdf-lib';
import JSZip from 'jszip';
import { createBatchDownload, createPdf } from './export';
import { defaultSettings, type TracedArtwork } from './types';

// The editor's normalized pixels are the source for the flattened print image.
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGOUD7bcwsDAwMDEAAUAFKQBY8XakPYAAAAASUVORK5CYII=';
const art: TracedArtwork = {
  id: 'test', name: 'label.png', image: png, width: 20, height: 10,
  pixels: new Uint8ClampedArray(Array.from({ length: 200 }, () => [31, 83, 57, 180]).flat()), rings: [[[0, 0], [20, 0], [20, 10], [0, 10]]],
};

describe('VersaWorks PDF output', () => {
  it('defines a named Separation color space and an overprinted 0.25 pt closed stroke', async () => {
    const doc = await PDFDocument.load(await createPdf([art], defaultSettings));
    const page = doc.getPages()[0];
    const resources = page.node.Resources()!;
    const space = resources.lookup(PDFName.of('ColorSpace'), PDFDict).lookup(PDFName.of('CS0'), PDFArray);
    expect(space.get(0).toString()).toBe('/Separation');
    expect(space.get(1).toString()).toBe('/CutContour');
    expect(space.get(2).toString()).toBe('/DeviceCMYK');
    expect(space.get(3)).toBeInstanceOf(PDFRef);
    expect(space.lookup(3, PDFDict).lookup(PDFName.of('Range'), PDFArray).asArray()).toHaveLength(8);
    const overprint = resources.lookup(PDFName.of('ExtGState'), PDFDict).lookup(PDFName.of('GS0'), PDFDict);
    expect(overprint.get(PDFName.of('OP'))?.toString()).toBe('true');
    const stream = page.node.Contents() as PDFRawStream;
    const commands = new TextDecoder().decode(decodePDFRawStream(stream).decode());
    expect(commands).toContain('/CS0 CS');
    expect(commands).toContain('1 SCN');
    expect(commands).toContain('0.25 w');
    expect(commands).toContain('h\nS');
    expect(commands).toContain('/GS0 gs');
    expect(commands).toMatch(/\/Artwork[^\s]* Do/);
    expect(stream.dict.has(PDFName.of('Filter'))).toBe(false);
  });

  it('uses PDF 1.3, flattens alpha onto white, and preserves millimeter dimensions', async () => {
    const bytes = await createPdf([art], defaultSettings);
    expect(new TextDecoder().decode(bytes.slice(0, 8))).toBe('%PDF-1.3');
    const doc = await PDFDocument.load(bytes);
    const page = doc.getPages()[0];
    expect(page.getWidth() * 25.4 / 72).toBeCloseTo(86, 5);
    expect(page.getHeight() * 25.4 / 72).toBeCloseTo(46, 5);
    const images = page.node.Resources()!.lookup(PDFName.of('XObject'), PDFDict);
    const image = doc.context.lookup(images.values()[0]) as PDFRawStream;
    expect(image.dict.has(PDFName.of('SMask'))).toBe(false);
    const rgb = decodePDFRawStream(image).decode();
    expect([...rgb.slice(0, 3)]).toEqual([97, 134, 115]);
    expect(rgb).toHaveLength(20 * 10 * 3);
  });

  it('keeps transparent pixels white and opaque pixel colors unchanged', async () => {
    const pixels = art.pixels.slice();
    pixels.set([150, 20, 30, 0, 150, 20, 30, 255], 0);
    const doc = await PDFDocument.load(await createPdf([{ ...art, pixels }], defaultSettings));
    const images = doc.getPages()[0].node.Resources()!.lookup(PDFName.of('XObject'), PDFDict);
    const image = doc.context.lookup(images.values()[0]) as PDFRawStream;
    expect([...decodePDFRawStream(image).decode().slice(0, 6)]).toEqual([255, 255, 255, 150, 20, 30]);
  });

  it('rejects incomplete pixel buffers rather than producing corrupted artwork', async () => {
    await expect(createPdf([{ ...art, pixels: new Uint8ClampedArray() }], defaultSettings)).rejects.toThrow('pixels are incomplete');
  });

  it('exports a cut-only PDF without an embedded artwork image', async () => {
    const doc = await PDFDocument.load(await createPdf([art], { ...defaultSettings, includeArtwork: false }));
    const images = doc.getPages()[0].node.Resources()!.lookup(PDFName.of('XObject'), PDFDict);
    expect(images.keys()).toHaveLength(0);
  });

  it('packs overflow onto additional A4 pages', async () => {
    const doc = await PDFDocument.load(await createPdf(Array.from({ length: 15 }, (_, i) => ({ ...art, id: `${i}` })), { ...defaultSettings, layout: 'a4' }));
    expect(doc.getPageCount()).toBe(2);
    for (const page of doc.getPages()) {
      expect(page.getWidth() * 25.4 / 72).toBeCloseTo(210, 5);
      expect(page.getHeight() * 25.4 / 72).toBeCloseTo(297, 5);
      const spot = page.node.Resources()!.lookup(PDFName.of('ColorSpace'), PDFDict).lookup(PDFName.of('CS0'), PDFArray);
      expect(spot.get(1).toString()).toBe('/CutContour');
    }
  });

  it('rejects designs that cannot fit on A4 instead of clipping them', async () => {
    await expect(createPdf([art], { ...defaultSettings, widthMm: 210, layout: 'a4' })).rejects.toThrow('too large for A4');
  });

  it('includes every design in a ZIP even with duplicate filenames', async () => {
    const download = await createBatchDownload([art, { ...art, id: 'second' }], defaultSettings);
    const zip = await JSZip.loadAsync(await download.blob.arrayBuffer());
    expect(Object.keys(zip.files)).toEqual(['label-CutContour.pdf', 'label-2-CutContour.pdf']);
    for (const file of Object.values(zip.files)) {
      const pdf = await PDFDocument.load(await file.async('uint8array'));
      expect(pdf.getPageCount()).toBe(1);
    }
    expect(download.name).toMatch(/\.zip$/);
  });

  it('uses a direct PDF download for a single design', async () => {
    const download = await createBatchDownload([art], defaultSettings);
    expect(download.name).toBe('label-CutContour.pdf');
    expect(download.blob.type).toBe('application/pdf');
  });

  it('refuses empty batches or designs without usable contours', async () => {
    await expect(createPdf([], defaultSettings)).rejects.toThrow('valid contour');
    await expect(createPdf([{ ...art, rings: [] }], defaultSettings)).rejects.toThrow('valid contour');
  });
});
