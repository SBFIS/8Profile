// =============================================================
// G8 PE Profile — Apps Script API (FIS, Grade 8 PE)
// =============================================================
// Lives INSIDE the FIS-owned Google Sheet that holds the roster and the
// profile data. Deployed as a web app (Execute as Me, access "Anyone") that
// answers JSON to the student-facing page on GitHub Pages, the same shape as
// the other FIS PE apps. Every request carries the student's Google sign-in
// token; the server verifies it with Google before answering, and then
// only ever reads or writes that student's own rows.
//
// Tabs (menu "PE Profile → Set up tabs" creates them):
//   Config       Key · Value · What it does
//   Students     Email · Name · Class             the roster, teacher-maintained
//   Teachers     Email · Name                     who gets the teacher view
//   Profile      Email · Style · Goal · Updated   written by the app, one row per student
//   Predictions  Email · Checkpoint · Timestamp · 13 × (rating, freq)   one row per student per checkpoint
//
// Privacy rules baked in (PRIVACY.md is the reviewable version):
//   • identity_() is the only place an identity is established: from the Google
//     ID token, verified with Google (audience, verified email, FIS domain, expiry).
//     Nothing in the request body (email, id) is ever trusted for identity.
//   • Every student handler works on the verified caller's own rows. Class data (the
//     dashboard, the AP check-out kiosk) is returned only behind requireTeacher_().
//   • Errors returned to the client never contain an email (they reach Stackdriver logs).
//   • The photo is the picture claim of the student's own token, passed through at
//     runtime. Nothing is copied or stored.
// =============================================================

// Combine Intro self-prediction ("Strengths & Challenges", Lesson 1). Thirteen
// items, each rated on two axes. Keys match the profile tiles and the Rubric Bank
// ladders, so the compare view can line the prediction up with Combine data later.
var PREDICT_ITEMS = ['cv', 'me', 'power', 'speed', 'throw', 'catch', 'strike', 'dribble', 'kick', 'balance', 'agility', 'jump', 'core'];
var PREDICT_CHECKPOINTS = ['intro'];
var RATINGS = ['strength', 'neutral', 'work-on'];
var FREQS = ['often', 'sometimes', 'rarely'];
function predictionHeaders_() {
  var h = ['Email', 'Checkpoint', 'Timestamp'];
  PREDICT_ITEMS.forEach(function (k) { h.push(k + '_rating'); h.push(k + '_freq'); });
  return h;
}

// ---------- v3 model: Combine fitness, skill ladders, participation, bands ----------
// The seven fundamental skills (balance & agility live on the fitness side now).
var SKILL_KEYS = ['throw', 'catch', 'strike', 'dribble', 'kick', 'jump', 'core'];
// The fitness Combine tests, with the direction a better result moves and a sane range.
// ref = a ROUGH typical-Grade-8 guide [strong, typical] used only for the student's
// "did my prediction match?" check — not a grade. Tune these to your own cohort.
//   dir 'up':   >= ref[0] strong · >= ref[1] typical · below = work-on
//   dir 'down': <= ref[0] strong · <= ref[1] typical · above = work-on
var FITNESS = [
  { key: 'mile',     label: 'Mile run',         unit: 'sec',    dir: 'down', min: 180, max: 1200, ref: [540, 720] },
  { key: 'pushups',  label: 'Push-ups',         unit: 'reps',   dir: 'up',   min: 0,   max: 150,  ref: [25, 12] },
  { key: 'sitstand', label: 'Sit-to-stand',     unit: 'reps',   dir: 'up',   min: 0,   max: 150,  ref: [45, 32] },
  { key: 'broad',    label: 'Broad jump',       unit: 'cm',     dir: 'up',   min: 40,  max: 360,  ref: [190, 150] },
  { key: 'grip',     label: 'Grip strength',    unit: 'kg',     dir: 'up',   min: 3,   max: 90,   ref: [30, 20] },
  { key: 'sprint',   label: '30 m sprint',      unit: 'sec',    dir: 'down', min: 3,   max: 15,   ref: [5.0, 5.8] },
  { key: 'illinois', label: 'Illinois agility', unit: 'sec',    dir: 'down', min: 10,  max: 45,   ref: [17.0, 19.5] },
  { key: 'stork',    label: 'Stork balance',    unit: 'losses', dir: 'down', min: 0,   max: 80,   ref: [3, 8] }
];
var FIT_KEYS = FITNESS.map(function (f) { return f.key; });
var FIT_BY_KEY = {}; FITNESS.forEach(function (f) { FIT_BY_KEY[f.key] = f; });
var AP_KEYS = ['ready', 'effort', 'growth', 'team', 'manage'];
var BAND_KEYS = ['knowledge', 'skills', 'concept'];
var COMBINE_CHECKPOINTS = ['sept', 'jan', 'may'];
var SKILL_MIN = 1, SKILL_MAX = 6;
// Teacher AP grades: twice a semester, imported from Canvas. Order = timeline order.
var AP_ROUNDS = ['s1-mid', 's1-end', 's2-mid', 's2-end'];
var AP_ROUND_LABELS = { 's1-mid': 'S1 mid', 's1-end': 'S1 end', 's2-mid': 'S2 mid', 's2-end': 'S2 end' };
var AP_SELF_MAX = 120; // most recent self-checks returned per student
// AP check-out (end of lesson, on the teacher's iPad): one AP key is the focus of the day.
// A student's tap is a self-check (Source 'self'); the teacher's lesson rating has its own
// Source 'lesson' and is never mixed with the summative Canvas grades (Source 'teacher').
var CHECKIN_WORDS = ['Cheered someone on', 'Tried my best', 'Tried something new', 'Helped set up', 'Stayed focused', 'Lost focus', 'Gave up a bit', 'Forgot kit'];
var CHECKIN_WHO = { self: 'self', teacher: 'lesson' };
var CHECKIN_DAYS_SPOTLIGHT = 30; // window for "fewest lesson ratings"
var SPOTLIGHT_SIZE = 5;
// Canvas Learning Mastery outcome → AP key. Matched case-insensitively inside each export header.
var AP_CANVAS = [
  { key: 'effort', match: ['c1'] },
  { key: 'ready',  match: ['manageself'] },
  { key: 'growth', match: ['growthmindset', 'growth mindset'] },
  { key: 'team',   match: ['s4'] },
  { key: 'manage', match: ['atl.sc.self', 'sc.self'] }
];
var GOAL_COMPONENTS = FIT_KEYS.concat(SKILL_KEYS).concat(['overall']);
function apHeaders_() {
  var h = ['Email'];
  AP_KEYS.forEach(function (k) { h.push(k + '_self'); h.push(k + '_tchr'); });
  h.push('Updated');
  return h;
}

var TABS = {
  Config:        ['Key', 'Value', 'What it does'],
  Students:      ['Email', 'Name', 'Class'],
  Teachers:      ['Email', 'Name'],
  Profile:       ['Email', 'Style', 'Goal', 'Updated'],
  Predictions:   predictionHeaders_(),
  // v3 data. Combine & Skills carry one row per student per checkpoint.
  Combine:       ['Email', 'Checkpoint'].concat(FIT_KEYS).concat(['Updated']),   // students enter their own fitness numbers
  Skills:        ['Email', 'Checkpoint'].concat(SKILL_KEYS).concat(['Updated']), // teachers enter the skill-ladder levels
  Participation: apHeaders_(),                                                   // teacher-reported, self + teacher per key
  APLog:         ['Email', 'Date', 'Source', 'Round'].concat(AP_KEYS).concat(['Updated', 'overall', 'Word']), // every AP rating: student self-checks (often) + teacher grades (4 rounds) + teacher lesson ratings ('lesson'); overall = the single Canvas AP grade; Word = check-out evidence word
  Bands:         ['Email'].concat(BAND_KEYS).concat(['Updated']),                // the three report bands
  Outcomes:      ['Email', 'Outcome', 'Value', 'Updated'],                       // latest 1–7 per standard (K1…C3), imported from Canvas Learning Mastery
  Goals:         ['Email', 'Component', 'Goal', 'Updated', 'Target'],            // focus goals: Target added last so it appends cleanly onto an existing Goals tab; plus one '_note' row

  Plan:          ['Email', 'Plan', 'Updated'],                                   // the student's personal workout plan (JSON)
  Locks:         ['Email', 'Checkpoint', 'Locked', 'Updated'],                   // teacher finalize-lock per student per checkpoint
  Reflections:   ['Email', 'Key', 'Text', 'Updated']                             // student reflections + unit self-assessments, one row per key
};
// Reflection slots a student may write. Unit keys hold a small JSON self-assessment.
var REFLECT_KEYS = ['compare-intro', 'unit-badminton'];
var REFLECT_MAX = 2000;
var PROFILE_KEY = 'Email';

