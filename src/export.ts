import JSZip from 'jszip';
import {
  PDFDocument, PDFName, PDFNumber, PDFOperator, PDFOperatorNames, PDFBool,
  PDFArray, PDFContentStream, PDFRef, PDFRawStream, decodePDFRawStream,
  pushGraphicsState, popGraphicsState, setLineWidth,
  moveTo, lineTo, closePath, stroke,
  type PDFPage, type PDFDict,
} from 'pdf-lib';
import { boundsFor } from './contour';
import { planPdfLayout } from './pdf-layout';
import type { Artwork, Settings, TracedArtwork } from './types';

const PT = 72 / 25.4;
const rounded = (value: number) => Math.round(value * 10000) / 10000;

function setupSpotColor(doc: PDFDocument, page: PDFPage) {
  // Match the minimal diagnostic recognized by VersaWorks: an indirect, bounded
  // tint function and a resource alias distinct from the actual spot-color name.
  const tint = doc.context.register(doc.context.obj({ FunctionType: 2, Domain: [0, 1], Range: [0, 1, 0, 1, 0, 1, 0, 1], C0: [0, 0, 0, 0], C1: [0, 1, 0, 0], N: 1 }));
  const spot = doc.context.obj([PDFName.of('Separation'), PDFName.of('CutContour'), PDFName.of('DeviceCMYK'), tint]);
  const resources = page.node.Resources() as PDFDict;
  resources.set(PDFName.of('ColorSpace'), doc.context.obj({ CS0: spot }));
  resources.set(PDFName.of('ExtGState'), doc.context.obj({ GS0: { Type: 'ExtGState', OP: PDFBool.True, op: PDFBool.False, OPM: 1 } }));
}

function drawOpaqueArtwork(doc: PDFDocument, page: PDFPage, art: TracedArtwork, x: number, y: number, width: number, height: number) {
  if (art.pixels.length !== art.width * art.height * 4) throw new Error(`${art.name}: artwork pixels are incomplete. Re-import this image before exporting.`);
  const rgb = new Uint8Array(art.width * art.height * 3);
  for (let i = 0, j = 0; i < art.pixels.length; i += 4, j += 3) {
    const alpha = art.pixels[i + 3];
    for (let channel = 0; channel < 3; channel++) {
      rgb[j + channel] = Math.round((art.pixels[i + channel] * alpha + 255 * (255 - alpha)) / 255);
    }
  }
  // Flatten only the raster artwork. The separately drawn spot-color paths stay
  // vector strokes; there are no soft masks or live transparency in the PDF.
  const image = doc.context.register(doc.context.flateStream(rgb, {
    Type: 'XObject', Subtype: 'Image', Width: art.width, Height: art.height,
    ColorSpace: 'DeviceRGB', BitsPerComponent: 8,
  }));
  const name = page.node.newXObject('Artwork', image);
  page.pushOperators(
    pushGraphicsState(),
    PDFOperator.of(PDFOperatorNames.ConcatTransformationMatrix, [width, 0, 0, height, x, y].map(value => PDFNumber.of(rounded(value)))),
    PDFOperator.of(PDFOperatorNames.DrawObject, [name]),
    popGraphicsState(),
  );
}

async function drawArtwork(doc: PDFDocument, page: PDFPage, art: TracedArtwork, settings: Settings, leftMm: number, topMm: number) {
  const b = boundsFor(art);
  const mmPerPixel = settings.widthMm / art.width;
  const scale = mmPerPixel * PT;
  const imageX = leftMm * PT - b.minX * scale;
  const imageTop = page.getHeight() - topMm * PT + b.minY * scale;
  if (settings.includeArtwork) {
    drawOpaqueArtwork(doc, page, art, imageX, imageTop - art.height * scale, art.width * scale, art.height * scale);
  }
  page.pushOperators(
    pushGraphicsState(),
    PDFOperator.of(PDFOperatorNames.SetGraphicsStateParams, [PDFName.of('GS0')]),
    PDFOperator.of(PDFOperatorNames.StrokingColorspace, [PDFName.of('CS0')]),
    PDFOperator.of(PDFOperatorNames.StrokingColorN, [PDFNumber.of(1)]),
    setLineWidth(0.25),
  );
  for (const ring of art.rings) {
    if (ring.length < 3) continue;
    page.pushOperators(moveTo(rounded(imageX + ring[0][0] * scale), rounded(imageTop - ring[0][1] * scale)));
    for (const [x, y] of ring.slice(1)) page.pushOperators(lineTo(rounded(imageX + x * scale), rounded(imageTop - y * scale)));
    page.pushOperators(closePath(), stroke());
  }
  page.pushOperators(popGraphicsState());
}

