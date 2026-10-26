// Browser-only: wires the real src/Code.gs (running against fake-sheets.js)
// up to a fake API (window.fetch) and a fake Sign in with Google, seeds a
// SYNTHETIC roster, and picks who "you" are from the URL:
//   ?role=student | student2 | teacher | owner | unknown | wrong | anon | expired   (default student)
//   ?as=someone@example.edu   sign in as an exact address
//   &fail=1                   every write fails (to test error handling)
//   &latency=800              simulated round-trip in ms
//   &reset=1                  wipe the fake spreadsheet stored in localStorage
//   &nophoto=1                token without a picture (initials fallback)
// Nothing here is real: names and addresses are made up, domain example.edu.
(function () {
  'use strict';
  const q = new URLSearchParams(location.search);
  const STORE = 'g8pe_fake_book_v3';
  const latency = parseInt(q.get('latency') || '200', 10);
  const failWrites = q.get('fail') === '1';
  window.__preview = { fastRetry: true };
  window.PE_CONFIG = { apiUrl: 'https://api.example/exec', clientId: 'preview-client', domain: 'example.edu' };

  if (q.get('reset') !== '1') {
    try { const j = localStorage.getItem(STORE); if (j) FakeSheets.book = FakeSheets.Book.fromJSON(JSON.parse(j)); } catch (e) {}
  }
  FakeSheets.book.onChange = b => { try { localStorage.setItem(STORE, JSON.stringify(b.toJSON())); } catch (e) {} };

  const ROSTER = [
    ['sample.one@example.edu',   'Sample One',    '8A'],
    ['sample.two@example.edu',   'Two, Sample',   '8A'], // "Last, First" as the school system exports it
    ['sample.three@example.edu', 'Sample Three',  '8B'],
    ['sample.four@example.edu',  'Sample Four',   '8B'],
    ['teacher@example.edu',      'Teacher Test',  '8B'] // the owner, also on the roster to test the student view
  ];
  const PHOTO = 'https://lh3.googleusercontent.com/preview/' + encodeURIComponent('data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="#cfe4f2"/><circle cx="50" cy="40" r="18" fill="#e8b98f"/><path d="M18 100C18 74 34 66 50 66s32 8 32 34z" fill="#3f6d8c"/></svg>');
  const tokenFor = (email, extra) => FakeSheets.token(Object.assign({
    aud: 'preview-client', email, email_verified: 'true', hd: email.split('@')[1], name: 'Token Name',
    picture: q.get('nophoto') === '1' ? '' : PHOTO, exp: Math.floor(Date.now() / 1000) + 3600
  }, extra || {}));
  function setConfig(key, val) { const cfg = FakeSheets.book.getSheetByName('Config'); cfg.getDataRange().getValues().forEach((r, i) => { if (r[0] === key) cfg.getRange(i + 1, 2).setValues([[val]]); }); }
  function callApi(body) { return JSON.parse(doPost({ postData: { contents: JSON.stringify(body) } }).getContent()); }

  function seed() {
    FakeSheets.owner = 'teacher@example.edu';
    setupTabs();
    setConfig('domain', 'example.edu'); setConfig('oauth_client_id', 'preview-client');
    const st = FakeSheets.book.getSheetByName('Students');
    st.getRange(2, 1, ROSTER.length, 3).setValues(ROSTER);
    const t = FakeSheets.book.getSheetByName('Teachers');
    t.getRange(t.getLastRow() + 1, 1, 1, 2).setValues([['other.teacher@example.edu', 'Other Teacher']]);
    clearConfigCache();
    const tok = tokenFor('sample.two@example.edu');
    callApi({ action: 'saveStyle', token: tok, style: 'improver' }); // one student has already chosen
    const ans = {}; PREDICT_ITEMS.forEach((k, i) => { ans[k] = { rating: RATINGS[i % 3], freq: FREQS[(i + 1) % 3] }; });
    callApi({ action: 'savePrediction', token: tok, checkpoint: 'intro', answers: ans }); // ...and made their Lesson 1 prediction

    // ── synthetic v3 data: sample.one is a fully-populated student; the class has a spread ──
    const T1 = tokenFor('sample.one@example.edu');
    if (!/[?&]nostyle=1/.test(location.search)) callApi({ action: 'saveStyle', token: T1, style: 'improver' }); // ?nostyle=1 → first-visit pack
    const ans1 = {}; PREDICT_ITEMS.forEach((k, i) => { ans1[k] = { rating: RATINGS[i % 3], freq: FREQS[(i + 1) % 3] }; });
    callApi({ action: 'savePrediction', token: T1, checkpoint: 'intro', answers: ans1 });
    callApi({ action: 'saveCombine', token: T1, checkpoint: 'sept', results: { mile: 612, pushups: 14, sitstand: 28, broad: 168, grip: 24, sprint: 5.9, illinois: 18.9, stork: 7 } });
    callApi({ action: 'saveCombine', token: T1, checkpoint: 'jan',  results: { mile: 584, pushups: 18, sitstand: 31, broad: 176, grip: 26, sprint: 5.7, illinois: 18.1, stork: 5 } });
    callApi({ action: 'saveGoals', token: T1, goals: [{ component: 'mile', target: 540 }, { component: 'dribble', target: 6 }, { component: 'pushups', target: 25 }], note: 'Run Tue/Thu, weak-hand dribble every session, push-ups after PE.' });
    const ago = d => { const x = new Date(Date.now() - d * 864e5); return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0'); };
    callApi({ action: 'savePlan', token: T1, plan: { v: 3,
      warmup: [{ n: 'Light jog', min: 3, int: 'easy' }, { n: 'Dynamic stretches', min: 2, int: 'easy' }],
      cardio: [{ n: 'Running intervals', sets: 4, reps: '1 min', min: 6, int: 'hard' }, { n: 'Skipping rope', sets: '', reps: '', min: 4, int: 'moderate' }],
      strength: [{ n: 'Push-ups (max reps)', sets: 3, reps: '40s', int: 'moderate' }, { n: 'Bodyweight squats', sets: 3, reps: '45s', int: 'moderate' }],
      focus: [{ n: 'Sprints', sets: 4, reps: '20 m', min: 4, int: 'hard' }],
      cooldown: [{ n: 'Static stretches', min: 4, int: 'easy' }],
      sChoice: 'endurance', fChoice: 'speed', hr: '150–170 bpm', fWhy: 'Short hard sprints build my top speed for the 30 m.',
      why: { warmup: 'Raises my heart rate and loosens hips and hamstrings', cardio: 'Intervals push me into my zone to improve the mile', strength: 'Timed sets build muscular endurance in arms and legs' },
      ref: { strength: 'My strength is sit-to-stand (31). I want to improve my mile (9:44).', worked: 'I reached 160 bpm in the intervals. Push-ups went 18 to 21.', change: '', matters: '' },
      equip: ['water bottle'], days: { tue: true, thu: true, sat: true },
      log: [{ date: ago(1), who: 'friend', num: '21 push-ups' }, { date: ago(9), who: 'me', num: '4 × 1 min at 160 bpm' }], reflection: '' } });
    const TT = tokenFor('teacher@example.edu'); // the owner is a teacher
    const seedSkills = (email, lv) => callApi({ action: 'saveSkills', token: TT, email, checkpoint: 'sept', levels: lv });
    seedSkills('sample.one@example.edu',   { throw: 4, catch: 5, strike: 3, dribble: 4, kick: 4, jump: 4, core: 5 });
    seedSkills('sample.two@example.edu',   { throw: 3, catch: 3, strike: 3, dribble: 2, kick: 3, jump: 3, core: 3 });
    seedSkills('sample.three@example.edu', { throw: 5, catch: 5, strike: 4, dribble: 5, kick: 5, jump: 4, core: 5 });
    seedSkills('sample.four@example.edu',  { throw: 2, catch: 3, strike: 2, dribble: 3, kick: 3, jump: 2, core: 3 });
    // participation + report bands (no API write; teacher-reported, seeded straight to the Sheet)
    const setRow = (tabName, vals) => { const s = FakeSheets.book.getSheetByName(tabName); s.getRange(s.getLastRow() + 1, 1, 1, vals.length).setValues([vals]); };
    setRow('Participation', ['sample.one@example.edu', 5, 4, 5, 5, 4, 4, 6, 5, 4, 4, '2026-09-20']);
    setRow('Bands', ['sample.one@example.edu', 5, 5, 4, '2026-09-20']);
    // AP log: regular self-checks (synthetic) + the teacher's S1-mid grade imported from Canvas
    [[50, 6, 6, 5, 6, 5], [38, 6, 5, 5, 6, 5], [27, 5, 5, 4, 6, 4], [15, 6, 5, 5, 6, 5], [6, 6, 6, 5, 7, 5], [1, 6, 6, 6, 7, 5]].forEach(r =>
      setRow('APLog', ['sample.one@example.edu', ago(r[0]), 'self', '', r[1], r[2], r[3], r[4], r[5], new Date()]));
    importApRows_([['Student name', 'PE.G6-10.C1 result', 'ATL.SM.manageself result', 'Growthmindset result', 'PE.G6-10.S4 result', 'ATL.SC.self result'],
      ['Sample One', 4, 5, 5, 5, 4], ['Sample Two', 5, 5, 4, 5, 5]], 's1-mid');
    importApRows_([['Student', 'SIS Login ID', 'Assignment -  Am I an Active Participant in PE? (139255)'], ['    Points Possible', '', 7], ['Sample Four', 'sample.four@example.edu', 6]], 's1-mid'); // overall only, like the Grades export
    // AP check-out: the teacher's lesson ratings on the day's focus (Source 'lesson', never Canvas)
    const KI = { ready: 4, effort: 5, growth: 6, team: 7, manage: 8 };
    [[34, 'effort', 5], [20, 'team', 6], [13, 'effort', 6], [4, 'growth', 4]].forEach(r => { const row = ['sample.one@example.edu', ago(r[0]), 'lesson', '', '', '', '', '', '', new Date()]; row[KI[r[1]]] = r[2]; setRow('APLog', row); });
    [[13, 'effort', 3], [4, 'team', 5]].forEach(r => { const row = ['sample.two@example.edu', ago(r[0]), 'lesson', '', '', '', '', '', '', new Date()]; row[KI[r[1]]] = r[2]; setRow('APLog', row); });
    callApi({ action: 'saveSkills', token: TT, email: 'sample.one@example.edu', checkpoint: 'jan', levels: { throw: 5, catch: 5, dribble: 5, core: 5 } }); // a January bump → trend arrows
    callApi({ action: 'saveCombine', token: tokenFor('sample.three@example.edu'), checkpoint: 'sept', results: { mile: 545, pushups: 22, broad: 195, sprint: 5.3 } });
  }
  if (!FakeSheets.book.getSheetByName('Students')) seed();
  FakeSheets.owner = 'teacher@example.edu';
  FakeSheets.cache = {};

  // who am I → a fake token in sessionStorage (what a real sign-in leaves behind)
  const role = q.get('role') || 'student';
  let email = ROSTER[0][0], extra = null;
  if (q.get('as')) email = q.get('as');
  else if (role === 'student2') email = ROSTER[1][0];
  else if (role === 'teacher') email = 'other.teacher@example.edu';
  else if (role === 'owner') email = 'teacher@example.edu';
  else if (role === 'unknown') email = 'nobody@example.edu';
  else if (role === 'wrong') email = 'someone@gmail.example';
  else if (role === 'expired') extra = { exp: Math.floor(Date.now() / 1000) - 10 };
  try { sessionStorage.removeItem('pe_token'); } catch (e) {}
  if (role !== 'anon') {
    const tok = tokenFor(email, extra);
    // an expired token is dropped by the page before use; keep it "valid-looking" for the page but rejected by the server
    if (role === 'expired') { const t2 = tokenFor(email, { exp: Math.floor(Date.now() / 1000) + 3600, aud: 'someone-else' }); sessionStorage.setItem('pe_token', t2); }
    else sessionStorage.setItem('pe_token', tok);
  }

  // fake Sign in with Google: a button that hands over a token for the chosen role
  window.google = { accounts: { id: {
    initialize() {}, prompt() {}, disableAutoSelect() {},
    renderButton(el) { el.innerHTML = '<button type="button" id="fakegsi" class="ct-btn">Sign in with Google (preview)</button>'; el.querySelector('button').onclick = () => window.__gsiCallback && window.__gsiCallback({ credential: tokenFor(role === 'anon' ? ROSTER[0][0] : email) }); }
  } } };
  const realInit = window.google.accounts.id.initialize;
  window.google.accounts.id.initialize = o => { window.__gsiCallback = o.callback; realInit(o); };

  // preview-only: a small role switcher so a demo needs no URL editing
  function roleBar() {
    const roles = [['student', '👤 Student'], ['student2', '👤 Student 2'], ['teacher', '🧑‍🏫 Teacher'], ['unknown', 'Not listed'], ['anon', 'Signed out']];
    const bar = document.createElement('div');
    bar.setAttribute('style', 'position:fixed;left:50%;transform:translateX(-50%);bottom:8px;z-index:9999;display:flex;gap:4px;background:#201b1d;padding:5px;border-radius:999px;box-shadow:0 4px 14px rgba(0,0,0,.3);font:600 12px Inter,system-ui,sans-serif');
    roles.forEach(([r, label]) => {
      const a = document.createElement('a');
      const on = (q.get('role') || 'student') === r;
      a.textContent = label;
      a.href = '?role=' + r;
      a.setAttribute('style', 'color:' + (on ? '#3a1008' : '#f0d3d8') + ';background:' + (on ? '#e7b64b' : 'transparent') + ';text-decoration:none;padding:5px 11px;border-radius:999px');
      bar.appendChild(a);
    });
    const tag = document.createElement('span');
    tag.textContent = 'PREVIEW · sample data';
    tag.setAttribute('style', 'color:#8c817d;padding:5px 8px;align-self:center');
    bar.appendChild(tag);
    document.addEventListener('DOMContentLoaded', () => document.body.appendChild(bar));
    if (document.body) document.body.appendChild(bar);
  }
  roleBar();

  // fake API transport: window.fetch → doPost in-page
  const realFetch = window.fetch;
  window.fetch = (url, opts) => {
    if (url !== window.PE_CONFIG.apiUrl) return realFetch(url, opts);
    return new Promise(resolve => setTimeout(() => {
      let out;
      try {
        const body = JSON.parse(opts.body);
        if (failWrites && /^save/.test(body.action)) out = { ok: false, error: 'Preview: writes are set to fail (&fail=1)' };
        else out = callApi(body);
      } catch (e) { out = { ok: false, error: e.message }; }
      resolve({ ok: true, json: async () => out });
    }, latency));
  };
})();
