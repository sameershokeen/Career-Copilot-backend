import express from "express";
import cors from "cors";
import helmet from "helmet";
import { env } from "./config/env";
import { assertScraperDbIsReadOnly } from "./config/db";
import { errorHandler } from "./middleware/errorHandler";
import { rateLimiters } from "./middleware/rateLimiter";
import { startMonthlyResetScheduler } from "./services/monthlyReset";

import { clerkWebhookRouter } from "./routes/webhooks.clerk";
import { jobsRouter } from "./routes/jobs";
import { userRouter } from "./routes/user";
import { resumesRouter } from "./routes/resumes";
import { queueRouter } from "./routes/queue";
import { applyRouter, applicationsRouter } from "./routes/applications";
import { aiRouter } from "./routes/ai";
import { communityRouter } from "./routes/community";
import { resourcesRouter } from "./routes/resources";
import { alertsRouter } from "./routes/alerts";
import { adminRouter } from "./routes/admin";

const app = express();

app.use(helmet());
app.use(cors({ origin: env.FRONTEND_ORIGIN, credentials: true }));

// Webhooks need the raw body for signature verification — mount BEFORE
// express.json() and give it its own path prefix.
app.use("/api/webhooks", clerkWebhookRouter);

app.use(express.json({ limit: "5mb" })); // resumes/PDFs as base64 can be sizeable

app.get("/health", (_req, res) => res.json({ status: "ok", time: new Date().toISOString() }));

// Global unauthenticated rate limit (per spec section 11) applies to everything else.
app.use(rateLimiters.globalUnauth);

app.use("/api/jobs", jobsRouter);
app.use("/api/user", userRouter);
app.use("/api/resumes", resumesRouter);
app.use("/api/queue", queueRouter);
// Mounted at their own specific prefixes (not bare "/api") so that an
// unmatched /api/whatever path falls through to the real 404 handler below,
// instead of being swallowed by these routers' requireAuth as a misleading
// 401 "Missing bearer token".
app.use("/api/apply", applyRouter); // POST /api/apply/bulk
app.use("/api/applications", applicationsRouter); // /api/applications*
app.use("/api/ai", aiRouter);
app.use("/api/community", communityRouter);
app.use("/api/resources", resourcesRouter);
app.use("/api/alerts", alertsRouter);
app.use("/api/admin", adminRouter);

app.use((req, res) => res.status(404).json({ error: "Not found", path: req.path }));
app.use(errorHandler);

app.listen(env.PORT, () => {
  console.log(`[server] Career Copilot backend listening on :${env.PORT} (${env.NODE_ENV})`);
  assertScraperDbIsReadOnly();
  startMonthlyResetScheduler();
});
