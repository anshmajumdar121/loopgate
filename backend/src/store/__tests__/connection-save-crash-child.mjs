// Run only by connections-persistence.test.ts with an isolated temp data dir.
// Stall the real persistence implementation at the commit boundary so the
// parent can hard-kill it after writeFile closes but before rename executes.
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { resolve } from "node:path";

if (!process.env.LOOP_DATA_DIR || !process.send) {
  throw new Error("crash fixture requires an explicit data dir and IPC parent");
}
const destination = resolve(process.env.LOOP_DATA_DIR, "..", "_connections.json");
const rename = fs.rename;
fs.rename = async (from, to) => {
  if (to !== destination) return rename(from, to);
  process.send({ tmpPath: from });
  await new Promise(() => {});
};
syncBuiltinESMExports();
// Keep the IPC channel referenced while rename is deliberately suspended.
process.on("message", () => {});

const { saveConnections } = await import("../persistence.ts");
await saveConnections(JSON.parse(process.argv[2]));
throw new Error("crash fixture unexpectedly completed rename");
