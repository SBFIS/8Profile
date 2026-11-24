#!/usr/bin/env node
// Runs the real src/Code.gs under Node against the fake runtime and checks the
// privacy guarantees: identity comes only from a verified Google token, a
// student gets their own rows only, non-domain accounts are refused, writes are
// validated. Synthetic data only.   Usage: node dev/test-server.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');

vm.runInThisContext(read('dev/fake-sheets.js'), { filename: 'fake-sheets.js' });
vm.runInThisContext(read('src/Code.gs'), { filename: 'Code.gs' });

let failed = 0;
function check(name, cond, detail) { if (cond) console.log('  ✓', name); else { failed++; console.log('  ✗', name, detail === undefined ? '' : JSON.stringify(detail)); } }
const CLIENT = 'test-client';
const now = () => Math.floor(Date.now() / 1000);
const tokenFor = (email, extra) => FakeSheets.token(Object.assign({ aud: CLIENT, email, email_verified: 'true', hd: email.split('@')[1], exp: now() + 3600, name: 'Tok Name', picture: 'https://lh3.googleusercontent.com/a/photo' }, extra || {}));
const post = (action, payload, tok) => JSON.parse(doPost({ postData: { contents: JSON.stringify(Object.assign({ action, token: tok }, payload || {})) } }).getContent());
const as = (email, action, payload, extra) => post(action, payload, tokenFor(email, extra));
const S1 = 'sample.one@example.edu', S2 = 'sample.two@example.edu', S3 = 'sample.three@example.edu', T = 'other.teacher@example.edu', OWNER = 'teacher@example.edu';

// ---- seed a synthetic school ----
FakeSheets.owner = OWNER;
setupTabs();
const cfgTab = FakeSheets.book.getSheetByName('Config');
const setConfig = (k, v) => { cfgTab.getDataRange().getValues().forEach((r, i) => { if (r[0] === k) cfgTab.getRange(i + 1, 2).setValues([[v]]); }); clearConfigCache(); };
setConfig('domain', 'example.edu'); setConfig('oauth_client_id', CLIENT);
FakeSheets.book.getSheetByName('Students').getRange(2, 1, 4, 3).setValues([
  ['Sample.One@example.edu', 'Sample One', '8A'],
  [S2, 'Two, Sample', '8A'],
  [S3, 'T, Sample Jo', '8B'],
  [OWNER, 'Teacher Test', '8B']
]);
FakeSheets.book.getSheetByName('Teachers').getRange(3, 1, 1, 2).setValues([[T, 'Other Teacher']]);

console.log('setup');
check('tabs created', ['Config', 'Students', 'Teachers', 'Profile', 'Predictions'].every(n => FakeSheets.book.getSheetByName(n)));
check('owner auto-added to Teachers', readTab_('Teachers')[0].Email === OWNER);
check('Predictions tab has 29 columns', TABS.Predictions.length === 29 && TABS.Predictions[3] === 'cv_rating' && TABS.Predictions[28] === 'core_freq');

console.log('token verification');
const authErr = r => !r.ok && r.authRequired === true;
check('no token → authRequired', authErr(post('bootstrap', {}, '')));
check('garbage token → authRequired, no tokeninfo call', (() => { const n = FakeSheets.fetchCount; const r = post('bootstrap', {}, 'not a token'); return authErr(r) && FakeSheets.fetchCount === n; })());
check('token google rejects → authRequired', authErr(post('bootstrap', {}, 'real.looking.jwt')));
check('token for another client (aud) → authRequired', authErr(as(S1, 'bootstrap', {}, { aud: 'someone-else' })));
check('unverified email → authRequired', authErr(as(S1, 'bootstrap', {}, { email_verified: 'false' })));
check('expired token → authRequired', authErr(as(S1, 'bootstrap', {}, { exp: now() - 5 })));
check('valid token → ok', as(S1, 'bootstrap').ok === true);
check('verified token is cached (second call makes no tokeninfo request)', (() => { const tok = tokenFor(S3); post('bootstrap', {}, tok); const n = FakeSheets.fetchCount; post('bootstrap', {}, tok); return FakeSheets.fetchCount === n; })());
check('unknown action → error, not authRequired', (() => { const r = as(S1, 'nothing'); return !r.ok && /Unknown action/.test(r.error) && !r.authRequired; })());
check('bad JSON body → Bad request', (() => { const r = JSON.parse(doPost({ postData: { contents: '{nope' } }).getContent()); return !r.ok && /Bad request/.test(r.error); })());
check('doGet returns no data', (() => { const r = JSON.parse(doGet().getContent()); return r.ok === false && !JSON.stringify(r).includes('example.edu'); })());
check('doGet shows the live build stamp', JSON.parse(doGet().getContent()).build === BUILD);
check('fitness meta carries a reference guide for every test', FITNESS.every(f => Array.isArray(f.ref) && f.ref.length === 2 && (f.dir === 'down' ? f.ref[0] <= f.ref[1] : f.ref[0] >= f.ref[1])));

console.log('identity');
const s1 = as(S1, 'bootstrap').data;
check('student (case-insensitive roster email) → own name & class', s1.role === 'student' && s1.student.name === 'Sample One' && s1.student.klass === '8A', s1);
check('student payload has no email and no roster', !('email' in s1) && !JSON.stringify(s1).includes('example.edu'), s1);
check('photo comes from the token picture claim', s1.student.photoUrl === 'https://lh3.googleusercontent.com/a/photo');
check('non-Google picture URL is dropped', as(S1, 'bootstrap', {}, { picture: 'https://evil.example/x.png' }).data.student.photoUrl === '');
check('"Last, First" → first name only, initial ignored', (() => { const st = as(S2, 'bootstrap').data.student; return st.first === 'Sample' && st.name === 'Sample' && st.initials === 'S'; })());
check('"L, First Middle" → first token after the comma', (() => { const st = as(S3, 'bootstrap').data.student; return st.first === 'Sample' && st.name === 'Sample'; })());
check('nameParts_ edge cases', nameParts_('  ').first === '' && nameParts_('Solo').display === 'Solo' && nameParts_(',').first === '');
check('owner on roster → student + alsoTeacher', (() => { const b = as(OWNER, 'bootstrap').data; return b.role === 'student' && b.alsoTeacher === true; })());
check('teacher not on roster → teacher view with own email only', (() => { const b = as(T, 'bootstrap').data; return b.role === 'teacher' && b.email === T && !b.student; })());
check('teacher bootstrap carries prediction labels for the demo, and no student data', (() => { const b = as(T, 'bootstrap').data; return b.predict && b.predict.items.length > 0 && !b.student && !b.students && !b.roster; })());
check('domain account on no tab → unknown', as('nobody@example.edu', 'bootstrap').data.role === 'unknown');
check('other domain (hd) → wrong_domain, nothing else', (() => { const b = as('someone@gmail.example', 'bootstrap').data; return b.role === 'wrong_domain' && !b.email && !b.student; })());
check('lookalike domain → wrong_domain', as('x@example.edu.evil.test', 'bootstrap').data.role === 'wrong_domain');
check('right email but missing hd claim → wrong_domain', as(S1, 'bootstrap', {}, { hd: '' }).data.role === 'wrong_domain');
check('roster email does not grant access without a token for it', (() => { const r = post('bootstrap', { email: S1 }, tokenFor('nobody@example.edu')); return r.data.role === 'unknown'; })());

console.log('writes');
check('saveStyle stores for the caller', as(S1, 'saveStyle', { style: 'Improver' }).data.style === 'improver' && as(S1, 'bootstrap').data.student.style === 'improver');
check('Profile row keyed by verified email', readTab_('Profile').length === 1 && readTab_('Profile')[0].Email === S1);
check('saveStyle upserts (no duplicate rows)', (() => { as(S1, 'saveStyle', { style: 'team' }); return readTab_('Profile').length === 1 && readTab_('Profile')[0].Style === 'team'; })());
check('other student unaffected and cannot see it', as(S2, 'bootstrap').data.student.style === '');
check('unknown style rejected', /Unknown style/.test(as(S1, 'saveStyle', { style: 'ninja' }).error));
check('teacher (not on roster) cannot write', /class list/.test(as(T, 'saveStyle', { style: 'team' }).error));
check('wrong domain cannot write', /class list/.test(as('x@gmail.example', 'saveStyle', { style: 'team' }).error));
check('no token cannot write', authErr(post('saveStyle', { style: 'team' }, '')));
check('error messages contain no email', !as('x@gmail.example', 'saveStyle', { style: 'team' }).error.includes('@'));
check('saveGoal trims, strips control chars, caps length', (() => { const g = as(S2, 'saveGoal', { goal: '  Mile\tunder 8:30 ' + 'x'.repeat(300) }).data; return g.goal.length === 140 && g.goal.startsWith('Mile under 8:30'); })());

