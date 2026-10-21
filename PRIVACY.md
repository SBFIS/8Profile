# Privacy & data protection — G8 PE Profile

For review by the FIS data-protection lead before go-live. This app displays, to each
Grade 8 student, PE information about that student only. It handles personal data of
minors under GDPR, so it is built to keep everything inside the FIS Google Workspace.

## Summary

| | |
|---|---|
| Data subjects | Grade 8 PE students; PE teachers (as users) |
| Controller | Frankfurt International School |
| Processor | Google (Workspace for Education, under the existing FIS agreement). No other processor. |
| Where data lives | One Google Sheet owned by the PE teacher's FIS account, inside the FIS Workspace |
| Where code runs | The page is static HTML served by GitHub Pages (no data on it). All data handling runs in Google Apps Script bound to that Sheet, in the FIS Workspace. |
| Who can use the app | Only verified `@fis.edu` Google accounts: every request carries a Google sign-in token that the server verifies with Google before answering |
| What a student sees | Their own rows only. The class list never reaches a browser. |
| Third parties | GitHub serves the page code (no data). Google provides sign-in and hosts the data. No analytics, trackers, or cookies beyond Google's session. |
| This repository | Code only. No data, no secrets. Test data is synthetic (`example.edu`). |

## Data inventory (v1)

| Tab | Fields | Source | Purpose |
|---|---|---|---|
| Students | Email, Name, Class | Existing PE roster, entered by the teacher | Recognise the signed-in student and greet them |
| Teachers | Email, Name | Teacher | Show the teacher screen instead of a student profile |
| Profile | Email, Style (one of six labels), Goal (≤140 chars, optional, own words), Updated | Written by the student through the app | Persist the student's chosen PE Style / goal |
| Predictions | Email, Checkpoint (`intro`), Timestamp, and for each of 13 fitness/skill items a rating (strength · neutral · work-on) and a frequency (often · sometimes · rarely) | Entered by the student in the Lesson 1 "Strengths & challenges" activity | The student's own prediction, shown back to them and later lined up against their Combine results. **New data created by the app** (self-perception, low sensitivity), one row per student per checkpoint, no free text |
| APLog | Email, Date, Source (`self` or `teacher`), Round (teacher only: s1-mid · s1-end · s2-mid · s2-end), five 1–7 Active Participation ratings, Updated | Self rows: the student's own check-in in the app (one per day). Teacher rows: imported by the teacher inside the Sheet from a Canvas Grades or Learning Mastery export (menu "Import AP grades from Canvas…"); the import tab is deleted afterwards | Shown back to that student only, as their self-checks against the teacher's graded rounds. Canvas grades never leave FIS Google: export → this Sheet → APLog |
| Config | key/value settings | Teacher | No personal data |

Later phases add data already collected in PE (Active Participation bands, Combine
fitness numbers, fundamental-skill levels, report bands). The app creates no new
categories of data and no free text beyond the student's own goal. There are no special
categories (health data is not collected; fitness test results are PE assessment data
already held by the school).

## Data flows

1. **Page load.** The browser fetches `index.html` from GitHub Pages. It contains no data
   and makes no request except to load Google's sign-in library.
2. **Sign-in.** Google Identity Services signs the student in on the FIS domain and hands
   the page a Google ID token (name, email, photo URL, expiry, signed by Google). The page
   never sees a password. The token is kept in the tab's session storage only and is
   discarded when the tab closes or the token expires (about an hour).
3. **Request.** The page sends `{ action, token, ...payload }` to the Apps Script API.
4. **Verification.** `verifyToken_()` in `src/Code.gs` asks Google's `tokeninfo` endpoint
   whether the token is genuine (a Google-to-Google call from the FIS script), then checks
   it was issued to the FIS sign-in client, that the email is verified, that the account is
   on the `fis.edu` domain, and that it has not expired. Verified results are cached in
   Apps Script's cache for up to ten minutes, keyed by a hash of the token. This is the
   only place an identity is established. Nothing else in the request (an email, an ID) is
   ever used as identity.
5. **Read.** `bootstrap_()` matches the verified address against the Students tab and
   returns that one row plus that student's Profile and Predictions rows. No function
   returns the roster or any other student's data. The response does not contain the
   student's own email.
