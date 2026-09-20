// Supabase Edge Function: generate-drop-candidates — v13 "headlines first" (2026-09-20)
//
// v13 vs v12 (generator-headlines-first build brief 9/20; Tara: "it's not realistic each pull to
// be $1 — maybe only generate headlines and clues once it's been selected for the round"):
//   - THE PULL IS TWO STEPS. POST {mode: "headlines"} (also the default for an empty body, so an
//     old console still works): NewsData only, NO model call. All 5 candidates per topic are
//     APPENDED to story_candidates as status='headline' rows, deduped on url. The teacher picks
//     the story now, not the model.
//     POST {mode: "package", ids: [uuid, …]}: for each id the row is claimed (status='writing'),
//     ONE package is generated for that one headline, and the v12 row fields are written back onto
//     the SAME row with status='ready' (+ model, generated_at). A failure leaves status='failed'
//     and the validator's message in package_error. {force: true} re-claims a row stuck in
//     'writing' (the function was killed mid-call). A 'ready' row is never rewritten.
//   - PACKAGES ARE KEPT. Nothing here deletes a row (Tara 9/20 on stale stories: "just leave
//     them"). {mode: "headlines", prune_days: n} is an opt-in that removes ONLY status='headline'
//     rows older than n days; nothing calls it today.
//   - THE DEAL MOVES TO PULL TIME. dealTells(seed) still deals 8 spun / 2 straight across the 10
//     topics; the result is written to every headline row's `dealt`, so the console shows the tell
//     before any package exists. The weak-clue lens is derived from the row id at package time.
//   - PROMPT CACHING: the shared system prompt is sent as a block with cache_control (GA, no beta
//     header). meta carries cache_read_input_tokens / cache_creation_input_tokens.
//   - VALIDATOR: the model echoes "chosen_headline" and it must equal the candidate it says it
//     picked (9/20 head-to-head: a post written about a different story than the one reported).
//     TELL_OFF_RE gains the self-narrating phrases both models slipped past it.
//   - THE 150s LIMIT (free plan): every model call carries a deadline (138s into the request) and
//     aborts itself there; the fix-up retry is skipped when under 65s remain. Either way the row is
//     marked 'failed' with a plain message instead of sticking in 'writing'. Measured 9/20: one
//     package call ran past 150s and the platform killed it mid-write.
//   - {dry: true, …} is unchanged: the v12 path (model picks among the topic's candidates), writes
//     nothing.
//
// Everything below about tells, receipts, looks and the mix is v12 and unchanged:
// v12 vs v11 (evidence-clues build brief 9/17 Part 2 + 9/18 addenda; claims-rule-brief-v2
// Part 2 for the deal; tells interview 9/17 for the six lenses):
//   - THE DEAL is the SIX TikTok-Age tells, not the Spotter's five chips. `dealTells(seed)`:
//     8 spun slots, 2 straight (Tara 9/18: "do more spun"). The six tells are dealt once each,
//     then two repeat, so a feed CAN carry a repeated primary — the console warns. The model may
//     still decline to straight ("this story can't carry it"), never swap. `delay` is dealt
//     like the others but the prompt says to decline unless the story has a problem + a fix.
//     `media` and `synthetic` are scrapped (tells interview) — never dealt, never emitted.
//   - ONE planted tell per story, with a RECEIPT the client already renders:
//       feel → the article (plainer wording) + `plain` twin + `swaps` for 🔁 Say it plain
//       grift → `background.shop` (link-in-bio page) + the Background check
//       viral → `background.versions` (version history + buried correction)
//       coordination → a `samephrase` search-results clip
//       joke → the Background check (name, handle AND bio say satire)
//       delay → the article (the fix is real and underway)
//     The row carries `post.planted = {tell, receipts, why}` in the hub-spoke CLAIMS shape.
//   - THE CLUE POOL: alongside the article / Background / reddit / Ask AI, each story gets 3–4
//     clues in the four 1c looks — official (doc), outlet (page), explainer (page), creator (vid)
//     — in EXACTLY the shapes `CLIPS` in infodemic-hub-spoke-prototype.html renders. Each clue
//     carries `strength` ("strong"|"weak") and `weak_reason` (null iff strong) as AUTHORING
//     METADATA ONLY: the console shows them to Tara; the mapper strips them before anything
//     reaches the game client. `kind`/`who` name the FORMAT only (document / news site /
//     explainer / video) — never the trust (Tara 9/18: "official alert" was a giveaway).
//   - THE MIX: straight story → 0–1 weak clue. Tell story → 2–3 weak, ≥2 strong. ≤1 off_topic.
//     Weak reasons vary across the pool (the deal hands each spun slot a suggested lens for
//     one of its weak clues so `no_proof` isn't dealt five times).
//   - `card_tell` / `card_words` stay in `post` as null so older readers don't break.
//     `variants: []` likewise.
//
// Unchanged from v11: NewsData pull (photo-first, media kept), the account/bio/money rules,
// the one-retry loop with failures spelled out. (v12's full replace of story_candidates is GONE.)
//
// Secrets: NEWSDATA_API_KEY, ANTHROPIC_API_KEY, optional GENERATOR_MODEL (Supabase dashboard ->
// Edge Functions -> Manage secrets). SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are injected by the runtime.

import { createClient } from "jsr:@supabase/supabase-js@2";

const NEWSDATA_KEY = (Deno.env.get("NEWSDATA_API_KEY") || "").trim() || undefined;
const ANTHROPIC_KEY = (Deno.env.get("ANTHROPIC_API_KEY") || "").trim() || undefined;
// 9/20 (Tara: cheaper + faster): the model is a Supabase secret, GENERATOR_MODEL, so a smaller
// model can be tried on one pull from the dashboard without a redeploy. Unset = the v11 default.
// The validator is the safety net: a weaker model trips it more often (one retry, then the topic
// errors out), so the failure mode is a thinner pool, never a broken row.
const DEFAULT_MODEL = "claude-sonnet-5";
// 7000 -> 10000 (9/20): a package reply was cut off at 7000. At ~85 tokens/s 10000 is ~118s, still inside the deadline.
const MAX_TOKENS = parseInt((Deno.env.get("GENERATOR_MAX_TOKENS") || "").trim(), 10) || 10000;
// GENERATOR_THINKING=off sends thinking:{type:"disabled"}. Unset = the API's default for the model.
const THINKING = (Deno.env.get("GENERATOR_THINKING") || "").trim().toLowerCase();
// GENERATOR_EFFORT=low|medium|high sends output_config:{effort} — the soft cap on how much the model thinks (there is no token budget on current models).
const EFFORT = (Deno.env.get("GENERATOR_EFFORT") || "").trim().toLowerCase();
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
type Tune = { max_tokens?: number; thinking?: string; effort?: string };
function tuneFrom(body: any): Tune {
  const mt = body && typeof body.max_tokens === "number" ? Math.min(16000, Math.max(1000, Math.floor(body.max_tokens))) : MAX_TOKENS;
  const th = body && typeof body.thinking === "string" ? body.thinking.toLowerCase() : THINKING;
  const ef = body && typeof body.effort === "string" ? body.effort.toLowerCase() : EFFORT;
  return { max_tokens: mt, thinking: th, effort: EFFORTS.indexOf(ef) === -1 ? "" : ef };
}
const MODEL = (Deno.env.get("GENERATOR_MODEL") || "").trim() || DEFAULT_MODEL;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// One topic == one NewsData query == one candidate story. Matches the console's TOPIC_GROUPS.
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