console.log('predictions');
const full = {}; PREDICT_ITEMS.forEach((k, i) => { full[k] = { rating: RATINGS[i % 3], freq: FREQS[i % 3] }; });
check('no prediction yet → empty object, combine null', (() => { const st = as(S1, 'bootstrap').data.student; return JSON.stringify(st.predictions) === '{}' && st.combine === null; })());
check('bootstrap exposes the item/rating vocab', (() => { const b = as(S1, 'bootstrap').data; return b.predict.items.length === 13 && b.predict.ratings.length === 3 && b.predict.freqs.length === 3; })());
check('incomplete submission rejected, nothing written', /Incomplete.*12 left/.test(as(S1, 'savePrediction', { checkpoint: 'intro', answers: { cv: { rating: 'strength', freq: 'often' } } }).error) && readTab_('Predictions').length === 0);
check('bad value rejected', (() => { const bad = JSON.parse(JSON.stringify(full)); bad.kick.rating = 'amazing'; return /Incomplete/.test(as(S1, 'savePrediction', { checkpoint: 'intro', answers: bad }).error); })());
check('unknown checkpoint rejected', /Unknown checkpoint/.test(as(S1, 'savePrediction', { checkpoint: 'final', answers: full }).error));
check('full submission saved and echoed', (() => { const r = as(S1, 'savePrediction', { checkpoint: 'Intro', answers: full }).data; return r.checkpoint === 'intro' && r.prediction.items.cv.rating === 'strength' && r.prediction.timestamp.length >= 10; })());
check('one row, keyed by verified email + checkpoint', readTab_('Predictions').length === 1 && readTab_('Predictions')[0].Email === S1 && readTab_('Predictions')[0].Checkpoint === 'intro');
check('re-save overwrites the same row', (() => { const again = JSON.parse(JSON.stringify(full)); again.cv.rating = 'work-on'; as(S1, 'savePrediction', { checkpoint: 'intro', answers: again }); return readTab_('Predictions').length === 1 && as(S1, 'bootstrap').data.student.predictions.intro.items.cv.rating === 'work-on'; })());
check('another student sees no prediction', JSON.stringify(as(S2, 'bootstrap').data.student.predictions) === '{}');
check('teacher / wrong domain / no token cannot save', /class list/.test(as(T, 'savePrediction', { checkpoint: 'intro', answers: full }).error) && /class list/.test(as('x@gmail.example', 'savePrediction', { checkpoint: 'intro', answers: full }).error) && authErr(post('savePrediction', { checkpoint: 'intro', answers: full }, '')));
check('client-supplied email in the body is ignored', (() => { as(S2, 'savePrediction', { checkpoint: 'intro', answers: full, email: S1, Email: S1 }); const rows = readTab_('Predictions'); return rows.length === 2 && rows.filter(r => r.Email === S2).length === 1; })());
check('bootstrap payload never carries another student\'s rows', !JSON.stringify(as(S2, 'bootstrap')).includes('sample.one'));

console.log('v3 combine (student self-entry)');
check('student with no data → combine null', as(S3, 'bootstrap').data.student.combine === null);
check('saveCombine stores the caller\'s fitness numbers', (() => {
  const r = as(S1, 'saveCombine', { checkpoint: 'sept', results: { mile: 612, pushups: 14, sprint: 5.9, stork: 7 } });
  if (!r.ok) return false;
  const c = as(S1, 'bootstrap').data.student.combine;
  return c && c.fitness.mile.sept === 612 && c.fitness.pushups.sept === 14 && c.fitness.sprint.sept === 5.9;
})());
check('blank fields are skipped, not zeroed', (() => { const c = as(S1, 'bootstrap').data.student.combine; return !('grip' in c.fitness); })());
check('second checkpoint builds the trend', (() => { as(S1, 'saveCombine', { checkpoint: 'jan', results: { mile: 590 } }); const c = as(S1, 'bootstrap').data.student.combine; return c.fitness.mile.sept === 612 && c.fitness.mile.jan === 590; })());
check('out-of-range value refused', (() => { const r = as(S1, 'saveCombine', { checkpoint: 'sept', results: { mile: 50 } }); return !r.ok && /range/i.test(r.error); })());
check('non-number refused', (() => { const r = as(S1, 'saveCombine', { checkpoint: 'sept', results: { mile: 'fast' } }); return !r.ok && /number/i.test(r.error); })());
check('unknown checkpoint refused', (() => { const r = as(S1, 'saveCombine', { checkpoint: 'xx', results: { mile: 600 } }); return !r.ok && /checkpoint/i.test(r.error); })());
check('teacher (not on roster) cannot saveCombine', /class list/.test(as(T, 'saveCombine', { checkpoint: 'sept', results: { mile: 600 } }).error));
check('one Combine row per student per checkpoint', readTab_('Combine').filter(r => lower_(r.Email) === S1).length === 2);
check('another student sees no combine', as(S2, 'bootstrap').data.student.combine === null);

console.log('v3 goals + plan (student)');
check('saveGoals keeps valid components, drops junk', (() => {
  const r = as(S1, 'saveGoals', { goals: [{ component: 'mile', goal: 'under 9:30' }, { component: 'nope', goal: 'x' }, { component: 'throw', goal: 'reach L5' }] });
  return r.ok && r.data.goals.length === 2 && as(S1, 'bootstrap').data.student.combine.goals.length === 2;
})());
check('saveGoals replaces the whole set', (() => { as(S1, 'saveGoals', { goals: [{ component: 'stork', goal: 'fewer losses' }] }); const g = as(S1, 'bootstrap').data.student.combine.goals; return g.length === 1 && g[0].component === 'stork'; })());
check('saveGoals stores a numeric target and a note', (() => { const r = as(S1, 'saveGoals', { goals: [{ component: 'mile', target: 540 }, { component: 'dribble', target: 6 }], note: 'run twice a week' }); const c = as(S1, 'bootstrap').data.student.combine; return r.ok && c.goals.find(x => x.component === 'mile').target === 540 && c.goalNote === 'run twice a week'; })());
check('savePlan stores and reads back', (() => { const plan = { days: [{ focus: 'cv', items: ['run 20 min'] }] }; const r = as(S1, 'savePlan', { plan: plan }); return r.ok && as(S1, 'bootstrap').data.student.combine.plan.days[0].focus === 'cv'; })());
check('savePlan keeps sets/reps rows and the home-session log', (() => { const plan = { warmup: [], main: [{ n: 'Push-ups', c: 'strength', sets: 3, reps: '10' }], cooldown: [], days: { tue: true }, log: [{ date: '2026-10-14', who: 'friend' }] }; const r = as(S1, 'savePlan', { plan: plan }); const p = as(S1, 'bootstrap').data.student.combine.plan; return r.ok && p.main[0].sets === 3 && p.main[0].reps === '10' && p.log[0].who === 'friend'; })());
check('savePlan keeps a full season of logged sessions (60 entries with a change line each)', (() => {
  const log = []; for (let i = 0; i < 60; i++) log.push({ id: 'e' + i, date: '2027-02-' + String(1 + (i % 28)).padStart(2, '0'), who: 'me', where: i % 2 ? 'home' : 'class', feel: 'right', hr: 'y', num: '22 push-ups and 10 min at 160 bpm', chg: 'x'.repeat(160) });
  const r = as(S1, 'savePlan', { plan: { v: 3, why: { warmup: 'by building up slowly' }, log } });
  return r.ok && r.data.plan.log.length === 60 && r.data.plan.log.every(e => /^e\d+$/.test(e.id) && e.chg.length === 160 && e.hr === 'y');
})());
check('savePlan merges logged sessions: an older draft never wipes a session logged since', (() => {
  as(S2, 'savePlan', { plan: { v: 4, log: [{ id: 'a1', date: '2026-10-20', where: 'class', who: 'me', num: '18' }] } });
  as(S2, 'savePlan', { plan: { v: 4, log: [{ id: 'a1', date: '2026-10-20', where: 'class', who: 'me', num: '18' }, { id: 'b2', date: '2026-10-22', where: 'home', who: 'friend', num: '20' }] } }); // workout mode logs b2
  const r = as(S2, 'savePlan', { plan: { v: 4, hr: '150', log: [{ id: 'a1', date: '2026-10-20', where: 'class', who: 'me', num: '18' }] } }); // stale draft saved later
  return r.ok && r.data.plan.log.length === 2 && r.data.plan.log.some(e => e.id === 'b2') && r.data.plan.hr === '150';
})());
check('savePlan removes only the sessions the student deleted', (() => {
  const r = as(S2, 'savePlan', { plan: { v: 4, log: [], logRemoved: ['a1'] } });
  return r.ok && r.data.plan.log.length === 1 && r.data.plan.log[0].id === 'b2' && !('logRemoved' in r.data.plan);
})());
check('savePlan does not duplicate a session when a save is retried', (() => {
  const e = { id: 'c3', date: '2026-10-23', where: 'home', who: 'me', num: '21' };
  as(S2, 'savePlan', { plan: { v: 4, log: [e] } }); const r = as(S2, 'savePlan', { plan: { v: 4, log: [e] } });
  return r.ok && r.data.plan.log.filter(x => x.id === 'c3').length === 1;
})());
check('savePlan stamps savedAt (so a device can tell the plan changed elsewhere)', /^\d{4}-\d\d-\d\dT/.test((as(S2, 'savePlan', { plan: { v: 4, log: [] } }).data || { plan: {} }).plan.savedAt || ''));
check('savePlan merges legacy sessions without ids by date/where/who/number', (() => {
  as(S3, 'savePlan', { plan: { v: 3, log: [{ date: '2026-10-01', who: 'me', num: '9' }] } });
  const r = as(S3, 'savePlan', { plan: { v: 4, log: [{ date: '2026-10-01', who: 'me', num: '9' }] } });
  return r.ok && r.data.plan.log.length === 1;
})());
check('savePlan refuses an oversized plan', /too long/.test(as(S1, 'savePlan', { plan: { reflection: 'x'.repeat(46000) } }).error || ''));
check('teacher (not on roster) cannot saveGoals', /class list/.test(as(T, 'saveGoals', { goals: [] }).error));

