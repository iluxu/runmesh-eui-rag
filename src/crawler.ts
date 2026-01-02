import { load } from "cheerio";
import type { Cheerio, Element } from "cheerio";
import { chromium, type Page } from "playwright";
import { isHtmlUrl, normalizeWhitespace, stripHashes, toAbsoluteUrl } from "./utils.js";
import { CodeBlockRecord, PageRecord, PageSection, TableRecord } from "./types.js";
import { fetchSitemapUrls } from "./sitemap.js";

type CrawlMode = "fetch" | "browser";
type CheerioAPI = ReturnType<typeof load>;

type CrawlOptions = {
  baseUrl: string;
  seedUrls?: string[];
  maxPages: number;
  concurrency: number;
  delayMs: number;
  ignoreRobots: boolean;
  mode?: CrawlMode;
  browserTimeoutMs?: number;
  browserWaitMs?: number;
  userAgent?: string;
  includePatterns?: string[];
  excludePatterns?: string[];
  onProgress?: (count: number, url: string) => void;
};

const DEFAULT_BROWSER_TIMEOUT = 20000;
const DEFAULT_BROWSER_WAIT = 400;

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchText(url: string, userAgent?: string): Promise<string> {
  const response = await fetch(url, {
    headers: { "User-Agent": userAgent ?? "RunMeshRAG/0.1" }
  });
  if (!response.ok) {
    throw new Error(`Fetch failed ${response.status}: ${url}`);
  }
  return response.text();
}

async function loadRobots(base: string, userAgent?: string): Promise<string[]> {
  try {
    const robotsUrl = new URL("/robots.txt", base).toString();
    const content = await fetchText(robotsUrl, userAgent);
    return content
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.toLowerCase().startsWith("disallow"))
      .map((line) => line.split(":")[1]?.trim() ?? "")
      .filter(Boolean);
  } catch {
    return [];
  }
}

function isAllowed(pathname: string, disallows: string[], ignoreRobots: boolean): boolean {
  if (ignoreRobots) return true;
  return !disallows.some((rule) => rule !== "/" && pathname.startsWith(rule));
}

function slugifyHeading(input: string): string {
  return (
    input
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "")
      .trim()
      .replace(/\s+/g, "-") || "section"
  );
}

function extractBreadcrumbs($: CheerioAPI): string[] {
  const candidates = $("nav[aria-label*='breadcrumb' i] a, nav.breadcrumb a, .breadcrumb a");
  const crumbs = candidates
    .map((_, el) => normalizeWhitespace($(el).text()))
    .get()
    .filter(Boolean);
  return crumbs;
}

function extractCodeBlocks($root: Cheerio<Element>, $: CheerioAPI): CodeBlockRecord[] {
  const blocks: CodeBlockRecord[] = [];
  $root.find("pre code").each((_, el) => {
    const code = $(el).text();
    if (!code.trim()) return;
    const className = $(el).attr("class") ?? "";
    const match = className.match(/language-([a-z0-9-]+)/i);
    const lang = match?.[1];
    blocks.push({ lang, code: code.trim() });
  });
  return blocks;
}

function extractTables($root: Cheerio<Element>, $: CheerioAPI): TableRecord[] {
  const tables: TableRecord[] = [];
  $root.find("table").each((_, table) => {
    const headers = $(table)
      .find("thead th")
      .map((_, th) => normalizeWhitespace($(th).text()))
      .get()
      .filter(Boolean);
    const rows = $(table)
      .find("tbody tr")
      .map((_, tr) =>
        $(tr)
          .find("td")
          .map((_, td) => normalizeWhitespace($(td).text()))
          .get()
          .filter(Boolean)
      )
      .get()
      .filter((row) => row.length > 0);
    if (headers.length || rows.length) {
      tables.push({ headers, rows });
    }
  });
  return tables;
}

