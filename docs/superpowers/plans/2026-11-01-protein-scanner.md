# Protein Scanner Implementation Plan

> **For implementers:** Review the revised spec and this plan before executing task-by-task. The ownership lanes may be delegated only if the user authorizes it. No commits are authorized.

**Goal:** Build a mobile-first hackathon prototype by November 4 with a consented, transient-image scanner, honest protein calculations, and a device-local diary.

**Architecture:** A Next.js web app calls same-origin server routes for Muse and Open Food Facts (OFF). Images are processed only in memory and sent to Meta after one explicit consent; deterministic nutrition code uses confirmed values. The diary is browser-local, and model request limits are in-memory and single-process.

**Tech Stack:** Next.js App Router, React, TypeScript, Node.js 22, npm, Vitest, jsdom and React Testing Library; Zod for untrusted schemas and Sharp for bounded image decoding/re-encoding. Pin compatible versions and create a lockfile during authorized implementation. No installation is performed by this plan.

**Spec:** [`docs/superpowers/specs/2026-11-01-protein-scanner-design.md`](../specs/2026-11-01-protein-scanner-design.md). The latest scope revision must be reviewed alongside this plan.

## Global Constraints

- No shared database, shared listings, ratings, price observations, or image persistence. Images, thumbnails and sampled frames are held transiently in memory only; never save them in browser persistence, application storage, logs, caches or temporary files. The diary is browser-local and contains no images or stored prices.
- Before any image upload or analysis, require one explicit, unselected consent to transmit images to Meta. Manual entry, OFF lookup and the labeled example need no consent. Explain Meta's separate processing/retention terms and that withdrawal cannot undo prior transmission.
- The developer supplies `MUSE_API_KEY` server-side in ignored `.env.local` locally and hosting environment variables for an approved deployment. The model stays off unless `MODEL_ENABLED=true` **and** a nonempty key is present. Neither belongs in client code or logs. Configuration is not spend authorization.
- Rate controls are per-client and per-process in-memory only: they reset on restart and do not coordinate across hosts, workers or serverless instances. They are not a guaranteed billing hard cap. The $150 Meta credit budget does not authorize spending. Separate approval is required for account/provider setup, live calls and charges, and deployment.
- Nutrition comes only from OFF, a visible label, or user input. Do not invent nutrition, prices, model capabilities, provider behavior or successful persistence. Fixture content is visibly labeled. Price and nutrition quantities must match; never assume mass equals volume; all denominators must be positive.
- Manual calculations, OFF lookup and diary remain available if the model is disabled, rate-limited or unavailable. Images and model output are untrusted; enforce input bounds, strict schemas and safe error messages. No retailer scraping, recommendation, analytics or speculative services.
- Local automated tests use injected mocks/fixtures; production uses real OFF/Muse adapters, never a fake fallback. No tests, public deployment, real-phone behavior, OCR accuracy, latency or provider charges are claimed by this document.

## Review Focus

1. Identical-looking serving/package quantities and g versus ml can yield plausible but wrong numbers — Task 2.
2. Withdrawing consent during an in-flight call must stop future sampling without claiming to retract an image already sent — Tasks 3 and 5.
3. Image bytes can leak through multipart handling, temporary files, logs, caches or persistent previews — Tasks 3, 5 and 7.
4. An in-memory limiter can reset or be bypassed across instances and must not be presented as a billing guarantee — Tasks 3 and 7.
5. Denied camera, local storage denial, model timeout or missing configuration must leave manual calculation usable and report the actual failure — Tasks 3, 5 and 6.

## Dependency graph, milestones and ownership

`Task 1 contracts/scaffold → {Task 2 nutrition/domain, Task 3 model route/limits} → Task 4 OFF route/composition → Task 5 scanner/review UI → Task 6 diary/search UI → Task 7 verification`.