console.log('reflections + unit self-assessment');
check('saveReflection stores the compare reflection', (() => { const r = as(S1, 'saveReflection', { key: 'compare-intro', text: 'I underrated my sprint' }); return r.ok && as(S1, 'bootstrap').data.student.reflections['compare-intro'].text === 'I underrated my sprint'; })());
check('saveReflection overwrites the same slot', (() => { as(S1, 'saveReflection', { key: 'compare-intro', text: 'second go' }); return as(S1, 'bootstrap').data.student.reflections['compare-intro'].text === 'second go' && readTab_('Reflections').filter(r => r.Email === S1 && r.Key === 'compare-intro').length === 1; })());
check('unit self-assessment JSON round-trips', (() => { const j = JSON.stringify({ levels: [2, 3, 2, 4], focus: 'move my opponent' }); as(S1, 'saveReflection', { key: 'unit-badminton', text: j }); return JSON.parse(as(S1, 'bootstrap').data.student.reflections['unit-badminton'].text).levels[3] === 4; })());
check('another student does not see my reflections', Object.keys(as(S2, 'bootstrap').data.student.reflections).length === 0);
check('unknown reflection key refused', /Unknown reflection/.test(as(S1, 'saveReflection', { key: 'teacher-notes', text: 'x' }).error || ''));
check('oversized reflection refused', /too long/.test(as(S1, 'saveReflection', { key: 'compare-intro', text: 'x'.repeat(2001) }).error || ''));
check('teacher (not on roster) cannot saveReflection', /class list/.test(as(T, 'saveReflection', { key: 'compare-intro', text: 'x' }).error || ''));
check('saveReflection ignores an email in the body', (() => { as(S2, 'saveReflection', { key: 'compare-intro', text: 'mine', email: S1 }); return as(S1, 'bootstrap').data.student.reflections['compare-intro'].text === 'second go'; })());

console.log('v3 skills (teacher-entered) + class view');
check('teacher records a student\'s skill levels', (() => {
  const r = as(T, 'saveSkills', { email: S1, checkpoint: 'sept', levels: { throw: 4, catch: 5, core: 5 } });
  const c = as(S1, 'bootstrap').data.student.combine;
  return r.ok && c.skills.throw.sept === 4 && c.skills.catch.sept === 5;
})());
check('owner (student+teacher) can record skills too', as(OWNER, 'saveSkills', { email: S1, checkpoint: 'sept', levels: { kick: 4 } }).ok === true);
check('a plain student cannot record skills', (() => { const r = as(S2, 'saveSkills', { email: S1, checkpoint: 'sept', levels: { throw: 3 } }); return !r.ok && /teacher/i.test(r.error); })());
check('skill level outside 1-6 refused', (() => { const r = as(T, 'saveSkills', { email: S1, checkpoint: 'sept', levels: { throw: 9 } }); return !r.ok && /must be/i.test(r.error); })());
check('skills for a non-roster student refused', (() => { const r = as(T, 'saveSkills', { email: 'ghost@example.edu', checkpoint: 'sept', levels: { throw: 3 } }); return !r.ok && /class list/.test(r.error); })());
check('classOverview: teacher sees the roster with data', (() => { const r = as(T, 'classOverview'); return r.ok && r.data.role === 'class' && r.data.students.length === 4 && r.data.students.some(s => s.skills.throw && s.skills.throw.sept === 4); })());
check('classOverview refused for a non-teacher student', (() => { const r = as(S2, 'classOverview'); return !r.ok && /teacher/i.test(r.error); })());
check('classStudent: teacher reads one student', (() => { const r = as(T, 'classStudent', { email: S1 }); return r.ok && r.data.student.name === 'Sample One' && r.data.student.fitness.mile.sept === 612; })());
check('classStudent refused for a non-teacher', (() => !as(S2, 'classStudent', { email: S1 }).ok)());
check('student bootstrap still carries no other student (after v3 data)', !JSON.stringify(as(S1, 'bootstrap')).includes('sample.two'));

console.log('v3 self-record skills + report bands + locks');
check('student self-records their own skills', (() => { const r = as(S1, 'saveMySkills', { checkpoint: 'sept', levels: { throw: 3, dribble: 4 } }); return r.ok && r.data.levels.throw === 3; })());
check('self-recorded skill shows on the student\'s own bootstrap', as(S1, 'bootstrap').data.student.combine.skills.dribble.sept === 4);
check('teacher can override a self-recorded skill', (() => { const r = as(T, 'saveSkills', { email: S1, checkpoint: 'sept', levels: { throw: 5 } }); return r.ok && r.data.levels.throw === 5; })());
check('teacher records report bands (1-7)', (() => { const r = as(T, 'saveBands', { email: S1, bands: { knowledge: 5, skills: 5, concept: 4 } }); return r.ok && r.data.bands.knowledge === 5; })());
check('report band outside 1-7 refused', (() => { const r = as(T, 'saveBands', { email: S1, bands: { knowledge: 8 } }); return !r.ok && /1.?7/.test(r.error); })());
check('a student cannot record report bands', (() => { const r = as(S2, 'saveBands', { email: S1, bands: { knowledge: 5 } }); return !r.ok && /teacher/i.test(r.error); })());
check('teacher locks a student checkpoint', (() => { const r = as(T, 'setLock', { emails: [S1], checkpoint: 'sept', locked: true }); return r.ok && r.data.emails.indexOf(S1) !== -1; })());
check('lock shows on the student bootstrap', as(S1, 'bootstrap').data.student.locked.sept === true);
check('locked student cannot edit fitness', (() => { const r = as(S1, 'saveCombine', { checkpoint: 'sept', results: { pushups: 20 } }); return !r.ok && /lock/i.test(r.error); })());
check('locked student cannot self-record skills', (() => { const r = as(S1, 'saveMySkills', { checkpoint: 'sept', levels: { kick: 3 } }); return !r.ok && /lock/i.test(r.error); })());
check('teacher can still edit a locked student', as(T, 'saveSkills', { email: S1, checkpoint: 'sept', levels: { kick: 4 } }).ok === true);
check('classOverview carries lock state', (() => { const r = as(T, 'classOverview'); return r.data.students.some(s => s.locked && s.locked.sept === true); })());
check('a student cannot use setLock', !as(S2, 'setLock', { emails: [S1], checkpoint: 'sept', locked: true }).ok);
check('teacher unlocks the checkpoint', (() => { const r = as(T, 'setLock', { emails: [S1], checkpoint: 'sept', locked: false }); return r.ok && as(S1, 'bootstrap').data.student.locked.sept !== true; })());
check('unlocked student can edit again', as(S1, 'saveCombine', { checkpoint: 'sept', results: { pushups: 20 } }).ok === true);

