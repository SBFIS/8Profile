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
//   • Every handler works on the verified caller's own rows. Nothing returns the roster.
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
  Bands:         ['Email'].concat(BAND_KEYS).concat(['Updated']),                // the three report bands
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
var BUILD = '2026-10-14 · student demo view';
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
    case 'saveSkills':      return saveSkills_(cfg, id, body.email, body.checkpoint, body.levels);
    case 'saveMySkills':    return saveMySkills_(cfg, id, body.checkpoint, body.levels);
    case 'saveBands':       return saveBands_(cfg, id, body.email, body.bands);
    case 'setLock':         return setLock_(cfg, id, body.emails, body.checkpoint, body.locked);
    case 'classOverview':   return classOverview_(cfg, id);
    case 'classStudent':    return classStudent_(cfg, id, body.email);
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

function apFor_(email) {
  var row = readTab_('Participation').filter(function (r) { return lower_(r.Email) === email; })[0];
  if (!row) return {};
  var out = {};
  AP_KEYS.forEach(function (k) {
    var self = numOrNull_(row[k + '_self']), tchr = numOrNull_(row[k + '_tchr']);
    if (self !== null || tchr !== null) out[k] = { self: self, tchr: tchr };
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
      ap = apFor_(email), bands = bandsFor_(email),
      g = goalsFor_(email), plan = planFor_(email);
  var any = Object.keys(fitness).length || Object.keys(skills).length ||
            Object.keys(ap).length || Object.keys(bands).length || g.items.length || g.note || plan;
  if (!any) return null;
  return { fitness: fitness, skills: skills, ap: ap, bands: bands, goals: g.items, goalNote: g.note, plan: plan };
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
      var data = s.getRange(2, 1, lastRow - 1, lastCol).getValues();
      for (var i = 0; i < data.length && rowIdx === -1; i++) {
        var hit = Object.keys(keys).every(function (k, j) { return lower_(data[i][keyCols[j]]) === lower_(keys[k]); });
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
  var fields = { Updated: new Date() }, saved = {};
  FIT_KEYS.forEach(function (k) {
    if (!(k in results) || results[k] === '' || results[k] === null) return;
    var meta = FIT_BY_KEY[k], n = Number(results[k]);
    if (!isFinite(n)) throw new Error('Not a number for ' + meta.label);
    if (n < meta.min || n > meta.max) throw new Error(meta.label + ' is out of range (' + meta.min + '–' + meta.max + ' ' + meta.unit + ')');
    fields[k] = n; saved[k] = n;
  });
  upsert_('Combine', { Email: id.email, Checkpoint: cp }, fields);
  return { ok: true, checkpoint: cp, results: saved };
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

// The student's personal workout plan (a small JSON structure built in the app).
function savePlan_(cfg, id, plan) {
  requireStudent_(id);
  if (plan === null || plan === undefined) throw new Error('Missing plan');
  var json; try { json = JSON.stringify(plan); } catch (e) { throw new Error('Bad plan'); }
  if (json.length > 8000) throw new Error('Plan is too long');
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
  var ap = indexAp_(), bands = indexBands_(), locks = locksIndex_();
  var out = [];
  readTab_('Students').forEach(function (r) {
    var email = lower_(r.Email); if (!email) return;
    out.push({ id: email, name: str_(r.Name), klass: str_(r.Class),
      fitness: combine[email] || {}, skills: skills[email] || {}, ap: ap[email] || {},
      bands: bands[email] || {}, locked: locks[email] || {} });
  });
  return { role: 'class', students: out, meta: combineMeta_() };
}
function classStudent_(cfg, id, targetEmail) {
  requireTeacher_(id);
  var email = lower_(targetEmail);
  var r = readTab_('Students').filter(function (x) { return lower_(x.Email) === email; })[0];
  if (!r) throw new Error('That student is not on the class list');
  return { role: 'classStudent', student: { id: email, name: str_(r.Name), klass: str_(r.Class),
    fitness: fitnessFor_(email), skills: skillsFor_(email), ap: apFor_(email), bands: bandsFor_(email) } };
}

// ---------- Sheet menu (teacher, inside the Sheet) ----------
function onOpen() {
  SpreadsheetApp.getUi().createMenu('PE Profile')
    .addItem('1. Set up tabs', 'setupTabs')
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

// Retention: wipes every student-written row (styles, goals, predictions). Roster is untouched.
function clearProfileData() {
  var ui = SpreadsheetApp.getUi();
  var ans = ui.alert('Clear all student data?', 'This deletes every student\'s saved style, goals, self-predictions, Combine, skills, participation, bands and workout plan. The Students roster is not touched. Continue?', ui.ButtonSet.YES_NO);
  if (ans !== ui.Button.YES) return;
  ['Profile', 'Predictions', 'Combine', 'Skills', 'Participation', 'Bands', 'Goals', 'Plan', 'Locks', 'Reflections'].forEach(function (n) {
    var s = ensureTab_(n, TABS[n]);
    if (s.getLastRow() > 1) s.getRange(2, 1, s.getLastRow() - 1, s.getLastColumn()).clearContent();
  });
  ui.alert('Student data cleared.');
}
