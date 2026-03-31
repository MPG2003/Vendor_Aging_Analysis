/* ═══════════════════════════════════════════════════════════════════════════
   SAP VRM — AI Intelligence  (intelligence.js)
   Three features:
     1. Natural Language Query Engine
     2. AI Insight Generator
     3. Vendor Risk Chatbot
   All LLM calls go through Flask /api/claude proxy → OpenRouter.
   ═══════════════════════════════════════════════════════════════════════════ */
"use strict";

/* ── data aliases ────────────────────────────────────────────────────────── */
const VENDORS       = RAW_DATA.vendors   || [];
const KPI           = RAW_DATA.kpi       || {};
const AGING_BUCKETS = RAW_DATA.aging_buckets || {};
const RISK_DIST     = RAW_DATA.risk_distribution || {};
const TOP10         = RAW_DATA.top10     || [];

/* ── chat history ────────────────────────────────────────────────────────── */
let chatHistory = [];

/* ═══════════════════════════════════════════════════════════════════════════
   MARKDOWN → HTML RENDERER
   Converts AI markdown responses into clean, styled HTML bubbles.
   ═══════════════════════════════════════════════════════════════════════════ */
function renderMarkdown(text) {
  if (!text) return "";

  // If the text already looks like HTML (starts with a tag), return as-is
  if (/^\s*<[a-z]/i.test(text)) return text;

  const lines = text.split("\n");
  let html = "";
  let inOL = false;
  let inUL = false;

  const closeList = () => {
    if (inOL) { html += "</ol>"; inOL = false; }
    if (inUL) { html += "</ul>"; inUL = false; }
  };

  const inlineFormat = (s) => s
    // **bold**
    .replace(/\*\*(.*?)\*\*/g, '<strong style="color:var(--accent-light)">$1</strong>')
    // *italic*
    .replace(/\*(.*?)\*/g, '<em>$1</em>')
    // `code`
    .replace(/`([^`]+)`/g, '<code style="background:rgba(255,255,255,.08);padding:1px 5px;border-radius:4px;font-size:12px">$1</code>')
    // currency shorthand
    .replace(/Rs\./g, "₹");

  for (let i = 0; i < lines.length; i++) {
    const raw  = lines[i];
    const line = raw.trim();

    // Empty line → paragraph break
    if (!line) {
      closeList();
      html += "<br>";
      continue;
    }

    // ### Heading
    if (/^#{1,3}\s+/.test(line)) {
      closeList();
      const content = inlineFormat(line.replace(/^#{1,3}\s+/, ""));
      html += `<div style="font-family:var(--font-display);font-weight:700;font-size:13px;color:var(--accent-light);margin:10px 0 5px 0">${content}</div>`;
      continue;
    }

    // **Bold line acting as a header** (entire line is bold)
    if (/^\*\*[^*]+\*\*:?\s*$/.test(line)) {
      closeList();
      const content = inlineFormat(line);
      html += `<div style="font-weight:600;color:var(--accent-light);margin:8px 0 3px 0">${content}</div>`;
      continue;
    }

    // Numbered list: "1. item" or "1) item"
    if (/^\d+[.)]\s+/.test(line)) {
      if (inUL) { html += "</ul>"; inUL = false; }
      if (!inOL) {
        html += `<ol style="margin:6px 0;padding-left:20px;display:flex;flex-direction:column;gap:3px">`;
        inOL = true;
      }
      const content = inlineFormat(line.replace(/^\d+[.)]\s+/, ""));
      html += `<li style="font-size:13px;line-height:1.55">${content}</li>`;
      continue;
    }

    // Unordered list: "- item" or "• item" or "* item"
    if (/^[-•*]\s+/.test(line)) {
      if (inOL) { html += "</ol>"; inOL = false; }
      if (!inUL) {
        html += `<ul style="margin:6px 0;padding-left:18px;display:flex;flex-direction:column;gap:3px">`;
        inUL = true;
      }
      const content = inlineFormat(line.replace(/^[-•*]\s+/, ""));
      html += `<li style="font-size:13px;line-height:1.55">${content}</li>`;
      continue;
    }

    // Regular paragraph line
    closeList();
    html += `<span style="display:block;margin-bottom:2px">${inlineFormat(line)}</span>`;
  }

  closeList();

  // Clean up multiple consecutive <br> tags
  html = html.replace(/(<br>\s*){3,}/g, "<br><br>");
  // Remove leading/trailing <br>
  html = html.replace(/^(<br>)+|(<br>)+$/g, "");

  return html;
}

/* ═══════════════════════════════════════════════════════════════════════════
   INIT
   ═══════════════════════════════════════════════════════════════════════════ */
document.addEventListener("DOMContentLoaded", () => {
  bootChat();
  wireKeys();
});

/* ═══════════════════════════════════════════════════════════════════════════
   1. NATURAL LANGUAGE QUERY ENGINE
   ═══════════════════════════════════════════════════════════════════════════ */
window.quickQuery = function(el) {
  document.getElementById("nlInput").value = el.textContent.trim();
  runNLQuery();
};

window.runNLQuery = async function() {
  const query = document.getElementById("nlInput").value.trim();
  const btn   = document.getElementById("nlBtn");
  const panel = document.getElementById("nlResult");

  if (!query) return;

  btn.disabled = true;
  btn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> Querying...`;
  panel.className = "nl-result";
  panel.innerHTML = "";

  try {
    const html = await nlQuery(query);
    panel.innerHTML = html;
    panel.className = "nl-result show";
  } catch (e) {
    panel.innerHTML = `<div class="err-msg"><i class="fas fa-exclamation-triangle"></i> ${e.message}</div>`;
    panel.className = "nl-result show";
  } finally {
    btn.disabled = false;
    btn.innerHTML = `<i class="fas fa-bolt"></i> Query`;
  }
};

