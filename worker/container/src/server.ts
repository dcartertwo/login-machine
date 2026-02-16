/**
 * Browser container HTTP server — runs inside the Docker container.
 *
 * Provides the same API surface as the old LoginBrowserDO, but uses
 * standard Playwright (not @cloudflare/playwright) with stealth measures.
 *
 * Endpoints:
 *   POST /launch              — Launch browser, navigate to URL
 *   POST /page-context        — Extract stripped HTML + screenshot
 *   POST /fill                — Fill form fields + click submit
 *   POST /click               — Click an element by locator
 *   POST /navigate            — Navigate to a URL
 *   POST /wait                — Wait for page content to settle
 *   POST /screenshot          — Take a standalone screenshot
 *   POST /validate-locators   — Validate locators against live DOM
 *   POST /close               — Close the browser
 *   GET  /health              — Health check (also used as ping by Container class)
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { chromium, type Browser, type Page, type BrowserContext } from "playwright";
import { applyStealthToContext, USER_AGENT } from "./stealth.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PORT = parseInt(process.env.PORT || "3000", 10);
const DEFAULT_TIMEOUT = 15_000;
const MAX_HTML_LENGTH = 100_000;

// ---------------------------------------------------------------------------
// DOM walker (evaluated browser-side via page.evaluate)
// ---------------------------------------------------------------------------

const EXTRACT_BODY_HTML_FN = `() => {
  function extractHTML(node) {
    if (node.nodeType === 3) return node.textContent?.trim() || "";
    if (node.nodeType !== 1) return "";
    const el = node;
    const styles = window.getComputedStyle(el);
    if (styles.display === "none" || styles.visibility === "hidden") return "";
    const exclude = ["SCRIPT", "STYLE", "svg", "IMG", "NOSCRIPT", "LINK"];
    if (exclude.includes(el.tagName)) return "";
    const root = el.shadowRoot || el;
    let html = "<" + el.tagName.toLowerCase();
    for (const attr of el.attributes) {
      if (["id","class","type","name","placeholder","role","aria-label"].includes(attr.name)) {
        html += " " + attr.name + '="' + attr.value + '"';
      }
    }
    html += ">";
    for (const child of root.childNodes) {
      if (child instanceof HTMLSlotElement) {
        const assigned = child.assignedNodes()[0];
        html += assigned ? extractHTML(assigned) : child.innerHTML;
      } else {
        html += extractHTML(child);
      }
    }
    html += "</" + el.tagName.toLowerCase() + ">";
    return html;
  }
  return extractHTML(document.body);
}`;

// ---------------------------------------------------------------------------
// Browser state (held in memory for the container's lifetime)
// ---------------------------------------------------------------------------

let browser: Browser | null = null;
let context: BrowserContext | null = null;
let page: Page | null = null;

// ---------------------------------------------------------------------------
// JSON helpers
// ---------------------------------------------------------------------------

function jsonResponse(res: ServerResponse, body: unknown, status = 200): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function errorResponse(res: ServerResponse, message: string, status = 500): void {
  jsonResponse(res, { error: message }, status);
}

async function readBody<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString()) as T;
}

function ensureAlive(res: ServerResponse): boolean {
  if (!browser || !page) {
    errorResponse(res, "Browser session not active. Call /launch first.", 410);
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handleLaunch(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody<{ url: string }>(req);
  if (!body.url) {
    errorResponse(res, "Missing 'url' in request body", 400);
    return;
  }

  // Close existing browser if any
  await closeBrowser();

  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-blink-features=AutomationControlled",
      "--disable-infobars",
      "--disable-gpu",
    ],
  });

  context = await browser.newContext({
    userAgent: USER_AGENT,
    viewport: { width: 1280, height: 800 },
    locale: "en-US",
    timezoneId: "America/New_York",
  });

  // Apply stealth patches before any page is created
  await applyStealthToContext(context);

  page = await context.newPage();
  page.setDefaultTimeout(DEFAULT_TIMEOUT);

  await page.goto(body.url, {
    waitUntil: "domcontentloaded",
    timeout: 30_000,
  });

  jsonResponse(res, { ok: true });
}

async function handlePageContext(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!ensureAlive(res)) return;

  try {
    await page!.waitForLoadState("domcontentloaded", { timeout: 10_000 });
  } catch {
    // Page might still be usable
  }

  let bodyHtml = await page!.evaluate(`(${EXTRACT_BODY_HTML_FN})()`) as string;

  // Extract iframe content
  for (const frame of page!.frames()) {
    if (frame !== page!.mainFrame()) {
      try {
        const iframeHtml = await frame.evaluate(`(${EXTRACT_BODY_HTML_FN})()`) as string;
        bodyHtml += `<iframe-content>${iframeHtml}</iframe-content>`;
      } catch {
        // Cross-origin frames can't be read
      }
    }
  }

  const buf = await page!.screenshot({
    type: "jpeg",
    quality: 80,
    fullPage: false,
    timeout: 30_000,
    animations: "disabled",
  });

  jsonResponse(res, {
    html: bodyHtml.substring(0, MAX_HTML_LENGTH),
    screenshot: buf.toString("base64"),
    url: page!.url(),
  });
}

async function handleFill(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!ensureAlive(res)) return;

  const body = await readBody<{
    inputs: Array<{ locator: string; value: string }>;
    submitLocator: string;
  }>(req);

  for (const { locator, value } of body.inputs) {
    const filled = await fillInPageOrFrame(page!, locator, value);
    if (!filled) {
      console.warn(`[container] Could not find element for locator: ${locator}`);
    }
  }

  await clickInPageOrFrame(page!, body.submitLocator);

  // Wait for navigation / redirects
  await page!.waitForLoadState("load").catch(() => {});
  await page!.waitForTimeout(3000);

  try {
    await page!.waitForLoadState("domcontentloaded", { timeout: 5000 });
  } catch {
    // Page may already be stable
  }

  jsonResponse(res, { success: true });
}

async function handleClick(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!ensureAlive(res)) return;

  const body = await readBody<{ locator: string }>(req);

  await clickInPageOrFrame(page!, body.locator);
  await page!.waitForLoadState("load").catch(() => {});
  await page!.waitForTimeout(1500);

  jsonResponse(res, { success: true });
}

async function handleNavigate(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!ensureAlive(res)) return;

  const body = await readBody<{ url: string }>(req);

  await page!.goto(body.url, { waitUntil: "domcontentloaded" });
  await page!.waitForLoadState("load").catch(() => {});

  jsonResponse(res, { success: true });
}

async function handleWait(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!ensureAlive(res)) return;

  await page!.waitForLoadState("load").catch(() => {});

  try {
    await page!.waitForFunction(`(() => {
      const body = document.body;
      if (!body) return false;
      return (
        body.querySelectorAll("input, button, a[href]").length >= 2 ||
        (body.innerText || "").trim().length > 100
      );
    })()`, { timeout: 15_000 });
  } catch {
    // Timeout is fine
  }

  await page!.waitForTimeout(2000);

  jsonResponse(res, { success: true });
}

async function handleScreenshot(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!ensureAlive(res)) return;

  const buf = await page!.screenshot({
    type: "jpeg",
    quality: 80,
    fullPage: false,
    timeout: 30_000,
    animations: "disabled",
  });

  jsonResponse(res, {
    screenshot: buf.toString("base64"),
    url: page!.url(),
  });
}

async function handleValidateLocators(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!ensureAlive(res)) return;

  const body = await readBody<{ locators: string[] }>(req);

  const results = await Promise.all(
    body.locators.map(async (locator) => ({
      locator,
      exists: await locatorExists(page!, locator),
    })),
  );

  jsonResponse(res, { results });
}

async function handleClose(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  await closeBrowser();
  jsonResponse(res, { success: true });
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function closeBrowser(): Promise<void> {
  try {
    if (browser) await browser.close();
  } catch {
    // Browser may already be closed
  } finally {
    browser = null;
    context = null;
    page = null;
  }
}

async function fillInPageOrFrame(
  p: Page,
  locator: string,
  value: string,
): Promise<boolean> {
  try {
    const el = p.locator(locator).first();
    if ((await el.count()) > 0) {
      await el.waitFor({ state: "attached", timeout: 5000 });
      await el.focus();
      await el.clear();
      await el.fill(value);
      return true;
    }
  } catch (e) {
    console.warn(`[container] Main frame fill failed for ${locator}:`, e);
  }

  for (const frame of p.frames()) {
    if (frame === p.mainFrame()) continue;
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
  p: Page,
  locator: string,
): Promise<boolean> {
  try {
    const el = p.locator(locator).first();
    if ((await el.count()) > 0) {
      await el.click();
      return true;
    }
  } catch (e) {
    console.warn(`[container] Main frame click failed for ${locator}:`, e);
  }

  for (const frame of p.frames()) {
    if (frame === p.mainFrame()) continue;
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

async function locatorExists(p: Page, locator: string): Promise<boolean> {
  try {
    if ((await p.locator(locator).first().count()) > 0) return true;
  } catch {
    // Fall through to frames
  }

  for (const frame of p.frames()) {
    if (frame === p.mainFrame()) continue;
    try {
      if ((await frame.locator(locator).first().count()) > 0) return true;
    } catch {
      // Next frame
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// HTTP server + router
// ---------------------------------------------------------------------------

const server = createServer(async (req, res) => {
  const path = req.url || "/";
  const method = req.method || "GET";

  try {
    if (method === "GET" && (path === "/health" || path === "/ping")) {
      jsonResponse(res, { alive: browser !== null && page !== null });
      return;
    }

    if (method !== "POST") {
      errorResponse(res, "Method not allowed", 405);
      return;
    }

    switch (path) {
      case "/launch":
        await handleLaunch(req, res);
        break;
      case "/page-context":
        await handlePageContext(req, res);
        break;
      case "/fill":
        await handleFill(req, res);
        break;
      case "/click":
        await handleClick(req, res);
        break;
      case "/navigate":
        await handleNavigate(req, res);
        break;
      case "/wait":
        await handleWait(req, res);
        break;
      case "/screenshot":
        await handleScreenshot(req, res);
        break;
      case "/validate-locators":
        await handleValidateLocators(req, res);
        break;
      case "/close":
        await handleClose(req, res);
        break;
      default:
        errorResponse(res, `Unknown path: ${path}`, 404);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[container] Error on ${path}:`, message);

    // Detect browser crash
    if (
      message.includes("Target closed") ||
      message.includes("Browser closed") ||
      message.includes("Connection closed")
    ) {
      browser = null;
      context = null;
      page = null;
      errorResponse(res, "Browser session crashed. Please create a new session.", 410);
      return;
    }

    errorResponse(res, message);
  }
});

server.listen(PORT, () => {
  console.log(`[container] Browser server ready on port ${PORT}`);
});
