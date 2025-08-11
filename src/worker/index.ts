// src/worker/index.ts
import { Hono } from "hono";

// ---- Env bindings ----
type Env = {
  DB: D1Database;
  CACHE: KVNamespace;
  R2: R2Bucket;
  ASSETS: Fetcher;
  META_APP_ID: string;
  META_APP_SECRET: string;
  LINKEDIN_CLIENT_ID: string;
  LINKEDIN_CLIENT_SECRET: string;
  X_BEARER: string;
};

// Create app
const app = new Hono<{ Bindings: Env }>();

// -------- CORS for /api ----------
app.use("/api/*", async (c, next) => {
  if (c.req.method === "OPTIONS") {
    return c.text("ok", 200, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    });
  }
  await next();
  c.header("Access-Control-Allow-Origin", "*");
  c.header("Access-Control-Allow-Headers", "*");
  c.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
});

// -------- API ROUTES -------------
app.get("/api/health", (c) => c.json({ status: "ok" }));

// Create company
app.post("/api/company", async (c) => {
  const env = c.env;
  const body = (await c.req.json().catch(() => ({}))) as any;
  const { name, description, tone, site_url, socials, logo_url, colors } = body || {};
  if (!name || !site_url) return c.json({ error: "name and site_url required" }, 400);

  const res = await env.DB
    .prepare(
      `INSERT INTO company (name, description, tone, site_url, socials_json, logo_url, colors_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      name,
      description ?? null,
      tone ?? null,
      site_url,
      JSON.stringify(socials || {}),
      logo_url ?? null,
      JSON.stringify(colors || {})
    )
    .run();

  const id = Number((res.meta as any)?.last_row_id ?? 0);
  return c.json({ id });
});

// Latest company
app.get("/api/company", async (c) => {
  const row = await c.env.DB.prepare("SELECT * FROM company ORDER BY id DESC LIMIT 1").first();
  return c.json({ company: row ?? null });
});

// Ingest site
app.post("/api/ingest", async (c) => {
  const env = c.env;
  const { company_id, limit = 20 } = (await c.req.json().catch(() => ({}))) as any;
  if (!company_id) return c.json({ error: "company_id required" }, 400);

  const company = await env.DB.prepare("SELECT * FROM company WHERE id=?").bind(company_id).first();
  if (!company) return c.json({ error: "company not found" }, 404);

  const pages = await ingestSite((company as any).site_url as string, env, limit);
  const products = extractProducts(pages);

  for (const p of products) {
    await env.DB
      .prepare(
        `INSERT INTO product (company_id, title, url, summary, price, images_json, tags)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        company_id,
        p.title,
        p.url,
        p.summary,
        p.price ?? null,
        JSON.stringify(p.images || []),
        p.tags?.join(",") || null
      )
      .run();
  }
  return c.json({ pages: pages.length, products: products.length });
});

// Weekly plan
app.post("/api/plan/week", async (c) => {
  const env = c.env;
  const { company_id, week_start, platforms = ["facebook", "instagram", "linkedin", "x"] } =
    (await c.req.json().catch(() => ({}))) as any;
  if (!company_id || !week_start) return c.json({ error: "company_id and week_start required" }, 400);

  const company = await env.DB.prepare("SELECT * FROM company WHERE id=?").bind(company_id).first();
  if (!company) return c.json({ error: "company not found" }, 404);

  const prods = await env.DB.prepare("SELECT * FROM product WHERE company_id=? LIMIT 20")
    .bind(company_id)
    .all();

  const planJson = buildWeeklyPlan(company as any, (prods.results as any[]) || [], platforms);

  const planRes = await env.DB
    .prepare(
      "INSERT INTO content_plan (company_id, week_start, platform, status, json) VALUES (?, ?, ?, ?, ?)"
    )
    .bind(company_id, week_start, "multi", "draft", JSON.stringify(planJson))
    .run();

  const planId = Number((planRes.meta as any)?.last_row_id ?? 0);

  for (const post of planJson.posts) {
    await env.DB
      .prepare(
        "INSERT INTO post (plan_id, platform, caption, hashtags, image_prompt, scheduled_at, status) VALUES (?, ?, ?, ?, ?, ?, ?)"
      )
      .bind(
        planId,
        post.platform,
        post.caption,
        (post.hashtags || []).join(" "),
        post.image_prompt,
        post.scheduled_at,
        "draft"
      )
      .run();
  }
  return c.json({ plan_id: planId, count: planJson.posts.length });
});

