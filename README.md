# RunMesh EUI RAG (Local)

A local RunMesh app that ingests the public EUI documentation site and provides an expert RAG chat experience with citations.

## Requirements
- Public access to `https://euidev.ecdevops.eu/`
- `OPENAI_API_KEY`
- `OPENAI_MODEL` (defaults to `gpt-5.2`)

## Install

```bash
pnpm --dir runmesh-eui-rag install
pnpm --dir runmesh-eui-rag exec playwright install chromium
```

## Live mode (default)

By default the server crawls the site at startup and builds the index in memory.

```bash
export OPENAI_API_KEY="..."
export OPENAI_MODEL="gpt-5.2"

pnpm --dir runmesh-eui-rag start
```

Optional controls:
- `EUI_LIVE=0` to disable live crawl
- `EUI_USE_LOCAL=1` to force loading `data/chunks.json`
- `EUI_SAVE=1` to save the live crawl to disk
- `EUI_SEED_URLS=https://euidev.ecdevops.eu/quickstart,...` to force extra entry points
- `EUI_CRAWL_MODE=browser` (default) to use Playwright for SPA crawling
- `EUI_CRAWL_MODE=fetch` to use plain HTTP crawling
- `EUI_URL_INCLUDE=21.x` to only keep URLs that include the substring
- `EUI_URL_EXCLUDE=19.x,18.x` to skip URLs that include the substring
- `EUI_BROWSER_TIMEOUT_MS=20000` for Playwright timeouts
- `EUI_BROWSER_WAIT_MS=400` for extra render wait time

## Ingest (optional one-time)

```bash
export OPENAI_API_KEY="..."
export OPENAI_MODEL="gpt-5.2"

pnpm --dir runmesh-eui-rag ingest
```

Options:
- `EUI_BASE_URL` (default: https://euidev.ecdevops.eu/)
- `EUI_MAX_PAGES` (default: 1200)
- `EUI_CONCURRENCY` (default: 4)
- `EUI_DELAY_MS` (default: 150)
- `EUI_IGNORE_ROBOTS=1` to bypass robots.txt
- `EUI_CRAWL_MODE=browser` to use Playwright for SPA crawling
- `EUI_URL_INCLUDE=21.x` to only keep URLs that include the substring
- `EUI_URL_EXCLUDE=19.x,18.x` to skip URLs that include the substring

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
  - `OPENAI_MODEL=gpt-5.2`
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
