/**
 * Cloudflare Browser Rendering provider.
 *
 * Implements the same function signatures as browserbase.ts but delegates all
 * browser operations to a Cloudflare Worker + Durable Object via HTTP.
 *
 * The DO holds the browser session in memory — no reconnection overhead.
 * All Playwright operations happen inside the DO; this module is just an
 * HTTP client.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Cloudflare-specific BrowserSession.
 *
 * Unlike BrowserBase, there's no local Playwright page/browser/context.
 * All operations go through the Worker API.
 */
export interface BrowserSession {
  sessionId: string;
  /** Always null for Cloudflare — no local Playwright objects. */
  page: null;
  /** Always null for Cloudflare. */
  browser: null;
  /** Always null for Cloudflare. */
  context: null;
  /** Always null — CF doesn't have an embeddable live view. */
  liveViewUrl: null;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function getWorkerUrl(): string {
  const url = process.env.CF_BROWSER_WORKER_URL;
  if (!url) throw new Error("CF_BROWSER_WORKER_URL must be set");
  return url.replace(/\/$/, ""); // Strip trailing slash
}

function getApiKey(): string {
  const key = process.env.CF_BROWSER_API_KEY;
  if (!key) throw new Error("CF_BROWSER_API_KEY must be set");
  return key;
}

// ---------------------------------------------------------------------------
// HTTP client
// ---------------------------------------------------------------------------

const REQUEST_TIMEOUT_MS = 60_000;
const MAX_RETRIES = 2;
const INITIAL_BACKOFF_MS = 500;

/** Non-retryable status codes (client errors, session dead). */
const NO_RETRY_STATUSES = new Set([400, 401, 403, 404, 410, 422]);

/** Sleep for a given number of milliseconds. */
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Make an authenticated request to the Worker with retry + backoff.
 *
 * Retries on:
 *   - 429 (rate limit) — uses Retry-After header when available
 *   - 5xx (server error) — exponential backoff
 *   - Network errors (ECONNREFUSED, etc.)
 *
 * Does NOT retry on:
 *   - 4xx client errors (400, 401, 403, 404, 410, 422)
 *   - Timeout (AbortError) — already waited 60s
 */
async function workerFetch(
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<Response> {
  const { method = "POST", body } = options;
  const url = `${getWorkerUrl()}${path}`;
  const bodyStr = body ? JSON.stringify(body) : undefined;

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        method,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${getApiKey()}`,
        },
        body: bodyStr,
        signal: controller.signal,
      });

      // Success
      if (response.ok) return response;

      // Parse error body
      const data = await response.json().catch(() => ({})) as Record<string, unknown>;
      const errorMsg = (data.error as string) || `Worker returned ${response.status}`;

      // 410 = session dead — never retry
      if (response.status === 410) {
        throw new SessionExpiredError(errorMsg);
      }

      // Non-retryable client errors
      if (NO_RETRY_STATUSES.has(response.status)) {
        throw new Error(errorMsg);
      }

      // 429 = rate limited — retry with Retry-After or backoff
      if (response.status === 429 && attempt < MAX_RETRIES) {
        const retryAfter = response.headers.get("Retry-After");
        const waitMs = retryAfter
          ? Math.min(parseInt(retryAfter, 10) * 1000, 10_000)
          : INITIAL_BACKOFF_MS * 2 ** attempt;
        console.warn(`[cf-provider] Rate limited on ${path}, retrying in ${waitMs}ms`);
        await sleep(waitMs);
        continue;
      }

      // 5xx — retry with backoff
      if (response.status >= 500 && attempt < MAX_RETRIES) {
        const waitMs = INITIAL_BACKOFF_MS * 2 ** attempt;
        console.warn(`[cf-provider] Server error ${response.status} on ${path}, retrying in ${waitMs}ms`);
        await sleep(waitMs);
        continue;
      }

      throw new Error(errorMsg);
    } catch (err) {
      if (err instanceof SessionExpiredError) throw err;

      if (err instanceof Error && err.name === "AbortError") {
        throw new Error(`Worker request timed out after ${REQUEST_TIMEOUT_MS / 1000}s: ${path}`);
      }

      // Network errors (ECONNREFUSED, DNS failure, etc.) — retry
      if (isNetworkError(err) && attempt < MAX_RETRIES) {
        const waitMs = INITIAL_BACKOFF_MS * 2 ** attempt;
        console.warn(`[cf-provider] Network error on ${path}, retrying in ${waitMs}ms`);
        lastError = err instanceof Error ? err : new Error(String(err));
        await sleep(waitMs);
        continue;
      }

      // Wrap network errors with a helpful message
      if (isNetworkError(err)) {
        throw new Error(
          `Cannot reach browser worker at ${getWorkerUrl()}. Is the Worker running? (${err instanceof Error ? err.message : String(err)})`,
        );
      }

      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }

  // Exhausted retries
  throw lastError ?? new Error(`Request to ${path} failed after ${MAX_RETRIES + 1} attempts`);
}

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

/** Thrown when the DO reports the browser session is dead (410). */
export class SessionExpiredError extends Error {
  constructor(message: string) {
    super(`Browser session expired: ${message}`);
    this.name = "SessionExpiredError";
  }
}

/** Check if an error is a network-level failure (not an HTTP error). */
function isNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return (
    err.name === "TypeError" || // fetch() throws TypeError for network failures
    msg.includes("econnrefused") ||
    msg.includes("econnreset") ||
    msg.includes("enotfound") ||
    msg.includes("fetch failed") ||
    msg.includes("network")
  );
}

/** Make a Worker request and parse the JSON response. */
async function workerJson<T>(
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<T> {
  const response = await workerFetch(path, options);
  return response.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

/** Create a new browser session via the Worker/DO. */
export async function createSession(): Promise<BrowserSession> {
  const data = await workerJson<{ sessionId: string }>(
    "/sessions",
    { body: { url: "about:blank" } },
  );

  return {
    sessionId: data.sessionId,
    page: null,
    browser: null,
    context: null,
    liveViewUrl: null,
  };
}

/**
 * Get an existing session by ID.
 * For Cloudflare, the DO holds the state — no reconnection needed.
 * This just returns a session stub with the ID.
 */
export async function getSession(
  sessionId: string,
): Promise<BrowserSession> {
  return {
    sessionId,
    page: null,
    browser: null,
    context: null,
    liveViewUrl: null,
  };
}

/** Close the browser session. */
export async function closeSession(sessionId: string): Promise<void> {
  try {
    await workerJson(`/sessions/${sessionId}/close`);
  } catch {
    // Session may already be closed
  }
}

// ---------------------------------------------------------------------------
// Page context extraction
// ---------------------------------------------------------------------------

/**
 * Extract stripped HTML + screenshot from the current page.
 * Delegates to the DO's /page-context endpoint.
 */
export async function getPageContext(
  session: BrowserSession,
): Promise<{ html: string; screenshot: string; url: string }> {
  return workerJson(`/sessions/${session.sessionId}/page-context`);
}

// ---------------------------------------------------------------------------
// Wait for meaningful page content
// ---------------------------------------------------------------------------

/** Wait for the page to render meaningful content. */
export async function waitForPageContent(
  session: BrowserSession,
): Promise<void> {
  await workerJson(`/sessions/${session.sessionId}/wait`);
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

/** Navigate the browser to a URL. */
export async function navigateTo(
  session: BrowserSession,
  url: string,
): Promise<void> {
  await workerJson(`/sessions/${session.sessionId}/navigate`, {
    body: { url },
  });
}

// ---------------------------------------------------------------------------
// Form interaction
// ---------------------------------------------------------------------------

/** Fill form fields and click submit. */
export async function fillAndSubmit(
  session: BrowserSession,
  inputs: Array<{ locator: string; value: string }>,
  submitLocator: string,
): Promise<void> {
  await workerJson(`/sessions/${session.sessionId}/fill`, {
    body: { inputs, submitLocator },
  });
}

/** Click an element by locator. */
export async function clickElement(
  session: BrowserSession,
  locator: string,
): Promise<void> {
  await workerJson(`/sessions/${session.sessionId}/click`, {
    body: { locator },
  });
}

// ---------------------------------------------------------------------------
// Locator validation (used by agent.ts)
// ---------------------------------------------------------------------------

/** Validate locators against the live DOM. Returns which ones exist. */
export async function validateLocators(
  session: BrowserSession,
  locators: string[],
): Promise<Array<{ locator: string; exists: boolean }>> {
  const data = await workerJson<{
    results: Array<{ locator: string; exists: boolean }>;
  }>(`/sessions/${session.sessionId}/validate-locators`, {
    body: { locators },
  });
  return data.results;
}
