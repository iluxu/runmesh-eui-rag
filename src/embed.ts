import { createOpenAI } from "@runmesh/core";
import { OpenAIEmbeddings } from "@runmesh/memory";
import { chunkText } from "./utils.js";
import { ChunkRecord, PageRecord, PageSection, TableRecord } from "./types.js";

const MIN_TOKENS = 300;
const MAX_TOKENS = 900;
const CHARS_PER_TOKEN = 4;

function estimateTokens(text: string) {
  return Math.max(1, Math.ceil(text.length / CHARS_PER_TOKEN));
}

function formatTable(table: TableRecord) {
  if (!table.headers.length && !table.rows.length) return "";
  const headers = table.headers.length ? table.headers : table.rows[0]?.map((_, index) => `Column ${index + 1}`) ?? [];
  const headerRow = `| ${headers.join(" | ")} |`;
  const separator = `| ${headers.map(() => "---").join(" | ")} |`;
  const rows = table.rows.map((row) => `| ${row.join(" | ")} |`).join("\n");
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
        const embedText = `${contextHeader}\n\n${piece}`.trim();
        const embedding = await embeddings.embed(embedText);
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
