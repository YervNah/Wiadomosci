/**
 * Polish News Telegram Bot
 * Source: GNews API (free - https://gnews.io)
 * AI: Groq or Gemini (set AI_MODEL env var)
 *
 * Required env vars:
 *   TELEGRAM_TOKEN, TELEGRAM_CHANNEL
 *   GNEWS_API_KEY   (free at gnews.io - 100 req/day)
 *   AI_MODEL        "groq" or "gemini"
 *   GROQ_API_KEY    (free at groq.com)
 *   GEMINI_API_KEY  (free at aistudio.google.com) - only if AI_MODEL=gemini
 */

import fetch from "node-fetch";
import cron from "node-cron";
import fs from "fs";

// ── CONFIG ────────────────────────────────────────────────────────────────────
const TELEGRAM_TOKEN   = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHANNEL = process.env.TELEGRAM_CHANNEL;
const GNEWS_API_KEY    = process.env.GNEWS_API_KEY;
const AI_MODEL         = (process.env.AI_MODEL || "groq").toLowerCase();
const GEMINI_API_KEY   = process.env.GEMINI_API_KEY;
const GROQ_API_KEY     = process.env.GROQ_API_KEY;
const POSTED_IDS_FILE  = "./posted_ids.json";

// ── GNEWS TOPIC QUERIES — Polish domestic politics only ───────────────────────
// Strategy: first try fresh 2-day window; if nothing new found, widen to 7 days.
// GNews free tier: 100 req/day. We use up to 8 queries/run = fine at 1 run/hour.
function buildPoliticsUrl(keywords, daysBack, max) {
  const from = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000)
    .toISOString().slice(0, 10) + "T00:00:00Z";
  return "https://gnews.io/api/v4/search?q=" + keywords
    + "&lang=pl&country=pl&max=" + max + "&sortby=relevance&from=" + from + "&apikey=";
}

// Core politics keywords — all about internal Polish government/policy
const POL_KEYWORDS = [
  "sejm+OR+senat+OR+rzad+OR+premier+OR+prezydent",
  "minister+OR+ministerstwo+OR+ustawa+OR+prawo",
  "tusk+OR+duda+OR+koalicja+OR+opozycja+OR+wybory",
  "polityka+polska+OR+partia+OR+PiS+OR+KO+OR+lewica",
];

// Build queries: 2-day window first (fresh), then 7-day (buffer)
const GNEWS_QUERIES_FRESH = POL_KEYWORDS.map((kw, i) => ({
  label: "politics-fresh-" + i,
  url: buildPoliticsUrl(kw, 2, 10),
}));

const GNEWS_QUERIES_BUFFER = POL_KEYWORDS.map((kw, i) => ({
  label: "politics-buffer-" + i,
  url: buildPoliticsUrl(kw, 7, 10),
}));

// ── TOPIC SCORING — domestic Polish politics only ────────────────────────────
const POLITICS_SCORE_KEYWORDS = [
  // Institutions
  "sejm","senat","rzad","rząd","ministerstwo","trybunał","sąd najwyższy","kprm",
  // Roles
  "premier","prezydent","minister","marszałek","poseł","senator","wiceminister",
  // Parties / people
  "tusk","duda","kowalski","sikorski","bodnar","nawrocki","trzaskowski",
  "pis","ko","lewica","td","koalicja","opozycja","partia",
  // Actions
  "ustawa","głosowanie","debata","expose","wotum","interpelacja","budżet",
  "nowelizacja","rozporządzenie","reforma","projekt ustawy","komisja sejmowa",
  // Domestic policy topics
  "wybory","kampania","sondaż","koalicja rządząca","polityka krajowa",
];

// Articles matching ANY of these are excluded — not internal politics
const EXCLUSION_KEYWORDS = [
  // Sports
  "mecz","liga","puchar","gol","bramka","koszykówka","siatkówka","tenis","wyścig",
  "formuła","olimpiada","mistrzostwa świata","mundial","euro 2024","nba","nhl","premier league",
  // Culture / entertainment
  "film","serial","netflix","premiera kinowa","koncert","festiwal muzyczny","oscar",
  "grammy","aktor","reżyser","piosenka","album","galeria","muzeum","teatr","opera",
  // International non-political
  "pogoda","huragan","trzęsienie","erupcja","powódź za granicą",
  "gwiazda","celebrity","influencer","tiktok","instagram",
  // Foreign sports teams / leagues
  "real madrid","barcelona","manchester","liverpool","juventus","bayern",
];

