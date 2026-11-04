# Protein Scanner

A mobile-first web prototype for identifying a packaged food and its shelf price, confirming the values, and comparing protein efficiency.

## What it does

From the landing page, a user can:

- **Scan** — use the device camera to sample still frames for analysis.
- **Upload photo** — submit one chosen photo for the same analysis and review path.
- **Enter manually** — enter food, price, and nutrition values without an image or model call.
- **Try example** — run a visibly labeled fixture example. It is not a live lookup or a live price.

For scan and upload flows, image analysis requires one explicit opt-in before the image is sent to Meta. Detected item, price, and nutrition candidates are shown for review. The user can correct values, reject an incorrect product match, and must confirm the inputs before results are calculated.

Where the confirmed inputs support it, the app calculates:

- protein per dollar (displayed as `g protein / $` for USD; otherwise named by currency), and
- protein per 100 kcal.

Both metrics require compatible quantities and valid inputs. If a value is missing or incompatible, that metric is shown as unavailable rather than guessed. Barcode lookup and search use Open Food Facts (OFF); nutrition is attributed to an OFF record, a visibly read label, or user input.

After confirmation, a food can be added to a device-local diary with its amount and available protein/energy values; totals are only shown for entries with compatible known values.

Optional marketplace links are plain searches using the confirmed product name. They are labeled as searches.

## What it does not do

- Photos are analyzed in memory and never kept by the app.
- It has no accounts or sign-in.
- It does not provide live retailer prices. Marketplace/search links only open a search; they do not display retailer prices or offers, and no retailer scraping or retailer API is used.
- It is not a diet recommendation or medical tool.

## Setup

Requirements: Node.js 22 or later (see `engines` in `package.json`).

```sh
npm install
```

Copy the example environment file to `.env.local`:

```sh
# Windows PowerShell
Copy-Item .env.example .env.local
```

```sh
# macOS / Linux
cp .env.example .env.local
```

Set the following in `.env.local` for local development:

```ini
MUSE_API_KEY=<Meta Model API key>
# Optional: blank means on when a key exists; set false to disable.
MODEL_ENABLED=
# Optional: in-memory request cap; defaults to 1000.
MODEL_MAX_REQUESTS=1000
# Optional: same-origin requests are accepted automatically.
ALLOWED_ORIGINS=http://localhost:3000
```

Notes:

- `MUSE_API_KEY` is developer-only and server-side. Never expose it to the client and never prefix it with `NEXT_PUBLIC_`.
- Only `MUSE_API_KEY` is required. `MODEL_ENABLED` defaults to on when a key exists (set `false` to disable). `MODEL_MAX_REQUESTS` defaults to 1000; raise/lower it to bound spend. `MODEL_ENABLED` accepts `true`, `false`, or unset; any other value disables model calls.
- `ALLOWED_ORIGINS` is optional. A scan request is accepted when its `Origin` header exactly matches the request's own public origin, derived server-side from the request URL or from the proxy's `x-forwarded-host` / `host` headers (with `x-forwarded-proto`). Set `ALLOWED_ORIGINS` (comma-separated, exact origins) only to allow additional origins; it takes priority and is recommended when the deployment uses a custom domain or a proxy that rewrites host headers. Any other origin, or a request without an `Origin` header, returns 403. For local development the automatic origin is `http://localhost:3000`.
- `MUSE_MODEL` and `MUSE_API_URL` are optional overrides. If unset, the server defaults to model `muse-spark-1.2` and endpoint `https://api.meta.ai/v1/chat/completions`.

Start the dev server:

```sh
npm run dev
```

Then open `http://localhost:3000`.

### Getting a Meta Model API key

