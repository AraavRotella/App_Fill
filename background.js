// background.js — service worker.
// Handles all calls to the Anthropic API: ambiguous field mapping,
// resume tailoring, and cold outreach drafting. Uses your own API key,
// stored locally, never sent anywhere but api.anthropic.com.

const HAIKU_MODEL = "claude-haiku-4-5-20251001";
const MAX_BULLET_CHARS = 165; // ~2 lines in Jake's template at 11pt
const MAX_TEXTBF_PER_BULLET = 1;

async function callClaude(apiKey, { system, prompt, maxTokens = 1200 }) {
  const body = {
    model: HAIKU_MODEL,
    max_tokens: maxTokens,
    messages: [{ role: "user", content: prompt }],
  };
  if (system) body.system = system;

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`API ${resp.status}: ${err.slice(0, 300)}`);
  }

  const data = await resp.json();
  return (data.content || []).map((c) => c.text || "").join("").trim();
}

// ============================================================================
// LaTeX bullet extraction / splice / validation
// (Used only when resumeText is LaTeX source. Plain-text resumes fall through
// to the whole-document rewrite path below, since they have no \resumeItem
// structure to splice into.)
// ============================================================================

/**
 * Find every \resumeItem{...} in the .tex source via brace counting, so
 * nested \textbf{...} and escapes (\&, \%, \~, \$, \{, \}) never break parsing.
 * Returns [{ bodyStart, bodyEnd, body }] — string indices into `tex`.
 */
function extractResumeItems(tex) {
  const items = [];
  const NEEDLE = "\\resumeItem";
  let i = 0;

  while (i < tex.length) {
    const hit = tex.indexOf(NEEDLE, i);
    if (hit === -1) break;

    // Must not be a longer command like \resumeItemListStart.
    const after = tex[hit + NEEDLE.length];
    if (after !== "{" && !/\s/.test(after || "")) {
      i = hit + NEEDLE.length;
      continue;
    }

    let j = hit + NEEDLE.length;
    while (j < tex.length && tex[j] !== "{") {
      if (!/\s/.test(tex[j])) { j = -1; break; }
      j++;
    }
    if (j === -1 || j >= tex.length) { i = hit + NEEDLE.length; continue; }

    const bodyStart = j + 1;
    let depth = 1;
    let k = bodyStart;
    while (k < tex.length && depth > 0) {
      const c = tex[k];
      if (c === "\\") { k += 2; continue; } // skip escaped char
      if (c === "{") depth++;
      else if (c === "}") depth--;
      if (depth === 0) break;
      k++;
    }
    if (depth !== 0) { i = hit + NEEDLE.length; continue; }

    items.push({ bodyStart, bodyEnd: k, body: tex.slice(bodyStart, k) });
    i = k + 1;
  }

  return items;
}

/** Replace bodies back-to-front so earlier indices stay valid. */
function spliceResumeItems(tex, items, newBodies) {
  if (items.length !== newBodies.length) {
    throw new Error(`splice length mismatch: ${items.length} vs ${newBodies.length}`);
  }
  let out = tex;
  for (let idx = items.length - 1; idx >= 0; idx--) {
    const { bodyStart, bodyEnd } = items[idx];
    out = out.slice(0, bodyStart) + newBodies[idx] + out.slice(bodyEnd);
  }
  return out;
}

function bracesBalanced(s) {
  let depth = 0;
  for (let k = 0; k < s.length; k++) {
    const c = s[k];
    if (c === "\\") { k++; continue; }
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth < 0) return false; }
  }
  return depth === 0;
}

function countOccurrences(s, sub) {
  let n = 0, pos = 0;
  while ((pos = s.indexOf(sub, pos)) !== -1) { n++; pos += sub.length; }
  return n;
}