// Plans list
app.get("/api/plans", async (c) => {
  const company_id = c.req.query("company_id");
  if (!company_id) return c.json({ error: "company_id required" }, 400);

  const rows = await c.env.DB.prepare(
    "SELECT id, week_start, platform, status FROM content_plan WHERE company_id=? ORDER BY id DESC LIMIT 20"
  )
    .bind(company_id)
    .all();

  return c.json({ plans: rows.results || [] });
});

// Posts by plan
app.get("/api/posts", async (c) => {
  const plan_id = c.req.query("plan_id");
  if (!plan_id) return c.json({ error: "plan_id required" }, 400);

  const rows = await c.env.DB.prepare(
    "SELECT id, platform, scheduled_at, caption, hashtags, image_prompt, status FROM post WHERE plan_id=? ORDER BY scheduled_at"
  )
    .bind(plan_id)
    .all();

  return c.json({ posts: rows.results || [] });
});

// Add competitors
app.post("/api/competitors", async (c) => {
  const env = c.env;
  const { company_id, competitors = [] } = (await c.req.json().catch(() => ({}))) as any;
  if (!company_id) return c.json({ error: "company_id required" }, 400);

  for (const comp of competitors) {
    await env.DB
      .prepare("INSERT INTO competitor (company_id, name, url, socials_json) VALUES (?, ?, ?, ?)")
      .bind(company_id, comp.name || null, comp.url, JSON.stringify(comp.socials || {}))
      .run();
  }
  return c.json({ added: competitors.length });
});

// List competitors + light analysis
app.get("/api/competitors", async (c) => {
  const company_id = c.req.query("company_id");
  if (!company_id) return c.json({ error: "company_id required" }, 400);

  const rows = await c.env.DB.prepare("SELECT * FROM competitor WHERE company_id=?")
    .bind(company_id)
    .all();

  const analysis = await analyzeCompetitors((rows.results as any[]) || []);
  return c.json({ competitors: rows.results, analysis });
});

// SEO audit a single page
app.get("/api/seo/audit", async (c) => {
  const env = c.env;
  const target = c.req.query("url");
  const company_id = c.req.query("company_id");
  if (!target || !company_id) return c.json({ error: "url and company_id required" }, 400);

  const audit = await auditPage(target);

  await env.DB
    .prepare(
      `INSERT INTO seo_page (company_id, url, title, h1, meta_desc, score, issues_json, last_checked)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(company_id, url) DO UPDATE SET
       title=excluded.title, h1=excluded.h1, meta_desc=excluded.meta_desc, score=excluded.score, issues_json=excluded.issues_json, last_checked=excluded.last_checked`
    )
    .bind(
      company_id,
      target,
      audit.title,
      audit.h1,
      audit.meta_desc,
      audit.score,
      JSON.stringify(audit.issues),
      Math.floor(Date.now() / 1000)
    )
    .run();

  return c.json(audit);
});

// SEO: list audited pages
app.get("/api/seo/pages", async (c) => {
  const company_id = c.req.query("company_id");
  if (!company_id) return c.json({ error: "company_id required" }, 400);

  const rows = await c.env.DB.prepare(
    "SELECT id, url, title, h1, meta_desc, score, last_checked, issues_json FROM seo_page WHERE company_id=? ORDER BY last_checked DESC NULLS LAST, id DESC LIMIT 100"
  )
    .bind(company_id)
    .all();

  return c.json({ pages: rows.results || [] });
});

