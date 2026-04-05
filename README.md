# RunMesh Docs RAG (Local)

A local RunMesh app that ingests a documentation site (default: EUI) and provides an expert RAG chat experience with citations.

## Requirements
- Public access to the target docs site (default: `https://euidev.ecdevops.eu/eui-docs-eui-21.x/`)
- `OPENAI_API_KEY`
- `OPENAI_MODEL` (defaults to `gpt-5.4`)
- `OPENAI_REASONING_EFFORT` (defaults to `high` for GPT-5 family requests made via the HTTP API)

## Install

```bash
pnpm --dir runmesh-eui-rag install
pnpm --dir runmesh-eui-rag exec playwright install chromium
```

## Live mode (default)

By default the server crawls the site at startup and builds the index in memory.

```bash
export OPENAI_API_KEY="..."
export OPENAI_MODEL="gpt-5.4"
export OPENAI_REASONING_EFFORT="high"

pnpm --dir runmesh-eui-rag start
```

Optional controls:
Use the `RAG_` prefix (preferred). `EUI_` variables are still accepted for backward compatibility.

- `RAG_BASE_URL=https://euidev.ecdevops.eu/eui-docs-eui-21.x/`
- `RAG_DOC_VERSION=EUI 21.x`
- `RAG_DOCS_NAME=EUI`
- `RAG_DOC_JSON_URL=https://euidev.ecdevops.eu/eui-docs-eui-21.x/json/documentation.json` to ingest from the Compodoc JSON instead of crawling HTML
- `RAG_DOCS_BASE_URL=https://euidev.ecdevops.eu/eui-docs-eui-21.x/` to override generated source links when ingesting JSON
- `RAG_DOC_JSON_INCLUDE_CODE=1` to also embed `sourceCode`, `template`, and `styles` from `documentation.json`
- `RAG_LIVE=0` to disable live crawl
- `RAG_USE_LOCAL=1` to force loading `data/chunks.json`
- `RAG_SAVE=1` to save the live crawl to disk
- `RAG_SEED_URLS=https://euidev.ecdevops.eu/quickstart,...` to force extra entry points
- `RAG_CRAWL_MODE=browser` (default) to use Playwright for SPA crawling
- `RAG_CRAWL_MODE=fetch` to use plain HTTP crawling
- `RAG_URL_INCLUDE=21.x` to only keep URLs that include the substring
- `RAG_URL_EXCLUDE=19.x,18.x` to skip URLs that include the substring
- `RAG_BROWSER_TIMEOUT_MS=20000` for Playwright timeouts
- `RAG_BROWSER_WAIT_MS=400` for extra render wait time
- `RAG_USER_AGENT=RunMeshRAG/0.1 (Playwright)`
- `RAG_DATA_DIR=./data` to override where chunks.json is stored
- `RAG_EXPAND=0` to disable query expansions (defaults to EUI-oriented expansions)
- `RAG_SYSTEM_PROMPT="..."` to override the assistant prompt
- `RAG_EMBEDDING_MODEL=text-embedding-3-small` to override the embedding model

## Ingest (optional one-time)

```bash
export OPENAI_API_KEY="..."
export OPENAI_MODEL="gpt-5.4"
export OPENAI_REASONING_EFFORT="high"

pnpm --dir runmesh-eui-rag ingest
```

Options:
Use the `RAG_` prefix (preferred). `EUI_` variables are still accepted.
- `RAG_BASE_URL` (default: https://euidev.ecdevops.eu/eui-docs-eui-21.x/)
- `RAG_DOC_VERSION` (default: EUI 21.x)
- `RAG_DOC_JSON_URL` (default: https://euidev.ecdevops.eu/eui-docs-eui-21.x/json/documentation.json)
- `RAG_DOCS_BASE_URL` to override generated source links for JSON ingestion
- `RAG_DOC_JSON_INCLUDE_CODE=1` to include raw code/template/style payloads from `documentation.json`
- `RAG_MAX_PAGES` (default: 1200)
- `RAG_CONCURRENCY` (default: 4)
- `RAG_DELAY_MS` (default: 150)
- `RAG_IGNORE_ROBOTS=1` to bypass robots.txt
- `RAG_CRAWL_MODE=browser` to use Playwright for SPA crawling
- `RAG_URL_INCLUDE=21.x` to only keep URLs that include the substring
- `RAG_URL_EXCLUDE=19.x,18.x` to skip URLs that include the substring
- `RAG_DATA_DIR=./data` to override where chunks.json is stored

## Example: Polymarket docs ingest

```bash
export OPENAI_API_KEY="..."
export OPENAI_MODEL="gpt-5.4"
export OPENAI_REASONING_EFFORT="high"
export RAG_BASE_URL="https://docs.polymarket.com/developers/"
export RAG_DOC_VERSION="Polymarket Developers"
export RAG_DOCS_NAME="Polymarket developer"
export RAG_DATA_DIR="./data/polymarket"
export RAG_CRAWL_MODE="browser"
export RAG_URL_INCLUDE="/developers/"
export RAG_EXPAND="0"

pnpm --dir runmesh-eui-rag ingest
```

## Run

```bash
pnpm --dir runmesh-eui-rag start
```

Open `http://localhost:8811`.

## Cloudflare Pages + Workers (recommended deployment)

This app can be deployed as a static UI on Cloudflare Pages with API functions running as Workers.
It uses an R2 bucket to load `chunks.json`.

### 1) Create an R2 bucket and upload chunks

```bash
wrangler r2 bucket create runmesh-eui-chunks
wrangler r2 object put runmesh-eui-chunks/chunks.json \
  --file /home/iluxu/axiom/runmesh-eui-rag/data/chunks.json \
  --content-type application/json
```

### 2) Configure Pages bindings + secrets

In Cloudflare Pages project settings:
- Bind R2 bucket: `EUI_RAG_BUCKET` -> `runmesh-eui-chunks`
- Add secrets:
  - `OPENAI_API_KEY`
  - `OPENAI_MODEL=gpt-5.4`
  - `OPENAI_REASONING_EFFORT=high`
  - `OPENAI_EMBEDDING_MODEL=text-embedding-3-small`

### 3) Deploy the Pages site (includes Functions)

```bash
wrangler pages deploy /home/iluxu/axiom/runmesh-eui-rag/public \
  --project-name runmesh-eui-rag
```

Pages Functions live in `runmesh-eui-rag/functions/api/*` and automatically handle:
- `POST /api/ask`
- `GET /api/status`

## Notes
- This deployment uses the saved `chunks.json` from R2 (no live crawl on Workers).
## Notes
- The app is analysis-only with citations, no hallucinated APIs.
- Stored data lives in `runmesh-eui-rag/data/`.
