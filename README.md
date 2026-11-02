# GRYSOSTA API — Backend

REST API for the GRYSOSTA VIP landing page, referral system and admin panel (SRS sections 2–11).
**Node.js 20+ · Express 5 · TypeScript · MongoDB (Mongoose 9) · Zod · Brevo · Cloudflare Turnstile.**

## Quick start

```bash

cp .env.example .env          # set MONGODB_URI, HASH_SALT, ADMIN_PASSWORD …
npm install
npm run seed:demo             # defaults + first admin + sample data (use `npm run seed` for no demo data)
npm run dev                   # http://localhost:4000/api/v1  (health: /health)
```

With Docker (MongoDB + API): `docker compose up --build`

| Script | What it does |
| --- | --- |
| `npm run dev` | Watch mode (tsx) |
| `npm run build` / `npm start` | Compile to `dist/` and run in production |
| `npm run seed` / `npm run seed:demo` | Settings, content, email templates E1–E6, first admin (+ demo data) |
| `npm test` | 41 end-to-end API tests against a real MongoDB (`MONGODB_URI_TEST`, default `mongodb://localhost:27017/grysosta_test`) |
| `npm run typecheck` | TypeScript check |

Without `BREVO_API_KEY` emails are logged to the console; without `TURNSTILE_SECRET` the bot check is skipped (development only).

## Architecture (module based)

```
src/
  app.ts, server.ts, routes.ts        Express app, bootstrap + graceful shutdown, route mounting
  config/                             env (validated with Zod), MongoDB, logger (pino)
  common/                             errors, validation, rate limits, uploads, export (CSV/XLSX), sanitizer, utils
  modules/
    auth/          A1   admin login, sessions (2 h idle), 5-try lock, 2-step (TOTP), password reset
    public/             landing data, visits, ?ref=, signup, buy click, unsubscribe, /my-referrals
    dashboard/     A2   cards, 30-day chart, EN/ES, top referrers, last signups
    settings/      A3, A12  site mode, book links, prices, program rules
    announcements/ A4   CRUD, schedule, pin, reorder, image, email it (E3)
    members/       A5   signup logic, table, filters, bulk, GDPR delete, export
    referrers/     A6, A7  codes, stats (aggregations), status, detail, Etsy checklist
    sales/         A8 + §9  CSV preview → mapping → confirm, history, undo, manual sale, refunds, approval
    payouts/       A9   per-referrer summary, record payout, PayPal bulk CSV
    emails/        A10 + §7  templates, renderer, Brevo provider, outbox queue + batch worker, logs
    content/       A11  texts, FAQ, policy pages, images (EN/ES)
    reports/       A13  exports, signups by source, activity log
    tracking/           page visits, referral visits, buy clicks
    jobs/               cron: commission approval, 8 AM daily summary, email worker (lock-protected)
```

Each module owns its model(s), Zod schemas, service (business logic) and routes.

**Scaling:** the API is stateless (sessions in MongoDB), so you can run several instances behind a load balancer.
Bulk email goes through a MongoDB outbox: jobs are claimed one at a time with an atomic update, and cron jobs take a lock first, so running several instances is safe.
Every hot query has an index. Referrer stats are batch aggregations, not one query per referrer.
For several instances, plug a shared store (e.g. Redis) into `common/rateLimit.ts` and move uploads to object storage (`common/upload.ts`).

## API reference

Base URL: `/api/v1`. Responses are `{ success: true, data, meta? }` or `{ success: false, error: { code, message, details? } }`.
Lists accept `page`, `limit` (default 50, max 200) and `sort` (`field` or `-field`); `meta` has `total`, `page`, `pages`.
Exports: add `format=csv|xlsx` (CSV is UTF-8 with BOM so Spanish accents open correctly in Excel).

**Auth:** admin routes need `Authorization: Bearer <token>` or the `gsta_admin` httpOnly cookie (set on login).
Referrer self-check routes use the token from `/public/my-referrals/verify` (or the `gsta_referrer` cookie).

