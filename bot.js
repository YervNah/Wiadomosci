/**
 * Polish News Telegram Bot
 * Dependencies: node-cron, rss-parser, node-fetch
 *
 * AI_MODEL env var: "groq" or "gemini"
 */

import fetch from "node-fetch";
import Parser from "rss-parser";
import cron from "node-cron";
import fs from "fs";

// ── CONFIG ────────────────────────────────────────────────────────────────────
const TELEGRAM_TOKEN   = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHANNEL = process.env.TELEGRAM_CHANNEL;
const AI_MODEL         = (process.env.AI_MODEL || "groq").toLowerCase();
const GEMINI_API_KEY   = process.env.GEMINI_API_KEY;
const GROQ_API_KEY     = process.env.GROQ_API_KEY;
const POSTED_IDS_FILE  = "./posted_ids.json";
const MAX_NEWS_PER_RUN = 1;
const MAX_RETRIES      = 10;

// ── RSS FEEDS ─────────────────────────────────────────────────────────────────
// Using feeds that focus on top/most-important stories where possible
const RSS_FEEDS = [
  { name: "WP Wiadomosci",  url: "https://rss.wp.pl/pub/rss/0/wiadomosci.xml" },
  { name: "Onet Wiadomosci",url: "https://wiadomosci.onet.pl/.feed/onet_wiadomosci_ogolnopolskie.xml" },
  { name: "TVN24",          url: "https://tvn24.pl/najnowsze.xml" },
  { name: "Gazeta.pl",      url: "https://rss.gazeta.pl/pub/rss/najwazniejsze.xml" },
  { name: "Polsat News",    url: "https://www.polsatnews.pl/rss/wszystkie.xml" },
  { name: "RMF FM",         url: "https://www.rmf.fm/rss/feed.xml" },
  { name: "Radio ZET",      url: "https://wiadomosci.radiozet.pl/rss/feed.xml" },
];

// ── TOPIC SCORING ─────────────────────────────────────────────────────────────
// Articles matching more keywords get a higher score — highest scored = posted
const TOPIC_KEYWORDS = {
  geopolitics: [
    "wojna","konflikt","ukraina","rosja","nato","ue","unia europejska","usa","niemcy",
    "francja","chiny","izrael","palestyna","dyplomacja","sankcje","traktat","szczyt",
    "prezydent","premier","minister","rzad","sejm","wybory","polityka","parlament",
    "kaczynski","tusk","duda","morawiecki","trzaskowski"
  ],
  weather: [
    "pogoda","burza","powodz","huragan","tornado","upał","mróz","snieg","deszcz",
    "ostrzezenie","imgw","temperatura","fala upałow","fala mrozow","wichura","grad"
  ],
  economy: [
    "inflacja","pkb","gospodarka","ceny","wzrost","kryzys","budżet","zloty","euro",
    "nbp","stopy procentowe","bezrobocie","giełda","firma","bankructwo"
  ],
  disasters: [
    "wypadek","katastrofa","pozar","trzesienie","lawina","ofiara","ranny","ewakuacja",
    "ratownicy","szpital","smierc","zginał","tragedia"
  ],
};

