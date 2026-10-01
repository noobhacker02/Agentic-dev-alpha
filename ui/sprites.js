// Pixel sprites for the page: art only, nothing from any run. The data is window.__SPRITES__ (built by
// src/sprites.ts from ui/assets/manifest.json, inline in a saved report). This turns it into CSS once:
//   .ic-<name> / .ic-<name>-s   17px / 12px icons         .cat-<pose>   the cat; with .spr-play a strip animates
//   :root --cur-<name>          pixel cursors (applied in index.html, switchable)
// If the data is missing, every helper returns "" / null and the page draws plain glyphs instead.
(function () {
  const AL = (window.AL = window.AL || {});
  const data = window.__SPRITES__ || {};
  const css = [];
  const items = (data.icons && data.icons.items) || {};
  const safeName = (n) => /^[\w-]+$/.test(n);

  css.push(".px{display:inline-block;flex:none;image-rendering:pixelated;background-repeat:no-repeat;background-position:center;vertical-align:-4px}");
  for (const [name, e] of Object.entries(items)) {
    if (!safeName(name) || !e.src) continue;
    css.push(`.ic-${name}{width:17px;height:17px;background-image:url(${e.src})}`);
    if (e.small) css.push(`.ic-${name}-s{width:12px;height:12px;vertical-align:-2px;background-image:url(${e.small})}`);
  }
  for (const [name, e] of Object.entries(data.cat || {})) {
    if (!safeName(name) || !e.src) continue;
    const total = e.w * e.frames;
    css.push(`.cat-${name}{width:${e.w}px;height:${e.h}px;background-image:url(${e.src});background-size:${total}px ${e.h}px;background-position:0 0;image-rendering:pixelated;background-repeat:no-repeat}`);
    if (e.frames > 1 && e.fps > 0) {
      css.push(`@keyframes kf-cat-${name}{from{background-position:0 0}to{background-position:-${total}px 0}}`);
      css.push(`.cat-${name}.spr-play{animation:kf-cat-${name} ${(e.frames / e.fps).toFixed(3)}s steps(${e.frames}) infinite}`);
    }
  }
  // Fallback keyword for each cursor, used if the image cannot be shown.
  const FALLBACK = { pointer: "pointer", text: "text", crosshair: "crosshair", move: "move", grab: "grab", grabbing: "grabbing", "not-allowed": "not-allowed", "no-drop": "no-drop", progress: "progress", wait: "wait", "zoom-in": "zoom-in", "ns-resize": "ns-resize", "ew-resize": "ew-resize", "nwse-resize": "nwse-resize", "nesw-resize": "nesw-resize" };
  const vars = [];
  for (const [name, c] of Object.entries(data.cursors || {})) {
    if (!safeName(name) || !c.src) continue;
    vars.push(`--cur-${name}:url(${c.src}) ${c.x | 0} ${c.y | 0},${FALLBACK[name] || "auto"}`);
  }
  if (vars.length) css.push(`:root{${vars.join(";")}}`);
  css.push("@media (prefers-reduced-motion: reduce){.spr-play{animation:none!important}}");

  const style = document.createElement("style");
  style.id = "sprite-css";
  style.textContent = css.join("\n");
  document.head.appendChild(style);

  AL.sprites = {
    data,
    credits: Array.isArray(data.credits) ? data.credits : [],
    /** True when a sprite is available: "cat.idle", "dino.run", "icons.planner", "cursors.pointer". */
    has(path) {
      const [a, b] = String(path).split(".");
      if (a === "icons") return !!(items[b] && items[b].src);
      return !!(data[a] && data[a][b] && data[a][b].src);
    },
    spec(path) { const [a, b] = String(path).split("."); return (data[a] && data[a][b]) || null; },
    /** `<i>` markup for an icon (17px, or 12px when `small`), or "" when there is none. */
    icon(name, small) {
      const e = items[name];
      if (!e || !safeName(name) || !e.src || (small && !e.small)) return "";
      return `<i class="px ic-${name}${small ? "-s" : ""}" aria-hidden="true"></i>`;
    },
    /** A decoded <img> for a canvas, or null when the sprite is missing. */
    image(path) {
      const e = this.spec(path);
      if (!e || !e.src) return null;
      const img = new Image();
      img.src = e.src;
      return img;
    },
    hasCursors: vars.length > 0,
  };
})();
