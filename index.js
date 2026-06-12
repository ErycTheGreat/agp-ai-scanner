import puppeteer from "@cloudflare/puppeteer";

// ─────────────────────────────────────────────────────────────────────────────
// Model list — primary first, fallback second.
// Both are active as of June 2026. Update here if Cloudflare deprecates again.
// ─────────────────────────────────────────────────────────────────────────────
const AI_MODELS = [
    '@cf/zai-org/glm-4.7-flash',         // Cloudflare's recommended fast model
    '@cf/meta/llama-3.1-8b-instruct-fp8' // Backup — still active, no deprecated tag
];

async function runAI(env, messages) {
    for (const model of AI_MODELS) {
        try {
            console.log(`Trying AI model: ${model}`);
            const response = await env.AI.run(model, { messages });
            console.log(`AI model succeeded: ${model}`);
            return response;
        } catch (e) {
            console.error(`Model ${model} failed: ${e.message}`);
        }
    }
    throw new Error("All AI models failed — check Workers AI model catalog for active models.");
}

async function extractPayload(env) {
    console.log("Starting Asymmetric Ghost Payload Generation...");
    let browser;

    try {
        browser = await puppeteer.launch(env.MYBROWSER);
        const page = await browser.newPage();

        // =================================================================
        // STEP 1: Get original gstatic URL via bot debug path
        //
        // WHY ?debug=bot:
        // The main worker's human fast-lane transforms link[rel="stylesheet"]
        // pointing to gstatic.com → our R2 URL. The bot path has no stylesheet
        // handler, so it exposes the original gstatic.com URL intact.
        // This lets us fetch the full CSS directly without going through our
        // own worker's R2 proxy.
        // =================================================================
        console.log("Step 1: Getting original gstatic URL via bot path...");
        await page.goto("https://www.eryc.my.id/?debug=bot");

        const gstaticHref = await page.evaluate(() => {
            const link = document.querySelector('link[rel="stylesheet"][href*="gstatic.com"]');
            return link ? link.href : null;
        });

        console.log("gstatic href found:", gstaticHref);

        if (gstaticHref) {
            // =============================================================
            // STEP 2: Fetch full CSS directly from gstatic and save to R2
            //
            // This guarantees R2 always has valid CSS as a baseline.
            // Even if critical CSS extraction fails later, the page works.
            // =============================================================
            console.log("Step 2: Fetching full CSS from gstatic...");
            const fullCssRes = await fetch(gstaticHref);

            if (fullCssRes.ok) {
                const fullCssText = await fullCssRes.text();
                console.log("Full CSS fetched:", fullCssText.length, "bytes");

                // Save full CSS to R2 as baseline
                await env.MY_ASSETS.put("css/gstatic-cache.css", fullCssText, {
                    httpMetadata: { contentType: "text/css" }
                });
                await env.AGP_STATE.put("GSTATIC_CSS", "ready");
                console.log("Full CSS saved to R2 as baseline.");

                // ==========================================================
                // STEP 3: Coverage pass on the normal page
                //
                // R2 now has valid CSS, so the worker serves it from
                // /assets/css/gstatic-cache.css. Coverage captures which
                // rules from THAT URL are actually used during first paint.
                // Filter matches our R2 URL (not gstatic.com) because the
                // worker already transformed it.
                // ==========================================================
                // KEY INSIGHT (from Lighthouse source code):
                // Lighthouse stops CSS coverage at FCP time, not after a delay.
                // Waiting 3s lets Google Sites initialize fully → 100% CSS marked
                // "used" → 1.56 MB captured (useless).
                // Stopping at FCP captures only rules needed for initial render
                // → target 2-30 KiB critical CSS.
                //
                // STRATEGY:
                // - Critical CSS → inline in HTML via KV (tiny, no render-block)
                // - Full CSS in R2 → deferred with media=print (non-render-blocking)
                // - No CLS because critical CSS handles above-fold layout inline
                console.log("Step 3: Running FCP-timed coverage pass...");
                await page.coverage.startCSSCoverage();
                await page.goto("https://www.eryc.my.id/");

                // Stop at FCP — same methodology Lighthouse uses
                await page.evaluate(() => new Promise((resolve) => {
                    const observer = new PerformanceObserver((list) => {
                        if (list.getEntries().find(e => e.name === 'first-contentful-paint')) {
                            observer.disconnect();
                            resolve();
                        }
                    });
                    observer.observe({ type: 'paint', buffered: true });
                    // Safety timeout: if FCP never fires within 8s, stop anyway
                    setTimeout(resolve, 8000);
                }));

                const cssCoverage = await page.coverage.stopCSSCoverage();

                // Match our R2 URL OR original gstatic URL (handles both states)
                const cssEntry = cssCoverage.find(entry =>
                    entry.url.includes('gstatic-cache.css') ||
                    entry.url.includes('gstatic.com')
                );

                if (cssEntry && cssEntry.ranges.length > 0) {
                    const criticalCss = cssEntry.ranges
                        .map(range => cssEntry.text.slice(range.start, range.end))
                        .join('\n');

                    console.log(`Critical CSS extracted: ${criticalCss.length} bytes (from ${fullCssText.length} bytes)`);

                    if (criticalCss.length > 100 && criticalCss.length < 50000) {
                        // Small enough to inline — save to KV for HTML injection
                        await env.AGP_STATE.put("CRITICAL_CSS", criticalCss);
                        console.log("Critical CSS saved to KV for inlining.");
                        // Full CSS stays in R2 for deferred (non-blocking) load
                    } else if (criticalCss.length >= 50000) {
                        console.log("Critical CSS still too large — FCP fired late. Keeping full CSS strategy.");
                        await env.AGP_STATE.put("CRITICAL_CSS", "");
                    } else {
                        console.log("Critical CSS too small — may be empty. Keeping full CSS strategy.");
                        await env.AGP_STATE.put("CRITICAL_CSS", "");
                    }
                } else {
                    console.log("No CSS coverage entries found — keeping full CSS in R2.");
                    await env.AGP_STATE.put("CRITICAL_CSS", "");
                }
            } else {
                console.log("Failed to fetch gstatic CSS, status:", fullCssRes.status);
            }
        } else {
            console.log("No gstatic link found on bot path — Google Sites may have changed.");
        }

        // =================================================================
        // STEP 4: Navigate normal page for AGP DOM payload
        // =================================================================
        console.log("Step 4: Navigating for AGP DOM payload...");
        await page.goto("https://www.eryc.my.id/");
        await new Promise(r => setTimeout(r, 3000));

        const cleanHTML = await page.evaluate(() => {
            document.querySelectorAll('script, style, svg, path, symbol, iframe, noscript').forEach(e => e.remove());
            document.querySelectorAll('div[data-code]').forEach(e => e.remove());
            const elements = document.body.getElementsByTagName('*');
            for (let i = 0; i < elements.length; i++) {
                elements[i].removeAttribute('class');
                elements[i].removeAttribute('id');
                elements[i].removeAttribute('jsname');
                elements[i].removeAttribute('jsaction');
            }
            return document.body ? document.body.innerHTML.substring(0, 8000) : "";
        });

        console.log("Clean HTML Length:", cleanHTML.length);
        if (cleanHTML.length < 100) throw new Error("Browser grabbed a blank page.");

        // =================================================================
        // STEP 5: AI extraction with automatic model fallback
        // =================================================================
        console.log("Step 5: Running AI extraction...");

        const systemPrompt = `You are a strict data parser. Read the HTML and extract the main image URL and background color. 
You MUST respond with ONLY this exact JSON format. No other words.
{"lcpUrl": "insert_url_here", "bgColor": "insert_color_here"}`;

        const aiResponse = await runAI(env, [
            { role: "system", content: systemPrompt },
            { role: "user", content: cleanHTML }
        ]);

        let rawText = aiResponse.response || "";
        console.log("Raw AI Output:", rawText);

        let parsedData = { lcpUrl: "", bgColor: "#020617" };

        try {
            rawText = rawText.replace(/```json/gi, "").replace(/```/g, "").trim();
            const firstBrace = rawText.indexOf("{");
            const lastBrace = rawText.lastIndexOf("}");
            if (firstBrace !== -1 && lastBrace !== -1) {
                const aiData = JSON.parse(rawText.substring(firstBrace, lastBrace + 1));
                if (aiData.lcpUrl &&
                    aiData.lcpUrl.startsWith("http") &&
                    aiData.lcpUrl.includes("www.eryc.my.id") &&
                    !aiData.lcpUrl.includes("googleusercontent.com")) {
                    parsedData.lcpUrl = aiData.lcpUrl;
                }
                if (aiData.bgColor) parsedData.bgColor = aiData.bgColor;
            }
        } catch (parseError) {
            console.error("Failed to parse AI JSON. Using fallback defaults.");
        }

        // Always hardcode hero.avif — prevents scanner writing heavy AVIF URL to KV
        await env.AGP_STATE.put("LCP_IMAGE_URL", "/assets/image/hero.avif");
        console.log("LCP_IMAGE_URL saved: /assets/image/hero.avif");

        // GHOST_CSS targets html not body — avoids overriding edge-anti-flash transparent body
        const safeCss = `html { background-color: #060522 !important; } .ghost-skeleton { width: 100vw; height: 100vh; background-color: #060522; }`;
        await env.AGP_STATE.put("GHOST_CSS", safeCss);
        console.log("GHOST_CSS saved.");

        console.log("AGP State Updated Successfully.");

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
        try {
            await extractPayload(env);
            return new Response("AI Scanner executed! Check your KV and R2.", { status: 200 });
        } catch (e) {
            return new Response("AI Scanner Failed. Error: " + e.message, { status: 500 });
        }
    }
};
