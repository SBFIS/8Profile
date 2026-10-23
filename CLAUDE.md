# CLAUDE.md — G8 PE Profile

Student-facing PE profile for Grade 8 at FIS. A static page on GitHub Pages (built to
`index.html`) that signs the student in with Google and calls a Google Apps Script JSON API
bound to an FIS-owned Sheet. Read `PRIVACY.md` and `PLAN.md` first.

## Privacy rules (non-negotiable)

- **No real student data, ever, in this repo or in any prompt.** Names, emails, scores,
  photos, rosters, screenshots of real students: none. Test with `data/dummy/` and the
  preview's synthetic `example.edu` roster only.
- **No Sheet IDs, script IDs or tokens in the repo.** `config.json` is git-ignored;
  `config.example.json` shows the shape with placeholders. Public values only live in
  `site.config.json` (the API `/exec` URL and the Google sign-in client ID): access is
  enforced by the token check, not by their secrecy.
- **Identity is established in one place**: `verifyToken_()` / `identity_()` in
  `src/Code.gs`, from the Google ID token verified with Google (aud, email_verified, hd,
  exp). Never accept an email (or any identifier) from the request body as identity.
- **A student only ever gets their own rows.** No function a student can call may return
  the roster or another student's data. Class-level reads and writes (class dashboard, AP
  check-out kiosk) exist only behind `requireTeacher_()`, return the minimum the screen
  needs (the kiosk: first name + last initial, never ratings), and each has a test proving
  a student is refused. Keep `dev/test-server.js` green; add a check when you add a function.
- **No third-party requests** beyond GitHub serving the page and Google (sign-in library,
  sign-in, API). No CDN scripts, analytics, or fonts. Vendor libraries into the repo instead.
- **No emails or tokens in thrown errors or logs** (they reach Stackdriver).
- Photos: the token's picture claim at runtime only. Never download, copy or store an image.

## Layout

- `src/Code.gs` server (API) · `src/Index.html` shell · `src/Styles.html` CSS · `src/App.html` client · `src/appsscript.json` manifest
- `index.html` GENERATED student page for GitHub Pages (`dev/build-site.js`); `site.config.json` feeds it
- `dist/Code.gs` copy of the server to paste into Apps Script (`dev/build-single.js`). Commit both after `npm run build`
- `lesson1/` teaching deck · `dev/` fake runtime, preview, builders, tests · `design/` mockups · `docs/` rubric bank + brief

## Workflow

```
npm test                                  # server checks (must pass)
npm run preview                           # dev/preview.html?role=student|student2|teacher|unknown|wrong|anon|expired &fail=1 &nophoto=1
NODE_PATH=$(npm root -g) npm run smoke    # Playwright smoke + screenshots (dev/shots/, ignored)
npm run build                             # regenerate index.html and dist/Code.gs before committing
```

Before committing: `npm run check` (tests + builds). Commit `index.html` and `dist/Code.gs`
with the source change. No dependencies to install; Node 18+ and, for smoke, a global Playwright.

## Conventions

- Plain ES5-style in `Code.gs` (Apps Script V8 runs modern JS, but keep it simple and
  `var`-based like `net-games`); modern JS is fine in `App.html`.
- Escape everything rendered with `esc()`. Client state lives in `state`; server is the
  source of truth after every save.
- Visual system: FIS maroon `#6f1d2c`, gold `#e7b64b`, Archivo + Inter (system fallback),
  the six PE-Style skins in `SKINS`. Reuse the mockups in `design/`; do not redesign.
- Rubric wording comes from `docs/G8_PE_Rubric_Bank.md` (single source). Generate, do not
  hand-copy, when v2 needs it.
- Same hosting shape as `aa-dash` (GitHub Pages + Apps Script API), but never its
  client-supplied-email identity: every request is identified by a server-verified token.
