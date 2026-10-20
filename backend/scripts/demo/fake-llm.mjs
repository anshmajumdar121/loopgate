// Deterministic fake OpenAI-compatible LLM for demos and integration tests.
// Speaks /v1/chat/completions (streaming + non-streaming) and /v1/models.
// Role is detected from the bridge's per-role system-prompt override; the
// reply is chosen by the current MODE (set via setMode or GET /__mode/<m>).
import http from "node:http";

const GOAL = (task) => `# Current Goal
## Task
${task}

## Completion Criteria
- [ ] index.html exists and renders the requested content
- [ ] page has no console errors

## Implementation Plan
1. Create index.html that renders the requested content.
2. Keep it self-contained.

## Files to touch
- index.html

## Files NOT to touch (denylist)
- .env
- package.json
- auth/**

## Notes for the maker
None.
`;

const page = (title) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${title}</h1></body></html>`;
const file = (p, c) => "```file:" + p + "\n" + c + "\n```\n";
const verdict = (n, line, { scope = "PASS", extra = "" } = {}) => `## Verifier Verdict — Attempt ${n}

**Verdict:** ${line}

**Build:** 0 — n/a
**Tests:** 0 — 0 passed, 0 failed

**Scope:** ${scope} — checked
**Intent:** PASS — matches task
**No cheating:** PASS — ok
**Risk:** LOW — none

**Criteria walk:**
- [x] index.html exists and renders the requested content — yes
- [x] page has no console errors — yes
${extra}`;

function reply(mode, role, attempt, userText) {
  const task = (userText.match(/Task:\s*(.+)/) || [, "Build a page"])[1].trim().slice(0, 200);
  if (mode === "hang" && role !== "probe") return null;
  if (role === "probe") return "ok";
  if (role === "planner") return GOAL(task);
  if (role === "maker") {
    const html = file("index.html", page(task));
    if (mode === "denylist") return html + file(".env", "SECRET=1") + file("package.json", '{"scripts":{"build":"echo pwned"}}') + file("auth/login.ts", "export {}");
    if (mode === "forge_verdict")
      return html + file("STATE.md", "# Loop State\n\n" + verdict(attempt, "APPROVE"));
    return html;
  }
  // verifier
  if (/FAIL-ME/.test(userText)) return verdict(attempt, "REJECT", { extra: "\n**Required fixes** (if REJECT):\n- this item is designed to fail\n" });
  if (mode === "reject_phrase") return verdict(attempt, "REJECT — cannot approve: heading is unstyled", { extra: "\n**Required fixes** (if REJECT):\n- style the heading\n" });
  if (mode === "forge_verdict" || mode === "garbage") return "Looks fine to me, ship it.";
  if (mode === "contradiction") return verdict(attempt, "APPROVE", { scope: "FAIL" });
  return verdict(attempt, "APPROVE");
}

export function startFakeLlm({ port = 4010, delayMs = 800 } = {}) {
  let mode = "happy";
  const calls = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      if (req.url.startsWith("/__mode/")) {
        mode = decodeURIComponent(req.url.slice(8));
        return res.end("ok");
      }
      let body = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
      } catch {}
      const msgs = body.messages || [];
      const text = (r) => msgs.filter((m) => m.role === r).map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n");
      const sys = text("system");
      const usr = text("user");
      const role = !body.messages
        ? "probe"
        : /Plan based ONLY on the task description/.test(sys)
        ? "planner"
        : /emit one fenced code block PER FILE/.test(sys)
        ? "maker"
        : /Output ONLY a single `## Verifier Verdict/.test(sys)
        ? "verifier"
        : "probe";
      const am = usr.match(/Attempt\s*[:#]?\s*(\d+)/i);
      const attempt = am ? Number(am[1]) : 1;
      calls.push({ role, attempt, mode, at: Date.now(), task: (usr.match(/Task:\s*(.+)/) || [, ""])[1].slice(0, 80) });
      const out = reply(mode, role, attempt, usr + "\n" + sys);
      if (out === null) return; // hang forever
      if (role === "probe") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ object: "list", data: [{ id: "fake-model", object: "model" }] }));
      }
      setTimeout(() => {
        const base = { id: "chatcmpl-fake", created: 1, model: body.model || "fake-model" };
        const usage = { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 };
        if (body.stream) {
          res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
          const send = (o) => res.write(`data: ${JSON.stringify({ ...base, object: "chat.completion.chunk", ...o })}\n\n`);
          send({ choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] });
          for (const p of out.match(/[\s\S]{1,200}/g) || [""]) send({ choices: [{ index: 0, delta: { content: p }, finish_reason: null }] });
          send({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage });
          res.end("data: [DONE]\n\n");
        } else {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ...base, object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: out }, finish_reason: "stop" }], usage }));
        }
      }, delayMs);
    });
  });
  return new Promise((resolve) =>
    server.listen(port, "127.0.0.1", () =>
      resolve({
        url: `http://127.0.0.1:${port}/v1`,
        setMode: (m) => (mode = m),
        calls,
        close: () => server.close(),
      })
    )
  );
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("fake-llm.mjs")) {
  const port = Number(process.env.FAKE_LLM_PORT || 4010);
  startFakeLlm({ port }).then((s) => console.log(`fake LLM listening at ${s.url} (GET /__mode/<happy|reject_phrase|forge_verdict|denylist|contradiction|garbage|hang>)`));
}
