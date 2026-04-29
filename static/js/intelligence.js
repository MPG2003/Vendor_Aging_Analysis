/* ═══════════════════════════════════════════════════════════════════════════
   SAP VRM — AI Intelligence  (intelligence.js)
   Feature: Vendor Risk Chatbot only.
   LLM calls go through Flask /api/claude proxy → OpenRouter.
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
   REASONING SCRUBBER
   Strips chain-of-thought / thinking blocks that some models leak.
   Patterns covered:
     <think>…</think>   (Deepseek, some Nemotron builds)
     <reasoning>…</reasoning>
     Bare lines that look like internal monologue before the real answer
   ═══════════════════════════════════════════════════════════════════════════ */
function scrubReasoning(text) {
  if (!text) return "";

  // Remove <think>…</think> blocks (may span multiple lines)
  text = text.replace(/<think>[\s\S]*?<\/think>/gi, "");
  // Remove <reasoning>…</reasoning> blocks
  text = text.replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, "");
  // Remove <reflection>…</reflection> blocks
  text = text.replace(/<reflection>[\s\S]*?<\/reflection>/gi, "");

  // Some models prefix with a "Scan list:" / "Let's extract…" monologue
  // before the actual structured answer. Detect and strip lines that look
  // like internal reasoning (heuristic: paragraph of plain sentences before
  // the first markdown heading or bullet list).
  const lines = text.split("\n");
  let answerStart = 0;
  let foundStructure = false;

  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    // Real answer starts at first heading, bullet, numbered item, or bold header
    if (/^#{1,3}\s+/.test(t) || /^[-•*]\s+/.test(t) || /^\d+[.)]\s+/.test(t) || /^\*\*/.test(t)) {
      answerStart  = i;
      foundStructure = true;
      break;
    }
  }

  // Only strip prefix monologue if the model produced structured content after it
  // AND the prefix is suspiciously long (> 4 lines of plain text)
  if (foundStructure && answerStart > 4) {
    text = lines.slice(answerStart).join("\n");
  }

  return text.trim();
}

/* ═══════════════════════════════════════════════════════════════════════════
   MARKDOWN → HTML RENDERER
   Handles: headings, bold, italic, code, ordered/unordered lists,
            pipe-delimited tables (| col | col |), and plain paragraphs.
   ═══════════════════════════════════════════════════════════════════════════ */
