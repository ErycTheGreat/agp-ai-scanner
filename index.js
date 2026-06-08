import puppeteer from "@cloudflare/puppeteer";

async function extractPayload(env) {
    console.log("Starting Asymmetric Ghost Payload Generation...");
    let browser; 

    try {
        browser = await puppeteer.launch(env.MYBROWSER);
        const page = await browser.newPage();
        
        console.log("Navigating to site...");
        // Navigation happens inside the coverage block below

        // ✅ EDIT: Fetch gstatic CSS and save to BOTH R2 and KV.
        //
        // WHY R2 (not KV inline):
        // Inlining 198 KiB into the HTML document inflates the payload to ~250 KB.
        // On slow 4G (1.6 Mbps), the browser can't render a single pixel until it
        // downloads ALL 250 KB — locking FCP/LCP/SI to ~4.1s regardless of whether
        // the CSS came from KV or a live fetch. Moving to an external file lets the
        // browser download HTML (~50 KB) and CSS (~198 KB) in parallel.
        //
        // WHY also KV (sentinel flag):
        // The worker can't check R2 existence without a blocking await.
        // KV "GSTATIC_CSS" being non-empty means the R2 file is populated and safe
        // to reference. On first deploy before scanner runs, KV is empty → worker
        // falls back to defer (no crash, slightly slower until scanner populates it).
        try {
            // ✅ FIX 1: Use Chrome Coverage API to extract ONLY the CSS rules
            // that are actually used during first paint — instead of saving the
            // full 182 KiB file where 179 KiB is unused.
            // Target: ~5-15 KiB critical CSS vs 182 KiB full CSS.
            // This eliminates the render-blocking 2,700ms download on slow 4G.
            await page.coverage.startCSSCoverage();

            // Re-navigate so coverage captures the actual first-paint CSS usage
            await page.goto("https://www.eryc.my.id/");
            await new Promise(r => setTimeout(r, 3000));

            const cssCoverage = await page.coverage.stopCSSCoverage();

            // Extract only the used ranges from gstatic stylesheet
            const gstaticEntries = cssCoverage.filter(entry =>
                entry.url.includes('gstatic.com')
            );

            let criticalCss = "";
            for (const entry of gstaticEntries) {
                for (const range of entry.ranges) {
                    criticalCss += entry.text.slice(range.start, range.end) + "\n";
                }
            }

            if (criticalCss.length > 100) {
                console.log(`Critical CSS extracted: ${criticalCss.length} bytes (from full gstatic CSS)`);

                // Save to R2
                await env.MY_ASSETS.put("css/gstatic-cache.css", criticalCss, {
                    httpMetadata: { contentType: "text/css" }
                });
                console.log("Critical CSS saved to R2 at css/gstatic-cache.css");

                // Sentinel flag in KV
                await env.AGP_STATE.put("GSTATIC_CSS", "ready");
                console.log("GSTATIC_CSS sentinel saved to KV.");
            } else {
                console.log("No gstatic CSS coverage found — skipping R2 save.");
            }
        } catch (gstaticErr) {
            console.error("Failed to extract critical CSS:", gstaticErr);
        }
        
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

        const systemPrompt = `You are a strict data parser. Read the HTML and extract the main image URL and background color. 
        You MUST respond with ONLY this exact JSON format. No other words.
        {"lcpUrl": "insert_url_here", "bgColor": "insert_color_here"}`;

        console.log("Sending Cleaned DOM to AI...");
        
        const aiResponse = await env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
            messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: cleanHTML }
            ]
        });

        let rawText = aiResponse.response || "";
        console.log("Raw AI Output:", rawText); 
        
        let parsedData = { lcpUrl: "", bgColor: "#020617" }; 
        
        try {
            rawText = rawText.replace(/```json/gi, "").replace(/```/g, "").trim();
            const firstBrace = rawText.indexOf("{");
            const lastBrace = rawText.lastIndexOf("}");
            
            if (firstBrace !== -1 && lastBrace !== -1) {
                const cleanJsonString = rawText.substring(firstBrace, lastBrace + 1);
                const aiData = JSON.parse(cleanJsonString);
                
                if (aiData.lcpUrl && 
                    aiData.lcpUrl.startsWith("http") && 
                    aiData.lcpUrl.includes("www.eryc.my.id") &&
                    !aiData.lcpUrl.includes("lh3.googleusercontent.com") &&
                    !aiData.lcpUrl.includes("googleusercontent.com")) {
                    parsedData.lcpUrl = aiData.lcpUrl;
                }
                if (aiData.bgColor) parsedData.bgColor = aiData.bgColor;
            } else {
                console.error("AI returned text without JSON. Using fallback defaults.");
            }
        } catch (parseError) {
            console.error("Failed to parse AI JSON. Using fallback defaults.");
        }
            
        // Always hardcode hero.avif — prevents scanner from writing heavy AVIF
        // URL to KV after Engine 2 fires the swap during Puppeteer visit
        await env.AGP_STATE.put("LCP_IMAGE_URL", "/assets/image/hero.avif");
        console.log("LCP_IMAGE_URL saved: /assets/image/hero.avif (hardcoded)");

        // GHOST_CSS: target `html` not `body` to avoid overriding edge-anti-flash
        const safeCss = `html { background-color: #060522 !important; } .ghost-skeleton { width: 100vw; height: 100vh; background-color: #060522; }`;
        await env.AGP_STATE.put("GHOST_CSS", safeCss);
        console.log("GHOST_CSS saved (hardcoded #060522, targets html only)");
        
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
    try {
        await extractPayload(env);
        return new Response("AI Scanner executed! Check your KV Database.", { status: 200 });
    } catch (e) {
        return new Response("AI Scanner Failed. Error: " + e.message, { status: 500 });
    }
  }
};
