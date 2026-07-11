import { generateText } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
const apiKey = process.argv[2];
const openai = createOpenAI({
  baseURL: "https://integrate.api.nvidia.com/v1",
  apiKey,
});
const { text } = await generateText({
  model: openai("minimaxai/minimax-m3"),
  prompt: "Reply pong.",
  temperature: 0.7,
});
console.log("RESPONSE:", text);