Freeze Task 1 interfaces before dependent work. **Nutrition lane:** `src/domain/**`, `src/server/nutrition/**`, and matching tests (Task 2). **Model/integration lane:** `src/server/muse/**`, `src/server/http/**`, `src/server/limits/**`, `src/app/api/**`, `src/server/composition.ts`, and matching tests (Tasks 3–4). **UI lane:** `src/app/{layout.tsx,page.tsx,globals.css}`, `src/components/**`, `src/client/**`, and UI tests (Tasks 5–6); it waits for frozen contracts and route implementations. Task 1 exclusively owns `src/contracts/**`, tool configs and package files. Task 7 owns the final integration tests and task-relevant documentation. Do not edit the same file concurrently.

- **Milestone A:** deterministic manual nutrition and OFF fixtures pass (Tasks 1–2).
- **Milestone B:** in-memory model route and OFF integration pass with mocks; actual provider adapters exist (Tasks 3–4).
- **Milestone C:** camera and camera-free UI, local diary and search links pass local tests (Tasks 5–6).
- **Milestone D:** only after separate approvals, live provider, public HTTPS and real-phone checks (Task 7). Local mocks alone do not complete the public demo.

## Frozen cross-lane contracts

Task 1 defines these exported types in `src/contracts/types.ts` and runtime schemas in `src/contracts/schemas.ts`. Numeric fields are finite and nonnegative unless stated otherwise; `null` means unavailable, never zero.

- `Basis = {amount:number; unit:'g'|'kg'|'ml'|'l'|'serving'|'package'; count?:number}`. Amount is positive; `count`, when used, is a positive integer counting identical package units. Never multiply a count into a physical quantity already representing the total pack.
- `Source = {kind:'off'|'label'|'user'|'fixture'; label:string; url?:string; productId?:string; visibleText?:string}`. `Food = {id?:string; name:string; barcode?:string; source:Source; packageBasis:Basis|null; servingSize:Basis|null; servingsPerPackage:number|null}`. `packageBasis` is the priced package's total physical quantity and `servingSize` its physical amount per serving; conflicting or absent mappings cannot be converted.
- `Nutrition = {proteinG:number|null; energyKcal:number|null; basis:Basis; source:Source}`; `Price = {amount:number; currency:string; basis:Basis; source:'user'|'label'}`; `ConfirmedInput = {food:Food; nutrition:Nutrition|null; price:Price|null}`. Model-transcribed nutrition requires visible-text evidence and explicit confirmation; quoted text is not proof of correct OCR.
- `Metric = {value:number; unit:string} | {unavailable:string}`; `Calculation = {proteinPerCurrency:Metric; proteinPer100Kcal:Metric}`.
- `Candidate = {item:string|null; barcode:string|null; price:Price|null; labelNutrition:Nutrition|null; uncertainties:string[]}`; `ImageInput = {bytes:Uint8Array; mediaType:string}`; `AnalysisResult = {candidate:Candidate}`. Images are never included in the response.
- `DiaryEntry = {id:string; food:Food; nutrition:Nutrition|null; amount:Basis; date:string}`; no image or price field.
- Routes return `{ok:true,data:T}` or `{ok:false,error:{code:string,message:string}}`, without stack traces. Image POST requires allowed same-origin `Origin`, bounded multipart input, `metaConsent:'true'` and `Cache-Control: no-store`; public deployment rejects untrusted or missing origins. Tests configure their local origin explicitly.

## Task 1: Scaffold, contracts and test harness

**Files:** Create `package.json`, `package-lock.json`, `tsconfig.json`, `next.config.ts`, `vitest.config.ts`, `vitest.setup.ts`, `.gitignore`, `.env.example`, `src/contracts/types.ts`, `src/contracts/schemas.ts`, `tests/contracts.test.ts`.

**Interfaces:** Export the above contracts and Zod `parseCandidate(value:unknown):Candidate` and `parseConfirmedInput(value:unknown):ConfirmedInput`; invalid input throws a controlled validation error.

- [ ] Write `tests/contracts.test.ts`: null remains null; reject NaN/Infinity, negative protein, zero/negative price, unsupported units, invalid currency, zero basis amount, noninteger package count and malformed/extra model fields.
- [ ] During approved implementation, create minimal package/test configuration and install pinned dependencies; run `npm run test -- tests/contracts.test.ts` and expect failure because contracts do not exist. Implement types and strict schemas. `.env.example` contains only blank `MUSE_API_KEY`, `MODEL_ENABLED=false` and documented nonsecret limit settings; ignore `.env.local`.
- [ ] Run `npm run test -- tests/contracts.test.ts` and `npm run typecheck`; expect pass. Configure `test` = `vitest run`, `typecheck` = `tsc --noEmit`, `build` = `next build`, `dev` = `next dev`. Use Node test environment by default and jsdom for UI tests.

