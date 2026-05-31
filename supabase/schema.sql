-- SEO Audit Pro - Supabase Schema
-- Run this in the Supabase SQL Editor

-- Enable UUID extension
create extension if not exists "uuid-ossp";

-- ============================================================
-- AUDITS TABLE
-- Stores every audit request (free and paid)
-- ============================================================
create table if not exists audits (
  id uuid primary key default uuid_generate_v4(),
  url text not null,
  email text,
  name text,
  company text,
  status text not null default 'pending', -- pending | analyzing | free_complete | paid_complete | failed
  plan text default 'free',               -- free | one-time | monthly

  -- Free tier results
  seo_score integer,
  ai_score integer,
  overall_score integer,
  top_issues jsonb,                        -- array of top 3 issues
  strengths jsonb,

  -- Full report results (paid)
  full_issues jsonb,                       -- all issues with priorities
  competitor_analysis jsonb,
  action_plan jsonb,                       -- 90-day plan
  full_report_data jsonb,                  -- complete report JSON

  -- Payment
  stripe_session_id text,
  stripe_payment_intent text,
  stripe_subscription_id text,
  payment_status text default 'unpaid',    -- unpaid | paid | refunded
  amount_paid integer,                     -- in cents

  -- Metadata
  page_title text,
  page_description text,
  word_count integer,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  completed_at timestamptz
);

-- ============================================================
-- SUBSCRIPTIONS TABLE
-- Tracks monthly recurring audits
-- ============================================================
create table if not exists subscriptions (
  id uuid primary key default uuid_generate_v4(),
  email text not null,
  name text,
  company text,
  url text not null,
  stripe_subscription_id text unique,
  stripe_customer_id text,
  status text default 'active',            -- active | cancelled | past_due
  current_period_end timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- ============================================================
-- CONTACTS TABLE
-- CRM - all contacts who have used the tool
-- ============================================================
create table if not exists contacts (
  id uuid primary key default uuid_generate_v4(),
  email text unique not null,
  name text,
  company text,
  website text,
  total_audits integer default 0,
  total_spent integer default 0,          -- in cents
  is_subscriber boolean default false,
  tags text[],
  notes text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- ============================================================
-- INDEXES
-- ============================================================
create index if not exists audits_email_idx on audits(email);
create index if not exists audits_status_idx on audits(status);
create index if not exists audits_created_at_idx on audits(created_at desc);
create index if not exists audits_stripe_session_idx on audits(stripe_session_id);
create index if not exists contacts_email_idx on contacts(email);
create index if not exists subscriptions_email_idx on subscriptions(email);
create index if not exists subscriptions_stripe_id_idx on subscriptions(stripe_subscription_id);

-- ============================================================
-- UPDATED_AT TRIGGER
-- ============================================================
create or replace function update_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger audits_updated_at
  before update on audits
  for each row execute function update_updated_at();

create trigger subscriptions_updated_at
  before update on subscriptions
  for each row execute function update_updated_at();

create trigger contacts_updated_at
  before update on contacts
  for each row execute function update_updated_at();

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================
alter table audits enable row level security;
alter table subscriptions enable row level security;
alter table contacts enable row level security;

-- Service key bypasses RLS (used by Netlify functions)
-- Anon key is read-only for report viewing via token
create policy "Service role full access to audits"
  on audits for all
  using (auth.role() = 'service_role');

create policy "Service role full access to subscriptions"
  on subscriptions for all
  using (auth.role() = 'service_role');

create policy "Service role full access to contacts"
  on contacts for all
  using (auth.role() = 'service_role');
