# Plan — G8 PE Profile

Status: **v3 built on branch `v3-combine-profile` — the populated profile (Combine fitness, 7×6 skill ladders, participation, report bands), the student Results & Planning flow (enter results → goals → workout plan), and the teacher class dashboard + skill entry. Model reconciled to the final system (7 skills × 6 levels; 30 m sprint, Illinois, stork, grip). 77 server checks green; builds clean. Awaiting move to the FIS repo (`Frankfurt-International-School/SB`) and redeploy — see `DEPLOY.md`.** Last updated 2026-10-11.

Earlier status (v1): rebuilt as GitHub Pages + token-verified API after the student web filter blocked Google-hosted script pages; passing local checks, awaiting redeploy. 2026-09-23.

## Decisions taken (and why)

| Decision | Choice | Reason |
|---|---|---|
| Where the page lives | **GitHub Pages**, like the other FIS PE apps; Apps Script is a JSON API only | The first build served the page from Apps Script (`HtmlService`, "Anyone within FIS"). It worked for staff, but the student web filter blocks navigations to Google-hosted script pages, while pages on `scottbain-dot.github.io` calling Apps Script in the background are proven on student devices (aa-dash). |
| Identity | Google ID token from Sign in with Google, **verified server-side** with Google's tokeninfo endpoint (audience, verified email, `hd` = fis.edu, expiry), cached by token hash | The aa-dash shape done properly: the server never trusts a client-supplied email or ID. Same guarantee as the earlier `Session.getActiveUser()` design, without the Google-hosted page. |
| Deployment access | "Anyone", execute as owner | Required for a cross-origin page to call the API. Data access is gated by the token check, not the deployment setting. |
| Photo | The `picture` claim of the student's own token | Free with sign-in, runtime only, no directory APIs or admin settings. |
| Fonts | System stack | No third-party font requests; the deck (teacher-facing) keeps Google Fonts for the projector. |
| Display font | Archivo (brief) with Barlow Condensed → system fallback | The Build-Your-Card mockup uses Archivo; the profile/card mockups use Barlow Condensed. Brief says Archivo. |
| Card download | Deferred | Needs `html2canvas`; ship only when vendored (no CDN). Not in the v1 definition of done. |
| Profile key | Server-verified email | Simplest correct key; the client never supplies it. If the DP lead prefers pseudonymous IDs, add a `StudentID` column to Students and key Profile on it (one-line change in `PROFILE_KEY`). |
| Teacher view (v1) | A plain teacher screen | Any "view as student" function is a new access path; design it with the DP review in v2. |

## Checks on deploy

1. **Sign-in works from the GitHub origin**: the FIS sign-in client lists
   `https://scottbain-dot.github.io` as an authorised JavaScript origin (it does; the other
   portals use it).
2. **A student on the roster** sees their own profile, and their photo if their Google
   account has one.
3. **A non-FIS Google account** gets "Use your FIS account"; an FIS account not on the
   roster gets "Not on the Grade 8 list".
4. **The API URL opened directly** shows only the one-line note.

## Milestones

### v1.2 — GitHub Pages + token-verified API  ✅ built
- [x] Page built to `index.html` from `src/` (`dev/build-site.js`), served by GitHub Pages
- [x] Sign in with Google on the page; token kept for the tab session; sign-out
- [x] Apps Script as JSON API: `doPost` → `verifyToken_` (tokeninfo, aud, email_verified, hd, exp, cached) → `identity_` → handlers
- [x] Photo from the token's picture claim (Google-hosted URLs only)
- [x] Fake sign-in + fake API in the preview; 52 server checks, 45 browser checks
- [ ] Deploy: paste `dist/Code.gs` + manifest, re-authorise, access "Anyone", new version

### v1 — sign-in → greet → pick style (saved) → teaser  ✅ scaffolded
- [x] Server: tabs, config, identity, bootstrap (own row only), saveStyle/saveGoal, menu, retention wipe
- [x] Client: profile page in the mockup's look (teaser card strip, goals, at-a-glance, fitness, nine skill ladders from the Rubric Bank, game skills, participation, report bands, tap-to-open overlays) with every section in its "fills in at the Combine" state; "Build my card" screen with the six-style picker and live reskin; first visit lands on the builder, later visits on the profile
- [x] Roster names in "Last, First" form: greet by first name, ignore the initial
- [x] Google photo (now from the sign-in token; the directory lookup was removed with the move to GitHub Pages)
- [x] Non-student screens: teacher, not-on-list, wrong domain, anonymous, load error
- [x] Dev: fake Sheets runtime, browser preview with synthetic roster, single-file build, 29 server checks, 14 browser smoke checks
- [x] Docs: README (deploy), PRIVACY (for DP lead), this plan, CLAUDE.md
- [x] Deployed to the FIS Sheet; owner saw own profile on the HtmlService version
- [ ] Redeploy as API (see v1.2) and confirm with one **student** account
- [ ] Share `PRIVACY.md` with the DP lead; record the answers to its six questions
- [ ] Go-live: fill Students, share the `/exec` link

