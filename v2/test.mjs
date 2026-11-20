// Offline test: mocks fetch, KV and R2. Run with:  node v2/test.mjs
import assert from "node:assert/strict";
import worker, { scan, rollback, findGstaticHref, sanitizeCss } from "./scanner.mjs";

const mkKV = () => {
  const m = new Map();
  return { m, get: async (k) => m.get(k) ?? null, put: async (k, v) => void m.set(k, v) };
};
const mkR2 = () => {
  const m = new Map();
  return {
    m,
    get: async (k) => (m.has(k) ? { text: async () => m.get(k) } : null),
    put: async (k, v) => void m.set(k, v),
  };
};

let css = ".a{color:red}\n".repeat(400) + ".b{background:url(data:image/png;base64,AAAA)}";
let pageStatus = 200;
let cssType = "text/css";
let withLink = true;
globalThis.fetch = async (url) => {
  url = String(url);
  if (url.includes("debug=bot")) {
    const html = withLink
      ? `<html><head><link href="https://www.gstatic.com/_/scs/sites-server/_/ss/k=abc/m=x.css?z=1&amp;y=2" rel="stylesheet"></head></html>`
      : `<html><head></head></html>`;
    return new Response(html, { status: pageStatus });
  }
  return new Response(css, { status: 200, headers: { "content-type": cssType } });
};

const env = () => ({ AGP_STATE: mkKV(), MY_ASSETS: mkR2(), AGP_KEY: "k" });

// helpers
assert.equal(
  findGstaticHref(`<link rel="stylesheet" href="https://www.gstatic.com/a.css">`),
  "https://www.gstatic.com/a.css",
);
assert.equal(findGstaticHref(`<link rel="icon" href="https://www.gstatic.com/a.png">`), null);
assert.ok(!sanitizeCss(css).includes("data:"));

// dry run writes nothing
let e = env();
let r = await scan(e, { apply: false });
assert.equal(r.result, "would-update");
assert.equal(e.MY_ASSETS.m.size, 0);
assert.equal(e.AGP_STATE.m.size, 0);

// first apply writes versioned + legacy + KV
r = await scan(e, { apply: true });
assert.equal(r.result, "updated");
assert.ok(e.MY_ASSETS.m.has("css/gstatic-cache.css"));
assert.ok(e.MY_ASSETS.m.has(`css/gstatic-${r.hash}.css`));
assert.equal(e.AGP_STATE.m.get("GSTATIC_CSS"), "ready");
assert.equal(e.AGP_STATE.m.get("LCP_IMAGE_URL"), "/assets/image/hero.avif");
assert.ok(!e.MY_ASSETS.m.get("css/gstatic-cache.css").includes("data:"));

// second run: unchanged, no writes
const before = e.MY_ASSETS.m.size;
r = await scan(e, { apply: true });
assert.equal(r.result, "unchanged");
assert.equal(e.MY_ASSETS.m.size, before);

// small change is applied, backup holds the old copy
const oldCss = e.MY_ASSETS.m.get("css/gstatic-cache.css");
css += "\n.c{color:blue}";
r = await scan(e, { apply: true });
assert.equal(r.result, "updated");
assert.equal(e.MY_ASSETS.m.get("css/gstatic-cache.prev.css"), oldCss);

// rollback restores the backup
const rb = await rollback(e);
assert.equal(rb.result, "rolled-back");
assert.equal(e.MY_ASSETS.m.get("css/gstatic-cache.css"), oldCss);

// wild size change is rejected; force overrides
const good = e.MY_ASSETS.m.get("css/gstatic-cache.css");
css = ".x{a:b}".repeat(10) + "x".repeat(2100);
r = await scan(e, { apply: true });
assert.equal(r.result, "rejected");
assert.equal(e.MY_ASSETS.m.get("css/gstatic-cache.css"), good);
r = await scan(e, { apply: true, force: true });
assert.equal(r.result, "updated"); // force overrides the size guard

// tiny / broken CSS is rejected on a fresh install too
e = env();
css = "oops";
r = await scan(e, { apply: true });
assert.equal(r.result, "rejected");
assert.equal(e.MY_ASSETS.m.size, 0);

// wrong content type and missing link are skipped, nothing written
css = ".a{}".repeat(1000);
cssType = "text/html";
r = await scan(env(), { apply: true });
assert.equal(r.result, "skipped");
cssType = "text/css";
withLink = false;
r = await scan(env(), { apply: true });
assert.equal(r.result, "skipped");
withLink = true;
pageStatus = 500;
r = await scan(env(), { apply: true });
assert.equal(r.result, "skipped");
pageStatus = 200;

// auth: no key / wrong key / no secret configured
e = env();
assert.equal((await worker.fetch(new Request("https://x/"), e)).status, 401);
assert.equal((await worker.fetch(new Request("https://x/?key=bad"), e)).status, 401);
assert.equal((await worker.fetch(new Request("https://x/?key=k"), { ...e, AGP_KEY: undefined })).status, 401);
const ok = await worker.fetch(new Request("https://x/?key=k"), e);
assert.equal(ok.status, 200);
assert.equal((await ok.json()).result, "would-update"); // dry by default
assert.equal(e.MY_ASSETS.m.size, 0);

// cron respects MODE
e = { ...env(), MODE: "dry" };
let pending;
await worker.scheduled({}, e, { waitUntil: (p) => (pending = p) });
await pending;
assert.equal(e.MY_ASSETS.m.size, 0);
e = { ...env(), MODE: "apply" };
await worker.scheduled({}, e, { waitUntil: (p) => (pending = p) });
await pending;
assert.ok(e.MY_ASSETS.m.has("css/gstatic-cache.css"));

console.log("all v2 tests passed");
