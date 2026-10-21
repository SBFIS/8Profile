# G8 PE Profile — FIS Grade 8

A student-facing PE profile for Grade 8 at Frankfurt International School. A student
opens one link, signs in with their FIS Google account, is greeted by name, picks their
**PE Style** (their athlete-card identity, saved), makes their Lesson 1 **strengths &
challenges** prediction, and sees what the year holds. Later phases fill the profile and
card with their real Active Participation, Combine and fundamental-skill data (see `PLAN.md`).

**This repo is code only.** No rosters, no names, no scores, no photos, no Sheet IDs.
Real data lives only in an FIS-owned Google Sheet and is read at runtime for the
signed-in student alone. Read `PRIVACY.md` before changing anything that touches
identity or data.

## How it works

```
student's browser on GitHub Pages ── Sign in with Google (accounts.google.com) ──▶ Google ID token
        │
        │  POST { action, token } as JSON
        ▼
Apps Script API (inside the FIS Sheet, executes as the owner, access "Anyone")
        │  verifyToken_(): asks Google (tokeninfo) that the token is genuine,
        │  issued to our sign-in client, for a verified @fis.edu account, not expired
        │  identity_() → the caller's own Students row
        │  bootstrap / saveStyle / saveGoal / savePrediction → that student's rows only
        ▼
FIS-owned Google Sheet: Config · Students · Teachers · Profile · Predictions
```

- **The page** (`index.html`, built from `src/`) is served by GitHub Pages like the other
  FIS PE apps, so the school filter treats it the same way. It holds no data.
- **Sign-in** is Google Identity Services with the FIS sign-in client. The page keeps the
  token for the tab session only and sends it with every request.
- **The API** is a container-bound Apps Script web app deployed *Execute as Me*, *Anyone*.
  "Anyone" is what lets a page on another origin call it; access is enforced by the token
  check, not by the deployment setting. The browser never sends an email or an ID as
  identity, and the server never trusts one.
- **Photo**: the picture claim of the student's own token, shown while signed in. Never
  copied or stored.
- **Lesson 1 activity**: "Strengths & challenges" self-prediction (13 items × traffic light
  + frequency) saved to a `Predictions` tab, one row per student per checkpoint, shown
  back as a summary and later compared with Combine data (compare view is a stub).
- No CDN scripts beyond Google's sign-in library, no analytics, no fonts from third parties.

The earlier design served the page from Apps Script itself (`HtmlService`). It worked for
staff but the student web filter blocks Google-hosted script pages, which is why the app
now follows the same GitHub Pages + API shape as the other FIS PE projects.

## Layout

```
index.html         GENERATED student page (GitHub Pages) — node dev/build-site.js. Commit it.
site.config.json   public values baked into the page: API URL, sign-in client ID, domain
src/
  Code.gs          server: token verification, identity, bootstrap, saveStyle/saveGoal/savePrediction, Sheet menu
  Index.html       page shell (placeholders filled by the builders)
  Styles.html      CSS (profile = light mockup, card builder = dark mockup, sign-in, Lesson 1)
  Rubrics.html     GENERATED from docs/G8_PE_Rubric_Bank.md by dev/build-rubrics.js (skill ladders)
  App.html         client: sign-in + API bridge, profile, card builder, predict / summary / compare views
  appsscript.json  manifest: scopes (this Sheet, external request for tokeninfo), web app = ANYONE, executes as deployer
dist/
  Code.gs          copy of src/Code.gs — what gets pasted into the Sheet's script. node dev/build-single.js
lesson1/           the Lesson 1 teaching deck, served at /lesson1/
dev/
  fake-sheets.js   in-memory stand-in for SpreadsheetApp, UrlFetchApp (tokeninfo), ContentService & co
  mock-runtime.js  fake Sign in with Google + fake API (window.fetch → doPost) + synthetic roster (browser preview)
  build-site.js    builds index.html · build-preview.js builds dev/preview.html · build-single.js builds dist/Code.gs
  build-rubrics.js builds src/Rubrics.html from the Rubric Bank
  test-server.js   Node checks: token verification, own-row-only reads, refusals, validated writes
  smoke.js         headless Chromium run of the preview (Playwright); screenshots in dev/shots/ (ignored)
  smoke-checkout.js  the same for the AP check-out: kiosk, spotlight, summary, student trend
data/dummy/        synthetic test data only
design/            the mockups the app is built from (fictional sample data)
docs/              G8_PE_Rubric_Bank.md (data source of truth for v2+), BUILD_BRIEF.md
PRIVACY.md         data flows, scopes, storage, retention — for the FIS data-protection lead
PLAN.md            architecture decisions, milestones v1–v4, open questions
```

## Developing

