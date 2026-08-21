// popup.js — loads/saves the profile and orchestrates the fill:
// 1) inject content.js into the active tab
// 2) scan fields
// 3) (optional) ask Claude to map unmatched fields
// 4) fill

const inputs = () => Array.from(document.querySelectorAll("[data-k]"));
const statusEl = document.getElementById("status");
const fillBtn = document.getElementById("fillBtn");

function setStatus(text, cls = "") {
  statusEl.textContent = text;
  statusEl.className = cls;
}

// ---------- Profile persistence ----------

// Starting defaults, pre-filled only the first time (before you've ever saved
// your own profile). Edit these directly, or just overwrite in the popup and
// hit Save — your saved values always win after that.
const DEFAULTS = {
  firstName: "Araav",
  lastName: "Rotella",
  school: "University of Maryland, College Park",
  degree: "Bachelor of Science, Computer Science",
  minor: "Mathematics",
  gradDate: "May 2027",
  currentCompany: "Allegis Group",
  currentTitle: "AI/ML Intern",
  projects:
    "Pocket Vogue — full-stack AI wardrobe & outfit recommendation app (FastAPI, React, Supabase, CLIP embeddings, Gemini Flash API); built outfit generation with pgvector similarity search, multi-image upload, and a React swipe-card UI, deployed on Railway/Vercel. " +
    "Win Probability Model — ML/NLP model built during Allegis internship. " +
    "Content Moderation pipeline — NLP-based moderation across large datasets at Allegis. " +
    "Clario — Career Intelligence Pipeline using Snowflake stored procedures and CORTEX functions.",
};

async function loadProfile() {
  const { profile } = await chrome.storage.local.get("profile");
  const effective = profile || DEFAULTS; // only use defaults if nothing saved yet
  inputs().forEach((el) => {
    if (effective[el.dataset.k] != null) el.value = effective[el.dataset.k];
  });
  return effective;
}

async function saveProfile() {
  const profile = {};
  inputs().forEach((el) => {
    const v = el.value.trim();
    if (v) profile[el.dataset.k] = v;
  });
  await chrome.storage.local.set({ profile });
  const msg = document.getElementById("saveMsg");
  msg.style.opacity = 1;
  setTimeout(() => (msg.style.opacity = 0), 1500);
  return profile;
}

document.getElementById("saveBtn").addEventListener("click", saveProfile);
loadProfile();

// ---------- Fill orchestration ----------

function sendToTab(tabId, message) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, message, (resp) => {
      if (chrome.runtime.lastError) resolve(null);
      else resolve(resp);
    });
  });
}

function sendToBackground(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (resp) => {
      if (chrome.runtime.lastError) resolve({ aiMap: {} });
      else resolve(resp || { aiMap: {} });
    });
  });
}

fillBtn.addEventListener("click", async () => {
  fillBtn.disabled = true;
  try {
    const profile = await saveProfile(); // always fill with what's on screen
    const { apiKey, ...profileData } = profile;

    if (Object.keys(profileData).length === 0) {
      setStatus("Fill in your profile below first, then save.", "warn");
      return;
    }

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !/^https?:/.test(tab.url || "")) {
      setStatus("Open a job application page first.", "warn");
      return;
    }

    // Inject content script (idempotent)
    await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      files: ["content.js"],
    });

    setStatus("Scanning page…");
    const scan = await sendToTab(tab.id, { action: "scan" });
    if (!scan || !scan.fields?.length) {
      setStatus("No fillable fields found on this page.", "warn");
      return;
    }

    // Optional AI mapping for unmatched fields
    let aiMap = {};
    const unmatchedCount = scan.fields.filter((f) => !f.matched).length;
    if (apiKey && unmatchedCount > 0) {
      setStatus(`Mapping ${unmatchedCount} tricky field(s) with Claude…`);
      const resp = await sendToBackground({
        action: "aiMap",
        apiKey,
        fields: scan.fields,
        profileKeys: Object.keys(profileData),
      });
      aiMap = resp.aiMap || {};
      if (resp.error) console.warn("AppFill AI mapping:", resp.error);
    }

    setStatus("Filling…");
    const result = await sendToTab(tab.id, {
      action: "fill",
      profile: profileData,
      aiMap,
    });

    if (result) {
      setStatus(
        `Filled ${result.filled} of ${result.total} fields. Review before submitting — resume uploads and some dropdowns need a manual touch.`,
        "ok"
      );
    } else {
      setStatus("Couldn't reach the page. Refresh it and try again.", "warn");
    }
  } finally {
    fillBtn.disabled = false;
  }
});

// ---------- Shared: get job posting context off the active tab ----------

async function getJobContext() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !/^https?:/.test(tab.url || "")) return null;
  await chrome.scripting.executeScript({
    target: { tabId: tab.id, allFrames: false },
    files: ["content.js"],
  });
  const ctx = await sendToTab(tab.id, { action: "scrapeJD" });
  return ctx;
}

function showResult(title, text, filename, hint) {
  document.getElementById("resultTitle").textContent = title;
  document.getElementById("resultText").value = text;
  document.getElementById("resultPanel").style.display = "block";
  document.getElementById("downloadBtn").dataset.filename = filename || "appfill-result.txt";
  const hintEl = document.getElementById("resultHint");
  if (hint) {
    hintEl.textContent = hint;
    hintEl.style.display = "block";
  } else {
    hintEl.style.display = "none";
  }
}

