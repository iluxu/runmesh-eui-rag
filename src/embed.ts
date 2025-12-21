import { createOpenAI } from "@runmesh/core";
import { OpenAIEmbeddings } from "@runmesh/memory";
import { chunkText } from "./utils.js";
import { ChunkRecord, PageRecord } from "./types.js";

export async function buildChunks(pages: PageRecord[], model: string, apiKey?: string) {
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is required for embeddings.");
  }
  const client = createOpenAI({
    apiKey,
    defaultModel: model
  });
  const embeddings = new OpenAIEmbeddings(client);

  const chunks: ChunkRecord[] = [];

  for (const page of pages) {
    const sections = page.headings.length ? page.headings : [page.title];
    const pieces = chunkText(page.text || "", 1200, 200);
    let index = 0;
    for (const piece of pieces) {
      const text = `${page.title}\n${piece}`.trim();
      const embedding = await embeddings.embed(text);
      const section = sections[Math.min(index, sections.length - 1)] ?? page.title;
      chunks.push({
        id: `${page.url}#chunk-${index}`,
        url: page.url,
        title: page.title,
        section,
        text,
        embedding
      });
      index += 1;
    }
  }

  return chunks;
}
