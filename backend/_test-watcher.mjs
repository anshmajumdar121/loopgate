import chokidar from "chokidar";
import { writeFile, readFile } from "node:fs/promises";
import { resolve as pathResolve } from "node:path";

const dir = "/tmp/watcher-test";
await import("node:fs/promises").then(fs => fs.mkdir(dir, { recursive: true }));
const goalPath = pathResolve(dir, "GOAL.md");
await writeFile(goalPath, "", "utf8");

const watcher = chokidar.watch(dir, {
  persistent: true,
  ignoreInitial: true,
  awaitWriteFinish: false,
  depth: 0,
});

let changeCount = 0;
watcher.on("add", (p) => {
  console.log(`[${new Date().toISOString()}] ADD ${p}`);
  changeCount++;
});
watcher.on("change", (p) => {
  console.log(`[${new Date().toISOString()}] CHANGE ${p}`);
  changeCount++;
});
watcher.on("error", (e) => console.log(`ERROR ${e.message}`));

// Wait for watcher to be ready
await new Promise(r => setTimeout(r, 500));
console.log("watcher ready, current GOAL.md size:", (await readFile(goalPath, "utf8")).length);

// Simulate planner write
await new Promise(r => setTimeout(r, 200));
console.log("writing 5000 chars to GOAL.md...");
await writeFile(goalPath, "x".repeat(5000), "utf8");
console.log("written, current size:", (await readFile(goalPath, "utf8")).length);

// Wait for events
await new Promise(r => setTimeout(r, 1500));
console.log(`total change events: ${changeCount}`);
await watcher.close();
