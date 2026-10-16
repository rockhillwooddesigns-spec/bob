# Put Contour Studio on your Shopify storefront

This integration adds a customer-facing workspace to a Shopify Online Store 2.0 page. It keeps dark/light mode, VersaWorks CutContour PDFs, 500-design Pro batches, presets, and your Free / CAD $7.99 monthly / CAD $79.99 annual plans.

**Shopify displays the app in a frame. The paid app and its export APIs still run on Netlify, with Stripe and Supabase.** Shopify Liquid cannot run the existing backend. This is not a Shopify admin app or Shopify-native subscription product. Shopify customer accounts, orders, discounts, and subscription billing are separate; customers sign in to Contour Studio. Stripe checkout opens in another tab. No theme or store has been changed automatically.

## 1. Prepare the hosted customer app

Follow [PAID-LAUNCH.md](PAID-LAUNCH.md) using your own Stripe, Supabase, and Netlify accounts. Do not embed `downloads/contour-site.zip`: that is the unrestricted personal owner edition. Do not put Stripe secret keys or Supabase service-role keys into a Shopify theme.

In **Supabase → Authentication → Email Templates → Magic Link**, include both the code and the link, for example:

```html
<h2>Sign in to Contour Studio</h2>
<p>On the store page, enter this sign-in code: <strong>{{ .Token }}</strong></p>
<p>Or <a href="{{ .ConfirmationURL }}">open the full workspace and sign in</a>.</p>
```

Keep Supabase's Site URL and allowed redirect URL set to the hosted app's HTTPS origin, as described in the launch guide. Set up real email delivery. The frame uses email-code verification so customers can finish sign-in without leaving their artwork. The full workspace keeps email-link sign-in. Storefront sign-in and the full workspace may use separate browser storage; a second sign-in may be needed.

For the most reliable embedded experience, put the app on a subdomain of your storefront domain (for example, `tools.YOUR-DOMAIN.com` with the store at `www.YOUR-DOMAIN.com`) using Netlify custom-domain settings and HTTPS. Browsers often block databases in cross-site frames such as a Netlify app inside a Shopify store; the integration detects this and shows a button to open the full app in a new tab instead of a broken editor. Private browsing and stricter browser settings can still require that fallback.

The app must permit embedding. If your host sets `X-Frame-Options: DENY` or `SAMEORIGIN`, remove that header for the app document. For a Content-Security-Policy, add your actual store origins to `frame-ancestors`; for example, `frame-ancestors 'self' https://YOUR-STORE.myshopify.com https://www.YOUR-DOMAIN.com https://YOUR-DOMAIN.com`. Replace the examples with your domains, and include only domains you own. This directive must be an HTTP response header, not an HTML meta tag. If you restrict framing, the Shopify theme editor may need to use its storefront preview instead.

## 2. Add the Shopify section

1. Download [the section file](../shopify/sections/contour-studio.liquid) (on GitHub: open it, then **Raw → Save as**). It is one Liquid file, not a complete theme.
2. In **Shopify → Online Store → Themes**, duplicate your current theme to make a backup. Open the theme you want to edit and choose **Edit code**.
3. Under **Sections**, create `contour-studio.liquid`, paste the downloaded file's contents, and save.
4. Open **Customize / Edit theme**. In the page selector, choose **Pages → Create template**, name it `contour-studio`, and base it on the default page. Add the **Contour Studio** section. If the theme offers a full-width page layout, use it.
5. In the section's **Hosted customer app URL** setting, paste your deployed app's HTTPS URL. Adjust workspace height if needed, then save. Until a valid HTTPS URL is entered, the live page shows a preparation message.
6. In **Online Store → Pages**, create a page titled **Contour Studio** and assign the `contour-studio` template. Save. Add that page to your store's navigation menu (often under **Content → Menus**).
7. Preview the page and complete the checks below before publishing your edited theme. Changing a published theme takes effect immediately; use a duplicate theme first if you want to review privately.

The section appears in the theme editor's Add section list on compatible Online Store 2.0 themes. Older themes may need a theme upgrade or a developer to add a section to their page template.

## 3. Check before opening sales

- On the actual store domain, import a transparent PNG/SVG, preview its contour, download a PDF, and check the CutContour in VersaWorks 7.6.1.3202.
- Sign in with the emailed code inside the frame. Confirm that Free cannot batch and its sixth monthly export is blocked.
- With Stripe **test keys**, try both Pro plans. Checkout must open in another tab. Return to the store page after paying; focus the embedded workspace to refresh the plan. Check the webhook granted Pro, 500-design access, saved presets, cancellation, and the billing portal. Do not switch to live keys until these checks pass.
- Try mobile and a browser that blocks third-party storage. The **Open full workspace** links remain outside and inside the frame; use them if storage or downloads are blocked. Files are not transferred automatically between those workspaces. Save downloads before navigating away.

Embedding does not make the backend or provider accounts live. The Shopify installation and real provider flows still require verification on your own store; local tests cannot establish that checkout and email delivery are configured there.

## Developer verification

`npm run test:shopify` renders the actual Liquid section with LiquidJS and runs Playwright against the hosted build (default preview URL `http://127.0.0.1:5176`, override with `BASE_URL`). It verifies invalid URL handling, HTML escaping, the cross-site storage fallback, same-site sandboxed preview, email-code sign-in and error recovery, a downloaded CutContour PDF, monthly/annual/portal popups, billing failure cleanup, and popup-blocker recovery. Provider responses are routed fixtures. Use the same hosted fixture build and Chromium setup as `tests/hosted-browser.mjs`; this does not contact real Stripe or deliver email.

`npm run package:shopify` regenerates the installation ZIP from the section and this guide. The ZIP is an integration kit, not an uploadable complete Shopify theme.
