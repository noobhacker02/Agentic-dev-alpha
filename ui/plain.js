// Plain mode: one switch for every cartoon on the page (the cat, the pixel icons and cursors, the dinosaur game,
// sound and the turning glyph). It decides first, before any of them loads, so each one asks `AL.plain`.
//   window.__PLAIN_DEFAULT__  the server's default for a browser that has never chosen (agent-loop run --plain)
//   ?plain=1 / ?plain=0       explicit for this browser, and remembered
//   agent-loop-plain          the remembered choice in localStorage ("on" / "off")
// The page works the same either way: this only decides what is drawn and played. A saved report honours it too.
(function () {
  const AL = (window.AL = window.AL || {});
  const KEY = "agent-loop-plain";
  const listeners = [];
  const read = () => { try { return localStorage.getItem(KEY); } catch { return null; } };
  const write = (on) => { try { localStorage.setItem(KEY, on ? "on" : "off"); } catch {} };

  let plain = !!window.__PLAIN_DEFAULT__;
  const saved = read();
  if (saved === "on") plain = true; else if (saved === "off") plain = false;
  try {
    const q = new URLSearchParams(location.search).get("plain");
    if (q !== null) { plain = /^(1|on|true|yes)$/i.test(q); write(plain); }
  } catch {}

  AL.plain = plain;
  document.documentElement.dataset.plain = plain ? "on" : "off";
  /** Called with the new value whenever it changes, after `AL.plain` and the page attribute are updated. */
  AL.onPlain = (fn) => { listeners.push(fn); };
  AL.setPlain = (on) => {
    on = !!on;
    write(on);
    if (on === AL.plain) return on;
    AL.plain = on;
    document.documentElement.dataset.plain = on ? "on" : "off";
    for (const fn of listeners) { try { fn(on); } catch {} }
    return on;
  };
})();
