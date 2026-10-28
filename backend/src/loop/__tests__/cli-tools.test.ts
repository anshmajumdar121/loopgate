// Gemini / Kimi local-CLI connectors — checks the per-tool invocation
// contract in backend/cli-tools.mjs without the real (logged-in) CLIs, plus
// the providerId → tool mapping the spawner hands to llm-agent.mjs.
//
// cli-tools.mjs lives at the package root next to llm-agent.mjs (outside
// tsc's src/), so it is loaded by a cwd-anchored runtime import, the same
// way llm-agent-cli.test.ts anchors llm-agent.mjs.

import { describe, it, expect, afterEach } from "vitest";
import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { cliToolForConnection } from "../cli-tool.js";

const CLI_TOOLS_URL = pathToFileURL(resolve(process.cwd(), "cli-tools.mjs")).href;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const load = (): Promise<any> => import(CLI_TOOLS_URL);

describe("cliToolForConnection", () => {
  it("maps presets to tools and defaults to claude", () => {
    expect(cliToolForConnection({ providerId: "gemini-cli" })).toBe("gemini");
    expect(cliToolForConnection({ providerId: "kimi-cli" })).toBe("kimi");
    expect(cliToolForConnection({ providerId: "local-cli" })).toBe("claude");
    expect(cliToolForConnection({})).toBe("claude");
    expect(cliToolForConnection(null)).toBe("claude");
  });
});

describe("buildCliInvocation", () => {
  it("keeps the original claude contract (prompt in argv, cwd = workdir)", async () => {
    const { buildCliInvocation } = await load();
    const inv = buildCliInvocation({ tool: "claude", prompt: "P", workdir: "/w" });
    expect(inv).toEqual({ bin: "claude", args: ["-p", "P", "--output-format", "text"], cwd: "/w" });
  });

  it("sends the prompt to gemini on stdin, never in argv", async () => {
    const { buildCliInvocation } = await load();
    const prompt = "x".repeat(100_000);
    const inv = buildCliInvocation({ tool: "gemini", model: "pro", prompt, workdir: "/w" });
    expect(inv.bin).toBe("gemini");
    expect(inv.input).toBe(prompt);
    expect(inv.args.join(" ")).not.toContain(prompt);
    expect(inv.args).toEqual(expect.arrayContaining(["-o", "text", "-m", "pro"]));
    expect(inv.cwd).toBe("/w");
  });

  it("writes the kimi prompt to TASK.md and restricts kimi to the Read tool", async () => {
    const { buildCliInvocation, KIMI_AGENT_MD } = await load();
    const inv = buildCliInvocation({ tool: "kimi", prompt: "DO IT", workdir: "/w", taskDir: "/t" });
    expect(inv.cwd).toBe("/t");
    expect(inv.args.join(" ")).not.toContain("DO IT");
    expect(inv.files["TASK.md"]).toContain("DO IT");
    expect(inv.files["TASK.md"]).toContain("/w");
    expect(inv.args).toEqual(expect.arrayContaining(["--agent-file", "loopgate-text.md"]));
    expect(inv.files["loopgate-text.md"]).toBe(KIMI_AGENT_MD);
    expect(KIMI_AGENT_MD).toMatch(/^tools: \[Read\]$/m);
    expect(inv.args).not.toContain("--yolo");
  });

  it("drops default / unsafe model ids instead of putting them on the command line", async () => {
    const { buildCliInvocation } = await load();
    for (const model of ["", "default", "pro & calc", 'a"b', "x|y", undefined]) {
      const inv = buildCliInvocation({ tool: "gemini", model, prompt: "P", workdir: "/w" });
      expect(inv.args).not.toContain("-m");
    }
    const ok = buildCliInvocation({ tool: "kimi", model: "kimi-code/kimi-for-coding", prompt: "P", workdir: "/w", taskDir: "/t" });
    expect(ok.args.slice(-2)).toEqual(["-m", "kimi-code/kimi-for-coding"]);
  });

  it("takes kimi's reply from the last assistant message in stream-json", async () => {
    const { parseCliOutput } = await load();
    const stdout = [
      '{"role":"meta","type":"system.version","version":"2.4.0"}',
      '{"role":"assistant","tool_calls":[{"type":"function","function":{"name":"Read"}}]}',
      '{"role":"tool","tool_call_id":"t1","content":"1\\tthe task"}',
      '{"role":"assistant","content":"ALPHA\\n\\n## Verdict\\nAPPROVE"}',
      '{"role":"meta","type":"session.resume_hint","content":"To resume this session: kimi -r x"}',
      "",
    ].join("\r\n");
    expect(parseCliOutput("kimi", stdout)).toBe("ALPHA\n\n## Verdict\nAPPROVE");
    expect(parseCliOutput("kimi", "not json")).toBe("");
    expect(parseCliOutput("gemini", "  hi \n")).toBe("hi");
  });

  it("rejects unknown tools", async () => {
    const { buildCliInvocation } = await load();
    expect(() => buildCliInvocation({ tool: "gpt", prompt: "P", workdir: "/w" })).toThrow(/unknown CLI tool/);
  });

  it("quotes cmd.exe args that contain spaces and leaves plain ones alone", async () => {
    const { quoteWinArg } = await load();
    expect(quoteWinArg("text")).toBe("text");
    expect(quoteWinArg("kimi-code/kimi-for-coding")).toBe("kimi-code/kimi-for-coding");
    expect(quoteWinArg("Read TASK.md now.")).toBe('"Read TASK.md now."');
    expect(quoteWinArg("C:\\Program Files\\x.cmd")).toBe('"C:\\Program Files\\x.cmd"');
  });
});

