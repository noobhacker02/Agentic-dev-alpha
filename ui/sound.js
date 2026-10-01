// Sound, generated in the browser with Web Audio: no audio files, nothing downloaded, nothing to license.
//  off    (the default) -- silent, and no AudioContext is even created
//  sfx    -- short blips: a prompt needs you, you approved/denied, a phase passed/failed, the run ended, the cat
//  music  -- sfx plus a quiet chiptune loop that follows the run: pad + bells when idle, bass/arp/soft drums while
//            an agent works, thinned out while something waits on you, stops a few seconds after the run ends
// Browsers only allow sound after a click or key press, so the context is created by the toggle (or by the first
// click/key after a page load that remembered "music"), never on load.
(function () {
  const AL = (window.AL = window.AL || {});
  const KEY = "agent-loop-sound";
  const MODES = ["off", "sfx", "music"];
  const BPM = 96, STEP = 60 / BPM / 4;     // sixteenth notes
  const AHEAD = 0.25, TICK_MS = 40;
  const LINGER_MS = 9000;                   // music keeps playing this long after a run ends, then fades
  let ctx = null, master = null, musicBus = null, sfxBus = null, noise = null;
  let mode = "off", mood = "idle", timer = null, stopTimer = null, step = 0, nextTime = 0;
  let notes = 0, sfxPlayed = 0, unlockArmed = false, seed = 7;
  const lastSfx = Object.create(null);

  const hz = (m) => 440 * Math.pow(2, (m - 69) / 12);
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const persist = (m) => { try { localStorage.setItem(KEY, m); } catch {} };

  function makeNoise(c) {
    const len = Math.floor(c.sampleRate * 0.12), buf = c.createBuffer(1, len, c.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }
  function ensureCtx() {
    if (ctx) return true;
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return false;
    try {
      ctx = new Ctor();
      master = ctx.createGain(); master.gain.value = 0.9; master.connect(ctx.destination);
      musicBus = ctx.createGain(); musicBus.gain.value = 0.55; musicBus.connect(master);
      sfxBus = ctx.createGain(); sfxBus.gain.value = 0.85; sfxBus.connect(master);
      noise = makeNoise(ctx);
      return true;
    } catch { ctx = null; return false; }
  }

  /** One enveloped note. o: slideTo (Hz), glide [[secondsIn, Hz]...], lp / bp (filter Hz), bus. */
  function tone(freq, t, dur, type, gain, o) {
    o = o || {};
    const osc = ctx.createOscillator(), g = ctx.createGain();
    osc.type = type; osc.frequency.setValueAtTime(freq, t);
    if (o.slideTo) osc.frequency.exponentialRampToValueAtTime(o.slideTo, t + dur);
    if (o.glide) for (const [dt, f] of o.glide) osc.frequency.exponentialRampToValueAtTime(f, t + dt);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + Math.min(0.012, dur / 3));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    let node = osc;
    for (const [kind, f] of [["lowpass", o.lp], ["bandpass", o.bp]]) {
      if (!f) continue;
      const fl = ctx.createBiquadFilter(); fl.type = kind; fl.frequency.value = f; fl.Q.value = kind === "bandpass" ? 3 : 0.7;
      node.connect(fl); node = fl;
    }
    node.connect(g); g.connect(o.bus || sfxBus);
    osc.start(t); osc.stop(t + dur + 0.05);
    notes++;
  }
  function hat(t, gain) {
    const src = ctx.createBufferSource(), g = ctx.createGain(), hp = ctx.createBiquadFilter();
    src.buffer = noise; hp.type = "highpass"; hp.frequency.value = 7000;
    g.gain.setValueAtTime(gain, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
    src.connect(hp); hp.connect(g); g.connect(musicBus); src.start(t); src.stop(t + 0.08); notes++;
  }
  function kick(t, gain) {
    const osc = ctx.createOscillator(), g = ctx.createGain();
    osc.frequency.setValueAtTime(140, t); osc.frequency.exponentialRampToValueAtTime(42, t + 0.12);
    g.gain.setValueAtTime(gain, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
    osc.connect(g); g.connect(musicBus); osc.start(t); osc.stop(t + 0.2); notes++;
  }

  // ---- the effects
  const SFX = {
    click: (t) => tone(1200, t, 0.035, "square", 0.05),
    prompt: (t) => { tone(659, t, 0.12, "triangle", 0.2); tone(880, t + 0.13, 0.22, "triangle", 0.2); },
    allow: (t) => [523, 659, 784].forEach((f, i) => tone(f, t + i * 0.06, 0.09, "square", 0.07)),
    deny: (t) => tone(220, t, 0.24, "sawtooth", 0.09, { slideTo: 120, lp: 900 }),
    pass: (t) => [523, 784, 1047].forEach((f, i) => tone(f, t + i * 0.07, 0.11, "triangle", 0.14)),
    fail: (t) => [330, 262, 220].forEach((f, i) => tone(f, t + i * 0.14, 0.24, "triangle", 0.14)),
    win: (t) => [523, 659, 784, 1047, 1319].forEach((f, i) => tone(f, t + i * 0.09, 0.18, "square", 0.065)),
    meow: (t) => tone(650, t, 0.36, "sine", 0.2, { glide: [[0.12, 980], [0.36, 520]], bp: 1300 }),
    jump: (t) => tone(420, t, 0.16, "square", 0.06, { slideTo: 840 }),
    point: (t) => { tone(988, t, 0.07, "square", 0.05); tone(1319, t + 0.07, 0.12, "square", 0.05); },
    die: (t) => [392, 330, 262, 196].forEach((f, i) => tone(f, t + i * 0.1, 0.16, "square", 0.07)),
  };

  // ---- the music: A minor, Am - F - C - G, one bar each (16 steps)
  const CHORDS = [
    { root: 45, arp: [57, 60, 64, 69] },
    { root: 41, arp: [53, 57, 60, 65] },
    { root: 48, arp: [55, 60, 64, 67] },
    { root: 43, arp: [55, 59, 62, 67] },
  ];
  const BELLS = [76, 79, 81, 84];
  const ARP_PATTERN = [0, 1, 2, 3, 2, 1, 2, 3];
  function playStep(s, t) {
    const bar = Math.floor(s / 16) % 4, k = s % 16, ch = CHORDS[bar];
    const calm = mood === "idle" || mood === "done" || mood === "failed" || mood === "attention";
    if (k === 0) for (const n of ch.arp.slice(0, 3)) tone(hz(n), t, STEP * 15, "triangle", 0.03, { bus: musicBus, lp: 1400 }); // pad
    if (k === 0 || k === 8) tone(hz(ch.root), t, STEP * (k === 0 ? 6 : 5), "triangle", 0.1, { bus: musicBus });                    // bass
    if (mood === "working") {
      if (k % 2 === 0) tone(hz(ch.arp[ARP_PATTERN[(k / 2) % 8]] + 12), t, STEP * 1.8, "square", 0.028, { bus: musicBus, lp: 2400 });
      if (k === 0 || k === 8) kick(t, 0.11);
      if (k % 2 === 1) hat(t, 0.028);
    } else if (calm && (k === 0 || k === 8) && rnd() < (mood === "attention" ? 0.35 : 0.6)) {
      tone(hz(BELLS[Math.floor(rnd() * BELLS.length)]), t + STEP * 2, STEP * 12, "triangle", 0.03, { bus: musicBus });             // a sparse bell
    }
  }
  function pump() {
    if (!ctx || mode !== "music" || document.hidden) { nextTime = ctx ? Math.max(nextTime, ctx.currentTime) : 0; return; }
    if (nextTime < ctx.currentTime) nextTime = ctx.currentTime + 0.05;
    while (nextTime < ctx.currentTime + AHEAD) { playStep(step, nextTime); step++; nextTime += STEP; }
  }
  function startMusic() {
    if (!ctx || mode !== "music" || timer) return;
    musicBus.gain.cancelScheduledValues(ctx.currentTime); musicBus.gain.setValueAtTime(0.55, ctx.currentTime);
    nextTime = ctx.currentTime + 0.05;
    timer = setInterval(pump, TICK_MS);
  }
  function stopMusic(fade) {
    if (timer) { clearInterval(timer); timer = null; }
    if (ctx && fade) { const t = ctx.currentTime; musicBus.gain.cancelScheduledValues(t); musicBus.gain.setValueAtTime(musicBus.gain.value, t); musicBus.gain.linearRampToValueAtTime(0.0001, t + 1.2); }
  }

  /**
   * Renders a timeline to audio offline: no speaker, no click, the live engine untouched. It exists so the walkthrough
   * videos can carry the real music (a headless browser is muted). timeline entries are { at: seconds, mood } or
   * { at: seconds, sfx }; music starts at the first mood and, like the live loop, stops LINGER_MS after done/failed.
   * Returns an AudioBuffer (mono, 44.1 kHz).
   */
  async function render(seconds, timeline) {
    const Off = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!Off) throw new Error("no OfflineAudioContext in this browser");
    const keep = { ctx, master, musicBus, sfxBus, noise, seed, mood };
    const rate = 44100;
    try {
      ctx = new Off(1, Math.ceil(seconds * rate), rate);
      master = ctx.createGain(); master.gain.value = 0.9; master.connect(ctx.destination);
      musicBus = ctx.createGain(); musicBus.gain.value = 0.55; musicBus.connect(master);
      sfxBus = ctx.createGain(); sfxBus.gain.value = 0.85; sfxBus.connect(master);
      noise = makeNoise(ctx);
      seed = 7;
      const moods = timeline.filter((e) => e.mood).sort((a, b) => a.at - b.at);
      if (moods.length) {
        for (let k = 0, t = moods[0].at; t < seconds; k++, t += STEP) {
          let m = moods[0].mood, since = moods[0].at;
          for (const e of moods) if (e.at <= t) { m = e.mood; since = e.at; }
          if ((m === "done" || m === "failed") && (t - since) * 1000 > LINGER_MS) break;
          mood = m; playStep(k, t);
        }
      }
      for (const e of timeline) if (e.sfx && SFX[e.sfx]) SFX[e.sfx](Math.max(0, e.at));
      return await ctx.startRendering();
    } finally {
      ({ ctx, master, musicBus, sfxBus, noise, seed, mood } = keep);
    }
  }

  const api = {
    modes: MODES,
    render,
    get mode() { return mode; },
    /** Switch mode. Must be called from a click/key handler to start sound; "off" never needs one. */
    setMode(m) {
      if (!MODES.includes(m)) return mode;
      if (m === "off") { mode = "off"; stopMusic(false); if (ctx) ctx.suspend().catch(() => {}); persist(m); return mode; }
      if (!ensureCtx()) { mode = "off"; return mode; }
      mode = m; persist(m);
      ctx.resume().catch(() => {});
      if (m === "music") startMusic(); else stopMusic(false);
      return mode;
    },
    cycle() { return api.setMode(MODES[(MODES.indexOf(mode) + 1) % MODES.length]); },
    /** What the music follows: idle | working | attention | done | failed. */
    setMood(m) {
      if (m === mood) return;
      mood = m;
      clearTimeout(stopTimer); stopTimer = null;
      if (mode !== "music") return;
      if (m === "done" || m === "failed") stopTimer = setTimeout(() => stopMusic(true), LINGER_MS);
      else if (!timer) startMusic();
    },
    sfx(name) {
      if (mode === "off" || !ctx || ctx.state !== "running" || !SFX[name]) return false;
      const now = performance.now();
      if (now - (lastSfx[name] || 0) < 80) return false;
      lastSfx[name] = now; sfxPlayed++;
      SFX[name](ctx.currentTime + 0.01);
      return true;
    },
    /** Remember-and-wait: a saved mode other than "off" starts at the first click or key press, never on load. */
    restore() {
      let saved = "off";
      try { saved = localStorage.getItem(KEY) || "off"; } catch {}
      if (!MODES.includes(saved) || saved === "off") return;
      mode = saved;                       // shown on the button, but silent until there is a gesture
      if (unlockArmed) return;
      unlockArmed = true;
      const go = () => { removeEventListener("pointerdown", go, true); removeEventListener("keydown", go, true); unlockArmed = false; if (mode !== "off") api.setMode(mode); };
      addEventListener("pointerdown", go, true); addEventListener("keydown", go, true);
    },
    /** True while a remembered mode is waiting for its first click or key press. */
    get waiting() { return unlockArmed; },
    stats() { return { mode, mood, ctx: ctx ? ctx.state : "none", notes, sfx: sfxPlayed, music: !!timer }; },
  };
  AL.sound = api;
  document.addEventListener("visibilitychange", () => { if (!document.hidden && timer) nextTime = ctx.currentTime + 0.05; });
})();
