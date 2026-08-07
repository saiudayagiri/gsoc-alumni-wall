-- GSoC Alumni Badge Wall — Supabase (Postgres) schema
-- One row per badge. Scalar fields are columns (queryable/indexable);
-- nested lists (roadmap, socials, sigs) are JSONB. The GSoC project URL is
-- the unique identity of an alum. `owner` is the sha256 email hash (edit key),
-- never a raw email.

create table if not exists badges (
  id            text primary key,
  name          text not null,
  org           text not null default '',
  event         text not null default 'GSoC Alumni',
  city          text not null default '',        -- event city (badge front)
  current_city  text not null default '',        -- where they live now
  native_city   text not null default '',        -- where they're from
  year          text not null default '',
  role          text not null default 'GSoCer',
  linkedin      text not null default '',
  gsoc_url      text not null unique,             -- unique project identity
  owner         text not null default '',         -- sha256(email) edit key
  photo         text not null default '',         -- /api/photo?id=... or ''
  roadmap       jsonb not null default '[]'::jsonb,
  socials       jsonb not null default '[]'::jsonb,
  sigs          jsonb not null default '[]'::jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz
);

-- search helpers (org / event / cities / year)
create index if not exists badges_org_idx         on badges (lower(org));
create index if not exists badges_event_idx       on badges (lower(event));
create index if not exists badges_currentcity_idx on badges (lower(current_city));
create index if not exists badges_nativecity_idx  on badges (lower(native_city));
create index if not exists badges_year_idx        on badges (year);
create index if not exists badges_created_idx     on badges (created_at);

-- Reads/writes go through the service_role key from the API only, so we lock
-- the table with RLS and add no public policies (service_role bypasses RLS).
alter table badges enable row level security;
