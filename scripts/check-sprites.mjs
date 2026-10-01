// Checks the sprite set the UI loads (ui/assets/manifest.json and the PNGs it names). Run after swapping a sprite.
import { validateSprites, ASSET_DIR } from "../dist/sprites.js";
const problems = validateSprites(process.argv[2] ?? ASSET_DIR);
if (problems.length) {
  for (const p of problems) console.error("✗ " + p);
  process.exit(1);
}
console.log("sprites ok");
