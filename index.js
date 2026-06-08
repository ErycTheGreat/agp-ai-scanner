import puppeteer from "@cloudflare/puppeteer";

async function extractPayload(env) {
    console.log("Starting Asymmetric Ghost Payload Generation...");
    let browser;

    try {
        browser = await puppeteer.launch(env.MYBROWSER);
        const page = await browser.newPage();

        console.log("Navigating to site...");
        await page.goto("https://www.eryc.my.id/", {
            // 🔒 FIX #2: Wait for network to go quiet instead of a fixed 3s timer.
            // This prevents scraping a half-hydrated Google Sites DOM.
            waitUntil: "networkidle0",
            timeout: 15000
        });

        // Small buffer after networkidle0 for any deferred paint jobs
        await new Promise(r => setTimeout(r, 1000));

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

        // Also grab the computed background color of the root element for GHOST_CSS
        const rootBgColor = await page.evaluate(() => {
            const htmlEl = document.documentElement;
            const computed = window.getComputedStyle(htmlEl).backgroundColor;
            // Convert rgb(...) to hex for KV storage
            const match = computed.match(/\d+/g);
            if (match && match.length >= 3) {
                const hex = '#' + match.slice(0, 3).map(n =>
                    parseInt(n).toString(16).padStart(2, '0')
                ).join('');
                return hex;
            }
            return "#060522"; // safe fallback matching edge-anti-flash
        });

        console.log("Clean HTML Length:", cleanHTML.length);
        console.log("Root BG Color:", rootBgColor);
        if (cleanHTML.length < 100) throw new Error("Browser grabbed a blank page.");

        // 🔒 WHY NO AI URL DETECTION:
        // The Puppeteer browser is a real browser — it passes all Engine 2 guards,
        // so triggerBg() fires and swaps data-heavy-bg into background-image.
        // The AI then sees the heavy AVIF (homepage-BG.avif) as the prominent image
        // and writes it to LCP_IMAGE_URL KV. The main worker then preloads that
        // heavy URL via HTTP header for ALL visitors including PSI — bypassing every
        // client-side guard. So we never ask AI to detect the LCP URL.
        const systemPrompt = `You are a strict JSON data extractor. Read the HTML and find the computed background-color of the page root.
Rules:
- Respond with ONLY this exact JSON object. No preamble, no markdown, no explanation.
- bgColor must be a valid CSS hex color like "#060522"
- If unsure, use "#060522"
{"bgColor": "#060522"}`;

        console.log("Sending Cleaned DOM to AI for bgColor only...");

        const aiResponse = await env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: cleanHTML }
            ]
        });

        let rawText = aiResponse.response || "";
        console.log("Raw AI Output:", rawText);

        // Graceful fallback
        let parsedData = {
            bgColor: rootBgColor
        };

        try {
            rawText = rawText.replace(/```json/gi, "").replace(/```/g, "").trim();
            const firstBrace = rawText.indexOf("{");
            const lastBrace = rawText.lastIndexOf("}");

            if (firstBrace !== -1 && lastBrace !== -1) {
                const cleanJsonString = rawText.substring(firstBrace, lastBrace + 1);
                const aiData = JSON.parse(cleanJsonString);
                if (aiData.bgColor && /^#[0-9a-fA-F]{3,6}$/.test(aiData.bgColor)) {
                    parsedData.bgColor = aiData.bgColor;
                }
            } else {
                console.error("AI returned text without JSON. Using computed color fallback.");
            }
        } catch (parseError) {
            console.error("Failed to parse AI JSON. Using computed color fallback.");
        }

        // 1. Save LCP Image URL — hardcoded to hero.avif (always above-fold, always an <img>)
        // This is the real LCP candidate PSI measures, not the CSS background swap.
        await env.AGP_STATE.put("LCP_IMAGE_URL", "/assets/image/hero.avif");
        console.log("LCP URL saved: /assets/image/hero.avif (hardcoded, swap-safe)");

        // 2. Build and save GHOST_CSS
        // 🔒 FIX #1 (css): Only set `html` background — never `body`.
        // The main worker's edge-anti-flash deliberately sets body to transparent
        // so the html canvas color shows through. Overriding body here breaks that
        // trick and causes a color mismatch flash.
        const safeCss = `
            html { background-color: ${parsedData.bgColor} !important; }
            .ghost-skeleton { width: 100vw; height: 100vh; background-color: ${parsedData.bgColor}; }
        `.trim();

        await env.AGP_STATE.put("GHOST_CSS", safeCss);
        console.log("GHOST_CSS saved with bgColor:", parsedData.bgColor);

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