function buildSections($: CheerioAPI, root: Cheerio<Element>): PageSection[] {
  const headings = root.find("h1, h2, h3").toArray();
  if (!headings.length) {
    const text = normalizeWhitespace(root.text());
    return [
      {
        heading: "Overview",
        level: 1,
        anchor: "",
        path: ["Overview"],
        text,
        codeBlocks: extractCodeBlocks(root, $),
        tables: extractTables(root, $)
      }
    ];
  }

  const sections: PageSection[] = [];
  const pathStack: { level: number; heading: string }[] = [];

  headings.forEach((headingEl) => {
    const headingText = normalizeWhitespace($(headingEl).text());
    const level = Number(headingEl.tagName?.slice(1) ?? "1") || 1;
    const headingId = $(headingEl).attr("id") || "";
    const anchor = headingId ? `#${headingId}` : `#${slugifyHeading(headingText)}`;

    while (pathStack.length && pathStack[pathStack.length - 1].level >= level) {
      pathStack.pop();
    }
    pathStack.push({ level, heading: headingText });
    const path = pathStack.map((item) => item.heading);

    const sectionNodes = $(headingEl).nextUntil("h1, h2, h3");
    const wrapper = $("<div></div>");
    sectionNodes.each((_, el) => {
      wrapper.append($(el).clone());
    });

    const codeBlocks = extractCodeBlocks(wrapper, $);
    const tables = extractTables(wrapper, $);
    const textRoot = wrapper.clone();
    textRoot.find("pre, table").remove();
    const text = normalizeWhitespace(textRoot.text());

    sections.push({
      heading: headingText,
      level,
      anchor,
      path,
      text,
      codeBlocks,
      tables
    });
  });

  return sections;
}

function extractContent(html: string, url: string): PageRecord {
  const $ = load(html);
  $("script, style, noscript, svg").remove();

  const title = normalizeWhitespace($("title").text() || "EUI Documentation");
  const canonicalHref = $("link[rel='canonical']").attr("href");
  const canonicalUrl = canonicalHref ? toAbsoluteUrl(url, canonicalHref) : url;
  const main = $("main");
  const article = $("article");
  const root = main.length ? main : article.length ? article : $("body");

  const breadcrumbs = extractBreadcrumbs($);
  const sections = buildSections($, root);
  return { url: canonicalUrl ?? url, canonicalUrl: canonicalUrl ?? undefined, title, breadcrumbs, sections };
}

function extractLinks(html: string, baseUrl: string, baseOrigin: string): string[] {
  const $ = load(html);
  const links = new Set<string>();
  $("a[href]").each((_, el) => {
    const href = String($(el).attr("href") ?? "");
    if (!href || href.startsWith("mailto:") || href.startsWith("tel:")) return;
    const absolute = toAbsoluteUrl(baseUrl, href);
    if (!absolute) return;
    const cleaned = stripHashes(absolute);
    if (!cleaned.startsWith(baseOrigin)) return;
    if (!isHtmlUrl(cleaned)) return;
    links.add(cleaned);
  });
  return Array.from(links);
}

function matchesPatterns(url: string, includePatterns?: string[], excludePatterns?: string[]): boolean {
  if (excludePatterns && excludePatterns.some((pattern) => url.includes(pattern))) {
    return false;
  }
  if (!includePatterns || includePatterns.length === 0) {
    return true;
  }
  return includePatterns.some((pattern) => url.includes(pattern));
}

async function crawlSiteFetch(options: CrawlOptions): Promise<PageRecord[]> {
  const disallows = await loadRobots(options.baseUrl, options.userAgent);
  const baseOrigin = new URL(options.baseUrl).origin;
  const sitemapUrls = await fetchSitemapUrls(options.baseUrl, options.maxPages);
  const seedUrls = new Set([options.baseUrl, ...sitemapUrls, ...(options.seedUrls ?? [])]);
  const queue = Array.from(seedUrls);
  const visited = new Set<string>();
  const pages: PageRecord[] = [];

  while (queue.length && pages.length < options.maxPages) {
    const batch = queue.splice(0, options.concurrency);
    const results = await Promise.allSettled(
      batch.map(async (url) => {
        if (visited.has(url)) return null;
        const isSeed = seedUrls.has(url);
        const shouldStore = matchesPatterns(url, options.includePatterns, options.excludePatterns);
        if (!shouldStore && !isSeed) return null;
        const pathname = new URL(url).pathname;
        if (!isAllowed(pathname, disallows, options.ignoreRobots)) return null;
        visited.add(url);
        const html = await fetchText(url, options.userAgent);
        const page = shouldStore ? extractContent(html, url) : null;
        const links = extractLinks(html, url, baseOrigin);
        links.forEach((link) => {
          if (visited.has(link)) return;
          if (!matchesPatterns(link, options.includePatterns, options.excludePatterns)) return;
          queue.push(link);
        });
        await sleep(options.delayMs);
        if (page) {
          options.onProgress?.(pages.length + 1, url);
        }
        return page;
      })
    );

    results.forEach((result) => {
      if (result.status === "fulfilled" && result.value) {
        pages.push(result.value);
      }
    });
  }

  return pages;
}