function isExcluded(article) {
  const text = ((article.title || "") + " " + (article.description || "")).toLowerCase();
  return EXCLUSION_KEYWORDS.some((kw) => text.includes(kw));
}

function scoreArticle(article) {
  const text = ((article.title || "") + " " + (article.description || "")).toLowerCase();
  let score = 0;
  for (const kw of POLITICS_SCORE_KEYWORDS) {
    if (text.includes(kw)) score++;
  }
  return score;
}

// ── DEDUPLICATION ─────────────────────────────────────────────────────────────
function normalizeTitle(title) {
  return (title || "").toLowerCase().replace(/[^a-z0-9ąćęłńóśźż]/g, "").slice(0, 80);
}

function loadPostedIds() {
  if (fs.existsSync(POSTED_IDS_FILE)) {
    return new Set(JSON.parse(fs.readFileSync(POSTED_IDS_FILE, "utf8")));
  }
  return new Set();
}

function savePostedItem(article, postedIds) {
  const keys = [article.url, normalizeTitle(article.title)].filter(Boolean);
  for (const k of keys) postedIds.add(k);
  fs.writeFileSync(POSTED_IDS_FILE, JSON.stringify([...postedIds].slice(-1000)));
}

function isAlreadyPosted(article, postedIds) {
  return (
    (article.url   && postedIds.has(article.url)) ||
    postedIds.has(normalizeTitle(article.title))
  );
}

// ── HELPERS ───────────────────────────────────────────────────────────────────
function escapeHtml(str) {
  return (str || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function sourceToHashtag(sourceName) {
  return "#" + (sourceName || "")
    .replace(/[^a-zA-Z0-9 ]/g, "")
    .split(" ").filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join("");
}

const POLISH_STOPWORDS = new Set([
  "w","z","i","a","na","do","że","się","nie","to","jak","po","przez","o","ale",
  "co","go","tak","już","ten","ta","te","tej","tego","temu","tym","przy","dla",
  "od","ze","bo","czy","no","jest","był","była","były","będzie","jego","jej","ich",
  "jeszcze","też","tylko","zostal","zostala","które","który","ktora","oraz","jako",
  "gdzie","kiedy","gdy","więc","zatem","jednak","nowe","nowy","nowa","przed","nad"
]);

function extractTitleHashtags(title) {
  return [...new Set(
    title
      .replace(/[„""«»()[\]{}<>:;,!?.'"/\\|]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 4)
      .map((w) => w.toLowerCase())
      .filter((w) => !POLISH_STOPWORDS.has(w))
  )]
  .slice(0, 4)
  .map((w) => "#" + w.charAt(0).toUpperCase() + w.slice(1));
}

function buildFallback(article, sourceTag) {
  let summary = (article.description || article.title || "").slice(0, 180).trim();
  const lastPunct = Math.max(summary.lastIndexOf("."), summary.lastIndexOf("!"), summary.lastIndexOf("?"));
  if (!summary.match(/[.!?]$/)) {
    summary = lastPunct > 20 ? summary.slice(0, lastPunct + 1) : summary + ".";
  }
  return { summary, hashtags: [...extractTitleHashtags(article.title || ""), sourceTag].filter(Boolean) };
}

// ── AI ────────────────────────────────────────────────────────────────────────
async function callGemini(systemPrompt, userPrompt) {
  const res = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=" + GEMINI_API_KEY,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: systemPrompt + "\n\n" + userPrompt }] }],
        generationConfig: { temperature: 0.3, maxOutputTokens: 300 },
      }),
    }
  );
  const data = await res.json();
  if (!data.candidates?.length) { console.warn("Gemini no candidates:", JSON.stringify(data)); return null; }
  return data.candidates[0]?.content?.parts?.[0]?.text?.trim() || null;
}

