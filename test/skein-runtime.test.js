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
// Optional acceptance against a real toolchain and an isolated Firefox BiDi session.
// No interpreter dependencies are downloaded or bundled by this test.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const http = require('node:http');
const { once } = require('node:events');
const { createRequire } = require('node:module');

const original = process.env.SKEIN_PROJECT;
const internal = process.env.SKEIN_INTERNAL;
const endpoint = process.env.SKEIN_BIDI;

for (const iskein of [false, true]) test(iskein
  ? 'PeachesNCream: saved Wait and I Quit through Test Manager Play ISkein in real browser'
  : 'PeachesNCream: compile command, real Quixe recording, linear replay, human continuation, fresh replacement, and non-recording play',
  { skip: !original || !internal || !endpoint, timeout: 120000 }, async t => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'informant-skein-runtime-'));
    t.after(() => fs.rm(temp, { recursive: true, force: true }));
    const project = path.join(temp, 'PeachesNCream.inform');
    await fs.mkdir(project);
    await fs.cp(path.join(original, 'Source'), path.join(project, 'Source'), { recursive: true });
    for (const name of ['Settings.plist', 'uuid.txt']) {
      await fs.copyFile(path.join(original, name), path.join(project, name)).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
    const destination = path.join(project, 'Skein.skein');
    await fs.copyFile(path.join(original, 'Skein.skein'), destination);
    const previous = await fs.readFile(destination, 'utf8');
    const storage = path.join(temp, 'storage');
    await fs.mkdir(path.join(storage, 'toolchains'), { recursive: true });
    await fs.symlink(internal, path.join(storage, 'toolchains', '10.1.2'), 'dir');
    const commands = new Map(), errors = [], warnings = [], logs = [], notices = [];
    let panel, origin, managerPanel;
    const disposable = () => ({ dispose() {} });
    const vscode = {
      commands: { executeCommand() {}, registerCommand(id, fn) { commands.set(id, fn); return { dispose() {} }; } },
      workspace: { onDidChangeConfiguration: () => ({ dispose() {} }), getConfiguration: () => ({ get: (key, fallback) => fallback }),
        createFileSystemWatcher: () => ({ dispose() {}, onDidCreate: disposable, onDidChange: disposable, onDidDelete: disposable }) },
      RelativePattern: class {},
      languages: { createDiagnosticCollection: () => ({ clear() {}, set() {} }) },
      Uri: { file: fsPath => ({ fsPath }) }, ViewColumn: { Active: 1 },
      Range: class {}, Diagnostic: class {}, DiagnosticSeverity: { Error: 0 },
      window: {
        activeTextEditor: { document: { uri: { fsPath: path.join(project, 'Source', 'story.ni') }, async save() {} } },
        createOutputChannel: () => ({ clear() {}, show() {}, append: s => logs.push(s), appendLine: s => logs.push(s) }),
        showErrorMessage: s => errors.push(s), showWarningMessage: s => warnings.push(s), showInformationMessage: s => notices.push(s),
        createWebviewPanel(type) {
          if (type === 'informant.testManager') {
            managerPanel = { messages: [], reveal() {}, onDidDispose: disposable, onDidChangeViewState: disposable,
              webview: { onDidReceiveMessage(fn) { managerPanel.receive = fn; return disposable(); },
                async postMessage(message) { managerPanel.messages.push(message); return true; } } };
            return managerPanel;
          }
          panel = { reveal() {}, onDidDispose(fn) { this.onDispose = fn; }, dispose() { this.onDispose(); }, webview: {
            postMessage: message => evaluate(`(() => { window.dispatchEvent(new MessageEvent('message', { data: ${JSON.stringify(message)} })); return true; })()`),
            cspSource: origin,
            asWebviewUri: u => ({ toString: () => `${origin}/asset?file=${encodeURIComponent(u.fsPath)}` }),
            onDidReceiveMessage(fn) { panel.receive = fn; return { dispose() {} }; }
          } };
          return panel;
        }
      }
    };
    function load(name, overrides = {}) {
      const file = path.join(__dirname, '..', name);
      const localRequire = createRequire(file);
      const sandbox = { module: { exports: {} }, process, setTimeout, clearTimeout, AbortController, require: name => name === 'vscode' ? vscode : overrides[name] || localRequire(name) };
      vm.runInNewContext(require('node:fs').readFileSync(file, 'utf8'), sandbox, { filename: file });
      return sandbox.module.exports;
    }
    const player = load('quixe-player.js');
    t.after(() => player.shutdownPlayer());
    const extension = load('extension.js', { './test-manager': load('test-manager.js'), './quixe-player': player, './documentation-viewer': {}, './index-viewer': {} });
    extension.activate({ subscriptions: [], globalStorageUri: { fsPath: storage } });
    if (iskein) {
      await fs.mkdir(path.join(project, 'Build'));
      await fs.copyFile(path.join(original, 'Build', 'output-test.ulx'), path.join(project, 'Build', 'output-test.ulx'));
      await fs.cp(path.join(original, '.informant', 'test-vectors'), path.join(project, '.informant', 'test-vectors'), { recursive: true });
    } else await commands.get('informant.compileTestStory')();
    assert.deepEqual(errors, [], logs.join('\n'));
    const story = path.join(project, 'Build', 'output-test.ulx');
    assert.equal((await fs.readFile(story)).toString('ascii', 0, 4), 'Glul');
    const server = http.createServer(async (req, res) => {
      try {
        const url = new URL(req.url, origin);
        if (url.pathname === '/asset') {
          const file = await fs.realpath(url.searchParams.get('file'));
          const runtime = path.join(await fs.realpath(internal), 'Player', 'Quixe');
          if (!file.startsWith(runtime + path.sep)) throw new Error('Asset outside runtime');
          const type = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'image/gif';
          res.setHeader('Content-Type', type); res.end(await fs.readFile(file)); return;
        }
        res.setHeader('Content-Type', 'text/html');
        res.end(panel.webview.html.replace(/(<script nonce="[^"]+">)/, '$1window.__messages=[]; window.acquireVsCodeApi=()=>({postMessage:m=>window.__messages.push(m)});'));
      } catch (error) { res.statusCode = 500; res.end(error.message); }
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening'); origin = `http://127.0.0.1:${server.address().port}`;
    t.after(() => new Promise(resolve => server.close(resolve)));
    const socket = new WebSocket(endpoint);
    await once(socket, 'open');
    let next = 0;
    const pending = new Map();
    socket.addEventListener('message', event => {
      const response = JSON.parse(event.data);
      if (response.id) { pending.get(response.id)?.(response); pending.delete(response.id); }
    });
    function call(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = ++next;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`BiDi timeout: ${method}`)); }, 10000);
        pending.set(id, result => { clearTimeout(timer); result.type === 'error' ? reject(new Error(JSON.stringify(result))) : resolve(result.result); });
        socket.send(JSON.stringify({ id, method, params }));
      });
    }
    await call('session.new', { capabilities: {} });
    t.after(async () => {
      try { await call('session.end'); } finally { socket.close(); }
    });
    const { context } = await call('browsingContext.create', { type: 'tab' });
    async function evaluate(expression) {
      const response = await call('script.evaluate', { expression: `JSON.stringify(${expression})`, target: { context }, awaitPromise: true });
      if (response.type === 'exception') throw new Error(JSON.stringify(response.exceptionDetails));
      return response.result.value === undefined ? undefined : JSON.parse(response.result.value);
    }
    async function pump() {
      const messages = await evaluate('window.__messages.splice(0)');
      for (const message of messages) panel.receive(message);
      return messages;
    }
    async function waitFor(predicate) {
      for (let i = 0; i < 100; i++) {
        await pump();
        if (await predicate()) return;
        await new Promise(resolve => setTimeout(resolve, 30));
      }
      throw new Error(`Acceptance timeout; errors=${errors.join('; ')}`);
    }
    async function visit(command) {
      await commands.get(command)();
      assert.deepEqual(errors, []);
      await call('browsingContext.navigate', { context, url: origin + '/?run=' + Date.now(), wait: 'complete' });
      await waitFor(() => evaluate('!!document.querySelector(".Input")'));
    }
    async function enter(command) {
      // Drive the existing input control; transcript capture still uses only the structured hook.
      await evaluate(`(() => { const input = document.querySelector('.Input'); input.focus(); input.value = ${JSON.stringify(command)}; $(input).trigger($.Event('keypress', {which:13, keyCode:13})); return true; })()`);
      await pump();
    }
    async function savedCommands(expected) {
      await waitFor(async () => {
        const xml = await fs.readFile(destination, 'utf8');
        return (xml.match(/<command /g) || []).length === expected;
      });
    }
    if (iskein) {
      const { discoverTestVectors } = require('../test-vector-library');
      const vectors = (await discoverTestVectors(original)).vectors;
      const snapshots = await Promise.all([path.join(original, 'Skein.skein'), destination,
        ...vectors.flatMap(v => [v.file, path.join(project, '.informant', 'test-vectors', path.basename(v.file))])]
        .map(async file => ({ file, bytes: await fs.readFile(file), stat: await fs.stat(file) })));
      await commands.get('informant.openTestManager')();
      for (const name of ['Wait', 'I Quit']) {
        const vector = vectors.find(v => v.name === name);
        assert.ok(vector, `Saved ${name} vector is required`);
        managerPanel.receive({ type: 'testManager.selectVector', guid: vector.guid });
        for (let i = 0; i < 100 && managerPanel.messages.at(-1).selectedGuid !== vector.guid; i++) await new Promise(resolve => setTimeout(resolve, 10));
        assert.equal(managerPanel.messages.at(-1).selectedGuid, vector.guid);
        const oldHTML = panel?.webview.html;
        managerPanel.receive({ type: 'testManager.playVector' });
        for (let i = 0; i < 100 && (!panel || panel.webview.html === oldHTML); i++) await new Promise(resolve => setTimeout(resolve, 10));
        assert.ok(panel?.webview.html && panel.webview.html !== oldHTML, managerPanel.messages.at(-1).operation);
        assert.doesNotMatch(panel.webview.html, /installRoomQualification|recording_handler/);
        await call('browsingContext.navigate', { context, url: origin + '/?run=' + Date.now(), wait: 'complete' });
        const completed = name === 'Wait' ? 'ISkein playback complete. You can continue playing.' : 'ISkein playback complete: story terminated normally.';
        await waitFor(() => notices.includes(completed));
        const display = await evaluate('document.querySelector(".BufferWindow").textContent');
        const echoed = await evaluate('Array.from(document.querySelectorAll(".Style_input"), element => element.textContent)');
        assert.deepEqual(echoed, vector.turns.map(turn => turn.command), 'Every persisted command is visibly echoed in exact order');
        if (name === 'Wait') {
          assert.equal(await evaluate('!!document.querySelector(".Input")'), true);
          await enter('look');
          assert.notEqual(await evaluate('document.querySelector(".BufferWindow").textContent'), display);
          assert.equal(await evaluate('!!document.querySelector(".Input")'), true);
        } else assert.equal(await evaluate('!!document.querySelector(".Input")'), false);
        t.diagnostic(`${name}: ${vector.turns.length} saved commands visibly replayed; ${name === 'Wait' ? 'manual look accepted after completion' : 'normal termination completed without waiting for more input'}.`);
      }
      assert.deepEqual(errors, []); assert.deepEqual(warnings, []);
      for (const snapshot of snapshots) {
        assert.deepEqual(await fs.readFile(snapshot.file), snapshot.bytes);
        assert.equal((await fs.stat(snapshot.file)).mtimeMs, snapshot.stat.mtimeMs);
      }
      t.diagnostic('All saved vectors and Skein.skein bytes/mtimes unchanged in both original and disposable copy. No compilation.');
      return;
    }
    await visit('informant.recordSkein');
    await savedCommands(1);
    let xml = await fs.readFile(destination, 'utf8');
    assert.notEqual(xml, previous);
    assert.match(xml, /A Peach Beyond Reason/);
    for (const command of ['wait', 'wait', 'n', 'look', 's']) await enter(command);
    await savedCommands(6);
    await player.shutdownPlayer();
    xml = await fs.readFile(destination, 'utf8');
    const serialized = JSON.stringify(xml);
    const parsed = await evaluate(`(() => {
      const doc = new DOMParser().parseFromString(${serialized}, 'application/xml');
      return { errors: doc.getElementsByTagName('parsererror').length, root: doc.documentElement.getAttribute('rootNode'),
        active: doc.getElementsByTagName('activeNode')[0].getAttribute('nodeId'),
        items: Array.from(doc.getElementsByTagName('item'), item => ({ id: item.getAttribute('nodeId'),
          command: item.getElementsByTagName('command')[0].textContent,
          result: item.getElementsByTagName('result')[0].textContent,
          children: Array.from(item.getElementsByTagName('child'), child => child.getAttribute('nodeId')) })) };
    })()`);
    assert.equal(parsed.errors, 0);
    assert.equal(parsed.root, parsed.active);
    assert.deepEqual(parsed.items.map(i => i.command), ['- start -', 'wait', 'wait', 'n', 'look', 's']);
    assert.ok(parsed.items.every((i, n) => i.children.length === (n < 5 ? 1 : 0)));
    assert.match(parsed.items[1].result, /^Sunlight inches/);
    assert.match(parsed.items[2].result, /decisive ding\.\n\nBy the time/);
    assert.match(parsed.items[3].result, /DefectN Room/);
    assert.match(parsed.items[4].result, /DefectN Room/);
    assert.match(parsed.items[5].result, /Ripening Room/);
    assert.ok(parsed.items.every(i => i.result.endsWith('>')));
    assert.ok(!xml.includes('Score:') && !xml.includes('Moves:'));
    t.diagnostic(JSON.stringify(parsed.items.map(i => ({ command: i.command, result: i.result }))));
    const recordedDisplay = await evaluate('document.querySelector(".BufferWindow").textContent');
    const beforePlayback = await fs.readFile(destination);
    const beforeStat = await fs.stat(destination);
    await visit('informant.playSkein');
    await waitFor(() => notices.includes('Skein playback complete. You can continue playing.'));
    assert.equal(await evaluate('document.querySelector(".BufferWindow").textContent'), recordedDisplay,
      'fresh replay visibly reaches exactly the recorded transcript/final state');
    assert.deepEqual(await fs.readFile(destination), beforePlayback);
    assert.equal((await fs.stat(destination)).mtimeMs, beforeStat.mtimeMs);
    await enter('look');
    assert.notEqual(await evaluate('document.querySelector(".BufferWindow").textContent'), recordedDisplay);
    assert.equal(await evaluate('!!document.querySelector(".Input")'), true, 'human can continue after replay');
    await player.shutdownPlayer();
    assert.deepEqual(await fs.readFile(destination), beforePlayback);
    assert.deepEqual(warnings, []);
    t.diagnostic('Replay acceptance: wait, wait, n, look, s produced the same visible transcript; human look continued; Skein bytes and mtime unchanged.');
    await visit('informant.recordSkein'); await savedCommands(1);
    const fresh = await fs.readFile(destination, 'utf8');
    assert.ok(!fresh.includes('Sunlight inches'));
    for (const command of ['informant.play', 'informant.playForTest']) {
      await visit(command); await enter('wait'); await player.shutdownPlayer();
      assert.equal(await fs.readFile(destination, 'utf8'), fresh);
    }
    // Verify empty input against the actual packaged engine, without guessing at its echo newline.
    await visit('informant.recordSkein'); await enter(''); await savedCommands(2);
    await player.shutdownPlayer();
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /newline is preserved/);
    assert.deepEqual(errors, []);
    t.diagnostic('Real compiler and Quixe acceptance passed on a temporary PeachesNCream copy; supplied project and Skein were not changed.');
  });