function downloadText(filename, text) {
  const blob = new Blob([text], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

document.getElementById("downloadBtn").addEventListener("click", (e) => {
  const filename = e.currentTarget.dataset.filename || "appfill-result.txt";
  downloadText(filename, document.getElementById("resultText").value);
});

document.getElementById("closeResultBtn").addEventListener("click", () => {
  document.getElementById("resultPanel").style.display = "none";
});

document.getElementById("copyBtn").addEventListener("click", async () => {
  const text = document.getElementById("resultText").value;
  await navigator.clipboard.writeText(text);
  const btn = document.getElementById("copyBtn");
  const original = btn.textContent;
  btn.textContent = "Copied ✓";
  setTimeout(() => (btn.textContent = original), 1200);
});

// ---------- Tailor resume to this job ----------

const tailorBtn = document.getElementById("tailorBtn");
tailorBtn.addEventListener("click", async () => {
  tailorBtn.disabled = true;
  try {
    const profile = await saveProfile();
    if (!profile.apiKey) {
      setStatus("Add an Anthropic API key under AI mapping first — resume tailoring needs it.", "warn");
      return;
    }
    if (!profile.resumeText) {
      setStatus("Paste your resume text in the profile first.", "warn");
      return;
    }
    setStatus("Reading the job posting…");
    const ctx = await getJobContext();
    if (!ctx) {
      setStatus("Open the job posting page first.", "warn");
      return;
    }
    setStatus("Tailoring your resume with Claude…");
    const resp = await sendToBackground({
      action: "tailorResume",
      apiKey: profile.apiKey,
      resumeText: profile.resumeText,
      jobText: ctx.text,
      jobTitle: ctx.pageTitle,
    });
    if (resp.error) {
      setStatus(`Couldn't tailor resume: ${resp.error}`, "warn");
      return;
    }
    const filename = resp.isLatex ? "tailored_resume.tex" : "tailored_resume.txt";
    let hint = resp.isLatex
      ? "This is edited LaTeX source, not a PDF. Compile it at overleaf.com (upload → Recompile → Download PDF), or paste it back to me in chat and I'll compile it to PDF/DOCX directly."
      : "Plain text — paste into your resume template.";
    if (resp.changes) {
      hint += "\n\nChange log (verify every metric line before trusting it):\n" + resp.changes;
    } else {
      hint += "\n\nNo change log returned — diff this against your original manually before using it.";
    }
    showResult("Tailored resume — review before using", resp.result, filename, hint);
    setStatus("Done. Check the change log below, then review before sending it anywhere.", "ok");
  } finally {
    tailorBtn.disabled = false;
  }
});

// ---------- Score my fit for this job ----------

function scoreColor(score) {
  if (score == null) return "var(--muted)";
  if (score >= 75) return "#5eead4"; // accent teal
  if (score >= 50) return "#fbbf24"; // amber
  return "#f87171"; // red
}

const scoreBtn = document.getElementById("scoreBtn");
scoreBtn.addEventListener("click", async () => {
  scoreBtn.disabled = true;
  try {
    const profile = await saveProfile();
    const { apiKey, resumeText, ...profileData } = profile;
    if (!apiKey) {
      setStatus("Add an Anthropic API key under AI mapping first — scoring needs it.", "warn");
      return;
    }
    if (!resumeText && Object.keys(profileData).length === 0) {
      setStatus("Fill in your profile or paste your resume first.", "warn");
      return;
    }
    setStatus("Reading the job posting…");
    const ctx = await getJobContext();
    if (!ctx) {
      setStatus("Open the job posting page first.", "warn");
      return;
    }
    setStatus("Scoring your fit with Claude…");
    const resp = await sendToBackground({
      action: "matchScore",
      apiKey,
      resumeText,
      profile: profileData,
      jobText: ctx.text,
      jobTitle: ctx.pageTitle,
      company: ctx.company,
    });
    if (resp.error) {
      setStatus(`Couldn't score this job: ${resp.error}`, "warn");
      return;
    }

    const badge = document.getElementById("scoreBadge");
    const body = document.getElementById("scoreBody");
    const panel = document.getElementById("scorePanel");
    const title = document.getElementById("scoreTitle");

    badge.textContent = resp.score != null ? `${resp.score}/100` : "—";
    badge.style.color = scoreColor(resp.score);
    body.textContent = (resp.raw || "").replace(/^SCORE:\s*\d+\s*/i, "").trim();
    title.textContent = ctx.pageTitle ? `Match score — ${ctx.pageTitle}` : "Match score";
    panel.style.display = "block";

    setStatus("Done. This is a rough estimate, not a guarantee — use your judgment.", "ok");
  } finally {
    scoreBtn.disabled = false;
  }
});

document.getElementById("closeScoreBtn").addEventListener("click", () => {
  document.getElementById("scorePanel").style.display = "none";
});

// ---------- Draft cold outreach ----------

const outreachBtn = document.getElementById("outreachBtn");
outreachBtn.addEventListener("click", async () => {
  outreachBtn.disabled = true;
  try {
    const profile = await saveProfile();
    const { apiKey, ...profileData } = profile;
    if (!apiKey) {
      setStatus("Add an Anthropic API key under AI mapping first — outreach drafting needs it.", "warn");
      return;
    }
    setStatus("Reading the job posting…");
    const ctx = await getJobContext();
    if (!ctx) {
      setStatus("Open the job posting page first.", "warn");
      return;
    }
    setStatus("Drafting outreach messages with Claude…");
    const resp = await sendToBackground({
      action: "coldOutreach",
      apiKey,
      profile: profileData,
      jobText: ctx.text,
      jobTitle: ctx.pageTitle,
      company: ctx.company,
      url: ctx.url,
    });
    if (resp.error) {
      setStatus(`Couldn't draft outreach: ${resp.error}`, "warn");
      return;
    }
    showResult("Outreach drafts — personalize before sending", resp.result, "outreach_drafts.txt");
    setStatus("Done. Swap in the actual recipient's name before sending.", "ok");
  } finally {
    outreachBtn.disabled = false;
  }
});
