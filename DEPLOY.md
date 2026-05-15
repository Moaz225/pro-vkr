# BRODSKY — Deploy to Render.com (Node.js + Express + PostgreSQL + Prisma)

This guide describes how to deploy the **BRODSKY** project to Render.com using the included Blueprint file: `render.yaml`.

## 1) Prerequisites

1. **GitHub account** and a Git repository for this project.
2. **Render account**.
3. **PostgreSQL** on Render (created automatically by the Blueprint).
4. **YooKassa account** (test or live shop) and credentials:
   - `YOOKASSA_SHOP_ID`
   - `YOOKASSA_SECRET_KEY`

## 2) Push the project to GitHub

1. Create a new GitHub repository.
2. Push your local project to GitHub (branch `master` is used for auto-deploy in `render.yaml`).

## 3) One‑click deploy using the Blueprint (`render.yaml`)

1. In Render Dashboard, choose **New** → **Blueprint**.
2. Connect your GitHub account and select the BRODSKY repository.
3. Render will detect `render.yaml` and show the resources it will create:
   - Web service: **`brodsky-web`**
   - PostgreSQL database: **`brodsky-db`**
4. Click **Apply** / **Deploy**.

### What Render runs during build

The Blueprint build command is:

- `npm install && npx prisma migrate deploy --schema prisma/schema.prisma && npx prisma generate --schema prisma/schema.prisma`

This ensures database migrations are applied and Prisma Client is generated during deployment.

After deploy, clients pick up static updates via the service worker cache version (`sw.js` `VERSION`, currently `v6`). Hard-refresh once if the manager UI or menu looks stale.

## 4) Configure environment variables in Render

The Blueprint defines placeholders, but you must set real secrets in Render.

In Render Dashboard → your service → **Environment**:

- **DATABASE_URL**: is set automatically from the Render PostgreSQL resource.
- **SESSION_SECRET**: set a strong random string (>= 32 chars).
- **CSRF_SECRET**: reserved for future use (current implementation uses session-based CSRF).
- **YOOKASSA_SHOP_ID**: from YooKassa.
- **YOOKASSA_SECRET_KEY**: from YooKassa.
- **PUBLIC_BASE_URL**: `https://<your-service>.onrender.com`
- **CORS_ORIGIN**: usually the same as `PUBLIC_BASE_URL` (or a comma-separated allowlist).
- **NODE_ENV**: `production`
- **TRUST_PROXY**: `1` (recommended on Render)
- **COOKIE_SECURE**: `1`

**`PUBLIC_BASE_URL`** must match your live site (HTTPS). It is used for YooKassa return URLs and for **links to cancellation proof files** in outbound email; wrong values break redirects and broken proof links in messages.

**Email (optional):** cancellation workflow can send mail via Nodemailer. If you skip SMTP, the app still runs but logs that mail was skipped. To enable, set in Render **Environment** (see root `.env.example` for descriptions):

- `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE` (`0` or `1`)
- `SMTP_USER`, `SMTP_PASS` (if required by your provider)
- `MAIL_FROM` (required together with `SMTP_HOST` for sending)
- `MAIL_TO_MANAGER` (optional; notifications for new cancellation requests)

After changes, click **Save Changes** (Render redeploys).

## 5) Verify the deployment

1. **Health check**
   - Open `https://<your-service>.onrender.com/health`
   - Expected JSON:
     - `{ "status": "ok", "timestamp": "..." }`

2. **Open the app**
   - `https://<your-service>.onrender.com/`

3. **Test authentication**
   - Register/login and confirm the session works (cookies).

4. **Test order flow**
   - Create an order from the guest menu.
   - Create a payment.
   - Confirm redirect to YooKassa works.

## 6) Configure YooKassa webhook URL (production)

In YooKassa settings, set webhook URL to:

- `https://<your-service>.onrender.com/api/payments/yookassa/webhook`

Important notes:
- The webhook endpoint is **server-to-server**. It must remain reachable publicly over HTTPS.
- The app builds `return_url` using `PUBLIC_BASE_URL` (see `server/server.js` and `server/env.js`).

## 7) Prisma migrations (if something goes wrong)

Normally migrations run automatically during Render build.

If you see errors in Render logs (e.g., database connection / migration failures):
1. Confirm `DATABASE_URL` is set correctly in Render.
2. Check build logs for `prisma migrate deploy`.
3. If needed, redeploy after fixing env vars.

## 8) Troubleshooting

### Database connection errors
- Symptom: build fails or server crashes on startup with connection errors.
- Fix:
  - Ensure Render Postgres exists and `DATABASE_URL` is injected from it.
  - Ensure the database is in the same Render region (Blueprint handles this normally).

### CORS errors in browser
- Symptom: browser blocks API calls.
- Fix:
  - Set `CORS_ORIGIN` to the exact frontend origin.
  - In production, do **not** use `*` (disallowed by `server/env.js`).

### 502 Bad Gateway
- Symptom: Render returns 502.
- Fix:
  - Check Render service logs for crash reason.
  - Common causes: missing required env vars, Prisma client generation issues, DB unavailable.

### YooKassa webhook not received
- Fix:
  - Confirm the webhook URL is correct:
    - `/api/payments/yookassa/webhook`
  - Confirm `PUBLIC_BASE_URL` is https and matches your deployed domain.
  - Check server logs to see webhook requests.

## 9) Render Free Tier note

On Render Free tier, services may **spin down after ~15 minutes of inactivity**.
The next request will “wake” the service, which can add a short delay for the first user request.

