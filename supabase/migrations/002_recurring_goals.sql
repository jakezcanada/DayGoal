-- Repeating daily goals. Run once in Supabase Dashboard -> SQL Editor.
-- Safe to run more than once.

create table if not exists public.recurring_goals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  text text not null,
  weekdays smallint[] not null default '{0,1,2,3,4,5,6}', -- 0 = Sunday ... 6 = Saturday
  active boolean not null default true,
  position int not null default 0,
  last_added date,                                        -- last day it was copied into goals
  created_at timestamptz not null default now()
);
create index if not exists recurring_goals_user on public.recurring_goals (user_id);

-- Each daily goal can point back at the repeating goal it came from.
alter table public.goals add column if not exists recurring_id uuid references public.recurring_goals on delete set null;
-- One copy per repeating goal per day, even if two devices add it at once.
create unique index if not exists goals_one_per_recurring on public.goals (user_id, day, recurring_id);
create index if not exists goals_recurring_id on public.goals (recurring_id);

alter table public.recurring_goals enable row level security;
drop policy if exists own_rows on public.recurring_goals;
create policy own_rows on public.recurring_goals for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

do $$ begin
  alter publication supabase_realtime add table public.recurring_goals;
exception when duplicate_object then null;
end $$;
