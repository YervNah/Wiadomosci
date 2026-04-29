/**
 * Polish News Telegram Bot
 * Dependencies: node-cron, rss-parser, node-fetch
 *
 * AI_MODEL options (set in Railway environment variables):
 *   gemini  → Google Gemini 1.5 Flash (free tier)
 *   groq    → Groq LLaMA 3.1 (free tier)
 */

import fetch from "node-fetch";
import Parser from "rss-parser";
import cron from "node-cron";
import fs from "fs";

// ── CONFIG ────────────────────────────────────────────────────────────────────
const TELEGRAM_TOKEN   = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHANNEL = process.env.TELEGRAM_CHANNEL;
const AI_MODEL         = (process.env.AI_MODEL || "groq").toLowerCase(); // "groq" or "gemini"
const GEMINI_API_KEY   = process.env.GEMINI_API_KEY;
const GROQ_API_KEY     = process.env.GROQ_API_KEY;

const POSTED_IDS_FILE  = "./posted_ids.json";
const MAX_NEWS_PER_RUN = 1;   // Post only 1 article per hour
const MAX_RETRIES      = 10;  // Stop trying after 10 failed RSS fetches in a row

// ── RSS FEEDS ─────────────────────────────────────────────────────────────────
const RSS_FEEDS = [
  { name: "WP Wiadomosci",  url: "https://rss.wp.pl/pub/rss/0/wiadomosci.xml" },
  { name: "Onet Wiadomosci",url: "https://wiadomosci.onet.pl/.feed/onet_wiadomosci_ogolnopolskie.xml" },
  { name: "TVN24",          url: "https://tvn24.pl/najnowsze.xml" },
  { name: "Gazeta.pl",      url: "https://rss.gazeta.pl/pub/rss/najwazniejsze.xml" },
  { name: "Polsat News",    url: "https://www.polsatnews.pl/rss/wszystkie.xml" },
  { name: "RMF FM",         url: "https://www.rmf.fm/rss/feed.xml" },
  { name: "Radio ZET",      url: "https://wiadomosci.radiozet.pl/rss/feed.xml" },
];

// ── RSS PARSER ────────────────────────────────────────────────────────────────
const parser = new Parser({
  customFields: {
    item: [
      ["media:content",   "mediaContent",   { keepArray: false }],
      ["media:thumbnail", "mediaThumbnail", { keepArray: false }],
      ["enclosure",       "enclosure"],
    ],
  },
});

// ── POSTED IDS (dedup) ────────────────────────────────────────────────────────
function loadPostedIds() {
  if (fs.existsSync(POSTED_IDS_FILE)) {
    return new Set(JSON.parse(fs.readFileSync(POSTED_IDS_FILE, "utf8")));
  }
  return new Set();
}

function savePostedId(id, postedIds) {
  postedIds.add(id);
  fs.writeFileSync(POSTED_IDS_FILE, JSON.stringify([...postedIds].slice(-500)));
}

// ── HELPERS ───────────────────────────────────────────────────────────────────
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
    .split(" ")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join("");
}

function buildFallback(title, description, sourceTag) {
  // Ensure fallback summary is a complete sentence
  let summary = stripHtml(description).slice(0, 180).trim() || title;
  const lastPunct = Math.max(summary.lastIndexOf("."), summary.lastIndexOf("!"), summary.lastIndexOf("?"));
  if (!summary.match(/[.!?]$/)) {
    summary = lastPunct > 20 ? summary.slice(0, lastPunct + 1) : summary + ".";
  }
  return {
    summary,
    hashtags: ["#Polska", "#Wiadomosci", sourceTag || "#Newsy"],
  };
}

// ── AI: GEMINI ────────────────────────────────────────────────────────────────
async function callGemini(prompt) {
  const res = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=" + GEMINI_API_KEY,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.4, maxOutputTokens: 400 },
      }),
    }
  );
  const data = await res.json();
  if (!data.candidates || data.candidates.length === 0) {
    console.warn("Gemini no candidates:", JSON.stringify(data));
    return null;
  }
  return data.candidates[0]?.content?.parts?.[0]?.text?.trim() || null;
}

// ── AI: GROQ ──────────────────────────────────────────────────────────────────
async function callGroq(prompt) {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + GROQ_API_KEY,
    },
    body: JSON.stringify({
      model: "llama-3.1-8b-instant",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 400,
      temperature: 0.4,
    }),
  });
  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() || null;
}

