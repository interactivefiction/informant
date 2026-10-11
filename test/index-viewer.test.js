/*
 * Informant - Inform development environment for Visual Studio Code
 * Copyright (C) 2026 OpcodeASM
 *
 * This file is part of Informant.
 *
 * Informant is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, version 3 of the License.
 *
 * Informant is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with Informant. If not, see <https://www.gnu.org/licenses/>.
 *
 * SPDX-License-Identifier: GPL-3.0-only
 */

'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

let panel;
const vscode = {
  Uri: { file: fsPath => ({ fsPath }) }, ViewColumn: { Active: 1 },
  window: {
    createWebviewPanel(type, title, column, options) {
      panel = { options, title, reveal() {}, dispose() { this.disposed?.(); }, onDidDispose(fn) { this.disposed = fn; },
        webview: { cspSource: 'http://127.0.0.1:*', asWebviewUri: uri => ({ toString: () => `${origin}/asset?file=${encodeURIComponent(uri.fsPath)}` }),
          onDidReceiveMessage(fn) { panel.receive = fn; return { dispose() {} }; } } };
      return panel;
    }, showErrorMessage(message) { throw new Error(message); }
  }
};
let origin = 'http://127.0.0.1:1';
const source = awaitSource();
function awaitSource() { return require('node:fs').readFileSync(path.join(__dirname, '..', 'index-viewer.js'), 'utf8'); }
const sandbox = { require: name => name === 'vscode' ? vscode : require(name), module: { exports: {} }, URL };
vm.runInNewContext(source + '\nmodule.exports.testing = { destination, contained, imageryUri, pageData, render };', sandbox);
const { openIndex, testing: api } = sandbox.module.exports;
const temporary = awaitTemp();
function awaitTemp() { return require('node:fs').mkdtempSync(path.join(os.tmpdir(), 'informant-index-test-')); }
after(async () => { await fs.rm(temporary, { recursive: true, force: true }); });

test('navigation allowlist and narrowly scoped Details correction', () => {
  assert.equal(api.destination('Details/1_A.html', 'https://informant-index.invalid/Details/0_A.html').pathname, '/Details/1_A.html');
  assert.equal(api.destination('../Actions.html', 'https://informant-index.invalid/Details/0_A.html').pathname, '/Actions.html');
  for (const input of ['../Source/story.ni', 'https://example.org/World.html', 'source:story.ni#line1', 'Details/no.html', '/%2e%2e/secret.html', '/Details%2f..%2fWorld.html']) assert.throws(() => api.destination(input));
});

test('realpath containment rejects escaping symlinks and resource traversal', async () => {
  const root = path.join(temporary, 'safe'); await fs.mkdir(root);
  await fs.writeFile(path.join(temporary, 'outside.png'), 'outside');
  await fs.symlink(path.join(temporary, 'outside.png'), path.join(root, 'escape.png'));
  await assert.rejects(api.contained(root, path.join(root, 'escape.png')), /symlink/);
  await assert.rejects(api.contained(root, path.join(temporary, 'outside.png')), /outside/);
  const state = { imagery: { doc_images: root } };
  for (const url of ['inform:/doc_images/escape.png', 'inform://host/doc_images/x.png', 'inform:/doc_images/%2e%2e%2foutside.png', 'file:///etc/passwd']) await assert.rejects(api.imageryUri(state, url));
});

