import { load } from "cheerio";
import { CodeBlockRecord, PageRecord, PageSection } from "./types.js";
import { normalizeWhitespace } from "./utils.js";

type DocumentationJson = Record<string, unknown>;
type DocumentationEntity = Record<string, unknown>;

type DocumentationJsonOptions = {
  jsonUrl: string;
  docsBaseUrl?: string;
  docVersion?: string;
  includeCode?: boolean;
};

const OVERVIEW_KEYS = new Set([
  "name",
  "id",
  "type",
  "file",
  "selector",
  "ngname",
  "className",
  "kind",
  "standalone",
  "deprecated",
  "deprecationMessage",
  "encapsulation",
  "rawdescription",
  "description"
]);

const CODE_BLOCK_KEYS = new Map<string, string>([
  ["sourceCode", "ts"],
  ["template", "html"],
  ["styles", "scss"]
]);

function stripHtml(input: string) {
  if (!input) return "";
  const $ = load(`<div>${input}</div>`);
  return normalizeWhitespace($.text());
}

function humanizeKey(key: string) {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function slugify(input: string) {
  return (
    input
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "")
      .trim()
      .replace(/\s+/g, "-") || "section"
  );
}

function isPrimitive(value: unknown): value is string | number | boolean {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function renderPrimitive(value: string | number | boolean) {
  if (typeof value === "string") return stripHtml(value);
  return String(value);
}

function renderStructuredValue(value: unknown, depth = 0): string {
  if (value == null) return "";
  if (isPrimitive(value)) return renderPrimitive(value);

  const indent = "  ".repeat(depth);
  const childIndent = "  ".repeat(depth + 1);

  if (Array.isArray(value)) {
    return value
      .map((item) => {
        const rendered = renderStructuredValue(item, depth + 1);
        if (!rendered) return "";
        if (isPrimitive(item)) return `${indent}- ${rendered}`;
        return `${indent}-\n${rendered}`;
      })
      .filter(Boolean)
      .join("\n");
  }

  if (typeof value === "object") {
    return Object.entries(value as DocumentationEntity)
      .map(([key, entry]) => {
        const rendered = renderStructuredValue(entry, depth + 1);
        if (!rendered) return "";
        if (isPrimitive(entry)) {
          return `${indent}${humanizeKey(key)}: ${rendered}`;
        }
        return `${indent}${humanizeKey(key)}:\n${rendered
          .split("\n")
          .map((line) => `${childIndent}${line}`)
          .join("\n")}`;
      })
      .filter(Boolean)
      .join("\n");
  }

  return "";
}

function valueHasContent(value: unknown) {
  if (value == null) return false;
  if (typeof value === "string") return stripHtml(value).length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value as Record<string, unknown>).length > 0;
  return true;
}

function buildOverviewSection(category: string, entity: DocumentationEntity, title: string): PageSection {
  const lines = [
    `Category: ${humanizeKey(category)}`,
    entity.type ? `Type: ${String(entity.type)}` : "",
    entity.selector ? `Selector: ${String(entity.selector)}` : "",
    entity.ngname ? `Angular name: ${String(entity.ngname)}` : "",
    entity.className ? `Class name: ${String(entity.className)}` : "",
    entity.file ? `Source file: ${String(entity.file)}` : "",
    typeof entity.standalone === "boolean" ? `Standalone: ${entity.standalone ? "yes" : "no"}` : "",
    entity.encapsulation ? `Encapsulation: ${String(entity.encapsulation)}` : "",
    entity.deprecated ? "Deprecated: yes" : "",
    entity.deprecationMessage ? `Deprecation: ${stripHtml(String(entity.deprecationMessage))}` : "",
    stripHtml(String(entity.rawdescription ?? entity.description ?? ""))
  ].filter(Boolean);

  return {
    heading: "Overview",
    level: 1,
    anchor: "#overview",
    path: [title, "Overview"],
    text: lines.join("\n\n"),
    codeBlocks: [],
    tables: []
  };
}

function toCodeBlocks(key: string, value: unknown): CodeBlockRecord[] {
  const lang = CODE_BLOCK_KEYS.get(key);
  if (!lang) return [];

  if (typeof value === "string" && value.trim()) {
    return [{ lang, code: value.trim() }];
  }

  if (Array.isArray(value)) {
    return value
      .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
      .map((code) => ({ lang, code: code.trim() }));
  }

  return [];
}

