// Use as: node --import ./test/fixtures/trace-resolve.mjs <script>
import { register } from "node:module";
register("./trace-resolve-hooks.mjs", import.meta.url);
