import {
  buildSystemPrompt,
  buildUserPrompt,
  checkRateLimit,
  embedQuery,
  jsonResponse,
  loadChunks,
  rankChunks,
  sanitizeConversation
} from "../_shared";
import type { ChatMessage, ChunkRecord, Env, ProjectContext } from "../_shared";

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
    const project: ProjectContext | undefined = projectText
      ? {
          name: typeof rawProject?.name === "string" ? rawProject.name : undefined,
          text: projectText,
          truncated: rawProject?.truncated === true
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
    const systemPrompt = buildSystemPrompt();
    const userPrompt = buildUserPrompt(prompt, sources, project);

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
        messages: [{ role: "system", content: systemPrompt }, ...conversation, { role: "user", content: userPrompt }]
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
