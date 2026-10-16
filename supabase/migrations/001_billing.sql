-- Run in the Supabase SQL editor before enabling the hosted billing build.
create table public.billing_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  stripe_customer_id text unique,
  stripe_subscription_id text unique,
  subscription_status text not null default 'free',
  access_until timestamptz,
  stripe_event_created bigint not null default 0,
  checkout_session_id text,
  checkout_attempt_id uuid not null default gen_random_uuid(),
  checkout_lock_until timestamptz not null default 'epoch'
);
create table public.export_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  client_id uuid not null,
  status text not null default 'reserved' check (status in ('reserved','completed','canceled')),
  plan text not null check (plan in ('free','pro')),
  manifest jsonb not null,
  settings jsonb not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '2 hours',
  unique(user_id, client_id)
);
create index export_jobs_quota on public.export_jobs(user_id, created_at) where plan='free';
create table public.saved_presets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 50),
  settings jsonb not null,
  updated_at timestamptz not null default now(),
  unique(user_id, name)
);
create table public.stripe_processed_events (id text primary key, created_at timestamptz not null default now());

alter table public.billing_profiles enable row level security;
alter table public.export_jobs enable row level security;
alter table public.saved_presets enable row level security;
alter table public.stripe_processed_events enable row level security;
create policy own_billing on public.billing_profiles for select to authenticated using (user_id=auth.uid());
create policy own_jobs on public.export_jobs for select to authenticated using (user_id=auth.uid());
create policy own_presets on public.saved_presets for select to authenticated using (user_id=auth.uid());
revoke all on public.billing_profiles, public.export_jobs, public.saved_presets, public.stripe_processed_events from anon, authenticated;
grant select on public.billing_profiles, public.export_jobs, public.saved_presets to authenticated;
grant all on public.billing_profiles, public.export_jobs, public.saved_presets, public.stripe_processed_events to service_role;

create function public.has_pro(p_user_id uuid) returns boolean language sql stable security definer set search_path=public as $$
  select exists(select 1 from billing_profiles where user_id=p_user_id and subscription_status in ('active','trialing') and access_until>now());
$$;

create function public.account_entitlements(p_user_id uuid) returns jsonb language sql stable security definer set search_path=public as $$
  with period as (select date_trunc('month',now() at time zone 'UTC') at time zone 'UTC' as start_at),
  usage as (select count(*)::int as used from export_jobs, period where user_id=p_user_id and plan='free' and created_at>=start_at and (status='completed' or (status='reserved' and expires_at>now())))
  select jsonb_build_object('pro',has_pro(p_user_id),'used',used,'limit',5,'remaining',greatest(0,5-used),'resetAt',(select start_at+interval '1 month' from period)) from usage;
$$;

create function public.reserve_export(p_user_id uuid,p_client_id uuid,p_manifest jsonb,p_settings jsonb) returns jsonb language plpgsql security definer set search_path=public as $$
declare existing export_jobs; job export_jobs; paid boolean; allowance jsonb;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text,0));
  select * into existing from export_jobs where user_id=p_user_id and client_id=p_client_id;
  if found then
    if existing.manifest<>p_manifest or existing.settings<>p_settings then raise exception 'IDEMPOTENCY_MISMATCH'; end if;
    return to_jsonb(existing);
  end if;
  paid:=has_pro(p_user_id);
  if jsonb_typeof(p_manifest)<>'array' or jsonb_array_length(p_manifest)<1 or jsonb_array_length(p_manifest)>500 then raise exception 'INVALID_BATCH'; end if;
  if not paid then
    if jsonb_array_length(p_manifest)<>1 then raise exception 'PRO_REQUIRED'; end if;
    if p_settings->>'layout'<>'individual' or (p_settings->>'holes')::boolean or (p_settings->>'threshold')::int<>128 or (p_settings->>'smoothing')::numeric<>0.35 then raise exception 'PRO_REQUIRED'; end if;
    allowance:=account_entitlements(p_user_id);
    if (allowance->>'remaining')::int<1 then raise exception 'FREE_LIMIT_REACHED'; end if;
  end if;
  insert into export_jobs(user_id,client_id,plan,manifest,settings) values(p_user_id,p_client_id,case when paid then 'pro' else 'free' end,p_manifest,p_settings) returning * into job;
  return to_jsonb(job);
