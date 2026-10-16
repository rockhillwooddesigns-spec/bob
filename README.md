# Contour Studio

A browser-based batch contour-cut workspace for Roland VersaWorks. Import transparent PNG/SVG artwork, set a physical print width and cut offset, inspect the paths, and export a batch of PDFs.

## Open the website without installing developer tools

[Download the ready-to-host website ZIP](downloads/contour-site.zip?raw=true). Unzip it, open [Netlify Drop](https://app.netlify.com/drop), and drag the extracted **contour-site** folder onto the page. Netlify provides the website link. This ZIP contains the tested production build; it does not require Node.js or npm to host.

The source files below are for development. A GitHub repository stores the project files; it does not automatically publish a live website. The website ZIP should be rebuilt after source changes before being redistributed.

## Run

Use Node.js 24 and npm. No account, API key, server database, or external service is needed.

```sh
npm ci
npm run dev
```

```sh
npm test          # Geometry and PDF structure checks
npm run build    # Type check and production bundle
npm run preview  # Serve the production bundle
```

For the browser checks, start the app first, then run:

```sh
# Use an installed Chromium browser in this cloud environment.
CHROMIUM_PATH=/usr/bin/chromium npm run test:browser

# Or install Playwright's Chromium on your own machine:
npx playwright install chromium
npm run test:browser
```

`BASE_URL` overrides the browser test's default server address. Screenshots and test downloads are written to the ignored `.local/` directory.

## Print and cut workflow

1. Add PNG, self-contained SVG, JPG, or WebP images. The first real upload replaces the sample batch. Up to 25 designs and 30 MB per file are supported.
2. Set the artwork width in millimeters. Height stays proportional. The width includes the source image's transparent padding; crop unnecessary padding before importing.
3. Set the outward cut offset, smoothing, and optional inner cutouts. All designs share these settings. Select which designs to export using their checkboxes.
4. Export separate PDFs, bundled in a ZIP for multiple designs, or automatically packed A4 sheets. Uncheck **Include artwork** to export only the vector cut paths.
5. Open the PDFs in VersaWorks at 100% scale. Verify its animated dotted cut preview and the physical dimensions, choose the appropriate Print & Cut controls, and run a small test cut before production.

Version 1.0.1 uses a simpler PDF 1.3 export structure based on the cut-square diagnostic recognized in the reported VersaWorks 7.6.1 installation. Print artwork is flattened onto white; the CutContour lines remain separate vector strokes. The specific cause of the original rejection is not yet isolated, and the revised artwork export still needs confirmation in VersaWorks.

The export defines a real PDF `/Separation /CutContour /DeviceCMYK` spot color with a magenta alternate color, a 0.25 pt closed vector stroke, and stroke overprinting. The spot color name is case-sensitive. Page bounds include the cut offset and a 3 mm margin for individual designs. A4 sheets use an 8 mm margin and 6 mm gaps between the outer bounds.

## Processing and limits

- Files are decoded and processed locally. Artwork is not uploaded. Fonts are self-hosted; the app has no runtime API or analytics calls.
- The longest raster edge is capped at 1,400 pixels for predictable browser memory use. SVG artwork is rasterized for printing. Contour paths remain vectors. This tool suits small stickers; check effective print resolution before using large physical sizes.
- Tracing uses transparency, or optionally ignores near-white pixels. It does not automatically segment a photo from a complex background. White mode changes tracing. At export, transparency and partially transparent pixels in the print artwork are composited onto white. This is intended for white media; live transparency and separate white-ink handling are not preserved.
- Very small islands under four source pixels of area are discarded. Rounded offsets are unioned to avoid duplicate cuts when shapes overlap. Smoothing reduces path nodes; inspect fine details and narrow cutouts before exporting.
- A4 packing preserves order and size without rotation or duplication. Oversized designs produce an error rather than being clipped.
- Files and settings are held in memory and reset on reload. This version has no saved projects or user accounts.
- PDF structure, physical dimensions, alpha flattening, and browser downloads are tested automatically. A physical Roland printer and VersaWorks are not available in this environment; recognition, media settings, color management, and cutting force must be checked on the production system.

## Stack

React, TypeScript, and Vite; d3-contour for marching-squares tracing; Clipper for polygon unions and offsets; pdf-lib for spot-color PDFs; JSZip for batches. Tracing runs in a web worker so the workspace stays responsive.
