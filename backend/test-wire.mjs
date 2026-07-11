import { createOpenAI } from "@ai-sdk/openai";
const apiKey = process.argv[2];

const openai = createOpenAI({
  baseURL: "https://integrate.api.nvidia.com/v1",
  apiKey,
  fetch: async (url, opts) => {
    console.log("REQ:", opts?.method || "GET", url);
    console.log("HEADERS:", JSON.stringify(opts?.headers || {}));
    if (opts?.body) console.log("BODY:", opts.body.toString().slice(0, 400));
    console.log("----");
    const r = await fetch(url, opts);
    const t = await r.text();
    console.log("RES:", r.status, "len=", t.length);
    console.log("BODY:", t.slice(0, 400));
    return new Response(t, { status: r.status, headers: r.headers });
  },
});

import { generateText } from "ai";
try {
  const { text } = await generateText({
    model: openai("minimaxai/minimax-m3"),
    prompt: "Reply pong.",
  });
  console.log("OK:", text);
} catch (e) {
  console.log("ERR:", e.message?.slice(0, 300));
}
