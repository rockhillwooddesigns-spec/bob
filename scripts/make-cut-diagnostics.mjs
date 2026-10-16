// Deliberately minimal fixtures for diagnosing RIP cut-color recognition.
// PDF 1.3 has no artwork, transparency, compression, or object streams.
import { mkdir, writeFile } from 'node:fs/promises';

const destination = new URL('../downloads/diagnostics/', import.meta.url);
await mkdir(destination, { recursive: true });
const pt = 72 / 25.4;
const page = (60 * pt).toFixed(6);
const margin = (10 * pt).toFixed(6);
const edge = (40 * pt).toFixed(6);
const contents = `q\n/GS0 gs\n/CS0 CS\n1 SCN\n0.25 w\n${margin} ${margin} ${edge} ${edge} re\nS\nQ\n`;
const objects = [
  '<< /Type /Catalog /Pages 2 0 R >>',
  '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${page} ${page}] /Resources << /ColorSpace << /CS0 [/Separation /CutContour /DeviceCMYK 5 0 R] >> /ExtGState << /GS0 << /Type /ExtGState /OP true /op false /OPM 1 >> >> >> /Contents 4 0 R >>`,
  `<< /Length ${Buffer.byteLength(contents)} >>\nstream\n${contents}endstream`,
  '<< /FunctionType 2 /Domain [0 1] /Range [0 1 0 1 0 1 0 1] /C0 [0 0 0 0] /C1 [0 1 0 0] /N 1 >>',
];
let pdf = '%PDF-1.3\n';
const offsets = [0];
objects.forEach((object, index) => {
  offsets.push(Buffer.byteLength(pdf));
  pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
});
const xref = Buffer.byteLength(pdf);
pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
pdf += offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
await writeFile(new URL('cutcontour-square.pdf', destination), pdf);

const eps = `%!PS-Adobe-3.0 EPSF-3.0
%%Title: CutContour 40 mm square diagnostic
%%Creator: Contour Studio
%%BoundingBox: 0 0 171 171
%%HiResBoundingBox: 0 0 ${page} ${page}
%%LanguageLevel: 3
%%DocumentCustomColors: (CutContour)
%%CMYKCustomColor: 0 1 0 0 (CutContour)
%%Pages: 1
%%EndComments
%%Page: 1 1
gsave
[/Separation /CutContour /DeviceCMYK {0 exch 0 0}] setcolorspace
1 setcolor
true setoverprint
0.25 setlinewidth
newpath
${margin} ${margin} moveto
${edge} 0 rlineto
0 ${edge} rlineto
-${edge} 0 rlineto
closepath stroke
grestore
showpage
%%EOF
`;
await writeFile(new URL('cutcontour-square.eps', destination), eps);
console.log('Created PDF and EPS cut-recognition diagnostics.');