// ---- the six tells ------------------------------------------------------------
// Ids are the game's TELLS keys (hub-spoke `TELLS`, the note's checkboxes, the reveal).
// Labels are draft copy (Abbie has not reviewed) — nothing keys off a label.
// `receipts` are the client-side clip ids WITHOUT the "-<claimId>" suffix; the mapper adds it.
type TellId = "feel" | "grift" | "viral" | "coordination" | "joke" | "delay";
const TELLS: { id: TellId; label: string; receipts: string[]; guidance: string }[] = [
  { id: "feel", label: "It's written to make you feel it", receipts: ["art"],
    guidance: `THE POST: a charged word where a plain one would do (quietly, admits, slams, dumps, cracks down, exposed); wording bigger than the story (one company → "the whole industry", drops the exception or scope detail); someone to blame with nothing to check. Feeling being present is NOT the tell — a sad story told straight is straight.
THE RECEIPT is the article's plainer wording next to the post. Emit: "plain" — the same facts in the article's register, no feeling — and 3–5 "swaps" [{hot, plain, why}] where every "hot" is copied VERBATIM from your post headline (same characters, same case; an emoji-led phrase like "🚨 BREAKING" is fine). "plain" in a swap may be "" when the phrase should just be deleted. "why" is ≤ 9 words in a kid's voice ("picked for the feeling, not the forecast").` },
  { id: "grift", label: "Somebody gets paid if I believe it", receipts: ["shop", "bg"],
    guidance: `Decide WHAT THE ACCOUNT SELLS FIRST, then derive its name, handle, bio, money rows and the post from that — they must all cohere. The post leans the story toward needing the product and NEVER names the product. Money stays off the card and out of the bio; the bio may hint at a link ("🔗 below").
THE RECEIPT is the Background check: "How it makes money" names the shop; and background.shop = {url (a linktr.ee-style address), links: [{t, hot}] ×2–3 with exactly ONE hot:true (the product), item: {name, pitch, price}} — the pitch only makes sense if the post is true ("Before a robot takes your shift" · 4.9★).` },
  { id: "viral", label: "It's made to go viral", receipts: ["ver"],
    guidance: `THE POST wears a wrapper that would work on ANY story: 🚨 BREAKING, "stop scrolling", "I wasn't going to post this", "share before it's deleted", "as a teacher…", "I did the research so you don't have to", "is it a coincidence that…", a ⬇️ cliffhanger. Test: lift the story out, drop another in, the post still works.
THE RECEIPT is the account's version history: background.versions = {label: "this claim · N tries this month", rows: [{t, d, n}] ×3–4 — the SAME claim posted milder → wilder over the last two weeks, "n" = views climbing with the exaggeration ("380", "9.1K", "2.1M", "14M"), the last row is your post (d ends "· pinned") — and correction: {who: "<handle> (creator)", text (a buried comment that walks it back a little), likes (small), views (the pinned post's), edited: "No"}}. You may wrap the escalating words in <mark>…</mark> inside "t".` },
  { id: "coordination", label: "Everyone started saying it at the same time", receipts: ["phr"],
    guidance: `Identical wording + tight timing + no visible shared source. Straight contrast: wire copy, credited quotes, memes whose wording drifts.
THE POST contains one 6–10-word sentence or clause that reads like a script line. THE RECEIPT is a same-phrase search: same_phrase = {q: "\\"<that exact phrase>\\" <topic word>", hits: [{h, t, d}] ×4–6} — the FIRST hit is your own account repeating the post; the rest are 3–5 other fictional accounts posting the exact phrase (in "t", wrap the phrase in <mark>…</mark>) within two days, none linking to the report. "d" is a short date ("Sep 13").` },
  { id: "joke", label: "It's a joke", receipts: ["bg"],
    guidance: `Satire ONLY ("just asking" is not this tell). The post is a deadpan joke about the real story that a kid seeing only the post could take as news. The account is clearly satire ON INSPECTION: displayName, handle AND bio all say so (e.g. "The Daily Turnip" · "@dailyturnip_satire" · "Parody. None of this happened. 🥔"). The money rows read like a comedy site's (merch, ads).
THE RECEIPT is the Background check itself (no extra data). The real article is the contrast.` },
  { id: "delay", label: "It says the fix is pointless", receipts: ["art"],
    guidance: `DEAL THIS ONLY IF the story contains a PROBLEM PLUS A FIX OR RESPONSE (a rule, a recall, a cleanup, a policy, a study prompting action). If none of the candidates does, DECLINE TO STRAIGHT.
THE POST concedes the fact and shrugs at the fix — too late; won't make a difference; someone else should go first; the fix is worse (no specifics); people will just get around it. It never says the thing isn't real. A specific, checkable criticism of the fix is NOT the tell; a blanket shrug is.
THE RECEIPT is the article: it shows the fix working or underway. Write article.receipt as that line.` },
];
const TELL_IDS = TELLS.map((t) => t.id);
const TELL_BY_ID: Record<string, typeof TELLS[number]> = {};
TELLS.forEach((t) => { TELL_BY_ID[t.id] = t; });

// ---- the clue pool ------------------------------------------------------------
// The four 1c looks and the EXACT client shapes (CLIPS in infodemic-hub-spoke-prototype.html).
// `kind`/`who` are set mechanically per look — the model never writes them.
type Look = "official" | "outlet" | "explainer" | "creator";
const LOOKS: Record<Look, { who: string; kind: string; dataKey: "doc" | "page" | "vid"; required: string[]; shape: string; strong: string; weak: string }> = {
  official: { who: "Document", kind: "document", dataKey: "doc", required: ["issuer", "about", "url", "title", "date", "lines"],
    shape: `"doc": {"issuer", "about" (one line: what kind of body this is), "url" (no scheme, e.g. "weather.gov/okx/flash-flood-warning"), "title", "date" (e.g. "Issued Sun, Sep 13, 2026 · 9:12 AM" or "Press release · Sep 13, 2026" or "Published Sep 9, 2026"), "lines": [2–3 strings — the actual rule, finding, method or limitation, in the document's own voice], "quote": {"t", "by"} (optional — a press release's CEO quote)}`,
    strong: `an official or primary document: the agency's warning, the study itself, the policy PDF, the court filing, the company's own filing — issuing body, date, and 2–3 lines of the actual rule or finding, including the scope or limit the post dropped.`,
    weak: `a press release: same document frame, but the issuer is a company or vendor, "about" says so, the date line says "Press release · …", the lines carry "early results" / "strong interest", and the body is a quote from its chief executive. (weak_reason "gain")` },
  outlet: { who: "News site", kind: "news site", dataKey: "page", required: ["mast", "domain", "url", "kicker", "headline", "by", "date", "body", "hl"],
    shape: `"page": {"mast" (a fictional outlet name), "domain", "url", "kicker" ("Local · Weather"), "headline", "by" (byline — "" for none), "date" ("Sep 13, 2026 · 2:40 PM"), "body" (one sentence before the highlight), "hl" (the ONE highlighted sentence — the detail this outlet adds), "after" (one sentence after; optional)}`,
    strong: `another outlet's coverage with a named byline, a date, and ONE highlighted sentence adding the detail the post dropped — a number, a scope ("pilot at 2 schools"), an end time, an exception, a named spokesperson.`,
    weak: `an aggregator: trend-y masthead ("TrendWire", "BuzzPulse"), "by" is "", the body is filler ("It's the story everyone is talking about."), and "hl" REPEATS THE POST'S OWN WORDING nearly verbatim with no reporting behind it. (weak_reason "no_proof")` },
  explainer: { who: "Explainer", kind: "explainer", dataKey: "page", required: ["mast", "domain", "url", "kicker", "headline", "by", "date", "claim", "body", "links"],
    shape: `"page": {"mast", "domain", "url", "kicker": "Explainer", "headline" (a question), "by" ("" for none), "date", "claim" (the claim it examines, in quotes), "body" (2–3 sentences of what it found), "links": [{"t", "d"}] — the sources it links, as chips ("CNN report" · "Sep 13"); [] for none}`,
    strong: `a fact-check / explainer that names what it checked and LINKS it: 2–3 link chips (the study, the agency page, the original report), a named author, and a body that says plainly what the evidence can and can't show.`,
    weak: `an explainer with "experts agree", "studies show", "insiders say", "many people report" — no names, no numbers, and "links": []. Reads confident, shows no work. (weak_reason "no_proof")` },
  creator: { who: "Video", kind: "video", dataKey: "vid", required: ["handle", "name", "caption", "views", "ago", "shows"],
    shape: `"vid": {"handle" ("@kayla.commutes"), "name" (first name or "Sam · nursing student"), "caption" (teen register, ≤ 30 words), "views" ("48.2K"), "ago" ("3h", "1d"), "shows" (one sentence: what is ON SCREEN, stated positively — what is shown, never what is missing), "hue": 0–360}`,
    strong: `a creator who shows the thing: holds up the actual document or letter, films the actual place or object (the one robot behind the PILOT AREA fence), reads the limits section out loud. "shows" describes the document/place on screen.`,
    weak: `someone talking to the camera about a cousin / a friend / "my school" / "my mom" — a single secondhand story told as if it were the news. "shows" is the person talking. (weak_reason "one_story")` },
};
const LOOK_KEYS = Object.keys(LOOKS) as Look[];
const WEAK_REASONS = ["gain", "one_story", "no_proof", "off_topic", ...TELL_IDS];

// ---- the deal --------------------------------------------------------------------
// Deterministic given a seed (logged in the response so a pool can be reproduced).
// 8 of 10 slots spun, 2 straight (Tara 9/18: "do more spun"). The shuffled six tells are dealt
// round-robin, so every tell is a primary at least once and two of them twice; the console's
// duplicate-primary warning covers a feed that picks both. Each spun slot also gets a suggested
// lens for one of its weak clues so the weak reasons vary across the pool.
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
type Slot = { subject: string; straight: boolean; primary: TellId | null; weakLens: string | null };
const STRAIGHT_SLOTS = 2;
function dealTells(seed: number, straightCount = STRAIGHT_SLOTS): Slot[] {
  const rnd = mulberry32(seed);
  const idx = shuffled(TOPICS.map((_, i) => i), rnd);
  const spunIdx = idx.slice(0, TOPICS.length - straightCount);
  const order = shuffled(TELL_IDS, rnd);
  const slots: Slot[] = TOPICS.map((t) => ({ subject: t.subject, straight: true, primary: null, weakLens: null }));
  spunIdx.forEach((topicIndex, k) => {
    const primary = order[k % order.length];
    // A weak clue written through a lens other than the story's own primary: the NEXT tell in the
    // shuffled deal order, so consecutive slots get different lenses and none equals its primary.
    const lens: TellId = order[(k + 1) % order.length];
    slots[topicIndex] = { subject: TOPICS[topicIndex].subject, straight: false, primary, weakLens: lens };
  });
  return slots;
}

