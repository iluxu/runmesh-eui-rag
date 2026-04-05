declare module "@runmesh/agent" {
  export type Policy = (context: {
    messages: Array<{ role: string; content?: unknown }>;
  }) => { allow: boolean };

  export function createAgent(config: {
    name: string;
    model: string;
    systemPrompt: string;
    tools: unknown;
    memory: unknown;
    policies?: Policy[];
  }): {
    run(prompt: string): Promise<{
      response: { choices: Array<{ message?: { content?: string } }> };
      steps?: unknown[];
    }>;
  };
}

declare module "@runmesh/core" {
  export function createOpenAI(config: {
    apiKey: string;
    defaultModel: string;
  }): unknown;

  export function generateStructuredOutput(config: {
    client: unknown;
    request: { messages: Array<{ role: string; content: string }> };
    schema: unknown;
    maxRetries?: number;
  }): Promise<{ value: any }>;
}

declare module "@runmesh/memory" {
  export class InMemoryAdapter {}

  export class OpenAIEmbeddings {
    constructor(client: unknown);
  }

  export class InMemoryRetriever {
    constructor(embeddings: unknown);
    add(input: { id: string; text: string; embedding: number[] }): Promise<void>;
    search(query: string, limit: number): Promise<Array<{ id: string; text: string }>>;
  }
}

declare module "@runmesh/tools" {
  export class ToolRegistry {
    register(tool: unknown): void;
  }

  export function tool(config: unknown): unknown;
}
