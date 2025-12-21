import { getMeta, jsonResponse, loadChunks } from "./_shared";
import type { Env } from "./_shared";

export const onRequestGet: PagesFunction<Env> = async ({ env }) => {
  try {
    const chunks = await loadChunks(env);
    const meta = getMeta();
    return jsonResponse({
      ready: true,
      chunks: chunks.length,
      source: "r2",
      lastRefresh: meta?.generatedAt ?? null,
      error: null,
      state: "ready",
      pagesCrawled: null,
      lastCrawledUrl: null
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return jsonResponse({
      ready: false,
      chunks: 0,
      source: "none",
      lastRefresh: null,
      error: message,
      state: "error",
      pagesCrawled: null,
      lastCrawledUrl: null
    }, 500);
  }
};
