import type { Connection } from "../types.js";

/** Which local CLI a `local-cli` connection drives. The preset (providerId)
 *  picks it; older connections without one keep using `claude`. The value is
 *  handed to llm-agent.mjs as LOOP_CLI_TOOL (see backend/cli-tools.mjs). */
export type CliTool = "claude" | "gemini" | "kimi";

export function cliToolForConnection(
  connection: Pick<Connection, "providerId"> | null | undefined
): CliTool {
  if (connection?.providerId === "gemini-cli") return "gemini";
  if (connection?.providerId === "kimi-cli") return "kimi";
  return "claude";
}
