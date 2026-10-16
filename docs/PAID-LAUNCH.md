# Launching the paid Contour website

The paid build implements your plans:

| Plan | Price | Exports | Features |
| --- | --- | --- | --- |
| Free | CAD $0 | 5 single-design exports per UTC calendar month | Basic contours, preview, PDF output |
| Pro | CAD $7.99/month | No monthly quota | Batches up to 500, advanced settings, saved presets |
| Annual Pro | CAD $79.99/year | Same Pro features | Saves CAD $15.89 against 12 monthly payments, about two months free |

An export means one successfully generated single-design PDF on Free. A canceled/expired reservation that never generated a PDF does not consume the final allowance. Export creation and quota reservation are atomic in PostgreSQL. Retries of an unchanged authorized job use the same request ID and do not consume another export. A new export after success is a new job. Pro has no monthly quota; browser storage, per-batch, per-part, and service resource limits still apply.

## Two builds: owner and hosted customer

- **Owner ZIP (`downloads/contour-site.zip`):** a standalone 500-design workspace with dark/light mode and local presets. It shows the prices for review but does not collect money, require accounts, or enforce customer quotas. Do not use this ZIP as your paid customer site. It can still be uploaded to a static host for your personal workspace.
- **Hosted customer website:** built from this repository with `VITE_BILLING_ENABLED=true`, Netlify Functions, Supabase accounts/PostgreSQL, and Stripe. Free/Pro access is checked by the server. The public build never contains the Stripe secret or Supabase service role key.

Existing public source code and owner downloads can be copied or self-hosted. The hosted subscription protects access to your hosted service, not the software from copying. Before a commercial launch, decide whether to restrict repository/download access and adopt a commercial license. This update does not change repository visibility or silently revoke existing copies.

## 1. Create a Supabase project

1. Create a project in your own Supabase account.
2. Run [the billing SQL migration](../supabase/migrations/001_billing.sql) once in its SQL editor. It creates profiles, authorized export jobs, private presets, webhook-event records, row-level policies, and service-only quota functions.
3. Enable email sign-in / magic links. Set **Site URL** to your final website URL and allow that origin as an auth redirect URL.
4. Configure a production email delivery provider in Supabase before inviting customers. Its default email delivery has restrictive limits and is not a production mailing service.
5. Record the project URL, public anon/publishable-compatible JWT key, and private service-role key. Put the private key only in server environment settings. This integration uses the legacy public anon key and service-role key supported by `supabase-js`.

Supabase stores customer IDs, entitlement status, export-job metadata/hashes, and presets. It does not receive artwork pixels. Do not grant browser roles write access to billing tables or permission to call service-only functions.

## 2. Configure Stripe in test mode first

1. Complete your Stripe business setup and create **Contour Pro** as a subscription product.
2. Create two recurring prices in **CAD**: **799 cents every month** and **7,999 cents every year**. Use interval count 1. The server verifies both amount and currency before opening checkout; a mismatched Price ID fails closed.
3. Enable the Stripe customer portal. Allow customers to cancel renewal and switch between these two prices. Configure proration and business policies in Stripe as appropriate for your launch.
4. Set up a webhook endpoint at `https://YOUR-SITE/api/stripe-webhook` for `customer.subscription.created`, `customer.subscription.updated`, and `customer.subscription.deleted`. Use the endpoint's signing secret from the same Stripe mode as the API key and Price IDs.
5. Configure payment methods in Stripe. Checkout requests card support; supported card wallets can be offered by Stripe. No card numbers are handled by this app.
6. Configure your tax obligations, customer-facing terms, privacy policy, refund policy, business contact, and Stripe receipts before going live. Automatic tax is optional and remains off unless `STRIPE_AUTOMATIC_TAX=true`; enabling it also requires Stripe Tax registrations and configuration.

Pro activation comes from a signed webhook and the current Stripe subscription, never the checkout success URL or a client-supplied plan. Access lasts through the paid period for a subscription canceled at period end. `past_due`, `unpaid`, `canceled`, and expired periods do not grant Pro. Billing retries and renewal notifications are managed through Stripe. Monitor webhook delivery failures in Stripe so renewal events are not missed.

Checkout creation uses a server-side lease and Stripe idempotency keys. Existing open checkouts are reused; active/pending subscriptions cannot start a second subscription through the app. The portal remains available for customers with a Stripe customer record, including customers whose Pro subscription is inactive.

