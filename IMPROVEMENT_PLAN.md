# IMPROVEMENT_PLAN.md — BRODSKY (Code Audit + Research + Roadmap)

## Executive Summary
BRODSKY is a single-node Express + Prisma + PostgreSQL web app that serves static HTML pages (guest menu + staff/manager dashboards) and exposes a JSON API with YooKassa payments, shift close/finalize reporting, reservations, and a cancellation/refund workflow. The core functional flows exist and are reasonably integrated end-to-end, but the current codebase has **critical security/access-control gaps**, **high duplication** across pages, and **operational risks** (shift finalization deletes all data and is not robustly protected). The PWA layer provides a basic offline shell, but its update strategy and caching scope do not match common 2026 guidance.

This document contains:
- A full code audit (backend, frontend, DB schema, PWA, deploy config)
- 2026 best-practice research findings (POS/KDS UI, PWA updates, YooKassa, RU fiscal requirements)
- A gap analysis (what exists vs industry standard)
- A prioritized improvement plan with files, approach, effort, and test strategy

---

## PHASE 1 — Code Audit Results (what exists)

### 1) Backend audit (`server/server.js`, `server/cancellation-routes.js`, `server/env.js`, `server/mail.js`)

#### Middleware stack (order)
From [`e:/pro vkr/server/server.js`](e:/pro%20vkr/server/server.js):
- `helmet(...)`
- global `express-rate-limit`
- `cors({ origin: allowlist, credentials: true })`
- `express.json({ limit: '100kb' })`
- `express-session` with Postgres store (`connect-pg-simple`)
- `csurf` (`csrfProtection`) applied **per route** (not global)
- routes
- (late) request logger middleware (note: routes defined before it won’t be logged)
- `express.static(PUBLIC_DIR)` + `/uploads` static
- CSRF error handler (`403`)
- global error handler (`500`)

#### Session management
- Cookie session: name `brodsky.sid`, `httpOnly`, `sameSite: 'lax'`, `secure` controlled by env, `maxAge` 14 days.
- Session store: Postgres table `session` (auto-created if missing).
- `saveUninitialized: true` creates sessions for anonymous visitors (operational + security trade-offs).

#### CSRF implementation
- `GET /api/csrf` returns a token (session-bound CSRF model).
- State-changing endpoints require header `X-CSRF-Token`.
- Dedicated CSRF error handler responds `403 { success:false, error:'CSRF token invalid or missing' }`.

#### API endpoints (routes)
From [`e:/pro vkr/server/server.js`](e:/pro%20vkr/server/server.js) and [`e:/pro vkr/server/cancellation-routes.js`](e:/pro%20vkr/server/cancellation-routes.js):

**CSRF/Health**
- `GET /api/csrf`
- `GET /health`
- `GET /api/health`

**Products**
- `GET /api/products` (public; non-archived; `?archived=true` requires Manager)
- `GET /api/products/availability` (public)
- `PATCH /api/products/:id/availability` (CSRF, Manager)
- `POST /api/products` (CSRF, Manager)
- `PUT /api/products/:id` (CSRF, Manager)
- `DELETE /api/products/:id` (CSRF, Manager — soft archive)
- `POST /api/products/:id/restore` (CSRF, Manager)
- `GET /api/analytics/sales?from=&to=` (Manager; revenue/count for New/InProgress/Done orders)

**Auth**
- `POST /api/auth/register`
- `POST /api/auth/login`
- `GET /api/auth/me` (requires session)
- `POST /api/auth/logout` (CSRF)

**Orders**
- `POST /api/orders` (CSRF)
- `GET /api/orders`
- `PATCH /api/orders/:orderId` (CSRF)
- `GET /api/orders/shift-summary`
- `POST /api/orders/shift-close`
- `POST /api/orders/shift-finalize`
- `GET /api/shift-reports`
- `POST /api/orders/:id/notify-ready` (CSRF; requires role Staff/Manager)
- `GET /api/me/order-ready-events` (SSE; requires session)
- `GET /api/me/orders` (requires session)

