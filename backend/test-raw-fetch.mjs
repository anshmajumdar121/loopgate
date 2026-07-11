// Mimic exactly what @ai-sdk/openai does — capture what headers it sends
const apiKey = process.argv[2];
const url = "https://integrate.api.nvidia.com/v1/chat/completions";

const r1 = await fetch(url, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "authorization": `Bearer ${apiKey}`,
  },
  body: JSON.stringify({
    model: "minimaxai/minimax-m3",
    messages: [{ role: "user", content: "hi" }],
    max_tokens: 10,
  }),
});
console.log("RAW FETCH:", r1.status, r1.statusText);
console.log(await r1.text());
