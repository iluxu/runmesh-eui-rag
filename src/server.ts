import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import { createAgent, Policy } from "@runmesh/agent";
import { createOpenAI, generateStructuredOutput } from "@runmesh/core";
import { InMemoryAdapter, InMemoryRetriever, OpenAIEmbeddings } from "@runmesh/memory";
import { tool, ToolRegistry } from "@runmesh/tools";
import { z } from "zod";
import { crawlSite } from "./crawler.js";
import { buildChunks } from "./embed.js";
import { ChunkRecord } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "../public");

const DEFAULT_MODEL = "gpt-5.2";
const ENV = process.env;
const BASE_URL = ENV.RAG_BASE_URL ?? ENV.EUI_BASE_URL ?? "https://euidev.ecdevops.eu/";
const DOC_VERSION = ENV.RAG_DOC_VERSION ?? ENV.EUI_DOC_VERSION ?? "EUI 21";
const DOCS_NAME = ENV.RAG_DOCS_NAME ?? ENV.EUI_DOCS_NAME ?? "EUI";
const DEFAULT_PROMPT = ENV.RAG_DEFAULT_PROMPT ?? ENV.EUI_DEFAULT_PROMPT ?? "Summarize the docs.";
const DEFAULT_STRUCTURED_PROMPT =
  ENV.RAG_STRUCTURED_PROMPT ?? ENV.EUI_STRUCTURED_PROMPT ?? "Summarize the current docs.";
const SYSTEM_PROMPT =
  ENV.RAG_SYSTEM_PROMPT ??
  ENV.EUI_SYSTEM_PROMPT ??
  [
    `You are a friendly, pragmatic expert for the ${DOCS_NAME} docs.`,
    "Write in a warm, conversational tone with short paragraphs.",
    "Use headings or bullets when it helps, and include code snippets when useful.",
    "Always call search_docs before answering.",
    "Use the sources provided to answer, and cite them in a Sources list.",
    "If you cannot find the answer, say so and ask a clarifying question.",
    "Do not invent APIs or features."
  ].join("\n");
const MAX_PAGES = Number(ENV.RAG_MAX_PAGES ?? ENV.EUI_MAX_PAGES ?? 1200);
const CONCURRENCY = Number(ENV.RAG_CONCURRENCY ?? ENV.EUI_CONCURRENCY ?? 4);
const DELAY_MS = Number(ENV.RAG_DELAY_MS ?? ENV.EUI_DELAY_MS ?? 150);
const IGNORE_ROBOTS = ENV.RAG_IGNORE_ROBOTS === "1" || ENV.EUI_IGNORE_ROBOTS === "1";
const LIVE_MODE = ENV.RAG_LIVE !== "0" && ENV.EUI_LIVE !== "0";
const USE_LOCAL = ENV.RAG_USE_LOCAL === "1" || ENV.EUI_USE_LOCAL === "1";
const SAVE_ON_REFRESH = ENV.RAG_SAVE === "1" || ENV.EUI_SAVE === "1";
const CRAWL_MODE = (ENV.RAG_CRAWL_MODE ?? ENV.EUI_CRAWL_MODE ?? "browser") as "fetch" | "browser";
const BROWSER_TIMEOUT_MS = Number(ENV.RAG_BROWSER_TIMEOUT_MS ?? ENV.EUI_BROWSER_TIMEOUT_MS ?? 20000);
const BROWSER_WAIT_MS = Number(ENV.RAG_BROWSER_WAIT_MS ?? ENV.EUI_BROWSER_WAIT_MS ?? 400);
const USER_AGENT = ENV.RAG_USER_AGENT ?? ENV.EUI_USER_AGENT;
const URL_INCLUDE = (ENV.RAG_URL_INCLUDE ?? ENV.EUI_URL_INCLUDE ?? "")
  .split(",")
  .map((entry) => entry.trim())
  .filter(Boolean);
const URL_EXCLUDE = (ENV.RAG_URL_EXCLUDE ?? ENV.EUI_URL_EXCLUDE ?? "")
  .split(",")
  .map((entry) => entry.trim())
  .filter(Boolean);