async function nlQuery(query) {
  const system = `You are a data analyst for an SAP Vendor Risk Monitoring system.
Answer the user's question using ONLY the vendor data below.

${buildSnapshot(50)}

Rules:
- Respond in clean HTML only — no markdown, no code fences.
- Start with: <div class="nl-result-label">RESULT</div>
- For lists of vendors use: <table class="nl-result-table"><thead>...</thead><tbody>...</tbody></table>
- Currency in Indian format: use Cr for crores, L for lakhs, prefix with rupee symbol.
- Be concise. State how many records match when listing vendors.`;

  return await callAI([{ role: "user", content: query }], system, 4096);
}

/* ═══════════════════════════════════════════════════════════════════════════
   2. AI INSIGHT GENERATOR
   ═══════════════════════════════════════════════════════════════════════════ */
window.generateInsights = async function() {
  const btn   = document.getElementById("insightBtn");
  const body  = document.getElementById("insightsBody");
  const empty = document.getElementById("insightsEmpty");

  btn.disabled = true;
  btn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> Analysing...`;
  if (empty) empty.style.display = "none";

  body.innerHTML = Array(6).fill(`<div class="shimmer"></div>`).join("");

  try {
    body.innerHTML = await buildInsights();
  } catch (e) {
    body.innerHTML = `<div class="err-msg"><i class="fas fa-exclamation-triangle"></i> ${e.message}</div>`;
  } finally {
    btn.disabled = false;
    btn.innerHTML = `<i class="fas fa-sync-alt"></i> Regenerate`;
  }
};

async function buildInsights() {
  const system = `You are a senior finance risk analyst writing a CFO briefing.
Analyse the vendor risk data below and return EXACTLY 6 insight objects as a JSON array.

${buildSnapshot(30)}

Each object must have exactly these keys:
  "icon"  - one of: fire, exclamation-triangle, chart-line, coins, calendar-alt, users, shield-alt, map-marker-alt
  "color" - one of: red, orange, amber, blue, green, purple
  "text"  - 1 to 2 sentences; wrap key numbers or names in HTML strong tags

Example output:
[{"icon":"fire","color":"red","text":"<strong>8%</strong> of vendors account for <strong>52%</strong> of total overdue."}]

Return ONLY the JSON array. No markdown. No explanation. No code fences.`;

  const raw     = await callAI([{ role: "user", content: "Generate the 6 insights now." }], system, 4096);
  const cleaned = raw.replace(/```json|```/gi, "").trim();

  let items;
  try {
    items = JSON.parse(cleaned);
  } catch (_) {
    const match = cleaned.match(/\[[\s\S]*\]/);
    if (!match) throw new Error("Could not parse AI response. Please try again.");
    items = JSON.parse(match[0]);
  }

  return items.map((item, i) => `
    <div class="insight-item" style="animation-delay:${i * 0.07}s">
      <div class="insight-icon ${item.color || "blue"}">
        <i class="fas fa-${item.icon || "lightbulb"}"></i>
      </div>
      <div class="insight-text">${item.text}</div>
    </div>`).join("");
}

/* ═══════════════════════════════════════════════════════════════════════════
   3. VENDOR RISK CHATBOT
   ═══════════════════════════════════════════════════════════════════════════ */
function bootChat() {
  const critical = VENDORS.filter(v => v.predicted_risk === "Critical").length;
  const topV     = TOP10[0];
  const totalOD  = fmt(KPI.total_overdue || 0);

  addBot(`Hello! I am your <strong>VendorRisk AI Assistant</strong>.<br><br>
Here is your portfolio snapshot:<br>
<ul style="margin:6px 0;padding-left:18px;display:flex;flex-direction:column;gap:4px">
  <li><strong style="color:var(--accent-light)">${KPI.total_vendors || 0}</strong> vendors analysed</li>
  <li><strong style="color:var(--accent-light)">${totalOD}</strong> total overdue exposure</li>
  <li><strong style="color:#ef4444">${critical}</strong> vendors flagged <strong style="color:#ef4444">Critical</strong></li>
  <li>Highest risk: <strong style="color:var(--accent-light)">${topV ? topV.vendor_name : "N/A"}</strong> (score ${topV ? topV.risk_score.toFixed(1) : "N/A"})</li>
</ul><br>
Ask me anything about vendor risk, payment priorities, or aging trends.`);

  showSugs(["Who needs immediate attention?", "Explain the risk scoring", "Which vendors to pay first?", "What is driving our overdue?"]);
}

window.sendChat = async function() {
  const inp  = document.getElementById("chatInp");
  const btn  = document.getElementById("sendBtn");
  const text = inp.value.trim();
  if (!text) return;

  inp.value    = "";
  btn.disabled = true;
  addUser(text);
  clearSugs();
  showTyping();

  chatHistory.push({ role: "user", content: text });
  if (chatHistory.length > 18) chatHistory = chatHistory.slice(-14);

  try {
    const raw   = await callAI(chatHistory, chatSystem(), 4096);
    const reply = renderMarkdown(raw);
    removeTyping();
    addBot(reply);
    chatHistory.push({ role: "assistant", content: raw });
    const sugs = followups(text, raw);
    if (sugs.length) showSugs(sugs);
  } catch (e) {
    removeTyping();
    addBot(`Sorry, I hit an error: <strong>${e.message}</strong> — please try again.`);
  } finally {
    btn.disabled = false;
  }
};

function chatSystem() {
  return `You are VendorRisk Assistant, an expert SAP Accounts Payable risk analyst chatbot.

${buildSnapshot(25)}

Rules:
- Reply using plain text with markdown formatting ONLY: **bold**, bullet lists with "- item", numbered lists with "1. item".
- Do NOT use HTML tags in your response.
- CRITICAL: Always complete your response fully. Never stop mid-sentence or mid-list. If listing vendors, finish the entire list.
- If a list would be very long, limit yourself to the top 5 items and say "(showing top 5)" — but always end with a complete sentence.
- Keep replies under 200 words unless a detailed list is needed; detailed lists may go up to 350 words.
- Use short sections with a bold heading then bullets below it.
- Currency in Indian rupee format (Cr, L).
- Always give a short actionable recommendation at the end.`;
}

function followups(q, r) {
  const s = (q + r).toLowerCase();
  if (s.includes("critical"))                       return ["Show critical vendor details", "How to reduce critical risk?"];
  if (s.includes("pay") || s.includes("priorit"))   return ["Top vendor overdue totals", "Show aging breakdown"];
  if (s.includes("score") || s.includes("risk"))    return ["What makes a vendor high risk?", "How is risk calculated?"];
  if (s.includes("aging") || s.includes("overdue")) return ["Vendors 120+ days overdue", "Overdue by risk level"];
  return [];
}

/* ── chat DOM helpers ──────────────────────────────────────────────────────── */
function addBot(html)  { addMsg("bot",  `<i class="fas fa-robot"></i>`, html); }
function addUser(text) { addMsg("user", `<i class="fas fa-user"></i>`,  esc(text)); }

function addMsg(role, av, body) {
  const c = document.getElementById("chatMsgs");
  const d = document.createElement("div");
  d.className = `msg ${role}`;
  d.innerHTML = `<div class="msg-av">${av}</div><div class="msg-bub">${body}</div>`;
  c.appendChild(d);
  c.scrollTop = c.scrollHeight;
}

function showTyping() {
  const c = document.getElementById("chatMsgs");
  const d = document.createElement("div");
  d.className = "msg bot";
  d.id        = "typingDot";
  d.innerHTML = `<div class="msg-av"><i class="fas fa-robot"></i></div>
    <div class="msg-bub"><div class="typing-ind">
      <div class="t-dot"></div><div class="t-dot"></div><div class="t-dot"></div>
    </div></div>`;
  c.appendChild(d);
  c.scrollTop = c.scrollHeight;
}
function removeTyping() { document.getElementById("typingDot")?.remove(); }

function showSugs(list) {
  document.getElementById("chatSuggest").innerHTML =
    list.map(s => `<button class="sug-btn" onclick="useSug(this)">${esc(s)}</button>`).join("");
}
function clearSugs() { document.getElementById("chatSuggest").innerHTML = ""; }
window.useSug = function(el) {
  document.getElementById("chatInp").value = el.textContent;
  sendChat();
};

function wireKeys() {
  document.getElementById("chatInp").addEventListener("keydown", e => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendChat(); }
  });
  document.getElementById("nlInput").addEventListener("keydown", e => {
    if (e.key === "Enter") { e.preventDefault(); runNLQuery(); }
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   FLASK PROXY CALL
   Primary  : /api/claude  →  OpenRouter  (arcee-ai/trinity-large-preview:free)
   Fallback : /api/gemini  →  Google Gemini (gemini-2.0-flash)
   On any rate-limit or server error from OpenRouter, the call is silently
   retried against Gemini — the user sees no interruption.
   ═══════════════════════════════════════════════════════════════════════════ */

/* Returns true for HTTP status codes that indicate a rate-limit or overload
   and that warrant a transparent retry on the fallback provider. */
function _isRateLimitError(status, data) {
  if (status === 429) return true;                       // Too Many Requests
  if (status === 503) return true;                       // Service Unavailable
  if (status === 529) return true;                       // OpenRouter overloaded
  // Some providers embed "rate limit" / "quota" text in a 400/500
  const errText = JSON.stringify(data || "").toLowerCase();
  if (errText.includes("rate limit"))  return true;
  if (errText.includes("quota"))       return true;
  if (errText.includes("overloaded"))  return true;
  if (errText.includes("limit exceeded")) return true;
  return false;
}

/* Low-level call to a single endpoint; resolves with the text or throws. */
async function _callEndpoint(endpoint, model, messages, systemPrompt, maxTokens) {
  const res = await fetch(endpoint, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model:      model,
      max_tokens: maxTokens,
      system:     systemPrompt,
      messages:   messages,
    }),
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    const msg = (data && data.error && (data.error.message || data.error)) ||
                ("Server error " + res.status);
    const err = new Error(msg);
    err.status = res.status;
    err.data   = data;
    throw err;
  }

  const text = (data.content || [])
    .filter(function(b) { return b.type === "text"; })
    .map(function(b)    { return b.text; })
    .join("");

  if (!text) {
    const err = new Error("Empty response from AI. Please try again.");
    err.status = 200; // got a response but empty — don't retry
    throw err;
  }

  return text;
}

async function callAI(messages, systemPrompt, maxTokens) {
  maxTokens = maxTokens || 4096;

  /* ── 1. Try primary: OpenRouter / trinity-large-preview ── */
  try {
    return await _callEndpoint(
      "/api/claude",
      "arcee-ai/trinity-large-preview:free",
      messages,
      systemPrompt,
      maxTokens
    );
  } catch (primaryErr) {
    /* Only fall through to Gemini on rate-limit / server-side overload */
    if (!_isRateLimitError(primaryErr.status, primaryErr.data)) {
      throw primaryErr; // real error — surface it immediately
    }
    /* Silent fallback — no visible indication to the user */
  }

  /* ── 2. Fallback: Google Gemini ── */
  return await _callEndpoint(
    "/api/gemini",
    "gemini-2.0-flash",
    messages,
    systemPrompt,
    maxTokens
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   DATA SNAPSHOT  – uses ai_context when available for richer, more accurate
   AI responses; falls back to the legacy KPI/vendor table otherwise.
   ═══════════════════════════════════════════════════════════════════════════ */

/* Top-level ai_context alias (populated by Flask if ml_model >= v2) */
const AI_CTX = RAW_DATA.ai_context || null;

/* ═══════════════════════════════════════════════════════════════════════════
   COMPUTED AGGREGATES — single source of truth, mirrors dashboard.js exactly
   All numbers are derived from the same VENDORS array the dashboard uses,
   so the chatbot and charts are guaranteed to match.
   ═══════════════════════════════════════════════════════════════════════════ */
const _AGG = (function() {
  var totalOverdue = 0, highRisk = 0, critical = 0;
  var riskOverdue  = { Critical: 0, High: 0, Medium: 0, Low: 0 };
  var riskCount    = { Critical: 0, High: 0, Medium: 0, Low: 0 };

  VENDORS.forEach(function(v) {
    var amt = Number(v.overdue_amount) || 0;
    totalOverdue += amt;
    if (v.predicted_risk === "High")     { highRisk++; }
    if (v.predicted_risk === "Critical") { critical++;  }
    if (riskOverdue[v.predicted_risk] !== undefined) {
      riskOverdue[v.predicted_risk] += amt;
      riskCount[v.predicted_risk]++;
    }
  });

  // Top 10 by overdue amount — same sort as dashboard Top-10 chart
  var top10ByOverdue = VENDORS.slice()
    .sort(function(a, b) { return b.overdue_amount - a.overdue_amount; })
    .slice(0, 10);

  // Top 10 by risk score — same sort as dashboard preview table
  var top10ByScore = VENDORS.slice()
    .sort(function(a, b) { return b.risk_score - a.risk_score; })
    .slice(0, 10);

  // Aging buckets — use backend invoice-level data (same source as chart)
  var aging = RAW_DATA.aging_buckets || {};

  return {
    totalVendors : VENDORS.length,
    totalOverdue : totalOverdue,
    highRisk     : highRisk,
    critical     : critical,
    riskOverdue  : riskOverdue,
    riskCount    : riskCount,
    top10ByOverdue: top10ByOverdue,
    top10ByScore  : top10ByScore,
    aging         : aging,
  };
})();

/* ═══════════════════════════════════════════════════════════════════════════
   buildSnapshot() — feeds every AI call with a full, consistent data view.
   The "maxVendors" param is kept for backwards compat but the full vendor
   list is always sent in a compact pipe-delimited format.
   ═══════════════════════════════════════════════════════════════════════════ */
function buildSnapshot(maxVendors) {

  /* ── KPIs (computed from VENDORS, same as dashboard) ────────────────────── */
  const kpiBlock =
    "=== KPIs (matches dashboard exactly) ===\n"
    + "Total vendors          : " + _AGG.totalVendors + "\n"
    + "Total overdue exposure : " + fmt(_AGG.totalOverdue) + "\n"
    + "High risk vendors      : " + _AGG.highRisk + "\n"
    + "Critical vendors       : " + _AGG.critical + "\n";

  /* ── Aging buckets (invoice-level from backend, same as aging chart) ──────── */
  const BUCKET_KEYS = ["0-30", "31-60", "61-90", "91-120", "120+"];
  const agingBlock =
    "=== Invoice Aging Buckets (per-invoice amounts — matches Aging chart) ===\n"
    + BUCKET_KEYS.map(function(k) {
        return "  " + k + " days: " + fmt(_AGG.aging[k] || 0);
      }).join("\n");

  /* ── Risk distribution (vendor counts — matches pie chart) ──────────────── */
  const distBlock =
    "=== Risk Distribution (vendor count — matches Risk Pie chart) ===\n"
    + ["Critical","High","Medium","Low"].map(function(r) {
        return "  " + r + ": " + (_AGG.riskCount[r] || 0) + " vendors";
      }).join("\n");

  /* ── Per-risk overdue totals (computed from VENDORS) ────────────────────── */
  const riskOverdueBlock =
    "\n=== Overdue Exposure by Risk Level ===\n"
    + ["Critical","High","Medium","Low"].map(function(r) {
        return "  " + r + ": " + fmt(_AGG.riskOverdue[r] || 0);
      }).join("\n");

  /* ── Top 10 by overdue amount (matches Top-10 bar chart) ────────────────── */
  const top10OverdueBlock =
    "\n=== Top 10 Vendors by Overdue Amount (matches dashboard chart) ===\n"
    + _AGG.top10ByOverdue.map(function(v, i) {
        return "  " + (i+1) + ". " + v.vendor_name + " (" + v.vendor_id + ")"
          + " | Overdue:" + fmt(v.overdue_amount)
          + " | Score:" + Number(v.risk_score).toFixed(1)
          + " | " + v.predicted_risk;
      }).join("\n");

  /* ── Top 10 by risk score (matches dashboard preview table) ─────────────── */
  const top10ScoreBlock =
    "\n=== Top 10 Vendors by Risk Score (matches dashboard table) ===\n"
    + _AGG.top10ByScore.map(function(v, i) {
        return "  " + (i+1) + ". " + v.vendor_name + " (" + v.vendor_id + ")"
          + " | Score:" + Number(v.risk_score).toFixed(1)
          + " | Overdue:" + fmt(v.overdue_amount)
          + " | " + v.predicted_risk
          + " | MaxDays:" + Math.round(v.max_days_overdue || 0);
      }).join("\n");

  /* ── Country & payment term breakdowns (from ai_context) ────────────────── */
  let countryBlock = "";
  if (AI_CTX && AI_CTX.country_distribution && Object.keys(AI_CTX.country_distribution).length) {
    countryBlock = "\n=== Overdue by Country (top 10) ===\n"
      + Object.entries(AI_CTX.country_distribution)
          .map(function(e) { return "  " + (e[0] || "Unknown") + ": " + fmt(e[1]); })
          .join("\n");
  }
  let ztermBlock = "";
  if (AI_CTX && AI_CTX.payment_terms_distribution && Object.keys(AI_CTX.payment_terms_distribution).length) {
    ztermBlock = "\n=== Payment Terms Distribution ===\n"
      + Object.entries(AI_CTX.payment_terms_distribution)
          .map(function(e) { return "  " + (e[0] || "Unknown") + ": " + e[1] + " vendors"; })
          .join("\n");
  }
  let bukrsBlock = "";
  if (AI_CTX && AI_CTX.company_code_distribution && Object.keys(AI_CTX.company_code_distribution).length) {
    bukrsBlock = "\n=== Overdue by Company Code ===\n"
      + Object.entries(AI_CTX.company_code_distribution)
          .map(function(e) { return "  " + (e[0] || "Unknown") + ": " + fmt(e[1]); })
          .join("\n");
  }

  /* ── Most overdue individual invoices (from ai_context) ─────────────────── */
  let invoiceBlock = "";
  if (AI_CTX && AI_CTX.top50_most_overdue_invoices && AI_CTX.top50_most_overdue_invoices.length) {
    invoiceBlock = "\n=== Top 20 Most Overdue Individual Invoices ===\n"
      + "  (vendor_id | amount | days_overdue | bucket)\n"
      + AI_CTX.top50_most_overdue_invoices.slice(0, 20).map(function(inv) {
          return "  " + (inv.vendor_id || "?")
            + " | " + fmt(inv.amount || 0)
            + " | " + Math.round(inv.days_overdue || 0) + "d"
            + " | " + (inv.aging_bucket || "?");
        }).join("\n");
  }

  /* ── Full vendor table — ALL vendors, compact format ────────────────────── */
  // Check if country/payment-term fields are present
  const sampleV  = VENDORS[0] || {};
  const hasExtra = !!(sampleV.country || sampleV.LAND1);
  const totalVend = VENDORS.length;
  const tableHeader = "\n=== Complete Vendor Table (" + totalVend + " vendors"
    + (hasExtra ? ", includes country & payment term" : "") + ") ===\n"
    + "Format: id|name|risk_level|score|overdue_amt|avg_days_OD|max_days_OD|invoices"
    + (hasExtra ? "|country|payment_term" : "") + "\n";

  const rows = VENDORS.map(function(v) {
    var base = (v.vendor_id || "?")
      + "|" + (v.vendor_name || "Unknown")
      + "|" + (v.predicted_risk || "?")
      + "|" + Number(v.risk_score || 0).toFixed(1)
      + "|" + Number(v.overdue_amount || 0).toFixed(0)
      + "|" + Number(v.avg_days_overdue || 0).toFixed(0)
      + "|" + Math.round(v.max_days_overdue || 0)
      + "|" + Math.round(v.total_invoices || 0);
    if (hasExtra) {
      base += "|" + (v.country || v.LAND1 || "?")
           +  "|" + (v.payment_term || v.ZTERM || v.zterm || "?");
    }
    return base;
  }).join("\n");

  let statsBlock = "";
  if (AI_CTX && AI_CTX.total_invoices_processed) {
    statsBlock = "\n=== Dataset Stats ===\n"
      + "  Total invoice lines processed: "
      + AI_CTX.total_invoices_processed.toLocaleString() + "\n";
  }

  return kpiBlock + "\n"
    + agingBlock + "\n"
    + distBlock
    + riskOverdueBlock + "\n"
    + top10OverdueBlock
    + top10ScoreBlock + "\n"
    + countryBlock
    + ztermBlock
    + bukrsBlock
    + statsBlock + "\n"
    + invoiceBlock
    + tableHeader
    + rows;
}
/* ── formatters ─────────────────────────────────────────────────────────── */
function fmt(n) {
  n = Number(n) || 0;
  if (n >= 1e9) return "\u20B9" + (n / 1e9).toFixed(2) + "B";
  if (n >= 1e7) return "\u20B9" + (n / 1e7).toFixed(2) + "Cr";
  if (n >= 1e5) return "\u20B9" + (n / 1e5).toFixed(2) + "L";
  return "\u20B9" + n.toLocaleString("en-IN", { maximumFractionDigits: 0 });
}

function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}