function scoreArticle(item) {
  const text = ((item.title || "") + " " + stripHtml(item.description || item.contentSnippet || "")).toLowerCase();
  let score = 0;
  for (const keywords of Object.values(TOPIC_KEYWORDS)) {
    for (const kw of keywords) {
      if (text.includes(kw)) score++;
    }
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

function savePostedItem(item, postedIds) {
  // Save multiple fingerprints so we catch duplicates regardless of which field changes
  const keys = [
    item.guid,
    item.link,
    normalizeTitle(item.title),
  ].filter(Boolean);
  for (const k of keys) postedIds.add(k);
  fs.writeFileSync(POSTED_IDS_FILE, JSON.stringify([...postedIds].slice(-1000)));
}

function isAlreadyPosted(item, postedIds) {
  return (
    (item.guid  && postedIds.has(item.guid))  ||
    (item.link  && postedIds.has(item.link))  ||
    postedIds.has(normalizeTitle(item.title))
  );
}

// ── HELPERS ───────────────────────────────────────────────────────────────────
const parser = new Parser({
  customFields: {
    item: [
      ["media:content",   "mediaContent",   { keepArray: false }],
      ["media:thumbnail", "mediaThumbnail", { keepArray: false }],
      ["enclosure",       "enclosure"],
    ],
  },
});

function extractImageUrl(item) {
  if (item.mediaContent?.$?.url)   return item.mediaContent.$.url;
  if (item.mediaThumbnail?.$?.url) return item.mediaThumbnail.$.url;
  if (item.enclosure?.url)          return item.enclosure.url;
  const content = item.content || item.summary || item.description || "";
  const m = content.match(/<img[^>]+src=["']([^"']+)["']/i);
  return m ? m[1] : null;
}

function stripHtml(html) {
  return (html || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function escapeHtml(str) {
  return (str || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function sourceToHashtag(source) {
  return "#" + source
    .replace(/[^a-zA-Z0-9 ]/g, "")
    .split(" ").filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join("");
}

// Extract meaningful keywords from the title directly in JS
// Used to guarantee topic-specific hashtags even if AI fails
const POLISH_STOPWORDS = new Set([
  "w","z","i","a","na","do","że","się","nie","to","jak","po","przez","o","ale",
  "co","go","tak","już","ten","ta","te","tej","tego","temu","tym","przy","dla",
  "od","ze","bo","czy","no","nowe","nowy","nowa","po","przed","nad","pod","za",
  "jest","był","była","były","będzie","ma","mają","ma","jego","jej","ich","je",
  "jeszcze","też","tylko","już","zostal","zostala","zostali","tego","które","który",
  "ktora","oraz","jako","sobie","gdzie","kiedy","gdy","więc","zatem","jednak"
]);

function extractTitleHashtags(title) {
  const words = title
    .replace(/[„""«»()[\]{}<>:;,!?.'"/\\|]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 4)
    .map((w) => w.toLowerCase())
    .filter((w) => !POLISH_STOPWORDS.has(w));

  // Capitalize first letter, keep rest as-is (preserves names)
  return [...new Set(words)]
    .slice(0, 4)
    .map((w) => "#" + w.charAt(0).toUpperCase() + w.slice(1));
}

function buildFallback(title, description, sourceTag) {
  let summary = stripHtml(description).slice(0, 180).trim() || title;
  const lastPunct = Math.max(summary.lastIndexOf("."), summary.lastIndexOf("!"), summary.lastIndexOf("?"));
  if (!summary.match(/[.!?]$/)) {
    summary = lastPunct > 20 ? summary.slice(0, lastPunct + 1) : summary + ".";
  }
  const titleTags = extractTitleHashtags(title);
  return { summary, hashtags: [...titleTags, sourceTag].filter(Boolean) };
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

async function generateSummaryAndHashtags(title, description, source) {
  const cleanDesc = stripHtml(description).slice(0, 600);
  const sourceTag = sourceToHashtag(source);
  // Pre-extract keywords from title as a guaranteed seed
  const titleTags  = extractTitleHashtags(title);

  const systemPrompt =
    "Jestes redaktorem polskiego kanalu Telegram. Odpowiadasz WYLACZNIE poprawnym JSON-em bez zadnych dodatkow, markdown ani komentarzy.";

  const userPrompt =
    "Tytul: " + title + "\n"
    + "Opis: " + cleanDesc + "\n\n"
    + "Zadanie 1 — PODSUMOWANIE: Napisz 1-2 kompletne zdania po polsku (max 160 znakow). "
    + "Zdanie MUSI konczyc sie kropka. Nie ucinaj w polowie.\n\n"
    + "Zadanie 2 — HASHTAGI: Wygeneruj dokladnie 4 hashtagi.\n"
    + "Regula: Kazdy hashtag MUSI byc slowem kluczowym wprost z tytulu lub tresci artykulu "
    + "(imie, nazwisko, kraj, miasto, temat, wydarzenie). "
    + "ZAKAZ uzywania: #Polska #Wiadomosci #News #Informacje #Aktualnosci.\n"
    + "Przykladowe DOBRE hashtagi dla tytulu 'Tusk spotkal sie z Scholzem w Berlinie': "
    + "#Tusk #Scholz #Berlin #Dyplomacja\n\n"
    + "Odpowiedz TYLKO tym JSON-em:\n"
    + '{"summary":"zdanie konczace sie kropka.","hashtags":["#Slowo1","#Slowo2","#Slowo3","#Slowo4"]}';

  try {
    const text = AI_MODEL === "gemini"
      ? await callGemini(systemPrompt, userPrompt)
      : await callGroq(systemPrompt, userPrompt);

    if (!text) return buildFallback(title, description, sourceTag);

    const clean = text.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(clean);

    // Ensure complete sentence
    let summary = (parsed.summary || "").trim();
    if (summary && !summary.match(/[.!?]$/)) {
      const lastPunct = Math.max(summary.lastIndexOf("."), summary.lastIndexOf("!"), summary.lastIndexOf("?"));
      summary = lastPunct > 20 ? summary.slice(0, lastPunct + 1) : summary + ".";
    }
    if (!summary) summary = title + ".";

    // Merge AI hashtags with title-extracted ones, deduplicate, cap at 5 + source
    const aiTags   = (parsed.hashtags || []).map((h) => h.startsWith("#") ? h : "#" + h);
    const merged   = [...new Set([...aiTags, ...titleTags])].slice(0, 5);
    // Remove source tag if somehow added, then always put it last
    const hashtags = merged.filter((h) => h !== sourceTag).concat(sourceTag);

    return { summary, hashtags };
  } catch (err) {
    console.warn("AI error (" + AI_MODEL + "), using fallback:", err.message);
    return buildFallback(title, description, sourceTag);
  }
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

// ── FETCH NEWS ────────────────────────────────────────────────────────────────
async function fetchAllNews() {
  const allItems = [];
  let failCount = 0;

  for (const feed of RSS_FEEDS) {
    if (failCount >= MAX_RETRIES) {
      console.warn("Reached " + MAX_RETRIES + " failures, stopping RSS fetch this run.");
      break;
    }
    try {
      console.log("Fetching: " + feed.name);
      const parsed = await parser.parseURL(feed.url);
      const items = (parsed.items || []).slice(0, 8).map((item) => ({ ...item, sourceName: feed.name }));
      allItems.push(...items);
    } catch (err) {
      failCount++;
      console.warn("Failed (" + failCount + "/" + MAX_RETRIES + ") " + feed.name + ": " + err.message);
    }
  }

  return allItems;
}

// ── MAIN ──────────────────────────────────────────────────────────────────────
async function runNewsBot() {
  console.log("\n[" + new Date().toISOString() + "] Running (model: " + AI_MODEL + ")...");
  const postedIds = loadPostedIds();

  let articles;
  try {
    articles = await fetchAllNews();
  } catch (err) {
    console.error("Failed to fetch news:", err.message);
    return;
  }

  // Filter out duplicates by guid, link, AND normalized title
  const newArticles = articles.filter((item) => !isAlreadyPosted(item, postedIds));
  console.log("Total fetched: " + articles.length + " | New (not posted yet): " + newArticles.length);

  if (newArticles.length === 0) {
    console.log("Nothing new to post this hour.");
    return;
  }

  // Score and pick the most important article
  const scored = newArticles.map((item) => ({ item, score: scoreArticle(item) }));
  scored.sort((a, b) => b.score - a.score);

  console.log("Top 3 candidates:");
  scored.slice(0, 3).forEach((s) => console.log("  [" + s.score + "] " + (s.item.title || "").slice(0, 70)));

  const { item } = scored[0];
  const title    = item.title || "Brak tytulu";
  const link     = item.link || "";
  const imageUrl = extractImageUrl(item);

  try {
    console.log("Processing: " + title.slice(0, 70));

    const { summary, hashtags } = await generateSummaryAndHashtags(
      title,
      item.contentSnippet || item.description || item.content || "",
      item.sourceName
    );

    const hashtagString = hashtags.join(" ");
    const caption =
      "&#x1F4F0; <b>" + escapeHtml(title) + "</b>\n\n" +
      escapeHtml(summary) + "\n\n" +
      hashtagString + "\n\n" +
      "&#x1F4CC; <i>" + item.sourceName + "</i>  |  <a href=\"" + link + "\">Czytaj wiecej</a>";

    let result = imageUrl
      ? await sendPhotoToTelegram(TELEGRAM_CHANNEL, imageUrl, caption)
      : await sendMessageToTelegram(TELEGRAM_CHANNEL, caption);

    if (result.ok) {
      console.log("Posted: " + title.slice(0, 70));
      savePostedItem(item, postedIds);
    } else {
      console.warn("Telegram error:", result.description);
      if (imageUrl && result.description?.includes("photo")) {
        const retry = await sendMessageToTelegram(TELEGRAM_CHANNEL, caption);
        if (retry.ok) {
          savePostedItem(item, postedIds);
          console.log("Posted (text fallback): " + title.slice(0, 70));
        }
      }
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
console.log("Posts/hr: " + MAX_NEWS_PER_RUN);
console.log("Schedule: every hour\n");

runNewsBot();
cron.schedule("0 * * * *", runNewsBot);