## 3. Connect GitHub to Netlify

Use Netlify's **Import an existing project** flow and choose this repository. A static Netlify Drop upload cannot run the paid account and export APIs.

The committed [netlify.toml](../netlify.toml) sets `npm run build`, `dist`, `netlify/functions`, Node 24, and `VITE_BILLING_ENABLED=true`. Add these environment variables through Netlify's secure settings, then deploy:

| Variable | Value / scope |
| --- | --- |
| `APP_URL` | Your exact HTTPS website origin, without a trailing path |
| `VITE_SUPABASE_URL` | Supabase project URL; public build value |
| `VITE_SUPABASE_ANON_KEY` | Supabase public anon key; public build value |
| `SUPABASE_URL` | Same project URL; server value |
| `SUPABASE_SERVICE_ROLE_KEY` | Private service-role key; Functions/server only |
| `STRIPE_SECRET_KEY` | Private Stripe API key; Functions/server only |
| `STRIPE_WEBHOOK_SECRET` | Private webhook signing secret; Functions/server only |
| `STRIPE_PRICE_MONTHLY` | CAD 7.99 monthly recurring Price ID; server value |
| `STRIPE_PRICE_ANNUAL` | CAD 79.99 annual recurring Price ID; server value |
| `STRIPE_AUTOMATIC_TAX` | Optional `true` after configuring Stripe Tax |

A hosted build intentionally fails while the two public Supabase build settings are missing, so an incomplete setup does not replace an existing production site.

Never prefix a private key with `VITE_`. Vite variables are public and baked into the browser build. Rebuild after changing public auth values. Do not paste private keys into chat, commits, screenshots, or the SQL editor.

## 4. Test before enabling real payments

1. Sign in with a real test customer email and confirm the magic link returns to the right site.
2. On Free, export five distinct designs and verify the sixth is blocked. Confirm advanced settings, batching, and saved presets require Pro.
3. Buy monthly Pro with Stripe test-mode payment details. Verify a signed subscription event grants Pro, then test a batch and save/reload a preset.
4. Test annual checkout and verify it charges CAD 79.99 per year. Confirm only one subscription exists for the account.
5. Open the customer portal and test plan changes, cancellation, renewal, failed payments, and access at the end of the paid period. Retry webhook deliveries to verify they do not duplicate entitlements.
6. Confirm final PDFs still show the cutting line in VersaWorks. Version 1.2 keeps the PDF 1.3 export format and white-flattened print image from the user-confirmed working version; cloud cut PDFs receive the print image locally underneath the vector strokes.
7. When test-mode flows work, enter the matching live-mode API key, live Price IDs, and live webhook signing secret securely, then repeat the live launch checks. This onboarding session has not created a Stripe product, taken a payment, or verified a real deployed checkout.

## Processing and privacy

Full artwork is kept in temporary IndexedDB storage on the customer's device. The cloud export API receives cut-path geometry, design names/dimensions, and a content hash to bind each export to its authorized job. Print pixels are composited locally under the server-generated spot-color paths. Update your customer-facing privacy notice to reflect that geometry/metadata is sent to the service; do not advertise the hosted version as entirely offline.

Jobs expire after two hours. Expired unfinished reservations stop reducing the Free allowance. A completed job can be retried within its lifetime with the same geometry/settings. Old job metadata and processed webhook IDs require a retention policy appropriate for your business; arrange scheduled cleanup and backups in your Supabase project. Do not delete current-month completed Free jobs, or customers' used allowance would be reset.

Netlify function limits, Supabase capacity, Stripe fees, taxes, refunds, and abuse prevention still have operational costs. Before opening a public free tier, configure platform rate limits and monitor sign-up/export volume. This is not unlimited server capacity or protection against people creating multiple free email accounts.

## Development

The ordinary `npm run dev` / `npm run build` defaults to owner mode. Use a local ignored `.env.local` based on `.env.example` and Netlify's local Functions tooling when developing a real hosted setup. Frontend-only Vite does not emulate the account APIs.

`npm run test:hosted` checks hosted UI/API wiring against routed test account/provider responses (after a hosted test build). `npm test` covers real PostgreSQL rules with PGlite, signed Stripe fixture webhooks, billing/authorization routes, geometry, PDF output, and 500-design export partitioning. Provider calls in route tests are mocked. These tests do not replace testing your own Stripe/Supabase/Netlify configuration.
