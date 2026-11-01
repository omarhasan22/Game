/* Game Hub SDK — added automatically to every uploaded game.
 *
 * In your game, when the student finishes, call:
 *   GameHub.submit({ score: 7, max_score: 10, duration_s: 95, status: "completed", details: { ... } })
 * Every field is optional. status is "completed" (default) or "not_finished".
 *
 * GameHub.player holds { full_name, grade, section, attempt_no } once the page has sent it,
 * and a "gamehub:player" event fires on window when it arrives.
 */
(function () {
  // Games run in a sandbox where the browser blocks localStorage / sessionStorage.
  // Give them an in-memory copy so games that use storage keep working (data lasts for this play only).
  function memoryStorage() {
    var m = new Map();
    return {
      getItem: function (k) { k = String(k); return m.has(k) ? m.get(k) : null; },
      setItem: function (k, v) { m.set(String(k), String(v)); },
      removeItem: function (k) { m.delete(String(k)); },
      clear: function () { m.clear(); },
      key: function (i) { return Array.from(m.keys())[i] || null; },
      get length() { return m.size; }
    };
  }
  ["localStorage", "sessionStorage"].forEach(function (name) {
    var works = false;
    try { works = !!window[name]; } catch (e) { /* blocked by the sandbox */ }
    if (!works) {
      try { Object.defineProperty(window, name, { value: memoryStorage(), configurable: true }); } catch (e) {}
    }
  });

  var inHub = window.parent && window.parent !== window;

  var GameHub = {
    inHub: inHub,
    player: null,
    submit: function (result) {
      var data;
      try { data = JSON.parse(JSON.stringify(result || {})); } catch (e) { data = {}; }
      if (inHub) window.parent.postMessage({ type: "gamehub-result", result: data }, "*");
      else console.info("[GameHub] result (not sent, game is not inside Game Hub):", data);
      return true;
    }
  };

  window.addEventListener("message", function (e) {
    if (e.source !== window.parent || !e.data || e.data.type !== "gamehub-player") return;
    GameHub.player = e.data.player || null;
    try { window.dispatchEvent(new CustomEvent("gamehub:player", { detail: GameHub.player })); } catch (err) {}
  });

  window.GameHub = GameHub;
  if (inHub) window.parent.postMessage({ type: "gamehub-ready" }, "*");
})();
