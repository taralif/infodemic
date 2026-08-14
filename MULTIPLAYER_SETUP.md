# Multiplayer setup (Week 1 + Week 2)

What's here: `schema.sql` (database tables), `supabase-sync.js` (the sync layer), `infodemic-multiplayer-lobby.html` (Week 1's standalone test page — proof that room creation/joining and live player sync work, no game screens). The actual game now lives one folder up as `../infodemic-multiplayer-prototype.html` — a copy of the hub-and-spoke prototype with real multiplayer wired in (see "Testing the actual game" below). The original `infodemic-hub-spoke-prototype.html` is untouched, same as always.

This matches the build-plan.md operating assumption of a managed realtime backend (Supabase/PartyKit) — using Supabase specifically, since it's the fastest path for a solo build on a 4-week clock.

## 1. Create the Supabase project

1. Go to supabase.com and sign in / create an account.
2. Create a new project (any name, e.g. "infodemic"). Pick any region close to you. Save the database password somewhere — you won't need it for this setup, but Supabase asks for one.
3. Wait for the project to finish provisioning (~2 minutes).

## 2. Run the schema

1. In the project dashboard, open **SQL Editor** (left sidebar).
2. Paste the entire contents of `schema.sql` and click **Run**.
3. Confirm it succeeded — you should see `rooms` and `players` under **Table Editor**.

## 3. Get your API keys

1. In the dashboard, go to **Project Settings → API**.
2. Copy the **Project URL** and the **anon public** key (not the service_role key — that one's secret and should never go in client-side code).

## 4. Wire the keys in

Open `supabase-sync.js` and replace the two placeholder lines near the top:

```js
var SUPABASE_URL = "REPLACE_WITH_YOUR_SUPABASE_URL";
var SUPABASE_ANON_KEY = "REPLACE_WITH_YOUR_SUPABASE_ANON_KEY";
```

with your actual values from step 3.

## 5. Test it

`infodemic-multiplayer-lobby.html`, `supabase-sync.js`, and `schema.sql` all need to sit in the same folder (they already do, in `multiplayer/`). Since this uses the `fetch`-based Supabase client (not `file://`-restricted APIs), you can just open `infodemic-multiplayer-lobby.html` directly in a browser — no local server required.

1. Open the file in one browser tab, enter a name, click **Create a new room**. Note the room code shown.
2. Open the same file in a second tab (or a different browser, or your phone), enter a different name, type in that room code, click **Join room**.
3. Both tabs should show both names in the player list within a second or two, with no page refresh needed — that's the realtime sync working.

If step 3 doesn't happen live: check the browser console for errors first (most likely cause is realtime not enabled on the tables — re-run the last two `alter publication` lines from `schema.sql`, or check they succeeded in the SQL Editor's output).

## What the Week 1 lobby page does and doesn't prove

Proves: rooms can be created with a shareable code, multiple real devices can join the same room, and player presence syncs live via Supabase Realtime — the foundation the rest of the build sits on.

Doesn't touch: the actual game. That's what Week 2 added — see below.

## Testing the actual game (Week 2)

Open `../infodemic-multiplayer-prototype.html` (same setup already done in steps 1–4 above applies — it uses the same `multiplayer/supabase-sync.js`, so once your keys are in there once, both this file and the lobby test page work).

1. Open it in one tab, enter your name, **Create a new room**. You'll land on a screen showing the room code and a live player list.
2. Open it in a second tab/device, enter a different name, type in that code, **Join room** — both tabs' player lists should update live.
3. Either player taps **Enter game ▶**, then whoever taps **Start Round 1** first starts the shared 60-second clock — the other tab should start counting down from the same moment within a second or two, without needing to also tap Start.
4. Vote on a claim in each tab — after the round ends, the reveal/sorted feed should show both players' real votes (not the old scripted Maya/Diego/Priya).
5. Flip open a contested claim, pool some evidence into the Board tab from either tab, set a determination, confirm, and file — the other tab should reflect the same evidence/verdict/filed state without refreshing.

What's still local-only (by design, not a bug): which screen you're on, which card is flipped open, and your Search/Ask AI/Background exploration progress — investigation is meant to be individual per the game's design; only what you pool onto the shared board syncs.

Verified via a Node test harness (`test_multiplayer_sync.js`, run against a mocked backend simulating two browser tabs) before this was handed off — confirmed room join, live player sync, shared round-timer adoption, per-player vote merging (not clobbering), and board/filing sync all work correctly at the logic level. That's not the same as testing against real Supabase infrastructure, so still worth doing the manual walkthrough above at least once.

## Known simplifications (deliberate, for MVP speed)

- **Last-write-wins.** The whole game state lives in one JSONB blob per room, read-modify-written on every update. If two players save at the exact same instant, one write can overwrite the other. Fine for a small, cooperative table; would need real conflict handling for anything more adversarial or higher-scale.
- **No vote-hiding at the database level.** When Round 1 votes get wired in next week, they'll sync to everyone's client in real time — hiding them until reveal will be done in the UI only (not rendering other players' votes early), not enforced server-side. A technically savvy player could see votes early via browser dev tools. Acceptable for a trusted-group MVP demo; flagged so it doesn't get forgotten if this ever goes public/competitive.
- **Open RLS policies.** Anyone with a room code can read/write that room — no auth, no per-player write restrictions. Matches "no accounts" design decision, but also means no real cheat-proofing.
- **No reconnect/disconnect handling yet.** If a player closes the tab, their `players` row just sits there — no "left the game" state. Deferred per the staged-MVP scope.