### Public (landing page)

| Method | Path | Description |
| --- | --- | --- |
| GET | `/public/site` | Settings subset, site content, active announcements, member count (book links and code only in launch mode) |
| POST | `/public/visits` | `{ lang, ref?, utmSource? }`: daily visitor; valid `ref` → referral visit (1/visitor/day) + 60-day `gsta_ref` cookie; returns referrer first name for the welcome bar |
| GET | `/public/referrers/:code` | Welcome bar lookup (404 for invalid / paused / blocked codes) |
| POST | `/public/signup` | `{ firstName, lastName, email, language, joinReferral, consent: true, refCode?, utm*, botToken }` → `kind: vip \| referrer \| upgraded \| already`, plus `code` / `link` for referrers. 5 per IP per hour |
| POST | `/public/buy-click` | `{ lang, ref? }` → `{ url, code }` (Etsy link for the language; referrer code or general VIP code); counts the click |
| POST | `/public/unsubscribe` · `/public/resubscribe` | `{ token }` |
| POST | `/public/my-referrals/request` | `{ email }` → emails a 30-minute single-use magic link (E5) |
| POST | `/public/my-referrals/verify` | `{ token }` → referrer session (24 h) |
| GET | `/public/my-referrals` | Code, link, visits, signups, clicks, sales, commission earned / paid / unpaid |
| PATCH | `/public/my-referrals/payout` | `{ payoutEmail }` (PayPal) |
| POST | `/public/my-referrals/logout` | |

### Auth (A1)

| Method | Path | Description |
| --- | --- | --- |
| POST | `/auth/login` | `{ email, password }` → `token`, or `{ twoFactorRequired, challengeToken }`. 423 after 5 wrong passwords (15 min) |
| POST | `/auth/2fa/verify` | `{ challengeToken, code }` |
| POST | `/auth/forgot-password` · `/auth/reset-password` | Reset link by email (1 h) · `{ token, password }` |
| GET | `/auth/me` · POST `/auth/logout` · POST `/auth/change-password` | |
| POST | `/auth/2fa/setup` · `/auth/2fa/enable` · `/auth/2fa/disable` | Authenticator app (returns `otpauthUrl` for a QR code) |

### Admin (all under `/admin`)

| Module | Endpoints |
| --- | --- |
| A2 Dashboard | `GET /dashboard` |
| A3 Site mode | `PATCH /settings/site-mode` `{ siteMode, bookLinkEn, bookLinkEs, regularPrice, vipPrice, autoVipPrice, generalVipCode, launchDate }` |
| A4 Announcements | `GET/POST /announcements`, `GET/PATCH/DELETE /announcements/:id`, `PATCH /announcements/reorder {ids}`, `POST /announcements/upload-image` (multipart `image`), `POST /announcements/:id/email {audience: all\|en\|es\|referrers}` |
| A5 VIP members | `GET /members?q&language&status&referredBy(id\|any\|none)&isReferrer&from&to&format`, `GET/PATCH/DELETE /members/:id`, `POST /members/:id/make-referrer`, `POST /members/:id/unsubscribe`, `POST /members/bulk {action: unsubscribe\|delete\|export, ids}` |
| A6 Referrers | `GET /referrers?q&status&etsyCreated&sort=-signups&format`, `GET /referrers/:id` (stats, referred, sales, payouts), `PATCH /referrers/:id {notes, payoutMethod, payoutEmail}`, `PATCH /referrers/:id/status`, `PATCH /referrers/:id/code`, `POST /referrers/:id/resend-email` |
| A7 Etsy codes | `GET /etsy-codes?created=false` (most signups first), `POST /etsy-codes/mark {ids, created}` |
| A8 Sales import | `POST /sales/import/preview` (multipart `file`, .csv, ≤10 MB) → `draftId` + summary; `POST /sales/import/:draftId/analyze {mapping}`; `POST /sales/import/:draftId/confirm {mapping?, assignments: {CODE: referrerId\|"skip"\|null}}`; `GET /sales/imports`; `POST /sales/imports/undo-last`; `POST /sales/manual`; `GET /sales?status&referrerId&from&to&format`; `POST /sales/:id/refund`; `POST /sales/approve-due` |
| A9 Payouts | `GET /payouts/summary?readyOnly`, `POST /payouts {referrerId, amount, paidOn, method, transactionId, note}`, `GET /payouts?format`, `GET /payouts/paypal-export` |
| A10 Emails | `GET /emails/templates`, `GET/PUT /emails/templates/:key`, `GET /emails/templates/:key/preview?lang`, `POST /emails/templates/:key/test {lang, to?, subject?, body?}`, `POST /emails/launch {audience}`, `GET /emails/audiences`, `GET /emails/logs`, `GET /emails/logs/:id` (progress %), `GET /emails/unsubscribed?format` |
| A11 Content | `GET /content`, `PUT /content/texts`, `PUT /content/faq` (full ordered list), `PUT /content/pages`, `POST/DELETE /content/images/:slot` (hero, cover, retirement, og) |
| A12 Settings | `GET /settings`, `PATCH /settings` (commission %, discount %, base, Etsy fee, min payout, holding days, cookie days, contact, address, social, GA, daily summary) |
| A13 Reports | `GET /reports/export/:dataset?format&from&to&lang` (members, referrers, sales, commissions, payouts, activity), `GET /reports/signups-by-source`, `GET /activity?q&entity&from&to` |