const SEED_URLS = (ENV.RAG_SEED_URLS ?? ENV.EUI_SEED_URLS ?? "")
  .split(",")
  .map((entry) => entry.trim())
  .filter(Boolean);
const DATA_DIR = path.resolve(ENV.RAG_DATA_DIR ?? ENV.EUI_DATA_DIR ?? path.join(__dirname, "../data"));
const CHUNKS_PATH = path.join(DATA_DIR, "chunks.json");
type ProjectContext = {
  name?: string;
  text?: string;
};

const memory = new InMemoryAdapter();

let chunkIndex = new Map<string, ChunkRecord>();
let retriever: InMemoryRetriever | null = null;
let lastRefresh: string | null = null;
let indexSource: "live" | "local" | "none" = "none";
let indexError: string | null = null;
let indexState: "idle" | "crawling" | "embedding" | "ready" | "error" = "idle";
let pagesCrawled = 0;
let lastCrawledUrl: string | null = null;

function jsonResponse(res: http.ServerResponse, status: number, payload: unknown) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body)
  });
  res.end(body);
}

async function parseBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf-8"));
  } catch {
    return {};
  }
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return "Unknown error";
}

function formatProjectContext(project?: ProjectContext) {
  const text = project?.text ? String(project.text).trim() : "";
  if (!text) return "";

  const notes = [];
  if (project?.name) notes.push(`File: ${project.name}`);

  const header = ["Project context (user-provided).", ...notes].join("\n");
  return [header, "-----", text, "-----"].join("\n");
}