// ---- the prompt ------------------------------------------------------------------
const FEW_SHOT = `
SUBJECT: Tech
YOUR ASSIGNMENT: spun — planted tell "grift" (Somebody gets paid if I believe it). Suggested lens for one weak clue: "feel".

CANDIDATE HEADLINES (pick ONE, by number, then draft its story):
1. [Regional Business Weekly] [no photo] Analyst raises price target on data-center REIT citing AI demand
2. [Interesting Engineering] [photo] 7 humanoid robot makers taking over real-world factories
3. [Hometown Gazette] [no photo] Library adds AI literacy class for seniors

OUTPUT:
{
  "chosen_index": 2,
  "chosen_headline": "7 humanoid robot makers taking over real-world factories",
  "straight": false,
  "post": {
    "headline": "Factories are quietly swapping workers for humanoid robots and nobody's stopping it 🤖 If your job is on a line, read this before it's yours.",
    "plain": null,
    "swaps": []
  },
  "planted_why": "the link in bio sells an 'AI-proof your career' course — the product needs the panic to be true",
  "article": {
    "kicker": "AI & Robotics",
    "receipt": "seven companies, 'developing' — pilots, not a swap"
  },
  "hook": "Which factories, how many robots, doing what jobs — the post makes it sound universal. And check what's in the bio.",
  "background": {
    "handle": "@FutureShockNow", "displayName": "Future Shock Now",
    "bio": "🤖 tech that's coming for your job (allegedly) | tips welcome | 🔗 AI-proof yourself below",
    "verified": false, "followers": "612K", "following": "301", "posts": "4,110", "joined": "Joined Jan 2021",
    "funding": [
      {"k": "Who's behind it", "v": "Run by two anonymous tech bloggers, per their own FAQ page"},
      {"k": "How it makes money", "v": "Affiliate links in bio and ad revenue — the bio links to a $149 course"},
      {"k": "Paid posts tagged?", "v": "No paid tags found in recent posts"}
    ],
    "shop": {"url": "linktr.ee/futureshocknow",
             "links": [{"t": "🎬 Watch: the robot takeover, explained", "hot": false}, {"t": "🎓 AI-PROOF YOUR CAREER — the course", "hot": true}, {"t": "📩 Join 30K on the newsletter", "hot": false}],
             "item": {"name": "AI-Proof Your Career (video course)", "pitch": "\\"Before a robot takes your shift\\" · 4.9★", "price": "$149"}}
  },
  "clues": [
    {"look": "official", "strength": "weak", "weak_reason": "gain", "name": "Axon Robotics",
     "text": "Axon Robotics press release: early results from its humanoid robots, and its CEO says they are changing the factory floor.",
     "doc": {"issuer": "Axon Robotics", "about": "Maker of humanoid robots for factories and warehouses", "url": "axonrobotics.com/press/pilot-results", "title": "Early results from factory pilot programs", "date": "Press release · Sep 10, 2026",
             "lines": ["Axon robots are now working at three customer sites. Early results show strong interest from plant managers."],
             "quote": {"t": "Our humanoids are already changing the factory floor. Every manufacturer will need them.", "by": "Axon's chief executive"}}},
    {"look": "outlet", "strength": "weak", "weak_reason": "feel", "name": "TrendWire",
     "text": "TrendWire: \\"Factories are quietly swapping workers for humanoid robots.\\"",
     "page": {"mast": "TrendWire", "domain": "trendwire.co", "url": "trendwire.co/tech/humanoid-robots-factories", "kicker": "Tech · Trending", "headline": "Factories are quietly swapping workers for humanoid robots", "by": "", "date": "Sep 13, 2026",
              "body": "It's the story everyone is talking about.", "hl": "Factories are quietly swapping workers for humanoid robots, and nobody's stopping it.", "after": "Posts about the robots have been shared millions of times this week."}},
    {"look": "explainer", "strength": "strong", "weak_reason": null, "name": "Plant Floor Weekly",
     "text": "Plant Floor Weekly explainer: counts the robots at each of the seven companies. Most are pilots of a few dozen robots at one plant.",
     "page": {"mast": "Plant Floor Weekly", "domain": "plantfloorweekly.com", "url": "plantfloorweekly.com/explainers/humanoid-robot-count", "kicker": "Explainer", "headline": "How many humanoid robots are working in factories?", "by": "Marcus Bell", "date": "Sep 14, 2026",
              "claim": "\\"Factories are swapping workers for humanoid robots.\\"", "body": "We asked all seven companies on the list. Five answered. Most run pilot programs: a few dozen robots at one plant, moving bins and parts. None reported layoffs tied to the robots.",
              "links": [{"t": "Interesting Engineering list", "d": "Sep 13"}, {"t": "Company answers (5 of 7)", "d": "PDF"}, {"t": "U.S. factory jobs data", "d": "Aug 2026"}]}},
    {"look": "creator", "strength": "strong", "weak_reason": null, "name": "@dee.on.the.line",
     "text": "@dee.on.the.line films the one humanoid robot at her plant. It carries bins behind a fence marked PILOT AREA.",
     "vid": {"handle": "@dee.on.the.line", "name": "Dee", "caption": "everyone keeps asking so here's THE robot at our plant. one. it moves bins. that's the whole job.", "views": "212K", "ago": "2d", "shows": "A humanoid robot carrying a bin behind a yellow safety fence. A sign on the fence reads PILOT AREA.", "hue": 265}}
  ],
  "reddit": {"strength": "weak", "weak_reason": "no_proof", "text": "A post amplifying the claim with a stock photo of a robot that doesn't match any real factory.", "detail": "Account has no posting history before this week."},
  "same_phrase": null,
  "ai_clips": [
    "A handful of companies are piloting humanoid robots in specific tasks — that's very different from robots already running factories broadly.",
    "Humanoid robots in manufacturing are a real and growing trend, but current deployment is small-scale and experimental, not a full workforce swap yet."
  ]
}

A STRAIGHT example, the parts that differ (same package rules apply — the clue pool is still 3–4 clues, at most ONE weak):
SUBJECT: Health · YOUR ASSIGNMENT: straight — no planted tell
"post": {"headline": "New animal study links prenatal Tylenol exposure to changes in daughters' reproductive organs. Researchers say more work is needed before drawing conclusions for humans.", "plain": null, "swaps": []}
"planted_why": null
"article": {"kicker": "Nation & World · Health", "receipt": "the article carries the limits the post carries"}
"background": {"handle": "@HealthLineReport", "displayName": "HealthLine Report", "bio": "Health & medical research news, plain-language summaries with links to the original studies", "verified": true, "followers": "612K", "following": "240", "posts": "8,102", "joined": "Joined Jan 2015",
  "funding": [{"k": "Who's behind it", "v": "A digital health-news outlet; editorial staff listed on its masthead"}, {"k": "How it makes money", "v": "Display advertising and a subscriber newsletter"}, {"k": "Paid posts tagged?", "v": "Sponsored content is labeled when it runs"}]}
"clues": an "official" doc = the study itself (journal, "Published Sep 9, 2026", lines: methods / results / "Limitations: an animal study. It does not show that the drug causes these changes in people."), a strong "outlet" ("The work was done in rats, and the two doses that showed changes were higher than most people take."), a strong "explainer" by "Dr. Renee Walsh, pharmacist" with three link chips, and a strong "creator" — "@nursing.with.sam holds up the printed study and reads the limits section out loud."
"reddit": {"strength": "weak", "weak_reason": "no_proof", "text": "A repost of the headline with 'doctors don't want you to know this' added.", "detail": "Account has no history before this week."}
`.trim();