// Export CSV to R2
app.post("/api/export/zip", async (c) => {
  const env = c.env;
  const { plan_id } = (await c.req.json().catch(() => ({}))) as any;
  if (!plan_id) return c.json({ error: "plan_id required" }, 400);

  const rows = await env.DB.prepare(
    "SELECT id, platform, scheduled_at, caption, hashtags, image_prompt, status FROM post WHERE plan_id=? ORDER BY scheduled_at"
  )
    .bind(plan_id)
    .all();

  const csv = toCSV((rows.results as any[]) || []);
  const key = `exports/plan_${plan_id}_${Date.now()}.csv`;
  await env.R2.put(key, csv, { httpMetadata: { contentType: "text/csv" } });
  return c.json({ r2_key: key });
});

// -------- Static assets fallback (for all non-/api paths) --------
app.all("*", async (c) => {
  // If API path somehow reaches here, 404 it
  if (c.req.path.startsWith("/api/")) return c.text("Not found", 404);
  // Serve built React app from [assets] binding (wrangler.json → assets.directory)
  const resp = await c.env.ASSETS.fetch(c.req.raw);
  return resp;
});

// ========== Export ==========
export default app;

// ------------- Helpers ----------------
async function ingestSite(baseUrl: string, env: Env, limit: number) {
  const key = `sitemap:${baseUrl}`;
  const cached = await env.CACHE.get(key);
  let urls: string[] = [];
  if (cached) {
    urls = JSON.parse(cached);
  } else {
    try {
      const sm = await fetch(new URL("/sitemap.xml", baseUrl));
      if (sm.ok) {
        const xml = await sm.text();
        urls = [...xml.matchAll(/<loc>(.*?)<\/loc>/g)].map((m) => m[1]).slice(0, limit);
      }
    } catch {}
    if (!urls.length) urls = [baseUrl];
    await env.CACHE.put(key, JSON.stringify(urls), { expirationTtl: 3600 });
  }
  const pages: { url: string; html: string }[] = [];
  for (const u of urls.slice(0, limit)) {
    try {
      const res = await fetch(u, { headers: { "User-Agent": "SMM/1.0" } });
      if (!res.ok) continue;
      const html = await res.text();
      pages.push({ url: u, html });
    } catch {}
  }
  return pages;
}

function extractProducts(
  pages: { url: string; html: string }[]
): { title: string; url: string; summary: string; price?: string; images?: string[]; tags?: string[] }[] {
  const items: any[] = [];
  for (const p of pages) {
    const titles = [...p.html.matchAll(/<(h2|h3)[^>]*>(.*?)<\/\1>/gi)].map((m) => strip(m[2]));
    const prices = [...p.html.matchAll(/R\s?\d+[\d\.,]*/gi)].map((m) => m[0]);
    const imgs = [...p.html.matchAll(/<img[^>]*src=["']([^"']+)["']/gi)].map((m) => m[1]);
    if (titles.length) {
      items.push({
        title: titles[0],
        url: p.url,
        summary: summarizeFromHtml(p.html),
        price: prices[0],
        images: imgs.slice(0, 3),
        tags: guessTags(p.html),
      });
    }
  }
  return dedupeBy(items, (x) => `${x.title}|${x.url}`);
}

function buildWeeklyPlan(company: any, products: any[], platforms: string[]) {
  const posts: any[] = [];
  const now = new Date();
  for (let d = 0; d < 7; d++) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + d).toISOString().slice(0, 10);
    const prod =
      products[d % Math.max(1, products.length)] || { title: company.name, summary: company.description };
    for (const platform of platforms) {
      posts.push({
        platform,
        scheduled_at: `${day}T09:00:00Z`,
        caption: captionTemplate(platform, prod, company.tone),
        hashtags: baseHashtags(company.name, prod),
        image_prompt: imagePrompt(prod, company),
      });
    }
  }
  return { posts };
}