async function callGroq(systemPrompt, userPrompt) {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + GROQ_API_KEY },
    body: JSON.stringify({
      model: "llama-3.1-8b-instant",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user",   content: userPrompt },
      ],
      max_tokens: 300,
      temperature: 0.3,
    }),
  });
  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() || null;
}

async function generateSummaryAndHashtags(article) {
  const sourceTag  = sourceToHashtag(article.source?.name || "");
  const titleTags  = extractTitleHashtags(article.title || "");

  const systemPrompt =
    "Jestes redaktorem polskiego kanalu Telegram. Odpowiadasz WYLACZNIE poprawnym JSON-em bez zadnych dodatkow, markdown ani komentarzy.";

  const userPrompt =
    "Tytul: " + (article.title || "") + "\n"
    + "Opis: " + (article.description || "").slice(0, 500) + "\n\n"
    + "Zadanie 1 — PODSUMOWANIE: Napisz 1-2 kompletne zdania po polsku (max 160 znakow). "
    + "Zdanie MUSI konczyc sie kropka. Nie ucinaj w polowie.\n\n"
    + "Zadanie 2 — HASHTAGI: Wygeneruj dokladnie 4 hashtagi.\n"
    + "Kazdy hashtag MUSI byc konkretnym slowem kluczowym z tytulu lub opisu "
    + "(imie, nazwisko, kraj, miasto, temat, wydarzenie). "
    + "ZAKAZ: #Polska #Wiadomosci #News #Informacje #Aktualnosci #Breaking.\n"
    + "Przyklad dla 'Tusk spotkal sie z Scholzem w Berlinie': #Tusk #Scholz #Berlin #Dyplomacja\n\n"
    + '{"summary":"zdanie konczace sie kropka.","hashtags":["#Slowo1","#Slowo2","#Slowo3","#Slowo4"]}';

  try {
    const text = AI_MODEL === "gemini"
      ? await callGemini(systemPrompt, userPrompt)
      : await callGroq(systemPrompt, userPrompt);

    if (!text) return buildFallback(article, sourceTag);

    const clean = text.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(clean);

    let summary = (parsed.summary || "").trim();
    if (summary && !summary.match(/[.!?]$/)) {
      const lastPunct = Math.max(summary.lastIndexOf("."), summary.lastIndexOf("!"), summary.lastIndexOf("?"));
      summary = lastPunct > 20 ? summary.slice(0, lastPunct + 1) : summary + ".";
    }
    if (!summary) summary = (article.title || "") + ".";

    const aiTags   = (parsed.hashtags || []).map((h) => h.startsWith("#") ? h : "#" + h);
    const merged   = [...new Set([...aiTags, ...titleTags])].slice(0, 5);
    const hashtags = merged.filter((h) => h !== sourceTag).concat(sourceTag);

    return { summary, hashtags };
  } catch (err) {
    console.warn("AI error (" + AI_MODEL + "), using fallback:", err.message);
    return buildFallback(article, sourceTag);
  }
}

// ── GNEWS FETCH ───────────────────────────────────────────────────────────────
async function fetchFromQueries(queries) {
  const results = [];
  const seen = new Set();
  for (const q of queries) {
    try {
      const res  = await fetch(q.url + GNEWS_API_KEY);
      const data = await res.json();
      if (data.errors) { console.warn("GNews error [" + q.label + "]:", JSON.stringify(data.errors)); continue; }
      const fresh = (data.articles || []).filter((a) => a.url && !seen.has(a.url));
      fresh.forEach((a) => seen.add(a.url));
      results.push(...fresh.map((a) => ({ ...a, _label: q.label })));
    } catch (err) {
      console.warn("Failed [" + q.label + "]: " + err.message);
    }
  }
  return results;
}

