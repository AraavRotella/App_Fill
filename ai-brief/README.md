# AI Brief

A phone-first web app (installable PWA) for your morning: the newest AI news that matters to programmers, a spoken audio briefing, and daily interview drills.

## Features
- **Morning briefing player**: reads out the top stories and the interview question of the day (play/pause, skip, 0.8×–1.5× speed, voice picker; lock-screen controls where the browser supports them).
- **News feed** from Hacker News (AI stories, last 36h), Hugging Face Daily Papers, new trending GitHub AI repos, and DEV articles. Filter chips, save for later, read tracking, plus focus keywords to boost topics you care about.
- **Interview tab**: 4 cards a day (coding pattern, system design, AI/ML concept, behavioral). Each has a reveal answer and follow-up. Mark "Got it" or "Review", and cards marked for review come back more often.
- **Optional AI coach**: add an Anthropic API key in Settings to get a short daily "what this means for you + interview talking point", read aloud in the briefing. The key is stored only on your device.
- Works offline with the last brief cached. Has a 🔥 daily streak.

## Put it on your phone
1. Merge this into `main`, then in the repo go to **Settings → Pages → Source: GitHub Actions**.
2. The workflow publishes to `https://<your-username>.github.io/App_Fill/`.
3. Open that URL on your phone:
   - **iPhone (Safari):** Share → *Add to Home Screen*
   - **Android (Chrome):** ⋮ → *Install app*

## Run locally
```bash
cd ai-brief && python3 -m http.server 8000
```
