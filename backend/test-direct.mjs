import { createOpenAI } from "@ai-sdk/openai";
const apiKey = process.argv[2];
const openai = createOpenAI({
  baseURL: "https://integrate.api.nvidia.com/v1",
  apiKey,
});

// Call doGenerate directly with full options, see what body it builds
const r = await openai("minimaxai/minimax-m3").doGenerate({
  inputFormat: "messages",
  mode: { type: "regular" },
  prompt: [{ role: "user", content: [{ type: "text", text: "Reply pong." }]}],
  maxTokens: 20,  // explicitly set
  temperature: 0.7,
  headers: undefined,
});
console.log("OK:", JSON.stringify(r).slice(0,200));