test('refresh rereads generated files, falls back for removed details, and recovers after clean', async () => {
  const project = path.join(temporary, 'Refresh.inform');
  const internal = path.join(temporary, 'package');
  await fs.mkdir(path.join(project, 'Source'), { recursive: true });
  await fs.writeFile(path.join(project, 'Source', 'story.ni'), 'Test');
  await fs.mkdir(path.join(project, 'Index', 'Details'), { recursive: true });
  const welcome = path.join(project, 'Index', 'Welcome.html');
  const detail = path.join(project, 'Index', 'Details', '1_A.html');
  await fs.writeFile(welcome, '<p>Welcome fixture</p>');
  await fs.writeFile(detail, '<p>Old detail</p>');
  for (const family of ['bg_images', 'doc_images', 'map_icons', 'scene_icons']) await fs.mkdir(path.join(internal, 'Imagery', family), { recursive: true });
  await openIndex(project, internal, { subscriptions: [] });
  const first = panel;
  await openIndex(project, internal, { subscriptions: [] });
  assert.equal(panel, first, 'reuses the project panel');
  await panel.receive({ type: 'navigate', target: 'https://informant-index.invalid/Details/1_A.html#anchor' });
  await fs.writeFile(detail, '<p id="anchor">Regenerated detail</p>');
  await panel.receive({ type: 'refresh' });
  assert.ok(panel.webview.html.includes('Regenerated detail'));
  assert.ok(panel.webview.html.includes('1_A.html#anchor'));
  await fs.unlink(detail);
  await panel.receive({ type: 'refresh' });
  assert.ok(panel.webview.html.includes('Welcome fixture'));
  await fs.rm(path.join(project, 'Index'), { recursive: true });
  await panel.receive({ type: 'refresh' });
  assert.ok(panel.webview.html.includes('Index unavailable'));
  await fs.mkdir(path.join(project, 'Index'));
  await fs.writeFile(welcome, '<p>Rebuilt fixture</p>');
  await panel.receive({ type: 'refresh' });
  assert.ok(panel.webview.html.includes('Rebuilt fixture'));
  panel.dispose();
});

const project = process.env.INDEX_PROJECT;
const internal = process.env.INDEX_INTERNAL;
const browser = process.env.INDEX_BROWSER;

