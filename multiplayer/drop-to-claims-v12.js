// drop-to-claims-v12.js — the v12 MAPPER (2026-09-18).
//
// Turns one published drop card (= one story_candidates row written by generate-drop-candidates
// v12, passed through the console's cardsForPublish) into the hub-spoke client's shapes:
//   mapV12Card(card, claimId, idx) → { claim, clips }
//     claim  = one CLAIMS[] entry (id, subject, hue, hook, headline, loaded, plain, swaps, planted,
//              media, article, background, npcVotes, …)
//     clips  = the CLIPS[claimId] list the row carried: the four clue looks, the reddit thread, the
//              same-phrase receipt, the two Ask AI answers — ids suffixed "-<claimId>", and the
//              authoring metadata (`strength`, `weak_reason`) STRIPPED. The game must never render,
//              branch on, or reveal those two fields (evidence-clues brief 9/17 §2a; addendum 7).
//   packageClips(claim) → the clips the hub-spoke generates FROM the claim at parse time
//              (bg / art / swap / shop / ver — see the two CLAIMS.forEach blocks after CLIPS in
//              infodemic-hub-spoke-prototype.html). A client that loads drops at runtime calls this
//              after mapping instead of relying on those parse-time loops.
//   stripAuthoringMeta(clip) → the clip without strength/weak_reason (used by mapV12Card).
//   hasAuthoringMeta(clips) → true if any clip still carries either field (a check for walks).
//
// Loads as a browser global (window.DropToClaimsV12) or a CommonJS module (the node test).
// Replaces mapDropCardsToClaims' body in the multiplayer file when the port happens; the
// hub-spoke has no drop loading yet, so nothing here is wired in until then.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.DropToClaimsV12 = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var AUTHORING_FIELDS = ["strength", "weak_reason"];
  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  function stripAuthoringMeta(clip) {
    var out = {};
    Object.keys(clip || {}).forEach(function (k) { if (AUTHORING_FIELDS.indexOf(k) === -1) out[k] = clip[k]; });
    return out;
  }
  function hasAuthoringMeta(clips) {
    return (clips || []).some(function (c) { return AUTHORING_FIELDS.some(function (k) { return c && Object.prototype.hasOwnProperty.call(c, k); }); });
  }

  // "2026-09-13 10:22:00" / ISO → "Sep 13, 2026" (the article screen's date chip).
  function prettyDate(s) {
    if (!s) return "";
    var m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return String(s);
    return MONTHS[parseInt(m[2], 10) - 1] + " " + parseInt(m[3], 10) + ", " + m[1];
  }
  function domainOf(card) {
    var u = (card.media && card.media.source_url) || card.sourceUrl || card.url || "";
    return String(u).replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0];
  }
  // Same hue-by-subject the multiplayer mapper uses today, kept stable so cards keep their colour.
  var HUES = { World: 20, Politics: 350, Disaster: 205, Health: 150, Science: 180, Tech: 265, Media: 300, Gaming: 120, Sports: 40, Brands: 335 };
  function hueForSubject(subject, idx) { return HUES[subject] !== undefined ? HUES[subject] : (idx * 47) % 360; }

  // The NPC gut-check votes the solo file seeds per story (maya / diego / priya). Not part of the
  // row — derived here so a generated story plays like a hand-written one: a spun story splits the
  // teammates, a straight one leans true, and the split is deterministic per claim id.
  function npcVotesFor(planted, claimId) {
    var spun = !!(planted && planted.tell);
    var k = claimId % 3;
    if (!spun) return [{ maya: "true", diego: "true", priya: "biased" }, { maya: "true", diego: "biased", priya: "true" }, { maya: "biased", diego: "true", priya: "true" }][k];
    return [{ maya: "misinfo", diego: "true", priya: "biased" }, { maya: "biased", diego: "true", priya: "biased" }, { maya: "misinfo", diego: "biased", priya: "true" }][k];
  }

  function mapV12Card(card, claimId, idx) {
    var post = card.post || {};
    var planted = post.planted || { tell: null, receipts: [], why: "" };
    var receipts = (planted.receipts || []).map(function (r) { return r + "-" + claimId; });
    var media = card.media || {};
    var domain = domainOf(card);
    var clips = (card.clips || []).map(function (cl) {
      var c = stripAuthoringMeta(cl);
      c.id = cl.id + "-" + claimId;
      // A receipt clip the row carried (same-phrase) keeps its tell only if the story planted it.
      if (c.tell && c.tell !== planted.tell) c.tell = null;
      return c;
    });
    var claim = {
      id: claimId,
      subject: card.subject,
      topic: card.topic || card.subject,
      hue: hueForSubject(card.subject || "", idx || 0),
      sourceUrl: card.sourceUrl || card.url || "",
      wired: !!(card.hook && clips.length),
      hook: card.hook || "",
      npcVotes: npcVotesFor(planted, claimId),
      headline: post.headline || card.headline || "",
      loaded: post.loaded || null,
      plain: post.plain || null,
      swaps: Array.isArray(post.swaps) ? post.swaps : [],
      tell: null, cardTell: null, cardWords: null,
      tells: Array.isArray(post.tells) ? post.tells.slice() : (planted.tell ? [planted.tell] : []),
      planted: { tell: planted.tell || null, receipts: receipts, why: planted.why || "" },
      media: { image_url: media.image_url || null, source_icon: media.source_icon || null, source_url: media.source_url || null,
               domain: domain, outlet: card.source || domain },
      article: { headline: card.headline || "", url: card.url || card.sourceUrl || "", date: prettyDate(card.date),
                 by: card.source || domain, kicker: (post.article && post.article.kicker) || card.subject || "",
                 lede: media.description || "", receipt: (post.article && post.article.receipt) || "" },
      background: card.background || null,
      source: (card.background || {}).handle || card.source || "Source"
    };
    return { claim: claim, clips: clips };
  }

  // Mirrors the hub-spoke's two parse-time CLAIMS.forEach blocks (9/14 Track F) for a runtime-loaded claim.
  function packageClips(claim) {
    var out = [];
    var b = claim.background || {}, a = claim.article, m = claim.media, pl = claim.planted || { receipts: [] };
    function tellFor(id) { return pl.receipts.indexOf(id) >= 0 ? pl.tell : null; }
    if (claim.background) out.push({ id: "bg-" + claim.id, source: "background",
      text: b.displayName + " (" + b.handle + ") — " + b.followers + " followers · " + b.joined, detail: null, tell: tellFor("bg-" + claim.id) });
    if (a) out.push({ id: "art-" + claim.id, look: "news", source: "article", who: "News / institution", text: a.headline, detail: (m ? m.outlet : "") + " · " + a.date, tell: tellFor("art-" + claim.id), receipt: a.receipt });
    if (claim.swaps && claim.swaps.length) out.push({ id: "swap-" + claim.id, look: "swap", source: "post", who: "The post itself",
      text: claim.swaps.length + " loaded words in the post — swap them for plain ones and it goes flat.", detail: "Plain version: “" + claim.plain + "”", tell: "feel",
      receipt: claim.swaps.length + " loaded words — swap them and it goes flat" });
    if (b.shop) out.push({ id: "shop-" + claim.id, look: "shop", source: "background", who: "Link in bio",
      text: b.handle + "'s link in bio: " + b.shop.item.name + " (" + b.shop.item.price + ") — " + b.shop.item.pitch, detail: b.shop.url, tell: tellFor("shop-" + claim.id), receipt: "the product needs the post to be true" });
    if (b.versions) out.push({ id: "ver-" + claim.id, look: "versions", source: "background", who: "Version history",
      text: b.handle + " posted this claim " + b.versions.rows.length + " ways this month; the wildest one is pinned (" + b.versions.rows[b.versions.rows.length - 1].n + " views).",
      detail: "A correction sits in the comments (" + b.versions.correction.likes + " likes); the post was never edited.", tell: tellFor("ver-" + claim.id), receipt: b.versions.rows.length + " tries — the wildest one got pinned" });
    return out;
  }

  function mapDropCards(cards) {
    var claims = [], clipsById = {};
    (cards || []).forEach(function (c, idx) {
      var r = mapV12Card(c, 9000 + idx, idx);
      claims.push(r.claim);
      clipsById[r.claim.id] = r.clips.concat(packageClips(r.claim));
    });
    return { claims: claims, clips: clipsById };
  }

  return { mapV12Card: mapV12Card, mapDropCards: mapDropCards, packageClips: packageClips,
           stripAuthoringMeta: stripAuthoringMeta, hasAuthoringMeta: hasAuthoringMeta, prettyDate: prettyDate, AUTHORING_FIELDS: AUTHORING_FIELDS };
});