function renderMarkdown(text) {
  if (!text) return "";

  // If the text already looks like HTML (starts with a tag), return as-is
  if (/^\s*<[a-z]/i.test(text)) return text;

  // First scrub any reasoning bleed-through
  text = scrubReasoning(text);

  const lines = text.split("\n");
  let html   = "";
  let inOL   = false;
  let inUL   = false;
  let inTBL  = false;
  let tblRows = [];

  /* ── close any open list or table ─────────────────────────────────────── */
  const closeList = () => {
    if (inOL) { html += "</ol>"; inOL = false; }
    if (inUL) { html += "</ul>"; inUL = false; }
  };

  const flushTable = () => {
    if (!inTBL || tblRows.length === 0) { inTBL = false; tblRows = []; return; }
    // First row = header, second row = separator (skip), rest = body
    let thtml = `<div style="overflow-x:auto;margin:8px 0">
<table style="width:100%;border-collapse:collapse;font-size:12px">`;

    tblRows.forEach((row, idx) => {
      // Skip pure separator rows (---|---| pattern)
      if (/^[\s|:\-]+$/.test(row)) return;

      const cells = row.split("|").map(c => c.trim()).filter((_, i, a) => i > 0 && i < a.length - 1 || a.length > 1);
      // Remove empty first/last caused by leading/trailing pipe
      const clean = row.replace(/^\||\|$/g, "").split("|").map(c => c.trim());

      if (idx === 0) {
        // Header row
        thtml += "<thead><tr>"
          + clean.map(c => `<th style="padding:5px 8px;border-bottom:1px solid rgba(255,255,255,.15);text-align:left;color:var(--accent-light);white-space:nowrap">${inlineFormat(c)}</th>`).join("")
          + "</tr></thead><tbody>";
      } else {
        thtml += "<tr>"
          + clean.map((c, ci) => `<td style="padding:4px 8px;border-bottom:1px solid rgba(255,255,255,.07);${ci === 0 ? "color:var(--accent-light);white-space:nowrap" : ""}">${inlineFormat(c)}</td>`).join("")
          + "</tr>";
      }
    });

    thtml += "</tbody></table></div>";
    html  += thtml;
    inTBL  = false;
    tblRows = [];
  };

  const inlineFormat = (s) => s
    .replace(/\*\*(.*?)\*\*/g, '<strong style="color:var(--accent-light)">$1</strong>')
    .replace(/\*(.*?)\*/g,     '<em>$1</em>')
    .replace(/`([^`]+)`/g,     '<code style="background:rgba(255,255,255,.08);padding:1px 5px;border-radius:4px;font-size:12px">$1</code>')
    .replace(/Rs\./g, "₹");

  /* ── detect pipe-table row ─────────────────────────────────────────────── */
  const isPipeRow = (l) => /^\|.+\|/.test(l.trim()) || (l.trim().split("|").length > 2);

  for (let i = 0; i < lines.length; i++) {
    const raw  = lines[i];
    const line = raw.trim();

    /* ── pipe table ──────────────────────────────────────────────────────── */
    if (isPipeRow(line)) {
      closeList();
      if (!inTBL) inTBL = true;
      tblRows.push(line);
      continue;
    } else if (inTBL) {
      flushTable();
    }

    /* ── empty line ──────────────────────────────────────────────────────── */
    if (!line) {
      closeList();
      html += "<br>";
      continue;
    }

    /* ── headings ─────────────────────────────────────────────────────────── */
    if (/^#{1,3}\s+/.test(line)) {
      closeList();
      const content = inlineFormat(line.replace(/^#{1,3}\s+/, ""));
      html += `<div style="font-family:var(--font-display);font-weight:700;font-size:13px;color:var(--accent-light);margin:10px 0 5px 0">${content}</div>`;
      continue;
    }

    /* ── bold-only line acting as heading ─────────────────────────────────── */
    if (/^\*\*[^*]+\*\*:?\s*$/.test(line)) {
      closeList();
      const content = inlineFormat(line);
      html += `<div style="font-weight:600;color:var(--accent-light);margin:8px 0 3px 0">${content}</div>`;
      continue;
    }

    /* ── numbered list ────────────────────────────────────────────────────── */
    if (/^\d+[.)]\s+/.test(line)) {
      if (inUL) { html += "</ul>"; inUL = false; }
      if (!inOL) { html += `<ol style="margin:6px 0;padding-left:20px;display:flex;flex-direction:column;gap:3px">`; inOL = true; }
      const content = inlineFormat(line.replace(/^\d+[.)]\s+/, ""));
      html += `<li style="font-size:13px;line-height:1.55">${content}</li>`;
      continue;
    }

    /* ── unordered list ───────────────────────────────────────────────────── */
    if (/^[-•*]\s+/.test(line)) {
      if (inOL) { html += "</ol>"; inOL = false; }
      if (!inUL) { html += `<ul style="margin:6px 0;padding-left:18px;display:flex;flex-direction:column;gap:3px">`; inUL = true; }
      const content = inlineFormat(line.replace(/^[-•*]\s+/, ""));
      html += `<li style="font-size:13px;line-height:1.55">${content}</li>`;
      continue;
    }

    /* ── regular paragraph ────────────────────────────────────────────────── */
    closeList();
    html += `<span style="display:block;margin-bottom:2px">${inlineFormat(line)}</span>`;
  }

  /* close anything still open */
  closeList();
  flushTable();

  /* clean up excess <br> */
  html = html.replace(/(<br>\s*){3,}/g, "<br><br>");
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
   VENDOR RISK CHATBOT
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
    const raw     = await callAI(chatHistory, chatSystem(), 1200);
    const cleaned = scrubReasoning(raw);
    const reply   = renderMarkdown(cleaned);
    removeTyping();
    addBot(reply);
    chatHistory.push({ role: "assistant", content: cleaned });
    const sugs = followups(text, cleaned);
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
- For tabular data use a pipe-delimited markdown table: | Col | Col | with a separator row | --- | --- |
- Do NOT output any thinking, reasoning, or internal monologue. Only output the final answer.
- Do NOT wrap your answer in <think>, <reasoning>, or any XML tags.
- CRITICAL: Always complete your response fully. Never stop mid-sentence or mid-list. If listing vendors, finish the entire list.
- If a list would be very long, limit yourself to the top 5 items and say "(showing top 5)" — but always end with a complete sentence.
- Keep replies under 250 words unless a detailed table is needed; detailed tables may go up to 400 words.
- Use short sections with a bold heading then bullets or table below it.
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
}

/* ═══════════════════════════════════════════════════════════════════════════
   FLASK PROXY CALL  →  /api/claude  →  OpenRouter
   ═══════════════════════════════════════════════════════════════════════════ */
async function callAI(messages, systemPrompt, maxTokens) {
  maxTokens = maxTokens || 700;

  const res = await fetch("/api/claude", {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model:      "nvidia/nemotron-3-super:free",
      max_tokens: maxTokens,
      system:     systemPrompt,
      messages:   messages,
    }),
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    const msg = (data && data.error && (data.error.message || data.error)) || ("Server error " + res.status);
    throw new Error(msg);
  }

  const text = (data.content || [])
    .filter(function(b) { return b.type === "text"; })
    .map(function(b) { return b.text; })
    .join("");

  if (!text) throw new Error("Empty response from AI. Please try again.");
  return text;
}

/* ═══════════════════════════════════════════════════════════════════════════
   DATA SNAPSHOT
   ═══════════════════════════════════════════════════════════════════════════ */
const AI_CTX = RAW_DATA.ai_context || null;

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

  var top10ByOverdue = VENDORS.slice()
    .sort(function(a, b) { return b.overdue_amount - a.overdue_amount; })
    .slice(0, 10);

  var top10ByScore = VENDORS.slice()
    .sort(function(a, b) { return b.risk_score - a.risk_score; })
    .slice(0, 10);

  var aging = RAW_DATA.aging_buckets || {};

  return {
    totalVendors  : VENDORS.length,
    totalOverdue  : totalOverdue,
    highRisk      : highRisk,
    critical      : critical,
    riskOverdue   : riskOverdue,
    riskCount     : riskCount,
    top10ByOverdue: top10ByOverdue,
    top10ByScore  : top10ByScore,
    aging         : aging,
  };
})();

function buildSnapshot(maxVendors) {
  const kpiBlock =
    "=== KPIs ===\n"
    + "Total vendors          : " + _AGG.totalVendors + "\n"
    + "Total overdue exposure : " + fmt(_AGG.totalOverdue) + "\n"
    + "High risk vendors      : " + _AGG.highRisk + "\n"
    + "Critical vendors       : " + _AGG.critical + "\n";

  const BUCKET_KEYS = ["0-30", "31-60", "61-90", "91-120", "120+"];
  const agingBlock =
    "=== Invoice Aging Buckets ===\n"
    + BUCKET_KEYS.map(function(k) {
        return "  " + k + " days: " + fmt(_AGG.aging[k] || 0);
      }).join("\n");

  const distBlock =
    "=== Risk Distribution (vendor count) ===\n"
    + ["Critical","High","Medium","Low"].map(function(r) {
        return "  " + r + ": " + (_AGG.riskCount[r] || 0) + " vendors";
      }).join("\n");

  const riskOverdueBlock =
    "\n=== Overdue Exposure by Risk Level ===\n"
    + ["Critical","High","Medium","Low"].map(function(r) {
        return "  " + r + ": " + fmt(_AGG.riskOverdue[r] || 0);
      }).join("\n");

  const top10OverdueBlock =
    "\n=== Top 10 Vendors by Overdue Amount ===\n"
    + _AGG.top10ByOverdue.map(function(v, i) {
        return "  " + (i+1) + ". " + v.vendor_name + " (" + v.vendor_id + ")"
          + " | Overdue:" + fmt(v.overdue_amount)
          + " | Score:" + Number(v.risk_score).toFixed(1)
          + " | " + v.predicted_risk;
      }).join("\n");

  const top10ScoreBlock =
    "\n=== Top 10 Vendors by Risk Score ===\n"
    + _AGG.top10ByScore.map(function(v, i) {
        return "  " + (i+1) + ". " + v.vendor_name + " (" + v.vendor_id + ")"
          + " | Score:" + Number(v.risk_score).toFixed(1)
          + " | Overdue:" + fmt(v.overdue_amount)
          + " | " + v.predicted_risk
          + " | MaxDays:" + Math.round(v.max_days_overdue || 0);
      }).join("\n");

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

/* ── formatters ──────────────────────────────────────────────────────────── */
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