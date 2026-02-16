/**
 * BrowserBase browser provider.
 *
 * Stateless design for serverless: every request connects to BrowserBase via
 * CDP, does its work, and the connection closes with the function. BrowserBase
 * keeps the actual browser alive server-side.
 *
 * Credentials never pass through this module's logs; values are written
 * directly to the DOM.
 */

import {
  chromium,
  type Browser,
  type Page,
  type BrowserContext,
} from "playwright";

import { extractBodyHTML, MAX_HTML_LENGTH } from "../page-extract";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BrowserSession {
  sessionId: string;
  page: Page;
  browser: Browser;
  context: BrowserContext;
  liveViewUrl: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getApiKey(): string {
  const apiKey = process.env.BROWSERBASE_API_KEY;
  if (!apiKey) throw new Error("BROWSERBASE_API_KEY must be set");
  return apiKey;
}

/** Connect Playwright to an existing BrowserBase session over CDP. */
async function connectToSession(
  bbSessionId: string,
): Promise<{ browser: Browser; context: BrowserContext; page: Page }> {
  const apiKey = getApiKey();
  const wsEndpoint = `wss://connect.browserbase.com?apiKey=${apiKey}&sessionId=${bbSessionId}`;
  const browser = await chromium.connectOverCDP(wsEndpoint);
  const context = browser.contexts()[0];
  const page = context.pages()[0] || (await context.newPage());
  page.setDefaultTimeout(15000);
  return { browser, context, page };
}

/** Fetch the embeddable live-view URL for a BrowserBase session. */
async function fetchLiveViewUrl(bbSessionId: string): Promise<string> {
  const apiKey = getApiKey();
  const fallback = `https://www.browserbase.com/sessions/${bbSessionId}`;
  try {
    const res = await fetch(
      `https://api.browserbase.com/v1/sessions/${bbSessionId}/debug`,
      { headers: { "x-bb-api-key": apiKey } },
    );
    if (!res.ok) return fallback;
    const data = await res.json();
    return data.debuggerFullscreenUrl || fallback;
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

/** Create a new BrowserBase cloud browser session. */
export async function createSession(): Promise<BrowserSession> {
  const apiKey = getApiKey();
  const projectId = process.env.BROWSERBASE_PROJECT_ID;
  if (!projectId) throw new Error("BROWSERBASE_PROJECT_ID must be set");

  const res = await fetch("https://api.browserbase.com/v1/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-bb-api-key": apiKey },
    body: JSON.stringify({
      projectId,
      browserSettings: { viewport: { width: 1280, height: 800 } },
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `BrowserBase session creation failed: ${res.statusText}${body ? ` — ${body}` : ""}`,
    );
  }

  const data = await res.json();
  const bbSessionId: string = data.id;

  const { browser, context, page } = await connectToSession(bbSessionId);
  const liveViewUrl = await fetchLiveViewUrl(bbSessionId);

  return { sessionId: bbSessionId, page, browser, context, liveViewUrl };
}

/** Reconnect to an existing BrowserBase session by ID. */
export async function getSession(
  bbSessionId: string,
): Promise<BrowserSession> {
  const { browser, context, page } = await connectToSession(bbSessionId);
  const liveViewUrl = await fetchLiveViewUrl(bbSessionId);
  return { sessionId: bbSessionId, page, browser, context, liveViewUrl };
}

/** Disconnect Playwright from the session (BrowserBase keeps the browser alive). */
export async function closeSession(bbSessionId: string): Promise<void> {
  try {
    const { browser } = await connectToSession(bbSessionId);
    await browser.close();
  } catch {
    // Session may already be closed
  }
}

// ---------------------------------------------------------------------------
// Page context extraction
// ---------------------------------------------------------------------------

/**
 * Build the minimal context the LLM needs: stripped HTML + a JPEG screenshot.
 *
 * Uses the shared DOM walker from page-extract.ts. Shadow DOM boundaries are
 * traversed so enterprise SSO widgets aren't missed.
 */
export async function getPageContext(
  session: BrowserSession,
  attempt = 0,
): Promise<{ html: string; screenshot: string; url: string }> {
  const { page } = session;

  try {
    await page.waitForLoadState("domcontentloaded", { timeout: 10000 });
  } catch {
    // Page might still be usable even if the full load times out
  }

  try {
    let bodyHtml = await page.evaluate(extractBodyHTML);

    // Extract iframe content separately
    for (const frame of page.frames()) {
      if (frame !== page.mainFrame()) {
        try {
          const iframeHtml = await frame.evaluate(extractBodyHTML);
          bodyHtml += `<iframe-content>${iframeHtml}</iframe-content>`;
        } catch {
          // Cross-origin frames can't be read
        }
      }
    }

    const buf = await page.screenshot({
      type: "jpeg",
      quality: 80,
      fullPage: false,
      timeout: 30000,
      animations: "disabled",
    });

    return {
      html: bodyHtml.substring(0, MAX_HTML_LENGTH),
      screenshot: buf.toString("base64"),
      url: page.url(),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "";
    if (msg.includes("Execution context was destroyed") && attempt < 2) {
      console.warn(
        `[browser] Navigation detected, retrying (attempt ${attempt + 1})...`,
      );
      await page.waitForTimeout(2000);
      return getPageContext(session, attempt + 1);
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Wait for meaningful page content (used after form submissions)
// ---------------------------------------------------------------------------

/**
 * Wait for the SPA to render meaningful content. Many login pages use
 * client-side rendering where the initial HTML is just an empty shell.
 */
export async function waitForPageContent(
  session: BrowserSession,
): Promise<void> {
  const { page } = session;

  await page.waitForLoadState("load").catch(() => {});

  try {
    await page.waitForFunction(
      () => {
        const body = document.body;
        if (!body) return false;
        return (
          body.querySelectorAll("input, button, a[href]").length >= 2 ||
          (body.innerText || "").trim().length > 100
        );
      },
      { timeout: 15000 },
    );
  } catch {
    // Timeout is fine — re-analyze with whatever we have
  }

  await page.waitForTimeout(2000);
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

/** Navigate the browser to a URL. Used for magic login links. */
export async function navigateTo(
  session: BrowserSession,
  url: string,
): Promise<void> {
  const { page } = session;
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("load").catch(() => {});
}

// ---------------------------------------------------------------------------
// Form interaction helpers
// ---------------------------------------------------------------------------

/**
 * Fill every field and click submit. Credential values are written directly
 * to the DOM — they never appear in logs or LLM context.
 */
export async function fillAndSubmit(
  session: BrowserSession,
  inputs: Array<{ locator: string; value: string }>,
  submitLocator: string,
): Promise<void> {
  const { page } = session;

  for (const { locator, value } of inputs) {
    const filled = await fillInPageOrFrame(page, locator, value);
    if (!filled) {
      console.warn(`[browser] Could not find element for locator: ${locator}`);
    }
  }

  await clickInPageOrFrame(page, submitLocator);

  // Wait for navigation / redirects
  await page.waitForLoadState("load").catch(() => {});
  await page.waitForTimeout(3000);

  try {
    await page.waitForLoadState("domcontentloaded", { timeout: 5000 });
  } catch {
    // Page may already be stable
  }
}

/** Click an element, searching across frames if needed. */
export async function clickElement(
  session: BrowserSession,
  locator: string,
): Promise<void> {
  const { page } = session;

  await clickInPageOrFrame(page, locator);
  await page.waitForLoadState("load").catch(() => {});
  await page.waitForTimeout(1500);
}

// ---------------------------------------------------------------------------
// Frame-aware helpers (internal)
// ---------------------------------------------------------------------------

async function fillInPageOrFrame(
  page: Page,
  locator: string,
  value: string,
): Promise<boolean> {
  try {
    const el = page.locator(locator).first();
    if ((await el.count()) > 0) {
      await el.waitFor({ state: "attached", timeout: 5000 });
      await el.focus();
      await el.clear();
      await el.fill(value);
      return true;
    }
  } catch (e) {
    console.warn(`[browser] Main frame fill failed for ${locator}:`, e);
  }

  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) continue;
    try {
      const el = frame.locator(locator).first();
      if ((await el.count()) > 0) {
        await el.focus();
        await el.clear();
        await el.fill(value);
        return true;
      }
    } catch {
      // Try next frame
    }
  }
  return false;
}

async function clickInPageOrFrame(
  page: Page,
  locator: string,
): Promise<boolean> {
  try {
    const el = page.locator(locator).first();
    if ((await el.count()) > 0) {
      await el.click();
      return true;
    }
  } catch (e) {
    console.warn(`[browser] Main frame click failed for ${locator}:`, e);
  }

  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) continue;
    try {
      const el = frame.locator(locator).first();
      if ((await el.count()) > 0) {
        await el.click();
        return true;
      }
    } catch {
      // Try next frame
    }
  }
  return false;
}