export async function createPdf(artworks: TracedArtwork[], settings: Settings, options: { loadArtwork?: (art: TracedArtwork) => Promise<Artwork>; onArtwork?: () => void } = {}): Promise<Uint8Array> {
  if (!artworks.length || artworks.some(art => !art.rings.length || art.error)) throw new Error('Every selected design must have a valid contour before exporting.');
  const doc = await PDFDocument.create();
  doc.setTitle(artworks.length === 1 ? artworks[0].name : 'Contour — batch cut sheet');
  doc.setCreator('Contour Studio 1.2.0');
  doc.setSubject('Print and cut artwork with a CutContour Separation spot color');
  for (const layout of planPdfLayout(artworks, settings)) {
    const page = doc.addPage([layout.widthMm * PT, layout.heightMm * PT]);
    setupSpotColor(doc, page);
    for (const item of layout.items) {
      const art = artworks[item.index];
      const raster = settings.includeArtwork && options.loadArtwork ? { ...art, ...await options.loadArtwork(art), rings: art.rings } : art;
      await drawArtwork(doc, page, raster, settings, item.leftMm, item.topMm);
      options.onArtwork?.();
    }
  }
  return saveCompatiblePdf(doc);
}

export async function addRasterArtwork(cutPdf: Uint8Array, artworks: TracedArtwork[], settings: Settings, load: (art: TracedArtwork) => Promise<Artwork>, onArtwork: () => void) {
  const doc = await PDFDocument.load(cutPdf);
  const layout = planPdfLayout(artworks, settings);
  if (doc.getPageCount() !== layout.length) throw new Error('The export service returned an unexpected page layout.');
  for (let i = 0; i < layout.length; i++) {
    const page = doc.getPages()[i];
    const previous = page.node.normalizedEntries().Contents?.asArray().slice() || [];
    for (const item of layout[i].items) {
      const art = artworks[item.index];
      if (settings.includeArtwork) {
        const raster = await load(art);
        const bounds = boundsFor(art), scale = settings.widthMm / art.width * PT;
        const x = item.leftMm * PT - bounds.minX * scale;
        const top = page.getHeight() - item.topMm * PT + bounds.minY * scale;
        drawOpaqueArtwork(doc, page, { ...art, ...raster, rings: art.rings }, x, top - art.height * scale, art.width * scale, art.height * scale);
      }
      onArtwork();
    }
    // Prepend the print image stream. Drawing it above the spot paths could hide
    // inner cutouts. The spot color and all cut strokes come from the service.
    const all = page.node.normalizedEntries().Contents?.asArray() || [];
    page.node.set(PDFName.of('Contents'), doc.context.obj([...all.filter(ref => !previous.includes(ref)), ...previous]));
  }
  return saveCompatiblePdf(doc);
}

async function saveCompatiblePdf(doc: PDFDocument): Promise<Uint8Array> {
  // Keep a single, uncompressed page content stream, as in the known-working
  // diagnostic. Image data can remain compressed without changing cut paths.
  const obsolete = new Set<PDFRef>();
  for (const page of doc.getPages()) {
    const contents = page.node.Contents();
    const refs = contents instanceof PDFArray ? contents.asArray() as PDFRef[] : [page.node.get(PDFName.of('Contents')) as PDFRef];
    const commands = refs.map(ref => {
      const object = doc.context.lookup(ref);
      return object instanceof PDFRawStream ? new TextDecoder().decode(decodePDFRawStream(object).decode()) : (object as PDFContentStream).getContentsString();
    }).join('\n');
    const stream = doc.context.register(doc.context.stream(commands));
    page.node.set(PDFName.of('Contents'), stream);
    refs.forEach(ref => obsolete.add(ref));
  }
  obsolete.forEach(ref => doc.context.delete(ref));
  const bytes = await doc.save({ useObjectStreams: false });
  // pdf-lib's writer hardcodes 1.7 and ignores context.header. Everything we
  // emit above is PDF 1.3: opaque RGB images, Separation colors, classic xref,
  // and ordinary streams. An equal-length header replacement preserves offsets.
  bytes.set(new TextEncoder().encode('%PDF-1.3'), 0);
  return bytes;
}

export function safeName(name: string): string {
  return name.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'artwork';
}

export async function createBatchDownload(artworks: TracedArtwork[], settings: Settings): Promise<{ blob: Blob; name: string }> {
  if (settings.layout === 'a4' || artworks.length === 1) {
    const bytes = await createPdf(artworks, settings);
    return { blob: new Blob([new Uint8Array(bytes)], { type: 'application/pdf' }), name: settings.layout === 'a4' ? 'contour-a4-sheets.pdf' : `${safeName(artworks[0].name)}-CutContour.pdf` };
  }
  const zip = new JSZip();
  const used = new Set<string>();
  for (const art of artworks) {
    const base = safeName(art.name);
    let stem = base, suffix = 2;
    while (used.has(stem.toLowerCase())) stem = `${base}-${suffix++}`;
    used.add(stem.toLowerCase());
    zip.file(`${stem}-CutContour.pdf`, await createPdf([art], settings));
  }
  return { blob: await zip.generateAsync({ type: 'blob' }), name: `contour-batch-${artworks.length}-designs.zip` };
}
