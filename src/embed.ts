import { chunkText } from "./utils.js";
import { ChunkRecord, PageRecord, PageSection, TableRecord } from "./types.js";

const MIN_TOKENS = 300;
const MAX_TOKENS = 900;
const CHARS_PER_TOKEN = 4;
const DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small";

function estimateTokens(text: string) {
  return Math.max(1, Math.ceil(text.length / CHARS_PER_TOKEN));
}

function formatTable(table: TableRecord) {
  if (!table.headers.length && !table.rows.length) return "";
  const firstRow = Array.isArray(table.rows[0]) ? table.rows[0] : [];
  const headers = table.headers.length ? table.headers : firstRow.map((_, index) => `Column ${index + 1}`);
  const headerRow = `| ${headers.join(" | ")} |`;
  const separator = `| ${headers.map(() => "---").join(" | ")} |`;
  const rows = table.rows
    .map((row) => (Array.isArray(row) ? row : [String(row)]))
    .map((row) => `| ${row.join(" | ")} |`)
    .join("\n");
  return [headerRow, separator, rows].filter(Boolean).join("\n");
}

function serializeSection(section: PageSection) {
  const parts: string[] = [];
  if (section.text) parts.push(section.text);
  if (section.codeBlocks.length) {
    section.codeBlocks.forEach((block) => {
      const lang = block.lang ? block.lang.trim() : "";
      parts.push(["```" + lang, block.code, "```"].join("\n"));
    });
  }
  if (section.tables.length) {
    section.tables.forEach((table) => {
      const rendered = formatTable(table);
      if (rendered) {
        parts.push(rendered);
      }
    });
  }
  return parts.filter(Boolean).join("\n\n").trim();
}

function inferKind(section: PageSection): ChunkRecord["kind"] {
  const heading = section.heading.toLowerCase();
  if (heading.includes("changelog") || heading.includes("release")) return "changelog";
  if (heading.includes("faq") || heading.includes("troubleshooting") || heading.includes("error")) return "faq";
  if (heading.includes("api") || heading.includes("props") || heading.includes("inputs") || heading.includes("options")) {
    return "api";
  }
  if (heading.includes("example") || heading.includes("usage") || section.codeBlocks.length) return "example";
  return "concept";
}

function buildContextHeader(page: PageRecord, section: PageSection) {
  const crumbs = page.breadcrumbs.length ? page.breadcrumbs.join(" > ") : "";
  const path = section.path.join(" > ");
  const parts = [
    `Title: ${page.title}`,
    crumbs ? `Breadcrumbs: ${crumbs}` : "",
    path ? `Section: ${path}` : "",
    section.anchor ? `Anchor: ${section.anchor}` : "",
    page.version ? `Version: ${page.version}` : ""
  ].filter(Boolean);
  return parts.join("\n");
}

function chunkSectionText(text: string) {
  const maxChars = MAX_TOKENS * CHARS_PER_TOKEN;
  if (estimateTokens(text) <= MAX_TOKENS) return [text];
  return chunkText(text, maxChars, 0);
}

async function embedInput(text: string, apiKey: string, model: string): Promise<number[]> {
  const maxAttempts = 5;
  const endpoint = "https://api.openai.com/v1/embeddings";
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model,
          input: text
        })
      });

      if (response.ok) {
        const payload = (await response.json()) as {
          data?: { embedding: number[] }[];
        };
        const embedding = payload.data?.[0]?.embedding;
        if (!embedding) {
          throw new Error("OpenAI embeddings missing data.");
        }
        return embedding;
      }

      const retryable = [429, 500, 502, 503, 504].includes(response.status);
      if (!retryable || attempt === maxAttempts) {
        const errorText = await response.text();
        throw new Error(`OpenAI embeddings failed: ${response.status} ${errorText}`);
      }

      const retryAfter = Number(response.headers.get("retry-after") ?? "");
      const delayMs = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : Math.min(1000 * 2 ** (attempt - 1), 10_000);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    } catch (error) {
      if (attempt === maxAttempts) {
        throw error instanceof Error ? error : new Error(String(error));
      }
      const delayMs = Math.min(1000 * 2 ** (attempt - 1), 10_000);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw new Error("OpenAI embeddings failed after retries.");
}

export async function buildChunks(pages: PageRecord[], model?: string, apiKey?: string) {
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is required for embeddings.");
  }
  const embeddingModel = model && model.trim().length ? model : DEFAULT_EMBEDDING_MODEL;

  const chunks: ChunkRecord[] = [];
  const generatedAt = new Date().toISOString();

  for (const page of pages) {
    let index = 0;
    for (const section of page.sections) {
      const sectionPath = section.path.join(" > ") || section.heading;
      const content = serializeSection(section);
      if (!content) continue;
      const pieces = chunkSectionText(content);
      for (const piece of pieces) {
        const contextHeader = buildContextHeader(page, section);
        const inputText = `${contextHeader}\n\n${piece}`.trim();
        const embedding = await embedInput(inputText, apiKey, embeddingModel);
        const tokens = estimateTokens(piece);
        const kind = inferKind(section);
        const lang = section.codeBlocks.length === 1 ? section.codeBlocks[0]?.lang : undefined;
        const anchor = section.anchor || "";
        chunks.push({
          id: `${page.url}${anchor}#chunk-${index}`,
          url: page.url,
          title: page.title,
          section: section.heading,
          sectionPath,
          anchor,
          breadcrumbs: page.breadcrumbs,
          kind,
          version: page.version,
          generatedAt,
          lang,
          tokens,
          text: piece,
          embedding
        });
        index += 1;
      }
    }
  }

  return chunks;
}
