import OpenAI from "openai";

const apiKey = process.env.OPENAI_API_KEY;
const baseURL = process.env.OPENAI_BASE_URL ?? "https://www.chenzk.top/v1";
const model = process.env.OPENAI_MODEL ?? "gpt-5.4";

if (!apiKey) {
  console.error("Set OPENAI_API_KEY first.");
  process.exit(1);
}

const client = new OpenAI({ apiKey, baseURL });

try {
  const response = await client.chat.completions.create({
    model,
    messages: [{ role: "user", content: "Reply with exactly: OK" }],
    max_tokens: 20,
  });
  console.log("SUCCESS");
  console.log(response.choices[0]?.message?.content ?? "(empty)");
} catch (error) {
  console.error("FAILED");
  console.error(error?.message ?? error);
  process.exit(1);
}
