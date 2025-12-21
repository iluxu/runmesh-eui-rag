import { isHtmlUrl } from "./utils.js";

async function fetchXml(url: string): Promise<string | null> {
  try {
    const response = await fetch(url, { headers: { "User-Agent": "RunMeshRAG/0.1" } });
    if (!response.ok) return null;
    return response.text();
  } catch {
    return null;
  }
}

function extractLocs(xml: string): string[] {
  const matches = Array.from(xml.matchAll(/<loc>([^<]+)<\/loc>/gi));
  return matches.map((match) => match[1]).filter(Boolean);
}

export async function fetchSitemapUrls(baseUrl: string, max = 2000): Promise<string[]> {
  const base = new URL(baseUrl);
  const candidates = [
    new URL("/sitemap.xml", base).toString(),
    new URL("/sitemap-index.xml", base).toString(),
    new URL("/sitemap_index.xml", base).toString()
  ];

  for (const candidate of candidates) {
    const xml = await fetchXml(candidate);
    if (!xml) continue;
    const locs = extractLocs(xml);
    if (!locs.length) continue;

    const sitemapUrls = locs.filter((loc) => loc.endsWith(".xml"));
    if (!sitemapUrls.length) {
      return locs.filter((loc) => loc.startsWith(base.origin) && isHtmlUrl(loc)).slice(0, max);
    }

    const allLocs: string[] = [];
    for (const sitemapUrl of sitemapUrls.slice(0, 50)) {
      const innerXml = await fetchXml(sitemapUrl);
      if (!innerXml) continue;
      const innerLocs = extractLocs(innerXml);
      allLocs.push(...innerLocs);
      if (allLocs.length >= max) break;
    }

    return allLocs.filter((loc) => loc.startsWith(base.origin) && isHtmlUrl(loc)).slice(0, max);
  }

  return [];
}
