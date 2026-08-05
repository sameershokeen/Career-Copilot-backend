# Career Copilot — Backend

Node.js + Express + Postgres (`pg`, no ORM) + Clerk auth. This is a **standalone**
deploy of the backend, wired to a local AI layer at `src/ai/` — no monorepo, no npm
workspaces, no sibling `frontend/`/`shared/` folders required. Push this folder to its
own repo and deploy it directly.

> Pairs with the **career-copilot-frontend** project (deploy target: Vercel). Point
> the frontend's `NEXT_PUBLIC_API_URL` at wherever this backend ends up, and set this
> backend's `FRONTEND_ORIGIN` to the frontend's deployed URL for CORS.

---

## 1. Architecture at a glance

```
┌─────────────────────────────────────────────────────────────┐
│  Express API (src/routes/*)                                  │
│  Clerk auth · plan gating · rate limiting · in-memory cache   │
└──────────────────────────┬────────────────────────────────────┘
                            │ direct in-process function calls
┌──────────────────────────▼────────────────────────────────────┐
│  AI layer (src/ai/)                                            │
│  Resume parser · match scorer · cover letter generator ·       │
│  auto-fill engine (Playwright) · OpenRouter client              │
└──────────────────────────────────────────────────────────────┘
```

- **`src/ai/`** is the AI layer, folded directly into this project (it used to be a
  separate `@career-copilot/ai` npm workspace package in the monorepo — same code,
  now living locally so this backend has zero external workspace dependencies). It's
  **never exposed to the internet** and never called over HTTP — `src/index.ts` only
  imports plain functions from `src/ai/index.ts` and calls them in-process. See
  [§6](#6-the-ai-layer-srcai).
- **Two separate Postgres databases** — see [§5](#5-the-two-database-architecture).
- Everything the frontend needs lives behind `Authorization: Bearer <clerk-session-jwt>`
  except `/health` and the Clerk webhook.

---

## 2. Setup

```bash
npm install              # also runs `playwright install chromium` (postinstall)
cp .env.example .env     # fill in real values — see §3
npm run migrate          # creates all cc_* tables in CC_DATABASE_URL
npm run dev              # tsx watch, http://localhost:4000
```

`npm run build && npm start` for a production-style run. `npm run typecheck` for a
quick compile check without emitting (both pass clean as of this project).

---

## 3. Environment variables

See `.env.example` for the full file with inline comments. Summary:

| Variable | Required | Notes |
|---|---|---|
| `PORT` | no (default `4000`) | |
| `NODE_ENV` | no | `development` \| `production` |
| `FRONTEND_ORIGIN` | yes | used for CORS — your deployed frontend's URL |
| `CC_DATABASE_URL` | **yes** | Career Copilot's own Postgres — owns every `cc_*` table |
| `SCRAPER_DATABASE_URL` | **yes** | the scraper's Postgres — **read-only**, never written to |
| `CLERK_SECRET_KEY` | **yes** | verifies session JWTs |
| `CLERK_PUBLISHABLE_KEY` | no | not used server-side, kept for parity |
| `CLERK_WEBHOOK_SECRET` | **yes** | verifies the `user.created` webhook signature (svix) |
| `OPENROUTER_API_KEY` | yes, for AI features | server boots without it; AI calls error clearly until set |
| `OPENROUTER_MODEL` / `OPENROUTER_FALLBACK_MODEL` | no | default to free-tier OpenRouter models |
| `AUTOFILL_HEADLESS` / `AUTOFILL_TIMEOUT_MS` | no | Playwright auto-fill engine tuning |
| `RESEND_API_KEY` | no | email notifications; no-ops without it |
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_PHONE_NUMBER` | no | Pro-tier SMS alerts |
| `ADMIN_API_KEY` | no (default `change_me`) | protects `/api/admin/*` — **set a real value in production** |

---

## 4. Deploying to Railway

1. Push this folder as its own git repo (or point Railway at the `backend/`
   subdirectory of a monorepo — either works, nothing here depends on sibling
   folders).
2. **New Project → Deploy from GitHub repo**, select this repo.
3. Railway auto-detects Node and uses Nixpacks. `nixpacks.toml` and `railway.json`
   are already included:
   - `railway.json` sets the start command (`npm start`) and points the health check
     at `GET /health`.
   - `nixpacks.toml` adds the system libraries Playwright's Chromium needs
     (`chromium`, `nss`, `mesa`, etc.) that aren't in the default Node image. Without
     these, the auto-fill engine's headless browser will fail to launch in
     production even though `npm install` (and its `postinstall: playwright install
     chromium`) succeeds.
4. Add every variable from `.env.example` in **Railway → Variables**. Provision
   Postgres for `CC_DATABASE_URL` either via Railway's own Postgres plugin or an
   external host (e.g. Neon) — `SCRAPER_DATABASE_URL` points at wherever your job
   scraper's database already lives.
5. After the first deploy, run the migration once (Railway → your service → shell,
   or run it locally against the production `CC_DATABASE_URL`):
   ```bash
   npm run migrate
   ```
6. Set `FRONTEND_ORIGIN` to your Vercel frontend's URL, and grab this service's
   public Railway URL to set as `NEXT_PUBLIC_API_URL` on the frontend.

If Chromium still fails to launch under Nixpacks in your Railway environment, the
usual fallback is switching `playwright` → `playwright-core` + `@sparticuz/chromium`
(a serverless-friendly Chromium build) inside the auto-fill engine — flagged here in
case Nixpacks' apt-style packages ever drift from what Playwright expects.

---

## 5. The two-database architecture

The job scraper runs independently and owns its own Postgres database (`jobs`,
`scrape_runs` tables). Career Copilot's `cc_*` tables live in a **separate** Postgres
database. This is intentional:

- `src/config/db.ts` exports `ccDb` and `scraperDb` as two independent `pg.Pool`
  instances, pointed at `CC_DATABASE_URL` and `SCRAPER_DATABASE_URL` respectively.
- Postgres can't enforce a foreign key across two separate database instances, so
  every `job_id` column on the `cc_*` side (`cc_apply_queue.job_id`,
  `cc_applications.job_id`, `cc_cover_letters.job_id`, `cc_match_scores.job_id`) is a
  plain `BIGINT` with **no FK constraint**.
- Anywhere the UI needs "application + live job details" (the tracker, the queue
  panel), the backend does an **app-level join**: fetch rows from `ccDb`, collect
  their `job_id`s, batch-fetch matching rows from `scraperDb`, merge in memory —
  see `src/services/jobsEnrich.ts`.
- If a job later disappears from the scraper DB, historical applications don't break
  — `cc_applications` stores a `job_title`/`job_company`/`job_url` snapshot taken at
  apply time, used as a fallback when the live join misses.
- The backend **never writes** to `jobs` or `scrape_runs` — every scraper-side query
  is a `SELECT`.

---

## 6. The AI layer (`src/ai/`)

**Stack:** OpenRouter (free-tier models) + Playwright + `pdf-parse`.

`src/services/aiClient.ts` and `src/routes/applications.ts` are the only two files
that import from `src/ai/index.ts` — the AI layer's sole public surface. Keeping the
import surface to one file makes it easy to change models, providers, or internal
prompt structure without touching route code.

### Exported functions (`src/ai/index.ts`)

| Function | Used by |
|---|---|
| `parseResume(input)` | `POST /api/ai/parse-resume`, `POST /api/resumes/:id/parse` |
| `computeMatchScore(input)` | `POST /api/ai/match/:jobId` |
| `generateCoverLetter(input)` | `POST /api/ai/cover-letter` |
| `autoFillAndSubmit(input)` | single-application path inside the bulk pipeline |
| `runBulkAutoFill(inputs, options)` | `POST /api/apply/bulk` |

### Model config
- Primary: `mistralai/mistral-7b-instruct` (free on OpenRouter)
- Fallback: `meta-llama/llama-3-8b-instruct` (free on OpenRouter)
- Both swappable via env, zero code changes. `src/ai/openrouter/client.ts` tries
  primary, falls back once on any failure (timeout, 429, 5xx, empty response), and
  only validates `OPENROUTER_API_KEY` at the moment a model call actually happens —
  not at process startup, so the rest of the API stays usable without it configured.

### Auto-Fill Engine
For each approved job: loads the parsed resume + generated cover letter, maps fields
to standard form inputs (name, email, phone, LinkedIn, GitHub, resume URL, cover
letter text), asks the model for free-text answers where needed, then submits via a
direct API if the target ATS exposes one, or a headless Playwright browser otherwise.
Every event is logged; CAPTCHA/bot-detection results in `manual_required` with the
pre-filled form JSON saved for the user to paste by hand.

---

## 7. Auth, plan gating, cache, notifications

- **Auth** — Clerk session JWT verified on every protected route via
  `middleware/auth.ts` → `requireAuth`. A Clerk webhook (`POST /api/webhooks/clerk`)
  creates the matching `cc_users` row on first sign-in. There's a brief window where
  a freshly-signed-up user's token is valid but their `cc_users` row doesn't exist
  yet — `requireAuth` returns `401 "User not provisioned yet"` in that case; the
  frontend should retry shortly.
- **Plan gating** — `middleware/planGate.ts` checks the relevant count on `cc_users`
  (`apply_count`, `cover_letter_count`, `resume_count`) against `FREE_LIMITS` /
  `PRO_LIMITS`, returning `402 Payment Required` with an upgrade-prompt body if hit.
  Counts reset on the 1st of each month via `services/monthlyReset.ts` (in-process
  scheduler, started at boot).
- **Cache** — `services/cacheStore.ts`, a singleton `Map`-based cache with per-key
  TTL, no Redis. Read-through, write-invalidating.
- **Notifications** — `services/notify.ts`, email via Resend, SMS via Twilio (Pro
  only). Every send is logged to `cc_notification_logs`; runs fine without these keys
  configured, calls just no-op/log a warning instead of throwing.

---

## 8. Full API reference

All routes except `/health` and `/api/webhooks/clerk` require
`Authorization: Bearer <clerk-session-jwt>`.

| Method | Path | Purpose | Notes |
|---|---|---|---|
| GET | `/health` | liveness check | no auth |
| POST | `/api/webhooks/clerk` | Clerk `user.created` webhook | svix-signed, no bearer auth |
| GET | `/api/jobs` | paginated job list | query: `page, pageSize, region, remote, postedWithin, search`; cached 15 min |
| GET | `/api/jobs/:id` | single job detail | cached 30 min |
| POST | `/api/jobs/search` | same filters, body-based | for complex filter UIs |
| GET | `/api/user/profile` | profile + resume list | |
| PUT | `/api/user/profile` | update profile | invalidates cache |
| GET | `/api/user/status` | plan, counts, limits | |
| GET | `/api/resumes` | list resumes | |
| GET | `/api/resumes/:id` | single resume | |
| POST | `/api/resumes` | create resume | gated: `resume_create` |
| PUT | `/api/resumes/:id` | update resume | every builder save |
| DELETE | `/api/resumes/:id` | delete resume | |
| POST | `/api/resumes/:id/parse` | run builder content through the AI parser | writes `cc_parsed_resumes` |
| GET | `/api/queue` | pending queue, enriched with live job data | returns `{ queue: [...], count }` |
| POST | `/api/queue` | "Add to Queue" | body: `{ job_id }` |
| DELETE | `/api/queue/:id` | remove entry | `:id` is the **queue row id**, not `job_id` |
| POST | `/api/apply/bulk` | "Bulk Approve & Auto-Apply" | acts on every currently-pending queue entry; gated: `auto_apply` |
| GET | `/api/applications` | Kanban tracker list | enriched with live/snapshot job data |
| GET | `/api/applications/:id/logs` | per-application event log | |
| PUT | `/api/applications/:id/status` | manual status override | |
| POST | `/api/ai/parse-resume` | parse raw text/PDF into structured JSON | writes `cc_parsed_resumes` |
| POST | `/api/ai/match/:jobId` | compute match score | requires a parsed resume on file; cached per (user, job) |
| POST | `/api/ai/cover-letter` | generate a cover letter | gated: `cover_letter` |
| PUT | `/api/ai/cover-letter/:id` | edit a generated letter | |
| GET | `/api/community/posts` | feed, paginated | `?page=1`; cached 5 min |
| POST | `/api/community/posts` | create a post | Pro only |
| POST | `/api/community/posts/:id/like` | toggle like | |
| GET | `/api/resources` | roadmaps/tips/guides | `?domain=&category=`; cached 24h |
| GET | `/api/resources/:slug` | single resource | |
| GET/POST | `/api/alerts` | job alert configs | Pro: email + SMS; Free: none |
| `/api/admin/*` | cache-clear, resource seeding | protected by `ADMIN_API_KEY` |

---

## 9. Database schema

**Scraper DB (read-only from this app):** `jobs`, `scrape_runs`.

**Career Copilot DB — every table prefixed `cc_`:**

| Table | Purpose |
|---|---|
| `cc_users` | account, plan, monthly counts |
| `cc_user_profiles` | phone, location, social links, bio, skills |
| `cc_resumes` | every builder-saved resume version (JSONB `content`) |
| `cc_parsed_resumes` | AI-parsed canonical resume JSON, feeds match scoring + cover letters |
| `cc_apply_queue` | pending/approved/removed queue entries |
| `cc_applications` | one row per application attempt, with status + job snapshot |
| `cc_application_logs` | timestamped event log per application |
| `cc_cover_letters` | generated letters, editable before use |
| `cc_match_scores` | per (user, job) computed scores, unique constraint |
| `cc_resources` | roadmaps/tips/guides, DB-backed content |
| `cc_community_posts` / `cc_post_likes` | community feed |
| `cc_alerts` | job alert configs |
| `cc_notification_logs` | every email/SMS sent, success or failure |
| `cc_rate_limit_logs` | every rate-limit hit |
| `cc_schema_migrations` | tracks which `.sql` files have run |

`npm run migrate` applies `src/db/migrations/001_init_cc_tables.sql`. The runner is
idempotent — already-applied files are skipped.

---

## 10. Auto-apply pipeline — how it actually runs

```
User browses Job Board
   │
   ▼
"Add to Queue" → POST /api/queue → row created in cc_apply_queue
   │
   ▼
Review Queue Panel → optionally DELETE /api/queue/:id to remove entries
   │
   ▼
"Bulk Approve & Auto-Apply" → POST /api/apply/bulk (acts on every
   currently-pending queue entry for this user)
   │
   ▼
Backend: check plan limit → create cc_applications rows (status: queued) →
   mark queue entries 'approved' → build AutoFillJobInput per application
   (parsed resume + latest cover letter for that job, if any)
   │
   ▼
runBulkAutoFill() (src/ai/) — processes in parallel batches of 5:
   - CAPTCHA / bot detection → status: manual_required, pre-filled form JSON saved
   - Success → status: applied
   - Network failure → status: failed, retryable from the tracker
   │
   ▼
Every event logged to cc_application_logs · apply_count incremented ·
   summary email sent · response returned as { queued, summary, results }
```

---

## 11. Project structure

```
career-copilot-backend/
├── src/
│   ├── ai/                  # AI layer — folded in locally, see §6
│   │   ├── openrouter/       # single entry point to the model, primary+fallback
│   │   ├── prompts/           # versioned prompt template strings
│   │   ├── services/          # resumeParser, matchScorer, coverLetterGenerator,
│   │   │                       # autoFillEngine (Playwright), autoFillBulk
│   │   ├── types/
│   │   └── index.ts            # the only file backend routes import AI functions from
│   ├── config/                 # env.ts, db.ts (the two Pool instances)
│   ├── middleware/              # auth.ts, planGate.ts, rateLimiter.ts, errorHandler.ts
│   ├── routes/                  # one file per resource — see §8
│   ├── services/                 # cacheStore, jobsEnrich, notify, aiClient, monthlyReset
│   ├── db/migrations/             # 001_init_cc_tables.sql + migrate.ts runner
│   └── index.ts                    # Express app entry point
├── .env.example
├── nixpacks.toml               # Railway build config (Chromium system deps)
├── railway.json                 # Railway start command + health check
├── package.json
└── tsconfig.json
```