/** True if `candidate` is a safe, non-fabricating replacement for `original`. */
function isValidBullet(candidate, original) {
  if (typeof candidate !== "string" || candidate.trim() === "") return false;
  if (candidate.length > MAX_BULLET_CHARS) return false;
  if (!bracesBalanced(candidate)) return false;
  if (countOccurrences(candidate, "\\textbf") > MAX_TEXTBF_PER_BULLET) return false;

  // A bare & % $ (not preceded by \) will crash pdflatex.
  if (/(^|[^\\])[&%$]/.test(candidate)) return false;

  // No new LaTeX commands beyond \textbf.
  const cmds = (s) => (s.match(/\\[a-zA-Z]+/g) || []).filter((c) => c !== "\\textbf").sort();
  if (JSON.stringify(cmds(candidate)) !== JSON.stringify(cmds(original))) return false;

  // Metric traceability: any number in the candidate must also appear in the
  // original bullet (prevents a fabricated statistic slipping through).
  const nums = (s) => (s.match(/\d[\d,.]*%?/g) || []);
  const candNums = nums(candidate);
  const origNums = nums(original);
  for (const n of candNums) {
    if (!origNums.includes(n)) return false;
  }

  return true;
}

const LATEX_TAILOR_SYSTEM_PROMPT = `You tailor existing resume bullets to a target job description. Rules:
- Never fabricate. Only reword, reorder, or re-emphasize facts already in the bullet. No new numbers, tools, or claims.
- Every number in your output must already appear in that same bullet's original text (verbatim or a trivial unit conversion). If a bullet has no number, keep it qualitative — do not invent one.
- Mirror the job posting's terminology only where it honestly matches what the bullet already describes.
- Active verbs, implied first person, never "we".
- Keep each bullet under ${MAX_BULLET_CHARS} characters (about 2 lines).
- Bold at most one key metric or keyword per bullet, using \\textbf{...}.
- These are LaTeX strings. Preserve every backslash-escape exactly: \\& \\% \\~ \\$ and sequences like "70\\% -> 80\\%" or "\\~\\$3.5K" are literal and must stay intact.
- Do not add or remove LaTeX commands beyond a single optional \\textbf{...}.
Return ONLY a JSON array of the rewritten bullet strings, same length and order as the input. No prose, no markdown fences.`;

/**
 * Surgical tailoring for LaTeX resumes: extract \resumeItem bodies, ask
 * Haiku to rewrite only those strings, validate each, splice back.
 * A bullet that fails validation silently falls back to its original text —
 * this path can never hand back a document that won't compile.
 */
async function tailorLatexResume({ apiKey, resumeText, jobText, jobTitle }) {
  const items = extractResumeItems(resumeText);
  if (items.length === 0) {
    return null; // no \resumeItem structure found; caller should fall back
  }

  const originals = items.map((it) => it.body);

  const userContent =
    `JOB POSTING${jobTitle ? ` (${jobTitle})` : ""}:\n"""\n${jobText.slice(0, 6000)}\n"""\n\n` +
    `RESUME BULLETS (JSON array, rewrite each in place):\n${JSON.stringify(originals, null, 2)}`;

  const text = await callClaude(apiKey, {
    system: LATEX_TAILOR_SYSTEM_PROMPT,
    prompt: userContent,
    maxTokens: 2500,
  });

  const clean = text.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  let rewritten;
  try {
    rewritten = JSON.parse(clean);
  } catch {
    return null; // malformed response; caller should fall back
  }
  if (!Array.isArray(rewritten) || rewritten.length !== originals.length) {
    return null;
  }

  const changeLog = [];
  const finalBodies = originals.map((orig, idx) => {
    const cand = rewritten[idx];
    if (isValidBullet(cand, orig)) {
      if (cand !== orig) changeLog.push(`Bullet ${idx + 1}: tailored to job posting.`);
      return cand;
    }
    changeLog.push(`Bullet ${idx + 1}: kept original (edit failed a safety check).`);
    return orig;
  });

  const newTex = spliceResumeItems(resumeText, items, finalBodies);
  if (!bracesBalanced(newTex)) return null; // belt-and-suspenders; caller falls back

  return {
    result: newTex,
    changes: changeLog.join("\n") || "No changes — all bullets already matched well.",
  };
}