**Payments (YooKassa)**
- `POST /api/payments/yookassa/create` (CSRF)
- `GET /payment/yookassa/return`
- `POST /api/payments/yookassa/webhook` (server-to-server; IP allowlist)

**Reservations**
- `POST /api/reservations` (CSRF)
- `GET /api/reservations`
- `PATCH /api/reservations/:reservationId` (CSRF)

**Cancellations**
- `POST /api/orders/:id/cancel` (CSRF + multipart; requires session + order ownership)
- `POST /api/orders/:id/cancel-proof` (CSRF + multipart; requires session + order ownership)
- `GET /api/cancellations/pending` (CSRF not required)
- `POST /api/cancellations/:orderId/approve` (CSRF)
- `POST /api/cancellations/:orderId/reject` (CSRF)

#### Database models used (Prisma)
From `server.js` + `cancellation-routes.js` and [`e:/pro vkr/prisma/schema.prisma`](e:/pro%20vkr/prisma/schema.prisma):
- `User`, `Product`, `Order`, `OrderItem`, `Payment`, `WebhookEvent`, `Reservation`, `ShiftReport`, `Settings`

#### YooKassa integration flow
- Create order first (`POST /api/orders`) with status `PendingPayment`.
- Create YooKassa payment (`POST /api/payments/yookassa/create`) using idempotence key; store `providerPaymentId` + `confirmationUrl` in `Payment`.
- Return URL (`GET /payment/yookassa/return`) verifies payment via YooKassa API and updates `Order`/`Payment`.
- Webhook (`POST /api/payments/yookassa/webhook`) checks source IP prefixes, dedupes events into `WebhookEvent`, verifies payment status server-side, updates DB, returns 200.

#### Shift management logic
- `GET /api/orders/shift-summary`: aggregates orders between `from..to`.
- `POST /api/orders/shift-close`: stores a `ShiftReport` and returns a `finalizeToken`.
- `POST /api/orders/shift-finalize`: transactionally deletes **all** Orders/OrderItems/Payments/WebhookEvents/Reservations and marks report finalized; also attempts to delete session rows.

#### Cancellation/refund flow
- Customer requests cancellation with reason, optional description, optional proof file (required for some reasons); order stores cancel metadata and an auto-approve deadline.
- Manager approves/rejects; approval triggers YooKassa refund when payment succeeded; auto-approve timer runs every minute.
- `cancellation-routes.js` contains a `loadManager()` helper but (as implemented) manager endpoints are not consistently role-gated.

#### Error handling patterns
- Consistent `try/catch` with JSON `{ success:false, error:'...' }`.
- CSRF errors centralized.
- Webhook always returns 200 to avoid provider retries.

#### High-risk issues identified (backend)
1. **Access control gaps**: multiple “staff/manager” actions appear unauthenticated at the API level (CSRF alone is not sufficient as authorization). This is the single highest priority gap.
2. **Shift finalize risk**: destructive endpoint is protected by a token returned by `shift-close`. Without strong auth/role checks, this is vulnerable.
3. **Late request logger**: placed after many routes; observability gap.
4. **`saveUninitialized: true`**: unnecessary sessions for anonymous users; increases CSRF/session surface area and DB load.
5. **Stop-list matching by normalized names**: OK for small menus but error-prone at scale; better to use product IDs.

---

### 2) Frontend audit (HTML + JS + CSS)

#### Files
- Pages: [`e:/pro vkr/index.html`](e:/pro%20vkr/index.html), [`staff-orders.html`](e:/pro%20vkr/staff-orders.html), [`manager.html`](e:/pro%20vkr/manager.html), [`my-orders.html`](e:/pro%20vkr/my-orders.html), [`cancellations.html`](e:/pro%20vkr/cancellations.html)
- Scripts: [`script.js`](e:/pro%20vkr/script.js), [`toast.js`](e:/pro%20vkr/toast.js), [`pwa.js`](e:/pro%20vkr/pwa.js), [`order-ready.js`](e:/pro%20vkr/order-ready.js)
- Styles: [`style.css`](e:/pro%20vkr/style.css)