var CONFIG_DEFAULTS = {
  domain:          ['fis.edu', 'Only Google accounts in this Workspace domain are served (checked on the verified sign-in token).'],
  oauth_client_id: ['701639243214-ud6m1qtmc6ma0pq6v24tk39afbuhcblv.apps.googleusercontent.com', 'The Google sign-in client the page uses. A token is accepted only if it was issued to this client. Public, not a secret.'],
  year_label:      ['26/27', 'Shown on the card header'],
  app_title:       ['My PE Profile', 'App title'],
  goal_max:        ['140', 'Maximum characters for the student\'s own goal']
};

// The six PE Styles. Keys are what the Profile tab stores; the client owns the colours.
var STYLES = {
  competitor: 'The Competitor',
  team:       'The Team Player',
  improver:   'The Improver',
  explorer:   'The Explorer',
  energizer:  'The Energizer',
  thinker:    'The Strategist',
  grafter:    'The Grafter',
  technician: 'The Technician'
};

var CACHE_KEY_CONFIG = 'g8pe_config_v1';
var CACHE_SECONDS = 120;

// ---------- Sheet helpers ----------
function ss_() { return SpreadsheetApp.getActiveSpreadsheet(); }
function tab_(name) { return ss_().getSheetByName(name); }

function ensureTab_(name, headers) {
  var book = ss_();
  var s = book.getSheetByName(name);
  if (!s) {
    s = book.insertSheet(name);
    s.getRange(1, 1, 1, headers.length).setValues([headers]);
    s.getRange(1, 1, 1, headers.length).setFontWeight('bold');
    s.setFrozenRows(1);
    return s;
  }
  var lastCol = Math.max(1, s.getLastColumn());
  var existing = s.getRange(1, 1, 1, lastCol).getValues()[0].map(String);
  while (existing.length && existing[existing.length - 1] === '') existing.pop();
  var missing = headers.filter(function (h) { return existing.indexOf(h) === -1; });
  if (existing.length === 0) s.getRange(1, 1, 1, headers.length).setValues([headers]);
  else if (missing.length) s.getRange(1, existing.length + 1, 1, missing.length).setValues([missing]);
  s.setFrozenRows(1);
  return s;
}

function readTab_(name) {
  var s = tab_(name);
  if (!s || s.getLastRow() < 2) return [];
  var data = s.getDataRange().getValues();
  var headers = data[0].map(function (h) { return String(h).trim(); });
  var out = [];
  for (var r = 1; r < data.length; r++) {
    var row = data[r], obj = {}, empty = true;
    for (var c = 0; c < headers.length; c++) {
      if (!headers[c]) continue;
      var v = row[c];
      if (v instanceof Date) v = Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
      obj[headers[c]] = v;
      if (v !== '' && v !== null && v !== undefined) empty = false;
    }
    if (!empty) out.push(obj);
  }
  return out;
}

function str_(v) { return (v === null || v === undefined) ? '' : String(v).trim(); }
function lower_(v) { return str_(v).toLowerCase(); }
function bool_(v) { return /^(true|yes|1)$/i.test(str_(v)); }

// ---------- Config ----------
function config_() {
  var cache = CacheService.getScriptCache();
  var hit = cache.get(CACHE_KEY_CONFIG);
  if (hit) { try { return JSON.parse(hit); } catch (e) { /* rebuild */ } }
  var kv = {};
  Object.keys(CONFIG_DEFAULTS).forEach(function (k) { kv[k] = CONFIG_DEFAULTS[k][0]; });
  readTab_('Config').forEach(function (r) { var k = str_(r.Key); if (k && str_(r.Value) !== '') kv[k] = str_(r.Value); });
  cache.put(CACHE_KEY_CONFIG, JSON.stringify(kv), CACHE_SECONDS);
  return kv;
}
function clearConfigCache() { CacheService.getScriptCache().remove(CACHE_KEY_CONFIG); }

// ---------- Identity (the only place an identity is established) ----------
// The page sends the Google ID token from Sign in with Google. It is verified
// with Google's tokeninfo endpoint (Google to Google; nothing leaves Google),
// then the claims are checked: issued to our client, verified email, FIS
// domain, not expired. Verified results are cached by token hash for a few
// minutes so a class saving at once does not hit tokeninfo on every call.
var TOKENINFO_URL = 'https://oauth2.googleapis.com/tokeninfo?id_token=';
var TOKEN_CACHE_SECONDS = 600;

