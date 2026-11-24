// Builds data/news.json once a day (run by the scheduled GitHub Action).
// Usage: node tools/fetch-news.mjs [outFile]
import { writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const AI_RE = /\b(ai|a\.i\.|llms?|gpt[-\w]*|claude|gemini|llama|mistral|openai|anthropic|deepmind|hugging ?face|transformer|neural|machine learning|ml|deep learning|agents?|agentic|rag|embedding|diffusion|inference|fine-?tun\w*|copilot|cursor|model|models|prompt\w*|token\w*|vector|gpu|nvidia|reasoning|chatbot|mcp)\b/i;
const PROG_RE = /\b(code|coding|programm\w*|developer|engineer\w*|rust|python|typescript|javascript|go|compiler|open source|github|api|sdk|framework|database|kubernetes|benchmark|library|tool\w*|ide|terminal)\b/i;

export async function buildNews({ fetchImpl = fetch, now = Date.now() } = {}) {
  async function getJSON(url, ms = 15000) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), ms);
    try {
      const headers = { Accept: "application/json", "User-Agent": "ai-brief-daily" };
      if (url.startsWith("https://api.github.com") && process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
      const r = await fetchImpl(url, { signal: ctl.signal, headers });
      if (!r.ok) throw new Error(`${url} -> ${r.status}`);
      return await r.json();
    } finally { clearTimeout(t); }
  }

  async function fromHN() {
    const since = Math.floor(now / 1000) - 36 * 3600;
    const d = await getJSON(`https://hn.algolia.com/api/v1/search?tags=story&numericFilters=created_at_i>${since},points>40&hitsPerPage=100`);
    return d.hits.filter((h) => h.title && AI_RE.test(h.title)).map((h) => ({
      id: "hn-" + h.objectID,
      cat: "news",
      source: "Hacker News",
      title: h.title,
      desc: h.url ? new URL(h.url).hostname.replace(/^www\./, "") : "Discussion",
      url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
      discuss: `https://news.ycombinator.com/item?id=${h.objectID}`,
      score: h.points + (h.num_comments || 0) * 0.5 + (PROG_RE.test(h.title) ? 60 : 0),
      meta: `▲ ${h.points} · ${h.num_comments || 0} comments`,
      ts: h.created_at_i * 1000,
    }));
  }

  async function fromHF() {
    const d = await getJSON("https://huggingface.co/api/daily_papers?limit=15");
    return d.map((p) => {
      const paper = p.paper || p;
      return {
        id: "hf-" + paper.id,
        cat: "research",
        source: "HF Papers",
        title: paper.title || p.title,
        desc: (paper.summary || p.summary || "").replace(/\s+/g, " ").trim(),
        url: `https://huggingface.co/papers/${paper.id}`,
        score: (paper.upvotes || 0) * 3 + 40,
        meta: `▲ ${paper.upvotes || 0} upvotes`,
        ts: Date.parse(p.publishedAt || paper.publishedAt) || now,
      };
    });
  }

  async function fromGitHub() {
    const since = new Date(now - 7 * 864e5).toISOString().slice(0, 10);
    const urls = ["topic:llm", "topic:ai-agents"].map((t) =>
      `https://api.github.com/search/repositories?q=${encodeURIComponent(`created:>${since} stars:>50 ${t}`)}&sort=stars&order=desc&per_page=10`);
    const res = await Promise.allSettled(urls.map((u) => getJSON(u)));
    if (res.every((r) => r.status === "rejected")) throw res[0].reason;
    const seen = new Set();
    return res.flatMap((r) => r.value?.items || []).filter((r) => !seen.has(r.id) && seen.add(r.id)).map((r) => ({
      id: "gh-" + r.id,
      cat: "repos",
      source: "GitHub",
      title: r.full_name,
      desc: r.description || "",
      url: r.html_url,
      score: Math.min(r.stargazers_count, 3000) / 6 + 30,
      meta: `★ ${r.stargazers_count.toLocaleString("en-US")} · ${r.language || "—"}`,
      ts: Date.parse(r.created_at),
    }));
  }

  async function fromDev() {
    const urls = ["https://dev.to/api/articles?tag=ai&top=2&per_page=12", "https://dev.to/api/articles?tag=machinelearning&top=3&per_page=8"];
    const res = await Promise.allSettled(urls.map((u) => getJSON(u)));
    if (res.every((r) => r.status === "rejected")) throw res[0].reason;
    const seen = new Set();
    return res.flatMap((r) => r.value || []).filter((x) => !seen.has(x.id) && seen.add(x.id)).map((x) => ({
      id: "dev-" + x.id,
      cat: "learn",
      source: "DEV",
      title: x.title,
      desc: x.description || "",
      url: x.url,
      score: (x.positive_reactions_count || 0) / 2 + 20,
      meta: `♥ ${x.positive_reactions_count || 0} · ${x.reading_time_minutes || "?"} min read`,
      ts: Date.parse(x.published_at),
    }));
  }

  const sources = [["Hacker News", fromHN], ["HF Papers", fromHF], ["GitHub", fromGitHub], ["DEV", fromDev]];
  const results = await Promise.allSettled(sources.map(([, fn]) => fn()));
  const failed = [];
  const items = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled") items.push(...r.value);
    else { failed.push(sources[i][0]); console.error(`[${sources[i][0]}]`, r.reason?.message || r.reason); }
  });
  return { generatedAt: now, items, failed };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const here = dirname(fileURLToPath(import.meta.url));
  const out = resolve(process.argv[2] || resolve(here, "../data/news.json"));
  const data = await buildNews();
  if (!data.items.length) { console.error("No stories from any source; not writing the file."); process.exit(1); }
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, JSON.stringify(data));
  console.log(`Wrote ${data.items.length} stories to ${out}` + (data.failed.length ? ` (failed: ${data.failed.join(", ")})` : ""));
}
