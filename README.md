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
MODEL_ENABLED=true
MODEL_MAX_REQUESTS=200
ALLOWED_ORIGINS=http://localhost:3000
```

Notes:

- `MUSE_API_KEY` is developer-only and server-side. Never expose it to the client and never prefix it with `NEXT_PUBLIC_`.
- `MODEL_ENABLED` must be `true` and `MUSE_API_KEY` must be set for model calls to be enabled. A valid `MODEL_MAX_REQUESTS` greater than 0 is also required by the server configuration.
- `ALLOWED_ORIGINS` must exactly match the app origin, or scan requests return 403. For local development that is `http://localhost:3000`.
- `MUSE_MODEL` and `MUSE_API_URL` are optional overrides. If unset, the server defaults to model `muse-spark-1.2` and endpoint `https://api.meta.ai/v1/chat/completions`.

Start the dev server:

```sh
npm run dev
```

Then open `http://localhost:3000`.

### Getting a Meta Model API key

Go to [dev.meta.ai](https://dev.meta.ai) and create an API key in the Meta developer portal. Put that key in `MUSE_API_KEY` in `.env.local` (locally) or in the host's environment variables (deployed). Usage is subject to Meta's billing/credits terms; see the cost note below before enabling the model.

## Usage

- **Camera scan:** requires a secure context — HTTPS, or `localhost` during local development — plus camera permission and the Meta-transmission opt-in. Sampling is bounded, with at most one model request in flight per client. If only an item or only a price is found, the app prompts for the missing value. Retry, upload, and manual entry remain available.
- **Upload:** choose one photo, give the Meta-transmission opt-in, then review and correct the candidates.
- **Manual entry:** no image, no model call, and no image consent required. OFF barcode lookup/search, where used, also needs no image consent.
- **Example:** labeled fixture content for judges or anyone without a camera. Judges without a camera can also use upload or manual entry instead.

In all flows, confirm the item, price, currency/quantity basis, and nutrition values before calculating. Correcting inputs recalculates the results.

## Privacy

- Submitted photos are sent to Meta for analysis only, after the explicit opt-in, and are not kept by the app. Meta's handling is under its own terms.
- The diary lives in `localStorage` in the user's browser and never reaches the server.

## Cost and safety controls

- The model route stays off unless `MODEL_ENABLED=true` and `MUSE_API_KEY` is set (with a valid request cap configured). Manual entry, OFF lookup, and the example work without the model.
- `MODEL_MAX_REQUESTS` is an in-memory, per-process request cap. Its counter resets when the process restarts and is not coordinated across processes, serverless instances, or hosts. It is an abuse-reduction measure, **not a billing guarantee** and not a global spending cap; Meta's pricing and accounting determine actual charges.
- Keep `MODEL_MAX_REQUESTS` conservative against the $150 Meta API credit budget, and review current pricing before any live use. To stop new model calls, set `MODEL_ENABLED` to a value other than `true` and restart/reconfigure the process; requests already in flight may finish.

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

When deploying to a host, set the same environment variables there (`MUSE_API_KEY`, `MODEL_ENABLED`, `MODEL_MAX_REQUESTS`, and optionally `MUSE_MODEL` / `MUSE_API_URL`), and set `ALLOWED_ORIGINS` to exactly match the public HTTPS origin of the deployed app. Camera use on the public URL requires HTTPS.
