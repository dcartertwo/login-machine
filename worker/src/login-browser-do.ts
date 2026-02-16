/**
 * LoginBrowserDO — Durable Object that holds a Cloudflare Browser Rendering
 * session in memory.
 *
 * The DO owns the browser lifecycle: launch → navigate → interact → close.
 * The Next.js app communicates via HTTP through the Worker fetch handler.
 *
 * Key properties:
 *   - Browser + page persist across requests (no reconnection overhead)
 *   - 10 min keep_alive (max allowed by Cloudflare)
 *   - Alarm-based cleanup for stale sessions
 *   - All Playwright operations run inside the DO (not in Next.js)
 */

import { DurableObject } from "cloudflare:workers";
import { launch } from "@cloudflare/playwright";
import type { Browser, Page } from "@cloudflare/playwright";

import type { Env } from "./index";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const KEEP_ALIVE_MS = 600_000; // 10 minutes (max allowed)
const STALE_SESSION_MS = 900_000; // 15 minutes — alarm cleanup
const DEFAULT_TIMEOUT = 15_000;

// ---------------------------------------------------------------------------
// Shared DOM walker (duplicated from page-extract.ts for Worker context)
// ---------------------------------------------------------------------------

/**
 * Browser-side JavaScript that extracts stripped HTML from document.body.
 * Executed inside the browser via page.evaluate() — NOT in the Worker runtime.
 *
 * Defined as a string template to avoid Worker-side type-checking of DOM
 * globals (window, document, Node, etc.) that only exist browser-side.
 */
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

const MAX_HTML_LENGTH = 100_000;

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function errorResponse(message: string, status = 500): Response {
  return jsonResponse({ error: message }, status);
}

// ---------------------------------------------------------------------------
// LoginBrowserDO
// ---------------------------------------------------------------------------

export class LoginBrowserDO extends DurableObject<Env> {
  private browser: Browser | null = null;
  private page: Page | null = null;

  /** Schedule a cleanup alarm when created or reconnected. */
  private async scheduleCleanup(): Promise<void> {
    await this.ctx.storage.setAlarm(Date.now() + STALE_SESSION_MS);
  }

  /** Ensure browser and page are alive, or return an error response. */
  private ensureAlive(): Response | null {
    if (!this.browser || !this.page) {
      return errorResponse("Browser session not active. Call /launch first.", 410);
    }
    return null;
  }

