#!/usr/bin/env node
// Headless Chromium run of the AP check-out on dev/preview.html: teacher setup,
// the student kiosk (name → 1–7 → word), hold-to-exit, spotlight, the teacher
// summary and the student's own trend. Synthetic data only; shots in dev/shots/.
//   node dev/build-preview.js && NODE_PATH=$(npm root -g) node dev/smoke-checkout.js
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');
const root = path.join(__dirname, '..');
const url = q => 'file://' + path.join(root, 'dev/preview.html') + '?reset=1&latency=20&' + q;
const shots = path.join(root, 'dev/shots'); fs.mkdirSync(shots, { recursive: true });

(async () => {
  let failed = 0;
  const check = (name, ok, extra) => { console.log((ok ? '  ✓ ' : '  ✗ ') + name + (ok ? '' : ' ' + (extra || ''))); if (!ok) failed++; };
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.route('https://lh3.googleusercontent.com/**', r => r.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg"/>' }));
  const noHScroll = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

  await page.goto(url('role=teacher'));
  await page.waitForSelector('#tocheckout');
  check('teacher landing has the AP Check-out button', (await page.textContent('#tocheckout')).includes('AP Check-out'));
  await page.click('#tocheckout'); await page.waitForSelector('[data-coclass]');
  check('setup lists the classes', (await page.$$('[data-coclass]')).length === 2);
  check('start is disabled until class + focus are picked', await page.isDisabled('#cokiosk'));
  await page.click('[data-coclass="8A"]'); await page.waitForSelector('.co-count');
  await page.click('[data-cofocus="effort"]'); await page.waitForSelector('#cokiosk:not([disabled])');
  check('focus cards carry the rubric criterion and code', (await page.textContent('[data-cofocus="effort"]')).includes('PE.G6-10.C1'));
  await page.screenshot({ path: path.join(shots, 'checkout-setup.png'), fullPage: true });

  await page.click('#cokiosk'); await page.waitForSelector('.ko-name');
  check('kiosk shows the class as first name + last initial', (await page.$$eval('.ko-name', b => b.map(x => x.textContent))).every(t => /^\S+ [A-Z]\.$/.test(t.trim())));
  check('kiosk shows no ratings', !/\b[1-7]\b/.test(await page.textContent('.ko-names')));
  await page.click('.ko-name >> nth=0'); await page.waitForSelector('.ko-band');
  check('rating screen: four levels in words, with the student "I…" wording', (await page.$$('.ko-band')).length === 4 && (await page.textContent('.ko-bands')).includes('Got it') && (await page.textContent('.ko-bands')).includes('I participate actively'));
  check('students see no numbers on the rating screen', !/\d/.test(await page.textContent('.ko-bands')));
  await page.screenshot({ path: path.join(shots, 'checkout-rate.png'), fullPage: true });
  await page.click('[data-kback]'); await page.waitForSelector('.ko-name');
  check('"Not me" goes back to the names', true);
  await page.click('.ko-name >> nth=0'); await page.click('[data-rate="5"]'); await page.waitForSelector('.ko-w');
  check('word screen offers the 8 words and Skip', (await page.$$('.ko-w')).length === 8 && (await page.$$('[data-word="skip"]')).length === 1);
  await page.click('.ko-w >> nth=1'); await page.waitForSelector('.ko-thanks');
  check('thanks screen shows no rating', !/[1-7]/.test(await page.textContent('.ko-thanks')));
  await page.waitForSelector('.ko-name.done', { timeout: 5000 });
  check('saved student gets a ✓ on the name grid', (await page.$$('.ko-name.done')).length === 1);
  await page.click('.ko-name >> nth=1'); await page.click('[data-rate="3"]'); await page.click('[data-word="skip"]');
  await page.waitForFunction(() => document.querySelectorAll('.ko-name.done').length === 2, null, { timeout: 5000 });
  check('skip saves without a word', true);
  await page.click('#kohold'); await page.waitForTimeout(400);
  check('a tap on Teacher does not leave the kiosk', (await page.$$('.ko-name')).length > 0);
  const box = await page.locator('#kohold').boundingBox();
  await page.mouse.move(box.x + 5, box.y + 5); await page.mouse.down(); await page.waitForTimeout(1100); await page.mouse.up();
  await page.waitForSelector('#cospot');
  check('press-and-hold returns to setup with the server count', (await page.textContent('.co-count')).includes('2 checked out'));

  await page.click('#cospot'); await page.waitForSelector('.sp-row');
  check('spotlight lists the class (≤5 up front)', (await page.$$('.sp-row')).length >= 1 && (await page.$$('.sp-row')).length <= 5);
  await page.click('.sp-row >> nth=0 >> [data-sprate="5"]');
  await page.waitForSelector('.sp-st:has-text("saved")');
  check('teacher rating saves and shows the band descriptor', (await page.textContent('.sp-row >> nth=0')).includes('Got it'));
  await page.screenshot({ path: path.join(shots, 'checkout-spotlight.png'), fullPage: true });

  await page.click('#spback'); await page.waitForSelector('#coback'); await page.click('#coback');
  await page.waitForSelector('#toclass'); await page.click('#toclass'); await page.waitForSelector('#toapsum');
  check('class dashboard has the check-out entry', (await page.$$('#tocheckout2')).length === 1);
  await page.click('#toapsum'); await page.waitForSelector('.aps');
  check('AP summary shows band words and averages', /Not yet|Approaching|Got it|Leading/.test(await page.textContent('.aps-t')) && (await page.textContent('.aps-t')).includes('L '));
  await page.click('.aps >> nth=0'); await page.waitForSelector('#ov.show .lad.here');
  check('summary cell opens the rubric with the suggested band', (await page.$$('#ov .lad')).length === 4);
  await page.screenshot({ path: path.join(shots, 'checkout-summary.png'), fullPage: true });

  await page.goto(url('role=student').replace('reset=1&', ''));
  await page.waitForSelector('.apchart');
  check('student chart shows the teacher\'s lesson ratings as their own marker', (await page.$$('.apchart .aplesson')).length >= 1 && (await page.textContent('.aplegend >> nth=-1')).includes('My teacher in lessons'));
  check('lesson ratings are not drawn as the Canvas grade', (await page.$$eval('.apchart title', t => t.map(x => x.textContent))).filter(x => /^Teacher in a lesson/.test(x)).length === (await page.$$('.apchart .aplesson')).length);
  check('the kiosk tap shows up as today\'s self-check', (await page.$$eval('.apchart .apdot title', t => t.map(x => x.textContent))).length >= 7);
  check('"Rate myself" is hidden (students check in on the teacher\'s iPad)', (await page.$$('#toapself, #toapself2')).length === 0);
  check('student AP shows bands in words, no numbers', !/\b[1-7]\/7\b|\bme [1-7]\b|teacher [1-7]\b/.test(await page.textContent('.apcompare')));
  await (await page.$('.apchart')).screenshot({ path: path.join(shots, 'checkout-student.png') });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(url('role=teacher'));
  await page.click('#tocheckout'); await page.waitForSelector('[data-coclass]');
  check('no horizontal scroll on phone (setup)', await noHScroll());
  await page.click('[data-coclass="8B"]'); await page.waitForSelector('.co-count');
  await page.click('[data-cofocus="team"]'); await page.waitForSelector('#cokiosk:not([disabled])');
  await page.click('#cokiosk'); await page.click('.ko-name >> nth=0'); await page.waitForSelector('.ko-band');
  check('no horizontal scroll on phone (kiosk)', await noHScroll());
  check('every criterion shows the student "I…" line', (await page.textContent('.ko-bands')).includes('I communicate respectfully'));

  check('no page errors', errors.length === 0, errors.join(' | '));
  await browser.close();
  console.log(failed ? `\n${failed} check-out smoke check(s) FAILED` : '\ncheck-out smoke passed');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
