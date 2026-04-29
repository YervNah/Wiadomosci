/**
 * 🇵🇱 Polish News Telegram Bot
 * Fetches top news from Polish websites every hour and posts to Telegram.
 *
 * Dependencies: node-cron, rss-parser, node-fetch
 * AI: Google Gemini API (free — https://aistudio.google.com/app/apikey)
 */

import fetch from "node-fetch";
import Parser from "rss-parser";
import cron from "node-cron";
import fs from "fs";

// ─── CONFIG ────────────────────────────────────────────────────────────────
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN; // Your bot token
const TELEGRAM_CHANNEL = process.env.TELEGRAM_CHANNEL; // e.g. @MojKanal or -100123456789
const GEMINI_API_KEY = process.env.GEMINI_API_KEY; // Free key from aistudio.google.com
const POSTED_IDS_FILE = "./posted_ids.json";
const MAX_NEWS_PER_RUN = 5; // How many articles to post each hour

// ─── POLISH NEWS RSS FEEDS ─────────────────────────────────────────────────
const RSS_FEEDS = [
  { name: "WP Wiadomości", url: "https://rss.wp.pl/pub/rss/0/wiadomosci.xml" },
  {
    name: "Onet Wiadomości",
    url: "https://wiadomosci.onet.pl/.feed/onet_wiadomosci_ogolnopolskie.xml",
  },
  {
    name: "TVN24",
    url: "https://tvn24.pl/najnowsze.xml",
  },
  {
    name: "Gazeta.pl",
    url: "https://rss.gazeta.pl/pub/rss/najwazniejsze.xml",
  },
  {
    name: "Polsat News",
    url: "https://www.polsatnews.pl/rss/wszystkie.xml",
  },
  {
    name: "RMF FM",
    url: "https://www.rmf.fm/rss/feed.xml",
  },
  {
    name: "Radio ZET",
    url: "https://wiadomosci.radiozet.pl/rss/feed.xml",
  },
];

// ─── HELPERS ───────────────────────────────────────────────────────────────
const parser = new Parser({
  customFields: {
    item: [
      ["media:content", "mediaContent", { keepArray: false }],
      ["media:thumbnail", "mediaThumbnail", { keepArray: false }],
      ["enclosure", "enclosure"],
    ],
  },
});

function loadPostedIds() {
  if (fs.existsSync(POSTED_IDS_FILE)) {
    return new Set(JSON.parse(fs.readFileSync(POSTED_IDS_FILE, "utf8")));
  }
  return new Set();
}

function savePostedId(id, postedIds) {
  postedIds.add(id);
  // Keep only the last 500 IDs to avoid the file growing too large
  const arr = [...postedIds].slice(-500);
  fs.writeFileSync(POSTED_IDS_FILE, JSON.stringify(arr));
}

function extractImageUrl(item) {
  // Try various RSS image fields
  if (item.mediaContent?.$ ?.url) return item.mediaContent.$.url;
  if (item.mediaThumbnail?.$ ?.url) return item.mediaThumbnail.$.url;
  if (item.enclosure?.url) return item.enclosure.url;
  if (item["media:content"]?.$ ?.url) return item["media:content"].$.url;

  // Try to extract from content
  const content = item.content || item.summary || item.description || "";
  const imgMatch = content.match(/<img[^>]+src=["']([^"']+)["']/i);
  if (imgMatch) return imgMatch[1];

  return null;
}

