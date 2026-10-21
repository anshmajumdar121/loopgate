// Side-effect module: MUST stay the first import in index.ts. The stores and
// the agent spawner read LOOP_DATA_DIR / LOOP_WORKSPACES_ROOT / LOOP_WORKDIR /
// LOOP_LLM_AGENT_SCRIPT once, at module evaluation, and ES modules evaluate
// in import order — so public demo mode has to fix the env up before them.
import { isPublicDemo, preparePublicDemoEnv } from "./publicDemo.js";

if (isPublicDemo()) {
  const { scrubbed, dataDir, workspacesRoot } = preparePublicDemoEnv();
  console.log("[loop-agent-backend] PUBLIC DEMO MODE — fake LLM only, connections read-only, writes confined to temp dirs");
  console.log(`[loop-agent-backend] demo data: ${dataDir}; workspaces: ${workspacesRoot}`);
  if (scrubbed.length > 0) {
    console.log(`[loop-agent-backend] ignored in public demo mode: ${scrubbed.join(", ")}`);
  }
}
