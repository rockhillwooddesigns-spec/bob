# Cut-line recognition test

These files each contain one 40 mm square using the exact spot-color name **CutContour**, with a 0.25 pt vector stroke. There is no printable artwork, rasterization, or transparency. The PDF is a minimal, uncompressed PDF 1.3; the EPS uses a PostScript Separation color space and declares its custom color in DSC metadata.

1. Download the original PDF and add it directly as a new job in VersaWorks. Do not print it to PDF, take a screenshot, or convert it through another app.
2. Inspect the job preview for the animated/dotted cutting line and whether cutting controls are available. Only the preview needs testing; do not send a job to the printer yet.
3. Repeat with the EPS if the PDF is not recognized.

Report which file is recognized, your printer model, and whether the line appears as normal printed magenta or is absent. If neither is recognized, check that the selected queue targets a cutting-capable device/configuration. These fixtures are diagnostic files, not proof of compatibility with your particular RIP or printer.

If these fixtures work but an app export fails, attach the original failing exported PDF so its resources and paths can be compared. The app's **Include artwork** switch can also isolate whether recognition changes when artwork/transparency is omitted.

Regenerate with `node scripts/make-cut-diagnostics.mjs`.
