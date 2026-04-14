import puppeteer from "@cloudflare/puppeteer";

async function extractPayload(env) {
    console.log("Starting Asymmetric Ghost Payload Generation...");
    let browser; // Declare outside the try block so 'finally' can access it

    try {
        browser = await puppeteer.launch(env.MYBROWSER);
        const page = await browser.newPage();
        
        console.log("Navigating to site...");
        await page.goto("https://sites.google.com/view/eryc-tri-juni-s-notes/");
        await new Promise(r => setTimeout(r, 3000));
        
        // 🚨 EXTREME PRUNING: Strip the Google Gibberish
        const cleanHTML = await page.evaluate(() => {
            document.querySelectorAll('script, style, svg, path, symbol, iframe, noscript').forEach(e => e.remove());
            document.querySelectorAll('div[data-code]').forEach(e => e.remove());
            
            // Strip all class names and IDs to save massive amounts of tokens
            const elements = document.body.getElementsByTagName('*');
            for (let i = 0; i < elements.length; i++) {
                elements[i].removeAttribute('class');
                elements[i].removeAttribute('id');
                elements[i].removeAttribute('jsname');
                elements[i].removeAttribute('jsaction');
            }
            // Cut it down to a tiny 8,000 characters
            return document.body ? document.body.innerHTML.substring(0, 8000) : "";
        });

        console.log("Clean HTML Length:", cleanHTML.length);
        if (cleanHTML.length < 100) throw new Error("Browser grabbed a blank page.");

        // 🚨 SIMPLIFIED PROMPT: Just get the color and image!
        const systemPrompt = `Analyze the HTML. Output ONLY a valid JSON object. 
        Required keys: 
        "lcpUrl" (string, the URL of the largest hero image or profile picture). 
        "bgColor" (string, the primary background color hex code, default to "#020617" if unsure). 
        Do not include markdown or explanations. Just raw JSON.`;

        console.log("Sending Cleaned DOM to Llama 3...");
        const aiResponse = await env.AI.run('@cf/meta/llama-3-8b-instruct', {
            messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: cleanHTML }
            ]
        });

        let rawText = aiResponse.response || "";
        console.log("Raw AI Output:", rawText);
        
        if (!rawText.trim()) throw new Error("AI returned a blank response.");

        // Extract JSON
        rawText = rawText.replace(/```json/gi, "").replace(/```/g, "").trim();
        const firstBrace = rawText.indexOf("{");
        const lastBrace = rawText.lastIndexOf("}");
        if (firstBrace === -1 || lastBrace === -1) throw new Error("No JSON brackets found.");
        
        const parsedData = JSON.parse(rawText.substring(firstBrace, lastBrace + 1));
            
        // 1. Save the Image
        if (parsedData.lcpUrl && parsedData.lcpUrl.length < 500 && parsedData.lcpUrl.startsWith("http")) {
            await env.AGP_STATE.put("LCP_IMAGE_URL", parsedData.lcpUrl);
        }

        // 2. Build the CSS Manually (No AI hallucinations possible here!)
        const bgColor = parsedData.bgColor || "#020617";
        const safeCss = `body { background-color: ${bgColor} !important; } .ghost-skeleton { width: 100vw; height: 100vh; background-color: ${bgColor}; }`;
        
        await env.AGP_STATE.put("GHOST_CSS", safeCss);
        console.log("AGP State Updated Successfully in KV.");

    } finally {
        // 🚨 THE SESSION FIX: Always close the browser, even if it crashes
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
        return new Response("AI Scanner executed successfully! Check KV.", { status: 200 });
    } catch (e) {
        return new Response("AI Scanner Failed. Error: " + e.message, { status: 500 });
    }
  }
};