#### Structure and responsibilities
- `index.html` + `script.js` implement: auth overlay (register/login/guest), product list + search + categories, product modal, cart drawer, checkout modal, reservation modal, payment initiation and redirect to YooKassa.
- `staff-orders.html` is an inline-JS dashboard: orders + reservations tabs, shift start/end, shift summary + destructive finalize, printing flow, sound alerts.
- `manager.html` is an inline-JS dashboard: stats, sales chart, shift reports, orders + reservations, and product management (modal create/edit, ingredients, archive/restore, stop-list).
- `my-orders.html` is an inline-JS customer page: list own orders + request cancellation + upload proof.
- `cancellations.html` is an inline-JS queue: approve/reject cancellations, view proof, “no access” panel.

#### API calls made
See “Backend audit” endpoints; frontend calls align to:
- Auth endpoints from `index.html` + `script.js` and `my-orders.html`.
- Orders/reservations from staff/manager dashboards.
- Cancellation endpoints from `my-orders.html` and `cancellations.html`.
- CSRF token fetched and used on state-changing requests across pages.

#### UX issues identified (frontend)
1. **Large inline scripts** in 4 pages cause duplication and slow iteration; shared utilities would reduce risk.
2. **Shift finalize UX** is dangerous: destructive action exposed in normal staff UI; requires stronger safeguards and clearer flow.
3. **Price parsing ambiguity**: some prices may contain multiple numbers (e.g., “230/260₽”), but parsing can pick the first number and mischarge.
4. **Availability matching by name**: can show wrong availability if names share prefixes.
5. **Order-ready SSE**: relies on same-origin cookies; will break if API is moved to another origin without redesign.

#### CSS audit (`style.css`)
- Token-based architecture with `:root` variables, consistent radii/shadows, and responsive breakpoints at 768/640/480.
- Strong componentization for modals, cards, menu grids, cart/checkout, auth overlay.
- Accessibility gaps: inconsistent `:focus-visible` across interactive controls; reduced-motion handling is partial.

---

### 3) Database audit (`prisma/schema.prisma` + migrations)
From [`e:/pro vkr/prisma/schema.prisma`](e:/pro%20vkr/prisma/schema.prisma):
- Enums: roles, order/payment/reservation statuses, cancellation reason/status.
- Core models: `User`, `Order`, `OrderItem`, `Product`, `Payment`, `WebhookEvent`, `Reservation`, `ShiftReport`, `Settings`.

Key gaps:
- **No indexes** on common filters: `Order.userId`, `Order.createdAt`, `Order.status`; likely needed for “My orders” and back-office queues.
- **Money precision not explicit**: recommend explicit DB decimal scale for RUB amounts.
- `OrderItem` does not link to `Product` (`productId` absent). This is OK for historical snapshots but limits analytics.

---

### 4) PWA & Infrastructure audit (`sw.js`, `manifest.json`, `pwa.js`, `render.yaml`)

#### Service Worker (`sw.js`)
- Precache static list, versioned caches.
- Runtime caching: `networkFirst` for `GET /api/products` and `/api/products/availability`.
- Navigation offline fallback always serves cached `/index.html`.
- Update strategy: `skipWaiting` + `clients.claim` without any user-facing update prompt.

#### Manifest (`manifest.json`)
- Basic manifest: name, scope, start_url, standalone, theme/background colors.
- Icons are SVG only (often insufficient for install surfaces; missing maskable PNGs).

#### Deploy (`render.yaml`)
From [`e:/pro vkr/render.yaml`](e:/pro%20vkr/render.yaml):
- Node 20, Prisma migrate deploy + generate at build, health check `/health`.
- Placeholder secrets in config (should be set in Render dashboard).
- Render free tier can sleep; first request after sleep is slow (affects staff dashboards).

---

## PHASE 2 — Research Findings (best practices, 2026)

### 1) Restaurant POS / KDS UI patterns
Industry KDS guidance emphasizes:
- **Station-oriented queues** (prep vs expo) and **bump workflows** (mark in-progress/done with a bump bar or tap).
- **Age timers + color escalation** for tickets to enforce throughput and SLA expectations.
- **All-day counts** for batching high-volume items.

