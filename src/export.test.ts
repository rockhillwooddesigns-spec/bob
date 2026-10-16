import { describe, expect, it } from 'vitest';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, decodePDFRawStream } from 'pdf-lib';
import JSZip from 'jszip';
import { createBatchDownload, createPdf } from './export';
import { defaultSettings, type TracedArtwork } from './types';

// A real semitransparent PNG exercises both the image resource and its soft mask.
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGOUD7bcwsDAwMDEAAUAFKQBY8XakPYAAAAASUVORK5CYII=';
const art: TracedArtwork = {
  id: 'test', name: 'label.png', image: png, width: 20, height: 10,
  pixels: new Uint8ClampedArray(), rings: [[[0, 0], [20, 0], [20, 10], [0, 10]]],
};

describe('VersaWorks PDF output', () => {
  it('defines a named Separation color space and an overprinted 0.25 pt closed stroke', async () => {
    const doc = await PDFDocument.load(await createPdf([art], defaultSettings));
    const page = doc.getPages()[0];
    const resources = page.node.Resources()!;
    const space = resources.lookup(PDFName.of('ColorSpace'), PDFDict).lookup(PDFName.of('CutContour'), PDFArray);
    expect(space.get(0).toString()).toBe('/Separation');
    expect(space.get(1).toString()).toBe('/CutContour');
    expect(space.get(2).toString()).toBe('/DeviceCMYK');
    const overprint = resources.lookup(PDFName.of('ExtGState'), PDFDict).lookup(PDFName.of('CutOverprint'), PDFDict);
    expect(overprint.get(PDFName.of('OP'))?.toString()).toBe('true');
    const contents = page.node.Contents() as PDFArray;
    const stream = doc.context.lookup(contents.get(0)) as PDFRawStream;
    const commands = new TextDecoder().decode(decodePDFRawStream(stream).decode());
    expect(commands).toContain('/CutContour CS');
    expect(commands).toContain('1 SCN');
    expect(commands).toContain('0.25 w');
    expect(commands).toContain('h\nS');
    expect(commands).toContain('/CutOverprint gs');
    expect(commands).toMatch(/\/Image[^\s]* Do/);
  });

  it('preserves image transparency and millimeter dimensions', async () => {
    const doc = await PDFDocument.load(await createPdf([art], defaultSettings));
    const page = doc.getPages()[0];
    expect(page.getWidth() * 25.4 / 72).toBeCloseTo(86, 5);
    expect(page.getHeight() * 25.4 / 72).toBeCloseTo(46, 5);
    const images = page.node.Resources()!.lookup(PDFName.of('XObject'), PDFDict);
    const image = doc.context.lookup(images.values()[0]) as PDFRawStream;
    expect(image.dict.has(PDFName.of('SMask'))).toBe(true);
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
      expect(page.node.Resources()!.lookup(PDFName.of('ColorSpace'), PDFDict).has(PDFName.of('CutContour'))).toBe(true);
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
