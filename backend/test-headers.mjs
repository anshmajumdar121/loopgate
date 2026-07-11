import { createOpenAI } from "@ai-sdk/openai";
const apiKey = process.argv[2];
const openai = createOpenAI({
  baseURL: "https://integrate.api.nvidia.com/v1",
  apiKey,
  fetch: async (url, opts) => {
    console.log("=== ACTUAL REQUEST ===");
    console.log("URL:", url);
    console.log("HEADERS:", JSON.stringify(opts.headers, null, 2));
    console.log("BODY:", opts.body?.toString().slice(0, 300));
    console.log("=====================");
    return await fetch(url, opts);
  },
});

// Try chat to see what request it builds
try {
  await openai("minimaxai/minimax-m3")?.doGenerate?.({
    inputFormat: "messages",
    mode: { type: "regular" },
    prompt: [{ role: "user", content: [{ type: "text", text: "hi" }]}],
    maxOutputTokens: 10,
  });
} catch (e) {
  console.log("ERR:", e.message);
}