function tokenKey_(token) {
  return 'tok:' + Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, token));
}
// Returns { email, name, picture, domainOk } or throws 'Please sign in' (client re-prompts).
function verifyToken_(cfg, token) {
  token = str_(token);
  if (!token || token.length > 4096 || !/^[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]*$/.test(token)) throw new Error('Please sign in');
  var cache = CacheService.getScriptCache(), key = tokenKey_(token);
  var hit = cache.get(key);
  if (hit) { try { return JSON.parse(hit); } catch (e) { /* re-verify */ } }
  var res = UrlFetchApp.fetch(TOKENINFO_URL + encodeURIComponent(token), { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) throw new Error('Please sign in again');
  var c; try { c = JSON.parse(res.getContentText()); } catch (e) { throw new Error('Please sign in again'); }
  var now = Math.floor(Date.now() / 1000), exp = parseInt(c.exp, 10) || 0;
  if (str_(c.aud) !== str_(cfg.oauth_client_id)) throw new Error('Please sign in again');
  if (str_(c.email_verified) !== 'true' || !str_(c.email)) throw new Error('Please sign in again');
  if (exp <= now) throw new Error('Please sign in again');
  var email = lower_(c.email), dom = lower_(cfg.domain);
  var domainOk = !dom || (lower_(c.hd) === dom && email.slice(-(dom.length + 1)) === '@' + dom);
  var out = { email: email, name: str_(c.name), picture: str_(c.picture), domainOk: domainOk };
  cache.put(key, JSON.stringify(out), Math.max(30, Math.min(TOKEN_CACHE_SECONDS, exp - now)));
  return out;
}

// Returns { role, ... }. role is one of:
//   wrong_domain  a verified Google account outside the configured domain
//   student       on the Students tab  → email, name, klass, picture (and teacher:true if also a teacher)
//   teacher       on the Teachers tab, or the Sheet owner, but not on the roster
//   unknown       a domain account that is on neither tab
function identity_(cfg, token) {
  var v = verifyToken_(cfg, token);
  if (!v.domainOk) return { role: 'wrong_domain' };
  var email = v.email;
  var owner = lower_(Session.getEffectiveUser().getEmail());
  var teacher = email === owner || readTab_('Teachers').some(function (t) { return lower_(t.Email) === email; });
  var me = readTab_('Students').filter(function (r) { return lower_(r.Email) === email; })[0];
  if (me) return { role: 'student', email: email, name: str_(me.Name), klass: str_(me.Class), picture: v.picture, teacher: teacher };
  if (teacher) return { role: 'teacher', email: email };
  return { role: 'unknown', email: email };
}
function requireStudent_(id) {
  if (id.role !== 'student') throw new Error('Not signed in with a school account that is on the class list');
  return id;
}
// Roster names arrive as "Last, First" from the school system (sometimes with
// only an initial before the comma) or as "First Last". The page greets by
// first name and shows the first name on the card; the part before a comma is
// ignored. Without a comma the full name is kept for display.
function nameParts_(raw) {
  var name = str_(raw).replace(/\s+/g, ' ');
  var first, display;
  if (name.indexOf(',') !== -1) {
    first = str_(name.split(',').slice(1).join(',')).split(' ')[0] || str_(name.split(',')[0]);
    display = first;
  } else {
    first = name.split(' ')[0] || '';
    display = name;
  }
  return { first: first, display: display, initials: initials_(display) };
}
function initials_(name) {
  var p = str_(name).split(/\s+/);
  return ((p[0] || '').charAt(0) + (p.length > 1 ? p[p.length - 1].charAt(0) : '')).toUpperCase();
}

// ---------- Web app entry: JSON API ----------
// The page POSTs { action, token, ...payload } as text/plain (no CORS preflight)
// and gets { ok:true, data } or { ok:false, error, authRequired }.
function doPost(e) {
  var out;
  try {
    var body = {};
    try { body = JSON.parse((e && e.postData && e.postData.contents) || '{}') || {}; } catch (err) { throw new Error('Bad request'); }
    out = { ok: true, data: handle_(body) };
  } catch (err) {
    var msg = (err && err.message) ? err.message : String(err);
    out = { ok: false, error: msg, authRequired: /sign in/i.test(msg) };
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}
// Opening the API URL in a browser is not the app; say so, with no data.
// Bump with each server change: opening the /exec link in a browser shows which build is live.
var BUILD = '2026-10-26 · workout assessment evidence + AP check-out';
function doGet() {
  return ContentService.createTextOutput(JSON.stringify({ ok: false, build: BUILD, error: 'This is the data service for My PE Profile. Open the app link your PE teacher shared.' }))
    .setMimeType(ContentService.MimeType.JSON);
}
function handle_(body) {
  var cfg = config_();
  var id = identity_(cfg, body.token);
  switch (str_(body.action)) {
    case 'bootstrap':       return bootstrap_(cfg, id);
    case 'saveStyle':       return saveStyle_(cfg, id, body.style);
    case 'saveGoal':        return saveGoal_(cfg, id, body.goal);
    case 'savePrediction':  return savePrediction_(cfg, id, body.checkpoint, body.answers);
    case 'saveCombine':     return saveCombine_(cfg, id, body.checkpoint, body.results);
    case 'saveGoals':       return saveGoals_(cfg, id, body.goals, body.note);
    case 'savePlan':        return savePlan_(cfg, id, body.plan);
    case 'saveReflection':  return saveReflection_(cfg, id, body.key, body.text);
    case 'saveApSelf':      return saveApSelf_(cfg, id, body.ratings);
    case 'saveSkills':      return saveSkills_(cfg, id, body.email, body.checkpoint, body.levels);
    case 'saveMySkills':    return saveMySkills_(cfg, id, body.checkpoint, body.levels);
    case 'saveBands':       return saveBands_(cfg, id, body.email, body.bands);
    case 'setLock':         return setLock_(cfg, id, body.emails, body.checkpoint, body.locked);
    case 'classOverview':   return classOverview_(cfg, id);
    case 'classStudent':    return classStudent_(cfg, id, body.email);
    case 'checkoutRoster':  return checkoutRoster_(cfg, id, body.klass, body.focus);
    case 'saveCheckin':     return saveCheckin_(cfg, id, body.email, body.focus, body.who, body.rating, body.word);
    default: throw new Error('Unknown action');
  }
}

// ---------- Reads ----------
function profileRow_(email) {
  return readTab_('Profile').filter(function (r) { return lower_(r[PROFILE_KEY]) === email; })[0] || null;
}

// The caller's predictions, by checkpoint: { intro: { timestamp, items: { cv: { rating, freq }, ... } } }
function predictionsFor_(email) {
  var out = {};
  readTab_('Predictions').forEach(function (r) {
    if (lower_(r.Email) !== email) return;
    var cp = lower_(r.Checkpoint); if (PREDICT_CHECKPOINTS.indexOf(cp) === -1) return;
    var items = {};
    PREDICT_ITEMS.forEach(function (k) {
      var rating = lower_(r[k + '_rating']), freq = lower_(r[k + '_freq']);
      if (RATINGS.indexOf(rating) !== -1 && FREQS.indexOf(freq) !== -1) items[k] = { rating: rating, freq: freq };
    });
    out[cp] = { timestamp: str_(r.Timestamp), items: items };
  });
  return out;
}
// ---------- v3 reads (all for the caller's own row) ----------
function numOrNull_(v) { var s = str_(v); if (s === '') return null; var n = Number(s); return isFinite(n) ? n : null; }

// Per-checkpoint numbers for one set of keys → { key: { sept, jan, may } }, only
// keys that have at least one value. Returns {} if nothing recorded.
function seriesByCheckpoint_(tabName, email, keys) {
  var out = {};
  readTab_(tabName).forEach(function (r) {
    if (lower_(r.Email) !== email) return;
    var cp = lower_(r.Checkpoint);
    if (COMBINE_CHECKPOINTS.indexOf(cp) === -1) return;
    keys.forEach(function (k) {
      var n = numOrNull_(r[k]);
      if (n === null) return;
      if (!out[k]) out[k] = {};
      out[k][cp] = n;
    });
  });
  return out;
}
function fitnessFor_(email) { return seriesByCheckpoint_('Combine', email, FIT_KEYS); }
function skillsFor_(email) { return seriesByCheckpoint_('Skills', email, SKILL_KEYS); }

// AP history for one student: every self-check (dated) and the teacher's graded rounds.
function ymd_(d) {
  if (Object.prototype.toString.call(d) === '[object Date]' && !isNaN(d)) {
    var m = d.getMonth() + 1, day = d.getDate();
    return d.getFullYear() + '-' + (m < 10 ? '0' : '') + m + '-' + (day < 10 ? '0' : '') + day;
  }
  var t = str_(d); return /^\d{4}-\d{2}-\d{2}/.test(t) ? t.slice(0, 10) : '';
}
function apEntry_(r) {
  var v = {}, any = false;
  AP_KEYS.concat(['overall']).forEach(function (k) { var n = numOrNull_(r[k]); if (n !== null && n >= 1 && n <= 7) { v[k] = n; any = true; } });
  return any ? v : null;
}
// self = the student's own checks (own device, Form, or the check-out kiosk), dated;
// teacher = the summative Canvas rounds; lesson = the teacher's check-out ratings, dated.
// rows (optional) collects every self/lesson row for the teacher's check-out summary.
function apLogIndex_(rows) {
  var idx = {};
  readTab_('APLog').forEach(function (r) {
    var email = lower_(r.Email); if (!email) return;
    var v = apEntry_(r); if (!v) return;
    var o = idx[email] || (idx[email] = { self: [], teacher: {}, lesson: [] });
    var src = lower_(r.Source);
    if (src === 'teacher') {
      var round = lower_(r.Round); if (AP_ROUNDS.indexOf(round) === -1) return;
      o.teacher[round] = { round: round, label: AP_ROUND_LABELS[round], date: ymd_(r.Date), v: v };
    } else if (src === 'self' || src === 'lesson') {
      var date = ymd_(r.Date); if (!date) return;
      var e = { date: date, v: v }, word = str_(r.Word);
      if (word && CHECKIN_WORDS.indexOf(word) !== -1) e.word = word;
      (src === 'self' ? o.self : o.lesson).push(e);
      if (rows) rows.push({ email: email, src: src, date: date, v: v });
    }
  });
  var byDate = function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; };
  Object.keys(idx).forEach(function (e) {
    var o = idx[e];
    o.self.sort(byDate); o.lesson.sort(byDate);
    if (o.self.length > AP_SELF_MAX) o.self = o.self.slice(-AP_SELF_MAX);
    if (o.lesson.length > AP_SELF_MAX) o.lesson = o.lesson.slice(-AP_SELF_MAX);
    o.teacher = AP_ROUNDS.filter(function (r) { return o.teacher[r]; }).map(function (r) { return o.teacher[r]; });
  });
  return idx;
}
function apLogFor_(email) { return apLogIndex_()[email] || { self: [], teacher: [], lesson: [] }; }

// Latest self + latest teacher value per key: from the log when there is one,
// otherwise from the older one-row Participation tab.
function apLatest_(log, row, prev) {
  var out = {};
  AP_KEYS.forEach(function (k) {
    var self = null, tchr = null, i;
    for (i = log.self.length - 1; i >= 0 && self === null; i--) if (log.self[i].v[k] != null) self = log.self[i].v[k];
    for (i = log.teacher.length - 1; i >= 0 && tchr === null; i--) if (log.teacher[i].v[k] != null) tchr = log.teacher[i].v[k];
    if (row) {
      if (self === null) self = numOrNull_(row[k + '_self']);
      if (tchr === null) tchr = numOrNull_(row[k + '_tchr']);
    }
    if (prev && prev[k]) {
      if (self === null && prev[k].self != null) self = prev[k].self;
      if (tchr === null && prev[k].tchr != null) tchr = prev[k].tchr;
    }
    if (self !== null || tchr !== null) out[k] = { self: self, tchr: tchr };
  });
  return out;
}
function apFor_(email) {
  var row = readTab_('Participation').filter(function (r) { return lower_(r.Email) === email; })[0];
  return apLatest_(apLogFor_(email), row || null);
}
// The student's latest grade per standard, e.g. { K4: 5, S1: 6, C1: 5 }.
var OUTCOME_CODES = ['K1', 'K2', 'K3', 'K4', 'K5', 'S1', 'S2', 'S3', 'S4', 'C1', 'C2', 'C3'];
function outcomesFor_(email) {
  var out = {};
  readTab_('Outcomes').forEach(function (r) {
    if (lower_(r.Email) !== email) return;
    var code = str_(r.Outcome).toUpperCase(), n = numOrNull_(r.Value);
    if (OUTCOME_CODES.indexOf(code) !== -1 && n !== null && n >= 1 && n <= 7) out[code] = n;
  });
  return out;
}
function bandsFor_(email) {
  var row = readTab_('Bands').filter(function (r) { return lower_(r.Email) === email; })[0];
  if (!row) return {};
  var out = {};
  BAND_KEYS.forEach(function (k) { var n = numOrNull_(row[k]); if (n !== null) out[k] = n; });
  return out;
}
// Finalize-locks: a teacher locks a student's checkpoint so the student can no
// longer edit it (teachers always can). Keyed by email + checkpoint.
function locksIndex_() {
  var idx = {};
  readTab_('Locks').forEach(function (r) {
    var email = lower_(r.Email); if (!email) return;
    var cp = lower_(r.Checkpoint); if (COMBINE_CHECKPOINTS.indexOf(cp) === -1) return;
    if (bool_(r.Locked)) (idx[email] || (idx[email] = {}))[cp] = true;
  });
  return idx;
}
function locksFor_(email) { return locksIndex_()[email] || {}; }
function isLocked_(email, cp) { return locksFor_(email)[cp] === true; }

function goalsFor_(email) {
  var items = [], note = '';
  readTab_('Goals').forEach(function (r) {
    if (lower_(r.Email) !== email) return;
    var c = lower_(r.Component);
    if (c === '_note') { note = str_(r.Goal); return; }
    if (GOAL_COMPONENTS.indexOf(c) === -1) return;
    var t = numOrNull_(r.Target), g = str_(r.Goal);
    if (t !== null || g) items.push({ component: c, target: t, goal: g });
  });
  return { items: items, note: note };
}
function planFor_(email) {
  var row = readTab_('Plan').filter(function (r) { return lower_(r.Email) === email; })[0];
  if (!row) return null;
  var raw = str_(row.Plan);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

// The caller's reflections: { key: { text, updated } }.
function reflectionsFor_(email) {
  var out = {};
  readTab_('Reflections').forEach(function (r) {
    if (lower_(r.Email) !== email) return;
    var k = str_(r.Key); if (REFLECT_KEYS.indexOf(k) === -1) return;
    out[k] = { text: str_(r.Text), updated: str_(r.Updated) };
  });
  return out;
}

// The caller's measured picture, or null if nothing has been recorded yet (keeps
// the profile in its "fills in at the Combine" state until there is real data).
function measuredFor_(email) {
  var fitness = fitnessFor_(email), skills = skillsFor_(email),
      apLog = apLogFor_(email), bands = bandsFor_(email), outcomes = outcomesFor_(email),
      g = goalsFor_(email), plan = planFor_(email);
  var row = readTab_('Participation').filter(function (r) { return lower_(r.Email) === email; })[0] || null;
  var ap = apLatest_(apLog, row);
  var any = Object.keys(fitness).length || Object.keys(skills).length ||
            Object.keys(ap).length || apLog.self.length || apLog.teacher.length || Object.keys(bands).length || Object.keys(outcomes).length || g.items.length || g.note || plan;
  if (!any) return null;
  return { fitness: fitness, skills: skills, ap: ap, apLog: apLog, bands: bands, outcomes: outcomes, goals: g.items, goalNote: g.note, plan: plan };
}

// Everything the page needs, for the caller only.
function bootstrap_(cfg, id) {
  var out = {
    role: id.role,
    config: { yearLabel: cfg.year_label, appTitle: cfg.app_title, goalMax: parseInt(cfg.goal_max, 10) || 140 },
    styles: STYLES
  };
  if (id.role === 'student') {
    var p = profileRow_(id.email) || {};
    var nm = nameParts_(id.name);
    out.student = {
      name: nm.display,
      first: nm.first,
      klass: id.klass,
      initials: nm.initials,
      style: STYLES[str_(p.Style)] ? str_(p.Style) : '',
      goal: str_(p.Goal),
      photoUrl: /^https:\/\/[a-z0-9.-]+\.googleusercontent\.com\//.test(id.picture) ? id.picture : '',
      predictions: predictionsFor_(id.email),
      combine: measuredFor_(id.email),
      locked: locksFor_(id.email),
      reflections: reflectionsFor_(id.email)
    };
    out.predict = { items: PREDICT_ITEMS, checkpoints: PREDICT_CHECKPOINTS, ratings: RATINGS, freqs: FREQS };
    out.meta = combineMeta_();
    if (id.teacher) out.alsoTeacher = true;
  } else if (id.role === 'teacher' || id.role === 'unknown') {
    out.email = id.email; // the caller's own address, so they can see which account they used
    if (id.role === 'teacher') { out.meta = combineMeta_(); out.predict = { items: PREDICT_ITEMS, checkpoints: PREDICT_CHECKPOINTS, ratings: RATINGS, freqs: FREQS }; } // for the made-up demo student
  }
  return out;
}

// Labels, units and order the client renders from, so wording stays in one place.
function combineMeta_() {
  return {
    fitness: FITNESS,
    skills: SKILL_KEYS,
    checkpoints: COMBINE_CHECKPOINTS,
    ap: AP_KEYS,
    bands: BAND_KEYS,
    skillMin: SKILL_MIN,
    skillMax: SKILL_MAX,
    goalComponents: GOAL_COMPONENTS
  };
}

// ---------- Writes (always for the caller's own row) ----------
// Sheets turns a typed "2026-10-23" into a Date; compare it as the day string it was written as.
function cellKey_(v) { return Object.prototype.toString.call(v) === '[object Date]' ? ymd_(v) : v; }
// Insert-or-update one row of `name`, matched on the `keys` columns (case-insensitive),
// under a script lock. Columns not in `fields` keep their value.
function upsert_(name, keys, fields) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var s = ensureTab_(name, TABS[name]);
    var lastRow = s.getLastRow(), lastCol = s.getLastColumn();
    var headers = s.getRange(1, 1, 1, lastCol).getValues()[0].map(String);
    var keyCols = Object.keys(keys).map(function (k) { return headers.indexOf(k); });
    var rowIdx = -1;
    if (lastRow > 1) {
      // Only the key columns are read to find the row (e.g. 3 of APLog's 13), then just that row.
      var c0 = Math.min.apply(null, keyCols), c1 = Math.max.apply(null, keyCols);
      var data = s.getRange(2, c0 + 1, lastRow - 1, c1 - c0 + 1).getValues();
      for (var i = 0; i < data.length && rowIdx === -1; i++) {
        var hit = Object.keys(keys).every(function (k, j) { return lower_(cellKey_(data[i][keyCols[j] - c0])) === lower_(keys[k]); });
        if (hit) rowIdx = i + 2;
      }
    }
    var row;
    if (rowIdx === -1) { rowIdx = lastRow + 1; row = headers.map(function () { return ''; }); Object.keys(keys).forEach(function (k, j) { row[keyCols[j]] = keys[k]; }); }
    else row = s.getRange(rowIdx, 1, 1, lastCol).getValues()[0];
    Object.keys(fields).forEach(function (k) { var c = headers.indexOf(k); if (c !== -1) row[c] = fields[k]; });
    s.getRange(rowIdx, 1, 1, lastCol).setValues([row]);
  } finally { lock.releaseLock(); }
}
function upsertProfile_(email, fields) {
  fields.Updated = new Date();
  upsert_('Profile', { Email: email }, fields);
}

