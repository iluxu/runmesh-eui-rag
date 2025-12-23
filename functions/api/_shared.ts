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

export type ProjectContext = {
  name?: string;
  text?: string;
};

export type ImageInput = {
  name?: string;
  type?: string;
  dataUrl?: string;
};

export type Env = {
  OPENAI_API_KEY: string;
  OPENAI_MODEL?: string;
  OPENAI_EMBEDDING_MODEL?: string;
  EUI_RAG_BUCKET: R2Bucket;
};

const DEFAULT_MODEL = "gpt-5.2";
const DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small";
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 12;
const MAX_IMAGE_COUNT = 3;
const MAX_IMAGE_DATA_URL_LENGTH = 8_000_000;
const allowedImagePrefixes = ["data:image/png;base64,", "data:image/jpeg;base64,", "data:image/webp;base64,"];
const SYSTEM_PROMPT = [
  "You are a friendly, pragmatic EUI/ECL expert for frontend developers.",
  "Write in a warm, conversational tone with short paragraphs.",
  "Use headings or bullets when it helps, and include code snippets when useful.",
  "Answer using the sources provided for doc claims.",
  "You may refer to the conversation history without citing sources.",
  "Always include a Sources section with links for doc-based statements.",
  "If you cannot find the answer, say so and ask a clarifying question.",
  "Do not invent APIs or components."
].join("\n");
const CHUNKS_KEY = "chunks.json";

let cachedChunks: ChunkWithNorm[] | null = null;
let cachedMeta: { generatedAt?: string; model?: string; baseUrl?: string } | null = null;
let loadingPromise: Promise<ChunkWithNorm[]> | null = null;
const rateLimits = new Map<string, { count: number; resetAt: number }>();

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

  try {
    return await loadingPromise;
  } finally {
    loadingPromise = null;
  }
}

export function getMeta() {
  return cachedMeta;
}

export function getChunkCacheState() {
  return {
    ready: Boolean(cachedChunks),
    loading: Boolean(loadingPromise),
    chunks: cachedChunks?.length ?? 0
  };
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

export function checkRateLimit(sessionId: string, now = Date.now()) {
  const key = sessionId || "anonymous";
  const existing = rateLimits.get(key);
  if (!existing || now > existing.resetAt) {
    const entry = { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS };
    rateLimits.set(key, entry);
    return {
      ok: true,
      remaining: RATE_LIMIT_MAX - 1,
      resetAt: entry.resetAt
    };
  }

  existing.count += 1;
  rateLimits.set(key, existing);
  if (existing.count > RATE_LIMIT_MAX) {
    return {
      ok: false,
      remaining: 0,
      resetAt: existing.resetAt
    };
  }

  return {
    ok: true,
    remaining: Math.max(0, RATE_LIMIT_MAX - existing.count),
    resetAt: existing.resetAt
  };
}

export function buildSystemPrompt() {
  return SYSTEM_PROMPT;
}

export function sanitizeImages(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const images: string[] = [];
  for (const item of raw) {
    let dataUrl = "";
    if (typeof item === "string") {
      dataUrl = item;
    } else if (item && typeof item === "object" && typeof (item as ImageInput).dataUrl === "string") {
      dataUrl = (item as ImageInput).dataUrl || "";
    }
    if (!dataUrl) continue;
    if (!allowedImagePrefixes.some((prefix) => dataUrl.startsWith(prefix))) continue;
    if (dataUrl.length > MAX_IMAGE_DATA_URL_LENGTH) continue;
    images.push(dataUrl);
    if (images.length >= MAX_IMAGE_COUNT) break;
  }
  return images;
}

export function formatProjectContext(project?: ProjectContext) {
  const text = project?.text ? String(project.text).trim() : "";
  if (!text) return "";

  const notes = [];
  if (project?.name) notes.push(`File: ${project.name}`);

  const header = ["Project context (user-provided).", ...notes].join("\n");
  return [header, "-----", text, "-----"].join("\n");
}

export function buildUserPrompt(prompt: string, sources: ChunkRecord[], project?: ProjectContext) {
  const sourceBlock = sources
    .map((source, index) => {
      const header = `[${index + 1}] ${source.title || "Untitled"} — ${source.url}`;
      return `${header}\n${source.text}`;
    })
    .join("\n\n");

  const projectBlock = formatProjectContext(project);
  const parts = [`Question: ${prompt}`];
  if (projectBlock) {
    parts.push("", projectBlock);
  }
  parts.push("", "Sources:", sourceBlock);
  return parts.join("\n");
}

export function buildUserContent(
  prompt: string,
  sources: ChunkRecord[],
  project?: ProjectContext,
  images?: string[]
) {
  const text = buildUserPrompt(prompt, sources, project);
  if (!images || !images.length) return text;
  return [
    { type: "text", text },
    ...images.map((url) => ({
      type: "image_url",
      image_url: { url }
    }))
  ];
}

export async function generateAnswer(
  prompt: string,
  sources: ChunkRecord[],
  env: Env,
  conversation?: ChatMessage[],
  project?: ProjectContext,
  images?: string[]
) {
  const systemPrompt = buildSystemPrompt();
  const userContent = buildUserContent(prompt, sources, project, images);

  const chatMessages = [
    { role: "system", content: systemPrompt },
    ...(conversation ?? []),
    { role: "user", content: userContent }
  ];

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: env.OPENAI_MODEL ?? DEFAULT_MODEL,
      temperature: 0.2,
      messages: chatMessages
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

export function sanitizeConversation(messages: ChatMessage[], prompt: string, maxMessages = 20) {
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
  return recent.map((msg) => ({
    role: msg.role,
    content: msg.content.length > 12000 ? `${msg.content.slice(0, 12000)}...` : msg.content
  }));
}
export function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}