function systemPrompt(): string {
  const tellTable = TELLS.map((t) => `### ${t.id} — "${t.label}"\n${t.guidance}`).join("\n\n");
  const lookTable = LOOK_KEYS.map((k) => {
    const l = LOOKS[k];
    return `### look "${k}"\n- STRONG: ${l.strong}\n- WEAK: ${l.weak}\n- Emit ${l.shape}`;
  }).join("\n\n");
  return `You are drafting content for Infodemic, a media-literacy game played by middle schoolers (roughly ages 11-14). You'll be given a subject, an ASSIGNMENT (a planted tell, or "straight"), and a numbered list of 3-5 real candidate headlines pulled from a news API for that subject.

STEP 1 — PICK THE STORY. Automated keyword search surfaces a lot of dry, adult-interest, or barely-relevant material alongside the occasional genuinely engaging story. Pick the ONE candidate a middle schooler would actually recognize, care about, or find compelling AND that can carry your assignment. Prefer, in roughly this order:
1. Stories involving something students directly encounter — a platform/app/game they use, a brand, a school-relevant policy, a sports team or athlete, a viral moment.
2. Stories with clear, concrete human stakes or surprise, even if the topic is "serious" (health, disaster, politics).
3. Avoid: stock/investor notes, "today in history" trivia, hyper-local stories with no wider relevance, loose keyword matches that are really about another subject.
If every candidate is weak, still pick the least-bad one — always produce a full story, never refuse. The post is shown over the article's photo, so prefer a [photo] candidate when the choice is close.

STEP 2 — WRITE THE STORY PACKAGE. A story is one post, one account, one real article, and a pool of clues. The post is what players see in a 2-second feed scroll: one or two sentences, teen-feed register (emoji fine), under ~25 words, a paraphrase of the real story — never a verbatim copy of the headline, never wire copy. Players open the real article in Round 2, so the post must stay ABOUT the article you picked.

THE PLANTED TELL. A spun story plants exactly ONE of these six tells — the one your ASSIGNMENT names. A tell is a property of the whole package, and every planted tell has a RECEIPT: something a kid can go find that pays it off. Lean subtle, low-stakes, never outright false: the post exaggerates or reframes the real story, it does not invent a different one.

${tellTable}

Rules for the tell:
- Plant ONLY the assigned tell. If no candidate can honestly carry it, set "straight": true and write a straight package instead (planted_why null, plain null, swaps []). Never swap to a different tell. Decline only when you must — the deal is meant to be followed.
- STRAIGHT (assignment "straight", or your decline): plain, specific, sourced-sounding post that says what the article says, limits included. No wrapper, no loaded words, no shrug, no joke, no shop, no version history.
- "planted_why": one line for the teacher — what was planted and where the receipt is (never shown to players).

THE ACCOUNT ("background"): a FAKE, clearly fictional social account that would plausibly post this. Never a real handle. The bio must read like something a person or newsroom would actually write about themselves — voice, emoji, a tagline, a disclaimer. The bio must NOT announce the tell ("just online a lot", "always sharing, rarely sourcing") and must NOT carry money or sponsorship ("sponsored by…", "code MARA20"). Good bios: "⚽️🔥 the drama, the takes, the receipts (sometimes)" · "holistic mama of 3 🌿 sharing what the doctors won't tell you | not medical advice" · "✅ fact-checking viral claims, sources linked every time". Bad bios: "not a scientist, just online a lot" · "sponsored by NutriGlow 💊 code MARA20" · "not affiliated with any facts".
For a STRAIGHT story the account reads reputable: a real-sounding (but fictional) newsroom, institution, or named expert; "verified": true is allowed; clean funding rows. For a "joke" story the account is openly satire in name, handle and bio.

MONEY ROWS: every account, honest ones included, gets exactly three "funding" rows with these fixed keys in this order: "Who's behind it", "How it makes money", "Paid posts tagged?". The money lives here, never in the bio. An honest account's rows are not empty and not special — they just read clean. Where disclosure is N/A the row still exists and says so.

THE ARTICLE ("article"): the real article you picked is rendered in the game from the API's headline, outlet, date and description — you do not rewrite it. Emit only "kicker" (a section label like "Weather" or "Investing · Tech") and "receipt": one line (≤ 90 characters) a kid could read out loud about what the article says next to the post — for a tell story, the gap; for a straight story, that it holds up.

THE CLUE POOL ("clues"): 3–4 clues, at most ONE per look, each in the look's exact shape below. Every clue has "strength" ("strong" or "weak") and "weak_reason" (null when strong; when weak, one of "gain", "one_story", "no_proof", "off_topic", or a tell id — "feel", "grift", "viral", "coordination", "joke", "delay"). These two fields are for the teacher only — players never see them, so NOTHING in the clue's content may signal its strength: no badge words, no "unverified", no "official alert". The difference is in the content alone. Every clue also has "name" (who it is from — the issuer, masthead or handle) and "text": ONE sentence for the case file that describes only what is there (what the document says, what the video shows) — NEVER what is missing or how it compares to the post. "no reporter is named", "repeats the post's wording", "with no sources", "mimics the post's shrug" are all REJECTED: they hand the kid the answer. A weak aggregator's text is simply what its headline says; a weak explainer's text is what it claims; a weak video's text is what the person says on camera. The weakness lives in the clue's own content (the empty byline, the missing link chips, the cousin), which the kid discovers by opening it.

${lookTable}

HOW TO WRITE A WEAK CLUE: subtle, low-stakes, never outright false. A weak clue is a real-seeming thing that does not carry the weight it appears to. It must still be ABOUT this story — except at most ONE "off_topic" clue per story (a real-looking clue about a different event, an old version of the story, or a neighboring topic; zero is fine). A "gain" clue follows the grift rule: decide what its source sells first, then write it; its headline never names the product. A clue written through a tell lens applies that tell's guidance to the clue's OWN wording — "feel": a charged word where a plain one would do; "viral": a BREAKING wrapper on a clue; "coordination": the clue repeats the post's exact phrase; "grift": the source gains if you believe it; "joke": a satire site's take; "delay": the clue shrugs at the fix.
HOW TO WRITE A STRONG CLUE: dated, named, specific, shows its work — a byline or issuing body, a date, a number or quote you could check, a link or document behind it. Strong clues often carry the detail the post dropped (scope, exception, "pilot at 2 schools", the end time, the limits section).
SKIP A LOOK RATHER THAN INVENT IT: if the story has no plausible primary document (nobody official said anything), emit no "official" clue — 3 clues is fine. Never invent a primary source for a story that has none.

THE MIX (the assignment tells you which):
- STRAIGHT story: 0–1 weak clue in the whole pool (clues + reddit). Everything else strong.
- TELL story: 2–3 weak clues, AND at least 2 strong clues that are enough to write an honest note about the post. Your ASSIGNMENT suggests a lens for one of the weak clues — use it for one weak clue so weak reasons vary across the pool; the other weak clues use one of "gain" / "one_story" / "no_proof" that fits the look.

ALSO, for every story:
- "reddit": one forum thread {strength, weak_reason, text (what the thread says, in one line), detail (one line about the account)} — or null.
- "same_phrase": the coordination receipt when the tell is "coordination"; otherwise null.
- "hook": one sentence framing what's worth investigating about the post (for a straight post: what a careful reader would check before trusting it).
- "ai_clips": exactly 2 short strings — an AI assistant's take on the post, one cautious, one contextual.

Ground rules:
- Never target real, named private individuals. Public figures/institutions named in real reporting are fine to name; every account, outlet, document issuer and creator you invent is FICTIONAL and must not share a name with a real one.
- "chosen_headline": copy the candidate headline you picked EXACTLY as given (every character) — it proves the package is about that story and not another. When only one candidate is listed the teacher already picked it: chosen_index is 1.
- QUOTES: inside any string value use curly quotes “ ” or escape straight quotes as \\" — one unescaped " breaks the whole reply.
- Output a strict JSON object only — no markdown fences, no commentary — with keys: chosen_index, chosen_headline, straight, post{headline, plain, swaps[]}, planted_why, article{kicker, receipt}, hook, background{handle, displayName, bio, verified, followers, following, posts, joined, funding[3], shop?, versions?}, clues[], reddit, same_phrase, ai_clips[2].

WORKED EXAMPLE:
${FEW_SHOT}`;
}

// ---- NewsData ----------------------------------------------------------------------
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
  const mapped = articles.map((a: any) => ({
    source: a.source_name || a.source_id || "News",
    date: a.pubDate || null,
    headline: a.title,
    url: a.link || null,
    media: {
      image_url: a.image_url || null,
      description: a.description || null,
      source_icon: a.source_icon || null,
      source_url: a.source_url || null,
    },
  }));
  // Photo first: the Round 1 card is the photo. Stable sort keeps NewsData's order otherwise.
  return mapped.map((c: any, i: number) => ({ c, i }))
    .sort((x: any, y: any) => (y.c.media.image_url ? 1 : 0) - (x.c.media.image_url ? 1 : 0) || x.i - y.i)
    .map((x: any) => x.c);
}

