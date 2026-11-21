// AGP Scanner v2 ("lite")
//
// Same job as v1 for the part that actually affects the live site:
// keep a cached copy of Google Sites' gstatic stylesheet in R2 and flag it
// as ready in KV. Differences from v1:
//   - no headless browser, no AI call (v1 threw the AI result away)
//   - only rebuilds when the gstatic CSS actually changed (hash compare)
//   - validates the new CSS before it overwrites production
//   - keeps the previous CSS as a backup in R2 for instant rollback
//   - no hardcoded trigger key (uses the AGP_KEY secret)
//   - dry-run by default: nothing is written until MODE="apply"

const SITE = "https://www.eryc.my.id";

// Same constants v1 wrote on every run. v2 only writes them if missing.
const LCP_IMAGE_URL = "/assets/image/hero.avif";
const GHOST_CSS =
  "html { background-color: #060522 !important; } .ghost-skeleton { width: 100vw; height: 100vh; background-color: #060522; }";

// R2 keys
const R2_LEGACY = "css/gstatic-cache.css"; // path the live Worker serves today
const R2_PREV = "css/gstatic-cache.prev.css"; // backup of the last good copy
const r2Versioned = (hash) => `css/gstatic-${hash}.css`;

// Sanity limits for a new stylesheet
const MIN_BYTES = 2000;
const MAX_SIZE_RATIO = 2; // reject if new size is >2x or <1/2 of the last one

