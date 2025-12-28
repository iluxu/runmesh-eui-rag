import {
  checkRateLimit,
  detectIntent,
  embedQuery,
  expandQuery,
  generateAnswer,
  hasInlineCitations,
  jsonResponse,
  loadChunks,
  rankChunks,
  sanitizeConversation,
  sanitizeImages,
  selectDiverse
} from "./_shared";
import type { ChatMessage, ChunkRecord, Env, ImageInput, ProjectContext } from "./_shared";

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  try {
    const body = await request.json().catch(() => ({}));
    const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
    const limit = Number(body.limit ?? 6);
    const sessionId = typeof body.sessionId === "string" ? body.sessionId : "anonymous";
    const rawProject = body.project && typeof body.project === "object" ? (body.project as ProjectContext) : undefined;
    const projectText = typeof rawProject?.text === "string" ? rawProject.text : "";
    const rawImages = Array.isArray(body.images) ? (body.images as ImageInput[]) : [];
    const images = sanitizeImages(rawImages);
    const project: ProjectContext | undefined = projectText
      ? {
          name: typeof rawProject?.name === "string" ? rawProject.name : undefined,
          text: projectText
        }
      : undefined;

    const rate = checkRateLimit(sessionId);
    if (!rate.ok) {
      const retryAfterMs = Math.max(0, rate.resetAt - Date.now());
      return jsonResponse(
        {
          error: `Rate limit reached. Try again in ${Math.ceil(retryAfterMs / 1000)}s.`,
          retryAfterMs
        },
        429
      );
    }

    if (!prompt) {
      return jsonResponse({ error: "Missing prompt." }, 400);
    }

    const chunks = await loadChunks(env);
    const intent = detectIntent(prompt);
    const finalLimit = intent === "debug" ? 8 : Math.min(Math.max(limit, 1), 10);
    const preferredKinds =
      intent === "debug"
        ? ["example", "faq"]
        : intent === "api"
        ? ["api"]
        : intent === "howto"
        ? ["example"]
        : undefined;

    const preferredVersion = env.EUI_PREFERRED_VERSION ?? env.EUI_DOC_VERSION;
    const embedding = await embedQuery(prompt, env);
    const expanded = expandQuery(prompt);
    const expandedEmbedding = expanded !== prompt ? await embedQuery(expanded, env) : null;

    const baseTop = rankChunks(chunks, prompt, embedding, {
      limit: finalLimit * 3,
      preferredVersion,
      preferredKinds
    });
    const expandedTop = expandedEmbedding
      ? rankChunks(chunks, expanded, expandedEmbedding, {
          limit: finalLimit * 3,
          preferredVersion,
          preferredKinds
        })
      : [];

    const merged = new Map<string, { chunk: (typeof baseTop)[number]["chunk"]; score: number }>();
    [...baseTop, ...expandedTop].forEach((item) => {
      const existing = merged.get(item.chunk.id);
      if (!existing || item.score > existing.score) {
        merged.set(item.chunk.id, item);
      }
    });

    const mergedList = Array.from(merged.values()).sort((a, b) => b.score - a.score);
    const top = selectDiverse(mergedList, {
      limit: finalLimit,
      preferredVersion,
      preferredKinds
    });

    const sources: ChunkRecord[] = top.map(({ chunk }) => ({
      id: chunk.id,
      url: chunk.url,
      title: chunk.title,
      section: chunk.section,
      sectionPath: chunk.sectionPath,
      anchor: chunk.anchor,
      breadcrumbs: chunk.breadcrumbs,
      kind: chunk.kind,
      version: chunk.version,
      generatedAt: chunk.generatedAt,
      lang: chunk.lang,
      tokens: chunk.tokens,
      text: chunk.text.length > 1800 ? `${chunk.text.slice(0, 1800)}...` : chunk.text,
      embedding: []
    }));

    const rawMessages = Array.isArray(body.messages) ? body.messages : [];
    const messages = rawMessages.filter(Boolean) as ChatMessage[];
    const conversation = sanitizeConversation(messages, prompt);
    let answer = await generateAnswer(prompt, sources, env, conversation, project, images);
    if (sources.length && !hasInlineCitations(answer)) {
      answer = await generateAnswer(prompt, sources, env, conversation, project, images, { strict: true });
    }
    return jsonResponse({ response: answer, sources });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return jsonResponse({ error: message }, 500);
  }
};