// ============================================================================
// Whole-document rewrite (plain-text resumes, and LaTeX fallback if the
// surgical path above can't run — e.g. a template with no \resumeItem)
// ============================================================================

async function tailorWholeResume({ apiKey, resumeText, jobText, jobTitle, isLatex }) {
  const latexRules = `
- The input is LaTeX source. Output must be the COMPLETE, valid, compilable .tex source — same preamble, same packages, same commands, same overall structure and layout.
- Only edit the TEXT INSIDE existing \\item / bullet commands and section content. Do not add, remove, or restructure LaTeX commands, environments, or sections.
- Do not change fonts, spacing commands, margins, or any layout-affecting code.
- Weave in keywords from the job posting only where they honestly describe content already present in a bullet.
- Output ONLY the raw .tex source, starting with \\documentclass, inside a block that starts with "===RESUME===" and ends with "===END_RESUME===". No markdown code fences inside that block.`;

  const plainRules = `
- Keep the same overall structure and length as the original resume.
- Output the full tailored resume in clean plain text, ready to paste, inside a block that starts with "===RESUME===" and ends with "===END_RESUME===". No markdown formatting symbols.`;

  const prompt = `You are an expert resume editor helping a candidate tailor their resume to a specific job posting, without fabricating anything.

JOB POSTING${jobTitle ? ` (${jobTitle})` : ""}:
"""
${jobText.slice(0, 6000)}
"""

CANDIDATE'S CURRENT RESUME${isLatex ? " (LaTeX source)" : ""}:
"""
${resumeText.slice(0, 8000)}
"""

Rewrite the resume to better match this job posting. Rules:
- Do NOT invent experience, skills, or projects that aren't in the original resume.
- METRIC TRACEABILITY (strict): every number in your output — percentage, count, dollar figure, time saved, scale, etc. — must appear verbatim, or as a trivial unit conversion, somewhere in the candidate's original resume text above. If a bullet has no metric in the original and you cannot find one to legitimately surface, leave it as a qualitative bullet. Never add a plausible-sounding number that isn't traceable to the original.
- STAR STRUCTURE: for each bullet, preserve whatever Situation/Task, Action, and Result structure already exists. You may sharpen the Action verb or reorder clauses for clarity, but do not add a Result clause (an outcome or metric) that the original bullet didn't already have.
- Reorder and re-emphasize existing bullets so the most relevant ones lead.
- Mirror key terminology from the job posting only where the candidate's real experience genuinely supports it.
${isLatex ? latexRules : plainRules}

After the resume block, output a change log inside a block that starts with "===CHANGES===" and ends with "===END_CHANGES===". For each bullet you modified, one line in the format:
"<section> — <short description of what changed and why>. Metric check: <the exact number used, quoted from the original, OR "no metric added">"
Keep each line under 25 words. This log is for the candidate to audit your edits, so be precise and honest, including if you made no changes.`;

  const text = await callClaude(apiKey, { prompt, maxTokens: 3400 });

  const resumeMatch = text.match(/===RESUME===([\s\S]*?)===END_RESUME===/);
  const changesMatch = text.match(/===CHANGES===([\s\S]*?)===END_CHANGES===/);
  return {
    result: resumeMatch ? resumeMatch[1].trim() : text.trim(),
    changes: changesMatch ? changesMatch[1].trim() : null,
  };
}