### v1 + Lesson 1 — "Strengths & challenges" self-prediction  ✅ built
- [x] `Predictions` tab (Email · Checkpoint · Timestamp · 13 × rating/freq), `savePrediction()` validates all 13 and upserts by verified email + checkpoint
- [x] Predict view (traffic light + frequency per item, progress bar, save only when complete), summary view (strengths / work-ons), profile panel with chips + Edit, compare view stub reading prediction next to `combine` (null until v3)
- [x] Re-opening is editable; saving again overwrites the intro row with a new timestamp
- [x] Wording aligned with the Lesson 1 deck (`lesson1/index.html`, hosted on Pages)

### v1.1 — polish once real students have used it
- Vendor `html2canvas` → "Save my card" PNG (runs inside the school login; the file is the student's own)
- Optional: embed Archivo/Inter as base64 WOFF2 in `Styles.html` so fonts need no third-party request
- Student goal UI (server `saveGoal` already exists; Profile has the column)

### v2 — live Active Participation data
- New tabs fed by the existing AP form responses: self (start/end) and teacher checkpoints for the 5 keys
  (Be ready · Best effort · Growth mindset · Great teammate · Manage myself & feelings)
- Generate the "where I am / next step" wording from `docs/G8_PE_Rubric_Bank.md`
  (write a `dev/build-rubrics.js` that emits `src/Rubrics.html` as a JS object, so the Rubric Bank stays the single source)
- Profile: participation section + trend; card: Effort and Team axes become real
- Data-minimisation rule stays: bootstrap returns the caller's rows only

### v2.1 — AP Check-out (end-of-lesson routine)  ✅ built on `claude/ap-checkout`
- [x] `Checkins` tab (Email · Date · Class · Focus · Who · Rating · Word · Updated), server date, upsert per student/day/focus/rater; cleared at year end
- [x] Teacher-only `checkoutRoster` (one class, first name + last initial, done-today flags, spotlight five; never ratings) and `saveCheckin` (roster email, AP key, self/teacher, 1–7, fixed word list)
- [x] Kiosk on the teacher iPad (class + focus → name → one of four word levels (Not yet · Approaching · Got it · Leading, stored as 2·4·6·7) → word/skip → ✓; students never see numbers), press-and-hold to leave; spotlight rating screen; AP summary with suggested band + CSV
- [x] `RUBRICS.ap` generated from the Rubric Bank §1; student trend (self vs teacher, 90 days) on the profile
- [x] Student "I…" wording for Social Skills, Self Management, Growth Mindset and Self Awareness: drafted in the Rubric Bank from the teacher descriptors
- [ ] Check those four drafted "I…" sets against the G8 student rubric
- [x] No numbers for students anywhere in AP: kiosk, trend, AP tiles and the card's Effort stat show level words (teacher views keep 1–7)
- [x] Check-in reads scan from the bottom of the tab (a tap reads ~today's rows; roster and student view ~90 days), not the whole year
- [ ] DP lead review of the kiosk (PRIVACY.md point 5)

### v3 — Combine + fundamental skills + report bands
- Combine tab: mile, push-ups, sit-to-stand, broad jump, 40 m sprint × Sept/Jan/May
- Skills tab: 9 ladders × level (1–4) × checkpoint, with self → peer → teacher sign-off state
- Report bands: Knowledge · Skills · Concept Transfer (best fit, 1–7) from the Rubric Bank map
- Fill `combineFor_()` so the compare view shows prediction vs. measurement per item
- Card radar from real data; "faint September self" ghost line

### v4 — tiers, badges, progress over time
- Bronze/Silver/Gold from growth · breadth · mastery · consistency (never raw ability)
- Badges (Mile PB, Big Riser, Full Effort, All-Rounder …), per-key sparklines, reflection

## Open questions for Scott
- Confirm the six PE Style names and one-line descriptions as shipped in `src/App.html`.
- Card tier label in v1 shows **BRONZE** for everyone (earned tiers arrive in v4). OK, or hide it until then?
- Class label format on the roster (`8A` vs `8(06B)` as in the mockups): the app shows whatever is in the Class column.
- Who is on the Teachers tab in v1 (only affects who sees the teacher screen).