console.log('fitness save: one bad number does not block the rest');
check('valid results save, out-of-range one is reported', (() => { const r = as(S2, 'saveCombine', { checkpoint: 'jan', results: { pushups: 18, broad: 1.9, sprint: 5.4 } }); return r.ok && r.data.results.pushups === 18 && r.data.results.sprint === 5.4 && r.data.rejected.length === 1 && r.data.rejected[0].key === 'broad'; })());
check('only-bad results still refused', (() => { const r = as(S2, 'saveCombine', { checkpoint: 'jan', results: { broad: 1.9 } }); return !r.ok && /Broad jump/.test(r.error); })());

console.log('AP log: self-checks + teacher rounds');
check('student saves an AP self-check', (() => { const r = as(S1, 'saveApSelf', { ratings: { ready: 6, effort: 5, growth: 4, team: 6, manage: 5 } }); return r.ok && r.data.apLog.self.length === 1 && r.data.apLog.self[0].v.effort === 5; })());
check('same-day self-check replaces, not duplicates', (() => { const r = as(S1, 'saveApSelf', { ratings: { effort: 6 } }); return r.ok && r.data.apLog.self.length === 1 && r.data.apLog.self[0].v.effort === 6 && r.data.apLog.self[0].v.ready === undefined; })());
check('self-check outside 1-7 refused', (() => { const r = as(S1, 'saveApSelf', { ratings: { effort: 9 } }); return !r.ok && /1 to 7/.test(r.error); })());
check('empty self-check refused', !as(S1, 'saveApSelf', { ratings: {} }).ok);
check('a teacher account cannot post a self-check', !as(T, 'saveApSelf', { ratings: { effort: 5 } }).ok);
check('body cannot smuggle a teacher grade or another email', (() => { as(S2, 'saveApSelf', { email: S1, source: 'teacher', round: 's1-mid', ratings: { team: 7 } }); const rows = readTab_('APLog'); return rows.every(r => r.Source === 'self') && rows.filter(r => r.Email === S2).length === 1 && rows.filter(r => r.Email === S1).length === 1; })());
const IMPORT = [
  ['Student name', 'Student ID', 'Student SIS ID', 'Section', 'PE.G6-10.C1: Significance result', 'PE.G6-10.C1: Significance mastery points', 'ATL.SM.manageself result', 'Growthmindset result', 'PE.G6-10.S4 Social skills result', 'ATL.SC.self result', 'PE.G6-10.C10 result'],
  ['Sample One', '1', 'x', '8A', 6, 5, 5, 6, 7, 4, 1],
  ['Sample Two', '2', 'y', '8A', 4, 5, 3, 4.4, 5, 5, 1],
  ['Nobody Here', '3', 'z', '8A', 5, 5, 5, 5, 5, 5, 1],
  ['Sample Jo T', '4', 'w', '8B', '', 5, '', '', '', '', '']
];
const imp = importApRows_(IMPORT, 'S1-mid', 'fitness');
check('Canvas import maps outcomes by name (not C10, not mastery points)', imp.imported === 2 && imp.missing.length === 0 && imp.blank === 1 && imp.unmatched.length === 1);
check('import matched "Two, Sample" by name and rounded 4.4', (() => { const t = readTab_('APLog').filter(r => r.Email === S2 && r.Source === 'teacher'); return t.length === 1 && t[0].Round === 's1-mid' && t[0].growth === 4 && t[0].effort === 4; })());
check('re-importing a round replaces, not duplicates', (() => { importApRows_(IMPORT, 's1-mid', 'fitness'); return readTab_('APLog').filter(r => r.Source === 'teacher').length === 2; })());
check('unknown round refused', (() => { try { importApRows_(IMPORT, 'term3'); return false; } catch (e) { return /Round/.test(e.message); } })());
check('student sees own self-checks + teacher round, latest values merged', (() => { const c = as(S1, 'bootstrap').data.student.combine; return c.apLog.teacher.length === 1 && c.apLog.teacher[0].label === 'S1 mid' && c.apLog.teacher[0].v.team === 7 && c.ap.effort.self === 6 && c.ap.effort.tchr === 6; })());
check('student AP log holds no other student', (() => { const j = JSON.stringify(as(S2, 'bootstrap')); return !j.includes('sample.one') && !j.includes('Sample One'); })());
check('teacher classStudent includes that student\'s AP log', (() => { const r = as(T, 'classStudent', { email: S2 }); return r.ok && r.data.student.apLog.teacher[0].v.growth === 4; })());
check('classOverview uses the latest teacher AP', (() => { const r = as(T, 'classOverview'); const s2 = r.data.students.find(s => s.id === S2); return s2 && s2.ap.growth.tchr === 4; })());

const GRADES = [
  ['Student', 'ID', 'SIS User ID', 'SIS Login ID', 'Integration ID', 'Section', 'Assignment -  Am I an Active Participant in PE? (139255)', 'Assignments Current Points (Semester 1)', 'Current Score (Semester 1)', 'Final Grade (Semester 1)'],
  ['    Points Possible', '', '', '', '', '', 7, '(read only)', '(read only)', '(read only)'],
  ['Made Up Name', '9', 'x', 'SAMPLE.THREE@example.edu', '', '8B', 6, 6, 85.7, 'B'],
  ['Someone Else', '8', 'y', 'nobody@example.edu', '', '8B', 5, 5, 71, 'C']
];
const g = importApRows_(GRADES, 's1-mid', 'fitness');
check('Grades export: AP assignment column imported as overall, matched by SIS Login email', (() => { const t = readTab_('APLog').filter(r => r.Email === S3 && r.Source === 'teacher'); return g.overall === true && g.imported === 1 && t.length === 1 && t[0].overall === 6 && t[0].effort === '' ; })());
check('Grades export: Points Possible row skipped, unknown email not imported', g.unmatched.length === 1 && !readTab_('APLog').some(r => /nobody/.test(r.Email)));
check('overall grade reaches only that student', (() => { const c = as(S3, 'bootstrap').data.student.combine; return c.apLog.teacher[0].v.overall === 6 && !JSON.stringify(as(S1, 'bootstrap')).includes('sample.three'); })());

check('finds an un-renamed Canvas export tab by its headers', (() => { const t = FakeSheets.book.insertSheet('2026-10-21T2014_Grades-Physical_Education_8-Bain'); t.getRange(1, 1, 2, GRADES[0].length).setValues(GRADES.slice(0, 2)); return canvasTab_() === t; })());
check('does not mistake the app\'s own tabs for an export', (() => { FakeSheets.book.sheets = FakeSheets.book.sheets.filter(t => !/Grades-/.test(t.name)); return canvasTab_() === null; })());

const FORM_HDR = ['Timestamp', 'Email Address', 'Lesson', 'First', 'Last', 'x', 'ACT', 'SM', 'GM', 'SA', 'how', 'why', 'goals', 'met', 'metwhy', 'take', 'SOC'];
const FORM = [FORM_HDR,
  [new Date(2026, 8, 3), S2, 'Start of unit', 'A', 'B', '', 'Mostly…', 'Consistently…', 'Sometimes…', 'Mostly…', '', '', '', '', '', '', 'I rarely…'],
  [new Date(2026, 8, 24), S2, 'End of unit', 'A', 'B', '', 'Consistently…', 'Consistently…', 'Mostly…', 'Mostly…', '', '', '', '', '', '', 'Mostly…'],
  [new Date(2026, 8, 24), 'not.on.roster@example.edu', 'End of unit', 'C', 'D', '', 'Mostly…', '', '', '', '', '', '', '', '', '', '']];
const f = importApFormRows_(FORM);
check('form self-ratings import as dated self rows, roster only', (() => { const rows = readTab_('APLog').filter(r => r.Email === S2 && r.Source === 'self' && /2026-09-(03|24)/.test(r.Date)); return f.imported === 2 && f.skipped === 1 && rows.length === 2 && !readTab_('APLog').some(r => /not\.on\.roster/.test(r.Email)); })());
check('form words map to the 1-7 bands', (() => { const st = readTab_('APLog').find(r => r.Email === S2 && r.Date === '2026-09-03'); return st.effort === 5 && st.ready === 7 && st.growth === 3 && st.team === 1; })());
check('re-running the form import does not duplicate', (() => { importApFormRows_(FORM); return readTab_('APLog').filter(r => r.Email === S2 && r.Source === 'self' && /2026-09-(03|24)/.test(r.Date)).length === 2; })());
check('form import refuses a sheet whose column B is not email', (() => { try { importApFormRows_([['Timestamp', 'Name'], [new Date(), 'x']]); return false; } catch (e) { return /email/.test(e.message); } })());
check('student sees form start/end on their own chart', (() => { const c = as(S2, 'bootstrap').data.student.combine; return c.apLog.self.some(e => e.date === '2026-09-03') && c.apLog.self.some(e => e.date === '2026-09-24'); })());

