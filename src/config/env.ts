import "dotenv/config";

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined) {
    // Don't throw at import time in dev — just warn — so the server can still
    // boot and hit the missing-config error only on the routes that need it.
    console.warn(`[env] Missing required env var: ${name}`);
    return "";
  }
  return value;
}

export const env = {
  PORT: Number(process.env.PORT ?? 4000),
  NODE_ENV: process.env.NODE_ENV ?? "development",
  FRONTEND_ORIGIN: process.env.FRONTEND_ORIGIN ?? "http://localhost:3000",

  CC_DATABASE_URL: required("CC_DATABASE_URL"),
  SCRAPER_DATABASE_URL: required("SCRAPER_DATABASE_URL"),

  CLERK_SECRET_KEY: required("CLERK_SECRET_KEY"),
  CLERK_PUBLISHABLE_KEY: process.env.CLERK_PUBLISHABLE_KEY ?? "",
  CLERK_WEBHOOK_SECRET: required("CLERK_WEBHOOK_SECRET"),

  AI_SERVICE_URL: process.env.AI_SERVICE_URL ?? "",

  RESEND_API_KEY: process.env.RESEND_API_KEY ?? "",
  TWILIO_ACCOUNT_SID: process.env.TWILIO_ACCOUNT_SID ?? "",
  TWILIO_AUTH_TOKEN: process.env.TWILIO_AUTH_TOKEN ?? "",
  TWILIO_PHONE_NUMBER: process.env.TWILIO_PHONE_NUMBER ?? "",

  ADMIN_API_KEY: process.env.ADMIN_API_KEY ?? "change_me",

  isProd: process.env.NODE_ENV === "production",
};