// ============================================================================
// Message router
// ============================================================================

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // ---------- Ambiguous field -> profile key mapping ----------
  if (msg.action === "aiMap") {
    (async () => {
      try {
        const { apiKey, fields, profileKeys } = msg;
        if (!apiKey) return sendResponse({ aiMap: {} });

        const unmatched = fields.filter((f) => !f.matched);
        if (unmatched.length === 0) return sendResponse({ aiMap: {} });

        const prompt = `You are mapping job-application form fields to a user's saved profile keys.

Available profile keys: ${profileKeys.join(", ")}

Form fields (JSON):
${JSON.stringify(
          unmatched.map((f) => ({
            index: f.index,
            label: f.label,
            name: f.name,
            type: f.type,
            options: f.options,
          })),
          null,
          0
        )}

Respond ONLY with a JSON object mapping field index (string) to a profile key.
If a field is a select/radio and the right answer is obvious from a profile key's meaning (e.g. work authorization = "Yes"), you may map it to a literal option string instead.
If you cannot confidently map a field, omit it. No markdown, no explanation.`;

        const text = await callClaude(apiKey, { prompt, maxTokens: 1000 });
        let aiMap = {};
        try {
          aiMap = JSON.parse(text.replace(/```json|```/g, "").trim());
        } catch {
          /* fail soft */
        }
        sendResponse({ aiMap });
      } catch (e) {
        sendResponse({ aiMap: {}, error: String(e) });
      }
    })();
    return true;
  }

  // ---------- Resume tailoring ----------
  if (msg.action === "tailorResume") {
    (async () => {
      try {
        const { apiKey, resumeText, jobText, jobTitle } = msg;
        if (!apiKey) return sendResponse({ error: "No API key set." });
        if (!resumeText) return sendResponse({ error: "Paste your resume text in the popup first." });

        const isLatex = /\\documentclass|\\begin\{document\}/.test(resumeText);

        if (isLatex) {
          try {
            const surgical = await tailorLatexResume({ apiKey, resumeText, jobText, jobTitle });
            if (surgical) {
              return sendResponse({ result: surgical.result, changes: surgical.changes, isLatex: true });
            }
            // surgical path declined (no \resumeItem found, or model output unusable) — fall back below
          } catch (e) {
            console.warn("AppFill: surgical LaTeX tailoring failed, falling back:", e);
          }
        }

        const whole = await tailorWholeResume({ apiKey, resumeText, jobText, jobTitle, isLatex });
        sendResponse({ result: whole.result, changes: whole.changes, isLatex });
      } catch (e) {
        sendResponse({ error: String(e) });
      }
    })();
    return true;
  }

  // ---------- Cold outreach drafting ----------
  if (msg.action === "coldOutreach") {
    (async () => {
      try {
        const { apiKey, profile, jobText, jobTitle, company, url } = msg;
        if (!apiKey) return sendResponse({ error: "No API key set." });

        const profileSummary = Object.entries(profile)
          .filter(([k]) => k !== "apiKey" && k !== "resumeText")
          .map(([k, v]) => `${k}: ${v}`)
          .join("\n");

        const prompt = `You are helping a job candidate draft cold outreach messages related to a specific job posting they're applying to.

JOB POSTING${jobTitle ? ` (${jobTitle})` : ""}${company ? ` at ${company}` : ""}${url ? ` — ${url}` : ""}:
"""
${jobText.slice(0, 4000)}
"""

CANDIDATE PROFILE:
"""
${profileSummary}
"""

Write two short, natural, non-generic drafts a real person would actually send:
1. A LinkedIn connection request message (under 300 characters) to someone at the company (e.g. a recruiter, alum, or engineer on the relevant team) — warm, specific to the role, no cliches like "I'd love to pick your brain."
2. A brief referral/introduction email (3-5 sentences) to a personal contact who works at or is connected to the company, asking for a referral or introduction, referencing something concrete from the job posting and the candidate's real, relevant background.

Output format exactly:
LINKEDIN MESSAGE:
<text>

REFERRAL EMAIL:
Subject: <subject>
<body>

No other commentary.`;

        const text = await callClaude(apiKey, { prompt, maxTokens: 900 });
        sendResponse({ result: text });
      } catch (e) {
        sendResponse({ error: String(e) });
      }
    })();
    return true;
  }
});