console.log('unit outcomes from Learning Mastery');
const LM = [['Student name', 'Student SIS ID', 'PE.G6-10.K4: Fitness concepts result', 'PE.G6-10.K4: Fitness concepts mastery points', 'PE.G6-10.S3 Strategy result', 'PE.G6-10.C1 result', 'PE.G6-10.S1 result'],
  ['Sample One', 'x', 5, 5, 6.2, 5, 7], ['Sample Two', 'y', 3, 5, '', '', '']];
const lm = importApRows_(LM, 's1-end', 'fitness');
check('Learning Mastery outcome columns import per standard (not mastery points)', (() => { const o = readTab_('Outcomes').filter(r => r.Email === 'sample.one@example.edu'); const by = {}; o.forEach(r => by[r.Outcome] = r.Value); return lm.outcomes.join() === 'K4,S3,C1,S1' && by.K4 === 5 && by.S3 === 6 && by.S1 === 7 && lm.outcomesImported === 2; })());
check('re-import updates outcomes, never duplicates', (() => { importApRows_(LM, 's1-end', 'fitness'); return readTab_('Outcomes').filter(r => r.Email === 'sample.one@example.edu' && r.Outcome === 'K4').length === 1; })());
check('student sees own outcomes only', (() => { const a = as(S1, 'bootstrap').data.student.combine.outcomes, b = as(S2, 'bootstrap').data.student.combine.outcomes; return a.S3 === 6 && b.K4 === 3 && b.S3 === undefined && !JSON.stringify(as(S2, 'bootstrap')).includes('sample.one'); })());

check('outcomes are labelled with the unit given', readTab_('Outcomes').filter(r => r.Email === 'sample.one@example.edu').every(r => r.Unit === 'fitness'));
check('without a unit, the date picks it', unitForDate_('2026-10-20') === 'fitness' && unitForDate_('2026-12-01') === 'badminton');
const LM2 = [['Student name', 'PE.G6-10.K4 result', 'PE.G6-10.S3 result'], ['Sample One', 6, 7]];
importApRows_(LM2, 's1-end', 'Badminton');
check('a later unit adds a step, never overwrites the earlier unit', (() => { const k4 = readTab_('Outcomes').filter(r => r.Email === 'sample.one@example.edu' && r.Outcome === 'K4'); return k4.length === 2 && k4.some(r => r.Unit === 'fitness' && r.Value === 5) && k4.some(r => r.Unit === 'badminton' && r.Value === 6); })());
check('latest unit wins, and the story is in year order', (() => { const c = as(S1, 'bootstrap').data.student.combine; const k4 = c.outcomeLog.filter(x => x.code === 'K4'); return c.outcomes.K4 === 6 && c.outcomes.S3 === 7 && k4.length === 2 && k4[0].unit === 'fitness' && k4[1].unit === 'badminton' && c.outcomes.C1 === 5; })());
check('unknown unit refused', (() => { try { importApRows_(LM2, 's1-end', 'netball'); return false; } catch (e) { return /Unit/.test(e.message); } })());
check('an old row with no unit sorts first and still counts', (() => { upsert_('Outcomes', { Email: 'sample.one@example.edu', Outcome: 'S2', Unit: '' }, { Value: 4, Updated: '2026-09-01' }); const c = as(S1, 'bootstrap').data.student.combine; return c.outcomes.S2 === 4 && c.outcomeLog[0].code === 'S2' && c.outcomeLog[0].unit === ''; })());
check('a student\'s outcome story holds only their own rows', (() => { const l = as(S2, 'bootstrap').data.student.combine.outcomeLog; return l.some(x => x.code === 'K4' && x.v === 3) && !l.some(x => x.unit === 'badminton' || x.code === 'S3' || x.code === 'S2'); })());

console.log('teacher assessment view');
check('student saves a plan with whys, a 4-part reflection and a logged number', (() => { const plan = { v: 3, warmup: [{ n: 'Light jog', min: 3, int: 'easy' }], cardio: [], strength: [], focus: [], cooldown: [], why: { warmup: 'raise my heart rate' }, ref: { strength: 'push-ups 18', worked: 'yes', change: 'more sets', matters: 'rugby' }, log: [{ date: '2026-10-27', who: 'me', where: 'home', feel: 'ok', num: '22 push-ups' }] };
  const r = as(S2, 'savePlan', { plan }); return r.ok && r.data.plan.ref.worked === 'yes' && r.data.plan.log.some(e => e.num === '22 push-ups'); })());
check('teacher classStudent includes that student\'s plan and goals', (() => { const r = as(T, 'classStudent', { email: S2 }); return r.ok && r.data.student.plan.why.warmup === 'raise my heart rate' && Array.isArray(r.data.student.goals.items); })());
check('a student cannot open another student\'s plan', (() => { const r = as(S1, 'classStudent', { email: S2 }); return !r.ok && /teacher/i.test(r.error); })());
check('student bootstrap does not include another student\'s plan', !JSON.stringify(as(S1, 'bootstrap')).includes('raise my heart rate'));

console.log('Printable workout cards (teacher only)');
check('a teacher gets the class\'s cards: names, parts and "how" lines', (() => { const r = as(T, 'classPlans', { klass: '8A' }); const two = r.ok && r.data.students.find(s => s.name === 'Two, Sample'); return r.ok && r.data.students.length > 0 && two && two.plan && two.plan.why.warmup === 'raise my heart rate' && Array.isArray(two.goals); })());
check('cards carry no session log, reflection or email', (() => { const j = JSON.stringify(as(T, 'classPlans', { klass: '8A' }).data); return !/"log"|"ref"|reflection|@example\.edu|22 push-ups/.test(j); })());
check('only the chosen class is returned', (() => { const r = as(T, 'classPlans', { klass: '8A' }); return r.ok && r.data.students.every(s => s.klass === '8A') && !r.data.students.some(s => s.name === 'T, Sample Jo'); })());
check('a student cannot print a class\'s cards', (() => { const r = as(S1, 'classPlans', { klass: '8A' }); return !r.ok && /teacher/i.test(r.error); })());
console.log('Health lesson class overview (teacher only)');
check('a student who saves a lesson keeps it with the plan', (() => { const r = as(S2, 'savePlan', { plan: { v: 4, warmup: [], cardio: [], strength: [], focus: [], cooldown: [], log: [{ id: 'hl1', date: '2026-10-30', where: 'class', who: 'me', chg: 'more rest' }, { id: 'hl2', date: '2026-11-01', where: 'home', who: 'me', chg: '' }, { id: 'hl0', date: '2026-10-01', where: 'home', who: 'me', chg: 'old' }], lessons: { train: { step: 5, done: '2026-11-03', score: 4, feel: 'ok', logAll: true, quiz: { 0: 1 }, qs: [[0, 2, [1, 0, 2]]], ex: 'Squats', how: 'I', now: '3 × 10', next: '3 × 12', rest: ['sleep'], prin: 'progression', exit: 'Squats are easy now so I add reps.' } } } }); return r.ok && r.data.plan.lessons.train.score === 4; })());
check('a teacher gets the class lesson overview in one call', (() => { const r = as(T, 'classLessons', { klass: '8A' }); const two = r.ok && r.data.students.find(s => s.name === 'Two, Sample'); return r.ok && two && two.plan.lessons.train.done === '2026-11-03' && two.plan.lessons.train.exit.indexOf('Squats') === 0 && two.logSum.pe >= 1 && two.logSum.home >= 1 && two.logSum.chg >= 1 && two.logSum.chg < two.logSum.pe + two.logSum.home; })());
check('the overview carries no session log, reflection or goal note', (() => { const j = JSON.stringify(as(T, 'classLessons', { klass: '8A' }).data); return !/"log"|"ref"|reflection|more rest|"note"/.test(j); })());
check('the overview can show all classes', (() => { const r = as(T, 'classLessons', { klass: 'all' }); return r.ok && r.data.students.some(s => s.klass === '8A') && r.data.students.some(s => s.klass !== '8A'); })());
check('a student cannot read the class lesson overview', (() => { const r = as(S1, 'classLessons', { klass: '8A' }); return !r.ok && /teacher/i.test(r.error); })());
check('classLessons needs a real class', !as(T, 'classLessons', { klass: '' }).ok && !as(T, 'classLessons', { klass: 'nope' }).ok);
check('classPlans needs a real class', !as(T, 'classPlans', { klass: '' }).ok && !as(T, 'classPlans', { klass: 'nope' }).ok);

