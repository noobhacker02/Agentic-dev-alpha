// The cat. One element on a fixed layer that lives by the input box and walks to whatever needs you:
//   idle       sways at home (by the input box; on the welcome card before the first run)
//   working    dances while an agent works
//   attention  runs to the waiting permission prompt, sits on its top edge and hops until you answer
//   win / fail stands by the run's closing card with stars, or slumps
//   sleep      naps after 90 s of nothing happening
// It is decoration and a nudge: it never reads run content, never touches the prompt, and the page works the
// same with it off (help dialog) or if this file fails to load. Positions come from the live layout (getBoundingClientRect).
(function () {
  const AL = (window.AL = window.AL || {});
  const S = AL.sprites;
  const KEY = "agent-loop-cat";
  const SLEEP_MS = 90_000;
  const NUDGES = [[20_000, "still waiting on you"], [60_000, "psst. still here"], [180_000, "I'll just sit here, then"]];
  const PET = ["mrrp", "purr", "mew", "you found the cat", "nyah", "pspsps back at you"];
  const reduce = () => !!(window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches);
  const idle = S && S.spec("cat.idle");
  const W = idle ? idle.w : 56, H = idle ? idle.h : 69;
  const api = { enabled: false, mood: "idle", anchor: "home", x: 0, y: 0 };
  AL.mascot = api;
  if (!S || !S.has("cat.idle") || !S.has("cat.dance") || !S.has("cat.hop")) { api.sync = api.touch = api.speak = api.react = api.setEnabled = () => {}; api.state = () => ({ enabled: false, mood: "idle", anchor: "home", x: 0, y: 0, hidden: true }); return; }

  // Plain mode (ui/plain.js) wins over the cat's own setting, which is left alone so it is back as it was when plain mode ends.
  const pref = () => { if (AL.plain) return false; try { return localStorage.getItem(KEY) !== "off"; } catch { return true; } };
  let el, body, bubble, wrap, layout = null;
  let mood = "idle", lastSay = "", lastActivity = Date.now(), attentionSince = 0, nudged = 0;
  let travelTimer = null, bubbleTimer = null, flash = null, enabled = false, queued = false;

  function build() {
    el = document.createElement("div");
    el.id = "cat"; el.setAttribute("aria-hidden", "true"); el.dataset.mood = "idle"; el.dataset.anchor = "home";
    el.innerHTML = '<div class="cat-bubble" hidden></div><div class="cat-wrap"><div class="cat-body cat-idle spr-play"></div></div>' +
      (S.has("cat.shadow") ? '<div class="cat-shade cat-shadow"></div>' : "") + '<div class="cat-zzz">z<span>z</span><span>z</span></div>';
    document.body.appendChild(el);
    body = el.querySelector(".cat-body"); bubble = el.querySelector(".cat-bubble"); wrap = el.querySelector(".cat-wrap");
    body.addEventListener("click", pet);
    el.addEventListener("transitionend", (e) => { if (e.target === el && e.propertyName === "transform") arrived(); });
  }

  const rect = (sel) => { const n = document.querySelector(sel); if (!n) return null; const r = n.getBoundingClientRect(); return r.width > 0 && r.height > 0 ? r : null; };
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  /** Where the cat should stand for a mood: its feet on the top edge of the thing it is about. */
  function target(m) {
    const vw = document.documentElement.clientWidth, vh = window.innerHeight;
    let r;
    if (m === "attention" && (r = rect("#prompt"))) return { anchor: "prompt", x: r.right - W - 18, y: r.top - H + 8 };
    if ((m === "win" || m === "fail") && (r = rect(".blk.run-end"))) {
      const view = rect("#scroll");
      if (view && r.top >= view.top + H && r.bottom <= view.bottom) return { anchor: "run-end", x: r.right - W - 16, y: r.top - H + 6 };
    }
    if (m === "idle" && (r = rect("#w-cat-spot"))) {
      const view = rect("#scroll");
      if (view && r.top >= view.top && r.bottom <= view.bottom) return { anchor: "welcome", x: r.left, y: r.bottom - H };
    }
    r = rect("#dock .inputrow") || rect("#dock .statusline") || rect("#dock");
    if (r) return { anchor: "home", x: r.right - W - 16, y: r.top - H + 4 };
    return { anchor: "home", x: vw - W - 20, y: vh - H - 20 };
  }

  function pose(name, play) { body.className = "cat-body cat-" + name + (play && !reduce() ? " spr-play" : ""); }
  function apply() {
    if (!el) return;
    el.dataset.mood = mood;
    wrap.className = "cat-wrap" + (mood === "attention" && !reduce() ? " hopping" : "") + (mood === "fail" ? " slump" : "") + (mood === "sleep" ? " asleep" : "");
    if (flash) return;
    if (mood === "attention") pose("hop", false);
    else if (mood === "working") pose("dance", true);
    else if (mood === "win") pose("win", true);
    else if (mood === "sleep" || mood === "fail") pose("idle", false);
    else pose("idle", true);
  }
  function arrived() { clearTimeout(travelTimer); el.classList.remove("travelling"); apply(); }

  function place(force) {
    if (!enabled || !el) return;
    const t = target(mood);
    const x = Math.round(clamp(t.x, 0, document.documentElement.clientWidth - W)), y = Math.round(clamp(t.y, 0, window.innerHeight - H));
    const moved = Math.hypot(x - api.x, y - api.y);
    el.dataset.anchor = t.anchor; api.anchor = t.anchor;
    if (!force && moved < 1) return;
    if (moved > 40 && !reduce() && el.dataset.placed) {
      // Going somewhere: dance on the way, face the way it is heading.
      el.classList.add("travelling"); el.classList.toggle("flip", x < api.x);
      if (!flash) pose("dance", true);
      clearTimeout(travelTimer); travelTimer = setTimeout(arrived, 1100);
    }
    el.style.transform = `translate(${x}px, ${y}px)`;
    el.dataset.placed = "1";
    api.x = x; api.y = y;
  }
  function schedule() { if (queued) return; queued = true; requestAnimationFrame(() => { queued = false; place(false); }); }

  function say(text, ms) {
    clearTimeout(bubbleTimer);
    if (!text) { bubble.hidden = true; return; }
    bubble.textContent = text; bubble.hidden = false;
    if (ms) bubbleTimer = setTimeout(() => { bubble.hidden = true; lastSay = ""; resay(); }, ms);
  }
  const resay = () => { if (mood === "attention" && lastSay) say(lastSay); };

  function pet() {
    touch();
    if (flash) return;
    say(PET[Math.floor(Math.random() * PET.length)], 2200);
    const h = document.createElement("i"); h.className = "px ic-heart cat-heart"; el.appendChild(h);
    setTimeout(() => h.remove(), 1300);
    const kids = el.querySelectorAll(".cat-heart"); if (kids.length > 5) kids[0].remove();
    AL.sound && AL.sound.sfx("meow");
    react("win", 1200);
  }
  /** A short pose that interrupts the mood for a moment ("win" after a pet, "charge" when the Overseer decides). */
  function react(name, ms) {
    if (!enabled || !el || mood === "attention") return;
    clearTimeout(flash); pose(name, name === "win");
    flash = setTimeout(() => { flash = null; apply(); }, ms || 1200);
  }
  function touch() { lastActivity = Date.now(); if (mood === "sleep") { mood = "idle"; apply(); schedule(); } }

  /**
   * The page's state in one call: { status, pending, say, offline }. Cheap; call it after anything changes.
   * `say` is the line shown while the cat is asking for you ("builder needs you"); it is never run content.
   */
  function sync(s) {
    if (!enabled || !el) return;
    let m;
    if (s.offline) m = "hidden";
    else if (s.pending > 0) m = "attention";
    else if (s.status === "running") m = "working";
    else if (s.status === "done") m = "win";
    else if (s.status === "failed" || s.status === "stopped") m = "fail";
    else m = "idle";
    if (m === "idle" && Date.now() - lastActivity > SLEEP_MS) m = "sleep";
    el.hidden = m === "hidden";
    if (m !== mood) {
      const was = mood; mood = m;
      if (m === "attention") { attentionSince = Date.now(); nudged = 0; setTimeout(schedule, 350); }
      if (was === "attention") say("");
      if (m === "fail") say("…", 4000); else if (m === "win") say("done!", 4000);
      apply();
    }
    if (mood === "attention") { lastSay = s.say || "needs you"; if (bubble.hidden || bubble.textContent !== lastSay) say(lastSay); }
    schedule();
  }

  function enable(on) {
    enabled = on;
    if (on && !el) build();
    if (el) { el.hidden = !on; if (on) { el.dataset.placed = ""; place(true); apply(); } }
    api.enabled = on;
  }
  api.setEnabled = (on) => { try { localStorage.setItem(KEY, on ? "on" : "off"); } catch {} enable(on && !AL.plain); };
  api.sync = sync; api.touch = touch; api.speak = (t, ms) => enabled && say(t, ms); api.react = react;
  api.state = () => ({ enabled, mood, anchor: api.anchor, x: api.x, y: api.y, hidden: !!(el && el.hidden) });

  // Gentle nudges while something waits, and the nap check.
  setInterval(() => {
    if (!enabled || !el) return;
    if (mood === "attention") {
      const waited = Date.now() - attentionSince;
      while (nudged < NUDGES.length && waited >= NUDGES[nudged][0]) {
        say(NUDGES[nudged][1], 4000); AL.sound && AL.sound.sfx("meow"); nudged++;
      }
    } else if (mood === "idle" && Date.now() - lastActivity > SLEEP_MS) { mood = "sleep"; apply(); }
  }, 1000);
  addEventListener("resize", schedule);
  addEventListener("pointermove", () => { if (mood === "sleep") touch(); }, { passive: true });
  addEventListener("keydown", () => { if (mood === "sleep") touch(); }, true);
  document.addEventListener("scroll", schedule, true);   // the run-end card and the welcome card move as the page scrolls
  // The prompt and new transcript blocks slide in; measured mid-slide they are a few pixels off, so look again when any animation ends.
  document.addEventListener("animationend", schedule, true);
  const watchDock = () => { const dock = document.getElementById("dock"); if (dock && window.ResizeObserver) new ResizeObserver(schedule).observe(dock); };
  if (document.readyState !== "loading") watchDock(); else document.addEventListener("DOMContentLoaded", watchDock);
  if (document.readyState !== "loading") enable(pref()); else document.addEventListener("DOMContentLoaded", () => enable(pref()));
  if (AL.onPlain) AL.onPlain(() => enable(pref()));
})();
