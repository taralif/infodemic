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
  var CODE_WORDS = [
    "FOX", "OWL", "ELM", "IVY", "JAY", "KOI", "RAY", "SKY", "ZEN", "OAK"
  ];
  function generateRoomCode() {
    var word = CODE_WORDS[Math.floor(Math.random() * CODE_WORDS.length)];
    var digits = String(Math.floor(1000 + Math.random() * 9000));
    return word + "-" + digits;
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
    generateRoomCode: generateRoomCode // exposed for tests
  };
})();
