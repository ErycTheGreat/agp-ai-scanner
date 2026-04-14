import puppeteer from "@cloudflare/puppeteer";

// 1. The Core AI Logic
async function extractPayload(env) {
    console.log("Starting Asymmetric Ghost Payload Generation...");
    
    const browser = await puppeteer.launch(env.MYBROWSER);
    const page = await browser.newPage();
    
    console.log("Navigating to site...");
    await page.goto("https://sites.google.com/view/eryc-tri-juni-s-notes/");
    
    // 🚨 FIX 1: THE HARD WAIT. Google Sites is notoriously slow to paint.
    // 'networkidle' sometimes fires too early. We force it to wait 3 extra seconds.
    await new Promise(r => setTimeout(r, 3000));
    
    // 🚨 FIX 2: PRUNE THE HTML BLOAT
    const cleanHTML = await page.evaluate(() => {
        document.querySelectorAll('script, style, svg, path, symbol, iframe, noscript').forEach(e => e.remove());
        document.querySelectorAll('div[data-code]').forEach(e => e.remove());
        // Added safety check in case document.body is missing
        return document.body ? document.body.innerHTML.substring(0, 15000) : "";
    });
    
    await browser.close();

    // 🚨 FIX 3: DIAGNOSTIC LOG. Let's see if the browser actually grabbed your site!
    console.log("Clean HTML Length grabbed by browser:", cleanHTML.length);
    
    if (cleanHTML.length < 100) {
        throw new Error("Puppeteer grabbed a blank page. Google Sites is loading too slowly.");
    }

    const systemPrompt = `You are an Edge SEO extraction tool. 
    Analyze the provided HTML. Output ONLY a valid JSON object. 
    Required keys: 
    "lcpUrl" (string, the absolute URL of the primary hero image), 
    "criticalCss" (string, a minified CSS string replicating the primary above-the-fold layout and background colors). 
    Do not include markdown formatting or explanations. Keep CSS under 500 characters.`;

    console.log("Sending Cleaned DOM to Llama 3...");
    const aiResponse = await env.AI.run('@cf/meta/llama-3-8b-instruct', {
        messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: cleanHTML }
        ]
    });

    // 🚨 FIX 4: BLANK RESPONSE CATCHER
    let rawText = aiResponse.response || "";
    console.log("Raw AI Output:", rawText);
    
    if (!rawText.trim()) {
        throw new Error("Llama-3 returned a completely blank response. The HTML might be confusing the model.");
    }

    // 🚨 FIX 5: BULLETPROOF JSON EXTRACTOR
    let parsedData = {};
    try {
        rawText = rawText.replace(/```json/gi, "").replace(/```/g, "").trim();
        const firstBrace = rawText.indexOf("{");
        const lastBrace = rawText.lastIndexOf("}");
        
        if (firstBrace === -1 || lastBrace === -1) {
            throw new Error("No JSON brackets found in the response.");
        }
        
        const cleanJsonString = rawText.substring(firstBrace, lastBrace + 1);
        parsedData = JSON.parse(cleanJsonString);
        
    } catch (parseError) {
        console.error("CRITICAL: AI failed to output valid JSON. See raw output above.");
        throw new Error("JSON Parsing failed. The AI output was malformed.");
    }
        
    // Validate LCP
    if (parsedData.lcpUrl && parsedData.lcpUrl.length < 500 && parsedData.lcpUrl.startsWith("http")) {
        await env.AGP_STATE.put("LCP_IMAGE_URL", parsedData.lcpUrl);
    }

    // Validate CSS
    let safeCss = "";
    if (parsedData.criticalCss) {
        if (parsedData.criticalCss.length > 1500) {
            safeCss = "body { background-color: #020617; } .ghost-skeleton { width: 100vw; height: 100vh; }";
        } else {
            safeCss = parsedData.criticalCss;
        }
    }

    if (safeCss) {
        await env.AGP_STATE.put("GHOST_CSS", safeCss);
    }
}

export default {
  // 2. The Standard Cron Trigger (Runs automatically in the background)
  async scheduled(event, env, ctx) {
    try {
        await extractPayload(env);
    } catch (error) {
        console.error("Cron AI Extraction Failed:", error);
    }
  },
  
  // 3. THE MANUAL OVERRIDE (Runs when you click the worker link)
  async fetch(request, env, ctx) {
    try {
        await extractPayload(env);
        return new Response("AI Scanner executed successfully! Go check your KV Database.", { status: 200 });
    } catch (error) {
        return new Response("AI Scanner Failed. Error: " + error.message, { status: 500 });
    }
  }
};
