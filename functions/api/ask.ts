import { embedQuery, generateAnswer, jsonResponse, loadChunks, rankChunks } from "./_shared";
import type { ChunkRecord, Env } from "./_shared";

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  try {
    const body = await request.json().catch(() => ({}));
    const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
    const limit = Number(body.limit ?? 6);

    if (!prompt) {
      return jsonResponse({ error: "Missing prompt." }, 400);
    }

    const chunks = await loadChunks(env);
    const embedding = await embedQuery(prompt, env);
    const top = rankChunks(chunks, embedding, Math.min(Math.max(limit, 1), 8));

    const sources: ChunkRecord[] = top.map(({ chunk }) => ({
      id: chunk.id,
      url: chunk.url,
      title: chunk.title,
      section: chunk.section,
      text: chunk.text.length > 1800 ? `${chunk.text.slice(0, 1800)}...` : chunk.text,
      embedding: []
    }));

    const answer = await generateAnswer(prompt, sources, env);
    return jsonResponse({ response: answer, sources });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return jsonResponse({ error: message }, 500);
  }
};