function saveStyle_(cfg, id, style) {
  requireStudent_(id);
  var key = lower_(style);
  if (!STYLES[key]) throw new Error('Unknown style');
  upsertProfile_(id.email, { Style: key });
  return { ok: true, style: key };
}

function saveGoal_(cfg, id, goal) {
  requireStudent_(id);
  var max = parseInt(cfg.goal_max, 10) || 140;
  var clean = str_(goal).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').slice(0, max);
  upsertProfile_(id.email, { Goal: clean });
  return { ok: true, goal: clean };
}

// Save the caller's self-prediction for one checkpoint. `answers` is
// { cv: { rating, freq }, ... } and must cover all 13 items with valid values.
// One row per student per checkpoint: saving again overwrites it.
function savePrediction_(cfg, id, checkpoint, answers) {
  requireStudent_(id);
  var cp = lower_(checkpoint);
  if (PREDICT_CHECKPOINTS.indexOf(cp) === -1) throw new Error('Unknown checkpoint');
  if (!answers || typeof answers !== 'object') throw new Error('Missing answers');
  var fields = { Timestamp: new Date() };
  var missing = [];
  PREDICT_ITEMS.forEach(function (k) {
    var a = answers[k] || {};
    var rating = lower_(a.rating), freq = lower_(a.freq);
    if (RATINGS.indexOf(rating) === -1 || FREQS.indexOf(freq) === -1) { missing.push(k); return; }
    fields[k + '_rating'] = rating; fields[k + '_freq'] = freq;
  });
  if (missing.length) throw new Error('Incomplete: rate every item before saving (' + missing.length + ' left)');
  upsert_('Predictions', { Email: id.email, Checkpoint: cp }, fields);
  return { ok: true, checkpoint: cp, prediction: predictionsFor_(id.email)[cp] };
}

