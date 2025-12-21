import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { crawlSite } from "./crawler.js";
import { buildChunks } from "./embed.js";
import { formatDate } from "./utils.js";

const BASE_URL = process.env.EUI_BASE_URL ?? "https://euidev.ecdevops.eu/";
const MAX_PAGES = Number(process.env.EUI_MAX_PAGES ?? 1200);
const CONCURRENCY = Number(process.env.EUI_CONCURRENCY ?? 4);
const DELAY_MS = Number(process.env.EUI_DELAY_MS ?? 150);
const IGNORE_ROBOTS = process.env.EUI_IGNORE_ROBOTS === "1";
const CRAWL_MODE = (process.env.EUI_CRAWL_MODE ?? "browser") as "fetch" | "browser";
const BROWSER_TIMEOUT_MS = Number(process.env.EUI_BROWSER_TIMEOUT_MS ?? 20000);
const BROWSER_WAIT_MS = Number(process.env.EUI_BROWSER_WAIT_MS ?? 400);
const URL_INCLUDE = (process.env.EUI_URL_INCLUDE ?? "")
  .split(",")
  .map((entry) => entry.trim())
  .filter(Boolean);
const URL_EXCLUDE = (process.env.EUI_URL_EXCLUDE ?? "")
  .split(",")
  .map((entry) => entry.trim())
  .filter(Boolean);
const DATA_DIR = path.resolve("data");
const PAGES_PATH = path.join(DATA_DIR, "pages.json");
const CHUNKS_PATH = path.join(DATA_DIR, "chunks.json");
const MODEL = process.env.OPENAI_MODEL ?? "gpt-5.2";

async function main() {
  console.log(`RunMesh EUI ingest starting for ${BASE_URL}`);
  const pages = await crawlSite({
    baseUrl: BASE_URL,
    maxPages: MAX_PAGES,
    concurrency: CONCURRENCY,
    delayMs: DELAY_MS,
    ignoreRobots: IGNORE_ROBOTS,
    mode: CRAWL_MODE,
    browserTimeoutMs: BROWSER_TIMEOUT_MS,
    browserWaitMs: BROWSER_WAIT_MS,
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
  const chunks = await buildChunks(pages, MODEL, process.env.OPENAI_API_KEY);
  await fs.writeFile(
    CHUNKS_PATH,
    JSON.stringify(
      {
        baseUrl: BASE_URL,
        generatedAt: new Date().toISOString(),
        model: MODEL,
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
