#!/usr/bin/env node
// Builds dev/preview.html: the real page with src/Code.gs running in the
// browser against a fake spreadsheet, a fake API and a fake Google sign-in.
//   node dev/build-preview.js && open dev/preview.html?role=student
// See dev/mock-runtime.js for the URL switches. Synthetic data only.
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
require('child_process').execFileSync(process.execPath, [path.join(__dirname, 'build-rubrics.js')], { stdio: 'inherit' });
const wrap = js => `<script>\n${js}\n</script>`;
const html = read('src/Index.html')
  .replace('<title>My PE Profile · Grade 8</title>', '<title>My PE Profile (preview)</title>')
  .replace('<!--STYLES-->', () => read('src/Styles.html'))
  .replace('<!--GSI-->', () => '')
  .replace('<!--CONFIG-->', () => [wrap(read('dev/fake-sheets.js')), wrap(read('src/Code.gs')), wrap(read('dev/mock-runtime.js'))].join('\n'))
  .replace('<!--RUBRICS-->', () => read('src/Rubrics.html'))
  .replace('<!--APP-->', () => read('src/App.html'));
const out = path.join(__dirname, 'preview.html');
fs.writeFileSync(out, html);
console.log('Wrote', path.relative(root, out), `(${(html.length / 1024).toFixed(0)} KB)`);
