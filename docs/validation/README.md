# Version 1.2 validation evidence

The owner stress test used 500 copies of a synthetic 1,400 × 1,400 PNG, with unique filenames, in headless desktop Chromium in this cloud environment. Each image had a rounded solid silhouette and text. This exercises image decoding, temporary storage, tracing, queue navigation, cancellation, PDF generation, ZIP partitioning, and downloads; it does not represent every artwork's geometric complexity or every customer's device.

The attached JSON records elapsed seconds from the start of the entire test, including setup and UI checks. The workflow produced ten 50-design ZIP volumes containing all 500 unique PDF filenames. A PDF from each volume was parsed to verify its CutContour resource. The measured heap field is only the main JavaScript thread after export and garbage collection, not peak or total browser RAM.

The separate standard browser suite passes 12 workflow checks. The hosted UI suite uses routed test auth/account/provider responses, real cut-PDF generation and local composition, and confirms Free limits/Pro controls and checkout/portal API wiring. No live payment was performed.

Forty automated tests cover geometry, PDFs, batch partitioning, real PostgreSQL rules through PGlite, and billing handlers with mocked provider requests and signed Stripe fixture webhooks. Actual Supabase email delivery, Stripe account settings, deployed Netlify Functions, taxes, receipts, and live payments require the operator's test-mode launch checks in PAID-LAUNCH.md.
