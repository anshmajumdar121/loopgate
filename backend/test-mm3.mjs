import { generateText } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
const apiKey = process.argv[2];
const openai = createOpenAI({ baseURL: "https://integrate.api.nvidia.com/v1", apiKey });

const r = await openai("minimaxai/minimax-m3").doGenerate({
  inputFormat: "messages",
  mode: { type: "regular" },
  prompt: [{ role: "user", content: [{ type: "text", text: "Reply pong." }]}],
  maxOutputTokens: 20,
  temperature: 0.7,
  headers: undefined,
});
console.log(JSON.stringify(r, null, 2).slice(0, 1500));
