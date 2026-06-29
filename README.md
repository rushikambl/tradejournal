# TradeJournal

A premium options-trading drawdown tracker. Multi-account (login-based), per-strategy
peak drawdown tracking, portfolios, account-level P&L reconciliation, and a dark
"graphite instrument" UI. Vanilla ES modules + Firebase (Firestore + Auth) + Chart.js.
No build step.

## Files
- `index.html` — app shell, login screen, all pages, modals
- `app.js` — all logic (auth, data, drawdown engine, rendering, CSV import)
- `style.css` — the dark UI theme
- `firebase-config.js` — your Firebase web config
- `firestore.rules` — security rules (multi-account isolation)
- `manifest.json` — PWA manifest

## Features
- Email/password login; isolated data per account
- Account hierarchy: superadmin -> managers -> users. Managers can create child accounts;
  a creator can view (read-only) the P&L of accounts they directly created
- Strategy master with a per-strategy delta threshold
- Portfolios = named combos of strategies, with portfolio-wise P&L and "running" toggles
- Peak-based drawdown engine (continuous, never resets) with per-lot delta alerts
- Account-level adjustments: enter your actual P&L and the difference is logged so the
  account total matches reality - never added under any strategy
- Dashboard shows all-time and active P&L side by side
- CSV import/export (reads the app's own export format)

## Setup

### 1. Firebase config
Paste your web config into `firebase-config.js`
(Firebase Console -> Project settings -> Your apps -> SDK setup and configuration).

### 2. Enable Email/Password auth
Firebase Console -> Authentication -> Sign-in method -> enable Email/Password.

### 3. Publish security rules
Open `firestore.rules`, change the `SUPERADMIN()` line to YOUR email, then paste the
file into Firestore Database -> Rules -> Publish.

### 4. First-time setup
Open the app -> "First-time setup" -> create the superadmin with that same email.
On first login it claims any existing data as yours.

## Run locally
ES modules need a local server (not file://):

```bash
python -m http.server 8080
# or
npx serve .
```

Then open http://localhost:8080

## Deploy (GitHub Pages)
1. Push this folder to a repo
2. Settings -> Pages -> Deploy from branch -> main -> / (root) -> Save
3. Live at https://<username>.github.io/<repo>
4. On mobile: open the URL -> Add to Home Screen
