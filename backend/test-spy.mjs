import { createOpenAI } from "@ai-sdk/openai";
const apiKey = process.argv[2];
let captured = null;
const openai = createOpenAI({
  baseURL: "https://integrate.api.nvidia.com/v1",
  apiKey,
  fetch: async (url, opts) => {
    captured = { url, method: opts.method, headers: opts.headers, body: opts.body };
    const r = await fetch(url, opts);
    const t = await r.text();
    console.log("REQUEST:", opts.method, url);
    console.log("REQ HEADERS:", JSON.stringify(opts.headers));
    console.log("REQ BODY:", opts.body?.toString().slice(0, 500));
    console.log("RES:", r.status);
    console.log("RES BODY:", t.slice(0, 500));
    return new Response(t, { status: r.status, headers: r.headers });
  },
});
import { generateText } from "ai";
try {
  const { text } = await generateText({
    model: openai("minimaxai/minimax-m3"),
    prompt: "Reply pong.",
    temperature: 0.7,
    maxOutputTokens: 20,
  });
  console.log("OK:", text);
} catch (e) {
  console.log("ERR:", e.message);
  if (captured) {
    console.log("REQUEST WAS:", JSON.stringify(captured, null, 2));
  }
}
