// Minimal in-memory stand-in for the Google Apps Script services that
// src/Code.gs uses (SpreadsheetApp, Session, LockService, CacheService,
// Utilities, HtmlService). Lets the real server code run in a browser
// preview (dev/build-preview.js) or under Node (dev/test-server.js).
// Only what Code.gs calls is emulated.
(function (g) {
  'use strict';
  const isEmpty = v => v === '' || v === null || v === undefined;

  class Range {
    constructor(sheet, r, c, nr, nc) { this.sheet = sheet; this.r = r; this.c = c; this.nr = nr; this.nc = nc; }
    getValues() {
      const out = [];
      for (let i = 0; i < this.nr; i++) {
        const row = this.sheet.rows[this.r - 1 + i] || [];
        const line = [];
        for (let j = 0; j < this.nc; j++) { const v = row[this.c - 1 + j]; line.push(isEmpty(v) ? '' : v); }
        out.push(line);
      }
      return out;
    }
    setValues(vals) {
      if (vals.length !== this.nr || vals[0].length !== this.nc) throw new Error(`setValues size mismatch: range ${this.nr}x${this.nc}, data ${vals.length}x${vals[0] && vals[0].length}`);
      for (let i = 0; i < this.nr; i++) {
        while (this.sheet.rows.length < this.r + i) this.sheet.rows.push([]);
        const row = this.sheet.rows[this.r - 1 + i];
        for (let j = 0; j < this.nc; j++) row[this.c - 1 + j] = vals[i][j];
      }
      this.sheet.book._touch();
      return this;
    }
    clearContent() { const blank = []; for (let i = 0; i < this.nr; i++) blank.push(new Array(this.nc).fill('')); return this.setValues(blank); }
    setFontWeight() { return this; }
  }
  class Sheet {
    constructor(book, name) { this.book = book; this.name = name; this.rows = []; }
    getName() { return this.name; }
    getLastRow() { let last = 0; this.rows.forEach((row, i) => { if (row.some(v => !isEmpty(v))) last = i + 1; }); return last; }
    getLastColumn() { let last = 0; this.rows.forEach(row => row.forEach((v, j) => { if (!isEmpty(v)) last = Math.max(last, j + 1); })); return last; }
    getRange(r, c, nr, nc) { return new Range(this, r, c, nr === undefined ? 1 : nr, nc === undefined ? 1 : nc); }
    getDataRange() { return new Range(this, 1, 1, Math.max(1, this.getLastRow()), Math.max(1, this.getLastColumn())); }
    setFrozenRows() { return this; }
    clear() { this.rows = []; this.book._touch(); return this; }
  }
  class Book {
    constructor() { this.sheets = []; this.onChange = null; }
    getSheetByName(n) { return this.sheets.find(s => s.name === n) || null; }
    getSheets() { return this.sheets.slice(); }
    insertSheet(n) { const s = new Sheet(this, n); this.sheets.push(s); this._touch(); return s; }
    _touch() { if (this.onChange) this.onChange(this); }
    toJSON() { return { sheets: this.sheets.map(s => ({ name: s.name, rows: s.rows })) }; }
    static fromJSON(j) { const b = new Book(); (j.sheets || []).forEach(x => { const s = b.insertSheet(x.name); s.rows = x.rows; }); return b; }
  }

  const FakeSheets = { book: new Book(), user: '', owner: 'owner@example.edu', cache: {}, uiAnswer: 'YES', alerts: [] };

  g.SpreadsheetApp = {
    getActiveSpreadsheet: () => FakeSheets.book,
    getUi: () => ({
      ButtonSet: { YES_NO: 'YES_NO', OK: 'OK' }, Button: { YES: 'YES', NO: 'NO' },
      alert: (...a) => { FakeSheets.alerts.push(a); return FakeSheets.uiAnswer; },
      createMenu: () => { const m = { addItem: () => m, addSeparator: () => m, addToUi: () => {} }; return m; }
    })
  };
  g.Session = {
    getActiveUser: () => ({ getEmail: () => FakeSheets.user }),
    getEffectiveUser: () => ({ getEmail: () => FakeSheets.owner }),
    getScriptTimeZone: () => 'Europe/Berlin'
  };
  g.LockService = { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) };
  g.CacheService = { getScriptCache: () => ({ get: k => (k in FakeSheets.cache ? FakeSheets.cache[k] : null), put: (k, v) => { FakeSheets.cache[k] = v; }, remove: k => { delete FakeSheets.cache[k]; } }) };
  const b64url = str => (typeof btoa === 'function' ? btoa(str) : Buffer.from(str).toString('base64')).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const b64urlDecode = str => { const b = str.replace(/-/g, '+').replace(/_/g, '/'); return typeof atob === 'function' ? atob(b) : Buffer.from(b, 'base64').toString('utf8'); };
  g.Utilities = {
    // like Apps Script: format in the given time zone (the real one honours it)
    formatDate: (d, tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(d)),
    DigestAlgorithm: { SHA_256: 'SHA_256' },
    // not a real hash; stable and distinct per input is all the cache key needs
    computeDigest: (alg, str) => { let h1 = 0x811c9dc5, h2 = 0x1000193; for (const ch of String(str)) { h1 = ((h1 ^ ch.charCodeAt(0)) * 16777619) >>> 0; h2 = ((h2 + ch.charCodeAt(0)) * 31) >>> 0; } return [h1, h2, String(str).length]; },
    base64EncodeWebSafe: bytes => b64url(JSON.stringify(bytes))
  };
  // A fake Google ID token: "fake.<base64url claims>.sig". FakeSheets.token(claims) makes one;
  // the fake tokeninfo endpoint decodes it. Real tokens never touch the fake runtime.
  FakeSheets.token = claims => 'fake.' + b64url(JSON.stringify(claims)) + '.sig';
  FakeSheets.fetchCount = 0;
  FakeSheets.fetch = (url, opts) => {
    FakeSheets.fetchCount++;
    const m = /tokeninfo\?id_token=(.+)$/.exec(url);
    const reply = (code, obj) => ({ getResponseCode: () => code, getContentText: () => JSON.stringify(obj) });
    if (!m) return reply(404, { error: 'unknown url' });
    const t = decodeURIComponent(m[1]);
    if (!t.startsWith('fake.')) return reply(400, { error: 'invalid_token' });
    try { return reply(200, JSON.parse(b64urlDecode(t.split('.')[1]))); } catch (e) { return reply(400, { error: 'invalid_token' }); }
  };
  g.UrlFetchApp = { fetch: (url, opts) => FakeSheets.fetch(url, opts) };
  g.ContentService = {
    MimeType: { JSON: 'application/json' },
    createTextOutput: text => { const o = { _text: text, setMimeType() { return o; }, getContent: () => text }; return o; }
  };
  g.HtmlService = {
    XFrameOptionsMode: { DEFAULT: 'DEFAULT', ALLOWALL: 'ALLOWALL' },
    createTemplate: src => {
      const t = { _src: src };
      t.evaluate = () => {
        let html = t._src.replace(/<\?!?=\s*(\w+)\s*\?>/g, (m, k) => (k in t ? String(t[k]) : ''));
        const out = { html, setTitle() { return out; }, addMetaTag() { return out; }, setXFrameOptionsMode() { return out; }, getContent: () => html };
        return out;
      };
      return t;
    },
    createTemplateFromFile: () => { throw new Error('createTemplateFromFile is not available in the fake runtime'); },
    createHtmlOutputFromFile: () => { throw new Error('createHtmlOutputFromFile is not available in the fake runtime'); }
  };
  FakeSheets.Book = Book;
  g.FakeSheets = FakeSheets;
})(typeof window !== 'undefined' ? window : globalThis);
