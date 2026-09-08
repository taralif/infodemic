// Supabase Edge Function: generate-drop-candidates — v10 "claims MVP" (2026-09-07)
//
// Pulls one live headline per topic from NewsData.io, then asks Claude to write
// ONE post per story in the claims rule's MVP shape, and caches the result in
// story_candidates for the console to read.
//
// v10 vs v9 (claims-rule-brief.md Part 2, cut down to the MVP Tara scoped 9/7):
//   - ONE post per story (`post`), not hygiene/flag variants. `variants` is retired.
//   - The post carries a CARD tell only: `card_tell` is one of the Spotter's five
//     chips, or null = straight. `card_words` is the phrase on the post the chip
//     is hittable through. NO dig tells (Tara 9/7: "eliminate those for now").
//   - Chips are DEALT SOFTLY: a deterministic round-robin hands each topic a chip
//     (two topics straight). The model may decline — "this story can't carry it"
//     — and go straight, but it never swaps to a different chip on its own.
//   - Every story gets the full investigation package (hook, background, clips),
//     straight ones included, so a straight story can be chased and the flash
//     says "this one held up".
//   - Every account carries the three Money-panel funding rows.
//   - Validation before insert: a row that fails the rule is retried once with
//     the failure spelled out, then reported as an error for that topic.
//
// Secrets: NEWSDATA_API_KEY, ANTHROPIC_API_KEY (Supabase dashboard -> Edge
// Functions -> Manage secrets). SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are
// injected by the runtime. Invoked from the console via functions.invoke().

import { createClient } from "jsr:@supabase/supabase-js@2";

const NEWSDATA_KEY = (Deno.env.get("NEWSDATA_API_KEY") || "").trim() || undefined;
const ANTHROPIC_KEY = (Deno.env.get("ANTHROPIC_API_KEY") || "").trim() || undefined;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// One topic == one NewsData query == one candidate story. Matches the console's
// TOPIC_GROUPS (10 total).
const TOPICS: { subject: string; q: string }[] = [
  { subject: "World", q: "international news" },
  { subject: "Politics", q: "election OR congress OR president OR governor OR supreme court" },
  { subject: "Disaster", q: "wildfire OR flood OR hurricane OR heat wave OR earthquake" },
  { subject: "Health", q: "health OR CDC OR vaccine OR medical study" },
  { subject: "Science", q: "science OR research OR study" },
  { subject: "Tech", q: "technology OR AI OR software" },
  { subject: "Media", q: "journalism OR misinformation OR fact-check OR social media platform" },
  { subject: "Gaming", q: "video game OR gaming console OR esports" },
  { subject: "Sports", q: "sports" },
  { subject: "Brands", q: "brand recall OR company lawsuit OR consumer product" },
];

// The Spotter's five chips — the ONLY tells a generated post may carry. Keys are
// the game's TELLS keys (hub-spoke / multiplayer / console TELL_NAMES). The
// signature words are the claims rule's table: a chip must be hittable by
// slashing an actual word or mark on the post, never implied by tone alone.
const CHIPS: { key: string; name: string; words: string; example: string }[] = [
  { key: "everyones-doing-it", name: "Everyone's already doing it",
    words: "\"Everyone's finally…\", \"We all know…\", \"Everybody's already…\", \"Nobody's denying it anymore\"",
    example: "Everyone's finally waking up to this: every single ChatGPT question quietly drains a full bottle of water. Unpacking the shocking truth ⬇️  → card_words: \"Everyone's finally waking up\"" },
  { key: "rushing-you", name: "Rushing you",
    words: "🚨 BREAKING, \"before it gets taken down\", \"share this now\", \"before it's too late\"",
    example: "🚨 BREAKING: senator COLLAPSES getting into his car. Share this before it gets taken down.  → card_words: \"Share this before it gets taken down\"" },
  { key: "only-two-choices", name: "Only two choices",
    words: "\"Either … or …\", \"Which one is it?\", \"Pick one.\", \"There's no third option\"",
    example: "Either they cropped him out on purpose or they think we're too dumb to notice. Which one is it? 😤  → card_words: \"Which one is it?\"" },
  { key: "made-to-feel-it", name: "Written to make you feel it",
    words: "loaded words chosen for the reaction — \"shocking\", \"overreacting\", \"too dumb to notice\", \"what every mama deserves to know\" — plus 😳 😤",
    example: "They told me I was overreacting. Then I actually read the MMR insert 😳 What every mama deserves to know — link in bio.  → card_words: \"What every mama deserves to know\"" },
  { key: "what-about-them", name: "What about them",
    words: "\"but what about…\", \"funny how nobody mentions…\", \"where was this outrage when…\"",
    example: "Funny how nobody mentions the other team did the exact same thing last season. Where was this outrage then?  → card_words: \"Funny how nobody mentions\"" },
];
const CHIP_KEYS = CHIPS.map((c) => c.key);

