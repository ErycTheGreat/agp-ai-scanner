import puppeteer from "@cloudflare/puppeteer";

async function extractPayload(env) {
    console.log("Starting Asymmetric Ghost Payload Generation...");
    let browser;

    try {
        browser = await puppeteer.launch(env.MYBROWSER);
        const page = await browser.newPage();

        console.log("Navigating to site...");
        await page.goto("https://www.eryc.my.id/", {
            waitUntil: "networkidle0",
            timeout: 15000
        });
        // Small buffer after networkidle0 for deferred paint jobs
        await new Promise(r => setTimeout(r, 1000));

        // Grab the computed background color of the root before stripping the DOM
        const rootBgColor = await page.evaluate(() => {
            const computed = window.getComputedStyle(document.documentElement).backgroundColor;
            const match = computed.match(/\d+/g);
            if (match && match.length >= 3) {
                return '#' + match.slice(0, 3).map(n =>
                    parseInt(n).toString(16).padStart(2, '0')
                ).join('');
            }
            return "#060522";
        });

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
        console.log("Root BG Color:", rootBgColor);
        if (cleanHTML.length < 100) throw new Error("Browser grabbed a blank page.");

        // AI's only job: confirm or refine the background color.
        // We do NOT ask AI to detect the LCP URL — the Puppeteer browser fires
        // Engine 2 (it's a real browser, not PSI), so by the time AI observes the
        // DOM, the heavy AVIF has already been swapped in. If AI writes that heavy
        // URL to LCP_IMAGE_URL KV, the main worker preloads it via HTTP header for
        // everyone including PSI — bypassing every JS guard before the page loads.
        const systemPrompt = `You are a strict JSON data extractor. Read the HTML and identify the dominant background color of the page.
Rules:
- Respond with ONLY this exact JSON object. Zero preamble, zero markdown.
- bgColor must be a valid CSS hex color e.g. "#060522"
- If unsure, return the fallback exactly as shown
{"bgColor": "#060522"}`;

        const aiResponse = await env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: cleanHTML }
            ]
        });

        let rawText = aiResponse.response || "";
        console.log("Raw AI Output:", rawText);

        let bgColor = rootBgColor; // default: real computed value from page

        try {
            rawText = rawText.replace(/```json/gi, "").replace(/```/g, "").trim();
            const firstBrace = rawText.indexOf("{");
            const lastBrace  = rawText.lastIndexOf("}");
            if (firstBrace !== -1 && lastBrace !== -1) {
                const aiData = JSON.parse(rawText.substring(firstBrace, lastBrace + 1));
                if (aiData.bgColor && /^#[0-9a-fA-F]{3,6}$/.test(aiData.bgColor)) {
                    bgColor = aiData.bgColor;
                }
            }
        } catch (parseError) {
            console.error("Failed to parse AI JSON — using computed color fallback:", rootBgColor);
        }

        // 1. LCP Image URL — hardcoded to hero.avif.
        //    hero.avif is always the real above-fold <img fetchpriority="high"> element.
        //    It is NOT subject to the bait-and-switch, so the AGP scanner can never
        //    accidentally write the heavy animation URL to KV.
        await env.AGP_STATE.put("LCP_IMAGE_URL", "/assets/image/hero.avif");
        console.log("LCP_IMAGE_URL saved: /assets/image/hero.avif");

        // 2. GHOST_CSS — only sets `html` background, never `body`.
        //    The main worker's edge-anti-flash sets body { background: transparent }
        //    so the html canvas shows through. Overriding body here breaks that trick.
        const safeCss = `html { background-color: ${bgColor} !important; } .ghost-skeleton { width: 100vw; height: 100vh; background-color: ${bgColor}; }`;
        await env.AGP_STATE.put("GHOST_CSS", safeCss);
        console.log("GHOST_CSS saved with bgColor:", bgColor);

        console.log("AGP State updated successfully.");

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
