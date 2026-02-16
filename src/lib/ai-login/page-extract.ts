/**
 * DOM walker for page context extraction.
 *
 * This function is serialized and sent to the browser via page.evaluate().
 * It's extracted here so both the BrowserBase provider (running in Next.js)
 * and the Cloudflare DO (running in a Worker) can share the same logic.
 *
 * The walker recursively traverses the DOM, keeping only attributes useful
 * for Playwright locator generation. Shadow DOM boundaries are crossed so
 * enterprise SSO widgets aren't missed.
 */

/** Maximum HTML length returned to the LLM. */
export const MAX_HTML_LENGTH = 100_000;

/**
 * Browser-side function that extracts stripped HTML from document.body.
 * Passed to page.evaluate() — must be self-contained (no closures).
 */
export const extractBodyHTML = () => {
  function extractHTML(node: Node): string {
    if (node.nodeType === 3) return node.textContent?.trim() || "";
    if (node.nodeType !== 1) return "";

    const el = node as Element;
    const styles = window.getComputedStyle(el);
    if (styles.display === "none" || styles.visibility === "hidden") return "";

    const exclude = ["SCRIPT", "STYLE", "svg", "IMG", "NOSCRIPT", "LINK"];
    if (exclude.includes(el.tagName)) return "";

    const root = el.shadowRoot || el;
    let html = `<${el.tagName.toLowerCase()}`;

    for (const attr of el.attributes) {
      if (
        [
          "id",
          "class",
          "type",
          "name",
          "placeholder",
          "role",
          "aria-label",
        ].includes(attr.name)
      ) {
        html += ` ${attr.name}="${attr.value}"`;
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

    html += `</${el.tagName.toLowerCase()}>`;
    return html;
  }
  return extractHTML(document.body);
};