// ---------- v3 writes ----------
function requireTeacher_(id) {
  if (!(id.role === 'teacher' || id.teacher === true)) throw new Error('This needs a PE teacher account');
  return id;
}

// A student enters their own Combine fitness numbers for one checkpoint. Blank
// fields are left untouched; out-of-range values are refused.
function saveCombine_(cfg, id, checkpoint, results) {
  requireStudent_(id);
  var cp = lower_(checkpoint);
  if (COMBINE_CHECKPOINTS.indexOf(cp) === -1) throw new Error('Unknown checkpoint');
  if (isLocked_(id.email, cp)) throw new Error('Your teacher has locked this checkpoint — ask them to unlock it to make changes');
  if (!results || typeof results !== 'object') throw new Error('Missing results');
  // Save every valid number; report the others instead of rejecting the whole set.
  var fields = { Updated: new Date() }, saved = {}, rejected = [];
  FIT_KEYS.forEach(function (k) {
    if (!(k in results) || results[k] === '' || results[k] === null) return;
    var meta = FIT_BY_KEY[k], n = Number(results[k]);
    if (!isFinite(n)) { rejected.push({ key: k, error: 'Not a number' }); return; }
    if (n < meta.min || n > meta.max) { rejected.push({ key: k, error: 'Out of range (' + meta.min + '–' + meta.max + ' ' + meta.unit + ')' }); return; }
    fields[k] = n; saved[k] = n;
  });
  if (!Object.keys(saved).length) {
    if (rejected.length) throw new Error(FIT_BY_KEY[rejected[0].key].label + ': ' + rejected[0].error);
    throw new Error('Missing results');
  }
  upsert_('Combine', { Email: id.email, Checkpoint: cp }, fields);
  return { ok: true, checkpoint: cp, results: saved, rejected: rejected };
}

// The student's component goals (which parts they want to improve). Replaces the
// whole set each save, so unticking a component removes its goal.
function replaceGoals_(email, items, note) {
  var lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    var s = ensureTab_('Goals', TABS.Goals), headers = TABS.Goals;
    var keep = readTab_('Goals').filter(function (r) { return lower_(r.Email) !== email; });
    items.forEach(function (it) { keep.push({ Email: email, Component: it.component, Target: (it.target === null || it.target === undefined) ? '' : it.target, Goal: it.goal, Updated: new Date() }); });
    if (note) keep.push({ Email: email, Component: '_note', Target: '', Goal: note, Updated: new Date() });
    if (s.getLastRow() > 1) s.getRange(2, 1, s.getLastRow() - 1, s.getLastColumn()).clearContent();
    if (keep.length) {
      var rows = keep.map(function (r) { return headers.map(function (h) { return r[h] === undefined ? '' : r[h]; }); });
      s.getRange(2, 1, rows.length, headers.length).setValues(rows);
    }
  } finally { lock.releaseLock(); }
}
// Focus goals: a May target per component (a number — a level for skills, a
// measure for fitness) plus one overall note ("how will you get there?").
function saveGoals_(cfg, id, goals, note) {
  requireStudent_(id);
  if (Object.prototype.toString.call(goals) !== '[object Array]') throw new Error('Missing goals');
  var clean = [];
  goals.forEach(function (g) {
    if (!g || typeof g !== 'object') return;
    var c = lower_(g.component);
    if (GOAL_COMPONENTS.indexOf(c) === -1 || clean.some(function (x) { return x.component === c; })) return;
    var t = (g.target === '' || g.target === null || g.target === undefined) ? null : Number(g.target);
    if (t !== null && !isFinite(t)) t = null;
    var text = str_(g.goal).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').slice(0, 160);
    if (t !== null || text) clean.push({ component: c, target: t, goal: text });
  });
  var noteText = str_(note).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').slice(0, 600);
  replaceGoals_(id.email, clean, noteText);
  return { ok: true, goals: clean, note: noteText };
}

// A reflection or unit self-assessment, for the caller's own row only.
function saveReflection_(cfg, id, key, text) {
  requireStudent_(id);
  var k = str_(key);
  if (REFLECT_KEYS.indexOf(k) === -1) throw new Error('Unknown reflection');
  var t = (text === null || text === undefined) ? '' : String(text);
  if (t.length > REFLECT_MAX) throw new Error('Reflection is too long');
  upsert_('Reflections', { Email: id.email, Key: k }, { Text: t, Updated: new Date() });
  return { ok: true, key: k, reflection: reflectionsFor_(id.email)[k] || { text: t, updated: '' } };
}

// A student's own AP self-check: five 1–7 ratings, one row per student per day
// (rating again the same day replaces that day's row). Never touches teacher rows.
function saveApSelf_(cfg, id, ratings) {
  requireStudent_(id);
  if (!ratings || typeof ratings !== 'object') throw new Error('Missing ratings');
  var fields = {}, n = 0;
  AP_KEYS.forEach(function (k) {
    var v = ratings[k];
    if (v === null || v === undefined || v === '') return;
    v = Number(v);
    if (!(v >= 1 && v <= 7 && Math.floor(v) === v)) throw new Error('Ratings are whole numbers from 1 to 7');
    fields[k] = v; n++;
  });
  if (!n) throw new Error('Rate at least one key');
  var today = ymd_(new Date());
  AP_KEYS.forEach(function (k) { if (!(k in fields)) fields[k] = ''; });
  fields.Updated = new Date();
  upsert_('APLog', { Email: id.email, Date: today, Source: 'self' }, fields);
  var log = apLogFor_(id.email);
  return { ok: true, apLog: log, ap: apFor_(id.email) };
}

// The student's personal workout plan (a small JSON structure built in the app).
function savePlan_(cfg, id, plan) {
  requireStudent_(id);
  if (plan === null || plan === undefined) throw new Error('Missing plan');
  var json; try { json = JSON.stringify(plan); } catch (e) { throw new Error('Bad plan'); }
  if (json.length > 20000) throw new Error('Plan is too long');
  upsert_('Plan', { Email: id.email }, { Plan: json, Updated: new Date() });
  return { ok: true, plan: plan };
}

// A teacher records the skill-ladder levels for a student on the roster (the
// "other Combine skill tests" the PE team runs). Teacher-gated; levels 1–6.
function saveSkills_(cfg, id, targetEmail, checkpoint, levels) {
  requireTeacher_(id);
  var email = lower_(targetEmail);
  if (!email) throw new Error('Missing student');
  if (!readTab_('Students').some(function (r) { return lower_(r.Email) === email; })) throw new Error('That student is not on the class list');
  var cp = lower_(checkpoint);
  if (COMBINE_CHECKPOINTS.indexOf(cp) === -1) throw new Error('Unknown checkpoint');
  if (!levels || typeof levels !== 'object') throw new Error('Missing levels');
  var fields = { Updated: new Date() }, saved = {};
  SKILL_KEYS.forEach(function (k) {
    if (!(k in levels) || levels[k] === '' || levels[k] === null) return;
    var n = Number(levels[k]);
    if (!isFinite(n) || n % 1 !== 0 || n < SKILL_MIN || n > SKILL_MAX) throw new Error('Level for ' + k + ' must be ' + SKILL_MIN + '–' + SKILL_MAX);
    fields[k] = n; saved[k] = n;
  });
  upsert_('Skills', { Email: email, Checkpoint: cp }, fields);
  return { ok: true, email: email, checkpoint: cp, levels: saved };
}

// A student self-records their OWN skill-ladder levels for one checkpoint (the
// self→teacher model). Refused if the teacher has locked the checkpoint.
function saveMySkills_(cfg, id, checkpoint, levels) {
  requireStudent_(id);
  var cp = lower_(checkpoint);
  if (COMBINE_CHECKPOINTS.indexOf(cp) === -1) throw new Error('Unknown checkpoint');
  if (isLocked_(id.email, cp)) throw new Error('Your teacher has locked this checkpoint — ask them to unlock it to make changes');
  if (!levels || typeof levels !== 'object') throw new Error('Missing levels');
  var fields = { Updated: new Date() }, saved = {};
  SKILL_KEYS.forEach(function (k) {
    if (!(k in levels) || levels[k] === '' || levels[k] === null) return;
    var n = Number(levels[k]);
    if (!isFinite(n) || n % 1 !== 0 || n < SKILL_MIN || n > SKILL_MAX) throw new Error('Level for ' + k + ' must be ' + SKILL_MIN + '–' + SKILL_MAX);
    fields[k] = n; saved[k] = n;
  });
  upsert_('Skills', { Email: id.email, Checkpoint: cp }, fields);
  return { ok: true, checkpoint: cp, levels: saved };
}

