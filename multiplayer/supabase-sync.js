// INFODEMIC multiplayer — Supabase sync layer (Week 1)
//
// Deliberately thin: this is the "easiest for MVP" sync approach discussed —
// one JSONB blob per room, read-modify-write, last-write-wins. No server-side
// vote-hiding, no optimistic-concurrency handling. Good enough for a solo
// 4-week build with a handful of trusted players; revisit if playtests show
// writes actually clobbering each other, or if this goes public.
//
// Depends on the Supabase JS CDN build being loaded on the page BEFORE this
// script, e.g.:
//   <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js"></script>
//   <script src="supabase-sync.js"></script>
//
// Fill in SUPABASE_URL / SUPABASE_ANON_KEY below once the project exists —
// see MULTIPLAYER_SETUP.md for how to get these.

var SUPABASE_URL = "https://gaafuidzcihkiiprdgmk.supabase.co";
var SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdhYWZ1aWR6Y2loa2lpcHJkZ21rIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODY0NzQ2ODQsImV4cCI6MjEwMjA1MDY4NH0.3pCTzQIAfhZrVNyRTD856d-ULu8ttISQYE3q56ZDRUg";

var InfodemicSync = (function () {
  var client = null;
  var roomChannel = null;
  var playersChannel = null;

  function ensureClient() {
    if (client) return client;
    if (typeof supabase === "undefined") {
      throw new Error(
        "Supabase JS library not found — make sure the CDN <script> tag is loaded before supabase-sync.js"
      );
    }
    if (SUPABASE_URL.indexOf("REPLACE_WITH") === 0) {
      throw new Error(
        "Set SUPABASE_URL / SUPABASE_ANON_KEY at the top of supabase-sync.js first — see MULTIPLAYER_SETUP.md"
      );
    }
    client = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    return client;
  }

  // ---------------- room codes ----------------
  // Shared word pool between ad hoc room codes and drop prefixes (see
  // personalization-data-model-sketch.md's "generalizing move" section) — both
  // draw from the same list so a word means one thing. Widened from 10 to 20
  // now that it serves double duty; collision with a *live* ad hoc room's word
  // (as opposed to a reserved drop prefix, which IS checked below) is still
  // possible but low-stakes — same "good enough for MVP" tradeoff as
  // last-write-wins state sync elsewhere in this file, not solved here.
  var CODE_WORDS = [
    "FOX", "OWL", "ELM", "IVY", "JAY", "KOI", "RAY", "SKY", "ZEN", "OAK",
    "BEAR", "WOLF", "HAWK", "DEER", "LYNX", "PUMA", "CRANE", "RAVEN", "ELK", "HERON"
  ];
  function generateRoomCode() {
    var word = CODE_WORDS[Math.floor(Math.random() * CODE_WORDS.length)];
    var digits = String(Math.floor(1000 + Math.random() * 9000));
    return word + "-" + digits;
  }
  function tableCodeFor(prefix) {
    var digits = String(Math.floor(1000 + Math.random() * 9000));
    return prefix + "-" + digits;
  }

  // ---------------- player identity ----------------
  var PLAYER_COLORS = ["#3ddc84", "#5ac8fa", "#ff9f5a", "#c583ff", "#ff6b6b", "#f5d76e"];
  function pickPlayerVisuals(name, existingPlayers) {
    var initial = (name || "?").trim().charAt(0).toUpperCase() || "?";
    var usedColors = (existingPlayers || []).map(function (p) { return p.color; });
    var color = PLAYER_COLORS.find(function (c) { return usedColors.indexOf(c) === -1; }) ||
      PLAYER_COLORS[Math.floor(Math.random() * PLAYER_COLORS.length)];
    return { initial: initial, color: color };
  }

  // ---------------- rooms ----------------
  // Creates a new room row (retrying the code on the rare collision), then
  // inserts the host as the first player. Returns {code, player}.
  function createRoom(hostName) {
    var db = ensureClient();
    function attempt(triesLeft) {
      var code = generateRoomCode();
      return db.from("rooms").insert({ code: code, state: {} }).select().single()
        .then(function (res) {
          if (res.error) {
            if (triesLeft > 0) return attempt(triesLeft - 1);
            throw res.error;
          }
          return code;
        });
    }
    return attempt(5).then(function (code) {
      return joinRoom(code, hostName).then(function (result) {
        return db.from("rooms").update({ host_player_id: result.player.id }).eq("code", code)
          .then(function () { return result; });
      });
    });
  }

  // Joins an existing room by code. Rejects if the room doesn't exist —
  // surface that to the user as "check the code" rather than silently
  // creating a new room under a typo'd code.
  function joinRoom(code, name) {
    var db = ensureClient();
    return db.from("rooms").select("code").eq("code", code).single().then(function (roomRes) {
      if (roomRes.error || !roomRes.data) {
        throw new Error("No room found with code " + code + " — double check with whoever created it.");
      }
      return db.from("players").select("*").eq("room_code", code).then(function (playersRes) {
        var visuals = pickPlayerVisuals(name, playersRes.data || []);
        return db.from("players").insert({
          room_code: code, name: name, initial: visuals.initial, color: visuals.color
        }).select().single().then(function (res) {
          if (res.error) throw res.error;
          return { code: code, player: res.data };
        });
      });
    });
  }

  // ---------------- drops (curator-published rounds) ----------------
  // Publishing a round from the content-pipeline console writes one of these.
  // No curator identity/auth — a drop is reached only by its code_prefix, same
  // spirit as a room being reached only by its code. See
  // personalization-data-model-sketch.md for the full design.
  function createDrop(dropData) {
    var db = ensureClient();
    function attempt(triesLeft, excludeWords) {
      var pool = CODE_WORDS.filter(function (w) { return excludeWords.indexOf(w) === -1; });
      var word = (pool.length ? pool : CODE_WORDS)[Math.floor(Math.random() * (pool.length ? pool.length : CODE_WORDS.length))];
      return db.from("drops").insert({
        code_prefix: word,
        title: dropData.title || "Untitled round",
        curated_by: dropData.curated_by || null,
        context: dropData.context || "general",
        topics_selected: dropData.topics_selected || [],
        cards: dropData.cards || []
      }).select().single().then(function (res) {
        if (res.error) {
          // unique_violation on code_prefix — try again with a different word
          if (triesLeft > 0) return attempt(triesLeft - 1, excludeWords.concat([word]));
          throw res.error;
        }
        return res.data;
      });
    }
    return attempt(8, []);
  }

  function findDropByPrefix(prefix) {
    var db = ensureClient();
    var normalized = (prefix || "").trim().toUpperCase();
    return db.from("drops").select("*").eq("code_prefix", normalized).maybeSingle().then(function (res) {
      if (res.error) throw res.error;
      return res.data || null;
    });
  }

  // Spins up a new table (room) for a published drop, retrying the table
  // number on the rare code collision — mirrors createRoom's retry shape.
  function startTableForDrop(drop, hostName) {
    var db = ensureClient();
    function attempt(triesLeft) {
      var code = tableCodeFor(drop.code_prefix);
      return db.from("rooms").insert({ code: code, state: {}, drop_id: drop.id }).select().single()
        .then(function (res) {
          if (res.error) {
            if (triesLeft > 0) return attempt(triesLeft - 1);
            throw res.error;
          }
          return code;
        });
    }
    return attempt(5).then(function (code) {
      return joinRoom(code, hostName).then(function (result) {
        return db.from("rooms").update({ host_player_id: result.player.id }).eq("code", code)
          .then(function () { return { code: code, player: result.player, drop: drop }; });
      });
    });
  }

  // ---------------- unified code entry ----------------
  // The single field every player types into, per the sketch's enterCode()
  // design: full "WORD-1234" shape joins an existing table; a bare word looks
  // up a published drop and mints a fresh table under it on the spot. Falls
  // back to the plain ad hoc createRoom() path only if the caller explicitly
  // asks for that (the lobby still offers "start without a drop").
  function enterCode(input, name) {
    var raw = (input || "").trim().toUpperCase();
    if (!raw) return Promise.reject(new Error("Enter a code first."));
    var isFullCode = /^[A-Z]+-\d+$/.test(raw);
    if (isFullCode) {
      return joinRoom(raw, name).then(function (result) {
        return { mode: "joined", code: result.code, player: result.player };
      });
    }
    return findDropByPrefix(raw).then(function (drop) {
      if (!drop) {
        throw new Error("No drop found for \"" + raw + "\" — check the word, or ask whoever published it.");
      }
      return startTableForDrop(drop, name).then(function (result) {
        return { mode: "started", code: result.code, player: result.player, drop: result.drop };
      });
    });
  }

  // Looks up whichever drop (if any) a room is linked to, so a UI can show
  // "here's what's actually in this round" — the confirmation step that was
  // missing: the lobby proved the code mechanism works, but nothing yet
  // proved a room picked up the *right* content, since there's no game
  // screen reading `drops.cards` today.
  function getDropForRoom(code) {
    var db = ensureClient();
    return db.from("rooms").select("drop_id").eq("code", code).single().then(function (roomRes) {
      if (roomRes.error) throw roomRes.error;
      if (!roomRes.data || !roomRes.data.drop_id) return null;
      return db.from("drops").select("*").eq("id", roomRes.data.drop_id).single().then(function (dropRes) {
        if (dropRes.error) throw dropRes.error;
        return dropRes.data;
      });
    });
  }

  // ---------------- story candidates (generated content, replaces mocked STORIES) ----------------
  // getStoryCandidates() reads whatever the generation Edge Function last
  // cached; refreshStoryCandidates() triggers a fresh pull+generate run. See
  // generate-drop-candidates (Edge Function) and personalization-data-model-
  // sketch.md's "Round 2 investigation content" section.
  function getStoryCandidates() {
    var db = ensureClient();
    return db.from("story_candidates").select("*").order("subject").then(function (res) {
      if (res.error) throw res.error;
      return res.data || [];
    });
  }

  // Invokes the Edge Function that pulls fresh headlines from NewsData.io and
  // generates their framings/hook/background/clips via Claude, replacing
  // whatever was cached before. Takes a while (sequential per-topic calls) —
  // callers should show a loading state, not treat this as instant. Resolves
  // to {inserted, errors} even on partial failure (some topics can fail while
  // others succeed); throws only if the function itself is unreachable or the
  // whole run failed.
  function refreshStoryCandidates() {
    var db = ensureClient();
    return db.functions.invoke("generate-drop-candidates", { method: "POST" }).then(function (res) {
      if (res.error) {
        // supabase-js's FunctionsHttpError.message is just "Edge Function
        // returned a non-2xx status code" — the actual reason (missing
        // secret, NewsData/Anthropic failure, etc.) is in error.context, the
        // raw Response, and has to be read out explicitly.
        var ctx = res.error.context;
        if (ctx && typeof ctx.json === "function") {
          return ctx.json().catch(function () { return null; }).then(function (body) {
            // Two different error shapes come back from the function: a
            // single {error} string (e.g. a missing secret, checked before
            // any topic runs) or {inserted:0, errors:[{subject,message}]}
            // (every topic failed individually, e.g. bad API keys).
            var msg = body && (
              body.error ||
              (body.errors && body.errors.length && body.errors.map(function (e) { return e.subject + ": " + e.message; }).join(" | "))
            );
            throw new Error(msg || res.error.message);
          });
        }
        throw res.error;
      }
      return res.data;
    });
  }

  function getPlayers(code) {
    var db = ensureClient();
    return db.from("players").select("*").eq("room_code", code).order("joined_at")
      .then(function (res) {
        if (res.error) throw res.error;
        return res.data;
      });
  }

  function getRoomState(code) {
    var db = ensureClient();
    return db.from("rooms").select("state").eq("code", code).single().then(function (res) {
      if (res.error) throw res.error;
      return res.data.state || {};
    });
  }

  // Read-modify-write helper for the shared state blob. `mutate(state)` gets
  // the current state and should return the new state to save (or mutate it
  // in place and return it). Last write wins if two players save at the same
  // instant — acceptable for MVP, see the note at the top of this file.
  function updateRoomState(code, mutate) {
    var db = ensureClient();
    return getRoomState(code).then(function (current) {
      var next = mutate(current || {}) || current;
      return db.from("rooms").update({ state: next }).eq("code", code).then(function (res) {
        if (res.error) throw res.error;
        return next;
      });
    });
  }

  // ---------------- realtime subscriptions ----------------
  // onPlayersChange(allPlayers) fires whenever anyone joins this room.
  // onStateChange(newState) fires whenever the shared state blob changes
  // (from any player, including this client's own writes).
  function subscribeRoom(code, handlers) {
    var db = ensureClient();
    handlers = handlers || {};

    if (playersChannel) db.removeChannel(playersChannel);
    if (roomChannel) db.removeChannel(roomChannel);

    playersChannel = db
      .channel("players-" + code)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "players", filter: "room_code=eq." + code },
        function () {
          if (handlers.onPlayersChange) {
            getPlayers(code).then(handlers.onPlayersChange);
          }
        }
      )
      .subscribe();

    roomChannel = db
      .channel("room-" + code)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "rooms", filter: "code=eq." + code },
        function (payload) {
          if (handlers.onStateChange) handlers.onStateChange(payload.new.state || {});
        }
      )
      .subscribe();

    return function unsubscribe() {
      if (playersChannel) db.removeChannel(playersChannel);
      if (roomChannel) db.removeChannel(roomChannel);
      playersChannel = null;
      roomChannel = null;
    };
  }

  return {
    createRoom: createRoom,
    joinRoom: joinRoom,
    getPlayers: getPlayers,
    getRoomState: getRoomState,
    updateRoomState: updateRoomState,
    subscribeRoom: subscribeRoom,
    generateRoomCode: generateRoomCode, // exposed for tests
    createDrop: createDrop,
    findDropByPrefix: findDropByPrefix,
    startTableForDrop: startTableForDrop,
    getDropForRoom: getDropForRoom,
    enterCode: enterCode,
    getStoryCandidates: getStoryCandidates,
    refreshStoryCandidates: refreshStoryCandidates
  };
})();