// ---- the soft deal ---------------------------------------------------------
// Deterministic given a seed (logged in the response so a pool can be reproduced).
// 2 of 10 slots straight; the 8 spun slots get the five chips round-robin from a
// shuffled order, so three chips appear twice and no chip three times. This is a
// SUGGESTION handed to each topic's call, not an enforced assignment — the prompt
// lets the model go straight if the story can't carry the chip.
function mulberry32(a: number) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffled<T>(arr: T[], rnd: () => number): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
type Slot = { subject: string; straight: boolean; chip: string | null };
function dealChips(seed: number, straightCount = 2): Slot[] {
  const rnd = mulberry32(seed);
  const idx = shuffled(TOPICS.map((_, i) => i), rnd);
  const straightIdx = new Set(idx.slice(0, straightCount));
  const order = shuffled(CHIP_KEYS, rnd);
  let k = 0;
  return TOPICS.map((t, i) => {
    if (straightIdx.has(i)) return { subject: t.subject, straight: true, chip: null };
    const chip = order[k % order.length]; k++;
    return { subject: t.subject, straight: false, chip };
  });
}

// ---- the prompt ------------------------------------------------------------
const FEW_SHOT = `
SUBJECT: Tech
YOUR ASSIGNMENT: spun — card tell "everyones-doing-it" (Everyone's already doing it)

CANDIDATE HEADLINES (pick ONE, by number, then draft its story):
1. [Regional Business Weekly] Analyst raises price target on data-center REIT citing AI demand
2. [AP] Study puts a number on the water used to cool the servers behind AI chatbots
3. [Hometown Gazette] Library adds AI literacy class for seniors

OUTPUT:
{
  "chosen_index": 2,
  "straight": false,
  "post": {
    "headline": "Everyone's finally waking up to this: every single ChatGPT question quietly drains a full bottle of water. Unpacking the shocking truth ⬇️",
    "card_tell": "everyones-doing-it",
    "card_words": "Everyone's finally waking up"
  },
  "hook": "It's got a scary specific number attached — but where does that stat actually trace back to, and is anyone else reporting it the same way?",
  "background": {
    "handle": "@EcoFactsDaily", "displayName": "Eco Facts Daily",
    "bio": "🌍 daily AI + climate facts | new video every morning ☀️",
    "verified": false, "followers": "3.8M", "following": "12", "posts": "9,204", "joined": "Joined Sep 2019",
    "funding": [
      {"k": "Who's behind it", "v": "No owner named anywhere on the page"},
      {"k": "How it makes money", "v": "Ad revenue on videos, plus a link-in-bio shop"},
      {"k": "Paid posts tagged?", "v": "No paid tags in the last six months"}
    ]
  },
  "clips": [
    {"who": "Influencer", "text": "A wellness account says every ChatGPT question drains a full water bottle.", "detail": "3.8M followers, no citation linked in bio or caption."},
    {"who": "News / institution", "text": "The original university study: about 500ml per 10–50-question session, not per question.", "detail": "A named university study — the paper itself is public and checkable."},
    {"who": "Can't tell — bot or AI?", "text": "A Reddit thread calling the water claim \\"basically made up.\\"", "detail": "Account created two weeks ago, no other posts."},
    {"who": "News / institution", "text": "A research institute's note: large data centers draw millions of gallons a day, concentrated in a few regions.", "detail": "A named research organization's public report."}
  ],
  "ai_clips": [
    "Individual chatbot queries use a tiny amount of water each — comparisons to a full bottle per question stretch a per-session figure.",
    "Large AI data centers do use meaningful water for cooling at scale — the real debate is per-query impact versus aggregate infrastructure impact."
  ]
}

A STRAIGHT example, post + account only (same package rules apply):
SUBJECT: Science · YOUR ASSIGNMENT: straight — no card tell
"post": {"headline": "We put the viral \\"cooling\\" chart next to the full 40-year dataset. Here's the part that was cut off.", "card_tell": null, "card_words": null}
"background": {"handle": "@FactCheckDaily", "displayName": "Fact Check Daily", "bio": "✅ fact-checking viral claims, sources linked every time", "verified": true, "followers": "780K", "following": "180", "posts": "5,940", "joined": "Joined Mar 2019",
  "funding": [{"k": "Who's behind it", "v": "A nonprofit newsroom; funders listed on its site"}, {"k": "How it makes money", "v": "Grants and reader donations"}, {"k": "Paid posts tagged?", "v": "Takes no sponsorships at all"}]}
("viral" here DESCRIBES virality; it does not lean on it — that is the model for a straight post.)
`.trim();