## Task 2: Deterministic nutrition and OFF lookup

**Files:** Create `src/domain/calculation.ts`, `src/domain/units.ts`, `src/server/nutrition/off.ts`, `tests/domain/calculation.test.ts`, `tests/server/off.test.ts`.

**Interfaces:** `calculate(input:ConfirmedInput):Calculation`; `convertBasis(amount:number,from:Basis,to:Basis,food:Food):number|null`; `lookupBarcode(code:string):Promise<Food[]>`, `searchFood(query:string):Promise<Food[]>`, `nutritionForFood(id:string):Promise<Nutrition|null>`. Inject OFF HTTP transport in tests.

- [ ] Write calculation tests: 200 g package, $4, 10 g protein/100 g, 100 kcal/100 g ⇒ `5 g/USD` and `10 g/100 kcal`; missing package mass ⇒ first unavailable, second 10; supported zero protein ⇒ zero; zero price/kcal, negative/NaN/infinite ⇒ invalid/unavailable. Test g↔kg, ml↔l, g↔ml rejection, known/missing multipack sizes, same-basis and mismatched-serving values, price/kg with matching weight and unsupported volume.
- [ ] Run `npm run test -- tests/domain/calculation.test.ts`; expect fail. Implement only compatible normalization and deterministic calculation; no currency conversion or automatic density assumptions. Display rounding belongs to UI.
- [ ] Write OFF tests: `energy-kcal_100g` maps to kcal/100 g; `energy_100g` kJ alone stays unavailable; missing nutrients stay null; no-match and timeout are explicit; results retain source URL and product ID and require UI confirmation. Run `npm run test -- tests/server/off.test.ts`; expect fail.
- [ ] Implement the injected OFF client using the documented barcode and search endpoints. Run both Task 2 test files and `npm run typecheck`; expect pass. Do not infer missing nutrition.

## Task 3: In-memory model admission and image route

**Files:** Create `src/server/muse/parse.ts`, `src/server/muse/client.ts`, `src/server/muse/image.ts`, `src/server/limits/memory.ts`, `src/server/http/image.ts`, `src/app/api/scan/analyze/route.ts`, `tests/server/muse.test.ts`, `tests/server/image.test.ts`, `tests/server/limits.test.ts`, `tests/integration/image-route.test.ts`.

**Interfaces:** `parseMuseResponse(raw:unknown):Candidate`; `MuseClient.analyze(image:ImageInput):Promise<Candidate>`; `sanitizeImage(input:ImageInput):Promise<ImageInput>`; `MemoryLimiter.admit(clientKey:string):{allowed:boolean;reason?:string;release?:()=>void}`. `POST /api/scan/analyze` accepts bounded multipart `{image,metaConsent:'true'}` and returns `AnalysisResult` in the common envelope. Inject model transport and limiter in tests; actual adapter uses server-only `MUSE_API_KEY`.

- [ ] Write parsing/image tests: reject bad/extra JSON, negative or unsupported values and missing visible-text evidence; uncertain fields are null. Reject malformed, MIME-mismatched, oversized and excessive-pixel images, and verify EXIF stripping for supported formats. Instructions embedded in image-derived text cannot change the schema or be treated as instructions. Run `npm run test -- tests/server/muse.test.ts tests/server/image.test.ts`; expect fail.
- [ ] Implement strict Muse parsing and an injected actual provider client. Verify the current Meta API/model contract before live wiring; no automatic retries or invented fields. Decode and re-encode JPEG/PNG/WebP in memory with initial limits of 5 MiB input and 20 megapixels; reject unsupported or failed sanitization rather than bypass it. Do not use filesystem-backed temporary files or log payloads.
- [ ] Write limiter/route tests: missing/false consent, `MODEL_ENABLED` not exactly `true`, or absent key ⇒ no Muse call; per-client window, per-process request count and concurrency exhaustion reject; timeout/error releases concurrency but does not refund an admitted count. A stop/disable blocks new calls but does not claim to cancel an already admitted call. Verify fake client forwarding headers cannot grant a trusted identity; when no trusted identity is available, use a conservative shared bucket. Run `npm run test -- tests/server/limits.test.ts tests/integration/image-route.test.ts`; expect fail.
- [ ] Implement in-memory admission with configured per-client window, per-process request count and concurrency; never claim cross-process coordination. Bound streaming input before decoding instead of trusting Content-Length, reject invalid origins/content types, limit response size and model timeout, and set `no-store`. Return only candidate fields, not images. A process restart resets counters; describe this in operator documentation. Rerun all four Task 3 tests and `npm run typecheck`; expect pass.

