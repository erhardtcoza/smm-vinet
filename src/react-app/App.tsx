// src/react-app/App.tsx
import { useState } from "react";
import "./App.css";
useEffect(() => {
  const saved = localStorage.getItem("companyId");
  const id = saved ? Number(saved) : null;
  if (!id) return;
  setCompanyId(id);
  fetch("/api/company")
    .then((r) => r.json())
    .then((j) => {
      const c = j.company || {};
      setCompany({
        name: c.name || "",
        description: c.description || "",
        tone: c.tone || "direct",
        site_url: c.site_url || "",
        logo_url: c.logo_url || "",
        socials: safeString(c.socials_json),
        colors: safeString(c.colors_json),
      });
    })
    .catch(() => {});
}, []);


// Types
type Plan = { id: number; week_start: string; platform: string; status: string };
type Post = {
  id: number;
  platform: string;
  scheduled_at: string;
  caption: string;
  hashtags: string;
  image_prompt: string;
  status: string;
};
type SeoRow = {
  id: number;
  url: string;
  title: string;
  h1: string;
  meta_desc: string;
  score: number;
  last_checked: number | null;
  issues_json: string | null;
};

export default function App() {
  // Company form
  const [company, setCompany] = useState({
    name: "",
    description: "",
    tone: "direct",
    site_url: "",
    logo_url: "",
    socials: "",
    colors: "",
  });
  const [companyId, setCompanyId] = useState<number | null>(null);

  // Planner
  const [week, setWeek] = useState<string>(
    new Date().toISOString().slice(0, 10)
  );
  const [platforms, setPlatforms] = useState<string[]>([
    "facebook",
    "instagram",
    "linkedin",
    "x",
  ]);

  // Data
  const [plans, setPlans] = useState<Plan[]>([]);
  const [selectedPlanId, setSelectedPlanId] = useState<number | null>(null);
  const [posts, setPosts] = useState<Post[]>([]);
  const [auditUrl, setAuditUrl] = useState("");
  const [seoRows, setSeoRows] = useState<SeoRow[]>([]);
  const [log, setLog] = useState<string[]>([]);

  const push = (m: string) => setLog((l) => [m, ...l]);

  // Actions
  async function saveCompany() {
    const payload = {
      ...company,
      socials: safeJson(company.socials),
      colors: safeJson(company.colors),
    };
    const r = await fetch(`/api/company`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const j = await r.json();
    if (j.error) return alert(j.error);
    setCompanyId(j.id);
    localStorage.setItem("companyId", String(j.id));
    push(`Company saved: ${j.id}`);
  }

  function safeString(x: any) {
  if (!x) return "";
  try { return typeof x === "string" ? x : JSON.stringify(x); } catch { return ""; }
}

  async function ingest() {
    if (!companyId) return alert("Save company first");
    const r = await fetch(`/api/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ company_id: companyId, limit: 20 }),
    });
    const j = await r.json();
    if (j.error) return alert(j.error);
    push(`Ingested pages=${j.pages} products=${j.products}`);
  }

  async function makePlan() {
    if (!companyId) return alert("Save company first");
    const r = await fetch(`/api/plan/week`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ company_id: companyId, week_start: week, platforms }),
    });
    const j = await r.json();
    if (j.error) return alert(j.error);
    push(`Plan created id=${j.plan_id} posts=${j.count}`);
  }

  async function loadPlans() {
    if (!companyId) return alert("Save company first");
    const r = await fetch(`/api/plans?company_id=${companyId}`);
    const j = await r.json();
    if (j.error) return alert(j.error);
    setPlans(j.plans || []);
    push(`Loaded ${j.plans?.length || 0} plans`);
  }

  async function loadPosts(planId: number) {
    setSelectedPlanId(planId);
    const r = await fetch(`/api/posts?plan_id=${planId}`);
    const j = await r.json();
    if (j.error) return alert(j.error);
    setPosts(j.posts || []);
  }

  async function runAudit() {
    if (!companyId) return alert("Save company first");
    if (!auditUrl) return alert("Enter a URL to audit");
    const r = await fetch(
      `/api/seo/audit?company_id=${companyId}&url=${encodeURIComponent(
        auditUrl
      )}`
    );
    const j = await r.json();
    if (j.error) return alert(j.error);
    push(`Audited: ${auditUrl} (score ${j.score})`);
    await refreshSeo();
  }

  async function refreshSeo() {
    if (!companyId) return alert("Save company first");
    const r = await fetch(`/api/seo/pages?company_id=${companyId}`);
    const j = await r.json();
    if (j.error) return alert(j.error);
    setSeoRows(j.pages || []);
    push(`Loaded SEO rows: ${j.pages?.length || 0}`);
  }

  // UI
  return (
    <div style={wrap}>
      <h2>Social Media Planner</h2>
      <p style={muted}>Setup → Ingest → Plan → Plans → SEO.</p>

      {/* Company + Ingest + Plan */}
      <div style={grid2}>
        <div>
          <h3>Company</h3>
          <input
            placeholder="Name"
            value={company.name}
            onChange={(e) => setCompany({ ...company, name: e.target.value })}
            style={inp}
          />
          <textarea
            placeholder="Description"
            rows={4}
            value={company.description}
            onChange={(e) =>
              setCompany({ ...company, description: e.target.value })
            }
            style={inp}
          />
          <input
            placeholder="Tone (e.g., direct)"
            value={company.tone}
            onChange={(e) => setCompany({ ...company, tone: e.target.value })}
            style={inp}
          />
          <input
            placeholder="Website URL"
            value={company.site_url}
            onChange={(e) => setCompany({ ...company, site_url: e.target.value })}
            style={inp}
          />
          <input
            placeholder="Logo URL"
            value={company.logo_url}
            onChange={(e) => setCompany({ ...company, logo_url: e.target.value })}
            style={inp}
          />
          <textarea
            placeholder='Socials JSON (e.g., {"facebook":"...","instagram":"..."})'
            rows={2}
            value={company.socials}
            onChange={(e) => setCompany({ ...company, socials: e.target.value })}
            style={inp}
          />
          <textarea
            placeholder='Colors JSON (e.g., {"primary":"#e2001a"})'
            rows={2}
            value={company.colors}
            onChange={(e) => setCompany({ ...company, colors: e.target.value })}
            style={inp}
          />
          <button onClick={saveCompany} style={btn}>
            Save Company
          </button>
        </div>

        <div>
          <h3>Ingest & Plan</h3>
          <button onClick={ingest} style={btn}>
            Ingest Website
          </button>

          <div style={{ marginTop: 12 }}>
            <label>Week start</label>
            <input
              type="date"
              value={week}
              onChange={(e) => setWeek(e.target.value)}
              style={inp}
            />
          </div>

          <div style={{ marginTop: 12 }}>
            <label>Platforms</label>
            <div style={grid4}>
              {["facebook", "instagram", "linkedin", "x"].map((p) => (
                <label key={p}>
                  <input
                    type="checkbox"
                    checked={platforms.includes(p)}
                    onChange={(e) =>
                      setPlatforms((s) =>
                        e.target.checked ? [...s, p] : s.filter((x) => x !== p)
                      )
                    }
                  />{" "}
                  {p}
                </label>
              ))}
            </div>
          </div>

          <button onClick={makePlan} style={{ ...btn, marginTop: 12 }}>
            Generate Week Plan
          </button>
        </div>
      </div>

      {/* Plans */}
      <h3 style={{ marginTop: 24 }}>Plans</h3>
      <div style={card}>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button onClick={loadPlans} style={btn}>
            Load Plans
          </button>
          {plans.length > 0 && (
            <select
              value={selectedPlanId ?? ""}
              onChange={(e) => loadPosts(Number(e.target.value))}
              style={{ padding: 8, borderRadius: 8, border: "1px solid #ddd" }}
            >
              <option value="" disabled>
                Select plan
              </option>
              {plans.map((p) => (
                <option key={p.id} value={p.id}>
                  #{p.id} — {p.week_start} — {p.status}
                </option>
              ))}
            </select>
          )}
        </div>

        {posts.length > 0 && (
          <div style={{ marginTop: 12, overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th align="left">Platform</th>
                  <th align="left">Scheduled (UTC)</th>
                  <th align="left">Caption</th>
                  <th align="left">Hashtags</th>
                  <th align="left">Image Prompt</th>
                  <th align="left">Status</th>
                </tr>
              </thead>
              <tbody>
                {posts.map((r) => (
                  <tr key={r.id}>
                    <td>{r.platform}</td>
                    <td>{r.scheduled_at}</td>
                    <td style={{ maxWidth: 360, whiteSpace: "pre-wrap" }}>
                      {r.caption}
                    </td>
                    <td>{r.hashtags}</td>
                    <td style={{ maxWidth: 260, whiteSpace: "pre-wrap" }}>
                      {r.image_prompt}
                    </td>
                    <td>{r.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* SEO */}
      <h3 style={{ marginTop: 24 }}>SEO</h3>
      <div style={card}>
        <div style={{ display: "flex", gap: 8 }}>
          <input
            placeholder="https://example.com/page"
            value={auditUrl}
            onChange={(e) => setAuditUrl(e.target.value)}
            style={inp}
          />
          <button onClick={runAudit} style={btn}>
            Run Audit
          </button>
          <button onClick={refreshSeo} style={btn}>
            Refresh Table
          </button>
        </div>

        {seoRows.length > 0 && (
          <div style={{ marginTop: 12, overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th align="left">Score</th>
                  <th align="left">URL</th>
                  <th align="left">Title</th>
                  <th align="left">H1</th>
                  <th align="left">Issues</th>
                  <th align="left">Checked</th>
                </tr>
              </thead>
              <tbody>
                {seoRows.map((r) => {
                  let issues = 0;
                  try {
                    const arr = JSON.parse(r.issues_json || "[]");
                    issues = Array.isArray(arr) ? arr.length : 0;
                  } catch {}
                  const dt = r.last_checked
                    ? new Date(r.last_checked * 1000).toISOString()
                    : "";
                  return (
                    <tr key={r.id}>
                      <td>{r.score}</td>
                      <td style={{ maxWidth: 280, wordBreak: "break-all" }}>
                        <a href={r.url} target="_blank" rel="noreferrer">
                          {r.url}
                        </a>
                      </td>
                      <td
                        style={{
                          maxWidth: 260,
                          whiteSpace: "nowrap",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                        }}
                      >
                        {r.title}
                      </td>
                      <td
                        style={{
                          maxWidth: 220,
                          whiteSpace: "nowrap",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                        }}
                      >
                        {r.h1}
                      </td>
                      <td>{issues}</td>
                      <td>{dt}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Activity */}
      <h3 style={{ marginTop: 24 }}>Activity</h3>
      <ul>
        {log.map((l, i) => (
          <li key={i}>{l}</li>
        ))}
      </ul>
    </div>
  );
}

// Styles
const wrap = {
  maxWidth: 1100,
  margin: "40px auto",
  padding: 24,
  background: "#fff",
  border: "1px solid #eee",
  borderRadius: 16,
  fontFamily:
    "system-ui, -apple-system, Segoe UI, Roboto, Ubuntu, Cantarell, Noto Sans, sans-serif",
} as const;

const muted = { color: "#666", fontSize: 12 } as const;
const grid2 = { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 } as const;
const grid4 = { display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 8 } as const;
const inp = {
  width: "100%",
  padding: 10,
  margin: "6px 0",
  border: "1px solid #ddd",
  borderRadius: 10,
} as const;
const btn = {
  padding: "10px 16px",
  borderRadius: 10,
  border: "1px solid #ddd",
  background: "#e2001a",
  color: "#fff",
  cursor: "pointer",
} as const;
const card = { border: "1px solid #eee", borderRadius: 12, padding: 12, background: "#fff" } as const;

// Utils
function safeJson(x: string) {
  try {
    return JSON.parse(x);
  } catch {
    return {};
  }
}
