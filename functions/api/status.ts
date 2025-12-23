import { getChunkCacheState, getMeta, jsonResponse, loadChunks } from "./_shared";
import type { Env } from "./_shared";

export const onRequestGet: PagesFunction<Env> = async ({ env, waitUntil }) => {
  try {
    const cache = getChunkCacheState();
    if (!cache.ready) {
      if (!cache.loading && typeof waitUntil === "function") {
        waitUntil(
          loadChunks(env).catch((error) => {
            console.warn("Status preload failed", error);
          })
        );
      }
      const meta = getMeta();
      return jsonResponse({
        ready: false,
        chunks: cache.chunks,
        source: "r2",
        lastRefresh: meta?.generatedAt ?? null,
        error: null,
        state: cache.loading ? "loading" : "idle",
        pagesCrawled: null,
        lastCrawledUrl: null
      });
    }
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