// A teacher records the three report-band grades (Knowledge · Skills · Concept
// transfer), best-fit 1–7, for a student on the roster.
function saveBands_(cfg, id, targetEmail, bands) {
  requireTeacher_(id);
  var email = lower_(targetEmail);
  if (!email) throw new Error('Missing student');
  if (!readTab_('Students').some(function (r) { return lower_(r.Email) === email; })) throw new Error('That student is not on the class list');
  if (!bands || typeof bands !== 'object') throw new Error('Missing bands');
  var fields = { Updated: new Date() }, saved = {};
  BAND_KEYS.forEach(function (k) {
    if (!(k in bands) || bands[k] === '' || bands[k] === null) return;
    var n = Number(bands[k]);
    if (!isFinite(n) || n % 1 !== 0 || n < 1 || n > 7) throw new Error('Report band ' + k + ' must be 1–7');
    fields[k] = n; saved[k] = n;
  });
  upsert_('Bands', { Email: email }, fields);
  return { ok: true, email: email, bands: saved };
}

// A teacher locks or unlocks a checkpoint for one or more students (finalize).
function setLock_(cfg, id, emails, checkpoint, locked) {
  requireTeacher_(id);
  var cp = lower_(checkpoint);
  if (COMBINE_CHECKPOINTS.indexOf(cp) === -1) throw new Error('Unknown checkpoint');
  var list = (Object.prototype.toString.call(emails) === '[object Array]') ? emails : [emails];
  var roster = {}; readTab_('Students').forEach(function (r) { roster[lower_(r.Email)] = true; });
  var done = [];
  list.forEach(function (e) {
    var email = lower_(e);
    if (!email || !roster[email]) return;
    upsert_('Locks', { Email: email, Checkpoint: cp }, { Locked: locked ? 'yes' : '', Updated: new Date() });
    done.push(email);
  });
  return { ok: true, checkpoint: cp, locked: !!locked, emails: done };
}

// ---------- Teacher reads (teacher-gated; the one place class data is returned) ----------
// Each tab is read ONCE and indexed by email, instead of re-reading all four tabs
// per student (which made the class view O(students × tabs) full-sheet reads).
function indexSeries_(tabName, keys) {
  var idx = {};
  readTab_(tabName).forEach(function (r) {
    var email = lower_(r.Email); if (!email) return;
    var cp = lower_(r.Checkpoint);
    if (COMBINE_CHECKPOINTS.indexOf(cp) === -1) return;
    var o = idx[email] || (idx[email] = {});
    keys.forEach(function (k) {
      var n = numOrNull_(r[k]); if (n === null) return;
      (o[k] || (o[k] = {}))[cp] = n;
    });
  });
  return idx;
}
function indexAp_() {
  var idx = {};
  readTab_('Participation').forEach(function (r) {
    var email = lower_(r.Email); if (!email) return;
    var o = {};
    AP_KEYS.forEach(function (k) {
      var self = numOrNull_(r[k + '_self']), tchr = numOrNull_(r[k + '_tchr']);
      if (self !== null || tchr !== null) o[k] = { self: self, tchr: tchr };
    });
    idx[email] = o;
  });
  return idx;
}
function indexBands_() {
  var idx = {};
  readTab_('Bands').forEach(function (r) {
    var email = lower_(r.Email); if (!email) return;
    var o = {};
    BAND_KEYS.forEach(function (k) { var n = numOrNull_(r[k]); if (n !== null) o[k] = n; });
    idx[email] = o;
  });
  return idx;
}
function classOverview_(cfg, id) {
  requireTeacher_(id);
  var combine = indexSeries_('Combine', FIT_KEYS);
  var skills  = indexSeries_('Skills', SKILL_KEYS);
  var ckRows = [], ap = indexAp_(), apLog = apLogIndex_(ckRows), bands = indexBands_(), locks = locksIndex_(), checkins = checkinSummary_(ckRows);
  var out = [];
  readTab_('Students').forEach(function (r) {
    var email = lower_(r.Email); if (!email) return;
    out.push({ id: email, name: str_(r.Name), klass: str_(r.Class),
      fitness: combine[email] || {}, skills: skills[email] || {},
      ap: apLatest_(apLog[email] || { self: [], teacher: [] }, null, ap[email]),
      bands: bands[email] || {}, locked: locks[email] || {}, checkinSummary: checkins[email] || {} });
  });
  return { role: 'class', students: out, meta: combineMeta_() };
}
function classStudent_(cfg, id, targetEmail) {
  requireTeacher_(id);
  var email = lower_(targetEmail);
  var r = readTab_('Students').filter(function (x) { return lower_(x.Email) === email; })[0];
  if (!r) throw new Error('That student is not on the class list');
  return { role: 'classStudent', student: { id: email, name: str_(r.Name), klass: str_(r.Class),
    fitness: fitnessFor_(email), skills: skillsFor_(email), ap: apFor_(email), apLog: apLogFor_(email), bands: bandsFor_(email),
    plan: planFor_(email), goals: goalsFor_(email) } };  // teacher assessment view: the student's workout, goals, log and reflection
}