function buildEntitySections(
  category: string,
  entity: DocumentationEntity,
  title: string,
  includeCode: boolean
) {
  const sections: PageSection[] = [buildOverviewSection(category, entity, title)];

  Object.entries(entity).forEach(([key, value]) => {
    if (OVERVIEW_KEYS.has(key) || !valueHasContent(value)) return;

    if (CODE_BLOCK_KEYS.has(key)) {
      if (!includeCode) return;
      const codeBlocks = toCodeBlocks(key, value);
      if (!codeBlocks.length) return;
      sections.push({
        heading: humanizeKey(key),
        level: 2,
        anchor: `#${slugify(key)}`,
        path: [title, humanizeKey(key)],
        text: `${humanizeKey(key)} extracted from documentation.json.`,
        codeBlocks,
        tables: []
      });
      return;
    }

    const text = renderStructuredValue(value);
    if (!text) return;
    const heading = humanizeKey(key);
    sections.push({
      heading,
      level: 2,
      anchor: `#${slugify(key)}`,
      path: [title, heading],
      text,
      codeBlocks: [],
      tables: []
    });
  });

  return sections;
}

function buildEntityUrl(docsBaseUrl: string, category: string, name: string) {
  if (category === "routes") {
    return new URL("routes.html", docsBaseUrl).toString();
  }
  if (category === "miscellaneous") {
    return new URL("miscellaneous.html", docsBaseUrl).toString();
  }
  return new URL(`${category}/${encodeURIComponent(name)}.html`, docsBaseUrl).toString();
}

function deriveDocsBaseUrl(jsonUrl: string) {
  return jsonUrl.replace(/\/json\/documentation\.json(?:\?.*)?$/, "/");
}

function buildEntityPage(
  docsBaseUrl: string,
  category: string,
  entity: DocumentationEntity,
  includeCode: boolean,
  docVersion?: string
): PageRecord | null {
  const title = typeof entity.name === "string" && entity.name.trim() ? entity.name.trim() : humanizeKey(category);
  const url = buildEntityUrl(docsBaseUrl, category, title);
  const sections = buildEntitySections(category, entity, title, includeCode);
  if (!sections.length) return null;

  return {
    url,
    canonicalUrl: url,
    title,
    breadcrumbs: [humanizeKey(category)],
    version: docVersion,
    sections
  };
}

function buildRoutesPage(
  docsBaseUrl: string,
  routes: DocumentationEntity,
  docVersion?: string
): PageRecord | null {
  if (!valueHasContent(routes)) return null;
  const title = typeof routes.name === "string" && routes.name.trim() ? routes.name.trim() : "Routes";
  const text = renderStructuredValue(routes);
  if (!text) return null;

  return {
    url: buildEntityUrl(docsBaseUrl, "routes", title),
    canonicalUrl: buildEntityUrl(docsBaseUrl, "routes", title),
    title,
    breadcrumbs: ["Routes"],
    version: docVersion,
    sections: [
      {
        heading: "Overview",
        level: 1,
        anchor: "#overview",
        path: [title, "Overview"],
        text,
        codeBlocks: [],
        tables: []
      }
    ]
  };
}

function buildMiscellaneousPages(
  docsBaseUrl: string,
  miscellaneous: DocumentationEntity,
  docVersion?: string
) {
  const pages: PageRecord[] = [];

  Object.entries(miscellaneous).forEach(([key, value]) => {
    if (!valueHasContent(value)) return;
    const title = `Miscellaneous ${humanizeKey(key)}`;
    const text = renderStructuredValue(value);
    if (!text) return;
    const url = buildEntityUrl(docsBaseUrl, "miscellaneous", title);
    pages.push({
      url,
      canonicalUrl: url,
      title,
      breadcrumbs: ["Miscellaneous"],
      version: docVersion,
      sections: [
        {
          heading: humanizeKey(key),
          level: 1,
          anchor: `#${slugify(key)}`,
          path: [title, humanizeKey(key)],
          text,
          codeBlocks: [],
          tables: []
        }
      ]
    });
  });

  return pages;
}

export async function fetchDocumentationJsonPages(options: DocumentationJsonOptions): Promise<PageRecord[]> {
  const response = await fetch(options.jsonUrl);
  if (!response.ok) {
    throw new Error(`Documentation JSON fetch failed: ${response.status} ${options.jsonUrl}`);
  }

  const payload = (await response.json()) as DocumentationJson;
  const docsBaseUrl = options.docsBaseUrl?.trim() || deriveDocsBaseUrl(options.jsonUrl);
  const pages: PageRecord[] = [];

  Object.entries(payload).forEach(([category, value]) => {
    if (Array.isArray(value)) {
      value.forEach((entry) => {
        if (!entry || typeof entry !== "object") return;
        const page = buildEntityPage(
          docsBaseUrl,
          category,
          entry as DocumentationEntity,
          options.includeCode ?? false,
          options.docVersion
        );
        if (page) pages.push(page);
      });
      return;
    }

    if (!value || typeof value !== "object") return;

    if (category === "routes") {
      const page = buildRoutesPage(docsBaseUrl, value as DocumentationEntity, options.docVersion);
      if (page) pages.push(page);
      return;
    }

    if (category === "miscellaneous") {
      pages.push(...buildMiscellaneousPages(docsBaseUrl, value as DocumentationEntity, options.docVersion));
    }
  });

  return pages;
}