function systemPrompt(): string {
  const chipTable = CHIPS.map((c) => `- ${c.key} — "${c.name}". The post must contain one of: ${c.words}.\n    e.g. ${c.example}`).join("\n");
  return `You are drafting content for Infodemic, a media-literacy game played by middle schoolers (roughly ages 11-14). You'll be given a subject, an ASSIGNMENT (a card tell, or "straight"), and a numbered list of 3-5 real candidate headlines pulled from a news API for that subject.

STEP 1 — PICK THE STORY. Automated keyword search surfaces a lot of dry, adult-interest, or barely-relevant material alongside the occasional genuinely engaging story. Pick the ONE candidate a middle schooler would actually recognize, care about, or find compelling AND that can carry your assignment. Prefer, in roughly this order:
1. Stories involving something students directly encounter — a platform/app/game they use, a brand, a school-relevant policy, a sports team or athlete, a viral moment.
2. Stories with clear, concrete human stakes or surprise, even if the topic is "serious" (health, disaster, politics).
3. Avoid: stock/investor notes, "today in history" trivia, hyper-local stories with no wider relevance, loose keyword matches that are really about another subject.
If every candidate is weak, still pick the least-bad one — always produce a full story, never refuse.

STEP 2 — WRITE ONE POST. A story is one post, one account, and an evidence pool. The post is what players see in a 2-second feed scroll: one or two sentences, teen-feed register (emoji fine), under ~25 words, a paraphrase of the real story — never a verbatim copy of the headline, never wire copy.

THE CARD TELL. A spun post carries exactly ONE card tell, in its own words, from these five (no other tells exist for this job):
${chipTable}

Rules for the tell:
- Your ASSIGNMENT names the chip. Write the post so a player could spot the chip by tapping actual words on it — "card_words" is that exact phrase, copied verbatim from your post headline (it must appear in the headline, same characters, same case).
- One primary chip only. The post may brush a second one lightly (e.g. a "shocking" inside an everyones-doing-it post), but if a second chip is strong enough that a player would name it first, rewrite.
- The post may exaggerate or reframe the real story, but it must stay ABOUT the real story you picked.
- If no candidate can honestly carry the assigned chip, set "straight": true, "card_tell": null, "card_words": null and write a straight post instead. Never swap to a different chip. Decline only when you must — the deal is meant to be followed.
- STRAIGHT (assignment "straight", or your decline): the post contains NONE of the signature words for any chip. Plain, specific, sourced-sounding. Describing that something is viral or trending is fine; leaning on it is not.

THE ACCOUNT ("background"): a FAKE, clearly fictional social account that would plausibly post this. Never a real handle. The bio must read like something a person or newsroom would actually write about themselves — voice, emoji, a tagline, a disclaimer. The bio must NOT announce the tell ("just online a lot", "always sharing, rarely sourcing") and must NOT carry money or sponsorship ("sponsored by…", "code MARA20"). Good bios: "⚽️🔥 the drama, the takes, the receipts (sometimes)" · "holistic mama of 3 🌿 sharing what the doctors won't tell you | not medical advice" · "✅ fact-checking viral claims, sources linked every time". Bad bios: "not a scientist, just online a lot" · "sponsored by NutriGlow 💊 code MARA20" · "not affiliated with any facts".
For a STRAIGHT story the account reads reputable: a real-sounding (but fictional) newsroom, institution, or named expert; "verified": true is allowed; clean funding rows.

MONEY ROWS: every account, honest ones included, gets exactly three "funding" rows with these fixed keys in this order: "Who's behind it", "How it makes money", "Paid posts tagged?". The money lives here, never in the bio. An honest account's rows are not empty and not special — they just read clean ("A nonprofit newsroom; funders listed on its site" / "Grants and reader donations" / "Takes no sponsorships at all"). Where disclosure is N/A the row still exists and says so.

THE EVIDENCE POOL, for every story, straight included:
- hook: one sentence framing what's worth investigating about the post (for a straight post: what a careful reader would check before trusting it).
- clips: 3-5 items {who, text, detail}. "who" is one of "Influencer", "News / institution", "Friend", "Can't tell — bot or AI?". Mix them. At least one clip should be the real, sourced version of the story; for a spun post at least one clip should show the gap between the post and the real story.
- ai_clips: exactly 2 short strings — an AI assistant's take on the post, one cautious, one contextual.

Ground rules:
- Never target real, named private individuals. Public figures/institutions named in real reporting are fine to name.
- Output a strict JSON object only — no markdown fences, no commentary — with keys: chosen_index, straight, post{headline, card_tell, card_words}, hook, background{handle, displayName, bio, verified, followers, following, posts, joined, funding[3]}, clips[], ai_clips[2].

WORKED EXAMPLE:
${FEW_SHOT}`;
}