// ---------- AP check-out (end-of-lesson routine on the teacher's iPad) ----------
// The date is always the server's today; the client never sends one.
function daysAgoYmd_(n) { return ymd_(new Date(Date.now() - n * 86400000)); }
function round1_(n) { return Math.round(n * 10) / 10; }
// Teacher view: per student, per AP key { selfAvg, lessonAvg, selfN, lessonN, last } over every
// self and lesson rating kept. Canvas grades are not in here: they stay in the dashboard as they are.
function checkinSummary_(rows) {
  var acc = {};
  rows.forEach(function (r) {
    AP_KEYS.forEach(function (k) {
      var n = r.v[k]; if (n == null) return;
      var o = acc[r.email] || (acc[r.email] = {}), f = o[k] || (o[k] = { s: 0, sn: 0, l: 0, ln: 0, last: '' });
      if (r.src === 'self') { f.s += n; f.sn++; } else { f.l += n; f.ln++; }
      if (r.date > f.last) f.last = r.date;
    });
  });
  var out = {};
  Object.keys(acc).forEach(function (e) {
    out[e] = {};
    Object.keys(acc[e]).forEach(function (k) { var f = acc[e][k];
      out[e][k] = { selfAvg: f.sn ? round1_(f.s / f.sn) : null, lessonAvg: f.ln ? round1_(f.l / f.ln) : null, selfN: f.sn, lessonN: f.ln, last: f.last }; });
  });
  return out;
}
// "Last, First" or "First Last" → first name + last initial, for the name buttons.
function shortName_(raw) {
  var name = str_(raw).replace(/\s+/g, ' '), first, last;
  if (name.indexOf(',') !== -1) { last = str_(name.split(',')[0]); first = nameParts_(name).first; }
  else { var p = name.split(' '); first = p[0] || ''; last = p.length > 1 ? p[p.length - 1] : ''; }
  return { first: first, lastInitial: last.charAt(0).toUpperCase() };
}
// Teacher-only: one class's names for the kiosk, who has checked out today on the focus, and
// the spotlight five (fewest lesson ratings in 30 days → oldest last lesson rating → alphabetical).
// Never returns ratings. Without a class, returns just the class list.
function checkoutRoster_(cfg, id, klass, focus) {
  requireTeacher_(id);
  var students = readTab_('Students').filter(function (r) { return lower_(r.Email); });
  var classes = {}; students.forEach(function (r) { var c = str_(r.Class); if (c) classes[c] = true; });
  var out = { classes: Object.keys(classes).sort(), words: CHECKIN_WORDS, focuses: AP_KEYS, date: ymd_(new Date()), klass: '', students: [], spotlight: [] };
  var want = lower_(klass);
  if (!want) return out;
  var mine = students.filter(function (r) { return lower_(r.Class) === want; });
  if (!mine.length) throw new Error('No students in that class');
  out.klass = str_(mine[0].Class);
  var f = lower_(focus); if (AP_KEYS.indexOf(f) === -1) f = '';
  var today = out.date, from = daysAgoYmd_(CHECKIN_DAYS_SPOTLIGHT), stats = {};
  mine.forEach(function (r) { stats[lower_(r.Email)] = { self: false, teacher: false, recent: 0, last: '' }; });
  readTab_('APLog').forEach(function (r) {
    var st = stats[lower_(r.Email)]; if (!st) return;
    var src = lower_(r.Source); if (src !== 'self' && src !== 'lesson') return;
    var date = ymd_(r.Date), v = apEntry_(r); if (!date || !v) return;
    if (date === today && (f ? v[f] != null : true)) st[src === 'self' ? 'self' : 'teacher'] = true;
    if (src === 'lesson') { if (date >= from) st.recent++; if (date > st.last) st.last = date; }
  });
  var rows = mine.map(function (r) {
    var email = lower_(r.Email), n = shortName_(r.Name);
    return { email: email, first: n.first, lastInitial: n.lastInitial, sortName: lower_(r.Name), doneToday: { self: stats[email].self, teacher: stats[email].teacher } };
  });
  var cmp = function (a, b) { return a < b ? -1 : (a > b ? 1 : 0); };
  out.spotlight = rows.slice().sort(function (a, b) {
    var x = stats[a.email], y = stats[b.email];
    return (x.recent - y.recent) || cmp(x.last, y.last) || cmp(a.sortName, b.sortName) || cmp(a.email, b.email); // never rated ('') sorts first
  }).slice(0, SPOTLIGHT_SIZE).map(function (r) { return r.email; });
  out.students = rows.sort(function (a, b) { return cmp(a.first.toLowerCase(), b.first.toLowerCase()) || cmp(a.sortName, b.sortName); })
    .map(function (r) { return { email: r.email, first: r.first, lastInitial: r.lastInitial, doneToday: r.doneToday }; });
  return out;
}
// Teacher-only: the verified teacher records a check-in for a student on the roster: the
// student's own tap (who 'self' → a self-check) or the teacher's lesson rating (who 'teacher'
// → Source 'lesson'). Only today's focus column is set; re-tapping overwrites it. Class and
// date come from the server, never the request. Canvas rows (Source 'teacher') are never touched.
function saveCheckin_(cfg, id, targetEmail, focus, who, rating, word) {
  requireTeacher_(id);
  var email = lower_(targetEmail);
  if (!email) throw new Error('Missing student');
  if (!readTab_('Students').some(function (r) { return lower_(r.Email) === email; })) throw new Error('That student is not on the class list');
  var f = lower_(focus);
  if (AP_KEYS.indexOf(f) === -1) throw new Error('Unknown focus');
  var src = CHECKIN_WHO.hasOwnProperty(lower_(who)) ? CHECKIN_WHO[lower_(who)] : '';
  if (!src) throw new Error('Unknown rater');
  var n = (typeof rating === 'number') ? rating : (typeof rating === 'string' && /^\s*\d+\s*$/.test(rating) ? Number(rating) : NaN);
  if (!isFinite(n) || n % 1 !== 0 || n < 1 || n > 7) throw new Error('Rating must be a whole number 1–7');
  var wd = (word === null || word === undefined) ? '' : word;
  if (typeof wd !== 'string' || (wd !== '' && CHECKIN_WORDS.indexOf(wd) === -1)) throw new Error('Unknown word');
  var date = ymd_(new Date()), fields = { Word: wd, Updated: new Date() };
  fields[f] = n;
  upsert_('APLog', { Email: email, Date: date, Source: src }, fields);
  return { ok: true, date: date };
}

// ---------- Sheet menu (teacher, inside the Sheet) ----------
function onOpen() {
  SpreadsheetApp.getUi().createMenu('PE Profile')
    .addItem('1. Set up tabs', 'setupTabs')
    .addItem('Import grades from Canvas (AP + unit outcomes)…', 'importApFromCanvas')
    .addItem('Import AP self-ratings from the form', 'importApFromForm')
    .addItem('Clear config cache', 'clearConfigCache')
    .addSeparator()
    .addItem('End of year: clear student data…', 'clearProfileData')
    .addToUi();
}

function setupTabs() {
  Object.keys(TABS).forEach(function (n) { ensureTab_(n, TABS[n]); });
  var c = tab_('Config');
  var have = readTab_('Config').map(function (r) { return str_(r.Key); });
  var add = Object.keys(CONFIG_DEFAULTS).filter(function (k) { return have.indexOf(k) === -1; })
    .map(function (k) { return [k, CONFIG_DEFAULTS[k][0], CONFIG_DEFAULTS[k][1]]; });
  if (add.length) c.getRange(c.getLastRow() + 1, 1, add.length, 3).setValues(add);
  var t = tab_('Teachers');
  if (t.getLastRow() < 2) t.getRange(2, 1, 1, 2).setValues([[Session.getEffectiveUser().getEmail(), 'Sheet owner (automatic)']]);
  clearConfigCache();
  try { SpreadsheetApp.getUi().alert('Tabs are ready. Fill Students (Email · Name · Class), then Deploy → New deployment → Web app: Execute as Me, Who has access: Anyone.'); } catch (e) { /* no UI when run headless */ }
}

