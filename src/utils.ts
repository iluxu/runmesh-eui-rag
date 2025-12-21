export function normalizeWhitespace(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}

export function stripHashes(url: string): string {
  const [base] = url.split("#");
  return base ?? url;
}

export function isHtmlUrl(url: string): boolean {
  return !/\.(png|jpe?g|svg|gif|css|js|ico|pdf|zip|gz|tar|mp4|webm)$/i.test(url);
}

export function toAbsoluteUrl(base: string, link: string): string | null {
  try {
    return new URL(link, base).toString();
  } catch {
    return null;
  }
}

export function chunkText(text: string, maxChars = 1200, overlap = 150): string[] {
  if (text.length <= maxChars) return [text];
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(text.length, start + maxChars);
    const slice = text.slice(start, end);
    chunks.push(slice);
    if (end === text.length) break;
    start = Math.max(0, end - overlap);
  }
  return chunks;
}

export function formatDate(date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}
