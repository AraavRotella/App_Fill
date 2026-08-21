// popup.js — loads/saves the profile and orchestrates the fill:
// 1) inject content.js into the active tab (ALL frames — Ashby's form lives
//    inside a nested iframe, not the top document)
// 2) scan fields across every frame and merge results
// 3) (optional) ask Claude to map unmatched fields
// 4) fill — broadcast to every frame; each frame only fills what it has

const inputs = () => Array.from(document.querySelectorAll("[data-k]"));
const statusEl = document.getElementById("status");
const fillBtn = document.getElementById("fillBtn");

function setStatus(text, cls = "") {
  statusEl.textContent = text;
  statusEl.className = cls;
}

// ---------- Profile persistence ----------

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
  const effective = profile || DEFAULTS;
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

// ---------- Cross-frame messaging ----------
// The page's real form can live inside a nested iframe (this is the case on
// Ashby-hosted applications: jobs.ashbyhq.com renders the form in a child
// frame, not the top document). chrome.tabs.sendMessage with no frameId only
// reaches the top frame, so we enumerate every frame the content script was
// injected into and message each one, merging the responses.

async function getAllFrameIds(tabId) {
  try {
    const frames = await chrome.webNavigation.getAllFrames({ tabId });
    return frames ? frames.map((f) => f.frameId) : [0];
  } catch {
    // webNavigation permission not present — fall back to top frame only
    return [0];
  }
}

function sendToFrame(tabId, frameId, message) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, message, { frameId }, (resp) => {
      if (chrome.runtime.lastError) resolve(null);
      else resolve(resp);
    });
  });
}

// Sends to every frame, returns only the responses that actually answered
// (a frame with no form on it will simply not respond meaningfully).
async function broadcast(tabId, message) {
  const frameIds = await getAllFrameIds(tabId);
  const results = await Promise.all(
    frameIds.map((frameId) => sendToFrame(tabId, frameId, message))
  );
  return results
    .map((resp, i) => ({ frameId: frameIds[i], resp }))
    .filter((r) => r.resp != null);
}

function sendToBackground(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (resp) => {
      if (chrome.runtime.lastError) resolve({ aiMap: {} });
      else resolve(resp || { aiMap: {} });
    });
  });
}

// ---------- Fill orchestration ----------

fillBtn.addEventListener("click", async () => {
  fillBtn.disabled = true;
  try {
    const profile = await saveProfile();
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

    // Inject into every frame — the actual form may be in a nested iframe.
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        files: ["content.js"],
      });
    } catch (e) {
      setStatus(`Couldn't inject script: ${e.message}`, "warn");
      return;
    }

    setStatus("Scanning page…");
    const scanResults = await broadcast(tab.id, { action: "scan" });

    // Merge fields from every frame that responded with any.
    const allFields = [];
    for (const { frameId, resp } of scanResults) {
      if (resp?.fields?.length) {
        resp.fields.forEach((f) => allFields.push({ ...f, __frameId: frameId }));
      }
    }

    if (allFields.length === 0) {
      setStatus("No fillable fields found on this page.", "warn");
      return;
    }

    // Optional AI mapping for unmatched fields (indices are per-frame, but
    // aiMap keys are just field indices — background.js doesn't care which
    // frame they came from, only content.js's own indices matter for filling).
    let aiMap = {};
    const unmatchedCount = allFields.filter((f) => !f.matched).length;
    if (apiKey && unmatchedCount > 0) {
      setStatus(`Mapping ${unmatchedCount} tricky field(s) with Claude…`);
      const resp = await sendToBackground({
        action: "aiMap",
        apiKey,
        fields: allFields,
        profileKeys: Object.keys(profileData),
      });
      aiMap = resp.aiMap || {};
      if (resp.error) console.warn("AppFill AI mapping:", resp.error);
    }

    setStatus("Filling…");
    // Broadcast fill to every frame that responded to scan. Each frame's
    // content.js only acts on the fields it collected itself, so sending the
    // same profile/aiMap to all of them is safe.
    const fillResults = await broadcast(tab.id, {
      action: "fill",
      profile: profileData,
      aiMap,
    });

    if (fillResults.length === 0) {
      setStatus("Couldn't reach the page. Refresh it and try again.", "warn");
      return;
    }

    const totals = fillResults.reduce(
      (acc, { resp }) => ({
        filled: acc.filled + (resp?.filled || 0),
        total: acc.total + (resp?.total || 0),
      }),
      { filled: 0, total: 0 }
    );

    setStatus(
      `Filled ${totals.filled} of ${totals.total} fields. Review before submitting — resume uploads and some dropdowns need a manual touch.`,
      "ok"
    );
  } finally {
    fillBtn.disabled = false;
  }
});

// ---------- Shared: get job posting context off the active tab ----------

async function getJobContext() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !/^https?:/.test(tab.url || "")) return null;

  await chrome.scripting.executeScript({
    target: { tabId: tab.id, allFrames: true },
    files: ["content.js"],
  });

  // Job description text usually lives on the top frame, but if the top
  // frame doesn't answer, fall back to whichever frame does.
  const results = await broadcast(tab.id, { action: "scrapeJD" });
  if (results.length === 0) return null;

  const top = results.find((r) => r.frameId === 0);
  const best = top || results.sort((a, b) => (b.resp?.text?.length || 0) - (a.resp?.text?.length || 0))[0];
  return best.resp;
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