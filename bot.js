/**
 * Polish News Telegram Bot
 * Dependencies: node-cron, rss-parser, node-fetch
 * AI: Google Gemini API (free - https://aistudio.google.com/app/apikey)
 */

import fetch from "node-fetch";
import Parser from "rss-parser";
import cron from "node-cron";
import fs from "fs";

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHANNEL = process.env.TELEGRAM_CHANNEL;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const POSTED_IDS_FILE = "./posted_ids.json";
const MAX_NEWS_PER_RUN = 5;

const RSS_FEEDS = [
  { name: "WP Wiadomosci", url: "https://rss.wp.pl/pub/rss/0/wiadomosci.xml" },
  { name: "Onet Wiadomosci", url: "https://wiadomosci.onet.pl/.feed/onet_wiadomosci_ogolnopolskie.xml" },
  { name: "TVN24", url: "https://tvn24.pl/najnowsze.xml" },
  { name: "Gazeta.pl", url: "https://rss.gazeta.pl/pub/rss/najwazniejsze.xml" },
  { name: "Polsat News", url: "https://www.polsatnews.pl/rss/wszystkie.xml" },
  { name: "RMF FM", url: "https://www.rmf.fm/rss/feed.xml" },
  { name: "Radio ZET", url: "https://wiadomosci.radiozet.pl/rss/feed.xml" },
];

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
  const arr = [...postedIds].slice(-500);
  fs.writeFileSync(POSTED_IDS_FILE, JSON.stringify(arr));
}

function extractImageUrl(item) {
  if (item.mediaContent && item.mediaContent.$ && item.mediaContent.$.url) return item.mediaContent.$.url;
  if (item.mediaThumbnail && item.mediaThumbnail.$ && item.mediaThumbnail.$.url) return item.mediaThumbnail.$.url;
  if (item.enclosure && item.enclosure.url) return item.enclosure.url;
  const content = item.content || item.summary || item.description || "";
  const imgMatch = content.match(/<img[^>]+src=["']([^"']+)["']/i);
  if (imgMatch) return imgMatch[1];
  return null;
}

function stripHtml(html) {
  if (!html) return "";
  return html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function buildFallback(title, description) {
  const summary = stripHtml(description).slice(0, 200) || title;
  return { summary, hashtags: ["#Polska", "#Wiadomosci", "#News"] };
}

async function generateSummaryAndHashtags(title, description, source) {
  const cleanDesc = stripHtml(description).slice(0, 800);

  const prompt = "Jestes redaktorem polskiego kanalu informacyjnego na Telegramie.\n"
    + "Napisz KROTKIE podsumowanie wiadomosci po polsku (max 2 zdania) i zaproponuj 4-6 hashtagow.\n\n"
    + "Tytul: " + title + "\n"
    + "Opis: " + cleanDesc + "\n"
    + "Zrodlo: " + source + "\n\n"
    + 'Odpowiedz TYLKO w JSON: {"summary": "...", "hashtags": ["#Tag1", "#Tag2"]}';

  try {
    const res = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=" + GEMINI_API_KEY,
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
      console.warn("Gemini no candidates. Full response:", JSON.stringify(data));
      return buildFallback(title, description);
    }

    const text = data.candidates[0]?.content?.parts?.[0]?.text?.trim();
    if (!text) {
      console.warn("Gemini empty text for:", title.slice(0, 50));
      return buildFallback(title, description);
    }

    const clean = text.replace(/```json|```/g, "").trim();
    return JSON.parse(clean);

  } catch (err) {
    console.warn("Gemini error, using fallback:", err.message);
    return buildFallback(title, description);
  }
}

async function sendPhotoToTelegram(channelId, imageUrl, caption) {
  const url = "https://api.telegram.org/bot" + TELEGRAM_TOKEN + "/sendPhoto";
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: channelId, photo: imageUrl, caption, parse_mode: "HTML" }),
  });
  return res.json();
}

async function sendMessageToTelegram(channelId, text) {
  const url = "https://api.telegram.org/bot" + TELEGRAM_TOKEN + "/sendMessage";
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: channelId, text, parse_mode: "HTML", disable_web_page_preview: false }),
  });
  return res.json();
}

function escapeHtml(str) {
  if (!str) return "";
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function fetchAllNews() {
  const allItems = [];
  for (const feed of RSS_FEEDS) {
    try {
      console.log("Fetching: " + feed.name);
      const parsed = await parser.parseURL(feed.url);
      const items = (parsed.items || []).slice(0, 5).map((item) => ({ ...item, sourceName: feed.name }));
      allItems.push(...items);
    } catch (err) {
      console.warn("Could not fetch " + feed.name + ": " + err.message);
    }
  }
  allItems.sort((a, b) => new Date(b.pubDate || b.isoDate || 0) - new Date(a.pubDate || a.isoDate || 0));
  return allItems;
}

async function runNewsBot() {
  console.log("\n[" + new Date().toISOString() + "] Running news bot...");
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

  console.log("Found " + newArticles.length + " new articles");
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
        if (imageUrl && result.description && result.description.includes("photo")) {
          const retry = await sendMessageToTelegram(TELEGRAM_CHANNEL, caption);
          if (retry.ok) {
            savePostedId(id, postedIds);
            console.log("Posted (text fallback): " + title.slice(0, 60));
          }
        }
      }

      await new Promise((r) => setTimeout(r, 2000));
    } catch (err) {
      console.error("Error processing article:", err.message);
    }
  }

  console.log("Done! Posted " + toPost.length + " articles.\n");
}

console.log("Polish News Bot starting...");
console.log("Channel: " + TELEGRAM_CHANNEL);
console.log("Schedule: every hour\n");

runNewsBot();
cron.schedule("0 * * * *", runNewsBot);
