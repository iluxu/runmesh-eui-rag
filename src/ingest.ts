import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { crawlSite } from "./crawler.js";
import { buildChunks } from "./embed.js";
import { formatDate } from "./utils.js";

const ENV = process.env;
const BASE_URL = ENV.RAG_BASE_URL ?? ENV.EUI_BASE_URL ?? "https://euidev.ecdevops.eu/";
const DOC_VERSION = ENV.RAG_DOC_VERSION ?? ENV.EUI_DOC_VERSION ?? "EUI 21";
const DOCS_NAME = ENV.RAG_DOCS_NAME ?? ENV.EUI_DOCS_NAME ?? "EUI";
const MAX_PAGES = Number(ENV.RAG_MAX_PAGES ?? ENV.EUI_MAX_PAGES ?? 1200);
const CONCURRENCY = Number(ENV.RAG_CONCURRENCY ?? ENV.EUI_CONCURRENCY ?? 4);
const DELAY_MS = Number(ENV.RAG_DELAY_MS ?? ENV.EUI_DELAY_MS ?? 150);
const IGNORE_ROBOTS = ENV.RAG_IGNORE_ROBOTS === "1" || ENV.EUI_IGNORE_ROBOTS === "1";
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
const DATA_DIR = path.resolve(ENV.RAG_DATA_DIR ?? ENV.EUI_DATA_DIR ?? "data");
const PAGES_PATH = path.join(DATA_DIR, "pages.json");
const CHUNKS_PATH = path.join(DATA_DIR, "chunks.json");
const EMBEDDING_MODEL =
  ENV.RAG_EMBEDDING_MODEL ??
  ENV.EUI_EMBEDDING_MODEL ??
  ENV.OPENAI_EMBEDDING_MODEL ??
  "text-embedding-3-small";

async function main() {
  console.log(`RunMesh ingest starting for ${DOCS_NAME}: ${BASE_URL}`);
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
      if (count % 25 === 0) {
        console.log(`Crawled ${count} pages (latest: ${url})`);
      }
    }
  });

  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(
    PAGES_PATH,
    JSON.stringify(
      {
        baseUrl: BASE_URL,
        generatedAt: new Date().toISOString(),
        pages
      },
      null,
      2
    )
  );

  console.log("Embedding chunks...");
  const pagesWithVersion = pages.map((page) => ({ ...page, version: DOC_VERSION }));
  const chunks = await buildChunks(pagesWithVersion, EMBEDDING_MODEL, ENV.OPENAI_API_KEY);
  await fs.writeFile(
    CHUNKS_PATH,
    JSON.stringify(
      {
        baseUrl: BASE_URL,
        version: DOC_VERSION,
        generatedAt: new Date().toISOString(),
        model: EMBEDDING_MODEL,
        chunks
      },
      null,
      2
    )
  );

  console.log(`Saved ${chunks.length} chunks to ${CHUNKS_PATH}`);
  console.log(`Done on ${formatDate()}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