function stripHtml(html) {
  if (!html) return "";
  return html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

async function generateSummaryAndHashtags(title, description, source) {
  const cleanDesc = stripHtml(description).slice(0, 800);

  const prompt = `Jesteś redaktorem polskiego kanału informacyjnego na Telegramie.
Napisz KRÓTKIE podsumowanie wiadomości po polsku (max 2 zdania, ~80 słów) i zaproponuj 4-6 tematycznych hashtagów.

Tytuł: ${title}
Opis: ${cleanDesc}
Źródło: ${source}

Odpowiedź TYLKO w formacie JSON (bez komentarzy, bez backticks):
{"summary": "Krótkie podsumowanie po polsku...", "hashtags": ["#Polityka", "#Polska", "..."]}`;

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
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
  const text = data.candidates[0].content.parts[0].text.trim();
  const clean = text.replace(/```json|```/g, "").trim();
  return JSON.parse(clean);
}

async function sendPhotoToTelegram(channelId, imageUrl, caption) {
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendPhoto`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: channelId,
      photo: imageUrl,
      caption: caption,
      parse_mode: "HTML",
    }),
  });
  return res.json();
}

async function sendMessageToTelegram(channelId, text) {
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: channelId,
      text: text,
      parse_mode: "HTML",
      disable_web_page_preview: false,
    }),
  });
  return res.json();
}

// ─── MAIN LOGIC ────────────────────────────────────────────────────────────
async function fetchAllNews() {
  const allItems = [];

  for (const feed of RSS_FEEDS) {
    try {
      console.log(`📡 Fetching: ${feed.name}`);
      const parsed = await parser.parseURL(feed.url);
      const items = (parsed.items || []).slice(0, 5).map((item) => ({
        ...item,
        sourceName: feed.name,
      }));
      allItems.push(...items);
    } catch (err) {
      console.warn(`⚠️  Could not fetch ${feed.name}: ${err.message}`);
    }
  }

  // Sort by publication date (newest first)
  allItems.sort((a, b) => {
    const dateA = new Date(a.pubDate || a.isoDate || 0);
    const dateB = new Date(b.pubDate || b.isoDate || 0);
    return dateB - dateA;
  });

  return allItems;
}

async function runNewsBot() {
  console.log(`\n🚀 [${new Date().toLocaleString("pl-PL")}] Running news bot...`);

  const postedIds = loadPostedIds();
  let articles;

  try {
    articles = await fetchAllNews();
  } catch (err) {
    console.error("❌ Failed to fetch news:", err.message);
    return;
  }

  // Filter out already-posted articles
  const newArticles = articles.filter((item) => {
    const id = item.guid || item.link || item.title;
    return id && !postedIds.has(id);
  });

  console.log(`📰 Found ${newArticles.length} new articles`);

  const toPost = newArticles.slice(0, MAX_NEWS_PER_RUN);

  for (const item of toPost) {
    const id = item.guid || item.link || item.title;
    const title = item.title || "Brak tytułu";
    const link = item.link || "";
    const imageUrl = extractImageUrl(item);

    try {
      console.log(`✍️  Processing: ${title.slice(0, 60)}...`);

      // Generate Polish summary + hashtags via Claude
      const { summary, hashtags } = await generateSummaryAndHashtags(
        title,
        item.contentSnippet || item.description || item.content || "",
        item.sourceName
      );

      const hashtagString = Array.isArray(hashtags) ? hashtags.join(" ") : "";

      // Build Telegram message
      const caption =
        `📰 <b>${escapeHtml(title)}</b>\n\n` +
        `${escapeHtml(summary)}\n\n` +
        `${hashtagString}\n\n` +
        `📌 <i>${item.sourceName}</i>  |  <a href="${link}">Czytaj więcej →</a>`;

      // Post with image if available, otherwise text only
      let result;
      if (imageUrl) {
        result = await sendPhotoToTelegram(TELEGRAM_CHANNEL, imageUrl, caption);
      } else {
        result = await sendMessageToTelegram(TELEGRAM_CHANNEL, caption);
      }

      if (result.ok) {
        console.log(`✅ Posted: ${title.slice(0, 60)}`);
        savePostedId(id, postedIds);
      } else {
        console.warn(`⚠️  Telegram error for "${title.slice(0, 40)}":`, result.description);
        // If image failed, retry without image
        if (imageUrl && result.description?.includes("photo")) {
          const retry = await sendMessageToTelegram(TELEGRAM_CHANNEL, caption);
          if (retry.ok) {
            savePostedId(id, postedIds);
            console.log(`✅ Posted (text fallback): ${title.slice(0, 60)}`);
          }
        }
      }

      // Small delay between posts to avoid rate limiting
      await new Promise((r) => setTimeout(r, 2000));
    } catch (err) {
      console.error(`❌ Error processing article: ${err.message}`);
    }
  }

  console.log(`✨ Done! Posted ${toPost.length} articles.\n`);
}

function escapeHtml(str) {
  if (!str) return "";
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ─── START ─────────────────────────────────────────────────────────────────
console.log("🇵🇱 Polish News Bot starting...");
console.log(`📢 Channel: ${TELEGRAM_CHANNEL}`);
console.log(`⏰ Schedule: every hour\n`);

// Run immediately on startup
runNewsBot();

// Then run every hour at minute 0
cron.schedule("0 * * * *", runNewsBot);