console.log('summative assessment on the dashboard (teacher only)');
check('a teacher saves a student\'s workout ratings', (() => { const r = as(T, 'saveAssess', { email: S2, task: 'workout', scores: { k4: 5, s2: 6, sm: '' }, note: 'Good how-lines' }); return r.ok && r.data.scores.k4 === 5 && r.data.scores.s2 === 6 && !('sm' in r.data.scores); })());
check('saving again updates the same row', (() => { as(T, 'saveAssess', { email: S2, task: 'workout', scores: { k4: 6, s2: 6, sm: 7 }, note: 'Good how-lines' }); return readTab_('Assess').filter(r => lower_(r.Email) === S2).length === 1; })());
check('classAssess returns ratings, note and an evidence summary', (() => { const r = as(T, 'classAssess', { klass: '8A', task: 'workout' }); const two = r.ok && r.data.students.find(s => s.name === 'Two, Sample'); return r.ok && two.scores.k4 === 6 && two.scores.sm === 7 && two.note === 'Good how-lines' && two.ev && typeof two.ev.parts === 'number' && two.ev.home >= 1 && two.updated.length === 10; })());
check('classAssess can show all classes', (() => { const r = as(T, 'classAssess', { klass: 'all' }); return r.ok && r.data.students.some(s => s.klass === '8A') && r.data.students.some(s => s.klass !== '8A'); })());
check('a student cannot read the assessments', (() => { const r = as(S1, 'classAssess', { klass: '8A' }); return !r.ok && /teacher/i.test(r.error); })());
check('a student cannot save an assessment (not even their own)', (() => { const r = as(S1, 'saveAssess', { email: S1, task: 'workout', scores: { k4: 7 } }); return !r.ok && /teacher/i.test(r.error) && !readTab_('Assess').some(x => lower_(x.Email) === S1); })());
check('the student\'s own profile never includes the ratings', !/Good how-lines|"Assess"/.test(JSON.stringify(as(S2, 'bootstrap').data)));
check('ratings must be whole numbers 1–7', !as(T, 'saveAssess', { email: S2, scores: { k4: 8 } }).ok && !as(T, 'saveAssess', { email: S2, scores: { k4: 4.5 } }).ok && !as(T, 'saveAssess', { email: S2, scores: { k4: 0 } }).ok);
check('saveAssess refuses someone not on the class list, an unknown task, a long note', !as(T, 'saveAssess', { email: 'nobody@example.edu', scores: { k4: 5 } }).ok && !as(T, 'saveAssess', { email: S2, task: 'essay', scores: { k4: 5 } }).ok && !as(T, 'saveAssess', { email: S2, scores: { k4: 5 }, note: 'x'.repeat(301) }).ok);
check('classAssess (workout) carries each plan, reflection and log for one-by-one marking, and no other fields', (() => { const r = as(T, 'classAssess', { klass: '8A', task: 'workout' }); const two = r.data.students.find(s => s.name === 'Two, Sample'); const w = two.work; return w && Array.isArray(w.log) && w.log.length >= 1 && typeof w.ref === 'object' && Array.isArray(w.warmup) && typeof w.why === 'object' && Array.isArray(two.goals) && !('equip' in w) && !('days' in w) && !('lessons' in w); })());
check('a student cannot read the class workout evidence', (() => { const r = as(S1, 'classAssess', { klass: '8A', task: 'workout' }); return !r.ok && /teacher/i.test(r.error); })());
check('assessment errors contain no email', ['nobody@example.edu'].every(e => !String(as(T, 'saveAssess', { email: e, scores: { k4: 5 } }).error).includes('@')));
check('a workout-day flag saves, keeps the ratings, and the day is set once', (() => { const r = as(T, 'saveAssess', { email: S2, task: 'workout', scores: { k4: 6, s2: 6, sm: 7 }, note: 'Good how-lines', flag: 'lead' }); const two = as(T, 'classAssess', { klass: '8A' }).data.students.find(s => s.sid === S2); return r.ok && two.flag === 'lead' && two.scores.sm === 7 && /^\d{4}-\d{2}-\d{2}$/.test(two.day) && 'planDay' in two && 'ap' in two; })());
check('the workout-quality (K4) flag saves separately from the training flag', (() => { as(T, 'saveAssess', { email: S2, scores: { k4: 6, s2: 6, sm: 7 }, flag: 'got', flagK4: 'ny' }); const two = as(T, 'classAssess', { klass: '8A' }).data.students.find(s => s.sid === S2); return two.flag === 'got' && two.flagK4 === 'ny' && !as(T, 'saveAssess', { email: S2, scores: {}, flagK4: 'x' }).ok; })());
check('an old 🌟/⚠ flag in the Sheet reads as a band', (() => { const sh = ensureTab_('Assess', TABS.Assess), h = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0], rows = sh.getRange(2, 1, sh.getLastRow() - 1, h.length).getValues(), ri = rows.findIndex(r => lower_(r[h.indexOf('Email')]) === S2); sh.getRange(ri + 2, h.indexOf('Flag') + 1, 1, 1).setValues([['up']]); sh.getRange(ri + 2, h.indexOf('FlagK4') + 1, 1, 1).setValues([['down']]); const two = as(T, 'classAssess', { klass: '8A' }).data.students.find(s => s.sid === S2); return two.flag === 'lead' && two.flagK4 === 'ap'; })());
check('a bad flag is refused; an empty flag clears it', !as(T, 'saveAssess', { email: S2, scores: {}, flag: 'sideways' }).ok && as(T, 'saveAssess', { email: S2, scores: {}, flag: '' }).ok && as(T, 'classAssess', { klass: '8A' }).data.students.find(s => s.sid === S2).flag === '');
check('saveAssessMany saves several students in one call', (() => { const r = as(T, 'saveAssessMany', { task: 'workout', rows: [{ email: S2, scores: { k4: 4 }, flag: 'got', flagK4: 'ap', note: 'n2' }, { email: S1, scores: {}, flag: 'lead' }] }); const st = as(T, 'classAssess', { klass: 'all' }).data.students; const two = st.find(s => s.sid === S2), one = st.find(s => s.sid === S1); return r.ok && r.data.saved === 2 && r.data.results.every(x => x.ok) && two.scores.k4 === 4 && two.flag === 'got' && two.flagK4 === 'ap' && two.note === 'n2' && one.flag === 'lead' && /^\d{4}-/.test(one.day) && readTab_('Assess').filter(x => lower_(x.Email) === S2).length === 1; })());
check('saveAssessMany: one bad row does not block the others', (() => { const r = as(T, 'saveAssessMany', { rows: [{ email: S2, scores: { k4: 9 } }, { email: 'nobody@example.edu', scores: {} }, { email: S1, scores: { s2: 5 } }] }); return r.ok && r.data.saved === 1 && !r.data.results[0].ok && !r.data.results[1].ok && r.data.results[2].ok && as(T, 'classAssess', { klass: 'all' }).data.students.find(s => s.sid === S1).scores.s2 === 5 && r.data.results.every(x => !x.error || !x.error.includes('@')); })());
check('a student cannot use saveAssessMany', (() => { const r = as(S1, 'saveAssessMany', { rows: [{ email: S1, scores: { k4: 7 } }] }); return !r.ok && /teacher/i.test(r.error); })());
check('saveAssessMany refuses an empty or oversized batch', !as(T, 'saveAssessMany', { rows: [] }).ok && !as(T, 'saveAssessMany', { rows: Array(61).fill({ email: S2, scores: {} }) }).ok);
check('badminton: saveAssessMany saves the four marks and the live bands', (() => { const r = as(T, 'saveAssessMany', { task: 'badminton', rows: [{ email: S1, scores: { serve: 5, rally: 4, move: 6, part: 7 }, live: { serve: 'got', part: 'lead' }, note: 'b1' }] }); const one = as(T, 'classAssess', { klass: 'all', task: 'badminton' }).data.students.find(s => s.sid === S1); return r.ok && r.data.saved === 1 && one.scores.serve === 5 && one.scores.part === 7 && one.live.serve === 'got' && one.live.part === 'lead' && !one.live.rally && one.note === 'b1'; })());
check('badminton marks live in their own row: the workout row is untouched', (() => { const w = as(T, 'classAssess', { klass: 'all', task: 'workout' }).data.students.find(s => s.sid === S1); return w.scores.s2 === 5 && !('serve' in w.scores) && readTab_('Assess').filter(x => lower_(x.Email) === S1).length === 2; })());
check('badminton: a bad band or rating is refused, an empty band clears it', (() => { const bad = as(T, 'saveAssessMany', { task: 'badminton', rows: [{ email: S1, scores: { serve: 8 } }, { email: S1, scores: {}, live: { serve: 'wow' } }] }); as(T, 'saveAssessMany', { task: 'badminton', rows: [{ email: S1, scores: { serve: 5, rally: 4, move: 6, part: 7 }, live: { serve: '', part: 'lead' } }] }); const one = as(T, 'classAssess', { klass: 'all', task: 'badminton' }).data.students.find(s => s.sid === S1); return bad.ok && bad.data.saved === 0 && !one.live.serve && one.live.part === 'lead'; })());
check('badminton: the teacher sees the practice check (levels, focus), out-of-range levels dropped', (() => { const d = as(T, 'classAssess', { klass: 'all', task: 'badminton' }).data, one = d.students.find(s => s.sid === S1); return d.keys.join() === 'serve,rally,move,part' && one.check && one.check.levels.join() === '2,3,2,' && one.check.focus === 'move my opponent' && d.students.some(s => s.check === null); })());
check('badminton: a student cannot read the class practice checks or marks', (() => { const r = as(S1, 'classAssess', { klass: 'all', task: 'badminton' }), w = as(S1, 'saveAssessMany', { task: 'badminton', rows: [{ email: S1, scores: { serve: 7 } }] }); return !r.ok && /teacher/i.test(r.error) && !w.ok && /teacher/i.test(w.error); })());
check('badminton: the student profile never includes the marks or live bands', !/"live"|"serve":5|b1/.test(JSON.stringify(as(S1, 'bootstrap').data)));
check('classAssess needs a real class', !as(T, 'classAssess', { klass: '' }).ok && !as(T, 'classAssess', { klass: 'nope' }).ok);

