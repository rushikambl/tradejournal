# TradeJournal

Options trading drawdown tracker — dark web app, works on mobile & desktop, Firebase backend.

## Setup

### 1. Firebase config
Open `firebase-config.js` and paste your Firebase project config:

```js
export const firebaseConfig = {
  apiKey:            "...",
  authDomain:        "...",
  projectId:         "...",
  storageBucket:     "...",
  messagingSenderId: "...",
  appId:             "..."
};
```

Get your config from:  
**Firebase Console → Project Settings → Your Apps → SDK setup and configuration**

### 2. Get your config
1. Go to [console.firebase.google.com](https://console.firebase.google.com)
2. Select your **TRADE JOURNAL** project
3. Click the ⚙️ gear → **Project settings**
4. Scroll to **Your apps** → click the web app `</>` icon (add one if none)
5. Copy the `firebaseConfig` object and paste into `firebase-config.js`

### 3. Run locally
Since the app uses ES modules you need a local server (not just opening the file):

```bash
# Option A — Python
python -m http.server 8080

# Option B — Node
npx serve .

# Option C — VS Code
Install "Live Server" extension → right-click index.html → Open with Live Server
```

Then open `http://localhost:8080`

---

## Deploy to GitHub Pages (use on mobile via browser)

1. Push this folder to a GitHub repo
2. Go to repo **Settings → Pages**
3. Source: **Deploy from branch** → `main` → `/ (root)` → Save
4. Your app will be live at `https://yourusername.github.io/your-repo-name`
5. On mobile: open that URL in Chrome/Safari → **Add to Home Screen** → works like an app

---

## Features
- Dark premium UI, mobile-first
- Firebase Firestore — real-time sync across all devices
- 200% & 300% strategy tracking
- Peak-based drawdown engine (continuous, never resets)
- ↑ delta alert when DD/lot ≥ threshold
- ↓ normalize delta when DD recovers to peak
- Filters: strategy, symbol, date range, profit/loss/alerts
- Charts: combined P&L, per-strategy, by symbol, DD timeline
- CSV export
- PWA — installable on mobile home screen