Sources:
- Toast platform guide (KDS expo concepts): `https://doc.toasttab.com/doc/platformguide/adminUsingExpo.html`
- General KDS best practices: `https://kwickos.com/blog/kitchen-display-system-guide.html`

### 2) PWA update strategy and SW lifecycle
Common guidance is to **avoid silent takeover** updates for multi-tab correctness. Preferred pattern:
- Detect “waiting” SW
- Prompt user
- Activate on user action (message to SW to `skipWaiting`)
- Reload after `controllerchange`

Sources:
- Workbox update guidance: `https://developer.chrome.com/docs/workbox/handling-service-worker-updates`
- web.dev PWA update module: `https://web.dev/learn/pwa/update`

### 3) YooKassa integration practices
Key practices:
- Use **idempotence keys** for payment/refund creation.
- For webhooks: confirm receipt with `200`, consider IP filtering, and (defense-in-depth) verify payment state via API.

Sources:
- YooKassa webhooks docs: `https://yookassa.ru/developers/using-api/webhooks`
- YooKassa response handling recommendations: `https://yookassa.ru/developers/using-api/response-handling/recommendations`

### 4) Russia fiscal receipts (KKT / FFD)
Changes effective since 2025 impact online receipts and metadata requirements (e.g., internet payment markers, contact data). Exact applicability depends on product categories (marked goods) and business obligations, but the direction is clear: **internet payments require correct receipt metadata and customer contact capture**.

Representative sources (overview articles; validate with official/OFД guidance for final requirements):
- e-ОФД overview: `https://e-ofd.ru/blog/ffd-1-2-i-novye-trebovaniya-s-1-sentyabrya-2025-chto-vazhno-znat/`
- KKT changes 2026 overview: `https://action-market.ru/blog/buhgalteriya/izmeneniya-kkt-v-2026-godu-chto-nuzhno-znat-biznesu/`

### 5) Express/Node security practices
Still relevant in 2026:
- Strong authentication/authorization boundaries (role checks)
- Harden sessions/cookies, avoid unnecessary sessions
- Correct CORS allowlist, rate limiting for auth endpoints, and strict input validation

Sources:
- Express security best practices: `https://expressjs.com/en/advanced/best-practice-security.html`

---

## PHASE 3 — Gap Analysis (Exists vs Should Exist)

| Feature | Current state | Industry standard | Gap |
|---|---|---|---|
| Authorization by role | Partial/inconsistent; some admin actions rely only on CSRF | Role-gated endpoints (Staff/Manager) + audited access | High: security + business risk |
| Shift close/finalize safety | Finalize deletes core tables; token is returned by shift-close | Two-person confirmation, manager-only, immutable reports, soft-delete or archival | High: data loss + abuse risk |
| Order queue UX (staff) | Basic cards, manual refresh, sound alerts | KDS: timers, color escalation, bump/expedite workflows, station filters | Medium: throughput + clarity |
| Observability | Late logger, limited structured logs | Consistent request logging + correlation IDs + audit logs for money/refunds | Medium |
| PWA updates | skipWaiting + claim; no prompt | User-prompted update, controlled activation, offline fallback page | Medium |
| Offline support | Offline shell + cached products only | Clear offline states per page, cache scope control, update hygiene | Medium |
| DB indexing | Missing indexes on core query patterns | Index on user/time/status; explicit decimal scales | Medium |
| Frontend architecture | Large inline scripts with duplication | Shared modules/utilities, minimal duplication, testability | Medium |
| Price correctness | Potential ambiguous parsing | Product ID + explicit price field + server validation | High: financial correctness |

---

## PHASE 4 — Prioritized Improvement Plan (Tier 1–4)