// ---------- AP grades: Canvas → APLog (runs inside the Sheet, by the teacher) ----------
// 1. Canvas → Grades → Learning Mastery → Export. 2. In this Sheet: File → Import →
// Upload → "Insert new sheet(s)", then rename that tab CanvasImport. 3. Run this.
// The grades go straight from that tab into APLog; nothing leaves this Sheet.
function apHeaderCol_(headers, words) {
  var res = -1;
  headers.forEach(function (h, i) {
    if (res !== -1) return;
    var t = ' ' + lower_(h).replace(/[^a-z0-9.]+/g, ' ') + ' ';
    var hit = words.some(function (w) {
      var esc = w.replace(/[.*+?^${}()|[\]\\]/g, function (c) { return '\\' + c; });
      return new RegExp('(^|[^a-z0-9])' + esc + '([^a-z0-9]|$)').test(t);
    });
    if (hit && !/mastery points|mastery_points/.test(lower_(h))) res = i;
  });
  return res;
}
function apNameKey_(n) {
  var t = lower_(n);
  if (t.indexOf(',') !== -1) { var p = t.split(','); t = p.slice(1).join(' ') + ' ' + p[0]; }
  return t.replace(/[^a-z\u00c0-\u024f]+/g, ' ').trim().split(' ').sort().join(' ');
}
// Pure: rows = the CanvasImport values (header row first). Returns counts, never data.
function importApRows_(rows, round) {
  round = lower_(round);
  if (AP_ROUNDS.indexOf(round) === -1) throw new Error('Round must be one of ' + AP_ROUNDS.join(', '));
  if (!rows || rows.length < 2) throw new Error('The import tab is empty');
  var headers = rows[0].map(str_);
  var cols = {}, missing = [];
  AP_CANVAS.forEach(function (o) { var c = apHeaderCol_(headers, o.match); if (c === -1) missing.push(o.key); else cols[o.key] = c; });
  // Grades export: one assignment column ("Am I an Active Participant in PE? (id)") → overall.
  var overallCol = -1;
  headers.forEach(function (h, i) {
    var t = lower_(h);
    if (overallCol === -1 && /active particip/.test(t) && !/\b(points|score|grade)\b.*\(semester/.test(t)) overallCol = i;
  });
  // Every PE standard column in a Learning Mastery export (e.g. "PE.G6-10.S3 … result") → Outcomes.
  var outcomeCols = {};
  headers.forEach(function (h, i) {
    var t = lower_(h); if (/mastery points/.test(t)) return;
    var m = t.match(/pe\.g6-10\.([ksc][1-5])(?![0-9])/); if (!m) return;
    var code = m[1].toUpperCase(); if (OUTCOME_CODES.indexOf(code) !== -1 && outcomeCols[code] === undefined) outcomeCols[code] = i;
  });
  var hasOutcomes = Object.keys(outcomeCols).length > 0;
  if (missing.length === AP_KEYS.length && overallCol === -1 && !hasOutcomes) throw new Error('No AP or outcome columns found: export Grades (with the AP assignment) or Learning Mastery from Canvas');
  // Who is who: an email-looking column first, else match the Canvas name to the Students tab.
  var emailCol = -1;
  headers.forEach(function (h, i) {
    if (emailCol !== -1) return;
    var hits = 0; for (var r = 1; r < rows.length; r++) if (/@/.test(str_(rows[r][i]))) hits++;
    if (hits >= Math.max(1, (rows.length - 1) / 2)) emailCol = i;
  });
  var nameCol = apHeaderCol_(headers, ['student name', 'name', 'student']);
  var roster = readTab_('Students'), byEmail = {}, byName = {};
  roster.forEach(function (st) { var e = lower_(st.Email); if (!e) return; byEmail[e] = e; byName[apNameKey_(st.Name)] = e; });
  var today = ymd_(new Date()), imported = 0, unmatched = [], blank = 0, outcomesImported = 0;
  for (var r = 1; r < rows.length; r++) {
    var row = rows[r];
    if (/^\s*points possible/i.test(str_(row[0]))) continue;
    var email = emailCol !== -1 ? byEmail[lower_(row[emailCol])] : null;
    if (!email && nameCol !== -1) email = byName[apNameKey_(row[nameCol])] || null;
    if (!email) { var who = nameCol !== -1 ? str_(row[nameCol]) : ''; if (who) unmatched.push(who); continue; }
    var fields = {}, n = 0;
    AP_KEYS.forEach(function (k) {
      var v = cols[k] === undefined ? null : numOrNull_(row[cols[k]]);
      if (v !== null && v >= 1 && v <= 7) { fields[k] = Math.round(v); n++; } else fields[k] = '';
    });
    var ov = overallCol === -1 ? null : numOrNull_(row[overallCol]);
    if (ov !== null && ov >= 1 && ov <= 7) { fields.overall = Math.round(ov); n++; } else fields.overall = '';
    var nOut = 0;
    Object.keys(outcomeCols).forEach(function (code) {
      var v = numOrNull_(row[outcomeCols[code]]);
      if (v === null || v < 1 || v > 7) return;
      upsert_('Outcomes', { Email: email, Outcome: code }, { Value: Math.round(v), Updated: new Date() }); nOut++;
    });
    if (nOut) outcomesImported++;
    if (!n) { if (!nOut) blank++; continue; }
    fields.Date = today; fields.Updated = new Date();
    upsert_('APLog', { Email: email, Source: 'teacher', Round: round }, fields);
    imported++;
  }
  return { imported: imported, unmatched: unmatched, blank: blank, missing: (overallCol !== -1 || hasOutcomes) && missing.length === AP_KEYS.length ? [] : missing,
           overall: overallCol !== -1, outcomes: Object.keys(outcomeCols), outcomesImported: outcomesImported };
}
// The tab a Canvas CSV landed in, found by its header row (no renaming needed).
function canvasTab_() {
  var found = null;
  ss_().getSheets().forEach(function (t) {
    if (found || TABS[t.getName()] || t.getLastRow() < 2) return;
    var h = t.getRange(1, 1, 1, Math.max(1, t.getLastColumn())).getValues()[0].map(lower_).join('|');
    if (/sis login id|student sis id/.test(h) && /active particip|manageself|growthmindset/.test(h)) found = t;
  });
  return found;
}
function importApFromCanvas() {
  var ui = SpreadsheetApp.getUi();
  var sh = tab_('CanvasImport') || canvasTab_();
  if (!sh) { ui.alert('No Canvas export found', 'In Canvas: Grades → Export → Export entire gradebook (or Learning Mastery → Export). Then here: File → Import → Upload → "Insert new sheet(s)", and run this again.', ui.ButtonSet.OK); return; }
  var ans = ui.prompt('Which AP round is this?', 'Type one of: ' + AP_ROUNDS.join(' · '), ui.ButtonSet.OK_CANCEL);
  if (ans.getSelectedButton() !== ui.Button.OK) return;
  var res;
  try { res = importApRows_(sh.getDataRange().getValues(), ans.getResponseText()); }
  catch (e) { ui.alert('Import stopped', e.message, ui.ButtonSet.OK); return; }
  var msg = res.imported + ' students imported into APLog (' + lower_(ans.getResponseText()) + ').';
  if (res.overall) msg += '\nUsed the overall AP grade from the Grades export.';
  if (res.outcomes.length) msg += '\nUnit outcomes (' + res.outcomes.join(', ') + ') saved for ' + res.outcomesImported + ' students: they feed the Athlete Card.';
  if (res.missing.length) msg += '\n\nNo column found for: ' + res.missing.join(', ') + '.';
  if (res.blank) msg += '\n' + res.blank + ' rows had no AP scores yet.';
  if (res.unmatched.length) msg += '\n\nNot on the Students tab (check spelling):\n' + res.unmatched.join('\n');
  msg += '\n\nDelete the "' + sh.getName() + '" tab now? (Recommended: the grades are in APLog.)';
  if (ui.alert('AP import done', msg, ui.ButtonSet.YES_NO) === ui.Button.YES) ss_().deleteSheet(sh);
}

// ---------- AP self-ratings: the Google Form responses → APLog (self rows) ----------
// Form columns (0-based, as the responses sheet lays them out): A Timestamp, B Email,
// G Active Participation, H Self Management, I Growth Mindset, J Self Awareness, Q Social Skills.
// Answers are the four rubric bands in words → the 1–7 scale (Consistently 7 · Mostly 5 · Sometimes 3 · else 1).
var AP_FORM_COL = { time: 0, email: 1, effort: 6, ready: 7, growth: 8, manage: 9, team: 16 };
function apFormBand_(text) {
  var t = lower_(text);
  if (!t) return null;
  if (/^[1-7]$/.test(t)) return Number(t);
  if (t.indexOf('consistent') !== -1) return 7;
  if (t.indexOf('mostly') !== -1) return 5;
  if (t.indexOf('sometimes') !== -1) return 3;
  return 1;
}
// Pure: rows = the responses sheet values (header first). Only roster students are kept. Returns counts only.
function importApFormRows_(rows) {
  if (!rows || rows.length < 2) throw new Error('The form responses are empty');
  if (!/mail/i.test(str_(rows[0][AP_FORM_COL.email]))) throw new Error('Column B of the responses is not the email column');
  var onRoster = {};
  readTab_('Students').forEach(function (st) { var e = lower_(st.Email); if (e) onRoster[e] = true; });
  var imported = 0, skipped = 0;
  for (var r = 1; r < rows.length; r++) {
    var row = rows[r], email = lower_(row[AP_FORM_COL.email]);
    if (!email || !onRoster[email]) { skipped++; continue; }
    var date = ymd_(row[AP_FORM_COL.time]); if (!date) { skipped++; continue; }
    var fields = {}, n = 0;
    AP_KEYS.forEach(function (k) { var v = apFormBand_(row[AP_FORM_COL[k]]); fields[k] = v === null ? '' : v; if (v !== null) n++; });
    if (!n) { skipped++; continue; }
    fields.Updated = new Date();
    upsert_('APLog', { Email: email, Date: date, Source: 'self' }, fields);
    imported++;
  }
  return { imported: imported, skipped: skipped };
}
// Reads the form through an APForm tab in THIS Sheet (A1: =IMPORTRANGE("<responses link>", "A:V")),
// so the script keeps its this-spreadsheet-only permission.
function importApFromForm() {
  var ui = SpreadsheetApp.getUi();
  var sh = tab_('APForm');
  if (!sh || sh.getLastRow() < 2) { ui.alert('No APForm tab yet', 'Add a tab called APForm. In cell A1 type:\n=IMPORTRANGE("<link to the AP form responses Sheet>", "A:V")\nClick Allow access, wait for the rows to load, then run this again.', ui.ButtonSet.OK); return; }
  var res;
  try { res = importApFormRows_(sh.getDataRange().getValues()); }
  catch (e) { ui.alert('Import stopped', e.message, ui.ButtonSet.OK); return; }
  ui.alert('AP self-ratings imported', res.imported + ' form responses copied into APLog as student self-ratings.\n' + res.skipped + ' rows skipped (not on the Students tab, or no ratings). Safe to run again after new responses: it updates, never duplicates.', ui.ButtonSet.OK);
}

// Retention: wipes every student-written row (styles, goals, predictions). Roster is untouched.
function clearProfileData() {
  var ui = SpreadsheetApp.getUi();
  var ans = ui.alert('Clear all student data?', 'This deletes every student\'s saved style, goals, self-predictions, Combine, skills, participation (incl. the AP log), bands and workout plan. The Students roster is not touched. Continue?', ui.ButtonSet.YES_NO);
  if (ans !== ui.Button.YES) return;
  ['Profile', 'Predictions', 'Combine', 'Skills', 'Participation', 'APLog', 'Outcomes', 'Bands', 'Goals', 'Plan', 'Locks', 'Reflections'].forEach(function (n) {
    var s = ensureTab_(n, TABS[n]);
    if (s.getLastRow() > 1) s.getRange(2, 1, s.getLastRow() - 1, s.getLastColumn()).clearContent();
  });
  ui.alert('Student data cleared.');
}