// ---- validation (the claims rule v2 + the clue-pool rules) ---------------------------------
const FUNDING_KEYS = ["Who's behind it", "How it makes money", "Paid posts tagged?"];
const SATIRE_RE = /satire|satir|parody|joke|jokes|humor|humour|comedy|spoof|gag|not real|none of this happened|fake news|the onion|turnip/i;
function isStr(v: any) { return typeof v === "string" && v.trim().length > 0; }
function has(o: any, k: string) { return o && Object.prototype.hasOwnProperty.call(o, k); }
function wordCount(s: string) { return s.trim().split(/\s+/).length; }
// A clue's case-file text (and a reddit line) describes only what is there. Naming what is missing
// is an answer key in the kid's hand (9/20: Haiku wrote "exact phrasing from the post — no reporting").
const TELL_OFF_RE = /\b(no|without|lacks?|lacking|zero|any)\s+(real\s+|actual\s+|original\s+|independent\s+|named\s+|new\s+)?(reporting|reporter|sources?|sourcing|byline|proof|evidence|citations?|links?|data|verification|checking|asking|attribution|names?)\b|\b(unsourced|unverified|uncited|unnamed|anonymous experts|mimics?|mimicking|parrot(s|ing)?|echo(es|ing)? the post|repeat(s|ing)? the post|copies the post|(exact|same|identical) (phras\w*|word\w*|languag\w*)|lifted from the post|from the post itself|(does|did) not (report|check|verify|cite|link|name|ask)|doesn't (report|check|verify|cite|link|name|ask)|secondhand|second-hand|hearsay|claims? without|with no |without\s+\w+ing\b|(no|without)\s+(naming|linking|citing|sourcing|verifying|checking|attributing)|\bnot (named|sourced|verified|linked)|no one is named|nobody is named|tell-?off|weak clue|with (charged|loaded|emotional) language|describ(es|ing) (the|its|their) (mistake|claim|language|rhetoric|tone)|framed as|designed to (alarm|scare|provoke)|sensational\w*)\b/i;
function tellOff(text: string): string | null { const m = String(text || "").match(TELL_OFF_RE); return m ? m[0] : null; }

// Models sometimes park the receipt objects one level off (gen.versions, post.versions,
// background.version_history). Move them where the client reads them before validating.
export function normalizeGen(gen: any): any {
  if (!gen || typeof gen !== "object") return gen;
  const bg = gen.background = gen.background || {};
  const post = gen.post || {};
  if (!bg.versions) { const v = bg.version_history || bg.versionHistory || gen.versions || gen.version_history || post.versions; if (v) bg.versions = v; }
  if (bg.versions && !Array.isArray(bg.versions.rows) && Array.isArray(bg.versions.versions)) bg.versions.rows = bg.versions.versions;
  if (bg.versions && Array.isArray(bg.versions.rows)) bg.versions.rows = bg.versions.rows.map((r: any) => (r && r.t === undefined && (r.caption || r.text)) ? { t: r.caption || r.text, d: r.d || r.date || "", n: String(r.n || r.views || "") } : r);
  if (bg.versions && !bg.versions.correction && (gen.correction || bg.correction)) bg.versions.correction = gen.correction || bg.correction;
  if (bg.versions && !bg.versions.label && Array.isArray(bg.versions.rows)) bg.versions.label = "this claim · " + bg.versions.rows.length + " tries this month";
  if (!bg.shop) { const sh = bg.link_in_bio || bg.linkInBio || gen.shop || post.shop; if (sh) bg.shop = sh; }
  ["version_history", "versionHistory", "link_in_bio", "linkInBio", "correction"].forEach((k) => { delete bg[k]; });
  delete gen.versions; delete gen.version_history; delete gen.shop; delete gen.correction;
  return gen;
}

function sameHeadline(a: any, b: any): boolean {
  const n = (s: any) => String(s == null ? "" : s).replace(/\s+/g, " ").trim();
  return n(a) === n(b) && n(a).length > 0;
}
// `candidates` (v13): when given, the model's chosen_index must point at a real candidate and
// chosen_headline must be that candidate's headline. Omitted = the v12 checks only.
export function validate(gen: any, slot: Slot, candidates?: { headline: string }[]): string[] {
  const errs: string[] = [];
  if (candidates && candidates.length && gen) {
    const idx = candidates.length === 1 && (gen.chosen_index === undefined || gen.chosen_index === null) ? 1 : gen.chosen_index;
    const cand = (typeof idx === "number") ? candidates[idx - 1] : undefined;
    if (!cand) errs.push("chosen_index " + JSON.stringify(gen.chosen_index) + " is not one of the candidates (1-" + candidates.length + ")");
    else if (!sameHeadline(gen.chosen_headline, cand.headline)) errs.push("chosen_headline must be candidate " + idx + "'s headline copied exactly: " + JSON.stringify(cand.headline) + " (got " + JSON.stringify(gen.chosen_headline === undefined ? null : gen.chosen_headline) + ") — and the post must be about THAT story");
  }
  const post = gen && gen.post;
  if (!post || !isStr(post.headline)) { errs.push("post.headline missing"); return errs; }
  const headline: string = post.headline;
  const hl = headline.toLowerCase();
  if (wordCount(headline) > 32) errs.push("post.headline is " + wordCount(headline) + " words; keep it under ~25");
  const straight = !!gen.straight;
  const tell: TellId | null = straight ? null : slot.primary;

  // straight ⇔ no plain ⇔ no swaps ⇔ planted_why null
  if (straight) {
    if (isStr(post.plain)) errs.push("straight is true but post.plain is set (must be null)");
    if (Array.isArray(post.swaps) && post.swaps.length) errs.push("straight is true but post.swaps is not empty");
    if (isStr(gen.planted_why)) errs.push("straight is true but planted_why is set (must be null)");
    if (gen.same_phrase) errs.push("straight is true but same_phrase is set (must be null)");
    if (gen.background && (gen.background.shop || gen.background.versions)) errs.push("straight is true but background carries shop/versions");
  } else {
    if (!slot.primary) errs.push("slot is straight but straight is false");
    if (!isStr(gen.planted_why)) errs.push("planted_why missing on a spun story");
  }

  // per-tell receipts
  const bg = gen.background;
  if (tell === "feel") {
    if (!isStr(post.plain)) errs.push("feel: post.plain missing (the same facts, no feeling)");
    const swaps = Array.isArray(post.swaps) ? post.swaps : [];
    if (swaps.length < 3 || swaps.length > 5) errs.push("feel: post.swaps must have 3-5 items (got " + swaps.length + ")");
    swaps.forEach((s: any, i: number) => {
      if (!s || !isStr(s.hot) || typeof s.plain !== "string" || !isStr(s.why)) errs.push("feel: swaps[" + i + "] needs {hot, plain, why}");
      else if (hl.indexOf(String(s.hot).toLowerCase()) === -1) errs.push("feel: swaps[" + i + "].hot " + JSON.stringify(s.hot) + " does not appear in post.headline");
    });
  } else {
    if (isStr(post.plain)) errs.push("post.plain is only for the feel tell (set it to null)");
    if (Array.isArray(post.swaps) && post.swaps.length) errs.push("post.swaps is only for the feel tell (set it to [])");
  }
  if (tell === "grift") {
    const sh = bg && bg.shop;
    if (!sh || !isStr(sh.url) || !Array.isArray(sh.links) || !sh.item) errs.push("grift: background.shop must be {url, links[], item{name, pitch, price}}");
    else {
      const hot = sh.links.filter((l: any) => l && l.hot === true);
      if (sh.links.length < 2 || sh.links.length > 3) errs.push("grift: shop.links must have 2-3 items");
      if (hot.length !== 1) errs.push("grift: exactly ONE shop link must have hot:true (got " + hot.length + ")");
      if (!isStr(sh.item.name) || !isStr(sh.item.pitch) || !isStr(sh.item.price)) errs.push("grift: shop.item needs name, pitch, price");
      else {
        const firstWord = String(sh.item.name).split(/\s+/)[0].toLowerCase();
        if (firstWord.length > 3 && hl.indexOf(firstWord) !== -1) errs.push("grift: the post names the product (" + JSON.stringify(sh.item.name) + ") — the post must never name it");
      }
      const money = bg.funding && bg.funding[1] && String(bg.funding[1].v || "");
      if (money && !/shop|link|course|sell|sells|store|merch|product|affiliate|subscription|program|book|supplement|kit|app|membership|\$/i.test(money)) errs.push("grift: 'How it makes money' must name the shop / product the receipt shows");
    }
  } else if (bg && bg.shop) errs.push("background.shop is only for the grift tell");
  if (tell === "viral") {
    const v = bg && bg.versions;
    if (!v || !isStr(v.label) || !Array.isArray(v.rows) || !v.correction) errs.push("viral: background.versions must be {label, rows[], correction{}}");
    else {
      if (v.rows.length < 3 || v.rows.length > 4) errs.push("viral: versions.rows must have 3-4 items (got " + v.rows.length + ")");
      v.rows.forEach((r: any, i: number) => { if (!r || !isStr(r.t) || !isStr(r.d) || !isStr(r.n)) errs.push("viral: versions.rows[" + i + "] needs {t, d, n}"); });
      const last = v.rows[v.rows.length - 1];
      if (last && isStr(last.d) && !/pinned/i.test(last.d)) errs.push("viral: the last versions row's date must end with '· pinned'");
      const c = v.correction;
      if (!isStr(c.who) || !isStr(c.text) || !isStr(c.likes) || !isStr(c.views)) errs.push("viral: versions.correction needs {who, text, likes, views, edited}");
    }
  } else if (bg && bg.versions) errs.push("background.versions is only for the viral tell");
  if (tell === "coordination") {
    const sp = gen.same_phrase;
    if (!sp || !isStr(sp.q) || !Array.isArray(sp.hits)) errs.push("coordination: same_phrase must be {q, hits[]}");
    else {
      const m = String(sp.q).match(/"([^"]+)"/);
      const phrase = (m ? m[1] : String(sp.q)).trim();
      const pw = wordCount(phrase);
      if (pw < 5 || pw > 11) errs.push("coordination: the quoted phrase in same_phrase.q must be 6-10 words (got " + pw + ")");
      if (hl.indexOf(phrase.toLowerCase()) === -1) errs.push("coordination: the phrase " + JSON.stringify(phrase) + " must appear verbatim in post.headline");
      if (sp.hits.length < 4 || sp.hits.length > 6) errs.push("coordination: same_phrase.hits must have 4-6 items (got " + sp.hits.length + ")");
      sp.hits.forEach((h: any, i: number) => { if (!h || !isStr(h.h) || !isStr(h.t) || !isStr(h.d)) errs.push("coordination: hits[" + i + "] needs {h, t, d}"); });
      const own = bg && bg.handle && sp.hits[0] && String(sp.hits[0].h).toLowerCase() === String(bg.handle).toLowerCase();
      if (!own) errs.push("coordination: hits[0].h must be the story's own account (" + (bg && bg.handle) + ")");
    }
  } else if (gen.same_phrase) errs.push("same_phrase is only for the coordination tell (set it to null)");
  if (tell === "joke" && bg) {
    if (!SATIRE_RE.test(String(bg.displayName || ""))) errs.push("joke: displayName must say satire/parody (e.g. 'The Daily Turnip · Satire')");
    if (!SATIRE_RE.test(String(bg.handle || ""))) errs.push("joke: handle must say satire/parody (e.g. '@dailyturnip_satire')");
    if (!SATIRE_RE.test(String(bg.bio || ""))) errs.push("joke: bio must say satire/parody ('Parody. None of this happened.')");
  }

  // article
  const art = gen.article;
  if (!art || !isStr(art.kicker) || !isStr(art.receipt)) errs.push("article must be {kicker, receipt}");
  else if (art.receipt.length > 110) errs.push("article.receipt is " + art.receipt.length + " chars; keep it under 90");

  if (!isStr(gen.hook)) errs.push("hook missing");
  if (!bg || !isStr(bg.handle) || !isStr(bg.displayName) || typeof bg.bio !== "string") errs.push("background incomplete (handle/displayName/bio)");
  else {
    const f = Array.isArray(bg.funding) ? bg.funding : [];
    if (f.length !== 3 || f.some((r: any, i: number) => !r || r.k !== FUNDING_KEYS[i] || !isStr(r.v)))
      errs.push("background.funding must be exactly three rows with keys " + FUNDING_KEYS.join(" / ") + " in order");
  }

  // the clue pool
  const clues = Array.isArray(gen.clues) ? gen.clues : [];
  if (clues.length < 3 || clues.length > 4) errs.push("clues must have 3-4 items (got " + clues.length + ")");
  const seenLooks: Record<string, number> = {};
  let weak = 0, strong = 0, offTopic = 0;
  const reasons: string[] = [];
  function tally(c: any, label: string) {
    if (c.strength !== "strong" && c.strength !== "weak") { errs.push(label + ": strength must be \"strong\" or \"weak\""); return; }
    if (c.strength === "strong") { strong++; if (c.weak_reason !== null && c.weak_reason !== undefined) errs.push(label + ": weak_reason must be null on a strong clue"); }
    else {
      weak++;
      if (WEAK_REASONS.indexOf(c.weak_reason) === -1) errs.push(label + ": weak_reason " + JSON.stringify(c.weak_reason) + " is not one of " + WEAK_REASONS.join("/"));
      else { reasons.push(c.weak_reason); if (c.weak_reason === "off_topic") offTopic++; }
    }
  }
  clues.forEach((c: any, i: number) => {
    const label = "clues[" + i + "]";
    if (!c || LOOK_KEYS.indexOf(c.look) === -1) { errs.push(label + ": look must be one of " + LOOK_KEYS.join("/")); return; }
    seenLooks[c.look] = (seenLooks[c.look] || 0) + 1;
    if (seenLooks[c.look] > 1) errs.push(label + ": a second " + c.look + " clue — at most one per look");
    const L = LOOKS[c.look as Look];
    if (!isStr(c.name)) errs.push(label + ": name missing");
    if (!isStr(c.text)) errs.push(label + ": text missing");
    else if (wordCount(c.text) > 45) errs.push(label + ": text is " + wordCount(c.text) + " words; one sentence");
    else { const t = tellOff(c.text); if (t) errs.push(label + ": text says what is MISSING (\"" + t + "\") — the kid reads this line, so it must describe only what the clue shows or says; a weak clue stays weak by its content, never by a note about it"); }
    const d = c[L.dataKey];
    if (!d) errs.push(label + ": " + c.look + " needs a \"" + L.dataKey + "\" object");
    else L.required.forEach((k) => {
      if (!has(d, k)) errs.push(label + ": " + L.dataKey + "." + k + " missing");
      else if (k === "lines" && (!Array.isArray(d.lines) || d.lines.length < 1 || d.lines.length > 3)) errs.push(label + ": doc.lines must have 1-3 strings");
      else if (k === "links" && !Array.isArray(d.links)) errs.push(label + ": page.links must be an array ([] for none)");
      else if (k !== "lines" && k !== "links" && k !== "by" && typeof d[k] !== "string") errs.push(label + ": " + L.dataKey + "." + k + " must be a string");
    });
    if (c.look === "creator" && d && typeof d.hue !== "number") errs.push(label + ": vid.hue must be a number 0-360");
    tally(c, label);
  });
  if (gen.reddit) {
    if (!isStr(gen.reddit.text)) errs.push("reddit.text missing (or set reddit to null)");
    else { const t = tellOff(gen.reddit.text); if (t) errs.push("reddit.text says what is MISSING (\"" + t + "\") — write what the thread says, not what it lacks"); }
    tally(gen.reddit, "reddit");
  }
  if (offTopic > 1) errs.push("at most ONE off_topic clue per story (got " + offTopic + ")");
  if (straight) {
    if (weak > 1) errs.push("straight story: at most ONE weak clue in the pool (got " + weak + ")");
  } else {
    if (weak < 2 || weak > 3) errs.push("tell story: 2-3 weak clues in the pool (got " + weak + ")");
    if (strong < 2) errs.push("tell story: at least 2 strong clues (got " + strong + ")");
  }
  const dup = reasons.filter((r, i) => reasons.indexOf(r) !== i);
  if (dup.length) errs.push("weak reasons repeat within one story (" + dup.join(", ") + ") — vary them");

  const ai = Array.isArray(gen.ai_clips) ? gen.ai_clips : [];
  if (ai.length !== 2) errs.push("ai_clips must have exactly 2 items (got " + ai.length + ")");
  return errs;
}

