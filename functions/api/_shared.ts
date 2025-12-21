export type ChunkRecord = {
  id: string;
  url: string;
  title: string;
  section: string;
  text: string;
  embedding: number[];
};

export type ChunkWithNorm = ChunkRecord & {
  norm: number;
};

export type ChatMessage = {
  role: "user" | "assistant";
  content: string;
};

export type Env = {
  OPENAI_API_KEY: string;
  OPENAI_MODEL?: string;
  OPENAI_EMBEDDING_MODEL?: string;
  EUI_RAG_BUCKET: R2Bucket;
};

const DEFAULT_MODEL = "gpt-5.2";
const DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small";
const CHUNKS_KEY = "chunks.json";

let cachedChunks: ChunkWithNorm[] | null = null;
let cachedMeta: { generatedAt?: string; model?: string; baseUrl?: string } | null = null;
let loadingPromise: Promise<ChunkWithNorm[]> | null = null;

function vectorNorm(values: number[]): number {
  let sum = 0;
  for (const value of values) {
    sum += value * value;
  }
  return Math.sqrt(sum);
}

function dotProduct(a: number[], b: number[]): number {
  let sum = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    sum += a[i] * b[i];
  }
  return sum;
}

export async function loadChunks(env: Env): Promise<ChunkWithNorm[]> {
  if (cachedChunks) return cachedChunks;
  if (loadingPromise) return loadingPromise;

  loadingPromise = (async () => {
    const object = await env.EUI_RAG_BUCKET.get(CHUNKS_KEY);
    if (!object) {
      throw new Error(`Missing ${CHUNKS_KEY} in R2 bucket.`);
    }
    const payload = (await object.json()) as {
      chunks?: ChunkRecord[];
      generatedAt?: string;
      model?: string;
      baseUrl?: string;
    };

    const chunks = (payload.chunks ?? []).map((chunk) => ({
      ...chunk,
      norm: vectorNorm(chunk.embedding)
    }));

    cachedMeta = {
      generatedAt: payload.generatedAt,
      model: payload.model,
      baseUrl: payload.baseUrl
    };
    cachedChunks = chunks;
    return chunks;
  })();

  return loadingPromise;
}

export function getMeta() {
  return cachedMeta;
}

export function rankChunks(chunks: ChunkWithNorm[], queryEmbedding: number[], limit: number) {
  const queryNorm = vectorNorm(queryEmbedding) || 1;
  const scored = chunks.map((chunk) => {
    const denom = chunk.norm ? chunk.norm * queryNorm : queryNorm;
    const score = denom ? dotProduct(chunk.embedding, queryEmbedding) / denom : 0;
    return { chunk, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

export async function embedQuery(text: string, env: Env): Promise<number[]> {
  const response = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: env.OPENAI_EMBEDDING_MODEL ?? DEFAULT_EMBEDDING_MODEL,
      input: text
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI embeddings failed: ${response.status} ${errorText}`);
  }

  const payload = (await response.json()) as { data?: { embedding?: number[] }[] };
  const embedding = payload.data?.[0]?.embedding;
  if (!embedding) {
    throw new Error("OpenAI embeddings response missing embedding.");
  }
  return embedding;
}

export async function generateAnswer(
  prompt: string,
  sources: ChunkRecord[],
  env: Env,
  conversation?: string
) {
  const systemPrompt = [
    "You are a friendly, pragmatic EUI/ECL expert for frontend developers.",
    "Write in a warm, conversational tone with short paragraphs.",
    "Use headings or bullets when it helps, and include code snippets when useful.",
    "Answer using only the sources provided.",
    "Always include a Sources section with links.",
    "If you cannot find the answer, say so and ask a clarifying question.",
    "Do not invent APIs or components."
  ].join("\n");

  const sourceBlock = sources
    .map((source, index) => {
      const header = `[${index + 1}] ${source.title || "Untitled"} — ${source.url}`;
      return `${header}\n${source.text}`;
    })
    .join("\n\n");

  const userPrompt = [
    conversation ? "Conversation so far:" : null,
    conversation ? conversation : null,
    conversation ? "" : null,
    `Question: ${prompt}`,
    "",
    "Sources:",
    sourceBlock
  ]
    .filter(Boolean)
    .join("\n");

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: env.OPENAI_MODEL ?? DEFAULT_MODEL,
      temperature: 0.2,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ]
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI request failed: ${response.status} ${errorText}`);
  }

  const payload = (await response.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  return payload.choices?.[0]?.message?.content ?? "";
}

export function formatConversation(messages: ChatMessage[], prompt: string, maxMessages = 8) {
  const filtered = messages
    .filter((msg) => msg && (msg.role === "user" || msg.role === "assistant") && msg.content)
    .map((msg) => ({
      role: msg.role,
      content: String(msg.content).trim()
    }))
    .filter((msg) => msg.content.length > 0);

  if (filtered.length) {
    const last = filtered[filtered.length - 1];
    if (last.role === "user" && last.content === prompt.trim()) {
      filtered.pop();
    }
  }

  const recent = filtered.slice(-maxMessages);
  if (!recent.length) return "";

  return recent
    .map((msg) => {
      const label = msg.role === "user" ? "User" : "Assistant";
      const content = msg.content.length > 800 ? `${msg.content.slice(0, 800)}...` : msg.content;
      return `${label}: ${content}`;
    })
    .join("\n");
}
export function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}
