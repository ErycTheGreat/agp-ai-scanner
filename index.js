import puppeteer from "@cloudflare/puppeteer";

async function extractPayload(env) {
    console.log("Starting Asymmetric Ghost Payload Generation...");
    let browser; 

    try {
        browser = await puppeteer.launch(env.MYBROWSER);
        const page = await browser.newPage();
        
        console.log("Navigating to site...");
        await page.goto("https://www.eryc.my.id/");
        await new Promise(r => setTimeout(r, 3000));

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
            const gstaticHref = await page.evaluate(() => {
                const link = document.querySelector('link[rel="stylesheet"][href*="gstatic.com"]');
                return link ? link.href : null;
            });

            if (gstaticHref) {
                console.log("Found gstatic CSS href:", gstaticHref);
                const cssRes = await fetch(gstaticHref);

                if (cssRes.ok) {
                    const cssText = await cssRes.text();

                    // 1. Save to R2 — served as external CSS file via asset proxy
                    await env.MY_ASSETS.put("css/gstatic-cache.css", cssText, {
                        httpMetadata: { contentType: "text/css" }
                    });
                    console.log("GSTATIC CSS saved to R2 at css/gstatic-cache.css. Length:", cssText.length);

                    // 2. Save sentinel to KV — worker reads this to know R2 file exists
                    // Store a short flag, not the full CSS (no need to inline anymore)
                    await env.AGP_STATE.put("GSTATIC_CSS", "ready");
                    console.log("GSTATIC_CSS sentinel saved to KV.");
                }
            } else {
                console.log("No gstatic CSS link found on page.");
            }
        } catch (gstaticErr) {
            console.error("Failed to cache gstatic CSS:", gstaticErr);
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