## Business rules implemented

- **Codes:** GSTA + first name (A–Z, max 8 letters) + 2 random digits; unique; blocked-words list; letters and numbers only; never reused after deletion or a code change.
- **Referral links:** the cookie lasts 60 days (set in Settings) and the last click wins. Invalid, paused or blocked codes are ignored silently. Nobody can refer themselves.
- **Duplicate signups:** an existing member who ticks the referral box is upgraded to referrer and gets E2. Otherwise they see "already registered", and the welcome email is resent at most once per 24 hours.
- **Commission:**
  - Formula: base × % with half-up rounding. The base is the price after discount, or the net after Etsy fees.
  - Each sale stores the % used, so changing the % only affects new sales.
  - New commissions are Pending, then become Approved after the holding period (daily job), then Paid when a payout is recorded.
  - A refund cancels the commission. If it was already paid, it becomes a negative balance taken off the next payout.
  - Ready to pay = approved balance ≥ minimum payout. Blocked referrers' unpaid commission is frozen.
- **CSV import:**
  - The server trims values and uppercases codes.
  - Order IDs already in the database are skipped.
  - The general VIP code and empty codes are saved as sales with no referrer.
  - Sales with a paused or blocked referrer's code are saved with $0 commission and flagged.
  - Unknown codes are shown for you to assign or skip.
  - Undo removes the last import (refused if its commissions were already paid).
- **Emails:**
  - All 6 emails are sent in the member's language with a branded header, disclaimer, mailing address, unsubscribe link and `List-Unsubscribe` header.
  - E1–E4 never go to unsubscribed members.
  - Bulk sends go out in batches within the Brevo daily limit, with progress shown.
  - In E4, `{code}` is the member's own code, else their referrer's code, else the general VIP code.
- **Security:**
  - Helmet + HSTS, CORS allow-list, rate limits, Zod validation on every input, and HTML sanitizing for rich text.
  - Passwords are bcrypt-hashed. Session and magic-link tokens are stored only as hashes.
  - Visitor IP + user agent is stored only as a salted hash, never the full IP.
  - The server checks the admin session on every admin route.

## Connecting the frontend

The Next.js frontend ([grysosta-frontend](https://github.com/shadat3500/grysosta-frontend)) currently uses a browser-side demo store (`src/lib/store.ts`). To go live, replace those store actions with calls to the endpoints above. Set `CORS_ORIGINS` and `SITE_URL` to the frontend URL. When the API is on another domain, set `COOKIE_SECURE=true`.