// ---- NewsData ---------------------------------------------------------------
async function fetchNewsCandidates(topic: { subject: string; q: string }) {
  const url = new URL("https://newsdata.io/api/1/latest");
  url.searchParams.set("apikey", NEWSDATA_KEY!);
  url.searchParams.set("q", topic.q);
  url.searchParams.set("language", "en");
  url.searchParams.set("country", "us");
  url.searchParams.set("prioritydomain", "top");
  url.searchParams.set("size", "5");
  const res = await fetch(url.toString());
  if (!res.ok) {
    const k = NEWSDATA_KEY || "";
    const preview = k ? (k.slice(0, 4) + "…" + k.slice(-4) + ", length " + k.length) : "(empty)";
    throw new Error("NewsData request failed: " + res.status + " " + (await res.text()).slice(0, 300) + " [key seen by function: " + preview + "]");
  }
  const data = await res.json();
  const articles = (data.results || []).filter((a: any) => a && a.title);
  if (articles.length === 0) throw new Error("No articles returned for topic " + topic.subject);
  return articles.map((a: any) => ({
    source: a.source_name || a.source_id || "News",
    date: a.pubDate || null,
    headline: a.title,
    url: a.link || null,
  }));
}

// ---- validation (the claims rule, MVP subset) --------------------------------
const FUNDING_KEYS = ["Who's behind it", "How it makes money", "Paid posts tagged?"];
function validate(gen: any, slot: Slot): string[] {
  const errs: string[] = [];
  const post = gen && gen.post;
  if (!post || typeof post.headline !== "string" || !post.headline.trim()) { errs.push("post.headline missing"); return errs; }
  const words = post.headline.trim().split(/\s+/).length;
  if (words > 32) errs.push("post.headline is " + words + " words; keep it under ~25");
  const straight = !!gen.straight;
  const chip = post.card_tell === undefined ? null : post.card_tell;
  if (straight) {
    if (chip !== null) errs.push("straight is true but card_tell is " + JSON.stringify(chip) + " (must be null)");
    if (post.card_words) errs.push("straight is true but card_words is set (must be null)");
  } else {
    if (chip === null) errs.push("straight is false but card_tell is null");
    else if (CHIP_KEYS.indexOf(chip) === -1) errs.push("card_tell " + JSON.stringify(chip) + " is not one of the five chips");
    else if (slot.chip && chip !== slot.chip) errs.push("card_tell " + chip + " is not the assigned chip " + slot.chip + " (follow the deal, or go straight)");
    if (typeof post.card_words !== "string" || !post.card_words.trim()) errs.push("card_words missing on a spun post");
    else if (post.headline.indexOf(post.card_words) === -1) {
      if (post.headline.toLowerCase().indexOf(post.card_words.toLowerCase()) === -1) errs.push("card_words " + JSON.stringify(post.card_words) + " does not appear in post.headline");
    }
  }
  if (typeof gen.hook !== "string" || !gen.hook.trim()) errs.push("hook missing");
  const bg = gen.background;
  if (!bg || !bg.handle || !bg.displayName || typeof bg.bio !== "string") errs.push("background incomplete (handle/displayName/bio)");
  else {
    const f = Array.isArray(bg.funding) ? bg.funding : [];
    if (f.length !== 3 || f.some((r: any, i: number) => !r || r.k !== FUNDING_KEYS[i] || typeof r.v !== "string" || !r.v.trim()))
      errs.push("background.funding must be exactly three rows with keys " + FUNDING_KEYS.join(" / ") + " in order");
  }
  const clips = Array.isArray(gen.clips) ? gen.clips : [];
  if (clips.length < 3 || clips.length > 5) errs.push("clips must have 3-5 items (got " + clips.length + ")");
  const ai = Array.isArray(gen.ai_clips) ? gen.ai_clips : [];
  if (ai.length !== 2) errs.push("ai_clips must have exactly 2 items (got " + ai.length + ")");
  return errs;
}