console.log('AP check-out (teacher iPad → APLog)');
const TODAY = ymd_(new Date());
const ago = n => daysAgoYmd_(n);
const errs = [];
const refused = (r, re) => { if (r && r.error) errs.push(r.error); return !!r && !r.ok && (!re || re.test(r.error)); };
const apRows = () => readTab_('APLog');
const addAp = (email, date, src, focus, n, word) => { const sh = ensureTab_('APLog', TABS.APLog), h = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0], row = h.map(() => ''); const set = (k, v) => { row[h.indexOf(k)] = v; }; set('Email', email); set('Date', date); set('Source', src); set(focus, n); if (word) set('Word', word); sh.getRange(sh.getLastRow() + 1, 1, 1, row.length).setValues([row]); };
const canvasBefore = JSON.stringify(apRows().filter(r => r.Source === 'teacher'));
const ok1 = { email: S1, focus: 'team', who: 'self', rating: 5, word: 'Tried my best' };
const nRows0 = apRows().length;
check('a student cannot load the check-out roster', refused(as(S2, 'checkoutRoster', { klass: '8A' }), /teacher/i));
check('a student cannot save a check-in (not even their own)', refused(as(S2, 'saveCheckin', Object.assign({}, ok1, { email: S2 })), /teacher/i));
check('wrong domain / no token cannot save a check-in', refused(as('x@gmail.example', 'saveCheckin', ok1), /teacher/i) && authErr(post('saveCheckin', ok1, '')));
check('teacher saveCheckin for an email not on the roster is refused', refused(as(T, 'saveCheckin', Object.assign({}, ok1, { email: 'ghost@example.edu' })), /class list/));
check('missing student refused', refused(as(T, 'saveCheckin', Object.assign({}, ok1, { email: '' })), /Missing student/));
[0, 8, 4.5, 'x', '', null, true, '4.0', -1].forEach(v => check('rating ' + JSON.stringify(v) + ' refused', refused(as(T, 'saveCheckin', Object.assign({}, ok1, { rating: v })), /Rating/)));
check('word not on the list refused', refused(as(T, 'saveCheckin', Object.assign({}, ok1, { word: 'Was amazing' })), /Unknown word/));
check('word must match the list exactly (no free text)', refused(as(T, 'saveCheckin', Object.assign({}, ok1, { word: 'tried my best ' })), /Unknown word/) && refused(as(T, 'saveCheckin', Object.assign({}, ok1, { word: ['Tried my best'] })), /Unknown word/));
check('focus not in AP_KEYS refused', refused(as(T, 'saveCheckin', Object.assign({}, ok1, { focus: 'speed' })), /Unknown focus/) && refused(as(T, 'saveCheckin', Object.assign({}, ok1, { focus: 'overall' })), /Unknown focus/));
check('who other than self/teacher refused (no way to write a Canvas row)', ['peer', 'lesson', 'canvas', 'constructor', 'hasOwnProperty'].every(w => refused(as(T, 'saveCheckin', Object.assign({}, ok1, { who: w })), /Unknown rater/)));
check('nothing written by refused calls', apRows().length === nRows0);
check('kiosk tap → {ok, date: server today}', (() => { const r = as(T, 'saveCheckin', Object.assign({}, ok1, { date: '1999-01-01' })); return r.ok && r.data.date === TODAY; })());
check('the tap joins the student\'s self-check for today (one self row; earlier keys kept)', (() => { const rows = apRows().filter(r => r.Email === S1 && r.Source === 'self' && r.Date === TODAY); return rows.length === 1 && rows[0].team === 5 && rows[0].effort === 6 && rows[0].Word === 'Tried my best'; })());
check('teacher lesson rating is stored as its own kind (Source "lesson"), body cannot make it Canvas', (() => {
  as(T, 'saveCheckin', { email: S1, focus: 'team', who: 'teacher', rating: '6', word: '', source: 'teacher', Source: 'teacher', round: 's1-mid', Round: 's1-mid', date: '2026-01-01' });
  const l = apRows().filter(r => r.Email === S1 && r.Source === 'lesson');
  return l.length === 1 && l[0].team === 6 && l[0].Round === '' && l[0].Date === TODAY;
})());
check('Canvas grades untouched by check-outs', JSON.stringify(apRows().filter(r => r.Source === 'teacher')) === canvasBefore);
check('lesson ratings never count as the Canvas teacher grade', (() => { const c = as(S1, 'bootstrap').data.student.combine, canvasTeam = c.apLog.teacher.filter(t => t.v.team != null).map(t => t.v.team).pop(); return c.apLog.teacher.every(t => ['s1-mid', 's1-end', 's2-mid', 's2-end'].indexOf(t.round) !== -1) && c.ap.team.tchr === canvasTeam && canvasTeam !== 6 && c.apLog.lesson.length === 1 && c.apLog.lesson[0].v.team === 6; })());
check('word may be skipped (missing → blank)', (() => { const r = as(T, 'saveCheckin', { email: S3, focus: 'growth', who: 'self', rating: 3 }); return r.ok && apRows().find(x => x.Email === S3 && x.Source === 'self' && x.Date === TODAY).Word === ''; })());
check('re-tap same student/focus/who/day → one row, updated value', (() => {
  as(T, 'saveCheckin', Object.assign({}, ok1, { rating: 7, word: 'Stayed focused' }));
  const rows = apRows().filter(r => r.Email === S1 && r.Source === 'self' && r.Date === TODAY);
  return rows.length === 1 && rows[0].team === 7 && rows[0].Word === 'Stayed focused';
})());
check('re-tap still one row when Sheets stored the date as a Date (fixes same-day self-checks too)', (() => {
  const sh = FakeSheets.book.getSheetByName('APLog'), h = sh.rows[0], i = sh.rows.findIndex(r => r[h.indexOf('Email')] === S1 && r[h.indexOf('Source')] === 'self' && r[h.indexOf('Date')] === TODAY);
  const p = TODAY.split('-').map(Number); sh.rows[i][h.indexOf('Date')] = new Date(p[0], p[1] - 1, p[2]);
  as(T, 'saveCheckin', Object.assign({}, ok1, { rating: 3 }));
  return apRows().filter(r => r.Email === S1 && r.Source === 'self' && r.Date === TODAY).length === 1;
})());
check('own-device self-checks also stay one row a day when the date cell is a Date', (() => {
  as(S3, 'saveApSelf', { ratings: { effort: 5 } });
  const sh = FakeSheets.book.getSheetByName('APLog'), h = sh.rows[0], i = sh.rows.findIndex(r => r[h.indexOf('Email')] === S3 && r[h.indexOf('Source')] === 'self' && r[h.indexOf('Date')] === TODAY);
  const p = TODAY.split('-').map(Number); sh.rows[i][h.indexOf('Date')] = new Date(p[0], p[1] - 1, p[2]);
  as(S3, 'saveApSelf', { ratings: { effort: 6 } });
  return apRows().filter(r => r.Email === S3 && r.Source === 'self' && r.Date === TODAY).length === 1;
})());
check('a save reads only the key columns (Email · Date · Source), not the whole tab', (() => {
  const sh = FakeSheets.book.getSheetByName('APLog'), g = sh.getRange.bind(sh); let widest = 0;
  sh.getRange = (r, c, nr, nc) => { if ((nr || 1) > 1) widest = Math.max(widest, nc || 1); return g(r, c, nr, nc); };
  const r = as(T, 'saveCheckin', { email: S3, focus: 'ready', who: 'teacher', rating: 4 }); sh.getRange = g;
  return r.ok && widest === 3;
})());
check('owner (student + teacher) can run the kiosk', as(OWNER, 'saveCheckin', { email: S2, focus: 'manage', who: 'self', rating: 1, word: 'Lost focus' }).ok === true);
check('student sees their own word on their self-check', as(S2, 'bootstrap').data.student.combine.apLog.self.some(e => e.date === TODAY && e.word === 'Lost focus'));
check('student bootstrap never carries another student\'s check-ins', !JSON.stringify(as(S2, 'bootstrap')).includes('sample.one') && !JSON.stringify(as(S1, 'bootstrap')).includes('sample.two') && !as(S2, 'bootstrap').data.student.combine.apLog.lesson.length);

