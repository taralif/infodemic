/* Infodemic analytics — GoatCounter (no cookies, no personal data).
 * Dashboard: https://<GC_CODE>.goatcounter.com
 *
 * Counts page views plus a few anonymous game milestones, so we can see where
 * players drop off. Only runs on the live site (never on localhost, LAN test
 * servers, or file://). Each page includes this with <script src="analytics.js" defer>.
 *
 * Milestones are recorded by wrapping the game's own global functions after the
 * page loads, so the game files themselves don't change. If a function is renamed,
 * that one milestone silently stops counting — nothing breaks.
 */
(function(){
  var GC_CODE = "playinfodemic";
  var LIVE_HOSTS = ["playinfodemic.org", "www.playinfodemic.org", "taralif.github.io"];
  if (LIVE_HOSTS.indexOf(location.hostname) < 0) return;

  // Which page is this? Used as the prefix on every event name.
  var file = location.pathname.split("/").pop() || "index.html";
  var PAGE = {
    "index.html": "landing",
    "infodemic-hub-spoke-prototype.html": "demo",
    "infodemic-multiplayer-prototype.html": "multiplayer",
    "infodemic-class-wall.html": "class-wall",
    "infodemic-content-pipeline-prototype.html": "teacher-console",
    "playtest-kit.html": "playtest-kit"
  }[file] || file.replace(/\.html$/, "");

  // Load GoatCounter's counter. allow_frame: the landing page embeds the demo in an iframe.
  var s = document.createElement("script");
  s.async = true;
  s.src = "https://gc.zgo.at/count.js";
  s.setAttribute("data-goatcounter", "https://" + GC_CODE + ".goatcounter.com/count");
  s.setAttribute("data-goatcounter-settings", JSON.stringify({allow_frame: true}));
  document.head.appendChild(s);

  // Events fired before count.js arrives wait in a queue.
  var queue = [], sent = {};
  function flush(){
    if (!window.goatcounter || !window.goatcounter.count) return false;
    while (queue.length) {
      var ev = queue.shift();
      try { window.goatcounter.count({path: ev, title: ev, event: true}); } catch(e) {}
    }
    return true;
  }
  var tries = 0, timer = setInterval(function(){ if (flush() || ++tries > 60) clearInterval(timer); }, 500);

  // track("round-1-started") → event "demo / round-1-started". once=true counts it a single time per visit.
  function track(name, once){
    var ev = PAGE + " / " + name;
    if (once !== false) { if (sent[ev]) return; sent[ev] = true; }
    queue.push(ev); flush();
  }
  window.infodemicTrack = track;

  function wrap(fnName, eventName, opts){
    opts = opts || {};
    var orig = window[fnName];
    if (typeof orig !== "function") return;
    window[fnName] = function(){
      var out = orig.apply(this, arguments);
      try { if (!opts.when || opts.when.apply(null, arguments)) track(eventName, opts.once); } catch(e) {}
      return out;
    };
  }

  function hook(){
    // The game pages (demo, multiplayer, class wall) share these function names.
    wrap("beginRound1",       "1-round-1-started");
    wrap("startRoundReveal",  "2-round-1-finished");
    wrap("commitChase",       "3-round-2-started");
    wrap("r3Start",           "4-round-3-started");
    wrap("fileBoard",         "5-case-filed", {once: false});   // every filing counts
    wrap("endSession",        "6-game-finished");

    // Teacher console: publishing a feed moves it to step 2.
    if (PAGE === "teacher-console")
      wrap("go", "feed-published", {once: false, when: function(n){ return n === 2; }});

    // Landing page: which buttons people click.
    if (PAGE === "landing" || PAGE === "playtest-kit") {
      document.addEventListener("click", function(e){
        var a = e.target.closest && e.target.closest("a[href]");
        if (!a) return;
        var href = a.getAttribute("href") || "";
        if (href.charAt(0) === "#") return;
        var target = href.replace(/^https?:\/\//, "").replace(/[?#].*$/, "").replace(/\.html$/, "");
        track("click: " + (target || href), false);
      }, true);
    }
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", hook);
  else hook();
})();
