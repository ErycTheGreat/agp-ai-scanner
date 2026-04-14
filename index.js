import puppeteer from "@cloudflare/puppeteer";

// 1. The Core AI Logic (Now with DOM Pruning)
async function extractPayload(env) {
    console.log("Starting Asymmetric Ghost Payload Generation...");
    
    const browser = await puppeteer.launch(env.MYBROWSER);
    const page = await browser.newPage();
    
    await page.goto("https://sites.google.com/view/eryc-tri-juni-s-notes/");
    await page.waitForNetworkIdle(); 
    
    // 🚨 THE FIX: PRUNE THE HTML BLOAT BEFORE EXTRACTING
    const cleanHTML = await page.evaluate(() => {
        // 1. Nuke scripts, styles, svgs, iframes, and noscript tags
        document.querySelectorAll('script, style, svg, path, symbol, iframe, noscript').forEach(e => e.remove());
        // 2. Nuke massive Google Sites JSON data blobs
        document.querySelectorAll('div[data-code]').forEach(e => e.remove());
        
        // 3. Return only the top section of the body where the LCP lives, strictly capped at 20,000 characters (~5,000 tokens)
        return document.body.innerHTML.substring(0, 20000);
    });
    
    await browser.close();

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
        { role: "user", content: cleanHTML } // <--- Passing the pruned HTML
        ]
    });

    // 🚨 THE JSON EXTRACTOR: Bulletproof parsing
    let parsedData = {};
    try {
        let rawText = aiResponse.response;
        console.log("Raw AI Output:", rawText); // Prints to logs so we can see what it actually said
        
        // 1. Strip markdown backticks if Llama hallucinated them
        rawText = rawText.replace(/```json/gi, "").replace(/```/g, "").trim();
        
        // 2. Find the exact start and end of the JSON object
        const firstBrace = rawText.indexOf("{");
        const lastBrace = rawText.lastIndexOf("}");
        
        if (firstBrace === -1 || lastBrace === -1) {
            throw new Error("No JSON brackets found in the response.");
        }
        
        // 3. Cut out just the pure JSON string and parse it
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
  
  // 🚨 3. THE MANUAL OVERRIDE (Runs when you click the worker link)
  async fetch(request, env, ctx) {
    try {
        await extractPayload(env);
        return new Response("AI Scanner executed successfully! Go check your KV Database.", { status: 200 });
    } catch (error) {
        // If it fails, it will print the exact error on your screen!
        return new Response("AI Scanner Failed. Error: " + error.message, { status: 500 });
    }
  }
};