describe("runCliTool", () => {
  let dir: string | null = null;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = null;
  });

  /** A fake CLI that prints its args and stdin as JSON — a .cmd shim on
   *  Windows (like npm's, so the cmd.exe route is exercised), a shell
   *  script elsewhere. The dir name has a space to exercise quoting. */
  async function fakeCli(): Promise<string> {
    dir = await mkdtemp(join(tmpdir(), "fake cli-"));
    const script = join(dir, "echo.mjs");
    await writeFile(
      script,
      `let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{` +
        `process.stdout.write(JSON.stringify({args:process.argv.slice(2),stdin:s,cwd:process.cwd()}))});`
    );
    if (process.platform === "win32") {
      const bin = join(dir, "fake.cmd");
      await writeFile(bin, `@"${process.execPath}" "${script}" %*\r\n`);
      return bin;
    }
    const bin = join(dir, "fake");
    await writeFile(bin, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
    await chmod(bin, 0o755);
    return bin;
  }

  it("gemini: prompt arrives on stdin, flags arrive intact", async () => {
    const { runCliTool } = await load();
    const bin = await fakeCli();
    const prompt = "line one\nline \"two\" & 100% <ok>";
    const r = runCliTool({ tool: "gemini", bin, model: "flash", prompt, workdir: dir });
    expect(r.error, String(r.error)).toBeUndefined();
    expect(r.status, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.stdin).toBe(prompt);
    expect(out.args).toEqual([
      "-p",
      "Follow the instructions above. Reply with only the final answer.",
      "-o",
      "text",
      "-m",
      "flash",
    ]);
  });

  it("kimi: runs in a temp task dir holding TASK.md, then cleans it up", async () => {
    const { runCliTool } = await load();
    const bin = await fakeCli();
    const r = runCliTool({ tool: "kimi", bin, prompt: "TASK BODY", workdir: dir });
    expect(r.status, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.args).toContain("--agent-file");
    expect(out.cwd).toMatch(/loopgate-kimi-/);
    // Task dir is removed after the run.
    await expect(stat(out.cwd)).rejects.toThrow();
  });
});