end;
$$;

create function public.finish_export(p_user_id uuid,p_job_id uuid) returns boolean language plpgsql security definer set search_path=public as $$
declare job export_jobs;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text,0));
  select * into job from export_jobs where id=p_job_id and user_id=p_user_id for update;
  if not found or job.status='canceled' or job.expires_at<=now() then return false; end if;
  update export_jobs set status='completed' where id=job.id;
  return true;
end;
$$;

create function public.save_pro_preset(p_user_id uuid,p_name text,p_settings jsonb) returns jsonb language plpgsql security definer set search_path=public as $$
declare result saved_presets;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text,0));
  if not has_pro(p_user_id) then raise exception 'PRO_REQUIRED'; end if;
  if not exists(select 1 from saved_presets where user_id=p_user_id and name=p_name) and (select count(*) from saved_presets where user_id=p_user_id)>=50 then raise exception 'PRESET_LIMIT'; end if;
  insert into saved_presets(user_id,name,settings) values(p_user_id,p_name,p_settings) on conflict(user_id,name) do update set settings=excluded.settings,updated_at=now() returning * into result;
  return to_jsonb(result);
end;
$$;

create function public.apply_subscription_event(p_event_id text,p_event_created bigint,p_user_id uuid,p_customer_id text,p_subscription_id text,p_status text,p_access_until timestamptz) returns void language plpgsql security definer set search_path=public as $$
begin
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text,0));
  if exists(select 1 from stripe_processed_events where id=p_event_id) then return; end if;
  if exists(select 1 from billing_profiles where user_id=p_user_id and stripe_customer_id is not null and stripe_customer_id<>p_customer_id) then raise exception 'CUSTOMER_MISMATCH'; end if;
  insert into billing_profiles(user_id,stripe_customer_id,stripe_subscription_id,subscription_status,access_until,stripe_event_created)
  values(p_user_id,p_customer_id,p_subscription_id,p_status,p_access_until,p_event_created)
  on conflict(user_id) do update set stripe_customer_id=excluded.stripe_customer_id,stripe_subscription_id=excluded.stripe_subscription_id,subscription_status=excluded.subscription_status,access_until=excluded.access_until,stripe_event_created=excluded.stripe_event_created
  where billing_profiles.stripe_event_created<=excluded.stripe_event_created;
  insert into stripe_processed_events(id) values(p_event_id);
end;
$$;

create function public.claim_checkout(p_user_id uuid) returns jsonb language plpgsql security definer set search_path=public as $$
declare profile billing_profiles;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text,0));
  select * into profile from billing_profiles where user_id=p_user_id for update;
  if not found or profile.checkout_lock_until>now() then return null; end if;
  update billing_profiles set checkout_lock_until=now()+interval '10 minutes' where user_id=p_user_id returning * into profile;
  return to_jsonb(profile);
end;
$$;

-- These operations accept an explicit user ID and must only be called by the
-- server after validating the bearer token. Browser roles cannot execute them.
revoke all on function public.has_pro(uuid), public.account_entitlements(uuid), public.reserve_export(uuid,uuid,jsonb,jsonb), public.finish_export(uuid,uuid), public.save_pro_preset(uuid,text,jsonb), public.apply_subscription_event(text,bigint,uuid,text,text,text,timestamptz), public.claim_checkout(uuid) from public, anon, authenticated;
grant execute on function public.has_pro(uuid), public.account_entitlements(uuid), public.reserve_export(uuid,uuid,jsonb,jsonb), public.finish_export(uuid,uuid), public.save_pro_preset(uuid,text,jsonb), public.apply_subscription_event(text,bigint,uuid,text,text,text,timestamptz), public.claim_checkout(uuid) to service_role;
