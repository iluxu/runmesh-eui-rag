import {
  buildSystemPrompt,
  buildUserContent,
  checkRateLimit,
  detectIntent,
  embedQuery,
  expandQuery,
  jsonResponse,
  loadChunks,
  rankChunks,
  sanitizeConversation,
  sanitizeImages,
  selectDiverse
} from "../_shared";
import type { ChatMessage, ChunkRecord, Env, ImageInput, ProjectContext } from "../_shared";

function sseHeaders() {
  return {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive"
  };
}

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

    if (!prompt) {
      return jsonResponse({ error: "Missing prompt." }, 400);
    }

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
    const systemPrompt = buildSystemPrompt();
    const userContent = buildUserContent(prompt, sources, project, images);

    const openaiResponse = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: env.OPENAI_MODEL ?? "gpt-5.2",
        temperature: 0.2,
        stream: true,
        messages: [{ role: "system", content: systemPrompt }, ...conversation, { role: "user", content: userContent }]
      })
    });

    if (!openaiResponse.ok || !openaiResponse.body) {
      const errorText = await openaiResponse.text();
      return jsonResponse({ error: `OpenAI request failed: ${openaiResponse.status} ${errorText}` }, 502);
    }

    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const bodyStream = openaiResponse.body.getReader();

    const stream = new ReadableStream({
      async start(controller) {
        let buffer = "";

        const send = (event: string, data: unknown) => {
          const payload = typeof data === "string" ? data : JSON.stringify(data);
          controller.enqueue(encoder.encode(`event: ${event}\n`));
          controller.enqueue(encoder.encode(`data: ${payload}\n\n`));
        };

        send("meta", { ok: true });

        while (true) {
          const { value, done } = await bodyStream.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const parts = buffer.split("\n\n");
          buffer = parts.pop() ?? "";

          for (const part of parts) {
            const lines = part.split("\n");
            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed.startsWith("data:")) continue;
              const data = trimmed.slice(5).trim();
              if (data === "[DONE]") {
                send("done", {});
                controller.close();
                return;
              }
              try {
                const parsed = JSON.parse(data);
                const delta = parsed.choices?.[0]?.delta?.content ?? "";
                if (delta) {
                  send("token", { token: delta });
                }
              } catch {
                continue;
              }
            }
          }
        }

        send("done", {});
        controller.close();
      }
    });

    return new Response(stream, { headers: sseHeaders() });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return jsonResponse({ error: message }, 500);
  }
};