// ---- Claude -----------------------------------------------------------------------
// v13: `deadline` (epoch ms). Supabase's free plan shuts a request down at 150s with no chance to
// clean up, which would leave a row stuck in 'writing'. The call aborts itself at the deadline so the
// handler can still mark the row failed and answer.
async function callClaude(messages: any[], model: string = MODEL, deadline = 0, tune: Tune = {}): Promise<any> {
  const ctl = new AbortController();
  const timer = deadline ? setTimeout(() => ctl.abort(), Math.max(1000, deadline - Date.now())) : null;
  try {
    return await callClaudeInner(messages, model, ctl.signal, tune);
  } catch (e) {
    if (ctl.signal.aborted) throw new Error("ran out of time (the writer took longer than this server allows for one request) — nothing was saved; Try again");
    throw e;
  } finally { if (timer) clearTimeout(timer); }
}
async function callClaudeInner(messages: any[], model: string, signal: AbortSignal, tune: Tune): Promise<any> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST", signal,
    headers: { "content-type": "application/json", "x-api-key": ANTHROPIC_KEY!, "anthropic-version": "2023-06-01" },
    // v13: the system prompt is identical on every call — mark it cacheable (5-min ephemeral cache).
    body: JSON.stringify({ model, max_tokens: tune.max_tokens || MAX_TOKENS, ...(tune.thinking === "off" ? { thinking: { type: "disabled" } } : {}), ...(tune.effort && tune.thinking !== "off" ? { output_config: { effort: tune.effort } } : {}), system: [{ type: "text", text: systemPrompt(), cache_control: { type: "ephemeral" } }], messages }),
  });
  if (!res.ok) throw new Error("Anthropic request failed: " + res.status + " " + (await res.text()).slice(0, 300));
  const data = await res.json();
  const text = (data.content || []).map((b: any) => b.text || "").join("");
  // Tolerate fences and stray prose around the object; a parse failure becomes a retryable
  // "gen: null" instead of a thrown error (9/20: Sonnet lost 2 of 3 stories to one unescaped quote).
  let cleaned = text.trim().replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```\s*$/i, "");
  const a = cleaned.indexOf("{"), z = cleaned.lastIndexOf("}");
  if (a > 0 || (z >= 0 && z < cleaned.length - 1)) cleaned = cleaned.slice(Math.max(a, 0), z >= 0 ? z + 1 : undefined);
  let gen: any = null, parseError: string | null = null;
  try { gen = JSON.parse(cleaned); } catch (e) { parseError = (e as Error).message; }
  // `reply` is diagnostics only: why it stopped, what kinds of blocks came back, and (only when the
  // JSON didn't parse) the two ends of the text.
  const reply: any = { stop_reason: data.stop_reason || null, blocks: (data.content || []).map((b: any) => b.type), chars: text.length };
  if (parseError) { reply.head = text.slice(0, 400); reply.tail = text.slice(-300); }
  return { text, gen, parseError, usage: data.usage || null, reply };
}

type Cand = { source: string; date: string | null; headline: string; url: string | null; media: any };
function assignmentText(slot: Slot): string {
  if (slot.straight) return "straight — no planted tell (planted_why null, plain null, swaps []; the pool has at most ONE weak clue)";
  const t = TELL_BY_ID[slot.primary!];
  return "spun — planted tell \"" + t.id + "\" (" + t.label + "). Suggested lens for one weak clue: \"" + slot.weakLens + "\"." +
    (slot.primary === "delay" ? " Remember: decline to straight unless the story contains a problem PLUS a fix or response." : "");
}
function sumUsage(usages: any[], key: string): number { return usages.reduce((n, u) => n + ((u && u[key]) || 0), 0); }
function usageMeta(usages: any[]) {
  return { input_tokens: sumUsage(usages, "input_tokens"), output_tokens: sumUsage(usages, "output_tokens"),
    cache_read_input_tokens: sumUsage(usages, "cache_read_input_tokens"), cache_creation_input_tokens: sumUsage(usages, "cache_creation_input_tokens"),
    thinking_tokens: usages.reduce((n, u) => n + ((u && u.output_tokens_details && u.output_tokens_details.thinking_tokens) || 0), 0) };
}
// `single` (v13 package mode): the teacher already picked the story, so there is one candidate and
// STEP 1 is moot — the user message says so instead of asking the model to pick.
const RETRY_NEEDS_MS = 65000; // don't start the fix-up pass with less than this left before the deadline
async function generateStory(slot: Slot, candidates: Cand[], model: string = MODEL, single = false, deadline = 0, tune: Tune = {}) {
  const candidateList = candidates.map((c, i) => (i + 1) + ". [" + c.source + "]" + (c.media && c.media.image_url ? " [photo]" : " [no photo]") + " " + c.headline).join("\n");
  const messages: any[] = [{
    role: "user",
    content: "SUBJECT: " + slot.subject + "\nYOUR ASSIGNMENT: " + assignmentText(slot) +
      (single ? "\n\nTHE HEADLINE (the teacher picked this story — skip STEP 1; chosen_index is 1; draft its package):\n"
              : "\n\nCANDIDATE HEADLINES (pick ONE, by number, then draft its story):\n") + candidateList + "\n\nOUTPUT:",
  }];
  const t0 = Date.now();
  let { text, gen, parseError, usage, reply } = await callClaude(messages, model, deadline, tune);
  const usages: any[] = [usage];
  const replies: any[] = [reply];
  gen = normalizeGen(gen);
  let errs = parseError ? ["the reply was not valid JSON (" + parseError + "). Most often an unescaped straight double quote inside a string value — inside text use curly quotes “ ” or escape as \\\", and return the whole object again"] : validate(gen, slot, candidates);
  const firstErrs = errs.slice();
  if (errs.length && deadline && deadline - Date.now() < RETRY_NEEDS_MS) {
    const err: any = new Error("the first draft failed the claims rule and there was no time left for the fix-up pass — Try again. First draft: " + errs.join("; "));
    err.meta = { model, ms: Date.now() - t0, calls: 1, first_errors: firstErrs, second_errors: [], ...usageMeta(usages), replies };
    throw err;
  }
  if (errs.length) {
    // One retry with the failures spelled out; a second failure is this topic's error.
    messages.push({ role: "assistant", content: text });
    messages.push({ role: "user", content: "That output fails the claims rule:\n- " + errs.join("\n- ") + "\n\nFix ONLY what is listed and return the full corrected JSON object, nothing else." });
    const again = await callClaude(messages, model, deadline, tune);
    gen = normalizeGen(again.gen); usages.push(again.usage); replies.push(again.reply);
    errs = again.parseError ? ["the reply was not valid JSON (" + again.parseError + ")"] : validate(gen, slot, candidates);
    if (errs.length) {
      // Carry the diagnostics out with the failure so the pull result shows both attempts.
      const err: any = new Error("failed the claims rule after one retry: " + errs.join("; "));
      err.meta = { model, ms: Date.now() - t0, calls: usages.length, first_errors: firstErrs, second_errors: errs, ...usageMeta(usages), replies };
      throw err;
    }
  }
  const chosen = candidates[(gen.chosen_index || 1) - 1] || candidates[0];
  // `meta` is diagnostics for the response only (dry runs / the console's pull result) — never on the row.
  const meta = { model, ms: Date.now() - t0, calls: usages.length, retried_for: firstErrs, ...usageMeta(usages), replies };
  return { gen, chosen, meta };
}

// ---- the row -----------------------------------------------------------------------
// Everything the model wrote, in the shapes the hub-spoke client renders, plus the mechanical
// bits the model never writes: clip ids (unsuffixed — the mapper appends "-<claimId>"),
// `kind`/`who` per look, `tell` on the receipt clip, bar widths + colours, `loaded` HTML.
const HIT_COLOURS = ["#e07a5f", "#81b29a", "#3d405b", "#f2cc8f", "#9b5de5", "#00afb9"];
function escapeHtml(s: string) { return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
function viewsToNumber(n: string): number {
  const m = String(n || "").replace(/,/g, "").match(/([\d.]+)\s*([KkMmBb]?)/);
  if (!m) return 0;
  const v = parseFloat(m[1]); const u = m[2].toUpperCase();
  return v * (u === "K" ? 1e3 : u === "M" ? 1e6 : u === "B" ? 1e9 : 1);
}
// `loaded` = the headline with each swap's hot phrase wrapped in <mark>, longest phrase first so a
// phrase inside another is never double-marked. Escaped first — the client drops it into innerHTML.
function loadedHTML(headline: string, swaps: any[]): string {
  let html = escapeHtml(headline);
  const hots = swaps.map((s) => String(s.hot)).sort((a, b) => b.length - a.length);
  hots.forEach((hot) => {
    const e = escapeHtml(hot);
    const i = html.toLowerCase().indexOf(e.toLowerCase());
    if (i === -1) return;
    html = html.slice(0, i) + "<mark>" + html.slice(i, i + e.length) + "</mark>" + html.slice(i + e.length);
  });
  return html;
}

export function toStoryRow(slot: Slot, chosen: Cand, gen: any) {
  const straight = !!gen.straight;
  const tell: TellId | null = straight ? null : slot.primary;
  const receipts = tell ? TELL_BY_ID[tell].receipts.slice() : [];
  const swaps: any[] = (tell === "feel" && Array.isArray(gen.post.swaps)) ? gen.post.swaps : [];

  const clips: any[] = [];
  const looksSeen: Record<string, boolean> = {};
  (gen.clues || []).forEach((c: any) => {
    const L = LOOKS[c.look as Look];
    if (!L || looksSeen[c.look]) return;
    looksSeen[c.look] = true;
    const id = c.look === "official" ? "off" : c.look === "outlet" ? "out" : c.look === "explainer" ? "exp" : "vid";
    const clip: any = { id, look: c.look, who: L.who, kind: L.kind, name: c.name, text: c.text, tell: null,
      strength: c.strength, weak_reason: c.strength === "weak" ? c.weak_reason : null };
    clip[L.dataKey] = c[L.dataKey];
    if (c.look === "creator" && clip.vid && typeof clip.vid.hue !== "number") clip.vid.hue = 200;
    clips.push(clip);
  });
  if (gen.reddit && gen.reddit.text) {
    clips.push({ id: "rd1", who: "Can't tell — bot or AI?", text: gen.reddit.text, detail: gen.reddit.detail || null, tell: null,
      strength: gen.reddit.strength, weak_reason: gen.reddit.strength === "weak" ? gen.reddit.weak_reason : null });
  }
  if (tell === "coordination" && gen.same_phrase) {
    const sp = gen.same_phrase;
    const hits = (sp.hits || []).map((h: any, i: number) => ({ h: h.h, t: h.t, d: h.d, c: HIT_COLOURS[i % HIT_COLOURS.length] }));
    const m = String(sp.q).match(/"([^"]+)"/);
    const phrase = m ? m[1] : String(sp.q);
    clips.push({ id: "phr", look: "samephrase", who: "Can't tell — bot or AI?", tell: "coordination",
      text: "Searching the exact phrase \"" + phrase + "\": " + hits.length + " accounts posted the same " + wordCount(phrase) + " words within two days.",
      detail: "Word-for-word matches, none linking to the report.",
      phrase: { q: sp.q, count: "Exact matches · this week · " + hits.length + " accounts", hits },
      receipt: hits.length + " accounts, same " + wordCount(phrase) + " words, 2 days",
      strength: "strong", weak_reason: null });
  }
  (gen.ai_clips || []).forEach((text: string, i: number) => {
    clips.push({ id: "ai" + (i + 1), text, who: "AI assistant", detail: null, tell: null, source: "ai" });
  });

  const bg = gen.background || {};
  if (bg.versions && Array.isArray(bg.versions.rows)) {
    const max = Math.max(1, ...bg.versions.rows.map((r: any) => viewsToNumber(r.n)));
    bg.versions.rows = bg.versions.rows.map((r: any, i: number, arr: any[]) => ({
      t: r.t, d: r.d, n: r.n, w: Math.max(3, Math.round(100 * viewsToNumber(r.n) / max)), ...(i === arr.length - 1 ? { win: true } : {}),
    }));
    if (bg.versions.correction && !isStr(bg.versions.correction.edited)) bg.versions.correction.edited = "No";
  }
  if (bg.shop && Array.isArray(bg.shop.links)) bg.shop.links = bg.shop.links.map((l: any) => ({ t: l.t, hot: l.hot === true }));

  const post = {
    headline: gen.post.headline,
    loaded: swaps.length ? loadedHTML(gen.post.headline, swaps) : null,
    plain: tell === "feel" ? gen.post.plain : null,
    swaps: swaps.map((s: any) => [s.hot, s.plain || "", s.why]),
    tells: tell ? [tell] : [],
    planted: { tell, receipts, why: tell ? gen.planted_why : "nothing was planted — the account says what the article says" },
    article: { kicker: gen.article.kicker, receipt: gen.article.receipt },
    card_tell: null, card_words: null,
  };

  return {
    subject: slot.subject,
    source: chosen.source,
    date: chosen.date,
    headline: chosen.headline,
    url: chosen.url,
    media: chosen.media || null,
    straight,
    post,
    variants: [],
    hook: gen.hook,
    background: bg,
    clips,
  };
}

// ---- v13: the slot for ONE already-dealt headline row ---------------------------------------
// `dealt` was written at pull time. The weak-clue lens is any OTHER tell, picked from the row id so a
// retry of the same row gets the same assignment.
function hashStr(s: string): number { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
export function slotForRow(row: { id: string; subject: string; dealt: string | null }): Slot {
  const k = TELL_IDS.indexOf(row.dealt as TellId);
  if (k === -1) return { subject: row.subject, straight: true, primary: null, weakLens: null };
  const lens = TELL_IDS[(k + 1 + (hashStr(String(row.id)) % (TELL_IDS.length - 1))) % TELL_IDS.length];
  return { subject: row.subject, straight: false, primary: TELL_IDS[k], weakLens: lens };
}

// ---- v13: headline rows from one pull (pure — the handler does the I/O) -------------------------
// Every candidate of a topic gets that topic's dealt tell. Dedupe on url (headline when there is no
// url) against what is already in the table AND within the batch (one article can match two topics).
export function headlineRows(perTopic: { subject: string; candidates: Cand[] }[], slots: Slot[], existingKeys: string[]) {
  const seen: Record<string, boolean> = {};
  existingKeys.forEach((k) => { seen[k] = true; });
  const rows: any[] = []; let skipped = 0;
  perTopic.forEach((t) => {
    const slot = slots.find((s) => s.subject === t.subject);
    const dealt = !slot || slot.straight ? "straight" : slot.primary;
    t.candidates.forEach((c) => {
      const key = rowKey(c);
      if (seen[key]) { skipped++; return; }
      seen[key] = true;
      rows.push({ subject: t.subject, source: c.source, date: c.date, headline: c.headline, url: c.url, media: c.media || null,
        status: "headline", dealt, straight: false, post: null, variants: [], hook: null, background: null, clips: [] });
    });
  });
  return { rows, skipped };
}
export function rowKey(c: { url: string | null; headline: string }): string { return c.url ? "u:" + c.url : "h:" + String(c.headline).trim().toLowerCase(); }

// PostgREST now and then answers "JWT issued at future" for a second or two after a cold boot (seen
// twice on 9/20 when several package calls started together). It is transient: wait and ask again.
async function dbRetry(fn: () => PromiseLike<any>): Promise<any> {
  for (let i = 0; ; i++) {
    const r = await fn();
    if (!r.error || i >= 3 || !/JWT issued at future/i.test(String(r.error.message || ""))) return r;
    await new Promise((res) => setTimeout(res, 1200 * (i + 1)));
  }
}

function json(payload: any, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { ...CORS_HEADERS, "content-type": "application/json" } });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });

  let body: any = {};
  if (req.method === "POST") { try { body = await req.json(); } catch (_e) { body = {}; } }
  body = body || {};
  const dry = !!body.dry;
  const mode: "headlines" | "package" = body.mode === "package" ? "package" : "headlines";
  const model: string = (typeof body.model === "string" && body.model.trim()) || MODEL;
  const seed = (typeof body.seed === "number") ? body.seed : Date.now() % 2147483647;
  // The free plan ends a request at 150s. Model calls abort themselves here so rows never stick in 'writing'.
  const deadline = Date.now() + 138000;
  const tune = tuneFrom(body); // {max_tokens?, thinking?: "off"} — try a setting on one call without a redeploy

  // {mode: "version"}: which build is live + a hash of the deployed source (to byte-check a deploy).
  if (body.mode === "version") {
    let sha256: string | null = null, bytes: number | null = null;
    try {
      const buf = await Deno.readFile(new URL(import.meta.url));
      bytes = buf.length;
      sha256 = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", buf))).map((x) => x.toString(16).padStart(2, "0")).join("");
    } catch (_e) { /* the runtime may not expose the source; version alone still answers */ }
    return json({ version: "v13 headlines first (2026-09-20)", model: MODEL, sha256, bytes });
  }

  const needsModel = dry || mode === "package";
  const needsNews = dry || mode === "headlines";
  if ((needsNews && !NEWSDATA_KEY) || (needsModel && !ANTHROPIC_KEY)) {
    return json({ error: "Missing " + (needsNews && !NEWSDATA_KEY ? "NEWSDATA_API_KEY" : "ANTHROPIC_API_KEY") + " secret -- set it in Supabase project settings (Edge Functions -> Manage secrets) before invoking this." }, 500);
  }

  const allSlots = dealTells(seed);
  const wanted: string[] | null = (Array.isArray(body.topics) && body.topics.length) ? body.topics : null;
  const picks = TOPICS.map((_t, i) => i).filter((i) => !wanted || wanted.indexOf(TOPICS[i].subject) !== -1);
  const slots = picks.map((i) => allSlots[i]);
  const deal = slots.map((s) => ({ subject: s.subject, dealt: s.straight ? "straight" : s.primary, weak_lens: s.weakLens }));

  // ---- DRY RUN (unchanged from v12): {dry: true, model?, topics?, seed?} generates WITHOUT touching
  // story_candidates — the model picks among each topic's candidates; `preview` carries the rows.
  if (dry) {
    const rows: any[] = [], metas: any[] = [];
    const errors: { subject: string; message: string; meta?: any }[] = [];
    const settled = await Promise.allSettled(picks.map(async (ti, k) => {
      const slot = slots[k];
      const candidates = await fetchNewsCandidates(TOPICS[ti]);
      const { gen, chosen, meta } = await generateStory(slot, candidates, model, false, deadline, tune);
      return { row: toStoryRow(slot, chosen, gen), meta: { subject: slot.subject, dealt: slot.straight ? "straight" : slot.primary, ...meta } };
    }));
    settled.forEach((result, k) => {
      if (result.status === "fulfilled") { rows.push(result.value.row); metas.push(result.value.meta); }
      else { const r: any = result.reason; errors.push({ subject: TOPICS[picks[k]].subject, message: r.message, ...(r.meta ? { meta: r.meta } : {}) }); }
    });
    const got = rows.map((r) => {
      const pool = r.clips.filter((c: any) => c.strength);
      return { subject: r.subject, planted: r.post.planted.tell || "straight",
        declined: !!(r.straight && slots.find((s) => s.subject === r.subject && !s.straight)),
        clues: pool.length, weak: pool.filter((c: any) => c.strength === "weak").map((c: any) => c.weak_reason) };
    });
    return json({ dry: true, inserted: 0, seed, model, deal, got, meta: metas, errors, preview: rows });
  }

  const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  // ---- HEADLINES: NewsData only. Appends; never touches a row that already exists. -----------------
  if (mode === "headlines") {
    const errors: { subject: string; message: string }[] = [];
    const settled = await Promise.allSettled(picks.map((ti) => fetchNewsCandidates(TOPICS[ti])));
    const perTopic: { subject: string; candidates: Cand[] }[] = [];
    settled.forEach((result, k) => {
      if (result.status === "fulfilled") perTopic.push({ subject: TOPICS[picks[k]].subject, candidates: result.value });
      else errors.push({ subject: TOPICS[picks[k]].subject, message: (result.reason as Error).message });
    });
    if (!perTopic.length) return json({ mode, inserted: 0, skipped_duplicates: 0, seed, deal, errors }, 502);

    const existing = await dbRetry(() => db.from("story_candidates").select("url, headline"));
    if (existing.error) return json({ mode, inserted: 0, skipped_duplicates: 0, seed, deal, errors: errors.concat([{ subject: "(read)", message: existing.error.message }]) }, 500);
    const { rows, skipped } = headlineRows(perTopic, slots, (existing.data || []).map(rowKey));

    if (rows.length) {
      const ins = await dbRetry(() => db.from("story_candidates").insert(rows));
      if (ins.error) return json({ mode, inserted: 0, skipped_duplicates: skipped, seed, deal, errors: errors.concat([{ subject: "(insert)", message: ins.error.message }]) }, 500);
    }
    // Opt-in only (nothing calls it today — Tara 9/20: "just leave them"). Headline rows ONLY.
    let pruned = 0;
    if (typeof body.prune_days === "number" && body.prune_days >= 1) {
      const cutoff = new Date(Date.now() - body.prune_days * 86400000).toISOString();
      const del = await db.from("story_candidates").delete().eq("status", "headline").lt("pulled_at", cutoff).select("id");
      if (del.error) errors.push({ subject: "(prune)", message: del.error.message }); else pruned = (del.data || []).length;
    }
    return json({ mode, inserted: rows.length, skipped_duplicates: skipped, pruned, seed, deal, errors });
  }

  // ---- PACKAGE: one model call per picked headline, written back onto the same row. -----------------
  const ids: string[] = (Array.isArray(body.ids) ? body.ids : []).filter((x: any) => typeof x === "string" && /^[0-9a-f-]{36}$/i.test(x)).slice(0, 10);
  if (!ids.length) return json({ mode, error: "package mode needs {ids: [uuid, …]} (max 10)" }, 400);
  const claimable = body.force ? ["headline", "failed", "writing"] : ["headline", "failed"];

  const ready: string[] = [], metas: any[] = [];
  const failed: { id: string; message: string; meta?: any }[] = [];
  const skipped: { id: string; reason: string }[] = [];

  await Promise.allSettled(ids.map(async (id) => {
    // Claim the row. `generated_at` holds the START time while status='writing' so the console can
    // tell a stalled call from a live one; it becomes the finish time on 'ready'.
    const claim = await dbRetry(() => db.from("story_candidates").update({ status: "writing", package_error: null, generated_at: new Date().toISOString() })
      .eq("id", id).in("status", claimable).select("*"));
    if (claim.error) { failed.push({ id, message: claim.error.message }); return; }
    const row = claim.data && claim.data[0];
    if (!row) { skipped.push({ id, reason: "not found, already written, or being written right now" }); return; }
    try {
      const slot = slotForRow(row);
      const cand: Cand = { source: row.source, date: row.date, headline: row.headline, url: row.url, media: row.media };
      const { gen, chosen, meta } = await generateStory(slot, [cand], model, true, deadline, tune);
      const out = toStoryRow(slot, chosen, gen);
      const up = await dbRetry(() => db.from("story_candidates").update({
        straight: out.straight, post: out.post, variants: out.variants, hook: out.hook, background: out.background, clips: out.clips,
        status: "ready", model, generated_at: new Date().toISOString(), package_error: null,
      }).eq("id", id));
      if (up.error) throw new Error("could not save the package: " + up.error.message);
      ready.push(id);
      metas.push({ id, subject: row.subject, dealt: row.dealt || "straight", planted: out.post.planted.tell || "straight", declined: !!(out.straight && !slot.straight), ...meta });
    } catch (e) {
      const r: any = e;
      const message = String((r && r.message) || r).slice(0, 1000);
      await dbRetry(() => db.from("story_candidates").update({ status: "failed", package_error: message }).eq("id", id));
      failed.push({ id, message, ...(r && r.meta ? { meta: r.meta } : {}) });
    }
  }));

  return json({ mode, model, tune, ready, failed, skipped, meta: metas });
});