## Task 4: OFF route and server composition

**Files:** Create `src/server/composition.ts`, `src/app/api/foods/lookup/route.ts`, `src/app/api/foods/search/route.ts`, `tests/integration/composition.test.ts`, `tests/integration/lookup-routes.test.ts`.

**Interfaces:** `createProductionServices(env:NodeJS.ProcessEnv):Services` uses actual OFF/Muse adapters and an in-memory limiter; GET lookup `?barcode=` and search `?q=` expose OFF candidates and nutrition basis/source. Test composition accepts injected mocks explicitly and is never a runtime fallback.

- [ ] Test absent key or disabled flag ⇒ model unavailable without network call, while OFF/manual paths still work. Test OFF barcode/search success, no match, timeout and attribution; invalid requests return safe errors. Assert no private key reaches client-facing responses.
- [ ] Run `npm run test -- tests/integration/composition.test.ts tests/integration/lookup-routes.test.ts`; expect fail. Implement lazy server-only composition and route wiring; `MUSE_API_KEY` never receives a `NEXT_PUBLIC_` prefix. Rerun those tests and `npm run test -- tests/integration/image-route.test.ts`; expect pass. A mock pass is not live-provider verification.

## Task 5: Mobile scanner, review and manual calculations

**Files:** Create `src/app/layout.tsx`, `src/app/page.tsx`, `src/app/globals.css`, `src/components/Consent.tsx`, `src/components/Scanner.tsx`, `src/components/Review.tsx`, `src/components/Results.tsx`, `src/client/scanner.ts`, `src/client/api.ts`, `tests/ui/scanner.test.tsx`, `tests/ui/review.test.tsx`.

**Interfaces:** `startScan(metaConsent:true,deps:ScannerDeps):Promise<void>` and `stopScan():void`; scanner dependencies inject camera, timer and transport. `Review` produces `ConfirmedInput`; `Results` consumes `Calculation` from Task 2. UI API calls follow Tasks 3–4.

- [ ] Write fake-camera/timer tests: opt-in is unselected; no frames sent without consent; camera denial/insecure context offers upload/manual; at most one analysis is in flight and no frames queue; both detected ⇒ sampling stops and review opens; one detected ⇒ prompt for missing value; no result ⇒ bounded next sample; withdrawal stops tracks/timers and no new requests. A previously transmitted image is not represented as retracted. Model timeout/disabled/limited states offer manual entry.
- [ ] Run `npm run test -- tests/ui/scanner.test.tsx tests/ui/review.test.tsx`; expect fail. Implement mobile-first semantic controls, visible keyboard focus and status/errors. Re-encode supported browser images before submission to strip metadata; if unsupported or sanitization fails, show a clear manual fallback. Keep selected preview only in memory and release object URLs and buffers after use. Never persist frames or image data.
- [ ] Test review can reject wrong OFF match, edit all candidate fields including currency/quantity/source, enter food/nutrition/price manually, show missing metrics and recompute after edits; explicit confirmation precedes results. Ensure source, label uncertainty, units and Meta disclosure are visible. The example is labeled and makes no live request. Rerun both UI tests and `npm run typecheck`; expect pass.

## Task 6: Device-local diary and search links

**Files:** Create `src/components/Diary.tsx`, `src/client/diary.ts`, `tests/ui/diary.test.tsx`, `tests/ui/search-link.test.tsx`; modify only UI-owned `src/app/page.tsx` after Task 5.