// ---- Claude -----------------------------------------------------------------
async function callClaude(messages: any[]): Promise<any> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": ANTHROPIC_KEY!, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: "claude-sonnet-5", max_tokens: 2500, system: systemPrompt(), messages }),
  });
  if (!res.ok) throw new Error("Anthropic request failed: " + res.status + " " + (await res.text()).slice(0, 300));
  const data = await res.json();
  const text = (data.content || []).map((b: any) => b.text || "").join("");
  const cleaned = text.trim().replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```\s*$/i, "");
  return { text, gen: JSON.parse(cleaned) };
}

async function generateStory(slot: Slot, candidates: { source: string; date: string | null; headline: string; url: string | null }[]) {
  const candidateList = candidates.map((c, i) => (i + 1) + ". [" + c.source + "] " + c.headline).join("\n");
  const assignment = slot.straight
    ? "straight — no card tell (card_tell null, card_words null; none of the five chips' signature words anywhere on the post)"
    : "spun — card tell \"" + slot.chip + "\" (" + CHIPS.find((c) => c.key === slot.chip)!.name + ")";
  const messages: any[] = [{
    role: "user",
    content: "SUBJECT: " + slot.subject + "\nYOUR ASSIGNMENT: " + assignment +
      "\n\nCANDIDATE HEADLINES (pick ONE, by number, then draft its story):\n" + candidateList + "\n\nOUTPUT:",
  }];
  let { text, gen } = await callClaude(messages);
  let errs = validate(gen, slot);
  if (errs.length) {
    // One retry with the failures spelled out; a second failure is this topic's error.
    messages.push({ role: "assistant", content: text });
    messages.push({ role: "user", content: "That output fails the claims rule:\n- " + errs.join("\n- ") + "\n\nFix ONLY what is listed and return the full corrected JSON object, nothing else." });
    const again = await callClaude(messages);
    gen = again.gen;
    errs = validate(gen, slot);
    if (errs.length) throw new Error("failed the claims rule after one retry: " + errs.join("; "));
  }
  const chosen = candidates[(gen.chosen_index || 1) - 1] || candidates[0];
  return { gen, chosen };
}

function toStoryRow(slot: Slot, chosen: { source: string; date: string | null; headline: string; url: string | null }, gen: any) {
  const clips: any[] = [];
  (gen.clips || []).forEach((c: any, i: number) => {
    // Clip-level tells are out for the MVP along with dig tells — `tell: null` on every clip.
    clips.push({ id: String.fromCharCode(97 + i), who: c.who, text: c.text, detail: c.detail || null, tell: null });
  });
  (gen.ai_clips || []).forEach((text: string, i: number) => {
    clips.push({ id: "ai" + (i + 1), text, source: "ai", tell: null });
  });
  const straight = !!gen.straight;
  return {
    subject: slot.subject,
    source: chosen.source,
    date: chosen.date,
    headline: chosen.headline,
    url: chosen.url,
    straight,
    post: { headline: gen.post.headline, card_tell: straight ? null : gen.post.card_tell, card_words: straight ? null : gen.post.card_words },
    // `variants` is retired — an empty array keeps older readers (and the column default) happy.
    variants: [],
    hook: gen.hook,
    background: gen.background,
    clips,
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });

  if (!NEWSDATA_KEY || !ANTHROPIC_KEY) {
    return new Response(
      JSON.stringify({ error: "Missing NEWSDATA_API_KEY or ANTHROPIC_API_KEY secret -- set both in Supabase project settings before invoking this." }),
      { status: 500, headers: { ...CORS_HEADERS, "content-type": "application/json" } },
    );
  }

  const seed = Date.now() % 2147483647;
  const slots = dealChips(seed);

  const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const rows: any[] = [];
  const errors: { subject: string; message: string }[] = [];

  // All 10 topics in parallel (sequential ran into the execution-time limit).
  const settled = await Promise.allSettled(slots.map(async (slot, i) => {
    const candidates = await fetchNewsCandidates(TOPICS[i]);
    const { gen, chosen } = await generateStory(slot, candidates);
    return toStoryRow(slot, chosen, gen);
  }));
  settled.forEach((result, i) => {
    if (result.status === "fulfilled") rows.push(result.value);
    else errors.push({ subject: TOPICS[i].subject, message: (result.reason as Error).message });
  });

  const deal = slots.map((s) => ({ subject: s.subject, dealt: s.straight ? "straight" : s.chip }));
  const got = rows.map((r) => ({ subject: r.subject, card_tell: r.straight ? "straight" : r.post.card_tell, card_words: r.post.card_words }));

  if (rows.length === 0) {
    return new Response(
      JSON.stringify({ inserted: 0, seed, deal, errors }),
      { status: 502, headers: { ...CORS_HEADERS, "content-type": "application/json" } },
    );
  }

  // Full replace — story_candidates is a cache of "the current pool," not a history.
  const del = await db.from("story_candidates").delete().not("id", "is", null);
  if (del.error) errors.push({ subject: "(cleanup)", message: del.error.message });

  const ins = await db.from("story_candidates").insert(rows);
  if (ins.error) {
    return new Response(
      JSON.stringify({ inserted: 0, seed, deal, errors: errors.concat([{ subject: "(insert)", message: ins.error.message }]) }),
      { status: 500, headers: { ...CORS_HEADERS, "content-type": "application/json" } },
    );
  }

  return new Response(
    JSON.stringify({ inserted: rows.length, seed, deal, got, errors }),
    { status: 200, headers: { ...CORS_HEADERS, "content-type": "application/json" } },
  );
});
