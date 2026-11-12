# Bleacher Stats

A mobile-first, offline-capable web app for parents to log their kid's at-bats pitch by pitch.
No login, no server, no build step. Everything is stored on the phone (localStorage).

## Logging a pitch (2 taps for most pitches)

1. **Where it was**: tap a spot on the 5×5 grid (catcher's view; the outlined 3×3 is the strike zone).
   This picks a suggested zone (center = Heart, rest of the zone = Edge, outside = Chase). Or tap
   **Heart / Edge / Chase / Waste** directly; tap a zone button to override the suggestion.
2. **What happened**: Ball, Called strike, Swinging strike, Foul, In play, HBP.
   - **In play** opens a sheet: contact (weak/medium/hard), trajectory, tap the field where the ball
     went, then the outcome (Out/1B/2B/3B/HR/Error), which saves the pitch.
   - HBP needs no zone (it's logged as Waste).

The count is tracked automatically. Walks, strikeouts (fouls with 2 strikes don't count), HBP and balls
in play end the PA on their own. **Undo** removes the last pitch and reopens the PA if that pitch ended it.
The **⋯** menu ends a PA without a pitch result (intentional walk, runner caught stealing, game over).

## Reports

Per game or season, filterable by player: chase rate, zone swing rate, heart take rate, first-pitch
swing rate, whiff rate, zone contact rate, swinging-strike rate, 2-strike chase rate, K rate,
pitches/PA, hard-hit rate, AVG/OBP/SLG, ahead/even/behind count splits, zone heat map
(pitches / swing % / whiff %), spray chart colored by contact quality, and a PA-by-PA log for a game.

Definitions: in-zone = Heart + Edge, out-of-zone = Chase + Waste. Ahead = more balls than strikes,
behind = more strikes than balls, even = equal counts plus 3-2. A stat shows **Small sample**
when the pitches (or PAs) behind it are below the thresholds in `MIN_N` in `js/stats.js`.

## Launch plan: free first

The app ships fully free. In `js/config.js`:

- `pro.enabled: false`: no upgrade UI anywhere. Game and season reports are complete.
- `features.insights` and `features.trends` are built but switched off. Set one to `true` to roll it out.
- When you're ready to charge, set `pro.enabled: true`. The season heat map, spray chart, count
  splits and any switched-on extras then need Pro; logging, game reports, the season stat list,
  CSV export and backups always stay free.

## Getting paid (Stripe)

1. In Stripe, create a product with a yearly and a monthly price, and a **Payment Link** for each.
2. In each Payment Link, set "After payment" to redirect to
   `https://YOUR-DOMAIN/?session_id={CHECKOUT_SESSION_ID}`.
3. Paste the two links into `plans[].url` in `js/config.js` and set the prices you chose.
4. Recommended: turn on purchase checking. Add the environment variable `STRIPE_SECRET_KEY` in
   Vercel or Netlify, then set `verifyUrl: '/api/verify'` in `js/config.js`. This also enables
   "Restore purchase" by email on a new phone and re-checks subscriptions when they renew.
   Without it the app trusts the redirect, so anyone who learns the URL pattern can unlock Pro.
5. Optional: put your Stripe customer-portal link in `manageUrl` so subscribers can cancel themselves.

The check lives in `server/verify-core.js` (unit-tested with a mocked Stripe), with thin wrappers in
`api/verify.js` (Vercel) and `netlify/functions/verify.js` (Netlify). Run through one real test-mode
purchase before launch. On localhost the Pro page has a "Preview Pro" link for trying the paid view.

Before launch also set `supportEmail` in `js/config.js` and read `privacy.html`.

## Data

**Settings** has: CSV export (one row per pitch, with count, zone, location, result, contact,
trajectory, spray x/y, outcome and PA result), JSON backup/restore, and erase. Data lives only in that
browser on that device, so download a backup now and then.

## Run locally

```bash
python3 -m http.server 8080
```

Open http://localhost:8080. Run the logic tests with `npm test` (Node 18+).

## Deploy (free)

It's a static site; publish the folder as-is.

- **Netlify**: drag the folder onto app.netlify.com/drop, or connect the repo (`netlify.toml` is included).
- **Vercel**: `npx vercel` in this folder, or import the repo with framework preset "Other" and no build command.
- **GitHub Pages** also works (all paths are relative).

HTTPS is required for offline/install support (all three provide it). When you ship changes, bump
`VERSION` in `sw.js` so installed phones pick up the new files.

## Files

- `index.html`, `css/app.css`: shell and styles (light/dark follow the phone setting)
- `js/app.js`: screens and tap handling
- `js/stats.js`: count replay, PA building, all stat formulas, CSV (pure, unit-tested)
- `js/store.js`: local storage, backup parsing
- `js/field.js`: field diagram SVG
- `js/config.js`, `js/pro.js`: prices, payment links and the Pro unlock
- `server/`, `api/`, `netlify/functions/`: optional purchase check
- `privacy.html`: privacy policy
- `sw.js`, `manifest.webmanifest`, `icons/`: PWA offline + install