### Tier 1 — Critical Fixes (must have)
1) **Enforce authorization boundaries (Staff/Manager)**
- **Description**: Ensure only Staff/Manager can access staff dashboards and perform state changes; only Manager can approve/reject cancellations, manage products, and finalize shifts.
- **Files**: [`server/server.js`](e:/pro%20vkr/server/server.js), [`server/cancellation-routes.js`](e:/pro%20vkr/server/cancellation-routes.js), affected HTML dashboards.
- **Approach**: Add reusable middleware `requireAuth`, `requireRole(['Staff','Manager'])`, `requireRole(['Manager'])`. Keep CSRF for browser cookie flows; add Origin/Referer checks for extra defense. Add explicit auth gates to `shift-close`, `shift-finalize`, cancellation approve/reject, reservations admin updates, product mutations, and order status changes.
- **Effort**: 6–10h
- **Test**: Manual role matrix + automated smoke tests (curl/fetch) verifying 401/403; regression for guest menu and payment flow.

2) **Make shift finalization safe**
- **Description**: Prevent accidental/hostile deletion; make reports immutable and make finalize manager-only, rate-limited, and auditable.
- **Files**: `server/server.js`, `staff-orders.html`, `manager.html`, Prisma migrations if schema changes.
- **Approach**: Replace “delete all” with archival or bounded cleanup; require manager confirmation, possibly second factor (time-limited admin token), and remove finalize UI from staff by default.
- **Effort**: 8–16h (depends on archival design)
- **Test**: Close shift, verify report visibility; verify data retention rules; verify finalize cannot be called without manager role.

3) **Financial correctness: server-side validation of totals**
- **Description**: Prevent mismatched totals and ambiguous price parsing from UI.
- **Files**: `server/server.js`, `script.js`, schema/migrations if moving to productId-based ordering.
- **Approach**: Send product IDs + qty; compute totals on server from `Product.price` snapshot; store snapshot in `OrderItem`.
- **Effort**: 8–14h
- **Test**: Orders with edge-case price strings; compare client total vs server total; YooKassa amount matches.

### Tier 2 — UX Improvements (should have)
1) **Staff KDS-inspired queue UX**
- **Files**: `staff-orders.html` (and shared UI utilities if extracted)
- **Approach**: Ticket age timer, color escalation, “in progress” state, station filters (drinks/food), all-day counts, bump-to-next workflow.
- **Effort**: 10–20h
- **Test**: Rush simulation, mobile/tablet ergonomics, accessibility checks.

2) **Consistent navigation + role-based nav visibility**
- **Files**: all HTML pages + `style.css`
- **Approach**: Single nav component; hide manager-only links when not authorized; avoid cross-role leakage.
- **Effort**: 3–6h
- **Test**: Role-based UI snapshot checks.

3) **Unified frontend utilities**
- **Files**: extract shared JS module(s) used by staff/manager/my-orders/cancellations
- **Approach**: centralize CSRF helper, fetch wrapper, escapeHtml, date formatting, status labels.
- **Effort**: 6–12h
- **Test**: Regression across all pages.

### Tier 3 — Feature additions (nice to have)
1) **Operational analytics**
- **Description**: daily revenue, top items, cancellations rate, average prep time.
- **Files**: Prisma schema (optional), `manager.html`, new API endpoints.
- **Effort**: 12–24h
- **Test**: Report accuracy with seeded data.

2) **Inventory & stop-list automation**
- **Description**: stock counts, auto stop-list when out-of-stock.
- **Effort**: 20–40h

3) **Push notifications**
- **Description**: order ready notifications beyond SSE (requires VAPID, user consent, push service).
- **Effort**: 20–35h

### Tier 4 — Polish (future)
- Visual micro-interactions, improved focus styles, reduced-motion support across animations
- Multi-language (if desired), theming/white-label via `Settings`
- Better offline fallback pages and “update available” prompt

---

## Implementation Roadmap (recommended order)
1. Authorization + role gates (server first, then UI)
2. Shift finalize hardening (remove from staff UI, manager-only + audit)
3. Order integrity (server totals, productId-based line items)
4. KDS UX upgrades (timers, bump flows, station filters)
5. DB indexes + decimal scale hardening
6. PWA update prompt + refined caching policy
7. Analytics + inventory features

---

## Appendix — Render free tier feasibility
- Expect cold starts; dashboards should tolerate the first request being slow.
- Prefer low-frequency polling + optimistic UI for staff/manager pages.
- Avoid heavy background tasks; keep cron-like timers (auto-approve) lightweight and idempotent.