test('actual generated Index resources, lifecycle, refresh, and browser interactions', { skip: !project || !internal }, async t => {
  const context = { subscriptions: [] };
  await openIndex(project, internal, context);
  assert.equal(panel.options.localResourceRoots.length, 4);
  assert.ok(panel.options.localResourceRoots.every(uri => uri.fsPath.startsWith(path.join(internal, 'Imagery') + path.sep)));
  const state = { project: await fs.realpath(project), root: path.join(await fs.realpath(project), 'Index'), imagery: {}, panel };
  for (const family of ['bg_images', 'doc_images', 'map_icons', 'scene_icons']) state.imagery[family] = await fs.realpath(path.join(internal, 'Imagery', family));
  const names = (await fs.readdir(state.root)).filter(n => n.endsWith('.html'));
  names.push(...(await fs.readdir(path.join(state.root, 'Details'))).filter(n => n.endsWith('.html')).map(n => 'Details/' + n));
  for (const name of names) {
    const data = await api.pageData(state, name);
    assert.ok(Object.keys(data.resources).length > 0, name);
  }
  assert.equal(names.length, 86);
  await panel.receive({ type: 'navigate', target: 'https://informant-index.invalid/World.html?segment2#missing' });
  await panel.receive({ type: 'refresh' });
  assert.ok(panel.webview.html.includes('World.html?segment2#missing'));
  await panel.receive({ type: 'home' });
  assert.ok(panel.webview.html.includes('Welcome.html'));
  if (!browser) { t.diagnostic('Set INDEX_BROWSER to exercise the adapter in a real Chromium browser.'); panel.dispose(); return; }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, origin);
      if (url.pathname === '/asset') {
        const file = url.searchParams.get('file');
        const root = Object.values(state.imagery).find(root => file.startsWith(root + path.sep));
        if (!root) throw new Error('asset outside roots');
        res.setHeader('Content-Type', 'image/png'); res.end(await fs.readFile(await api.contained(root, file))); return;
      }
      const data = await api.pageData(state, url.searchParams.get('page') || 'Welcome.html');
      // VS Code 1.96.4 toContentHtml replaces the supplied doctype and prepends
      // defaultStyles. Keep its layout-affecting rules before extension styles.
      let html = api.render(state, data).replace(/<!DOCTYPE[^>]+>/i, '<!DOCTYPE html>');
      html = html.replace('<head>', `<head><style id="_defaultStyles">
        :root { --vscode-font-family: sans-serif; --vscode-font-weight: normal; --vscode-font-size: 13px; }
        body { overscroll-behavior-x: none; background-color: transparent;
          color: var(--vscode-editor-foreground); font-family: var(--vscode-font-family);
          font-weight: var(--vscode-font-weight); font-size: var(--vscode-font-size);
          margin: 0; padding: 0 20px; }
        img, video { max-width: 100%; max-height: 100%; }
        code { font-family: var(--monaco-monospace-font); padding: 1px 3px; border-radius: 4px; }
        pre code { padding: 0; }
        kbd { border-style: solid; border-width: 1px; border-radius: 3px;
          vertical-align: middle; padding: 1px 3px; }
        ::-webkit-scrollbar { width: 10px; height: 10px; }
      </style>`);
      html = html.replace(/(<script nonce="[^"]+">)/, '$1window.messages=[]; window.acquireVsCodeApi=()=>({postMessage:m=>window.messages.push(m)});');
      res.setHeader('Content-Type', 'text/html'); res.end(html);
    } catch (err) { res.statusCode = 500; res.end(err.stack); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); origin = `http://127.0.0.1:${server.address().port}`;
  const profile = path.join(temporary, 'browser');
  const child = spawn(browser, ['--headless', '--no-sandbox', '--disable-gpu', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
  let ws;
  try {
    let port;
    for (let i = 0; i < 100; i++) { try { port = (await fs.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; break; } catch { await new Promise(r => setTimeout(r, 100)); } }
    assert.ok(port, 'browser started');
    const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    ws = new WebSocket(pages.find(p => p.type === 'page').webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
    let id = 0; const pending = new Map(); const errors = [];
    ws.addEventListener('message', event => { const data = JSON.parse(event.data); if (data.id) { pending.get(data.id)?.(data); pending.delete(data.id); } if (data.method === 'Runtime.exceptionThrown') errors.push(data.params); });
    function call(method, params = {}) { return new Promise((resolve, reject) => { const key = ++id; pending.set(key, result => result.error ? reject(new Error(JSON.stringify(result.error))) : resolve(result.result)); ws.send(JSON.stringify({ id: key, method, params })); }); }
    async function evaluate(expression) { const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails)); return result.result.value; }
    await call('Runtime.enable');
    async function visit(page) {
      await call('Page.navigate', { url: `${origin}/?page=${encodeURIComponent(page)}` });
      for (let i = 0; i < 100; i++) { if (await evaluate(`document.readyState === 'complete' && !!window.messages && window.messages.length > 0 && window.messages[0].target.includes(${JSON.stringify(page.split('?')[0].split('#')[0])})`)) return; await new Promise(r => setTimeout(r, 30)); }
      throw new Error('page load timeout ' + page);
    }
    const themes = ['vscode-light', 'vscode-dark', 'vscode-high-contrast', 'vscode-high-contrast-light'];
    async function theme(name) {
      const dark = name === 'vscode-dark' || name === 'vscode-high-contrast';
      const high = name.includes('high-contrast');
      await evaluate(`(() => {
        document.body.className = ${JSON.stringify(name === 'vscode-high-contrast-light' ? name + ' vscode-high-contrast' : name)};
        const vars = ${JSON.stringify({
          'editor-background': dark ? (high ? '#000000' : '#1e1e1e') : '#ffffff',
          'editor-foreground': dark ? '#dddddd' : '#202020',
          'editorWidget-background': dark ? '#282828' : '#eeeeee',
          'descriptionForeground': dark ? '#bbbbbb' : '#555555',
          'tree-tableOddRowsBackground': dark ? '#242424' : '#f3f6fa',
          'panel-border': dark ? '#707070' : '#aaaaaa',
          'textLink-foreground': dark ? '#88ccff' : '#0000ee',
          'contrastBorder': high ? (dark ? '#ffffff' : '#000000') : '#707070',
          'focusBorder': dark ? '#ffffff' : '#000000'
        })};
        for (const [key, value] of Object.entries(vars)) document.documentElement.style.setProperty('--vscode-' + key, value);
      })()`);
    }
    const images = () => evaluate(`Array.from(document.querySelectorAll('#content img')).map(img => [img.src, img.naturalWidth, img.naturalHeight, img.width, img.height])`);
    const regionState = () => evaluate(`Array.from(document.querySelectorAll('#content td[bgcolor]')).map(cell => ({
      fill: cell.getAttribute('bgcolor'), background: getComputedStyle(cell).backgroundColor,
      foreground: getComputedStyle(cell).color, title: cell.closest('table').title,
      label: cell.textContent.trim(), labelColors: Array.from(cell.querySelectorAll('.indexblack')).map(el => getComputedStyle(el).color)
    }))`);
    await visit('Welcome.html');
    assert.equal(await evaluate(`document.querySelectorAll('#content [onclick],#content script').length`), 0);
    assert.equal(await evaluate(`document.querySelectorAll('#content [role="button"]').length`), 38);
    await evaluate(`document.querySelector('#box7_2 .elementtext').click()`);
    assert.ok((await evaluate('messages.at(-1).target')).endsWith('World.html?segment2'));
    await visit('World.html');
    const measureGeometry = () => evaluate(`(() => {
      const size = el => { const r = el.getBoundingClientRect(); return [r.width, r.height]; };
      const maps = [...document.querySelectorAll('#content table[background]')];
      const rooms = [...maps[0].querySelectorAll('table.indexmaproom')];
      const positions = rooms.map(el => { const r = el.getBoundingClientRect(); return [r.x, r.y]; });
      return {
        overview: size(maps[0]),
        details: maps.slice(1).map(size),
        rooms: [...document.querySelectorAll('#content table.indexmaproom')].map(size),
        horizontal: positions.filter((_, i) => i % 3 !== 2).map((p, i) => {
          const index = Math.floor(i / 2) * 3 + i % 2;
          return positions[index + 1][0] - p[0];
        }),
        vertical: positions.slice(0, 6).map((p, i) => positions[i + 3][1] - p[1])
      };
    })()`);
    const geometry = await measureGeometry();
    assert.equal(await evaluate(`document.doctype.publicId`), '', 'host forces HTML5 mode');
    assert.equal(await evaluate(`getComputedStyle(document.body).paddingLeft`), '20px', 'host default padding is injected');
    assert.ok(await evaluate(`document.querySelectorAll('.informant-map-image-cell').length > 0`));
    assert.equal(await evaluate(`Array.from(document.querySelectorAll('.informant-map-image-cell')).filter(cell =>
      cell.tagName !== 'TD' || !cell.querySelector(':scope > img') || Array.from(cell.childNodes).some(node =>
        !(node.nodeType === 3 && !node.textContent.trim()) && !(node.nodeType === 1 &&
          (node.tagName === 'BR' || (node.tagName === 'IMG' && new URL(node.src).searchParams.get('file').includes('/map_icons/'))))
      )).length`), 0, 'only whitespace, breaks and map images receive compatibility treatment');
    assert.equal(await evaluate(`document.querySelectorAll('table.indexmaproom .informant-map-image-cell, .informant-map-image-cell table').length`), 0, 'room labels and enclosing cells remain untouched');
    assert.ok(await evaluate(`Array.from(document.querySelectorAll('table.indexmaproom td')).every(cell => getComputedStyle(cell).fontSize === '12px')`), 'room-label font sizes remain intact');
    t.diagnostic('World geometry: ' + JSON.stringify(geometry));
    assert.deepEqual(geometry.overview, [159, 159], 'World overview geometry');
    assert.equal(geometry.details.length, 9, 'nine individual room maps');
    for (const size of geometry.details) assert.deepEqual(size, [53, 53], 'individual room map geometry');
    assert.equal(geometry.rooms.length, 20, 'overview, detail and region-key room boxes');
    for (const size of geometry.rooms) assert.deepEqual(size, [27, 27], 'room box geometry');
    assert.deepEqual(geometry.horizontal, Array(6).fill(53), 'horizontal room spacing');
    assert.deepEqual(geometry.vertical, Array(6).fill(53), 'vertical room spacing');
    const worldImages = await images();
    for (const name of themes) {
      await theme(name);
      assert.deepEqual(await measureGeometry(), geometry, name + ' exact World geometry');
      assert.deepEqual(await images(), worldImages, name + ' canonical World imagery and dimensions');
      const regions = await regionState();
      assert.equal(regions.filter(r => r.fill === '#98FB98').length, 16);
      assert.equal(regions.filter(r => r.fill === '#ADD8E6').length, 13);
      for (const cell of regions) {
        const green = cell.fill === '#98FB98';
        assert.equal(cell.background, green ? 'rgb(152, 251, 152)' : 'rgb(173, 216, 230)');
        assert.equal(cell.foreground, 'rgb(32, 32, 32)', name + ' dark inherited badge lettering');
        assert.ok(cell.labelColors.every(color => color === 'rgb(0, 0, 0)'), 'original map label lettering');
        if (cell.title) assert.equal(green, ['Ripening Room', 'DefectN Room', 'DefectS Room', 'DefectE Room', 'DefectW Room'].includes(cell.title), cell.title + ' region assignment');
        if (cell.label.includes('region')) assert.ok(cell.label.includes(green ? 'TestA' : 'TestB'));
      }
      assert.equal(await evaluate(`getComputedStyle(document.body).backgroundColor`), name === 'vscode-dark' ? 'rgb(30, 30, 30)' : name === 'vscode-high-contrast' ? 'rgb(0, 0, 0)' : 'rgb(255, 255, 255)');
    }
    await theme('vscode-light');
    await visit('World.html?segment2');
    assert.equal(await evaluate(`document.getElementById('segment1').style.display`), 'none');
    await evaluate(`document.querySelector('#box7_2 a').click()`);
    assert.equal(await evaluate(`document.getElementById('segment1').style.display`), '');
    await evaluate(`document.getElementById('plus1').closest('a').click()`);
    assert.equal(await evaluate(`document.getElementById('extra1').style.display`), 'block');
    assert.ok((await evaluate(`document.getElementById('plus1').src`)).includes('extraclose'));
    await evaluate(`document.getElementById('plus1').closest('a').click()`);
    assert.equal(await evaluate(`document.getElementById('extra1').style.display`), 'none');
    assert.ok(await evaluate(`document.querySelector('.informant-disabled').title.includes('not available')`));
    await evaluate(`window.scrollTo(0, 300); document.getElementById('plus1').closest('a').click()`);
    assert.ok(await evaluate('window.scrollY > 0'), 'toggle does not jump to top');
    await evaluate(`document.querySelector('#box7_1 a').click(); window.scrollTo(0, 300)`);
    const stateBeforeThemes = await evaluate(`({ messages: JSON.stringify(messages), scroll: scrollY, extra: document.getElementById('extra1').style.display, segments: [...document.querySelectorAll('[id^="segment"]')].map(el => el.style.display) })`);
    for (const name of themes) {
      await theme(name);
      assert.deepEqual(await evaluate(`({ messages: JSON.stringify(messages), scroll: scrollY, extra: document.getElementById('extra1').style.display, segments: [...document.querySelectorAll('[id^="segment"]')].map(el => el.style.display) })`), stateBeforeThemes, name + ' preserves navigation, expansion, segment and scroll state');
      assert.equal(await evaluate(`getComputedStyle(document.getElementById('box7_1')).backgroundColor`), 'rgb(139, 88, 191)', 'active report identity');
      assert.equal(await evaluate(`getComputedStyle(document.getElementById('box7_2')).backgroundColor`), name === 'vscode-dark' || name === 'vscode-high-contrast' ? 'rgb(40, 40, 40)' : 'rgb(204, 204, 204)', 'inactive tile follows theme');
    }
    await visit('Kinds.html');
    await evaluate(`document.querySelector('#content img[src*="shelp.png"]').closest('a').click()`);
    assert.equal(await evaluate(`document.getElementById('default').style.display`), '');
    await visit('Kinds.html?segment2#K1_room');
    assert.notEqual(await evaluate(`getComputedStyle(document.querySelector('[name="K1_room"]').closest('[id^="segment"]')).display`), 'none');
    const fragmentState = await evaluate(`({ messages: JSON.stringify(messages), scroll: scrollY })`);
    for (const name of themes) { await theme(name); assert.deepEqual(await evaluate(`({ messages: JSON.stringify(messages), scroll: scrollY })`), fragmentState, 'theme preserves fragment state'); }
    await visit('Details/0_A.html');
    await evaluate(`Array.from(document.querySelectorAll('#content a')).find(a=>a.textContent==='^').click()`);
    assert.ok((await evaluate('messages.at(-1).target')).endsWith('/Actions.html'));
    for (const name of names) {
      await visit(name);
      const canonicalImages = await images();
      const sizes = () => evaluate(`Array.from(document.querySelectorAll('#content table')).map(el => { const r = el.getBoundingClientRect(); return [r.width, r.height]; })`);
      const lightSizes = await sizes();
      for (const themeName of themes) {
        await theme(themeName);
        assert.deepEqual(await sizes(), lightSizes, name + ' table dimensions in ' + themeName);
        assert.deepEqual(await images(), canonicalImages, name + ' imagery in ' + themeName);
        const semantic = await evaluate(`(() => {
          const roles = ['indexdullred', 'indexdullblue', 'phrasetokentext', 'phrasetokendesctext'];
          return roles.flatMap(role => {
            const el = document.querySelector('#content .' + role + ':not(.informant-index-light *)');
            if (!el) return [];
            let surface = el;
            while (surface.parentElement && getComputedStyle(surface).backgroundColor === 'rgba(0, 0, 0, 0)') surface = surface.parentElement;
            return [{ role, color: getComputedStyle(el).color, background: getComputedStyle(surface).backgroundColor }];
          });
        })()`);
        const dark = themeName === 'vscode-dark' || themeName === 'vscode-high-contrast';
        const expectedRoles = dark
          ? { indexdullred: 'rgb(240, 160, 160)', indexdullblue: 'rgb(156, 220, 254)', phrasetokentext: 'rgb(240, 160, 206)', phrasetokendesctext: 'rgb(197, 180, 255)' }
          : { indexdullred: 'rgb(128, 0, 0)', indexdullblue: 'rgb(0, 0, 128)', phrasetokentext: 'rgb(224, 0, 96)', phrasetokendesctext: 'rgb(64, 64, 255)' };
        const luminance = rgb => rgb.match(/[\d.]+/g).slice(0, 3).map(Number).map(v => {
          v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
        }).reduce((sum, value, i) => sum + value * [0.2126, 0.7152, 0.0722][i], 0);
        for (const item of semantic) {
          assert.equal(item.color, expectedRoles[item.role], name + ' semantic role ' + item.role);
          if (dark) {
            const values = [luminance(item.color), luminance(item.background)].sort((a, b) => b - a);
            assert.ok((values[0] + 0.05) / (values[1] + 0.05) >= 4.5, name + ' semantic text contrast');
          }
        }
        if (name === 'Contents.html') {
          assert.ok(await evaluate(`Array.from(document.querySelectorAll('ul.leaders li.leaded span:first-child, ul.leaders li.leaded span + span')).every(el => getComputedStyle(el).backgroundColor === getComputedStyle(document.body).backgroundColor)`), 'Contents leader masks follow canvas');
          assert.equal(await evaluate(`getComputedStyle(document.querySelector('.librarycardtitle')).color`), 'rgb(128, 48, 48)', 'library card title unchanged');
          assert.equal(await evaluate(`getComputedStyle(document.querySelector('.librarycardother')).color`), 'rgb(48, 48, 48)', 'library card text unchanged');
        }
        if (name === 'Phrasebook.html' && (themeName === 'vscode-dark' || themeName === 'vscode-high-contrast')) {
          assert.equal(await evaluate(`getComputedStyle(document.querySelector('.phrasetokentext')).color`), 'rgb(240, 160, 206)');
          assert.equal(await evaluate(`getComputedStyle(document.querySelector('.phrasetokendesctext')).color`), 'rgb(197, 180, 255)');
        }
        if (name === 'Kinds.html' && (themeName === 'vscode-dark' || themeName === 'vscode-high-contrast')) {
          assert.equal(await evaluate(`getComputedStyle(document.querySelector('.stripetwo')).backgroundColor`), 'rgb(36, 36, 36)');
          assert.equal(await evaluate(`getComputedStyle(document.querySelector('.headingrow')).backgroundColor`), 'rgb(40, 40, 40)');
        }
      }
      if (name !== 'World.html') assert.equal(await evaluate(`document.querySelectorAll('.informant-map-image-cell').length`), 0, name + ' receives no map compatibility classes');
      assert.equal(await evaluate(`Array.from(document.querySelectorAll('#content img')).filter(img=>!img.complete || img.naturalWidth===0).length`), 0, name + ' images');
    }
    assert.deepEqual(errors, []);
    t.diagnostic(`Rendered ${names.length} real generated pages in all four theme classes with no missing images or browser exceptions.`);
  } finally { ws?.close(); child.kill(); await once(child, 'exit'); server.closeAllConnections(); await new Promise(r => server.close(r)); panel.dispose(); }
});
