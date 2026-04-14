import puppeteer from "@cloudflare/puppeteer";

async function extractPayload(env) {
    console.log("Starting Asymmetric Ghost Payload Generation...");
    let browser; 

    try {
        browser = await puppeteer.launch(env.MYBROWSER);
        const page = await browser.newPage();
        
        console.log("Navigating to site...");
        await page.goto("https://sites.google.com/view/eryc-tri-juni-s-notes/");
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

        // 🚨 THE IRONCLAD PROMPT: Forcing the AI to use an exact template
        const systemPrompt = `You are a strict data parser. Read the HTML and extract the main image URL and background color. 
        You MUST respond with ONLY this exact JSON format. No other words.
        {"lcpUrl": "insert_url_here", "bgColor": "insert_color_here"}`;

        console.log("Sending Cleaned DOM to Llama 3...");
        const aiResponse = await env.AI.run('@cf/meta/llama-3-8b-instruct', {
            messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: cleanHTML }
            ]
        });

        let rawText = aiResponse.response || "";
        console.log("Raw AI Output:", rawText); // We can read this in the logs later!
        
        // 🚨 THE GRACEFUL FALLBACK: If AI fails, use safe defaults instead of crashing
        let parsedData = { lcpUrl: "", bgColor: "#020617" }; 
        
        try {
            rawText = rawText.replace(/```json/gi, "").replace(/```/g, "").trim();
            const firstBrace = rawText.indexOf("{");
            const lastBrace = rawText.lastIndexOf("}");
            
            if (firstBrace !== -1 && lastBrace !== -1) {
                const cleanJsonString = rawText.substring(firstBrace, lastBrace + 1);
                const aiData = JSON.parse(cleanJsonString);
                
                if (aiData.lcpUrl && aiData.lcpUrl.startsWith("http")) parsedData.lcpUrl = aiData.lcpUrl;
                if (aiData.bgColor) parsedData.bgColor = aiData.bgColor;
            } else {
                console.error("AI returned text without JSON. Using fallback defaults.");
            }
        } catch (parseError) {
            console.error("Failed to parse AI JSON. Using fallback defaults.");
        }
            
        // 1. Save the Image to KV
        if (parsedData.lcpUrl) {
            await env.AGP_STATE.put("LCP_IMAGE_URL", parsedData.lcpUrl);
        } else {
            // Default to your known hero image if AI fails to find one
            await env.AGP_STATE.put("LCP_IMAGE_URL", "https://www.eryc.my.id/assets/image/hero.avif");
        }

        // 2. Build the CSS and save to KV
        const safeCss = `body { background-color: ${parsedData.bgColor} !important; } .ghost-skeleton { width: 100vw; height: 100vh; background-color: ${parsedData.bgColor}; }`;
        await env.AGP_STATE.put("GHOST_CSS", safeCss);
        
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