// ── GENERATE SUMMARY + HASHTAGS ───────────────────────────────────────────────
async function generateSummaryAndHashtags(title, description, source) {
  const cleanDesc = stripHtml(description).slice(0, 800);
  const sourceTag = sourceToHashtag(source);

  const prompt =
    "Jestes redaktorem polskiego kanalu informacyjnego na Telegramie.\n\n"
    + "ZADANIE 1 - PODSUMOWANIE:\n"
    + "Napisz dokladnie 1-2 PELNE zdania po polsku opisujace sedno tej wiadomosci.\n"
    + "ZASADY: Kazde zdanie musi byc kompletne i konczyc sie kropka lub wykrzyknikiem. Nie ucinaj w polowie slowa ani zdania. Maksymalnie 180 znakow lacznie.\n\n"
    + "ZADANIE 2 - HASHTAGI:\n"
    + "Zaproponuj 4-5 hashtagow scisle zwiazanych z trescia artykulu (osoby, miejsca, tematy, slowa kluczowe z tytulu).\n"
    + "ZASADY: Tylko polskie slowa kluczowe z tytulu/tresci. Bez ogolnych tagow jak #News #Wiadomosci #Informacje #Polska.\n\n"
    + "Tytul: " + title + "\n"
    + "Opis: " + cleanDesc + "\n"
    + "Zrodlo: " + source + "\n\n"
    + 'Odpowiedz TYLKO w JSON bez zadnych dodatkow: {"summary": "Pelne zdanie konczace sie kropka.", "hashtags": ["#Temat1", "#Temat2"]}';

  try {
    const text = AI_MODEL === "gemini" ? await callGemini(prompt) : await callGroq(prompt);
    if (!text) return buildFallback(title, description, sourceTag);

    const clean = text.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(clean);

    // Guarantee summary ends at a sentence boundary
    let summary = (parsed.summary || "").trim();
    if (summary && !summary.match(/[.!?]$/)) {
      const lastPunct = Math.max(summary.lastIndexOf("."), summary.lastIndexOf("!"), summary.lastIndexOf("?"));
      summary = lastPunct > 20 ? summary.slice(0, lastPunct + 1) : summary + ".";
    }

    // Deduplicate and always append source hashtag last
    const hashtags = (parsed.hashtags || []).filter((h) => h !== sourceTag);
    hashtags.push(sourceTag);

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
      console.warn("Reached " + MAX_RETRIES + " fetch failures, stopping RSS fetching this run.");
      break;
    }
    try {
      console.log("Fetching: " + feed.name);
      const parsed = await parser.parseURL(feed.url);
      const items = (parsed.items || []).slice(0, 5).map((item) => ({ ...item, sourceName: feed.name }));
      allItems.push(...items);
    } catch (err) {
      failCount++;
      console.warn("Failed (" + failCount + "/" + MAX_RETRIES + ") " + feed.name + ": " + err.message);
    }
  }

  allItems.sort((a, b) => new Date(b.pubDate || b.isoDate || 0) - new Date(a.pubDate || a.isoDate || 0));
  return allItems;
}

// ── MAIN ──────────────────────────────────────────────────────────────────────
async function runNewsBot() {
  console.log("\n[" + new Date().toISOString() + "] Running news bot (model: " + AI_MODEL + ")...");
  const postedIds = loadPostedIds();

  let articles;
  try {
    articles = await fetchAllNews();
  } catch (err) {
    console.error("Failed to fetch news:", err.message);
    return;
  }

  const newArticles = articles.filter((item) => {
    const id = item.guid || item.link || item.title;
    return id && !postedIds.has(id);
  });

  console.log("New articles available: " + newArticles.length + " | Will post: " + Math.min(newArticles.length, MAX_NEWS_PER_RUN));

  const toPost = newArticles.slice(0, MAX_NEWS_PER_RUN);

  for (const item of toPost) {
    const id = item.guid || item.link || item.title;
    const title = item.title || "Brak tytulu";
    const link = item.link || "";
    const imageUrl = extractImageUrl(item);

    try {
      console.log("Processing: " + title.slice(0, 60));

      const { summary, hashtags } = await generateSummaryAndHashtags(
        title,
        item.contentSnippet || item.description || item.content || "",
        item.sourceName
      );

      const hashtagString = Array.isArray(hashtags) ? hashtags.join(" ") : "";
      const caption =
        "&#x1F4F0; <b>" + escapeHtml(title) + "</b>\n\n" +
        escapeHtml(summary) + "\n\n" +
        hashtagString + "\n\n" +
        "&#x1F4CC; <i>" + item.sourceName + "</i>  |  <a href=\"" + link + "\">Czytaj wiecej</a>";

      let result = imageUrl
        ? await sendPhotoToTelegram(TELEGRAM_CHANNEL, imageUrl, caption)
        : await sendMessageToTelegram(TELEGRAM_CHANNEL, caption);

      if (result.ok) {
        console.log("Posted: " + title.slice(0, 60));
        savePostedId(id, postedIds);
      } else {
        console.warn("Telegram error:", result.description);
        // Retry without image if image caused the failure
        if (imageUrl && result.description && result.description.includes("photo")) {
          const retry = await sendMessageToTelegram(TELEGRAM_CHANNEL, caption);
          if (retry.ok) {
            savePostedId(id, postedIds);
            console.log("Posted (text fallback): " + title.slice(0, 60));
          }
        }
      }
    } catch (err) {
      console.error("Error processing article:", err.message);
    }
  }

  if (toPost.length === 0) {
    console.log("No new articles to post this hour.");
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