**Interfaces:** `saveEntry(entry:DiaryEntry):Promise<void>`, `listEntries():Promise<DiaryEntry[]>`, `removeEntry(id:string):Promise<void>`, `marketplaceSearchUrl(confirmedName:string):string`. The search URL includes only the encoded confirmed product name, never a price.

- [ ] Write tests: confirmed food/compatible amount persists across reload in original browser; local storage denial is visible and manual calculations remain usable; totals omit unknown values and mark incomplete; removal affects only a local entry. Inspect the stored entry to assert it contains no image or price. A search link is labeled as a search, properly encoded, and displays/stores no retailer price.
- [ ] Run `npm run test -- tests/ui/diary.test.tsx tests/ui/search-link.test.tsx`; expect fail. Implement local-only diary, incomplete totals, explicit add/remove actions and optional marketplace search link. Disclose browser clearing/device changes can lose entries; do not imply synchronization.
- [ ] Rerun both UI test files and `npm run test`, `npm run typecheck`, `npm run build`; expect pass. Check keyboard access and small-screen layout.

## Task 7: Verification, disclosure and approval-gated demo

**Files:** Create `README.md`, `tests/integration/local-flow.test.ts`; update only task-relevant documentation. No commits.

- [ ] Write local-flow tests using explicit mocks: manual → confirm → calculations → diary; sample item+price → review → corrected results; one missing → prompt; upload → model error → manual fallback. Assert fixture data stays labeled, no secrets/images in captured logs, no image writes to app/browser persistence or caches, and no real network calls. Run `npm run test -- tests/integration/local-flow.test.ts`; expect pass after prior tasks are integrated; investigate any failure.
- [ ] Run `npm run test`, `npm run typecheck`, and `npm run build`; record actual outputs. Inspect client bundles for accidental keys and image-handling code/logs for persistence or leakage. Verify per-process limiter behavior, restart reset and multi-instance limitation are honestly documented, not falsely tested as a global limit.
- [ ] Document local setup: developer places `MUSE_API_KEY` and `MODEL_ENABLED=true` in ignored `.env.local` only after spend approval; deployment uses server-side hosting environment variables. Document model-disabled/manual flow, Meta transmission notice, no app image storage, local diary limitations, test mocks, single-process rate-limit reset and lack of billing guarantee. Never print or include an actual key. Explain that toggling configuration blocks new calls only after the process picks up the change; in-flight calls may finish.
- [ ] **Approval gate — live model:** separately ask before provider account setup, using a supplied key, live Meta calls or incurring charges. After approval, choose conservative limits based on current pricing, use a small consented image set and record request count, observable cost, detection/OCR errors, schema behavior and measured latency. Do not claim a provider billing cap or guaranteed latency.
- [ ] **Approval gate — deployment:** separately ask before public hosting/deployment and associated charges. Once approved, configure HTTPS and server-side environment variables, then test on a real phone: camera consent/permission, bounded sampling, correction, missing-item/price recovery and manual fallback. In a camera-free browser exercise upload and labeled example; verify OFF attribution, local diary, search links and failure recovery. Record results and unresolved gaps; if blocked, mark public demonstration incomplete.

## Acceptance coverage map

| Revised spec criterion | Tasks / evidence |
|---|---|
| 1. Phone scan, auto-select/prompt and correction | 2–5; real phone in 7 |
| 2. Camera-free upload/example/manual and failure fallback | 3–6; camera-free check in 7 |
| 3. Attributable nutrition, matching quantities and valid denominators | 1–2, 4–5; calculation and provenance tests |
| 4. Local diary and honest search links | 5–7; local persistence and link tests |
| 5. One consent, transient images, server key and process limits | 3–5, 7; privacy/config/limiter tests |
| 6. Public HTTPS demo only after authorization | 7 deployment gate and real-device evidence |

## Reference checks for implementation

- Next.js route handlers and server-only environment variables: https://nextjs.org/docs/app/guides/backend-for-frontend and https://nextjs.org/docs/app/guides/environment-variables .
- Verify OFF barcode/data semantics and Meta request schema against current official documentation and configured provider version before live use; no specific OCR accuracy or response latency is assumed.
