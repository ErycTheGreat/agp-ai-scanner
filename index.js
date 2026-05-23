import puppeteer from "@cloudflare/puppeteer";

// We scan the RAW Google Sites page: there gstatic CSS is render-blocking and
// fully applied, so coverage capture is reliable. The served page uses the SAME
// structural CSS, so the used-rule set transfers cleanly.
const TARGET_URL = "https://sites.google.com/view/eryc-tri-juni-s-notes/";

// The main worker deterministically swaps the LCP background to this poster,
// so the preload target is a CONSTANT WE CONTROL. No model needs to guess it.
// (If your real LCP element is the hero instead, change this to hero.avif.)
const KNOWN_LCP_POSTER = "https://www.eryc.my.id/assets/image/homepage-BG-split.avif";

async function extractPayload(env) {
    console.log("Starting Asymmetric Ghost Payload Generation...");
    let browser;

    try {
        browser = await puppeteer.launch(env.MYBROWSER);
        const page = await browser.newPage();
        await page.setViewport({ width: 1366, height: 900 });

        // 1. Ask the ENGINE which CSS rules it actually uses (ground truth),
        //    instead of asking an LLM to guess from mangled HTML.
        let coverageSupported = true;
        try {
            await page.coverage.startCSSCoverage();
        } catch (e) {
            coverageSupported = false;
            console.error("CSS coverage unavailable in this runtime:", e.message);
        }

        console.log("Navigating to site...");
        await page.goto(TARGET_URL, { waitUntil: "networkidle0", timeout: 30000 });
        await new Promise(r => setTimeout(r, 1500)); // settle render

        // 2. Build the critical CSS from the rules Chrome actually applied.
        let criticalCss = "";
        if (coverageSupported) {
            try {
                const coverage = await page.coverage.stopCSSCoverage();
                for (const entry of coverage) {
                    for (const range of entry.ranges) {
                        criticalCss += entry.text.slice(range.start, range.end);
                    }
                }
                criticalCss = criticalCss.trim();
            } catch (e) {
                console.error("Failed reading CSS coverage:", e.message);
            }
        }

        console.log("Critical CSS length:", criticalCss.length);

        // 3. THE GRACEFUL FALLBACK: only overwrite GHOST_CSS if we captured
        //    something real, so a bad run never wipes a known-good ceiling.
        if (criticalCss.length > 50) {
            await env.AGP_STATE.put("GHOST_CSS", criticalCss);
            console.log("GHOST_CSS updated in KV.");
        } else {
            console.error("Critical CSS too small; keeping previous GHOST_CSS.");
        }

        // 4. LCP preload target is the poster the worker injects — deterministic.
        await env.AGP_STATE.put("LCP_IMAGE_URL", KNOWN_LCP_POSTER);

        console.log("AGP State Updated Successfully in KV.");

    } finally {
        if (browser) {
            console.log("Closing browser session...");
            await browser.close();
        }
    }
}

export default {
  async scheduled(event, env, ctx) {
    try { await extractPayload(env); } catch (e) { console.error("Cron AI Failed:", e); }
  },
  async fetch(request, env, ctx) {
    // Guard the manual trigger so a random crawler can't spin up Chrome on every
    // hit and burn your Browser Rendering quota. Set SCAN_SECRET in the dashboard,
    // then trigger via /?key=YOUR_SECRET. If SCAN_SECRET is unset, behaviour is
    // unchanged (open trigger).
    if (env.SCAN_SECRET) {
        const key = new URL(request.url).searchParams.get("key");
        if (key !== env.SCAN_SECRET) {
            return new Response("Forbidden", { status: 403 });
        }
    }
    try {
        await extractPayload(env);
        return new Response("AI Scanner executed! Check your KV Database.", { status: 200 });
    } catch (e) {
        return new Response("AI Scanner Failed. Error: " + e.message, { status: 500 });
    }
  }
};