```
npm test                                      # node dev/test-server.js — server checks against the fake Sheet
npm run preview                               # dev/preview.html — open ?role=student | student2 | teacher | unknown | wrong | anon | expired
                                              #   &fail=1  &latency=800  &reset=1  &nophoto=1  &as=someone@example.edu
NODE_PATH=$(npm root -g) npm run smoke        # needs playwright + Chromium
NODE_PATH=$(npm root -g) npm run smoke:checkout   # AP check-out flow only
npm run build                                 # regenerate index.html and dist/Code.gs — commit both
```

The preview runs the real `Code.gs` in the browser against a fake spreadsheet kept in
`localStorage`, with a fake Google sign-in and a fake API, so token checks, identity and
write logic are exercised too. All preview data is synthetic (`example.edu`).

## Deploying (teacher)

**The Sheet + API, once**

1. Create a Google Sheet **in the FIS Workspace**, owned by the PE teacher account.
2. Extensions → Apps Script. Replace the contents of `Code.gs` with `dist/Code.gs`.
   Project Settings → tick *Show "appsscript.json"* and replace it with `src/appsscript.json`.
3. Save. In the editor's function dropdown pick **`setupTabs`** and click **Run**. Authorise
   with your FIS account when Google asks (Advanced → Go to project if it warns the app is
   unverified). This creates the tabs. Then **reload the Sheet**: the **PE Profile** menu
   appears. (The menu is built on open and cannot ask for authorisation itself.)
4. Fill **Students** (Email · Name · Class) with the Grade 8 roster. Add colleagues to
   **Teachers**. Check **Config**: `domain` = `fis.edu`, `oauth_client_id` = the sign-in
   client the page uses (same value as `site.config.json`), `year_label`.
5. Deploy → New deployment → Web app: *Execute as* **Me**, *Who has access* **Anyone**.
   Copy the `/exec` URL into `site.config.json` → `apiUrl`, run `npm run build`, commit.
   (Opening that URL in a browser only shows a "this is the data service" note.)

**The page**

6. GitHub → Settings → Pages → Deploy from branch `main`, folder `/ (root)`. The student
   link is `https://scottbain-dot.github.io/8Profile/`.
7. The Google sign-in client must list `https://scottbain-dot.github.io` under *Authorised
   JavaScript origins* (Google Cloud console → APIs & Services → Credentials). The FIS PE
   client already does, because the other portals run from the same origin.
8. Test with a **dummy student account** on the roster, a domain account not on the
   roster, and a personal Gmail. Expected: own profile / "not on the list" / "use your FIS
   account". Only then share the link.

**After code changes**: `npm run check`, commit (this rebuilds `index.html` and
`dist/Code.gs`). For server changes also paste the new `dist/Code.gs` and Deploy → Manage
deployments → edit → *New version*. The `/exec` URL stays the same. A *new deployment*
would change it, and then `site.config.json` must be updated and the page rebuilt.

### The GitHub address

`https://scottbain-dot.github.io/8Profile/` is the app, and `https://scottbain-dot.github.io/8Profile/pe/`
is the same page at a second path (the root URL was mis-classified by the student web
filter while it was a redirect page; use whichever the filter allows and ask IT to clear
the root). `index.html` at the repo root is the built page, `pe/index.html` its copy; `lesson1/` holds the Lesson 1 teaching deck (arrow keys or click to move, `f`
for full screen), served at `/8Profile/lesson1/`, whose last slide links to the app.

Keep the Sheet ID and script ID out of this repo (`config.example.json` shows the shape;
`config.json` is git-ignored). The `/exec` URL and the sign-in client ID are public values
and live in `site.config.json`.

### Troubleshooting

- **No "PE Profile" menu.** Run `setupTabs` once from the editor (step 3) and reload the Sheet.
- **"Cannot call SpreadsheetApp.getActiveSpreadsheet"** or tabs appear nowhere: the script is
  not bound to the Sheet. Open the editor from the Sheet via Extensions → Apps Script and paste there.
- **Sign-in button never appears.** The page could not load Google's sign-in library
  (`accounts.google.com`); check the network / filter.
- **"Your sign-in expired" straight after signing in.** The token was refused by the server:
  Config `oauth_client_id` does not match the client in `site.config.json`, or the deployment
  is not the one in `apiUrl`. Fix the value, PE Profile → Clear config cache.
- **Student sees "Use your FIS account".** They signed in with a personal Google account.
- **Name shows the wrong way round.** Names in the Students tab may be "Last, First" or
  "First Last"; the app greets by first name either way and ignores anything before a comma.
- **Changed the Sheet's Config and nothing happens.** Config is cached for two minutes; use
  PE Profile → Clear config cache.
