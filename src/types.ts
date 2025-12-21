export type PageRecord = {
  url: string;
  title: string;
  text: string;
  headings: string[];
};

export type ChunkRecord = {
  id: string;
  url: string;
  title: string;
  section: string;
  text: string;
  embedding: number[];
};
