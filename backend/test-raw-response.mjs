const apiKey = process.argv[2];
const url = "https://integrate.api.nvidia.com/v1/chat/completions";
const r = await fetch(url, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    authorization: `Bearer ${apiKey}`,
  },
  body: JSON.stringify({
    model: "minimaxai/minimax-m3",
    messages: [{ role: "user", content: "Reply with just 'pong'." }],
    max_tokens: 20,
  }),
});
console.log("status:", r.status);
const text = await r.text();
console.log("raw response:");
console.log(text);