// spotlight: a third class with seven students and a known lesson-rating history
const stTab = FakeSheets.book.getSheetByName('Students');
const C = n => 'c' + n + '@example.edu';
stTab.getRange(stTab.getLastRow() + 1, 1, 7, 3).setValues([
  [C(1), 'Gee, Ann', '8C'], [C(2), 'Fox, Ben', '8C'], [C(3), 'Eve Cole', '8C'], [C(4), 'Dee Dunn', '8C'],
  [C(5), 'Zed, Ann', '8C'], [C(6), 'Zed, Bob', '8C'], [C(7), 'Alpha, Cy', '8C']
]);
const D = n => 'd' + n + '@example.edu';
stTab.getRange(stTab.getLastRow() + 1, 1, 6, 4).setValues([
  [D(1), 'L, Juho', '8D', ''], [D(2), 'L2, Juho', '8D', ''], [D(3), 'Ko, Mia', '8D', ''], [D(4), 'Ko, Mia', '8D', ''], [D(5), 'Z, F', '8D', 'Felix Z'], [D(6), 'Avery, Sam', '8D', '']
]);
const rosterCount = readTab_('Students').length;
addAp(C(1), ago(2), 'lesson', 'team', 5); addAp(C(1), ago(9), 'lesson', 'ready', 5);
addAp(C(2), ago(5), 'lesson', 'team', 5);
addAp(C(3), ago(10), 'lesson', 'team', 5);
addAp(C(4), ago(40), 'lesson', 'team', 5);
addAp(C(5), ago(1), 'self', 'team', 7); addAp(C(5), ago(2), 'self', 'team', 7);
addAp(C(6), ago(3), 'teacher', 'team', 2); // a Canvas-style row must not count as a lesson rating
addAp(C(7), ago(1), 'lesson', 'team', 5); addAp(C(7), ago(3), 'lesson', 'team', 5); addAp(C(7), ago(4), 'lesson', 'team', 5);
const roster = as(T, 'checkoutRoster', { klass: '8c', focus: 'effort' });
check('checkoutRoster returns the requested class only', roster.ok && roster.data.klass === '8C' && roster.data.students.length === 7 && roster.data.students.every(s => /^c\d@/.test(s.email)), roster);
check('checkoutRoster never returns ratings', !/rating|avg|"v"|"word"/i.test(JSON.stringify(roster.data).replace(/"words":\[[^\]]*\]/, '')));
check('roster rows are {email, first, lastInitial, doneToday:{self,teacher}}', roster.data.students.every(s => Object.keys(s).sort().join() === 'doneToday,email,first,lastInitial' && typeof s.doneToday.self === 'boolean'));
check('names: "Last, First" and "First Last" → first + last initial', (() => { const by = e => roster.data.students.find(s => s.email === e); return by(C(1)).first === 'Ann' && by(C(1)).lastInitial === 'G' && by(C(3)).first === 'Eve' && by(C(3)).lastInitial === 'C'; })());
check('two students with the same first name + initial get different buttons', (() => { const st = as(T, 'checkoutRoster', { klass: '8D' }).data.students, lab = x => x.first + ' ' + x.lastInitial, by = e => st.find(x => x.email === e); return lab(by(D(1))) === 'Juho L' && lab(by(D(2))) === 'Juho L2' && lab(by(D(3))) !== lab(by(D(4))) && new Set(st.map(lab)).size === st.length && lab(by(D(6))) === 'Sam A'; })());
check('"Known as" replaces the roster name on the check-out and the dashboards', (() => { const k = as(T, 'checkoutRoster', { klass: '8D' }).data.students.find(x => x.email === D(5)); const a = as(T, 'classAssess', { klass: '8D' }).data.students.find(x => x.sid === D(5)); return k.first === 'Felix Z' && k.lastInitial === '' && a.name === 'Felix Z'; })());
check('a student greeted by their "Known as"', as(D(5), 'bootstrap').data.student.first === 'Felix');
check('checkoutRoster carries the word list and server date', JSON.stringify(roster.data.words) === JSON.stringify(CHECKIN_WORDS) && roster.data.date === TODAY);
check('spotlight: fewest lesson ratings (30 d) → oldest last → alphabetical; self taps and Canvas rows ignored', JSON.stringify(roster.data.spotlight) === JSON.stringify([C(5), C(6), C(4), C(3), C(2)]), roster.data.spotlight);
check('doneToday reflects today for the chosen focus', (() => {
  const a = as(T, 'checkoutRoster', { klass: '8A', focus: 'team' }).data.students, b = as(T, 'checkoutRoster', { klass: '8A', focus: 'growth' }).data.students;
  const s1a = a.find(s => s.email === S1), s2a = a.find(s => s.email === S2), s1b = b.find(s => s.email === S1);
  return s1a.doneToday.self && s1a.doneToday.teacher && s2a.doneToday.self && !s2a.doneToday.teacher && !s1b.doneToday.self && !s1b.doneToday.teacher;
})());
check('checkoutRoster without a class → class list only', (() => { const r = as(T, 'checkoutRoster', {}).data; return r.students.length === 0 && JSON.stringify(r.classes) === '["8A","8B","8C","8D"]'; })());
check('checkoutRoster for an unknown class refused', refused(as(T, 'checkoutRoster', { klass: '9Z' }), /No students/));
check('classOverview: per-student checkinSummary of self + lesson (never Canvas)', (() => {
  const st = as(T, 'classOverview').data.students, s1 = st.find(x => x.id === S1).checkinSummary, c6 = st.find(x => x.id === C(6)).checkinSummary, c5 = st.find(x => x.id === C(5)).checkinSummary;
  return s1.team.selfN === 1 && s1.team.selfAvg === 3 && s1.team.lessonN === 1 && s1.team.lessonAvg === 6 && s1.team.last === TODAY && !c6.team && c5.team.selfAvg === 7 && c5.team.lessonAvg === null;
})());
check('classAssess shows the AP check-outs (effort + manage) from the training lessons, only where they exist', (() => { addAp(C(2), TODAY, 'lesson', 'effort', 6); addAp(C(2), TODAY, 'self', 'manage', 4); addAp(C(3), '2026-10-01', 'lesson', 'effort', 2); const st = as(T, 'classAssess', { klass: 'all' }).data.students; const c2 = st.find(x => x.sid === C(2)), c3 = st.find(x => x.sid === C(3)); return c2.ap && c2.ap.lessonAvg === 6 && c2.ap.selfAvg === 4 && c3.ap === null && st.some(x => x.ap === null); })());
check('check-out error messages contain no email', errs.length > 10 && errs.every(e => !e.includes('@')), errs.filter(e => e.includes('@')));

console.log('retention');
FakeSheets.uiAnswer = 'YES';
clearProfileData();
check('clearProfileData empties all student data, keeps Students', readTab_('Profile').length === 0 && readTab_('Predictions').length === 0 && readTab_('Combine').length === 0 && readTab_('Skills').length === 0 && readTab_('Goals').length === 0 && readTab_('Plan').length === 0 && readTab_('Reflections').length === 0 && readTab_('APLog').length === 0 && readTab_('Outcomes').length === 0 && readTab_('Assess').length === 0 && readTab_('Students').length === rosterCount);
check('retention clears check-outs (they live in APLog)', JSON.stringify(as(S1, 'bootstrap').data.student.combine) === 'null' || as(S1, 'bootstrap').data.student.combine.apLog.lesson.length === 0);

console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed');
process.exit(failed ? 1 : 0);
