import JSZip from 'jszip';
import {
  PDFDocument, PDFName, PDFNumber, PDFOperator, PDFOperatorNames, PDFBool,
  pushGraphicsState, popGraphicsState, setLineWidth,
  moveTo, lineTo, closePath, stroke,
  type PDFPage, type PDFDict,
} from 'pdf-lib';
import { boundsFor } from './contour';
import type { Settings, TracedArtwork } from './types';

const PT = 72 / 25.4;
const MARGIN = 3;

function setupSpotColor(doc: PDFDocument, page: PDFPage) {
  const tint = doc.context.obj({ FunctionType: 2, Domain: [0, 1], C0: [0, 0, 0, 0], C1: [0, 1, 0, 0], N: 1 });
  const spot = doc.context.obj([PDFName.of('Separation'), PDFName.of('CutContour'), PDFName.of('DeviceCMYK'), tint]);
  const resources = page.node.Resources() as PDFDict;
  resources.set(PDFName.of('ColorSpace'), doc.context.obj({ CutContour: spot }));
  resources.set(PDFName.of('ExtGState'), doc.context.obj({ CutOverprint: { Type: 'ExtGState', OP: PDFBool.True, op: PDFBool.False, OPM: 1 } }));
}

async function drawArtwork(doc: PDFDocument, page: PDFPage, art: TracedArtwork, settings: Settings, leftMm: number, topMm: number) {
  const b = boundsFor(art);
  const mmPerPixel = settings.widthMm / art.width;
  const scale = mmPerPixel * PT;
  const imageX = leftMm * PT - b.minX * scale;
  const imageTop = page.getHeight() - topMm * PT + b.minY * scale;
  if (settings.includeArtwork) {
    const png = await doc.embedPng(art.image);
    page.drawImage(png, { x: imageX, y: imageTop - art.height * scale, width: art.width * scale, height: art.height * scale });
  }
  page.pushOperators(
    pushGraphicsState(),
    PDFOperator.of(PDFOperatorNames.SetGraphicsStateParams, [PDFName.of('CutOverprint')]),
    PDFOperator.of(PDFOperatorNames.StrokingColorspace, [PDFName.of('CutContour')]),
    PDFOperator.of(PDFOperatorNames.StrokingColorN, [PDFNumber.of(1)]),
    setLineWidth(0.25),
  );
  for (const ring of art.rings) {
    if (ring.length < 3) continue;
    page.pushOperators(moveTo(imageX + ring[0][0] * scale, imageTop - ring[0][1] * scale));
    for (const [x, y] of ring.slice(1)) page.pushOperators(lineTo(imageX + x * scale, imageTop - y * scale));
    page.pushOperators(closePath());
  }
  page.pushOperators(stroke(), popGraphicsState());
}

export async function createPdf(artworks: TracedArtwork[], settings: Settings): Promise<Uint8Array> {
  if (!artworks.length || artworks.some(art => !art.rings.length || art.error)) throw new Error('Every selected design must have a valid contour before exporting.');
  const doc = await PDFDocument.create();
  doc.setTitle(artworks.length === 1 ? artworks[0].name : 'Contour — batch cut sheet');
  doc.setCreator('Contour Studio');
  doc.setSubject('Print and cut artwork with a CutContour Separation spot color');
  if (settings.layout === 'individual') {
    for (const art of artworks) {
      const b = boundsFor(art), mmPerPixel = settings.widthMm / art.width;
      const page = doc.addPage([(b.width * mmPerPixel + MARGIN * 2) * PT, (b.height * mmPerPixel + MARGIN * 2) * PT]);
      setupSpotColor(doc, page);
      await drawArtwork(doc, page, art, settings, MARGIN, MARGIN);
    }
  } else {
    const margin = 8, gap = 6, pageWidth = 210, pageHeight = 297;
    let page = doc.addPage([pageWidth * PT, pageHeight * PT]);
    setupSpotColor(doc, page);
    let x = margin, y = margin, rowHeight = 0;
    for (const art of artworks) {
      const b = boundsFor(art), mmPerPixel = settings.widthMm / art.width;
      const width = b.width * mmPerPixel, height = b.height * mmPerPixel;
      if (width > pageWidth - margin * 2 || height > pageHeight - margin * 2) throw new Error(`${art.name} is too large for A4. Reduce the artwork width or export separate PDFs.`);
      if (x + width > pageWidth - margin + 0.001) { x = margin; y += rowHeight + gap; rowHeight = 0; }
      if (y + height > pageHeight - margin + 0.001) { page = doc.addPage([pageWidth * PT, pageHeight * PT]); setupSpotColor(doc, page); x = margin; y = margin; rowHeight = 0; }
      await drawArtwork(doc, page, art, settings, x, y);
      rowHeight = Math.max(rowHeight, height);
      x += width + gap;
    }
  }
  return doc.save({ useObjectStreams: false });
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