function captionTemplate(_platform: string, prod: any, _tone: string) {
  const line = `${prod.title || "Our services"} — ${truncate(prod.summary || "", 140)}`;
  const cta = "Chat to us: 021 007 0200 | sales@vinet.co.za";
  return `${line}\n${cta}`.trim();
}
function baseHashtags(_name: string, prod: any) {
  const tags = ["#Vinet", "#Internet", "#Connectivity", "#Fibre", "#Wireless"];
  if (prod?.tags?.length) tags.push(...prod.tags.slice(0, 3).map((t: string) => `#${t.replace(/\s+/g, "")}`));
  return dedupeBy(tags, (x: string) => x);
}
function imagePrompt(prod: any, company: any) {
  return `Minimal ad tile for ${company.name}. Headline: ${prod.title}. Colors: brand palette if available. Include logo if available.`;
}

async function analyzeCompetitors(list: any[]) {
  const out: any[] = [];
  for (const c of list) {
    try {
      const res = await fetch(c.url);
      const html = await res.text();
      const title = (html.match(/<title>(.*?)<\/title>/i) || [])[1] || "";
      out.push({ id: c.id, url: c.url, title, cadence_guess: "weekly", topic_guess: ["pricing", "coverage", "support"] });
    } catch {
      out.push({ id: c.id, url: c.url, error: "fetch_failed" });
    }
  }
  return out;
}

async function auditPage(url: string) {
  const res = await fetch(url);
  if (!res.ok) return { url, score: 0, issues: [{ id: "fetch", msg: `HTTP ${res.status}` }] };
  const html = await res.text();
  const title = (html.match(/<title>(.*?)<\/title>/i) || [])[1] || "";
  const h1 = (html.match(/<h1[^>]*>(.*?)<\/h1>/i) || [])[1] || "";
  const meta_desc =
    (html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']*)["'][^>]*>/i) || [])[1] || "";
  const imgAltsMissing = (html.match(/<img\b(?![^>]*alt=)[^>]*>/gi) || []).length;
  const links = (html.match(/<a\b[^>]*href=/gi) || []).length;
  const issues: any[] = [];
  if (!title) issues.push({ id: "title", msg: "Missing <title>" });
  if (!h1) issues.push({ id: "h1", msg: "Missing <h1>" });
  if (!meta_desc) issues.push({ id: "meta", msg: "Missing meta description" });
  if (imgAltsMissing > 0) issues.push({ id: "img_alt", msg: `${imgAltsMissing} images missing alt` });
  if (links < 5) issues.push({ id: "links", msg: "Low internal link count" });
  const score = Math.max(0, 100 - issues.length * 12);
  return { url, title: strip(title), h1: strip(h1), meta_desc: strip(meta_desc), score, issues };
}

function toCSV(rows: any[]) {
  if (!rows.length) return "platform,scheduled_at,caption,hashtags\n";
  const header = Object.keys(rows[0]).join(",");
  const esc = (v: any) => (v == null ? "" : String(v).replaceAll('"', '""'));
  const lines = rows.map((r) => Object.keys(r).map((k) => `"${esc((r as any)[k])}"`).join(","));
  return header + "\n" + lines.join("\n");
}

// utils
function strip(s?: string) {
  return s?.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim() ?? "";
}
function truncate(s: string, n: number) {
  return (s || "").length > n ? s.slice(0, n - 1) + "…" : s || "";
}
function summarizeFromHtml(html: string) {
  const text = strip(html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " "));
  return text.split(/\s+/).slice(0, 40).join(" ");
}
function guessTags(html: string) {
  const tags: string[] = [];
  if (/fibre|fiber/i.test(html)) tags.push("fibre");
  if (/wireless|wifi/i.test(html)) tags.push("wireless");
  if (/voip/i.test(html)) tags.push("voip");
  if (/hosting|domain/i.test(html)) tags.push("hosting");
  return tags;
}
function dedupeBy<T>(arr: T[], keyer: (x: T) => string) {
  const m = new Map<string, T>();
  for (const x of arr) {
    const k = keyer(x);
    if (!m.has(k)) m.set(k, x);
  }
  return [...m.values()];
}