6. **Write.** `saveStyle_()` / `saveGoal_()` / `savePrediction_()` validate the values and
   upsert one row keyed by the *verified* address (plus checkpoint for predictions). An
   incomplete or malformed prediction is rejected whole.
7. **Photo.** The `picture` claim of the student's own token, a URL on Google's servers, is
   passed back so the page can show it while signed in. Nothing is copied, stored or logged.
8. **Logs.** Apps Script keeps execution logs in Google Cloud (Stackdriver) for the FIS
   project. The code never logs emails, tokens or data, and error messages sent to users
   contain no email.

## Google API scopes (least privilege)

Declared in `src/appsscript.json`:

| Scope | Why |
|---|---|
| `spreadsheets.currentonly` | Read/write the one Sheet the script is bound to. No access to other Drive files. |
| `script.external_request` | Call Google's `tokeninfo` endpoint to verify sign-in tokens. The only URL the script fetches. |
| `userinfo.email` | Identify the Sheet owner (teacher) inside the script. |

The Google sign-in client requests only the basic profile (name, email, photo) that Sign in
with Google always provides. The script runs as the teacher account, so students are never
asked to grant scopes and need no access to the Sheet.

The web app is deployed with access "Anyone" so that a page on GitHub Pages can call it.
That setting does not expose data: without a valid FIS token every request is refused
with "Please sign in", and the API URL opened in a browser returns a one-line note.

## Third-party requests

- GitHub Pages serves the page code. GitHub sees the request for the page (IP address,
  as for any website) but never any student data; nothing is sent back to GitHub.
- Google: the sign-in library from `accounts.google.com`, the sign-in itself, the
  Apps Script API, and the student's own photo URL. All within Google.
- No analytics, no fonts from third parties (system fonts are used), no other requests.
- The PNG "download my card" feature from the mockups uses the `html2canvas` library from
  a CDN. It is **not** in the app. It will be added only with the library vendored into
  the repo, so no third-party request is made.

## Retention & deletion

- Profile rows (style, goal) and Predictions rows are the only app-written data. The
  Sheet menu **PE Profile → End of year: clear student data…** deletes them all. Proposed retention:
  delete at the end of each school year. **To be confirmed by the DP lead.**
- Students and Teachers tabs are the school's existing roster data; retention follows the
  school's roster policy.
- A single student's data can be removed by deleting their row(s) in the Sheet.
- No copies exist outside the Sheet: the browser holds only the sign-in token for the tab
  session (about an hour) and a per-tab draft of the prediction until it is saved; no
  exports, no emails.

## Points to confirm with the data-protection lead before go-live

1. **Lawful basis and parental information.** The app displays PE assessment data the
   school already holds. Confirm whether the existing school/parent information covers
   it, or whether a notice (or consent for the optional photo) is needed.
2. **Retention period** for Profile rows and, in later phases, for assessment data shown
   in the app (proposal above).
3. **Google directory photo.** Showing the account photo inside a school app is
   arguably within existing Workspace use, but confirm it. (It is the picture on the sign-in token.)
4. **Web fonts.** Keep off unless approved (see above).
5. **Teacher accounts.** Teachers see only a teacher screen in v1. Later phases may add a
   teacher "view a student's profile" function; that is a new access path and should be
   reviewed when designed.
6. **Self-prediction data.** The Lesson 1 activity is the first thing the app *creates*
   rather than displays: a student's own opinion of their strengths and challenges. It
   is shown only to that student (and, in the Sheet, the PE teacher). Confirm this is
   covered by the same basis as the rest of PE assessment.
7. **Later phases** (AP, Combine, skill levels, report bands) widen the data displayed.
   Each phase updates the inventory above and is re-reviewed.

## The GitHub Pages address

`index.html` at the repo root is the student page, published on GitHub Pages. It contains
no data: it signs the student in with Google and asks the FIS Apps Script API for that
student's own rows. The API URL and the sign-in client ID are visible in the page. That is
acceptable because access is enforced by Google sign-in and the server's token check, not by
keeping those values secret.

## Repository hygiene

- `.gitignore` excludes config, data, exports and screenshots. Only `data/dummy/` (synthetic)
  is allowed in.
- Commits, issues and screenshots must never contain real students. Test with dummy
  FIS accounts and synthetic data only.
- No AI tool is ever given real student data; development uses synthetic data only.
