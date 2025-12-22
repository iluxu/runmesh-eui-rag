import {
  checkRateLimit,
  embedQuery,
  generateAnswer,
  jsonResponse,
  loadChunks,
  rankChunks,
  sanitizeConversation
} from "./_shared";
import type { ChatMessage, ChunkRecord, Env, ProjectContext } from "./_shared";

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  try {
    const body = await request.json().catch(() => ({}));
    const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
    const limit = Number(body.limit ?? 6);
    const sessionId = typeof body.sessionId === "string" ? body.sessionId : "anonymous";
    const rawProject = body.project && typeof body.project === "object" ? (body.project as ProjectContext) : undefined;
    const projectText = typeof rawProject?.text === "string" ? rawProject.text : "";
    const project: ProjectContext | undefined = projectText
      ? {
          name: typeof rawProject?.name === "string" ? rawProject.name : undefined,
          text: projectText,
          truncated: rawProject?.truncated === true
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

    const rawMessages = Array.isArray(body.messages) ? body.messages : [];
    const messages = rawMessages.filter(Boolean) as ChatMessage[];
    const conversation = sanitizeConversation(messages, prompt);
    const answer = await generateAnswer(prompt, sources, env, conversation, project);
    return jsonResponse({ response: answer, sources });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return jsonResponse({ error: message }, 500);
  }
};
