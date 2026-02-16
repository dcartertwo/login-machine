# Login Machine — Cloudflare Browser Worker

Cloudflare Worker + Durable Object that holds a persistent browser session via [Cloudflare Browser Rendering](https://developers.cloudflare.com/browser-rendering/).

This Worker is the backend for the `BROWSER_PROVIDER=cloudflare` path in the Login Machine.

## Architecture

```
Next.js App (api/chat)
  ↓ HTTP (Bearer auth)
Worker (index.ts)          — routes requests by session ID
  ↓
LoginBrowserDO (DO)        — one per session, holds browser in memory
  ├── @cloudflare/playwright browser (keep_alive: 10 min)
  ├── page object (persistent across requests)
  └── alarm (auto-cleanup after 15 min idle)
```

## Setup

### Prerequisites

- [Cloudflare account](https://dash.cloudflare.com/) with Browser Rendering enabled
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) (`npm i -g wrangler`)
- Node.js 20+

### Install

```bash
cd worker
npm install
```

### Local Development

1. Create a `.dev.vars` file with your auth secret:

   ```
   AUTH_SECRET=your-local-test-secret
   ```

2. Start the Worker:

   ```bash
   npx wrangler dev
   ```

   This launches locally on `http://localhost:8787`.

3. In the root project, set your `.env.local`:

   ```
   BROWSER_PROVIDER=cloudflare
   CF_BROWSER_WORKER_URL=http://localhost:8787
   CF_BROWSER_API_KEY=your-local-test-secret
   ```

4. Start the Next.js app in a separate terminal:

   ```bash
   npm run dev
   ```

### Deploy

```bash
npx wrangler deploy
```

Then set the `AUTH_SECRET` in production:

```bash
npx wrangler secret put AUTH_SECRET
```

Update your Next.js environment to point at the deployed Worker URL.

## API

All endpoints (except `/health`) require `Authorization: Bearer <AUTH_SECRET>`.

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/sessions` | Create session — launches browser, navigates to URL |
| `POST` | `/sessions/:id/page-context` | Extract stripped HTML + screenshot |
| `POST` | `/sessions/:id/fill` | Fill form fields + click submit |
| `POST` | `/sessions/:id/click` | Click an element by locator |
| `POST` | `/sessions/:id/navigate` | Navigate to a URL |
| `POST` | `/sessions/:id/wait` | Wait for page content to settle |
| `POST` | `/sessions/:id/screenshot` | Take a standalone screenshot |
| `POST` | `/sessions/:id/validate-locators` | Validate locators against live DOM |
| `POST` | `/sessions/:id/close` | Close the browser session |
| `DELETE` | `/sessions/:id` | Close the browser session |
| `GET` | `/health` | Worker health check (no auth) |

## Configuration

See `wrangler.jsonc` for the Worker configuration. Key bindings:

- `MYBROWSER` — Cloudflare Browser Rendering binding
- `LOGIN_SESSIONS` — Durable Object namespace for `LoginBrowserDO`

## Limits

- **Session timeout**: 10 minutes idle (Cloudflare max `keep_alive`)
- **Rate limit**: 3 requests/second (paid plan)
- **Free tier**: 10 hours/month of browser time
- **No live view**: Unlike BrowserBase, there's no embeddable iframe. The app uses screenshot preview instead.