function buildPromptWithProject(prompt: string, project?: ProjectContext) {
  const projectBlock = formatProjectContext(project);
  if (!projectBlock) return prompt;
  return [projectBlock, `Question: ${prompt}`].join("\n\n");
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function initRetriever(chunks: ChunkRecord[]) {
  if (!ENV.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is required to run the RAG server.");
  }
  chunkIndex = new Map(chunks.map((chunk) => [chunk.id, chunk]));
  const client = createOpenAI({
    apiKey: ENV.OPENAI_API_KEY,
    defaultModel: ENV.OPENAI_MODEL ?? DEFAULT_MODEL
  });
  const embeddings = new OpenAIEmbeddings(client);
  retriever = new InMemoryRetriever(embeddings);
  for (const chunk of chunks) {
    await retriever.add({ id: chunk.id, text: chunk.text, embedding: chunk.embedding });
  }
  lastRefresh = new Date().toISOString();
  indexError = null;
  indexState = "ready";
}

async function loadFromFile() {
  const raw = await fs.readFile(CHUNKS_PATH, "utf-8");
  const parsed = JSON.parse(raw) as { chunks?: ChunkRecord[] };
  const chunks = parsed.chunks ?? [];
  await initRetriever(chunks);
  indexSource = "local";
}

async function refreshIndex() {
  indexState = "crawling";
  pagesCrawled = 0;
  lastCrawledUrl = null;
  const pages = await crawlSite({
    baseUrl: BASE_URL,
    seedUrls: SEED_URLS.length ? SEED_URLS : undefined,
    maxPages: MAX_PAGES,
    concurrency: CONCURRENCY,
    delayMs: DELAY_MS,
    ignoreRobots: IGNORE_ROBOTS,
    mode: CRAWL_MODE,
    browserTimeoutMs: BROWSER_TIMEOUT_MS,
    browserWaitMs: BROWSER_WAIT_MS,
    userAgent: USER_AGENT,
    includePatterns: URL_INCLUDE.length ? URL_INCLUDE : undefined,
    excludePatterns: URL_EXCLUDE.length ? URL_EXCLUDE : undefined,
    onProgress: (count, url) => {
      pagesCrawled = count;
      lastCrawledUrl = url;
      if (count % 50 === 0) {
        console.log(`Crawled ${count} pages (latest: ${url})`);
      }
    }
  });
  indexState = "embedding";
  const pagesWithVersion = pages.map((page) => ({ ...page, version: DOC_VERSION }));
  const chunks = await buildChunks(pagesWithVersion, ENV.OPENAI_MODEL ?? DEFAULT_MODEL, ENV.OPENAI_API_KEY);
  await initRetriever(chunks);
  indexSource = "live";

  if (SAVE_ON_REFRESH) {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(
      CHUNKS_PATH,
      JSON.stringify(
        {
          baseUrl: BASE_URL,
          generatedAt: lastRefresh,
          model: ENV.OPENAI_MODEL ?? DEFAULT_MODEL,
          version: DOC_VERSION,
          chunks
        },
        null,
        2
      )
    );
  }
}

async function loadIndex() {
  const hasLocal = await fileExists(CHUNKS_PATH);
  if (USE_LOCAL && hasLocal) {
    await loadFromFile();
    return;
  }
  if (LIVE_MODE) {
    await refreshIndex();
    return;
  }
  if (hasLocal) {
    await loadFromFile();
    return;
  }
  throw new Error("No local chunks and live mode disabled. Run ingest or enable live mode.");
}

function createTools() {
  const tools = new ToolRegistry();
  tools.register(
    tool({
      name: "search_docs",
      description: `Search ${DOCS_NAME} docs for relevant passages.`,
      schema: z.object({
        query: z.string(),
        limit: z.number().min(1).max(8).default(5)
      }),
      handler: async ({ query, limit }) => {
        if (!retriever) throw new Error("Retriever not loaded");
        const results = await retriever.search(query, limit);
        return results.map((item) => {
          const chunk = chunkIndex.get(item.id);
          const anchor = chunk?.anchor ?? "";
          return {
            id: item.id,
            url: `${chunk?.url ?? ""}${anchor}`,
            title: chunk?.title ?? "",
            section: chunk?.section ?? "",
            sectionPath: chunk?.sectionPath ?? "",
            anchor: chunk?.anchor ?? "",
            breadcrumbs: chunk?.breadcrumbs ?? [],
            kind: chunk?.kind ?? "concept",
            version: chunk?.version ?? "",
            text: chunk?.text ?? item.text
          };
        });
      }
    })
  );
  return tools;
}

const ragPolicy: Policy = ({ messages }) => {
  const lastUser = [...messages].reverse().find((msg) => msg.role === "user");
  const content = typeof lastUser?.content === "string" ? lastUser.content : "";
  if (!content) return { allow: true };
  return { allow: true };
};

function createAgentForSession(sessionId: string) {
  const tools = createTools();
  return createAgent({
    name: `docs-rag-${sessionId}`,
    model: ENV.OPENAI_MODEL ?? DEFAULT_MODEL,
    systemPrompt: SYSTEM_PROMPT,
    tools,
    memory,
    policies: [ragPolicy]
  });
}

async function handleStatus(_: http.IncomingMessage, res: http.ServerResponse) {
  jsonResponse(res, 200, {
    ready: Boolean(retriever),
    chunks: chunkIndex.size,
    source: indexSource,
    lastRefresh,
    error: indexError,
    state: indexState,
    pagesCrawled,
    lastCrawledUrl
  });
}

async function handleRefresh(_: http.IncomingMessage, res: http.ServerResponse) {
  try {
    await refreshIndex();
    jsonResponse(res, 200, {
      ok: true,
      chunks: chunkIndex.size,
      lastRefresh,
      source: indexSource,
      error: indexError,
      state: indexState
    });
  } catch (error) {
    indexError = formatError(error);
    indexState = "error";
    jsonResponse(res, 500, { error: indexError });
  }
}

async function handleAsk(req: http.IncomingMessage, res: http.ServerResponse) {
  const body = await parseBody(req);
  const promptRaw = typeof body.prompt === "string" ? body.prompt.trim() : "";
  const prompt = promptRaw || DEFAULT_PROMPT;
  const sessionId = typeof body.sessionId === "string" ? body.sessionId : crypto.randomUUID();
  const rawProject = body.project && typeof body.project === "object" ? (body.project as ProjectContext) : undefined;
  const projectText = typeof rawProject?.text === "string" ? rawProject.text : "";
  const project: ProjectContext | undefined = projectText
    ? {
        name: typeof rawProject?.name === "string" ? rawProject.name : undefined,
        text: projectText
      }
    : undefined;
  const fullPrompt = buildPromptWithProject(prompt, project);

  if (!retriever) {
    jsonResponse(res, 500, { error: "Retriever not loaded. Index is empty." });
    return;
  }

  try {
    const agent = createAgentForSession(sessionId);
    const result = await agent.run(fullPrompt);
    const text = result.response.choices[0]?.message?.content ?? "";
    jsonResponse(res, 200, { sessionId, response: text, steps: result.steps });
  } catch (error) {
    jsonResponse(res, 500, { error: formatError(error) });
  }
}

async function handleAskStructured(req: http.IncomingMessage, res: http.ServerResponse) {
  const body = await parseBody(req);
  const prompt = typeof body.prompt === "string" ? body.prompt : DEFAULT_STRUCTURED_PROMPT;
  const sessionId = typeof body.sessionId === "string" ? body.sessionId : crypto.randomUUID();

  if (!retriever) {
    jsonResponse(res, 500, { error: "Retriever not loaded. Index is empty." });
    return;
  }

  try {
    const sources = await retriever.search(prompt, 5);
    const sourcePayload = sources.map((item) => {
      const chunk = chunkIndex.get(item.id);
      const anchor = chunk?.anchor ?? "";
      return {
        id: item.id,
        url: `${chunk?.url ?? ""}${anchor}`,
        title: chunk?.title ?? "",
        section: chunk?.section ?? "",
        sectionPath: chunk?.sectionPath ?? "",
        anchor: chunk?.anchor ?? "",
        breadcrumbs: chunk?.breadcrumbs ?? [],
        kind: chunk?.kind ?? "concept",
        version: chunk?.version ?? "",
        text: chunk?.text ?? item.text
      };
    });

    const OutputSchema = z.object({
      answer: z.string(),
      sources: z.array(
        z.object({
          id: z.string(),
          url: z.string(),
          title: z.string(),
          section: z.string()
        })
      )
    });

    const client = createOpenAI({
      apiKey: ENV.OPENAI_API_KEY,
      defaultModel: ENV.OPENAI_MODEL ?? DEFAULT_MODEL
    });

    const promptText = [
      `You are an expert ${DOCS_NAME} documentation assistant.`,
      "Answer using only the provided sources.",
      "If the answer is not in the sources, say you don't know.",
      "Return JSON only that matches the schema.",
      "",
      `question: ${prompt}`,
      `sources: ${JSON.stringify(sourcePayload)}`
    ].join("\n");

    const result = await generateStructuredOutput({
      client,
      request: { messages: [{ role: "user", content: promptText }] },
      schema: OutputSchema,
      maxRetries: 2
    });

    jsonResponse(res, 200, { sessionId, ...result.value });
  } catch (error) {
    jsonResponse(res, 500, { error: formatError(error) });
  }
}

async function serveStatic(req: http.IncomingMessage, res: http.ServerResponse) {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
  const filePath = path.join(PUBLIC_DIR, pathname);

  try {
    const content = await fs.readFile(filePath);
    const ext = path.extname(filePath);
    const contentType =
      ext === ".html"
        ? "text/html"
        : ext === ".css"
        ? "text/css"
        : ext === ".js"
        ? "text/javascript"
        : "application/octet-stream";
    res.writeHead(200, { "Content-Type": contentType });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
}

const server = http.createServer(async (req, res) => {
  if (!req.url) {
    res.writeHead(400);
    res.end("Bad request");
    return;
  }

  if (req.method === "GET" && req.url.startsWith("/api/status")) {
    await handleStatus(req, res);
    return;
  }

  if (req.method === "POST" && req.url.startsWith("/api/refresh")) {
    await handleRefresh(req, res);
    return;
  }

  if (req.method === "POST" && req.url.startsWith("/api/ask/structured")) {
    await handleAskStructured(req, res);
    return;
  }

  if (req.method === "POST" && req.url.startsWith("/api/ask")) {
    await handleAsk(req, res);
    return;
  }

  await serveStatic(req, res);
});

const port = Number(process.env.PORT ?? 8811);
server.listen(port, async () => {
  try {
    await loadIndex();
    console.log(`Index ready (${chunkIndex.size} chunks, source: ${indexSource}).`);
  } catch (error) {
    indexError = formatError(error);
    indexState = "error";
    console.warn(indexError);
  }
  console.log(`RunMesh EUI RAG running at http://localhost:${port}`);
});
