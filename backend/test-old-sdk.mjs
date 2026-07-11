import { generateText } from "ai";
import { createOpenAI } from "@ai-sdk/openai";

const apiKey = process.argv[2];
const openai = createOpenAI({
  baseURL: "https://integrate.api.nvidia.com/v1",
  apiKey,
  fetch: async (url, opts) => {
    console.log("URL:", url);
    return await fetch(url, opts);
  },
});
const { text } = await generateText({
  model: openai("minimaxai/minimax-m3"),
  prompt: "Reply with just 'pong'.",
});
console.log("OK:", text);
