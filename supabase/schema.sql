-- DayGoal schema. Run once in Supabase Dashboard -> SQL Editor.

create extension if not exists pgcrypto;

-- ---------- Tables ----------
create table if not exists public.goals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  day date not null,
  text text not null,
  completed boolean not null default false,
  position int not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists goals_user_day on public.goals (user_id, day);

create table if not exists public.day_entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  day date not null,
  done_notes text not null default '',
  updated_at timestamptz not null default now(),
  unique (user_id, day)
);

create table if not exists public.tasks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  parent_id uuid references public.tasks on delete cascade,
  title text not null,
  description text not null default '',
  status text not null default 'todo' check (status in ('todo','doing','done')),
  due_date date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);
create index if not exists tasks_user on public.tasks (user_id);

create table if not exists public.notes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  day date not null default current_date,
  title text not null default '',
  body text not null default '',
  tags text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists notes_user_day on public.notes (user_id, day);

create table if not exists public.user_settings (
  user_id uuid primary key default auth.uid() references auth.users on delete cascade,
  morning_time text not null default '08:00',
  evening_time text not null default '21:00',
  updated_at timestamptz not null default now()
);

-- ---------- updated_at trigger ----------
create or replace function public.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$ begin new.updated_at = now(); return new; end $$;

drop trigger if exists t_day_entries on public.day_entries;
create trigger t_day_entries before update on public.day_entries for each row execute function public.touch_updated_at();
drop trigger if exists t_tasks on public.tasks;
create trigger t_tasks before update on public.tasks for each row execute function public.touch_updated_at();
drop trigger if exists t_notes on public.notes;
create trigger t_notes before update on public.notes for each row execute function public.touch_updated_at();
drop trigger if exists t_settings on public.user_settings;
create trigger t_settings before update on public.user_settings for each row execute function public.touch_updated_at();

-- ---------- Row Level Security: each user sees only their rows ----------
do $$
declare t text;
begin
  foreach t in array array['goals','day_entries','tasks','notes','user_settings'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists own_rows on public.%I', t);
    execute format('create policy own_rows on public.%I for all to authenticated
                    using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()))', t);
  end loop;
end $$;

-- ---------- Realtime (cross-device live sync) ----------
do $$
declare t text;
begin
  foreach t in array array['goals','day_entries','tasks','notes','user_settings'] loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
    exception when duplicate_object then null;
    end;
  end loop;
end $$;

-- ---------- Literal substring search across everything ----------
create or replace function public.has_text(hay text, needle text, cs boolean)
returns boolean language sql immutable set search_path = '' as $$
  select case when cs then strpos(coalesce(hay,''), needle) > 0
              else strpos(lower(coalesce(hay,'')), lower(needle)) > 0 end
$$;

create or replace function public.search_all(q text, case_sensitive boolean default false)
returns table (kind text, item_id uuid, item_day date, item_title text, item_body text, ts timestamptz)
language sql stable security invoker set search_path = public as $$
  select 'goal'::text as kind, g.id as item_id, g.day as item_day, g.text as item_title, ''::text as item_body, g.created_at as ts
    from goals g
   where g.user_id = auth.uid() and has_text(g.text, q, case_sensitive)
  union all
  select 'done', d.id, d.day, 'What I did', d.done_notes, d.updated_at
    from day_entries d
   where d.user_id = auth.uid() and has_text(d.done_notes, q, case_sensitive)
  union all
  select 'task', t.id, t.due_date, t.title, t.description, t.updated_at
    from tasks t
   where t.user_id = auth.uid() and has_text(t.title || E'\n' || t.description, q, case_sensitive)
  union all
  select 'note', n.id, n.day, n.title, n.body, n.updated_at
    from notes n
   where n.user_id = auth.uid()
     and has_text(n.title || E'\n' || n.body || E'\n' || array_to_string(n.tags, ' '), q, case_sensitive)
  order by ts desc
  limit 300
$$;

grant execute on function public.search_all(text, boolean) to authenticated;
