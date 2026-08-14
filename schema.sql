-- INFODEMIC multiplayer — Week 1 schema
-- Simplest model that works: one row per room holding the whole shared game
-- state as JSONB (votes, board, round timer, filed cases), plus a players
-- table for the dynamic join list. Last-write-wins on the state blob — no
-- per-field concurrency handling. That's a deliberate MVP tradeoff (see
-- MULTIPLAYER_SETUP.md) so this is easy to reason about with one solo dev in
-- 4 weeks. Revisit if playtests show writes actually clobbering each other.

create extension if not exists pgcrypto; -- for gen_random_uuid()

create table if not exists rooms (
  code text primary key,                    -- short shareable join code, e.g. "FOX-4213"
  created_at timestamptz not null default now(),
  host_player_id uuid,                      -- player row id of whoever created the room
  -- Whole shared game state lives here as one blob. Shape (filled in as Week 2
  -- wires actual gameplay — empty/default for the Week 1 lobby milestone):
  -- {
  --   roundState: { startedAt: iso-string|null, ended: bool },
  --   claimVotes: { [claimId]: { [playerId]: "misinfo"|"biased"|"true" } },
  --   board: { [claimId]: { board: [clipId,...], teamCall: null|string,
  --                          confirmed: bool, filed: bool, filedAt: iso-string|null } }
  -- }
  state jsonb not null default '{}'::jsonb
);

create table if not exists players (
  id uuid primary key default gen_random_uuid(),
  room_code text not null references rooms(code) on delete cascade,
  name text not null,
  initial text not null,
  color text not null,
  joined_at timestamptz not null default now()
);

create index if not exists players_room_code_idx on players(room_code);

-- ---------- Row Level Security ----------
-- MVP: fully open policies, no auth. Anyone who has the room code can read/
-- write that room. Fine for a small trusted group playing a demo within a
-- few weeks; NOT fine if this ever goes public — tighten before then.
alter table rooms enable row level security;
alter table players enable row level security;

drop policy if exists "rooms_select_all" on rooms;
create policy "rooms_select_all" on rooms for select using (true);

drop policy if exists "rooms_insert_all" on rooms;
create policy "rooms_insert_all" on rooms for insert with check (true);

drop policy if exists "rooms_update_all" on rooms;
create policy "rooms_update_all" on rooms for update using (true);

drop policy if exists "players_select_all" on players;
create policy "players_select_all" on players for select using (true);

drop policy if exists "players_insert_all" on players;
create policy "players_insert_all" on players for insert with check (true);

-- ---------- Realtime ----------
-- Lets clients subscribe to live changes on these tables (new players joining,
-- state updates) instead of polling. Run this after the tables exist.
alter publication supabase_realtime add table rooms;
alter publication supabase_realtime add table players;
