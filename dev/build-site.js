#!/usr/bin/env node
// Builds the student page, index.html at the repo root (served by GitHub Pages),
// from src/Index.html + Styles + Rubrics + App and the public values in
// site.config.json. Commit index.html: it is what students open.
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
require('child_process').execFileSync(process.execPath, [path.join(__dirname, 'build-rubrics.js')], { stdio: 'inherit' });
const cfg = JSON.parse(read('site.config.json'));
// The page carries the build of the server it was made with, so teachers can see at a glance
// whether the uploaded page and the deployed server match.
const pageBuild = (read('src/Code.gs').match(/var BUILD = '([^ ']+)/) || [])[1] || '';
const pub = { apiUrl: cfg.apiUrl, clientId: cfg.clientId, domain: cfg.domain, pageBuild };
const html = read('src/Index.html')
  .replace('<!--STYLES-->', () => read('src/Styles.html'))
  .replace('<!--GSI-->', () => '<script src="https://accounts.google.com/gsi/client" async defer></script>')
  .replace('<!--CONFIG-->', () => '<script>window.PE_CONFIG = ' + JSON.stringify(pub) + ';</script>')
  .replace('<!--RUBRICS-->', () => read('src/Rubrics.html'))
  .replace('<!--APP-->', () => read('src/App.html'));
fs.writeFileSync(path.join(root, 'index.html'), html);
// Same page at a second path: the root URL was mis-classified by the school web
// filter while it was a redirect page, and the tag stuck to that URL.
fs.mkdirSync(path.join(root, 'pe'), { recursive: true });
fs.writeFileSync(path.join(root, 'pe/index.html'), html);
console.log('Wrote index.html and pe/index.html', `(${(html.length / 1024).toFixed(0)} KB)`);