Go to [dev.meta.ai](https://dev.meta.ai) and create an API key in the Meta developer portal. Put that key in `MUSE_API_KEY` in `.env.local` (locally) or in the host's environment variables (deployed). Adding the key turns model calls on by default with a 1,000-request in-memory cap per process, so review the cost note below before setting it on a deployed site. Usage is subject to Meta's billing/credits terms.

## Usage

- **Camera scan:** requires a secure context — HTTPS, or `localhost` during local development — plus camera permission and the Meta-transmission opt-in. Sampling is bounded, with at most 10 model requests per client per 60 seconds and up to four model calls in flight per server process. If only an item or only a price is found, the app prompts for the missing value. Retry, upload, and manual entry remain available.
- **Upload:** choose one photo, give the Meta-transmission opt-in, then review and correct the candidates.
- **Manual entry:** no image, no model call, and no image consent required. OFF barcode lookup/search, where used, also needs no image consent.
- **Example:** labeled fixture content for judges or anyone without a camera. Judges without a camera can also use upload or manual entry instead.

In all flows, confirm the item, price, currency/quantity basis, and nutrition values before calculating. Correcting inputs recalculates the results.

## Privacy

- Submitted photos are sent to Meta for analysis only, after the explicit opt-in, and are not kept by the app. Meta's handling is under its own terms.
- The diary lives in `localStorage` in the user's browser and never reaches the server.

## Cost and safety controls

- The model route is on when `MUSE_API_KEY` is set. `MODEL_ENABLED=false` is a hard off; `MODEL_MAX_REQUESTS` defaults to 1000. Manual entry, OFF lookup, and the example work without the model.
- Limits are enforced in memory, per process and per client. Each client identity gets at most 10 model requests per 60-second window, the process admits at most 4 model calls in flight, and each admitted call has a 15-second lease. Exceeding the per-client window returns 429 `rate_limit`; reaching the concurrency cap returns 429 `concurrency_limit`. A client identity comes only from proxy-set headers: `x-nf-client-connection-ip` (Netlify), else the first `x-forwarded-for` entry, else one shared fallback bucket; malformed values fall back, and the raw value is kept only as an in-memory quota key (never logged or persisted).
- `MODEL_MAX_REQUESTS` is an in-memory, per-process request cap. Its counter resets when the process restarts and is not coordinated across processes, serverless instances, or hosts. **Netlify can run multiple instances; each has its own counter and limits, so the effective aggregate cap can exceed the configured number.** It is an abuse-reduction measure, **not a billing guarantee** and not a global spending cap; Meta's pricing and accounting determine actual charges.
- Keep `MODEL_MAX_REQUESTS` conservative against the $150 Meta API credit budget, and review current pricing before any live use. To stop new model calls, set `MODEL_ENABLED=false` (or remove `MUSE_API_KEY`) and restart/reconfigure the process; requests already in flight may finish. A change to `MODEL_MAX_REQUESTS` also requires a restart: until the process restarts, the changed cap is not applied and model calls fail closed rather than silently resetting the existing counter.

## Troubleshooting 503

If scanning returns 503, open `/api/health` on the deployed site first. It reports the effective model configuration without revealing the API key:

```json
{
  "ok": true,
  "data": {
    "model": {
      "enabled": false,
      "reasons": ["MUSE_API_KEY is missing"],
      "keyPresent": false,
      "enabledFlag": true,
      "cap": 1000,
      "model": "muse-spark-1.2",
      "endpointHost": "api.meta.ai"
    },
    "origins": { "configured": false }
  }
}
```

`reasons` lists each failing precondition: `MUSE_API_KEY` must be present; `MODEL_ENABLED` must be `true`, `false`, or unset (unset/empty means on when a key exists, `false` is a hard off); `MODEL_MAX_REQUESTS` must be a positive integer (unset or empty defaults to 1000); and `MUSE_API_URL` (if set) must be an `https:` URL. `keyPresent` only indicates whether a key exists; the key value, its length, and any prefix or hash are never returned. The endpoint is reduced to its hostname.

Set or correct the environment variables in the hosting provider's dashboard (not in a committed file). Netlify applies environment-variable changes only on a new deploy, so redeploy after changing them and check `/api/health` again.

## Verification

```sh
npm test
npm run typecheck
npm run build
```

These run the automated test suite (Vitest), the TypeScript check, and the Next.js production build.

**Unverified:** live Muse (Meta model) accuracy and latency, and real-phone camera behavior, have not been verified. They remain unverified until tested with a real API key, consented sample images, and a real device.

## Deployment

Deployment has not yet been performed.

When deploying to a host, only `MUSE_API_KEY` is required there. `MODEL_ENABLED` defaults to on when the key exists (set it to `false` to disable), and `MODEL_MAX_REQUESTS` defaults to 1000. `MUSE_MODEL` / `MUSE_API_URL` remain optional. The deployed app accepts same-origin scan requests automatically, so `ALLOWED_ORIGINS` is optional; set it to a comma-separated list of exact origins only when you must allow origins other than the site's own public origin (recommended for custom domains or proxies that rewrite host headers). Camera use on the public URL requires HTTPS.
