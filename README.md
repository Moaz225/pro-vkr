# BRODSKY — Orders & Reservations (Web App)

## Description
BRODSKY is a small web application for a cafe/restaurant workflow:
- Guests open the menu, add items to a cart, and “pay” (submit an order).
- Staff and managers open dashboards to view incoming orders/reservations and update statuses.

The project is designed to run locally with a simple Node.js server that serves the static frontend and exposes a JSON API.

> Note: In the current codebase, **orders, reservations, payments, and users are persisted in PostgreSQL** via Prisma.  
> Authentication uses **secure cookie sessions** (HttpOnly) and **CSRF protection** for state-changing requests.

## Table of Contents
- [Features](#features)
- [Technologies Used](#technologies-used)
- [Installation](#installation)
- [Usage](#usage)
- [API Documentation](#api-documentation)
- [Configuration](#configuration)
- [Folder Structure](#folder-structure)
- [Testing](#testing)
- [Contributing](#contributing)
- [License](#license)
- [Acknowledgments](#acknowledgments)
- [Contact / Maintainers](#contact--maintainers)

## Features
- **Guest menu UI**: categories, search, product modal, cart drawer, checkout modal.
- **Order checkout**:
  - payment method (`visa` / `qr` / `cash`)
  - optional table number + comment
  - sends order to backend API
- **Reservations form**: submit table reservation request.
- **Staff dashboard** (`staff-orders.html`):
  - view orders and reservations
  - update order status (`new → in_progress → done`)
  - audible notification toggle + volume
- **Manager dashboard** (`manager.html`):
  - stats (revenue totals by payment method, etc.)
  - view orders and reservations
  - confirm/cancel reservations
  - audible notification toggle + volume
- **Auth overlay** on the menu page:
  - signup / login / continue as guest
  - UI may cache state in `localStorage`, but auth is enforced by server-side cookie sessions (`/api/auth/me`)

## Technologies Used
- **Frontend**: HTML, CSS, JavaScript (DOM, Fetch API, LocalStorage for UI cache)
- **Backend**: Node.js, Express, CORS, Helmet, Rate limiting
- **Database**: PostgreSQL + Prisma (Prisma Client)
- **Auth**: cookie sessions (`express-session`) + Postgres session store (`connect-pg-simple`)
- **CSRF**: `csurf` with `X-CSRF-Token` header
- **Password hashing**: `crypto` (PBKDF2)

Key dependencies (root `package.json`):
- `express`, `cors`, `dotenv`
- `prisma` (dev), `@prisma/client`

## Installation

### Prerequisites
- **Node.js** (recommended: modern LTS)
- **PostgreSQL** (required for signup/login via Prisma)

### Setup (Windows / PowerShell)
From the project root:

```powershell
cd "E:\pro vkr"
npm install
```

Generate Prisma client (required for auth endpoints):

```powershell
npx prisma generate --schema prisma/schema.prisma
```

If you want the Prisma schema applied to your database (creates tables):

```powershell
npx prisma migrate dev --name init --schema prisma/schema.prisma
```

## Usage

### Start the server
Run the backend server from the `server` folder:

```powershell
cd "E:\pro vkr\server"
node server.js
```

You should see URLs in the console (default port 3000).

If port 3000 is busy:

```powershell
$env:PORT=3001
node server.js
```

### Open the app in the browser
Always open pages via HTTP (served by the Node server), not via `file:///`.

- **Guest menu + checkout**: `http://localhost:3000/`
- **Staff dashboard**: `http://localhost:3000/staff-orders.html`
- **Manager dashboard**: `http://localhost:3000/manager.html`

### Important behavior (data persistence)
- **Orders, reservations, and payments**: stored in **PostgreSQL** via Prisma.
- **Users (auth)**: stored in **PostgreSQL** via Prisma.
- **Sessions**: stored in **PostgreSQL** (server-side), cookie is HttpOnly.

## API Documentation

Base URL: `http://localhost:3000`

### Auth
#### `POST /api/auth/register`
Create a new user.

**Body**
```json
{ "name": "Anna", "email": "anna@example.com", "password": "secret123" }
```

**Response (success)**
```json
{ "success": true, "user": { "id": "…", "name": "Anna", "email": "anna@example.com", "role": "user" } }
```

#### `POST /api/auth/login`

**Body**
```json
{ "email": "anna@example.com", "password": "secret123" }
```

**Response**
Same shape as register.

#### `GET /api/auth/me`
Uses cookie session (send requests with credentials).

#### `POST /api/auth/logout`
Destroys cookie session. Requires CSRF token (see below).

### CSRF
#### `GET /api/csrf`
Returns:
```json
{ "csrfToken": "..." }
```

For every state-changing request (`POST`, `PATCH`), send header:
`X-CSRF-Token: <csrfToken>`

### Orders
#### `POST /api/orders`

**Body**
```json
{
  "items": [{ "name": "Эспрессо", "price": 200, "qty": 1 }],
  "total": 200,
  "paymentMethod": "cash",
  "comment": "Без сахара",
  "tableNumber": "5"
}
```

**Response**
```json
{ "success": true, "orderId": "1" }
```

#### `GET /api/orders`
Returns:
```json
{ "orders": [ /* ... */ ] }
```

Supports query params (server-side filtering):
- `status` (e.g. `new`, `in_progress`, `done`)
- `paymentMethod` (`visa`, `qr`, `cash`)
- `q` (search in comment + item names)
- `from`, `to` (ISO date strings)
- `sort` (`asc` or `desc`, default `desc`)
- `limit` (integer)

#### `PATCH /api/orders/:orderId`
Update order status.

**Body**
```json
{ "status": "in_progress" }
```

Allowed: `new`, `in_progress`, `done`

### Reservations
#### `POST /api/reservations`

**Body**
```json
{
  "name": "Иван",
  "phone": "+7 999 000-00-00",
  "date": "2026-03-20",
  "time": "18:30",
  "guests": 2,
  "comment": "Окно"
}
```

**Response**
```json
{ "success": true, "reservationId": "1" }
```

#### `GET /api/reservations`
Returns:
```json
{ "reservations": [ /* ... */ ] }
```

#### `PATCH /api/reservations/:reservationId`
Update reservation status.

**Body**
```json
{ "status": "confirmed" }
```

Allowed: `pending`, `confirmed`, `cancelled`

### Health
#### `GET /api/health`
Returns counts of DB-backed orders/reservations:

```json
{ "status": "ok", "time": "…", "ordersCount": 0, "reservationsCount": 0 }
```

## Configuration

### `.env`
Located at the project root: `./.env`

Used variables:
- **`DATABASE_URL`**: PostgreSQL connection string for Prisma and session store.
  - Example:

```env
DATABASE_URL="postgresql://Tech@localhost:5432/brodsky?schema=public"
```

- **`PORT`** (optional): server port (default `3000`)
- **`CORS_ORIGIN`**: CORS allowlist (use explicit origins in production)
- **`PUBLIC_BASE_URL`**: public base URL (used for YooKassa return URL)
- **`SESSION_SECRET`**: session secret (required in production)

### Optional frontend API base overrides
These pages support overriding API base via global variables:
- `window.BRODSKY_API_BASE` (menu page)
- `window.STAFF_API_BASE` (staff page)
- `window.MANAGER_API_BASE` (manager page)

If not set, the dashboards default to `http://localhost:3000`.

## Folder Structure
```text
E:\pro vkr\
  index.html              # Guest menu page
  staff-orders.html       # Staff dashboard
  manager.html            # Manager dashboard
  style.css               # Global styles
  script.js               # Frontend logic for menu/cart/checkout/auth/reservation
  prisma\
    schema.prisma         # Prisma schema (auth + restaurant domain models)
    migrations\           # Prisma migrations (if applied)
  server\
    server.js             # Express server + API endpoints
  .env                    # Environment variables (DATABASE_URL, etc.)
  package.json            # Root dependencies + Prisma scripts
```

## Testing
No automated test suite is included yet.

Manual testing checklist:
- Start server, open all three pages via `http://localhost:3000`.
- Place an order → confirm it appears on staff/manager after refresh.
- Change order status on staff page → confirm it updates.
- Create reservation → confirm it appears on staff/manager and can be confirmed/cancelled on manager page.
- Signup/login from menu page.

## Contributing
- Keep changes small and focused.
- Prefer consistent API response shapes (`{ success: boolean, ... }`).
- Avoid storing secrets in the repo; keep them in `.env`.

## License
This project is licensed under **ISC** (per `package.json`).

## Acknowledgments
- Icons: Font Awesome
- Fonts: Google Fonts (Roboto)
- Prisma ORM for database access