export function sanitizeCss(css) {
  // identical to v1: drop inlined data: URLs
  return css.replace(/url\(['"]?data:[^)]+['"]?\)/g, "none");
}

export async function sha256Short(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 12);
}

export function findGstaticHref(html, base = SITE) {
  const tags = html.match(/<link\b[^>]*>/gi) || [];
  for (const tag of tags) {
    if (!/\brel=["']?stylesheet/i.test(tag)) continue;
    const m = tag.match(/\bhref=["']([^"']*gstatic\.com[^"']*)["']/i);
    if (m) return new URL(m[1].replace(/&amp;/g, "&"), base).href;
  }
  return null;
}

export async function scan(env, { apply = false, force = false } = {}) {
  const report = { at: new Date().toISOString(), apply, steps: [] };
  const log = (s) => {
    report.steps.push(s);
    console.log(`agp-v2: ${s}`);
  };

  // 1. Find the original gstatic stylesheet via the bot path
  const pageRes = await fetch(`${SITE}/?debug=bot`, {
    headers: { "User-Agent": "agp-scanner-v2" },
  });
  if (!pageRes.ok) {
    report.result = "skipped";
    report.reason = `bot page returned ${pageRes.status}`;
    log(report.reason);
    return report;
  }
  const href = findGstaticHref(await pageRes.text());
  if (!href) {
    report.result = "skipped";
    report.reason = "no gstatic stylesheet link found (Google Sites may have changed)";
    log(report.reason);
    return report;
  }
  report.href = href;
  log(`gstatic href: ${href}`);

  // 2. Download and sanitize it
  const cssRes = await fetch(href);
  const ctype = cssRes.headers.get("content-type") || "";
  if (!cssRes.ok || !ctype.includes("text/css")) {
    report.result = "skipped";
    report.reason = `gstatic CSS fetch failed (status ${cssRes.status}, type ${ctype || "none"})`;
    log(report.reason);
    return report;
  }
  const css = sanitizeCss(await cssRes.text());
  const bytes = new TextEncoder().encode(css).length;
  const hash = await sha256Short(css);
  report.hash = hash;
  report.bytes = bytes;
  log(`sanitized CSS: ${bytes} bytes, hash ${hash}`);

  // 3. Compare with what is already deployed
  const [prevHash, prevSizeRaw, ready] = await Promise.all([
    env.AGP_STATE.get("GSTATIC_HASH"),
    env.AGP_STATE.get("GSTATIC_SIZE"),
    env.AGP_STATE.get("GSTATIC_CSS"),
  ]);
  const prevSize = prevSizeRaw ? parseInt(prevSizeRaw, 10) : 0;

  // The file can disappear from R2 even when Google's CSS is unchanged
  // (e.g. the repo's R2 sync with --delete). Check it really exists.
  const fileExists = Boolean(await env.MY_ASSETS.head(R2_LEGACY));
  report.fileExists = fileExists;

  if (prevHash === hash && ready === "ready" && fileExists && !force) {
    report.result = "unchanged";
    log("CSS unchanged since last run, nothing to do");
    if (apply) await env.AGP_STATE.put("SCAN_STATE", JSON.stringify(report));
    return report;
  }
  if (!fileExists) log(`${R2_LEGACY} is missing in R2, will restore it`);

  // 4. Validate before touching production
  if (bytes < MIN_BYTES || !css.includes("{")) {
    report.result = "rejected";
    report.reason = `new CSS looks wrong (${bytes} bytes)`;
    log(report.reason);
    if (apply) await env.AGP_STATE.put("SCAN_STATE", JSON.stringify(report));
    return report;
  }
  if (prevSize && !force) {
    const ratio = bytes / prevSize;
    if (ratio > MAX_SIZE_RATIO || ratio < 1 / MAX_SIZE_RATIO) {
      report.result = "rejected";
      report.reason = `size changed ${prevSize} -> ${bytes} bytes (>${MAX_SIZE_RATIO}x); re-run with force=1 if intended`;
      log(report.reason);
      if (apply) await env.AGP_STATE.put("SCAN_STATE", JSON.stringify(report));
      return report;
    }
  }

  report.change = { from: prevHash || null, to: hash };
  if (!apply) {
    report.result = "would-update";
    log("dry run: would update R2 + KV (set MODE=apply or use ?apply=1)");
    return report;
  }

  // 5. Apply: backup, then write
  const current = await env.MY_ASSETS.get(R2_LEGACY);
  if (current) {
    await env.MY_ASSETS.put(R2_PREV, await current.text(), {
      httpMetadata: { contentType: "text/css" },
    });
    log(`backed up previous CSS to ${R2_PREV}`);
  }
  const meta = { httpMetadata: { contentType: "text/css" } };
  await env.MY_ASSETS.put(r2Versioned(hash), css, meta); // versioned copy (cache-safe URL)
  await env.MY_ASSETS.put(R2_LEGACY, css, meta); // path the live Worker uses today
  await Promise.all([
    env.AGP_STATE.put("GSTATIC_CSS", "ready"),
    env.AGP_STATE.put("GSTATIC_HASH", hash),
    env.AGP_STATE.put("GSTATIC_SIZE", String(bytes)),
    env.AGP_STATE.put("GSTATIC_CSS_PATH", `/assets/${r2Versioned(hash)}`),
  ]);
  log(`wrote ${r2Versioned(hash)} and ${R2_LEGACY}`);

  // 6. Constants v1 rewrote every run: only seed them if missing
  const [lcp, ghost] = await Promise.all([
    env.AGP_STATE.get("LCP_IMAGE_URL"),
    env.AGP_STATE.get("GHOST_CSS"),
  ]);
  if (!lcp) await env.AGP_STATE.put("LCP_IMAGE_URL", LCP_IMAGE_URL);
  if (!ghost) await env.AGP_STATE.put("GHOST_CSS", GHOST_CSS);

  report.result = "updated";
  await env.AGP_STATE.put("SCAN_STATE", JSON.stringify(report));
  return report;
}

// Restore the backed-up CSS (one step back).
export async function rollback(env) {
  const prev = await env.MY_ASSETS.get(R2_PREV);
  if (!prev) return { result: "no-backup" };
  const css = await prev.text();
  await env.MY_ASSETS.put(R2_LEGACY, css, { httpMetadata: { contentType: "text/css" } });
  const hash = await sha256Short(css);
  await Promise.all([
    env.AGP_STATE.put("GSTATIC_HASH", hash),
    env.AGP_STATE.put("GSTATIC_SIZE", String(new TextEncoder().encode(css).length)),
  ]);
  return { result: "rolled-back", hash };
}

function authorized(request, env) {
  const key = new URL(request.url).searchParams.get("key");
  return Boolean(env.AGP_KEY) && key === env.AGP_KEY;
}

export default {
  async scheduled(event, env, ctx) {
    const apply = env.MODE === "apply";
    ctx.waitUntil(scan(env, { apply }).catch((e) => console.error("agp-v2 cron failed:", e)));
  },

  async fetch(request, env) {
    if (!authorized(request, env)) return new Response("Unauthorized", { status: 401 });
    const url = new URL(request.url);
    const json = (obj, status = 200) =>
      new Response(JSON.stringify(obj, null, 2), {
        status,
        headers: { "Content-Type": "application/json" },
      });

    try {
      if (url.pathname === "/status") {
        const state = await env.AGP_STATE.get("SCAN_STATE");
        return json(state ? JSON.parse(state) : { result: "no runs yet" });
      }
      if (url.pathname === "/rollback") {
        return json(await rollback(env));
      }
      // default: dry run unless ?apply=1
      return json(
        await scan(env, {
          apply: url.searchParams.get("apply") === "1",
          force: url.searchParams.get("force") === "1",
        }),
      );
    } catch (e) {
      return json({ result: "error", error: e.message }, 500);
    }
  },
};
