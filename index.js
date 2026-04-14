import puppeteer from "@cloudflare/puppeteer";

export default {
  // Notice there is no fetch() here. It ONLY runs on a schedule.
  async scheduled(event, env, ctx) {
    console.log("Starting Asymmetric Ghost Payload Generation...");

    try {
        const browser = await puppeteer.launch(env.MYBROWSER);
        const page = await browser.newPage();
        
        // 🚨 CHANGE THIS TO YOUR UGLY GOOGLE SITES URL
        await page.goto("https://sites.google.com/view/eryc-tri-juni-s-notes/");
        
        // Wait for Google's slow scripts to finish building the page
        await page.waitForNetworkIdle(); 
        const computedHTML = await page.content();
        await browser.close();

        const systemPrompt = `You are an Edge SEO extraction tool. 
        Analyze the provided HTML. 
        Output ONLY a valid JSON object. 
        Required keys: 
        "lcpUrl" (string, the absolute URL of the primary hero image), 
        "criticalCss" (string, a minified CSS string replicating the primary above-the-fold layout and background colors). 
        Do not include markdown formatting or explanations.`;

        console.log("Sending DOM to Llama 3...");
        const aiResponse = await env.AI.run('@cf/meta/llama-3-8b-instruct', {
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: computedHTML }
          ]
        });

        // Parse and save the payload to KV
        const parsedData = JSON.parse(aiResponse.response);
          
        if (parsedData.lcpUrl) {
            await env.AGP_STATE.put("LCP_IMAGE_URL", parsedData.lcpUrl);
        }
        if (parsedData.criticalCss) {
            await env.AGP_STATE.put("GHOST_CSS", parsedData.criticalCss);
        }
          
        console.log("AGP State Updated Successfully in KV.");
    } catch (error) {
        console.error("AI Extraction Failed:", error);
    }
  }
};
