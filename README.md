# 🇵🇱 Polish News Telegram Bot

Automatyczny bot, który co godzinę publikuje najważniejsze wiadomości z polskich portali na Twoim kanale Telegram — ze zdjęciem, krótkim opisem po polsku i hashtagami.

---

## 📡 Źródła wiadomości

| Portal | Feed |
|--------|------|
| WP Wiadomości | rss.wp.pl |
| Onet Wiadomości | wiadomosci.onet.pl |
| TVN24 | tvn24.pl |
| Gazeta.pl | gazeta.pl |
| Polsat News | polsatnews.pl |
| RMF FM | rmf.fm |
| Radio ZET | radiozet.pl |

---

## ⚙️ Instalacja (krok po kroku)

### Krok 1 — Utwórz bota Telegram

1. Otwórz Telegram i napisz do **@BotFather**
2. Wpisz `/newbot`
3. Podaj nazwę i username bota
4. Skopiuj **token API** (wygląda tak: `123456:ABCdef...`)

### Krok 2 — Utwórz kanał i dodaj bota

1. Utwórz nowy kanał w Telegram
2. Wejdź w **Ustawienia kanału → Administratorzy**
3. Dodaj swojego bota jako administratora z uprawnieniem **"Publikowanie wiadomości"**
4. Skopiuj username kanału (np. `@MojKanal`) lub ID kanału

### Krok 3 — Klucz Anthropic API

1. Wejdź na https://console.anthropic.com
2. Utwórz konto / zaloguj się
3. Wygeneruj klucz API

### Krok 4 — Konfiguracja projektu

```bash
# Sklonuj lub pobierz pliki projektu
cd polish-news-bot

# Zainstaluj zależności
npm install

# Utwórz plik .env
cp .env.example .env
```

Otwórz `.env` i uzupełnij:
```env
TELEGRAM_TOKEN=123456789:ABCdefGHIjklMNOpqrSTUvwxyz
TELEGRAM_CHANNEL=@NazwaKanalu
ANTHROPIC_API_KEY=sk-ant-...
```

### Krok 5 — Uruchom bota

```bash
# Załaduj zmienne środowiskowe i uruchom
node --env-file=.env bot.js
```

Bot uruchomi się natychmiast i będzie publikować co godzinę (o pełnej godzinie).

---

## 🔧 Konfiguracja

W pliku `bot.js` możesz zmienić:

```js
const MAX_NEWS_PER_RUN = 5;  // Ile artykułów publikować co godzinę
```

Aby dodać nowe źródła RSS, dopisz do tablicy `RSS_FEEDS`:
```js
{ name: "Nazwa Portalu", url: "https://portal.pl/rss.xml" },
```

---

## 🖥️ Uruchomienie ciągłe (serwer)

### Opcja A — PM2 (zalecane)

```bash
npm install -g pm2
pm2 start bot.js --name "polish-news-bot" --env production
pm2 save
pm2 startup   # Autostart po restarcie serwera
```

### Opcja B — systemd (Linux)

Utwórz `/etc/systemd/system/polish-news-bot.service`:
```ini
[Unit]
Description=Polish News Telegram Bot
After=network.target

[Service]
WorkingDirectory=/path/to/polish-news-bot
ExecStart=/usr/bin/node --env-file=.env bot.js
Restart=always
User=yourusername

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable polish-news-bot
sudo systemctl start polish-news-bot
```

### Opcja C — Docker

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
CMD ["node", "--env-file=.env", "bot.js"]
```

---

## 📋 Wymagania

- Node.js 18 lub nowszy
- Konto Anthropic z kluczem API
- Bot Telegram jako administrator kanału

---

## 💬 Przykład wpisu na kanale

```
📰 Sejm uchwalił nową ustawę o ochronie danych

Posłowie przyjęli wczoraj wieczorem kontrowersyjną ustawę 
dotyczącą ochrony danych osobowych. Za głosowało 231 posłów, 
przeciw 189. Ustawa wejdzie w życie za 30 dni.

#Polityka #Polska #Sejm #Prawo #RODO

📌 TVN24  |  Czytaj więcej →
```