async function waitForNetworkIdle(page: Page, timeoutMs: number) {
  try {
    await page.waitForLoadState("networkidle", { timeout: timeoutMs });
  } catch {
    return;
  }
}

async function navigateSpa(
  page: Page,
  url: string,
  baseOrigin: string,
  timeoutMs: number,
  waitMs: number
) {
  const target = new URL(url, baseOrigin);
  const nextPath = `${target.pathname}${target.search}${target.hash}`;

  await page.evaluate((path) => {
    if (window.location.pathname + window.location.search + window.location.hash === path) return;
    window.history.pushState({}, "", path);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, nextPath);

  await waitForNetworkIdle(page, timeoutMs);
  if (waitMs > 0) {
    await page.waitForTimeout(waitMs);
  }
}

async function navigatePage(
  page: Page,
  url: string,
  baseOrigin: string,
  timeoutMs: number,
  waitMs: number
): Promise<number | null> {
  let status: number | null = null;
  try {
    const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    status = response?.status() ?? null;
  } catch {
    status = null;
  }

  if (status && status >= 400) {
    try {
      await page.goto(baseOrigin, { waitUntil: "domcontentloaded", timeout: timeoutMs });
      await navigateSpa(page, url, baseOrigin, timeoutMs, waitMs);
      status = null;
    } catch {
      return status;
    }
  }

  await waitForNetworkIdle(page, timeoutMs);
  if (waitMs > 0) {
    await page.waitForTimeout(waitMs);
  }

  return status;
}

async function crawlSiteBrowser(options: CrawlOptions): Promise<PageRecord[]> {
  const baseOrigin = new URL(options.baseUrl).origin;
  const seedUrls = new Set([options.baseUrl, ...(options.seedUrls ?? [])]);
  const queue = Array.from(seedUrls);
  const visited = new Set<string>();
  const pages: PageRecord[] = [];
  const timeoutMs = options.browserTimeoutMs ?? DEFAULT_BROWSER_TIMEOUT;
  const waitMs = options.browserWaitMs ?? DEFAULT_BROWSER_WAIT;

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    userAgent: options.userAgent ?? "RunMeshRAG/0.1 (Playwright)"
  });

  try {
    while (queue.length && pages.length < options.maxPages) {
      const url = queue.shift();
      if (!url) break;
      const cleanedUrl = stripHashes(url);
      if (visited.has(cleanedUrl)) continue;
      visited.add(cleanedUrl);

      const status = await navigatePage(page, cleanedUrl, baseOrigin, timeoutMs, waitMs);
      if (status && status >= 400) {
        continue;
      }
      const html = await page.content();
      if (html.includes("<Code>AccessDenied</Code>")) {
        continue;
      }

      const shouldStore = matchesPatterns(cleanedUrl, options.includePatterns, options.excludePatterns);
      const record = shouldStore ? extractContent(html, cleanedUrl) : null;
      const links = extractLinks(html, cleanedUrl, baseOrigin);
      links.forEach((link) => {
        const nextUrl = stripHashes(link);
        if (visited.has(nextUrl)) return;
        if (!matchesPatterns(nextUrl, options.includePatterns, options.excludePatterns)) return;
        queue.push(nextUrl);
      });

      if (record) {
        pages.push(record);
        options.onProgress?.(pages.length, cleanedUrl);
      }
      await sleep(options.delayMs);
    }
  } finally {
    await browser.close();
  }

  return pages;
}

export async function crawlSite(options: CrawlOptions): Promise<PageRecord[]> {
  if (options.mode === "browser") {
    return crawlSiteBrowser(options);
  }
  return crawlSiteFetch(options);
}