  // -----------------------------------------------------------------------
  // HTTP router
  // -----------------------------------------------------------------------

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      switch (path) {
        case "/launch":
          return await this.handleLaunch(request);
        case "/page-context":
          return await this.handlePageContext();
        case "/fill":
          return await this.handleFill(request);
        case "/click":
          return await this.handleClick(request);
        case "/navigate":
          return await this.handleNavigate(request);
        case "/wait":
          return await this.handleWait();
        case "/screenshot":
          return await this.handleScreenshot();
        case "/validate-locators":
          return await this.handleValidateLocators(request);
        case "/close":
          return await this.handleClose();
        case "/health":
          return jsonResponse({
            alive: this.browser !== null && this.page !== null,
          });
        default:
          return errorResponse(`Unknown path: ${path}`, 404);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[LoginBrowserDO] Error on ${path}:`, message);

      // Detect browser crash
      if (
        message.includes("Target closed") ||
        message.includes("Browser closed") ||
        message.includes("Connection closed")
      ) {
        this.browser = null;
        this.page = null;
        return errorResponse("Browser session crashed. Please create a new session.", 410);
      }

      return errorResponse(message);
    }
  }

  // -----------------------------------------------------------------------
  // Alarm — cleanup stale sessions
  // -----------------------------------------------------------------------

  async alarm(): Promise<void> {
    console.log("[LoginBrowserDO] Alarm fired — cleaning up stale session");
    await this.closeBrowser();
  }

  // -----------------------------------------------------------------------
  // Handlers
  // -----------------------------------------------------------------------

  /** Launch a new browser, navigate to the given URL. */
  private async handleLaunch(request: Request): Promise<Response> {
    const body = await request.json<{ url: string }>();
    if (!body.url) return errorResponse("Missing 'url' in request body", 400);

    // Close existing browser if any
    await this.closeBrowser();

    this.browser = await launch(this.env.MYBROWSER, {
      keep_alive: KEEP_ALIVE_MS,
    });
    this.page = await this.browser.newPage();
    this.page.setDefaultTimeout(DEFAULT_TIMEOUT);

    // Set viewport to match BrowserBase default
    await this.page.setViewportSize({ width: 1280, height: 800 });

    await this.page.goto(body.url, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });

    await this.scheduleCleanup();

    return jsonResponse({ sessionId: this.ctx.id.toString() });
  }

  /** Extract stripped HTML + JPEG screenshot from the current page. */
  private async handlePageContext(): Promise<Response> {
    const dead = this.ensureAlive();
    if (dead) return dead;

    const page = this.page!;

    try {
      await page.waitForLoadState("domcontentloaded", { timeout: 10_000 });
    } catch {
      // Page might still be usable
    }

    let bodyHtml = await page.evaluate(`(${EXTRACT_BODY_HTML_FN})()`) as string;

    // Extract iframe content
    for (const frame of page.frames()) {
      if (frame !== page.mainFrame()) {
        try {
          const iframeHtml = await frame.evaluate(`(${EXTRACT_BODY_HTML_FN})()`) as string;
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
      timeout: 30_000,
      animations: "disabled",
    });

    await this.scheduleCleanup();

    return jsonResponse({
      html: bodyHtml.substring(0, MAX_HTML_LENGTH),
      screenshot: Buffer.from(buf).toString("base64"),
      url: page.url(),
    });
  }

  /** Fill form fields and click submit. */
  private async handleFill(request: Request): Promise<Response> {
    const dead = this.ensureAlive();
    if (dead) return dead;

    const body = await request.json<{
      inputs: Array<{ locator: string; value: string }>;
      submitLocator: string;
    }>();

    const page = this.page!;

    for (const { locator, value } of body.inputs) {
      const filled = await this.fillInPageOrFrame(page, locator, value);
      if (!filled) {
        console.warn(`[DO] Could not find element for locator: ${locator}`);
      }
    }

    await this.clickInPageOrFrame(page, body.submitLocator);

    // Wait for navigation / redirects
    await page.waitForLoadState("load").catch(() => {});
    await page.waitForTimeout(3000);

    try {
      await page.waitForLoadState("domcontentloaded", { timeout: 5000 });
    } catch {
      // Page may already be stable
    }

    await this.scheduleCleanup();

    return jsonResponse({ success: true });
  }

  /** Click an element by locator. */
  private async handleClick(request: Request): Promise<Response> {
    const dead = this.ensureAlive();
    if (dead) return dead;

    const body = await request.json<{ locator: string }>();
    const page = this.page!;

    await this.clickInPageOrFrame(page, body.locator);
    await page.waitForLoadState("load").catch(() => {});
    await page.waitForTimeout(1500);

    await this.scheduleCleanup();

    return jsonResponse({ success: true });
  }

  /** Navigate to a URL (magic login links). */
  private async handleNavigate(request: Request): Promise<Response> {
    const dead = this.ensureAlive();
    if (dead) return dead;

    const body = await request.json<{ url: string }>();
    const page = this.page!;

    await page.goto(body.url, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("load").catch(() => {});

    await this.scheduleCleanup();

    return jsonResponse({ success: true });
  }

  /** Wait for meaningful page content to render. */
  private async handleWait(): Promise<Response> {
    const dead = this.ensureAlive();
    if (dead) return dead;

    const page = this.page!;

    await page.waitForLoadState("load").catch(() => {});

    try {
      await page.waitForFunction(`(() => {
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

    await page.waitForTimeout(2000);
    await this.scheduleCleanup();

    return jsonResponse({ success: true });
  }

  /** Take a standalone screenshot (for live preview polling). */
  private async handleScreenshot(): Promise<Response> {
    const dead = this.ensureAlive();
    if (dead) return dead;

    const buf = await this.page!.screenshot({
      type: "jpeg",
      quality: 80,
      fullPage: false,
      timeout: 30_000,
      animations: "disabled",
    });

    await this.scheduleCleanup();

    return jsonResponse({
      screenshot: Buffer.from(buf).toString("base64"),
      url: this.page!.url(),
    });
  }

  /** Validate an array of Playwright locators against the live DOM. */
  private async handleValidateLocators(request: Request): Promise<Response> {
    const dead = this.ensureAlive();
    if (dead) return dead;

    const body = await request.json<{ locators: string[] }>();
    const page = this.page!;

    const results = await Promise.all(
      body.locators.map(async (locator) => ({
        locator,
        exists: await this.locatorExists(page, locator),
      })),
    );

    await this.scheduleCleanup();

    return jsonResponse({ results });
  }

  /** Close the browser and clean up. */
  private async handleClose(): Promise<Response> {
    await this.closeBrowser();
    return jsonResponse({ success: true });
  }

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  private async closeBrowser(): Promise<void> {
    try {
      if (this.browser) {
        await this.browser.close();
      }
    } catch {
      // Browser may already be closed
    } finally {
      this.browser = null;
      this.page = null;
    }
  }

  private async fillInPageOrFrame(
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
      console.warn(`[DO] Main frame fill failed for ${locator}:`, e);
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

  private async clickInPageOrFrame(
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
      console.warn(`[DO] Main frame click failed for ${locator}:`, e);
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

  private async locatorExists(
    page: Page,
    locator: string,
  ): Promise<boolean> {
    try {
      if ((await page.locator(locator).first().count()) > 0) return true;
    } catch {
      // Fall through to frames
    }

    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) continue;
      try {
        if ((await frame.locator(locator).first().count()) > 0) return true;
      } catch {
        // Next frame
      }
    }
    return false;
  }
}