async function fetchAllNews(postedIds) {
  // Step 1: try fresh 2-day window
  console.log("Fetching fresh politics news (2-day window)...");
  let articles = await fetchFromQueries(GNEWS_QUERIES_FRESH);

  // Filter out excluded topics and already-posted
  let filtered = articles
    .filter((a) => !isExcluded(a))
    .filter((a) => !isAlreadyPosted(a, postedIds));

  console.log("Fresh fetch: " + articles.length + " total | " + filtered.length + " new politics articles");

  // Step 2: if nothing found, widen to 7-day buffer
  if (filtered.length === 0) {
    console.log("No fresh articles — falling back to 7-day buffer...");
    articles = await fetchFromQueries(GNEWS_QUERIES_BUFFER);
    filtered = articles
      .filter((a) => !isExcluded(a))
      .filter((a) => !isAlreadyPosted(a, postedIds));
    console.log("Buffer fetch: " + articles.length + " total | " + filtered.length + " new politics articles");
  }

  return filtered;
}

// ── TELEGRAM ──────────────────────────────────────────────────────────────────
async function sendPhotoToTelegram(channelId, imageUrl, caption) {
  const res = await fetch("https://api.telegram.org/bot" + TELEGRAM_TOKEN + "/sendPhoto", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: channelId, photo: imageUrl, caption, parse_mode: "HTML" }),
  });
  return res.json();
}

async function sendMessageToTelegram(channelId, text) {
  const res = await fetch("https://api.telegram.org/bot" + TELEGRAM_TOKEN + "/sendMessage", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: channelId, text, parse_mode: "HTML", disable_web_page_preview: false }),
  });
  return res.json();
}

// ── MAIN ──────────────────────────────────────────────────────────────────────
async function runNewsBot() {
  console.log("\n[" + new Date().toISOString() + "] Running (model: " + AI_MODEL + ")...");
  const postedIds = loadPostedIds();

  let newArticles;
  try {
    newArticles = await fetchAllNews(postedIds);
  } catch (err) {
    console.error("Failed to fetch news:", err.message);
    return;
  }

  if (newArticles.length === 0) {
    console.log("No new domestic politics articles found even in 7-day buffer. Skipping.");
    return;
  }

  // Score and pick the most relevant politics article
  const scored = newArticles
    .map((a) => ({ a, score: scoreArticle(a) }))
    .sort((x, y) => y.score - x.score);

  console.log("Top 3 candidates:");
  scored.slice(0, 3).forEach((s) =>
    console.log("  [score:" + s.score + "] " + (s.a.title || "").slice(0, 70))
  );

  const article = scored[0].a;
  const title   = article.title || "Brak tytulu";
  const link    = article.url   || "";
  const image   = article.image || null;

  try {
    console.log("Processing: " + title.slice(0, 70));
    const { summary, hashtags } = await generateSummaryAndHashtags(article);

    const caption =
      "&#x1F4F0; <b>" + escapeHtml(title) + "</b>\n\n" +
      escapeHtml(summary) + "\n\n" +
      hashtags.join(" ") + "\n\n" +
      "&#x1F4CC; <i>" + escapeHtml(article.source?.name || "") + "</i>  |  <a href=\"" + link + "\">Czytaj wiecej</a>";

    let result = null;

    // Try with image first
    if (image) {
      result = await sendPhotoToTelegram(TELEGRAM_CHANNEL, image, caption);
      if (!result.ok) {
        console.warn("Photo failed (" + result.description + "), retrying as text...");
        result = null;
      }
    }

    // Fall back to text-only if no image or image failed
    if (!result || !result.ok) {
      result = await sendMessageToTelegram(TELEGRAM_CHANNEL, caption);
    }

    if (result.ok) {
      console.log("Posted: " + title.slice(0, 70));
      savePostedItem(article, postedIds);
    } else {
      console.error("Telegram failed:", result.description);
    }

  } catch (err) {
    console.error("Error processing article:", err.message);
  }

  console.log("Done. Next run in 1 hour.\n");
}

// ── START ─────────────────────────────────────────────────────────────────────
console.log("Polish News Bot starting...");
console.log("Channel : " + TELEGRAM_CHANNEL);
console.log("AI model: " + AI_MODEL);
console.log("Source  : GNews API (gnews.io)");
console.log("Schedule: every hour\n");

runNewsBot();
cron.schedule("0 * * * *", runNewsBot);
