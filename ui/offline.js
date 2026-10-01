// "Can't reach agent-loop": shown when the page loses its connection to the run's server (and the run was not
// already over), gone the moment it reconnects. Chrome's offline dinosaur lives here: Space/↑ jumps, ↓ ducks, a tap
// jumps. The dino and the score digits are your sprites; the cacti are drawn in code in the same grey.
// Nothing here touches the run, the approval socket, or the transcript.
(function () {
  const AL = (window.AL = window.AL || {});
  const S = AL.sprites;
  const HI_KEY = "agent-loop-dino-hi";
  const INK = "#535353", PAPER = "#f7f7f7";
  const SHOW_AFTER_MS = 900;           // a blip of a reconnect never flashes the screen
  let root, canvas, g2, attemptEl, showTimer = null, shown = false, game = null, imgs = null;

  const api = { onRetry: null, isShown: () => shown, state: () => ({ shown, playing: !!(game && game.running), over: !!(game && game.over), score: game ? game.score : 0, hi: game ? game.hi : 0, y: game ? game.y : 0, duck: !!(game && game.duck), speed: game ? Math.round(game.speed) : 0, obs: game ? game.obs.map((o) => Math.round(o.x)) : [] }) };
  AL.offline = api;

  function build() {
    root = document.createElement("div");
    root.id = "offline"; root.hidden = true; root.tabIndex = -1;
    root.setAttribute("role", "alertdialog"); root.setAttribute("aria-modal", "true");
    root.setAttribute("aria-labelledby", "off-title"); root.setAttribute("aria-describedby", "off-body");
    root.innerHTML =
      '<div class="off-card">' +
      '<canvas id="dino" aria-label="A dinosaur runner game. Press space to jump."></canvas>' +
      '<h2 id="off-title">Can\'t reach agent-loop</h2>' +
      '<p id="off-body">The page lost its connection to the run\'s server. The run may have finished, crashed, or its terminal was closed. Trying again every second or two · <span id="off-attempt"></span></p>' +
      '<div class="off-actions"><button type="button" id="off-retry" tabindex="-1">Retry now</button><button type="button" id="off-play" tabindex="-1">Play while you wait</button></div>' +
      '<p class="off-fine">Space or ↑ jump · ↓ duck · tap to jump</p></div>';
    document.body.appendChild(root);
    canvas = root.querySelector("#dino"); g2 = canvas.getContext("2d"); attemptEl = root.querySelector("#off-attempt");
    root.querySelector("#off-retry").onclick = () => { if (api.onRetry) api.onRetry(); };
    root.querySelector("#off-play").onclick = () => { press(); };
    canvas.addEventListener("pointerdown", (e) => { e.preventDefault(); press(); });
    imgs = {};
    for (const n of ["stand", "run", "dead", "duck", "digits", "gameover", "restart"]) imgs[n] = S && S.image("dino." + n);
  }

  // ---- the game, in sprite pixels (each one drawn at an integer number of screen pixels)
  const DINO_X = 28, GROUND = 12, GRAV = 900, JUMP_V = 330;
  function size() {
    const avail = Math.max(240, Math.min(root.querySelector(".off-card").clientWidth - 32, 600));
    const zoom = 1;                       // Chrome's own scale: a 4:1 canvas and a 44px dino, crisp on hi-dpi because each sprite pixel is a whole number of device pixels
    const dpr = Math.max(1, Math.round(window.devicePixelRatio || 1));
    const wd = Math.floor(avail / zoom), ht = Math.round(wd / 4);
    canvas.style.width = wd * zoom + "px"; canvas.style.height = ht * zoom + "px";
    canvas.width = wd * zoom * dpr; canvas.height = ht * zoom * dpr;
    g2.setTransform(zoom * dpr, 0, 0, zoom * dpr, 0, 0); g2.imageSmoothingEnabled = false;
    return { wd, ht };
  }
  function newGame() {
    const dim = size();
    let hi = 0; try { hi = +localStorage.getItem(HI_KEY) || 0; } catch {}
    const stand = S && S.spec("dino.stand");
    return { ...dim, running: false, over: false, y: 0, vy: 0, duck: false, speed: 200, dist: 0, score: 0, hi, obs: [], spawn: 0.6, t: 0, last: 0, raf: 0,
      dw: stand ? stand.w : 40, dh: stand ? stand.h : 43 };
  }
  function drawDigits(text, rightX, y) {
    const spec = S && S.spec("dino.digits"), img = imgs.digits;
    if (!spec || !img) { g2.fillStyle = INK; g2.font = "10px monospace"; g2.textAlign = "right"; g2.fillText(text, rightX, y + 9); return; }
    let x = rightX;
    for (let i = text.length - 1; i >= 0; i--) {
      const gl = spec.glyphs[text[i]]; if (!gl) continue;
      x -= gl[1] + 1; g2.drawImage(img, gl[0], 0, gl[1], spec.h, x, y, gl[1], spec.h);
    }
  }
  function cactus(x, h) {
    const gy = game.ht - GROUND;
    g2.fillStyle = INK;
    g2.fillRect(x + 6, gy - h, 7, h);
    g2.fillRect(x, gy - h * 0.55, 6, 4); g2.fillRect(x, gy - h * 0.55 - 9, 4, 13);
    g2.fillRect(x + 13, gy - h * 0.45, 6, 4); g2.fillRect(x + 15, gy - h * 0.45 - 8, 4, 12);
  }
  function frame(ts) {
    const q = game; if (!q) return;
    const dt = Math.min(0.05, q.last ? (ts - q.last) / 1000 : 0); q.last = ts;
    if (q.running && !q.over) {
      q.t += dt; q.speed = Math.min(420, q.speed + 6 * dt); q.dist += q.speed * dt; q.score = Math.floor(q.dist / 10);
      q.vy -= (q.duck && q.y > 0 ? GRAV * 3 : GRAV) * dt; q.y += q.vy * dt;
      if (q.y <= 0) { q.y = 0; if (q.vy < 0) q.vy = 0; }   // landing stops a fall; it must not cancel a jump that has just begun
      q.spawn -= dt;
      if (q.spawn <= 0) { q.obs.push({ x: q.wd + 10, h: [26, 32, 38][Math.floor(Math.random() * 3)] }); q.spawn = (110 + Math.random() * 170) / q.speed + 0.35; }
      for (const o of q.obs) o.x -= q.speed * dt;
      q.obs = q.obs.filter((o) => o.x > -30);
      const ducking = q.duck && q.y === 0, bw = ducking ? 46 : q.dw - 10, bh = ducking ? 22 : q.dh - 6;
      for (const o of q.obs) {
        const ox = o.x + 4, ow = 11, oh = o.h - 3;
        if (DINO_X + 4 < ox + ow && DINO_X + 4 + bw > ox && q.y < oh && q.y + bh > 0) { die(); break; }
      }
    }
    // ---- paint
    g2.fillStyle = PAPER; g2.fillRect(0, 0, q.wd, q.ht);
    const gy = q.ht - GROUND;
    g2.fillStyle = INK; g2.fillRect(0, gy, q.wd, 1);
    for (let i = 0; i < 14; i++) { const sx = ((i * 53 - q.dist * 0.9) % (q.wd + 40) + q.wd + 40) % (q.wd + 40) - 20; g2.fillRect(sx, gy + 3 + (i % 3) * 2, 3 + (i % 2) * 2, 1); }
    for (const o of q.obs) cactus(o.x, o.h);
    let img = imgs.stand, fw = q.dw, fx = 0, name = "stand";
    if (q.over) { img = imgs.dead; name = "dead"; }
    else if (q.running && q.duck && q.y === 0 && imgs.duck) { img = imgs.duck; const sp = S.spec("dino.duck"); fw = sp.w; fx = (Math.floor(q.t * 8) % sp.frames) * sp.w; name = "duck"; }
    else if (q.running && q.y === 0 && imgs.run) { img = imgs.run; const sp = S.spec("dino.run"); fx = (Math.floor(q.t * 8) % sp.frames) * sp.w; name = "run"; }
    const sp = S && S.spec("dino." + name), fh = sp ? sp.h : q.dh;
    const dy = gy - fh - q.y + 1;
    if (img && img.complete && img.naturalWidth) g2.drawImage(img, fx, 0, fw, fh, DINO_X, dy, fw, fh);
    else { g2.fillStyle = INK; g2.fillRect(DINO_X, dy, q.dw, fh); }          // sprites missing: still playable
    drawDigits(String(q.score).padStart(5, "0"), q.wd - 8, 6);
    if (q.hi) { drawDigits(String(q.hi).padStart(5, "0"), q.wd - 66, 6); drawDigits("HI", q.wd - 122, 6); }
    if (q.over && imgs.gameover && imgs.gameover.complete) {
      const go = S.spec("dino.gameover"), rs = S.spec("dino.restart");
      g2.drawImage(imgs.gameover, Math.round((q.wd - go.w) / 2), Math.round(q.ht * 0.28));
      if (imgs.restart) g2.drawImage(imgs.restart, Math.round((q.wd - rs.w) / 2), Math.round(q.ht * 0.28) + go.h + 8);
    } else if (!q.running) {
      g2.fillStyle = INK; g2.font = "9px monospace"; g2.textAlign = "center"; g2.fillText("press space to play", q.wd / 2, q.ht * 0.4);
    }
    q.raf = requestAnimationFrame(frame);
  }
  function die() {
    game.over = true; game.running = false;
    if (game.score > game.hi) { game.hi = game.score; try { localStorage.setItem(HI_KEY, String(game.score)); } catch {} }
    AL.sound && AL.sound.sfx("die");
  }
  function press() {
    if (!game) return;
    if (game.over) { const hi = game.hi; game = Object.assign(newGame(), { hi, running: true, raf: game.raf, last: 0 }); return; }
    if (!game.running) { game.running = true; game.last = 0; }
    if (game.y === 0) { game.vy = JUMP_V; AL.sound && AL.sound.sfx("jump"); }
  }
  function onKey(e) {
    if (!shown) return;
    const down = e.type === "keydown";
    if (e.code === "Space" || e.code === "ArrowUp") { if (down) { e.preventDefault(); if (!e.repeat) press(); } }
    else if (e.code === "ArrowDown") { e.preventDefault(); if (game) game.duck = down; }
  }
  document.addEventListener("keydown", onKey, true);
  document.addEventListener("keyup", onKey, true);

  function reveal() {
    if (shown) return;
    if (!root) build();
    shown = true; root.hidden = false;
    game = newGame(); game.raf = requestAnimationFrame(frame);
    root.focus({ preventScroll: true });
  }
  /** The connection dropped (attempt = how many retries so far). The screen waits a moment so a blip never shows it. */
  api.lost = function (attempt) {
    api.attempt = attempt;
    if (shown) { attemptEl.textContent = "attempt " + attempt; return; }
    if (showTimer) return;
    showTimer = setTimeout(() => { showTimer = null; reveal(); attemptEl.textContent = "attempt " + (api.attempt || 1); }, SHOW_AFTER_MS);
  };
  /** The connection is back (or the run is over): the screen goes away and the game stops. */
  api.found = function () {
    clearTimeout(showTimer); showTimer = null; api.attempt = 0;
    if (!shown) return;
    shown = false; root.hidden = true;
    if (game) { cancelAnimationFrame(game.raf); game = null; }
  };
  window.addEventListener("resize", () => { if (shown && game) { const keep = game; Object.assign(keep, size()); } });
})();
