-- Career Copilot — initial schema for the cc_* tables.
-- Runs against CC_DATABASE_URL only. The scraper's `jobs` / `scrape_runs`
-- tables live in a separate database and are NOT created here.
--
-- NOTE: every *_job_id / job_id column below is a plain BIGINT with no FK
-- constraint, because it points at a table in a different database. See
-- src/config/db.ts for the full explanation.

CREATE EXTENSION IF NOT EXISTS pgcrypto; -- for gen_random_uuid()

CREATE TABLE IF NOT EXISTS cc_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clerk_id TEXT UNIQUE NOT NULL,
  email TEXT NOT NULL,
  name TEXT,
  plan TEXT NOT NULL DEFAULT 'free' CHECK (plan IN ('free', 'pro')),
  apply_count INT NOT NULL DEFAULT 0,
  cover_letter_count INT NOT NULL DEFAULT 0,
  resume_count INT NOT NULL DEFAULT 0,
  profile_complete BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS cc_user_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES cc_users(id) ON DELETE CASCADE,
  phone TEXT,
  location TEXT,
  linkedin TEXT,
  github TEXT,
  portfolio TEXT,
  twitter TEXT,
  bio TEXT,
  skills TEXT[],
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_cc_user_profiles_user_id ON cc_user_profiles(user_id);

CREATE TABLE IF NOT EXISTS cc_resumes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES cc_users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  content JSONB NOT NULL,
  is_default BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_cc_resumes_user_id ON cc_resumes(user_id);

CREATE TABLE IF NOT EXISTS cc_parsed_resumes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES cc_users(id) ON DELETE CASCADE,
  resume_id UUID REFERENCES cc_resumes(id) ON DELETE SET NULL,
  parsed_data JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_cc_parsed_resumes_user_id ON cc_parsed_resumes(user_id);

CREATE TABLE IF NOT EXISTS cc_apply_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES cc_users(id) ON DELETE CASCADE,
  job_id BIGINT NOT NULL, -- references scraper DB's jobs.id (cross-db, no FK)
  added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'removed'))
);
CREATE INDEX IF NOT EXISTS ix_cc_apply_queue_user_id ON cc_apply_queue(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_cc_apply_queue_user_job_pending
  ON cc_apply_queue(user_id, job_id) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS cc_cover_letters (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES cc_users(id) ON DELETE CASCADE,
  job_id BIGINT NOT NULL, -- cross-db reference, no FK
  content TEXT NOT NULL,
  tone TEXT CHECK (tone IN ('formal', 'casual', 'enthusiastic')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_cc_cover_letters_user_job ON cc_cover_letters(user_id, job_id);

CREATE TABLE IF NOT EXISTS cc_applications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES cc_users(id) ON DELETE CASCADE,
  job_id BIGINT NOT NULL, -- cross-db reference, no FK
  resume_id UUID REFERENCES cc_resumes(id) ON DELETE SET NULL,
  cover_letter_id UUID REFERENCES cc_cover_letters(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN (
    'queued', 'applied', 'viewed', 'interview', 'offer',
    'rejected', 'manual_required', 'failed'
  )),
  -- Snapshot of title/company/job_url at apply time so the tracker still
  -- renders something sane if the job later disappears from the scraper DB.
  job_title_snapshot TEXT,
  job_company_snapshot TEXT,
  job_url_snapshot TEXT,
  prefilled_data JSONB,
  applied_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_cc_applications_user_id ON cc_applications(user_id);
CREATE INDEX IF NOT EXISTS ix_cc_applications_job_id ON cc_applications(job_id);
CREATE INDEX IF NOT EXISTS ix_cc_applications_status ON cc_applications(status);

CREATE TABLE IF NOT EXISTS cc_application_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id UUID NOT NULL REFERENCES cc_applications(id) ON DELETE CASCADE,
  event TEXT NOT NULL,
  detail TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_cc_application_logs_application_id ON cc_application_logs(application_id);

CREATE TABLE IF NOT EXISTS cc_match_scores (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES cc_users(id) ON DELETE CASCADE,
  job_id BIGINT NOT NULL, -- cross-db reference, no FK
  overall_score INT,
  skills_match INT,
  experience_match INT,
  domain_match INT,
  missing_skills TEXT[],
  strengths TEXT[],
  summary TEXT,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, job_id)
);

CREATE TABLE IF NOT EXISTS cc_resources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  category TEXT CHECK (category IN ('roadmap', 'tip', 'guide')),
  domain TEXT CHECK (domain IN ('frontend', 'backend', 'ai', 'general')),
  content TEXT NOT NULL,
  order_index INT DEFAULT 0,
  published BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS cc_community_posts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES cc_users(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  post_type TEXT CHECK (post_type IN ('update', 'question', 'resource', 'founder-connect')),
  likes_count INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_cc_community_posts_created_at ON cc_community_posts(created_at DESC);

CREATE TABLE IF NOT EXISTS cc_post_likes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id UUID NOT NULL REFERENCES cc_community_posts(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES cc_users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (post_id, user_id)
);

CREATE TABLE IF NOT EXISTS cc_alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES cc_users(id) ON DELETE CASCADE,
  keywords TEXT[],
  location TEXT,
  role_type TEXT,
  frequency TEXT CHECK (frequency IN ('instant', 'daily', 'weekly')),
  channel TEXT CHECK (channel IN ('email', 'sms', 'both')),
  active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_cc_alerts_user_id ON cc_alerts(user_id);

CREATE TABLE IF NOT EXISTS cc_notification_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES cc_users(id) ON DELETE CASCADE,
  type TEXT CHECK (type IN ('apply_complete', 'alert', 'status_change', 'digest')),
  channel TEXT CHECK (channel IN ('email', 'sms')),
  recipient TEXT,
  subject TEXT,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  success BOOLEAN DEFAULT TRUE,
  error TEXT
);

CREATE TABLE IF NOT EXISTS cc_rate_limit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES cc_users(id) ON DELETE SET NULL,
  ip TEXT,
  route TEXT,
  hit_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_cc_rate_limit_logs_hit_at ON cc_rate_limit_logs(hit_at);
