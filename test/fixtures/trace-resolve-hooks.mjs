// Module-resolution hook: appends every specifier Node resolves to $TRACE_RESOLVE_FILE, so a test can
// prove a module (here, the native desktop driver) was -- or was never -- loaded by a spawned process.
import { appendFileSync } from "node:fs";

export async function resolve(specifier, context, nextResolve) {
  const file = process.env.TRACE_RESOLVE_FILE;
  if (file) appendFileSync(file, `${specifier}\n`);
  return nextResolve(specifier, context);
}
