import { generateText } from "ai";
import { createOpenAI } from "@ai-sdk/openai";

const apiKey = process.argv[2];
if (!apiKey) { console.error("usage: node test-llm.mjs <key>"); process.exit(2); }

const openai = createOpenAI({
  baseURL: "https://integrate.api.nvidia.com/v1",
  apiKey,
});

const t0 = Date.now();
const { text } = await generateText({
  model: openai("minimaxai/minimax-m3"),
  prompt: "Reply with just the word 'pong' and nothing else.",
});
console.log(`OK in ${Date.now()-t0}ms:`, text);
