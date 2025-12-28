export type TableRecord = {
  headers: string[];
  rows: string[][];
};

export type CodeBlockRecord = {
  lang?: string;
  code: string;
};

export type PageSection = {
  heading: string;
  level: number;
  anchor: string;
  path: string[];
  text: string;
  codeBlocks: CodeBlockRecord[];
  tables: TableRecord[];
};

export type PageRecord = {
  url: string;
  canonicalUrl?: string;
  title: string;
  breadcrumbs: string[];
  version?: string;
  sections: PageSection[];
};

export type ChunkRecord = {
  id: string;
  url: string;
  title: string;
  section: string;
  sectionPath: string;
  anchor: string;
  breadcrumbs: string[];
  kind: "api" | "example" | "concept" | "faq" | "changelog";
  version?: string;
  generatedAt: string;
  lang?: string;
  tokens?: number;
  text: string;
  embedding: number[];
};
