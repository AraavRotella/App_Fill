/* AI Brief — morning AI news + interview drills, with a spoken briefing. */
(() => {
  "use strict";

  // ---------- storage (safe) ----------
  const store = {
    get(k, d) { try { const v = localStorage.getItem("aib:" + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem("aib:" + k, JSON.stringify(v)); } catch {} },
    del(k) { try { localStorage.removeItem("aib:" + k); } catch {} },
  };

  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const todayKey = () => new Date().toISOString().slice(0, 10);
  const CACHE_MS = 30 * 60 * 1000;

  const settings = Object.assign(
    { name: "", voice: "", count: 8, focus: "", apiKey: "", rate: 1.0 },
    store.get("settings", {})
  );

  // ---------- header ----------
  function renderHeader() {
    const h = new Date().getHours();
    const part = h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
    $("#greet").textContent = settings.name ? `${part}, ${settings.name}` : part;
    $("#today").textContent = new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
  }

  function bumpStreak() {
    const s = store.get("streak", { last: null, n: 0 });
    const t = todayKey();
    if (s.last !== t) {
      const y = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
      s.n = s.last === y ? s.n + 1 : 1;
      s.last = t;
      store.set("streak", s);
    }
    $("#streak").textContent = `🔥 ${s.n}`;
  }

  // ---------- fetching ----------
  async function getJSON(url, ms = 9000) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), ms);
    try {
      const r = await fetch(url, { signal: ctl.signal, headers: { Accept: "application/json" } });
      if (!r.ok) throw new Error(r.status);
      return await r.json();
    } finally { clearTimeout(t); }
  }

  const AI_RE = /\b(ai|a\.i\.|llms?|gpt[-\w]*|claude|gemini|llama|mistral|openai|anthropic|deepmind|hugging ?face|transformer|neural|machine learning|ml|deep learning|agents?|agentic|rag|embedding|diffusion|inference|fine-?tun\w*|copilot|cursor|model|models|prompt\w*|token\w*|vector|gpu|nvidia|reasoning|chatbot|mcp)\b/i;
  const PROG_RE = /\b(code|coding|programm\w*|developer|engineer\w*|rust|python|typescript|javascript|go|compiler|open source|github|api|sdk|framework|database|kubernetes|benchmark|library|tool\w*|ide|terminal)\b/i;

  async function fromHN() {
    const since = Math.floor(Date.now() / 1000) - 36 * 3600;
    const d = await getJSON(`https://hn.algolia.com/api/v1/search?tags=story&numericFilters=created_at_i>${since},points>40&hitsPerPage=100`);
    return d.hits
      .filter((h) => h.title && AI_RE.test(h.title))
      .map((h) => ({
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
      const summary = (paper.summary || p.summary || "").replace(/\s+/g, " ").trim();
      return {
        id: "hf-" + paper.id,
        cat: "research",
        source: "HF Papers",
        title: paper.title || p.title,
        desc: summary,
        url: `https://huggingface.co/papers/${paper.id}`,
        score: (paper.upvotes || 0) * 3 + 40,
        meta: `▲ ${paper.upvotes || 0} upvotes`,
        ts: Date.parse(p.publishedAt || paper.publishedAt || Date.now()),
      };
    });
  }

  async function fromGitHub() {
    const since = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);
    const q = encodeURIComponent(`created:>${since} stars:>50 topic:llm`);
    const q2 = encodeURIComponent(`created:>${since} stars:>50 topic:ai-agents`);
    const [a, b] = await Promise.allSettled([
      getJSON(`https://api.github.com/search/repositories?q=${q}&sort=stars&order=desc&per_page=10`),
      getJSON(`https://api.github.com/search/repositories?q=${q2}&sort=stars&order=desc&per_page=10`),
    ]);
    const items = [...(a.value?.items || []), ...(b.value?.items || [])];
    const seen = new Set();
    return items.filter((r) => !seen.has(r.id) && seen.add(r.id)).map((r) => ({
      id: "gh-" + r.id,
      cat: "repos",
      source: "GitHub",
      title: r.full_name,
      desc: r.description || "",
      url: r.html_url,
      score: Math.min(r.stargazers_count, 3000) / 6 + 30,
      meta: `★ ${r.stargazers_count.toLocaleString()} · ${r.language || "—"}`,
      ts: Date.parse(r.created_at),
    }));
  }

  async function fromDev() {
    const [a, b] = await Promise.allSettled([
      getJSON("https://dev.to/api/articles?tag=ai&top=2&per_page=12"),
      getJSON("https://dev.to/api/articles?tag=machinelearning&top=3&per_page=8"),
    ]);
    const seen = new Set();
    return [...(a.value || []), ...(b.value || [])].filter((x) => !seen.has(x.id) && seen.add(x.id)).map((x) => ({
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

  function focusBoost(item) {
    const words = settings.focus.split(",").map((w) => w.trim().toLowerCase()).filter(Boolean);
    const hay = (item.title + " " + item.desc).toLowerCase();
    return words.some((w) => hay.includes(w)) ? 200 : 0;
  }

  let items = [];
  let filter = "all";

  async function loadNews(force = false) {
    const cached = store.get("news", null);
    if (!force && cached && Date.now() - cached.at < CACHE_MS) {
      items = cached.items;
      setStatus(cached);
      renderNews();
      return;
    }
    $("#newsStatus").textContent = "Fetching the latest…";
    const sources = [["Hacker News", fromHN], ["HF Papers", fromHF], ["GitHub", fromGitHub], ["DEV", fromDev]];
    const results = await Promise.allSettled(sources.map(([, fn]) => fn()));
    const failed = [];
    let all = [];
    results.forEach((r, i) => {
      if (r.status === "fulfilled") all = all.concat(r.value);
      else failed.push(sources[i][0]);
    });
    if (!all.length && cached) {
      items = cached.items;
      $("#newsStatus").textContent = "Offline — showing your last brief.";
      renderNews();
      return;
    }
    all.forEach((it) => (it.rank = it.score + focusBoost(it)));
    items = all;
    const payload = { at: Date.now(), items, failed };
    store.set("news", payload);
    setStatus(payload);
    renderNews();
    maybeCoach(force);
  }

  function setStatus(p) {
    const mins = Math.round((Date.now() - p.at) / 60000);
    let s = `${p.items.length} stories · updated ${mins < 1 ? "just now" : mins + " min ago"}`;
    if (p.failed && p.failed.length) s += ` · couldn't reach ${p.failed.join(", ")}`;
    $("#newsStatus").textContent = s;
  }

  // Interleave categories so the top of the feed is a good mix.
  function ranked() {
    const byCat = {};
    items.slice().sort((a, b) => b.rank - a.rank).forEach((it) => (byCat[it.cat] ||= []).push(it));
    if (filter !== "all") return byCat[filter] || [];
    const order = ["news", "news", "research", "repos", "news", "learn"];
    const out = [];
    let i = 0;
    while (Object.values(byCat).some((l) => l.length)) {
      const c = order[i++ % order.length];
      if (byCat[c]?.length) out.push(byCat[c].shift());
      else {
        const other = Object.keys(byCat).find((k) => byCat[k].length);
        if (other) out.push(byCat[other].shift());
      }
    }
    return out;
  }

  // ---------- saved / read ----------
  const saved = store.get("saved", {});
  const readSet = new Set(store.get("read", []));
  function markRead(id) { readSet.add(id); store.set("read", [...readSet].slice(-500)); }

  function cardHTML(it) {
    const isSaved = !!saved[it.id];
    return `<article class="card ${readSet.has(it.id) ? "read" : ""}" data-id="${esc(it.id)}">
      <div class="card-meta"><span class="badge ${it.cat}">${esc(it.source)}</span><span>${esc(it.meta || "")}</span></div>
      <a class="title" href="${esc(it.url)}" target="_blank" rel="noopener">${esc(it.title)}</a>
      ${it.desc ? `<div class="desc">${esc(it.desc)}</div>` : ""}
      <div class="card-actions">
        <button class="mini ${isSaved ? "on" : ""}" data-act="save">${isSaved ? "★ Saved" : "☆ Save"}</button>
        <button class="mini" data-act="listen">🔊 Listen</button>
        ${it.discuss ? `<a class="mini" href="${esc(it.discuss)}" target="_blank" rel="noopener" style="text-decoration:none">💬 Discuss</a>` : ""}
      </div>
    </article>`;
  }

  function renderNews() {
    const list = ranked();
    $("#newsList").innerHTML = list.length ? list.map(cardHTML).join("") : `<div class="empty">Nothing here yet. Pull refresh.</div>`;
    if (!speaking) buildQueue();
  }

  function renderSaved() {
    const list = Object.values(saved).sort((a, b) => b.savedAt - a.savedAt);
    $("#savedList").innerHTML = list.length ? list.map(cardHTML).join("") : `<div class="empty">Tap ☆ on a story to save it for later.</div>`;
  }

  function onCardClick(e) {
    const card = e.target.closest(".card");
    if (!card) return;
    const id = card.dataset.id;
    const it = items.find((x) => x.id === id) || saved[id];
    if (!it) return;
    if (e.target.closest("a.title")) { markRead(id); card.classList.add("read"); return; }
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (act === "save") {
      if (saved[id]) delete saved[id];
      else saved[id] = Object.assign({}, it, { savedAt: Date.now() });
      store.set("saved", saved);
      renderNews(); renderSaved();
    } else if (act === "listen") {
      speakOne(it);
    }
  }

  // ---------- interview drills ----------
  function seeded(seed) { let x = seed; return () => ((x = (x * 1664525 + 1013904223) >>> 0) / 4294967296); }
  const drillState = store.get("drill", { got: {}, review: {}, offset: 0 });

  function pickDrills() {
    const t = todayKey();
    if (drillState.day !== t) { drillState.day = t; drillState.offset = 0; }
    const daySeed = Number(t.replace(/-/g, "")) + drillState.offset * 7919;
    const rnd = seeded(daySeed);
    return ["coding", "design", "ai", "behavioral"].map((kind) => {
      const bank = window.DRILLS[kind];
      // Prefer cards marked "review", then cards never mastered.
      const review = bank.filter((_, i) => drillState.review[kind + i]);
      const fresh = bank.filter((_, i) => !drillState.got[kind + i]);
      const pool = review.length && rnd() < 0.5 ? review : fresh.length ? fresh : bank;
      const card = pool[Math.floor(rnd() * pool.length)];
      return { kind, idx: bank.indexOf(card), ...card };
    });
  }

  const KIND_LABEL = { coding: "Coding pattern", design: "System design", ai: "AI / ML concept", behavioral: "Behavioral" };
  let todaysDrills = [];

  function renderDrills() {
    todaysDrills = pickDrills();
    $("#drillList").innerHTML = todaysDrills.map((d) => {
      const key = d.kind + d.idx;
      return `<article class="card drill" data-key="${key}">
        <div class="card-meta"><span class="badge ${d.kind === "ai" ? "research" : d.kind === "design" ? "repos" : d.kind === "behavioral" ? "learn" : ""}">${KIND_LABEL[d.kind]}</span>
          ${drillState.got[key] ? "<span>✓ mastered</span>" : drillState.review[key] ? "<span>↺ reviewing</span>" : ""}</div>
        <div class="q">${esc(d.q)}</div>
        <div class="ans hidden">${esc(d.a)}${d.f ? `<div class="follow">↳ ${esc(d.f)}</div>` : ""}</div>
        <div class="card-actions">
          <button class="mini" data-act="reveal">Reveal</button>
          <button class="mini" data-act="speak">🔊</button>
          <button class="mini ${drillState.got[key] ? "on" : ""}" data-act="got">✓ Got it</button>
          <button class="mini ${drillState.review[key] ? "on" : ""}" data-act="review">↺ Review</button>
        </div>
      </article>`;
    }).join("");
    const total = Object.values(window.DRILLS).reduce((n, b) => n + b.length, 0);
    $("#drillScore").textContent = `${Object.keys(drillState.got).length}/${total} mastered`;
  }

  function onDrillClick(e) {
    const card = e.target.closest(".drill");
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (!card || !act) return;
    const key = card.dataset.key;
    const d = todaysDrills.find((x) => x.kind + x.idx === key);
    if (act === "reveal") {
      const ans = card.querySelector(".ans");
      ans.classList.toggle("hidden");
      e.target.textContent = ans.classList.contains("hidden") ? "Reveal" : "Hide answer";
    } else if (act === "speak") {
      stopAudio();
      queue = [{ title: KIND_LABEL[d.kind], text: `${d.q} ... Take a moment to think. ... ${d.a} ${d.f || ""}` }];
      qi = 0; play();
    } else if (act === "got") {
      drillState.got[key] = Date.now(); delete drillState.review[key];
      store.set("drill", drillState); renderDrills();
    } else if (act === "review") {
      drillState.review[key] = Date.now(); delete drillState.got[key];
      store.set("drill", drillState); renderDrills();
    }
  }

  // ---------- AI coach (optional, user-supplied key) ----------
  let coachText = store.get("coach", null);
  function showCoach() {
    if (coachText && coachText.day === todayKey() && settings.apiKey) {
      $("#coachText").textContent = coachText.text;
      $("#coachCard").classList.remove("hidden");
    } else $("#coachCard").classList.add("hidden");
  }

  async function maybeCoach(force) {
    if (!settings.apiKey || !items.length) return showCoach();
    if (!force && coachText && coachText.day === todayKey()) return showCoach();
    $("#coachCard").classList.remove("hidden");
    $("#coachText").textContent = "Thinking about today's news…";
    try {
      const { default: Anthropic } = await import("https://esm.sh/@anthropic-ai/sdk");
      const client = new Anthropic({ apiKey: settings.apiKey, dangerouslyAllowBrowser: true });
      const top = ranked().slice(0, 15).map((it, i) => `${i + 1}. [${it.source}] ${it.title}${it.desc ? " — " + it.desc.slice(0, 200) : ""}`).join("\n");
      const resp = await client.beta.messages.create({
        model: "claude-opus-5-5",
        max_tokens: 2000,
        output_config: { effort: "low" },
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        system: "You are a concise morning coach for a software engineer preparing for technical interviews. Your text will be read aloud by a text-to-speech voice, so write plain sentences: no markdown, no bullet symbols, no URLs.",
        messages: [{
          role: "user",
          content: `Today's AI and developer headlines:\n${top}\n\nIn under 170 words: (1) the two or three developments that matter most for a working programmer and why, (2) one concrete thing to try or learn this week, and (3) one interview talking point these stories give me, phrased as something I could say in an interview.${settings.focus ? " I'm especially interested in: " + settings.focus + "." : ""}`,
        }],
      });
      if (resp.stop_reason === "refusal") throw new Error("The model declined this request.");
      const text = resp.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim();
      coachText = { day: todayKey(), text };
      store.set("coach", coachText);
      showCoach();
      if (!speaking) buildQueue();
    } catch (err) {
      $("#coachText").textContent = "Couldn't reach the AI coach: " + (err?.message || err) + ". Check the key in Settings.";
    }
  }

  // ---------- audio briefing (Web Speech API) ----------
  const synth = window.speechSynthesis;
  let queue = [], qi = 0, speaking = false, paused = false;
  const RATES = [0.8, 1.0, 1.15, 1.3, 1.5];

  function buildQueue() {
    const top = ranked().slice(0, Number(settings.count) || 8);
    const d = todaysDrills[0] || pickDrills()[0];
    const dayStr = new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
    queue = [{ title: "Intro", text: `${$("#greet").textContent}. It's ${dayStr}. Here's your AI brief: ${top.length} stories, then your interview question of the day.` }];
    if (coachText && coachText.day === todayKey() && settings.apiKey) {
      queue.push({ title: "Coach's take", text: "First, the big picture. " + coachText.text });
    }
    top.forEach((it, i) => {
      const lead = i === 0 ? "Top story." : i === top.length - 1 ? "And finally." : `Story ${i + 1}.`;
      let body = it.title + ".";
      if (it.cat === "research" && it.desc) body += " " + firstSentences(it.desc, 2);
      else if (it.cat === "repos") body = `A trending repo: ${it.title.replace("/", " slash ")}. ${it.desc}`;
      else if (it.cat === "learn" && it.desc) body += " " + it.desc;
      queue.push({ id: it.id, title: it.title, text: `${lead} From ${it.source}. ${body}` });
    });
    if (d) {
      queue.push({ title: "Interview question", text: `Interview question of the day, ${KIND_LABEL[d.kind]}. ${d.q} ... Think about it for a moment. ... Here's a strong answer. ${d.a}` });
    }
    queue.push({ title: "Outro", text: "That's your brief. Go build something great today." });
    qi = 0;
    updatePlayerUI();
  }

  function firstSentences(s, n) { return (s.match(/[^.!?]+[.!?]+/g) || [s]).slice(0, n).join(" "); }

  function pickVoice() {
    const voices = synth?.getVoices() || [];
    return voices.find((v) => v.voiceURI === settings.voice)
      || voices.find((v) => /en[-_]US/i.test(v.lang) && /(natural|premium|enhanced|samantha|google)/i.test(v.name))
      || voices.find((v) => /^en/i.test(v.lang));
  }

  function speakCurrent() {
    if (!synth) return;
    const seg = queue[qi];
    if (!seg) { stopAudio(); return; }
    const u = new SpeechSynthesisUtterance(seg.text.replace(/\.\.\./g, ", "));
    const v = pickVoice();
    if (v) u.voice = v;
    u.rate = settings.rate;
    u.onend = () => { if (!speaking || paused) return; qi++; if (qi < queue.length) speakCurrent(); else stopAudio(true); };
    u.onerror = (e) => { if (e.error !== "interrupted" && e.error !== "canceled") { qi++; speakCurrent(); } };
    synth.cancel();
    synth.speak(u);
    updatePlayerUI();
  }

  function play() {
    if (!synth) { alert("Text-to-speech isn't supported in this browser."); return; }
    if (!queue.length) buildQueue();
    if (paused && synth.paused) { synth.resume(); paused = false; speaking = true; updatePlayerUI(); return; }
    speaking = true; paused = false;
    speakCurrent();
  }
  function pause() { paused = true; speaking = false; synth?.cancel(); updatePlayerUI(); } // cancel+restart segment is more reliable on mobile than pause()
  function stopAudio(finished) {
    speaking = false; paused = false; synth?.cancel();
    if (finished) qi = 0;
    updatePlayerUI();
  }
  function skip(delta) {
    qi = Math.max(0, Math.min(queue.length - 1, qi + delta));
    if (speaking) speakCurrent(); else updatePlayerUI();
  }
  function speakOne(it) {
    stopAudio();
    queue = [{ id: it.id, title: it.title, text: `${it.title}. ${it.desc || ""}` }];
    qi = 0; play();
  }

  function updatePlayerUI() {
    const seg = queue[qi];
    $("#playBtn").textContent = speaking ? "❚❚" : "▶";
    $("#playerTitle").textContent = seg ? (speaking || paused || qi > 0 ? seg.title : "Tap play to hear today's brief") : "Tap play to hear today's brief";
    const words = queue.reduce((n, s) => n + s.text.split(/\s+/).length, 0);
    const mins = Math.max(1, Math.round(words / (165 * settings.rate)));
    $("#playerMeta").textContent = queue.length ? `${qi + 1}/${queue.length} · ~${mins} min` : "—";
    $("#progressFill").style.width = queue.length ? `${((qi + (speaking ? 0.5 : 0)) / queue.length) * 100}%` : "0";
    $("#speedBtn").textContent = (Number.isInteger(settings.rate) ? settings.rate.toFixed(1) : String(settings.rate)) + "×";
    document.querySelectorAll(".card.speaking").forEach((c) => c.classList.remove("speaking"));
    if (speaking && seg?.id) {
      const el = document.querySelector(`#newsList .card[data-id="${CSS.escape(seg.id)}"]`);
      if (el) { el.classList.add("speaking"); el.scrollIntoView({ behavior: "smooth", block: "center" }); }
    }
    if ("mediaSession" in navigator) {
      try { navigator.mediaSession.metadata = new MediaMetadata({ title: seg?.title || "AI Brief", artist: "AI Brief" }); } catch {}
    }
  }

  // ---------- settings ----------
  function fillVoices() {
    const sel = $("#voiceSelect");
    const voices = (synth?.getVoices() || []).filter((v) => /^en/i.test(v.lang));
    sel.innerHTML = `<option value="">Auto (best English voice)</option>` +
      voices.map((v) => `<option value="${esc(v.voiceURI)}">${esc(v.name)} (${esc(v.lang)})</option>`).join("");
    sel.value = settings.voice;
  }

  function openSettings() {
    $("#nameInput").value = settings.name;
    $("#countSelect").value = String(settings.count);
    $("#focusInput").value = settings.focus;
    $("#keyInput").value = settings.apiKey;
    fillVoices();
    $("#sheet").classList.remove("hidden");
  }
  function saveSettings() {
    const prevKey = settings.apiKey, prevFocus = settings.focus;
    settings.name = $("#nameInput").value.trim();
    settings.voice = $("#voiceSelect").value;
    settings.count = Number($("#countSelect").value);
    settings.focus = $("#focusInput").value.trim();
    settings.apiKey = $("#keyInput").value.trim();
    store.set("settings", settings);
    $("#sheet").classList.add("hidden");
    renderHeader();
    if (prevFocus !== settings.focus) items.forEach((it) => (it.rank = it.score + focusBoost(it)));
    renderNews();
    if (settings.apiKey && settings.apiKey !== prevKey) maybeCoach(true); else showCoach();
  }

  // ---------- wiring ----------
  function switchTab(name) {
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
    ["news", "drill", "saved"].forEach((v) => $("#view-" + v).classList.toggle("hidden", v !== name));
    if (name === "saved") renderSaved();
    store.set("tab", name);
  }

  function init() {
    renderHeader();
    bumpStreak();
    renderDrills();
    showCoach();

    document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => switchTab(t.dataset.tab)));
    $("#filterChips").addEventListener("click", (e) => {
      const c = e.target.closest(".chip"); if (!c) return;
      filter = c.dataset.filter;
      document.querySelectorAll(".chip").forEach((x) => x.classList.toggle("active", x === c));
      renderNews();
    });
    $("#newsList").addEventListener("click", onCardClick);
    $("#savedList").addEventListener("click", onCardClick);
    $("#drillList").addEventListener("click", onDrillClick);
    $("#refreshBtn").addEventListener("click", () => loadNews(true));
    $("#shuffleBtn").addEventListener("click", () => { drillState.offset++; store.set("drill", drillState); renderDrills(); });

    $("#playBtn").addEventListener("click", () => (speaking ? pause() : play()));
    $("#prevBtn").addEventListener("click", () => skip(-1));
    $("#nextBtn").addEventListener("click", () => skip(1));
    $("#speedBtn").addEventListener("click", () => {
      const i = RATES.indexOf(settings.rate);
      settings.rate = RATES[(i + 1) % RATES.length];
      store.set("settings", settings);
      if (speaking) speakCurrent(); else updatePlayerUI();
    });

    $("#settingsBtn").addEventListener("click", openSettings);
    $("#closeSheet").addEventListener("click", () => $("#sheet").classList.add("hidden"));
    $("#sheet").addEventListener("click", (e) => { if (e.target.id === "sheet") $("#sheet").classList.add("hidden"); });
    $("#saveSettings").addEventListener("click", saveSettings);
    $("#clearCache").addEventListener("click", () => { store.del("news"); store.del("coach"); coachText = null; $("#sheet").classList.add("hidden"); loadNews(true); });
    if (synth) synth.onvoiceschanged = fillVoices;

    if ("mediaSession" in navigator) {
      try {
        navigator.mediaSession.setActionHandler("play", play);
        navigator.mediaSession.setActionHandler("pause", pause);
        navigator.mediaSession.setActionHandler("nexttrack", () => skip(1));
        navigator.mediaSession.setActionHandler("previoustrack", () => skip(-1));
      } catch {}
    }

    switchTab(store.get("tab", "news"));
    loadNews();

    if ("serviceWorker" in navigator && location.protocol !== "file:") {
      navigator.serviceWorker.register("sw.js").catch(() => {});
    }
  }

  init();
})();
