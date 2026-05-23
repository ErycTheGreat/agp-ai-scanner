/* =============================================================================
 * AGP SCANNER — writes the "ceiling" state to KV (AGP_STATE)
 *
 * What changed vs. the old Llama-based scanner:
 *   - NO LLM. The old code launched real Chrome (which already KNOWS the LCP and
 *     which CSS rules are used), threw that away, mangled the DOM to 8000 chars,
 *     and asked Llama-3-8b to GUESS the LCP url + bg color. That's a hallucination
 *     risk feeding a top-priority preload header -> non-deterministic LCP poisoning.
 *   - GROUND TRUTH LCP: read the browser's own largest-contentful-paint entry.
 *   - REAL CRITICAL CSS: page.coverage records exactly which CSS rules were USED
 *     during render. That turns the ~195KB gstatic blob into the few KB that
 *     actually matter -> stored as GHOST_CSS (the "ceiling").
 *   - Scans the LIVE edge output (www.eryc.my.id), NOT the raw Google Sites URL,
 *     so the measurements match what PSI / real users actually get. Because the
 *     edge swaps the LCP element to the small poster, the measured LCP url is the
 *     poster -> the preload header becomes self-consistent automatically.
 *   - AUTH on the manual fetch trigger so nobody can spin up Chrome on your dime.
 *
 * Required bindings (wrangler.toml):
 *   browser   = { binding = "MYBROWSER" }       # Browser Rendering
 *   kv_namespaces: AGP_STATE
 *   vars/secrets: SCAN_SECRET                    # set via `wrangler secret put`
 * ============================================================================= */

import puppeteer from "@cloudflare/puppeteer";

const TARGET = "https://www.eryc.my.id/";                       // scan post-edge output
const FALLBACK_LCP = "https://www.eryc.my.id/assets/image/hero.avif";
const FALLBACK_CSS = "html{background:#060522}body{background:transparent}";
const MAX_CSS_BYTES = 60000;                                    // guard KV value size

async function extractPayload(env) {
  let browser;
  try {
    browser = await puppeteer.launch(env.MYBROWSER);
    const page = await browser.newPage();
    await page.setViewport({ width: 1366, height: 820 });       // desktop above-fold

    // Start CSS coverage BEFORE navigation. Gracefully degrade if unsupported.
    let coverageOn = true;
    try { await page.coverage.startCSSCoverage(); }
    catch (e) { coverageOn = false; console.warn("CSS coverage unsupported:", e.message); }

    console.log("Navigating to", TARGET);
    await page.goto(TARGET, { waitUntil: "networkidle0", timeout: 30000 });
    // Let deferred (media=print -> onload=all) stylesheets actually apply.
    await new Promise(r => setTimeout(r, 1500));

    // 1) GROUND-TRUTH LCP — ask the engine that computed it.
    const lcpUrl = await page.evaluate(() => new Promise((resolve) => {
      try {
        const obs = new PerformanceObserver((list) => {
          const entries = list.getEntries();
          const last = entries[entries.length - 1];
          if (last) {
            const url = last.url
              || (last.element && (last.element.currentSrc || last.element.src))
              || "";
            resolve(url);
          }
        });
        obs.observe({ type: "largest-contentful-paint", buffered: true });
        // LCP can keep changing; settle after a short window.
        setTimeout(() => resolve(""), 2000);
      } catch (e) { resolve(""); }
    }));
    console.log("Measured LCP url:", lcpUrl || "(none)");

    // 2) REAL CRITICAL CSS — only the rules Chrome actually used.
    let criticalCss = "";
    if (coverageOn) {
      try {
        const coverage = await page.coverage.stopCSSCoverage();
        for (const entry of coverage) {
          for (const range of entry.ranges) {
            criticalCss += entry.text.slice(range.start, range.end);
          }
        }
      } catch (e) {
        console.warn("stopCSSCoverage failed:", e.message);
        criticalCss = "";
      }
    }
    criticalCss = criticalCss.replace(/\s+/g, " ").trim();
    if (criticalCss.length > MAX_CSS_BYTES) {
      criticalCss = criticalCss.slice(0, MAX_CSS_BYTES);
      console.warn("Critical CSS truncated to", MAX_CSS_BYTES, "bytes");
    }
    console.log("Critical CSS bytes:", criticalCss.length);

    // 3) WRITE KV (the "ceiling"). Floor in the main worker covers any gaps.
    const finalLcp = (lcpUrl && lcpUrl.startsWith("http")) ? lcpUrl : FALLBACK_LCP;
    const finalCss = criticalCss.length > 50 ? criticalCss : FALLBACK_CSS;

    await env.AGP_STATE.put("LCP_IMAGE_URL", finalLcp);
    await env.AGP_STATE.put("GHOST_CSS", finalCss);
    console.log("AGP_STATE updated.");

    return { lcp: finalLcp, cssBytes: finalCss.length, usedFallbackCss: finalCss === FALLBACK_CSS };
  } finally {
    if (browser) {
      console.log("Closing browser session...");
      await browser.close();
    }
  }
}

export default {
  // Cron: refresh the ceiling on a schedule. Don't run too often — the CSS only
  // changes when the page design changes. Daily/weekly is plenty.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      extractPayload(env).catch((e) => console.error("Cron AGP failed:", e))
    );
  },

  // Manual trigger — AUTH REQUIRED. Call: https://<scanner>/?key=YOUR_SECRET
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const provided = url.searchParams.get("key");
    if (!env.SCAN_SECRET || provided !== env.SCAN_SECRET) {
      // Without this, anyone hitting the URL spins up Chrome and burns your quota.
      return new Response("Forbidden", { status: 403 });
    }
    try {
      const result = await extractPayload(env);
      return new Response("AGP scan OK: " + JSON.stringify(result), {
        status: 200, headers: { "Content-Type": "text/plain" }
      });
    } catch (e) {
      return new Response("AGP scan failed: " + e.message, { status: 500 });
    }
  }
};
