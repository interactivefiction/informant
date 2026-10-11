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
const { test } = require('node:test');
const assert = require('node:assert/strict');
const endpoint = location => ({ location, observation: 'CBF43926' });
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { Skein, parseLinearSkein } = require('../skein');
const manifest = require('../package.json');
const { createVector, serializeVector } = require('../iskein');
const { discoverTestVectors } = require('../test-vector-library');

function recorded(commands) {
  const skein = new Skein();
  for (const command of commands) {
    const item = skein.item(command);
    skein.items.at(-1).childId = item.id;
    skein.items.push(item);
  }
  return skein.serialize();
}
function event() {
  const listeners = new Set();
  return { subscribe(fn) { listeners.add(fn); return { dispose: () => listeners.delete(fn) }; },
    fire(value) { for (const fn of listeners) fn(value); }, size: () => listeners.size };
}
async function fixture(t) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'informant-test-manager-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, 'PeachesNCream.inform');
  await fs.mkdir(path.join(root, 'Source'), { recursive: true });
  // Only a filesystem marker is required; these tests never compile a story.
  await fs.writeFile(path.join(root, 'Source', 'story.ni'), '');
  const panels = [], watchers = [], errors = [], commands = new Map();
  const contexts = new Map();
  const configurationChanged = event();
  let sourceActions;
  const vscode = {
    commands: { executeCommand(command, key, value) {
      assert.equal(command, 'setContext');
      contexts.set(key, value);
    }, registerCommand(id, fn) { commands.set(id, fn); return { dispose() {} }; } },
    languages: { createDiagnosticCollection: () => ({ dispose() {} }) },
    Uri: { file: fsPath => ({ fsPath }) }, ViewColumn: { Active: 1 },
    RelativePattern: class { constructor(base, pattern) { this.base = base; this.pattern = pattern; } },
    workspace: { getConfiguration: () => ({ get: (key, fallback) => key === 'sourceActions' ? sourceActions ?? fallback : fallback }), onDidChangeConfiguration: configurationChanged.subscribe, workspaceFolders: [{ uri: { fsPath: root } }], createFileSystemWatcher(pattern) {
      const create = event(), change = event(), remove = event();
      const watcher = { pattern, create, change, remove, disposed: false,
        onDidCreate: create.subscribe, onDidChange: change.subscribe, onDidDelete: remove.subscribe,
        dispose() { this.disposed = true; } };
      watchers.push(watcher); return watcher;
    } },
    window: {
      activeTextEditor: { document: { uri: { fsPath: path.join(root, 'Source', 'story.ni') } } },
      createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }),
      showErrorMessage: message => errors.push(message),
      createWebviewPanel(type, title, column, options) {
        const receive = event(), dispose = event(), view = event();
        const panel = { type, title, options, receive, view, reveals: 0, messages: [], disposed: false,
          reveal() { this.reveals++; }, onDidDispose: dispose.subscribe, onDidChangeViewState: view.subscribe,
          dispose() { if (!this.disposed) { this.disposed = true; dispose.fire(); } },
          webview: { onDidReceiveMessage: receive.subscribe, async postMessage(message) { panel.messages.push(message); return true; } } };
        panels.push(panel); return panel;
      }
    }
  };
  function load(name, overrides = {}) {
    const file = path.join(__dirname, '..', name);
    const local = createRequire(file);
    const sandbox = { module: { exports: {} }, process, AbortController, require(id) {
      if (id === 'vscode') return vscode;
      if (Object.hasOwn(overrides, id)) return overrides[id];
      return local(id);
    } };
    vm.runInNewContext(require('node:fs').readFileSync(file, 'utf8'), sandbox, { filename: file });
    return sandbox.module.exports;
  }
  const manager = load('test-manager.js');
  const forbidden = () => { throw new Error('Compiler/player must not run'); };
  const extension = load('extension.js', { './test-manager': manager,
    './documentation-viewer': {}, './index-viewer': {}, './quixe-player': { openPlayer: forbidden, shutdownPlayer: forbidden },
    child_process: { exec: forbidden, execFile: forbidden } });
  const storage = new Map();
  const context = { subscriptions: [], globalState: {
    get: key => storage.get(key),
    async update(key, value) { storage.set(key, value); }
  } };
  extension.activate(context);
  t.after(() => { for (const p of panels) p.dispose(); });
  return { contexts, setSourceActions(value) {
    sourceActions = value;
    configurationChanged.fire({ affectsConfiguration: key => key === 'informant.sourceActions' });
  }, root, temp, panels, watchers, errors, commands, vscode, context, manager, load,
    open: () => commands.get('informant.openTestManager')(),
    state: () => panels.at(-1).messages.at(-1).skein };
}
async function settled(predicate) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('Panel update did not arrive');
}

test('exactly one public Test Manager command, registered and activated', async t => {
  const f = await fixture(t);
  const previous = ['playSkein', 'recordSkein', 'playForTest', 'compileTestStory', 'compile', 'compileAndPlay', 'play', 'showErrors', 'openDocs', 'openIndex', 'createProject', 'openProject', 'installExtension', 'clean', 'installToolchain', 'manageToolchains', 'selectToolchain', 'showStorage'];
  const expected = [...previous, 'openTestManager', 'configureSourceActions'].map(id => 'informant.' + id).sort();
  assert.deepEqual([...f.commands.keys()].sort(), expected);
  assert.deepEqual(manifest.contributes.commands.map(c => c.command).sort(), expected);
  assert.equal(manifest.contributes.commands.find(c => c.command === 'informant.openTestManager').title, 'Informant: Open Test Manager');
  assert.ok(manifest.activationEvents.includes('onCommand:informant.openTestManager'));
  assert.ok(manifest.contributes.menus.commandPalette.some(c => c.command === 'informant.openTestManager' && !c.when));
});

test('opens bound to the project, counts commands without writing or running compiler/player', async t => {
  const f = await fixture(t), file = path.join(f.root, 'Skein.skein');
  const xml = recorded(['wait', 'wait', 'n', 'look', 's']);
  await fs.writeFile(file, xml);
  const before = await fs.stat(file);
  await f.open();
  assert.equal(f.panels.length, 1);
  assert.equal(f.panels[0].messages.at(-1).project, await fs.realpath(f.root));
  assert.equal(f.state().status, 'available'); assert.equal(f.state().count, 5);
  assert.equal(await fs.readFile(file, 'utf8'), xml);
  assert.equal((await fs.stat(file)).mtimeMs, before.mtimeMs);
  assert.deepEqual(f.errors, []);
  assert.deepEqual(await fs.readdir(f.root), ['Skein.skein', 'Source']);
  assert.equal(f.watchers[0].pattern.pattern, 'Skein.skein');
});

test('missing, root-only, invalid XML/UTF-8 and unreadable Skeins have honest states', async t => {
  const f = await fixture(t), file = path.join(f.root, 'Skein.skein');
  await f.open(); assert.equal(f.state().status, 'missing');
  await fs.writeFile(file, recorded([])); await f.open(); assert.equal(f.state().count, 0);
  for (const bytes of ['<Skein/>', Buffer.from([0xff])]) {
    await fs.writeFile(file, bytes); await f.open();
    assert.equal(f.state().status, 'unsupported'); assert.equal(f.state().count, undefined);
  }
  await fs.unlink(file); await fs.mkdir(file); await f.open();
  assert.equal(f.state().status, 'unreadable'); assert.deepEqual(f.errors, []);
});

test('ready, refresh, visibility and file events update the fixed binding; disposal cleans subscriptions', async t => {
  const f = await fixture(t); await f.open();
  const panel = f.panels[0], watcher = f.watchers[0];
  for (const trigger of [() => panel.receive.fire({ type: 'testManager.ready' }),
    () => panel.receive.fire({ type: 'testManager.refresh', project: '/untrusted' }),
    () => panel.view.fire({ webviewPanel: { visible: true } }),
    () => watcher.create.fire(), () => watcher.change.fire(), () => watcher.remove.fire()]) {
    const before = panel.messages.length; trigger();
    await settled(() => panel.messages.length > before);
    assert.equal(panel.messages.at(-1).project, f.root);
  }
  await fs.writeFile(path.join(f.root, 'Skein.skein'), recorded(['look']));
  watcher.change.fire(); await settled(() => f.state().count === 1);
  await fs.unlink(path.join(f.root, 'Skein.skein'));
  watcher.remove.fire(); await settled(() => f.state().status === 'missing');
  await f.open(); assert.equal(f.panels.length, 1); assert.equal(panel.reveals, 1);
  const before = panel.messages.length;
  panel.receive.fire({ type: 'makeTestVector' });
  panel.receive.fire({ type: 'testManager.refresh' }); panel.dispose();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(panel.messages.length, before);
  for (const current of f.watchers) {
    assert.ok(current.disposed);
    assert.equal(current.create.size(), 0); assert.equal(current.change.size(), 0); assert.equal(current.remove.size(), 0);
  }
  assert.ok(watcher.disposed); assert.equal(watcher.change.size(), 0); assert.equal(panel.receive.size(), 0);
  await f.open(); assert.equal(f.panels.length, 2);
});

test('existing resolver uses workspace fallback, rejects non-projects, and keeps separate bindings', async t => {
  const f = await fixture(t);
  f.vscode.window.activeTextEditor = undefined;
  await f.open(); assert.equal(f.panels.length, 1);
  f.vscode.workspace.workspaceFolders = [{ uri: { fsPath: f.temp } }];
  await f.open(); assert.equal(f.panels.length, 1); assert.match(f.errors[0], /No Inform project/);
  // A second checkout of the same fixture, not a different Inform story.
  const second = path.join(f.temp, 'other-checkout', 'PeachesNCream.inform');
  await fs.mkdir(path.dirname(second)); await fs.cp(f.root, second, { recursive: true });
  f.vscode.workspace.workspaceFolders = [{ uri: { fsPath: second } }];
  await f.open(); assert.equal(f.panels.length, 2);
  assert.equal(f.panels[0].messages.at(-1).project, f.root);
  assert.equal(f.panels[1].messages.at(-1).project, second);
});

test('webview security, ready handshake, text-only rendering and conversion availability', async t => {
  const f = await fixture(t); await f.open(); const panel = f.panels[0];
  assert.equal(panel.options.enableScripts, true); assert.equal(panel.options.localResourceRoots.length, 0);
  const html = panel.webview.html;
  assert.match(html, /default-src 'none'/); assert.match(html, /script-src 'nonce-[^']+' 'unsafe-eval'/);
  assert.match(html, /frame-src blob:/);
  assert.doesNotMatch(html, /script-src[^;]*unsafe-inline/);
  assert.match(html, /<button[^>]*disabled[^>]*>Accept Starter Vector<\/button>/);
  assert.match(html, /Starter Recording/);
  assert.match(html, /Continuation Recording/);
  assert.doesNotMatch(html, /<h2>Working Recordings<\/h2>/);
  assert.equal(panel.messages.at(-1).continuation.exists, false);
  const nonce = /script-src 'nonce-([^']+)'/.exec(html)[1];
  assert.ok(html.includes(`<script nonce="${nonce}">`));
  const elements = {}, posted = []; let receive;
  const document = { getElementById(id) { return elements[id] ||= { textContent: '', addEventListener(type, fn) { this.click = fn; } }; } };
  vm.runInNewContext(/<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(html)[1], {
    document, acquireVsCodeApi: () => ({ postMessage: data => posted.push(data) }),
    window: { addEventListener(type, fn) { receive = fn; } }
  });
  assert.equal(posted[0].type, 'testManager.ready');
  receive({ data: { type: 'testManager.state', project: '<img onerror="bad()">', skein: { message: '<script>bad()</script>' } } });
  assert.equal(elements.project.textContent, '<img onerror="bad()">');
  assert.equal(elements.status.textContent, '<script>bad()</script>');
  assert.equal(elements['make-vector'].disabled, true);
  receive({ data: { type: 'testManager.state', project: 'project', skein: { status: 'available', count: 2, message: '2 commands' } } });
  assert.equal(elements['make-vector'].disabled, false);
  elements['make-vector'].click(); assert.equal(posted.at(-1).type, 'testManager.makeVector');
  receive({ data: { type: 'testManager.state', project: 'project', busy: true, skein: { status: 'available', count: 2 } } });
  assert.equal(elements['make-vector'].disabled, true);
  elements.refresh.click(); assert.equal(posted.at(-1).type, 'testManager.refresh');
});


test('newer refresh wins when reads finish out of order', async t => {
  const f = await fixture(t), reads = [];
  const manager = f.load('test-manager.js', { fs: { promises: { readFile: () => new Promise(resolve => reads.push(resolve)) } } });
  const opening = manager.openTestManager(f.root, f.context);
  const panel = f.panels[0];
  panel.receive.fire({ type: 'testManager.refresh' });
  reads[1](Buffer.from(recorded(['look', 'n'])));
  await settled(() => panel.messages.length === 1);
  reads[0](Buffer.from(recorded([]))); await opening;
  assert.equal(panel.messages.length, 1); assert.equal(panel.messages[0].skein.count, 2);
});

test('optional actual PeachesNCream observational acceptance', { skip: !process.env.SKEIN_PROJECT }, async t => {
  const f = await fixture(t), root = await fs.realpath(process.env.SKEIN_PROJECT);
  const file = path.join(root, 'Skein.skein');
  const before = await fs.readFile(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  const stat = before ? await fs.stat(file) : null;
  const storyFile = path.join(root, 'Build', 'output-test.ulx');
  const storyBefore = await fs.readFile(storyFile);
  const libraryBefore = await discoverTestVectors(root);
  const snapshots = await Promise.all(libraryBefore.vectors.map(async vector => ({ file: vector.file, bytes: await fs.readFile(vector.file), stat: await fs.stat(vector.file) })));
  f.vscode.window.activeTextEditor = { document: { uri: { fsPath: path.join(root, 'Source', 'story.ni') } } };
  await f.open();
  assert.deepEqual(f.errors, []);
  assert.equal(f.panels[0].messages.at(-1).project, root);
  if (before) {
    assert.equal(f.state().count, parseLinearSkein(before.toString('utf8')).length);
    assert.deepEqual(await fs.readFile(file), before);
    assert.equal((await fs.stat(file)).mtimeMs, stat.mtimeMs);
  } else {
    assert.equal(f.state().status, 'missing');
    await assert.rejects(fs.readFile(file), { code: 'ENOENT' });
  }
  const panel = f.panels[0];
  assert.deepEqual(panel.messages.at(-1).library, libraryBefore);
  for (const vector of libraryBefore.vectors) {
    panel.receive.fire({ type: 'testManager.selectVector', guid: vector.guid });
    await settled(() => panel.messages.at(-1).selectedGuid === vector.guid);
    assert.deepEqual(panel.messages.at(-1).library.vectors.find(v => v.guid === vector.guid), vector);
    t.diagnostic(JSON.stringify({ name: vector.name, guid: vector.guid, start: vector.start, end: vector.end, turns: vector.turnCount }));
  }
  for (const snapshot of snapshots) {
    assert.deepEqual(await fs.readFile(snapshot.file), snapshot.bytes);
    assert.equal((await fs.stat(snapshot.file)).mtimeMs, snapshot.stat.mtimeMs);
  }
  t.diagnostic(`PeachesNCream: ${snapshots.length} saved vectors inspected, bytes and mtimes unchanged.`);
  assert.deepEqual(await fs.readFile(storyFile), storyBefore);
  t.diagnostic('PeachesNCream: working Skein state and Test Story bytes unchanged.');
});

test('Test Manager conversion prompts, serializes duplicate clicks, refreshes success, and uses its bound project', async t => {
  const f = await fixture(t);
  const file = path.join(f.root, 'Skein.skein');
  await fs.writeFile(file, recorded(['wait', 'wait', 'n']));
  f.vscode.window.showInputBox = async () => '  My vector  ';
  let calls = 0;
  await f.manager.openTestManager(f.root, f.context, async commands => {
    calls++; assert.deepEqual(Array.from(commands), ['wait', 'wait', 'n']);
    return { start: endpoint('Ripening Room - room'), end: endpoint('DefectN Room') };
  });
  const panel = f.panels[0];
  panel.receive.fire({ type: 'testManager.makeVector', project: '/untrusted', name: 'ignored' });
  panel.receive.fire({ type: 'testManager.makeVector' });
  await settled(() => panel.messages.some(m => m.operation.startsWith('Created')));
  assert.equal(calls, 1);
  assert.match(panel.messages.at(-1).operation, /My vector/);
  assert.equal(panel.messages.at(-1).busy, false);
  assert.equal(panel.messages.at(-1).library.vectors.length, 1);
  assert.equal(panel.messages.at(-1).library.vectors[0].name, '  My vector  ');
  const library = path.join(f.root, '.informant', 'test-vectors');
  const files = await fs.readdir(library); assert.equal(files.length, 1);
  assert.match(await fs.readFile(path.join(library, files[0]), 'utf8'), /<name>  My vector  <\/name>/);
  await assert.rejects(fs.readFile(file), { code: 'ENOENT' });
  assert.equal(panel.messages.at(-1).skein.status, 'missing');
});

test('Test Manager reports failure and permits retry; blank name defaults and cancellation does not launch', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, 'Skein.skein'), recorded(['look']));
  let name, calls = 0;
  f.vscode.window.showInputBox = async () => name;
  await f.manager.openTestManager(f.root, f.context, async () => {
    if (++calls === 1) throw new Error('Runtime failed');
    return { start: endpoint('Ripening Room - room'), end: endpoint('Ripening Room - room') };
  });
  const panel = f.panels[0];
  panel.receive.fire({ type: 'testManager.makeVector' });
  await settled(() => panel.messages.at(-1).operation === 'Conversion cancelled.');
  assert.equal(calls, 0);
  name = '';
  panel.receive.fire({ type: 'testManager.makeVector' });
  await settled(() => panel.messages.at(-1).operation.includes('Runtime failed'));
  assert.equal(panel.messages.at(-1).busy, false);
  panel.receive.fire({ type: 'testManager.makeVector' });
  await settled(() => panel.messages.at(-1).operation.startsWith('Created'));
  assert.match(panel.messages.at(-1).operation, /Ripening Room - room [0-9A-F]{4}/);
});

test('disposing Test Manager aborts qualification and cannot publish a vector', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, 'Skein.skein'), recorded(['look']));
  f.vscode.window.showInputBox = async () => '';
  let signal, resolve;
  await f.manager.openTestManager(f.root, f.context, (_, current) => {
    signal = current; return new Promise(done => { resolve = done; });
  });
  const panel = f.panels[0]; panel.receive.fire({ type: 'testManager.makeVector' });
  await settled(() => !!resolve);
  const count = panel.messages.length; panel.dispose();
  assert.equal(signal.aborted, true);
  resolve({ start: endpoint('Room'), end: endpoint('Room') });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(panel.messages.length, count);
  await assert.rejects(fs.stat(path.join(f.root, '.informant', 'test-vectors')), /ENOENT/);
});

test('library events and explicit refresh retain valid selection and clear removed/invalid vectors', async t => {
  const f = await fixture(t); await f.open();
  const panel = f.panels[0], watcher = f.watchers[1];
  assert.equal(watcher.pattern.pattern, '.informant/test-vectors/**');
  const directory = path.join(f.root, '.informant', 'test-vectors');
  const vector = createVector({ entry: 'initial', name: 'Saved', start: endpoint('桃 — salle'), end: { type: 'termination' }, turns: [{ command: 'quit', result: 'Goodbye\n' }] });
  await fs.mkdir(directory, { recursive: true });
  const file = path.join(directory, vector.guid + '.iskein');
  await fs.writeFile(file, serializeVector(vector));
  watcher.create.fire();
  await settled(() => panel.messages.at(-1).library.vectors.length === 1);
  panel.receive.fire({ type: 'testManager.selectVector', guid: vector.guid });
  await settled(() => panel.messages.at(-1).selectedGuid === vector.guid);
  const count = panel.messages.length;
  panel.receive.fire({ type: 'testManager.selectVector', guid: '../untrusted.iskein' });
  assert.equal(panel.messages.length, count);
  vector.name = 'Updated';
  await fs.writeFile(file, serializeVector(vector));
  panel.receive.fire({ type: 'testManager.refresh' });
  await settled(() => panel.messages.at(-1).library.vectors[0].name === 'Updated');
  assert.equal(panel.messages.at(-1).selectedGuid, vector.guid);
  await fs.writeFile(file, '<broken>'); watcher.change.fire();
  await settled(() => panel.messages.at(-1).library.issues.length === 1);
  assert.equal(panel.messages.at(-1).selectedGuid, null);
  await fs.unlink(file); watcher.remove.fire();
  await settled(() => panel.messages.at(-1).library.issues.length === 0);
  assert.equal(panel.messages.at(-1).library.vectors.length, 0);
});

test('library browser selection renders identity, both endpoint forms and persisted transcript safely', async t => {
  const f = await fixture(t); await f.open();
  const descendants = node => node.children.flatMap(child => [child, ...descendants(child)]);
  const elements = {}, posted = []; let receive;
  function element(tag = '') {
    return { showModal() { this.open = true; }, close() { this.open = false; }, tag, children: [], dataset: {}, attrs: {}, textContent: '',
      appendChild(node) { this.children.push(node); }, replaceChildren() { this.children = []; },
      setAttribute(name, value) { this.attrs[name] = value; },
      addEventListener(type, fn) { this[type] = fn; }, focus() { document.activeElement = this; } };
  }
  const document = { createElement: element, getElementById(id) { return elements[id] ||= element(); } };
  vm.runInNewContext(/<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(f.panels[0].webview.html)[1], {
    document, acquireVsCodeApi: () => ({ postMessage: message => posted.push(message) }),
    window: { addEventListener(type, fn) { receive = fn; } }
  });
  const vector = createVector({ entry: 'initial', name: '<img onerror="bad()">', start: endpoint('桃 — salle'), end: endpoint('Final room'), turns: [{ command: '<script>command</script>', result: '  <b>result</b>\n\n🍑\r\n' }] });
  vector.turnCount = 1;
  const data = { type: 'testManager.state', project: f.root, skein: { status: 'missing' }, library: { status: 'available', vectors: [vector], issues: [] }, selectedGuid: null };
  receive({ data });
  const button = elements.vectors.children[0].children[0];
  assert.equal(button.textContent, vector.name); button.focus(); button.click();
  assert.equal(posted.at(-1).type, 'testManager.selectVector'); assert.equal(posted.at(-1).guid, vector.guid);
  assert.equal(descendants(elements['vector-details']).find(node => node.textContent === 'Play').disabled, true);
  data.selectedGuid = vector.guid; receive({ data });
  let play = descendants(elements['vector-details']).find(node => node.textContent === 'Play');
  assert.equal(play.disabled, false); play.click();
  assert.equal(posted.at(-1).type, 'testManager.playVector');
  const record = descendants(elements['vector-details']).find(node => node.textContent === 'Record Continuation');
  assert.equal(record.disabled, false); record.click();
  assert.equal(posted.at(-1).type, 'testManager.recordContinuation');
  data.busy = true; receive({ data });
  play = descendants(elements['vector-details']).find(node => node.textContent === 'Play');
  assert.equal(play.disabled, true);
  data.busy = false; receive({ data });
  assert.equal(elements.vectors.children[0].children[0].attrs['aria-pressed'], 'true');
  assert.equal(document.activeElement, elements.vectors.children[0].children[0]);
  const texts = node => [node.textContent, ...node.children.flatMap(texts)];
  let displayed = texts(elements['vector-details']);
  for (const value of [vector.name, 'GUID: ' + vector.guid, vector.start.location, vector.end.location, 'Observation (CRC-32): CBF43926', '> ' + vector.turns[0].command, vector.turns[0].result, 'Recorded Transcript — 1 turn']) assert.ok(displayed.includes(value), value);
  assert.ok(displayed.includes('Starter Vector'));
  vector.entry = 'continuation'; receive({ data });
  assert.equal(descendants(elements['vector-details']).find(node => node.textContent === 'Play').disabled, true);
  assert.ok(texts(elements['vector-details']).includes('Continuation Vector'));
  assert.equal(descendants(elements['vector-details']).find(node => node.textContent === 'Record Continuation').disabled, true);
  assert.ok(texts(elements['vector-details']).some(text => text.includes('Requires prior state/composition')));
  assert.match(elements.vectors.children[0].children[1].textContent, /Continuation Vector/);
  vector.entry = 'initial'; vector.end = { type: 'termination' }; receive({ data });
  assert.equal(descendants(elements['vector-details']).find(node => node.textContent === 'Record Continuation').disabled, true);
  displayed = texts(elements['vector-details']);
  assert.ok(displayed.includes('Termination — normal story termination (leaf endpoint).'));
  assert.equal(displayed.filter(text => text.startsWith('Observation')).length, 1);
  data.selectedGuid = null; data.continuationOrigin = { name: 'Nested route' }; receive({ data });
  const liveRecord = descendants(elements['vector-details']).find(node => node.textContent === 'Record Continuation');
  assert.equal(liveRecord.disabled, false);
  assert.match(liveRecord.title, /Nested route/);
  data.continuation = { exists: true }; receive({ data });
  assert.equal(descendants(elements['vector-details']).find(node => node.textContent === 'Record Continuation').disabled, true);
  data.continuation = { exists: false }; data.continuationOrigin = undefined; receive({ data });
  assert.equal(descendants(elements['vector-details']).find(node => node.textContent === 'Record Continuation').disabled, true);
  data.library.issues = [{ file: 'bad.iskein', message: '<script>invalid</script>' }]; receive({ data });
  assert.equal(elements['library-issues'].children[0].textContent, 'bad.iskein: <script>invalid</script>');
});

for (const end of [endpoint('Room'), { type: 'termination' }]) test(`Play ISkein reads selected transcript, ignores results and preserves files (${end.type || 'location'})`, async t => {
  const f = await fixture(t), calls = [];
  const directory = path.join(f.root, '.informant', 'test-vectors');
  await fs.mkdir(directory, { recursive: true });
  const vector = createVector({ entry: 'initial', name: 'Replay', start: endpoint('Room'), end,
    turns: ['wait', 'quit', 'y'].map(command => ({ command, result: 'Deliberately different runtime output' })) });
  const file = path.join(directory, vector.guid + '.iskein');
  await fs.writeFile(file, serializeVector(vector));
  const skein = path.join(f.root, 'Skein.skein');
  await fs.writeFile(skein, recorded(['unrelated']));
  const before = await Promise.all([file, skein].map(async file => ({ bytes: await fs.readFile(file), stat: await fs.stat(file) })));
  let release;
  await f.manager.openTestManager(f.root, f.context, () => assert.fail('No qualification'), async (...args) => {
    calls.push(args); await new Promise(resolve => { release = resolve; });
  });
  const panel = f.panels[0];
  panel.receive.fire({ type: 'testManager.playVector', guid: vector.guid });
  await settled(() => panel.messages.at(-1).operation.includes('Select a valid'));
  assert.equal(calls.length, 0);
  panel.receive.fire({ type: 'testManager.selectVector', guid: vector.guid });
  await settled(() => panel.messages.at(-1).selectedGuid === vector.guid);
  panel.receive.fire({ type: 'testManager.playVector', commands: ['rogue'], project: '/untrusted' });
  panel.receive.fire({ type: 'testManager.playVector' });
  await settled(() => !!release);
  assert.equal(calls.length, 1);
  assert.deepEqual(Array.from(calls[0][0]), ['wait', 'quit', 'y']);
  assert.equal(calls[0][1], end.type || 'location');
  release(); await settled(() => !panel.messages.at(-1).busy);
  assert.match(panel.messages.at(-1).operation, /^Playing/);
  for (const [index, name] of [file, skein].entries()) {
    assert.deepEqual(await fs.readFile(name), before[index].bytes);
    assert.equal((await fs.stat(name)).mtimeMs, before[index].stat.mtimeMs);
  }
  await fs.writeFile(file, '<broken>');
  panel.receive.fire({ type: 'testManager.playVector' });
  await settled(() => panel.messages.at(-1).operation.includes('Select a valid'));
  assert.equal(calls.length, 1, 'revalidates stale selection before launching');
});

for (const end of [endpoint('Room'), { type: 'termination' }]) {
  for (const stale of [false, true]) test(`continuation cannot launch standalone (${end.type || 'location'}, stale initial selection=${stale})`, async t => {
    const f = await fixture(t);
    const directory = path.join(f.root, '.informant', 'test-vectors');
    await fs.mkdir(directory, { recursive: true });
    const vector = createVector({ entry: stale ? 'initial' : 'continuation', start: endpoint('Room'), end,
      turns: [{ command: 'wait', result: 'Time passes.' }] });
    const file = path.join(directory, vector.guid + '.iskein');
    await fs.writeFile(file, serializeVector(vector));
    await f.manager.openTestManager(f.root, f.context, () => assert.fail('No qualification'), () => assert.fail('No fresh launch'));
    const panel = f.panels[0];
    panel.receive.fire({ type: 'testManager.selectVector', guid: vector.guid });
    await settled(() => panel.messages.at(-1).selectedGuid === vector.guid);
    if (stale) await fs.writeFile(file, serializeVector({ ...vector, entry: 'continuation' }));
    const before = await fs.readFile(file), stat = await fs.stat(file);
    panel.receive.fire({ type: 'testManager.playVector', entry: 'initial' });
    await settled(() => !panel.messages.at(-1).busy && panel.messages.at(-1).operation.includes('requires prior state/composition'));
    assert.deepEqual(await fs.readFile(file), before);
    assert.equal((await fs.stat(file)).mtimeMs, stat.mtimeMs);
  });
}

for (const entry of ['initial', 'continuation']) {
  for (const termination of [false, true]) test(`Record Continuation revalidates selected entry=${entry}, termination=${termination}`, async t => {
    const f = await fixture(t), launches = [];
    const directory = path.join(f.root, '.informant', 'test-vectors'); await fs.mkdir(directory, { recursive: true });
    const vector = createVector({ entry: 'initial', start: endpoint('Room'), end: endpoint('Room'), turns: [{ command: 'wait', result: 'Original result' }] });
    const file = path.join(directory, `${vector.guid}.iskein`);
    await fs.writeFile(file, serializeVector(vector));
    await f.manager.openTestManager(f.root, f.context, () => assert.fail('No qualification'), () => assert.fail('No direct play'), async selected => launches.push(selected));
    const panel = f.panels[0];
    panel.receive.fire({ type: 'testManager.selectVector', guid: vector.guid });
    await settled(() => panel.messages.at(-1).selectedGuid === vector.guid);
    vector.entry = entry; if (termination) vector.end = { type: 'termination' };
    const xml = serializeVector(vector); await fs.writeFile(file, xml);
    panel.receive.fire({ type: 'testManager.recordContinuation', entry: 'initial', commands: ['rogue'] });
    await settled(() => !panel.messages.at(-1).busy && /^(Replaying|Continuation record failed)/.test(panel.messages.at(-1).operation));
    assert.equal(launches.length, entry === 'initial' && !termination ? 1 : 0);
    if (launches.length) assert.deepEqual(launches[0].turns, vector.turns);
    else assert.match(panel.messages.at(-1).operation, /prior state|terminated story/);
    assert.equal(await fs.readFile(file, 'utf8'), xml);
  });
}

test('pane filters and host-backed composition assembly retain stable controls', async t => {
  const f = await fixture(t); await f.open();
  const elements = {}, posted = []; let receive, saved;
  function element() {
    return { showModal() { this.open = true; }, close() { this.open = false; }, children: [], dataset: {}, attrs: {}, textContent: '', scrollTop: 0,
      appendChild(node) { this.children.push(node); }, replaceChildren() { this.children = []; },
      setAttribute(key, value) { this.attrs[key] = value; }, addEventListener(key, fn) { this[key] = fn; },
      focus() { document.activeElement = this; } };
  }
  const document = { createElement: element, getElementById(id) { return elements[id] ||= element(); } };
  const html = f.panels[0].webview.html;
  vm.runInNewContext(/<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(html)[1], {
    document, acquireVsCodeApi: () => ({ postMessage: msg => posted.push(msg), setState: state => { saved = state; } }),
    window: { addEventListener(type, fn) { receive = fn; } }
  });
  const vectors = ['Zulu', 'Alpha', 'Beta'].map((name, i) => ({ ...createVector({ name, entry: i === 1 ? 'continuation' : 'initial', start: endpoint('Room'), end: endpoint('Room'), turns: [{ command: 'look', result: 'Room' }] }), turnCount: 1 }));
  const { createWorkingComposition, compositionView, editMembers, resolver } = require('../icomposition');
  const playables = vectors.map(value => ({ ...value, type: 'iskein' }));
  let working = createWorkingComposition();
  const before = JSON.stringify(vectors);
  const data = { type: 'testManager.state', project: f.root, skein: { status: 'missing' }, continuation: { exists: false, canAccept: false }, library: { status: 'available', vectors, issues: [] }, selectedGuid: vectors[0].guid };
  data.composition = compositionView(working, playables);
  receive({ data });
  const clickAction = id => {
    const list = id === 'add-member' ? elements.playables : elements.members;
    list.children.flatMap(row => row.children).find(node => node.id === id).click();
    const message = posted.at(-1);
    working = editMembers(working, message.action, message.index, message.reference, resolver(playables));
    data.composition = compositionView(working, playables);
    receive({ data });
  };
  const names = id => elements[id].children.map(row => row.children[0]?.textContent);
  const change = (id, value, event = 'change') => { elements[id].value = value; elements[id][event](); };
  assert.deepEqual(names('vectors'), ['Alpha', 'Beta', 'Zulu']);
  change('library-search', 'zU', 'input'); assert.deepEqual(names('vectors'), ['Zulu']);
  change('library-search', '', 'input'); change('library-type', 'continuation'); assert.deepEqual(names('vectors'), ['Alpha']);
  assert.equal(elements['vector-details'].children[0].children[0].children[0].textContent, 'Zulu', 'filtering retains selected details');
  change('library-type', 'initial'); assert.deepEqual(names('vectors'), ['Beta', 'Zulu']);
  change('library-type', 'all'); change('library-sort', 'za'); assert.deepEqual(names('vectors'), ['Zulu', 'Beta', 'Alpha']);
  change('library-sort', 'type'); assert.deepEqual(names('vectors'), ['Alpha', 'Beta', 'Zulu']);
  assert.equal(saved.filters.library.sort, 'type');
  elements['vector-details'].scrollTop = 120; receive({ data }); assert.equal(elements['vector-details'].scrollTop, 120);
  data.selectedGuid = vectors[1].guid; receive({ data }); assert.equal(elements['vector-details'].scrollTop, 0);
  assert.equal(elements.playables.children.flatMap(row => row.children).find(node => node.id === 'add-member'), undefined);
  elements.playables.children[0].children[0].focus();
  elements.playables.children[0].children[0].click();
  assert.equal(document.activeElement, elements.playables.children[0].children[0], 'selection preserves focus for keyboard navigation');
  const append = elements.playables.children[0].children.find(node => node.id === 'add-member');
  assert.equal(append.disabled, false);
  append.focus(); receive({ data });
  assert.equal(document.activeElement, elements.playables.children[0].children.find(node => node.id === 'add-member'), 'refresh preserves Add focus');
  assert.deepEqual(names('playables'), ['Beta', 'Zulu']);
  assert.ok(elements.playables.children.every(row => !row.className));
  clickAction('add-member'); assert.deepEqual(names('members'), ['1. Beta']);
  assert.deepEqual(names('playables'), ['Alpha', 'Beta', 'Zulu']);
  assert.equal(elements.playables.children[0].className, 'candidate-strong');
  assert.ok(!elements.playables.children[1].className);
  assert.equal(elements.playables.children.flatMap(row => row.children).find(node => node.id === 'add-member').disabled, true, 'the last playable cannot be added again');
  const disabledAppend = elements.playables.children.flatMap(row => row.children).find(node => node.id === 'add-member');
  assert.equal(disabledAppend.title, data.composition.candidates.find(candidate => candidate.guid === vectors[2].guid).reason);
  assert.equal(disabledAppend.attrs['aria-describedby'], 'append-guidance');
  assert.equal(elements['move-up'], undefined); assert.equal(elements['move-down'], undefined);
  elements.playables.children[0].children[0].click(); clickAction('add-member');
  elements.members.children[0].children[0].click();
  assert.equal(elements['composition-name'].value, '');
  change('playables-sort', 'za'); change('playables-search', 'Zulu', 'input');
  assert.deepEqual(names('members'), ['1. Beta', '2. Alpha']); assert.equal(elements.playables.children.flatMap(row => row.children).find(node => node.id === 'add-member'), undefined);
  assert.equal(elements.members.children[0].children.some(node => node.id === 'remove-member'), false);
  clickAction('remove-member');
  assert.deepEqual(names('members'), ['1. Beta'], 'removal targets the last row even when an earlier row is selected');
  clickAction('remove-member');
  assert.equal(elements.members.children.flatMap(row => row.children).find(node => node.id === 'remove-member'), undefined); assert.deepEqual(names('members'), []);
  for (const populated of [true, false]) {
    data.skein = { status: populated ? 'available' : 'missing', count: populated ? 2 : 0 };
    data.continuation = { exists: populated, canAccept: populated };
    receive({ data });
    assert.equal(elements.status.hidden, !populated);
    assert.equal(elements['continuation-status'].hidden, !populated);
    for (const id of ['make-vector', 'accept-continuation', 'discard-continuation']) assert.equal(elements[id].disabled, !populated);
  }
  elements['compositions-tab'].click(); assert.equal(elements['vectors-view'].hidden, true);
  elements['vectors-tab'].click(); assert.equal(elements['vectors-view'].hidden, false);
  assert.equal(JSON.stringify(vectors), before);
  assert.equal(posted[0].type, 'testManager.ready');
  assert.ok(posted.slice(1).every(msg => ['testManager.composition', 'testManager.tab'].includes(msg.type)));
  assert.equal(elements['save-composition'].disabled, true);
  assert.match(html, /\.scroll-list \{[^}]*min-height: 0; overflow: auto/);
  assert.match(html, /#vector-details \{[^}]*min-height: 0; overflow: auto/);
  assert.doesNotMatch(html, /body \{ overflow: auto/);
  assert.doesNotMatch(html, /assembly-actions|<button id="(?:add|remove)-member"/);
  assert.match(html, /\.working-region \{[^}]*max-height: 26vh/);
});

test('composition host creates, saves, loads, renames and reports broken members without compiler/player work', async t => {
  const f = await fixture(t);
  const vector = createVector({ name: 'Starter <&>', entry: 'initial', start: endpoint('A'), end: endpoint('B'), turns: [] });
  const directory = path.join(f.root, '.informant', 'test-vectors'); await fs.mkdir(directory, { recursive: true });
  const vectorFile = path.join(directory, `${vector.guid}.iskein`); await fs.writeFile(vectorFile, serializeVector(vector));
  await f.open(); const panel = f.panels[0];
  const state = () => panel.messages.at(-1);
  async function action(action, extra = {}) {
    const before = panel.messages.length;
    panel.receive.fire({ type: 'testManager.composition', action, ...extra, project: '/untrusted' });
    await settled(() => panel.messages.length > before && !state().busy);
  }
  assert.equal(state().composition.members.length, 0);
  await action('save'); assert.match(state().operation, /at least one/);
  await action('add', { reference: { type: 'iskein', guid: vector.guid } });
  assert.equal(state().composition.members[0].playable.name, vector.name);
  assert.equal(state().composition.name, '');
  assert.equal(state().composition.error, '');
  let answer;
  const prompts = [];
  f.vscode.window.showInputBox = async options => { prompts.push(options); return answer; };
  await action('save');
  assert.equal(state().composition.committed, null, 'cancelling keeps the working composition');
  assert.equal(state().composition.members.length, 1);
  await assert.rejects(fs.access(path.join(f.root, '.informant', 'compositions')), { code: 'ENOENT' });
  assert.equal(prompts[0].value, '');
  assert.ok(prompts[0].validateInput('   '));
  assert.equal(prompts[0].validateInput('Named'), undefined);
  answer = '   ';
  await action('save'); assert.match(state().operation, /name is required/);
  assert.equal(state().composition.committed, null);
  answer = '  Prompted name  ';
  await action('save'); assert.match(state().operation, /Saved/);
  assert.equal(state().composition.committed.name, 'Prompted name');
  f.vscode.window.showInputBox = async options => options.title === 'New Composition' ? 'New composition' : options.value;
  await action('name', { name: 'My Composition' }); assert.equal(state().composition.error, '');
  await action('save'); assert.match(state().operation, /Saved/);
  const guid = state().composition.committed.guid;
  const compositionFile = path.join(f.root, '.informant', 'compositions', `${guid}.icomposition`);
  const original = await fs.readFile(compositionFile, 'utf8');
  await action('new'); assert.equal(state().composition.members.length, 0);
  await action('load', { reference: { type: 'icomposition', guid } });
  assert.equal(state().composition.name, 'My Composition');
  // Input and save arrive back-to-back: serialized host messages preserve the edit.
  panel.receive.fire({ type: 'testManager.composition', action: 'name', name: 'Renamed' });
  panel.receive.fire({ type: 'testManager.composition', action: 'save' });
  await settled(() => state().composition.committed.name === 'Renamed');
  assert.equal(state().composition.committed.guid, guid);
  assert.notEqual(await fs.readFile(compositionFile, 'utf8'), original);
  await action('add', { reference: { type: 'icomposition', guid } });
  assert.match(state().operation, /cycle/); assert.equal(state().composition.members.length, 1);
  await fs.unlink(vectorFile);
  const watcher = f.watchers.find(value => value.pattern.pattern === '.informant/compositions/**');
  watcher.change.fire(); await settled(() => state().composition.members[0].playable === null);
  assert.equal(state().composition.members[0].guid, vector.guid);
  assert.deepEqual(state().composition.committed.start, vector.start);
  assert.equal(state().composition.start, null);
  assert.match(state().composition.error, /Missing iskein/);
  await action('save'); assert.match(state().operation, /Missing iskein/);
  panel.dispose(); await f.open();
  const reopened = f.panels.at(-1);
  reopened.receive.fire({ type: 'testManager.composition', action: 'load', reference: { type: 'icomposition', guid } });
  await settled(() => reopened.messages.at(-1).composition.committed?.guid === guid);
  assert.equal(reopened.messages.at(-1).composition.members[0].playable, null);
});

test('composition browser distinguishes nested Playables, keeps broken identities and stable save/load controls', async t => {
  const f = await fixture(t); await f.open();
  const { compositionView, createWorkingComposition, commitComposition, resolver, reference } = require('../icomposition');
  const a = { ...createVector({ name: 'Starter', entry: 'initial', start: endpoint('A'), end: endpoint('B'), turns: [] }), type: 'iskein' };
  const child = { ...commitComposition({ name: 'Nested <script>', members: [reference(a)] }, resolver([a])), type: 'icomposition' };
  const missing = { type: 'iskein', guid: require('node:crypto').randomUUID() };
  const parent = { ...child, guid: require('node:crypto').randomUUID(), members: [missing, reference(child)] };
  const elements = {}, posted = []; let receive;
  function element() {
    return { showModal() { this.open = true; }, close() { this.open = false; }, children: [], dataset: {}, attrs: {}, textContent: '', scrollTop: 0,
      appendChild(node) { this.children.push(node); }, replaceChildren() { this.children = []; },
      setAttribute(key, value) { this.attrs[key] = value; }, addEventListener(key, fn) { this[key] = fn; },
      focus() { document.activeElement = this; } };
  }
  const document = { createElement: element, getElementById(id) { return elements[id] ||= element(); } };
  vm.runInNewContext(/<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(f.panels[0].webview.html)[1], {
    document, acquireVsCodeApi: () => ({ postMessage: msg => posted.push(msg) }), window: { addEventListener(type, fn) { receive = fn; } }
  });
  const data = { type: 'testManager.state', project: f.root, skein: {}, library: { vectors: [], issues: [] },
    composition: compositionView(createWorkingComposition(parent), [a, child]) };
  receive({ data });
  assert.equal(elements.playables.children.length, 2, 'nested composition is one Playable');
  assert.equal(elements.members.children.length, 2);
  assert.match(elements.members.children[0].children[0].textContent, new RegExp('Missing iskein: ' + missing.guid));
  assert.match(elements.members.children[1].children[0].textContent, /Nested <script>/);
  assert.equal(elements['save-composition'].disabled, true);
  elements['playables-type'].value = 'composition'; elements['playables-type'].change();
  assert.equal(elements.playables.children.length, 1);
  elements.playables.children[0].children[0].click(); assert.equal(elements['load-composition'].disabled, false);
  elements['load-composition'].click(); assert.equal(posted.at(-1).action, 'load');
  assert.equal(posted.at(-1).reference.type, 'icomposition');
  data.composition = compositionView(createWorkingComposition(child), [a, child]); receive({ data });
  assert.equal(elements['save-composition'].disabled, false);
  for (const id of ['play-composition', 'record-composition-continuation']) assert.equal(elements[id].disabled, false);
  elements['record-composition-continuation'].click();
  assert.equal(posted.at(-1).action, 'record');
  for (const update of [
    { composition: compositionView(createWorkingComposition(), [a, child]) },
    { composition: { ...data.composition, name: 'Unsaved edit' } },
    { busy: true }
  ]) {
    receive({ data: { ...data, ...update } });
    for (const id of ['play-composition', 'record-composition-continuation']) assert.equal(elements[id].disabled, true);
  }
  receive({ data: { ...data, continuation: { exists: true } } });
  assert.equal(elements['record-composition-continuation'].disabled, true);
  receive({ data: { ...data, composition: { ...data.composition, end: { type: 'termination' } } } });
  assert.equal(elements['record-composition-continuation'].disabled, true);
  receive({ data });
  assert.equal(elements.playables.children.flatMap(row => row.children).find(node => node.id === 'add-member').disabled, true, 'self-cycle disabled with host-derived reason');
  const texts = node => [node.textContent, ...node.children.flatMap(texts)].join('\n');
  assert.match(texts(elements.playables), /cycle/);
  assert.match(texts(elements['composition-endpoints']), /Working START/);
  assert.match(texts(elements['composition-endpoints']), /Committed END/);
  data.busy = true; receive({ data });
  for (const id of ['save-composition', 'new-composition', 'load-composition', 'add-member', 'remove-member']) {
    const control = id === 'add-member' || id === 'remove-member'
      ? [...elements.playables.children, ...elements.members.children].flatMap(row => row.children).find(node => node.id === id)
      : elements[id];
    assert.equal(control.disabled, true, id); assert.notEqual(control.hidden, true, id);
  }
});

test('New Composition names empty work and protects unsaved members and edits', async t => {
  const f = await fixture(t);
  const vector = createVector({ name: 'Starter', entry: 'initial', start: endpoint('A'), end: endpoint('B'), turns: [] });
  const directory = path.join(f.root, '.informant', 'test-vectors');
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, `${vector.guid}.iskein`), serializeVector(vector));
  await f.open();
  const panel = f.panels[0], state = () => panel.messages.at(-1);
  const prompts = [], warnings = [];
  let newName = '  First  ', choice;
  let cancelSave = false;
  f.vscode.window.showInputBox = async options => {
    prompts.push(options);
    return options.title === 'New Composition' ? newName : cancelSave ? undefined : options.value;
  };
  f.vscode.window.showWarningMessage = async (...args) => { warnings.push(args); return choice; };
  async function action(action, extra = {}) {
    const count = panel.messages.length;
    panel.receive.fire({ type: 'testManager.composition', action, ...extra });
    await settled(() => panel.messages.length > count && !state().busy);
  }
  await action('new');
  assert.equal(state().composition.name, 'First');
  assert.equal(warnings.length, 0);
  await action('add', { reference: { type: 'iskein', guid: vector.guid } });
  assert.equal(state().composition.error, '');
  await action('new'); // Cancel the unsaved-changes dialog.
  assert.equal(state().composition.name, 'First');
  assert.equal(state().composition.members.length, 1);
  choice = 'Save'; cancelSave = true;
  await action('new');
  assert.equal(state().composition.committed, null);
  assert.equal(state().composition.members.length, 1);
  cancelSave = false; newName = 'Second';
  await action('new');
  assert.equal(prompts.at(-2).title, 'Save Composition');
  assert.equal(prompts.at(-2).value, 'First');
  assert.equal(prompts.at(-1).title, 'New Composition');
  assert.equal(state().composition.name, 'Second');
  assert.equal(state().composition.members.length, 0);
  const { discoverCompositions } = require('../composition-library');
  const saved = (await discoverCompositions(f.root)).compositions[0];
  assert.equal(saved.name, 'First');
  await action('load', { reference: { type: 'icomposition', guid: saved.guid } });
  const warningCount = warnings.length;
  newName = undefined;
  await action('new'); // Saved work needs no warning; cancelled naming preserves it.
  assert.equal(warnings.length, warningCount);
  assert.equal(state().composition.committed.guid, saved.guid);
  await action('name', { name: 'Edited' });
  choice = 'Discard';
  await action('new');
  assert.equal(warnings.length, warningCount + 1);
  assert.equal(state().composition.name, 'Edited', 'cancelled naming preserves discarded work until replacement');
  newName = 'Third';
  await action('new');
  assert.equal(state().composition.name, 'Third');
  assert.equal(state().composition.members.length, 0);
  assert.equal((await discoverCompositions(f.root)).compositions[0].name, 'First');
  await action('add', { reference: { type: 'iskein', guid: vector.guid } });
  await action('remove', { index: 0 });
  await action('add', { reference: { type: 'iskein', guid: vector.guid } });
  await fs.unlink(path.join(directory, `${vector.guid}.iskein`));
  choice = 'Save'; newName = 'Fourth';
  await action('new');
  assert.match(state().operation, /Missing iskein/);
  assert.equal(state().composition.name, 'Third', 'failed save preserves unsaved work');
});

test('Play Composition launches accepted disk snapshot and reports completion without mutating artifacts', async t => {
  const f=await fixture(t), calls=[];
  const { serializeComposition }=require('../icomposition');
  const { randomUUID }=require('node:crypto');
  const a=createVector({ entry:'initial',name:'First',start:endpoint('Room'),end:endpoint('Room'),turns:[{ command:'look',result:'' }] });
  const c={ guid:randomUUID(),name:'Route',entry:'initial',start:a.start,end:a.end,members:[{ type:'iskein',guid:a.guid }] };
  for (const directory of ['test-vectors','compositions']) await fs.mkdir(path.join(f.root,'.informant',directory),{ recursive:true });
  const file=path.join(f.root,'.informant','compositions',c.guid+'.icomposition'), source=serializeComposition(c);
  await fs.writeFile(file,source);
  await fs.writeFile(path.join(f.root,'.informant','test-vectors',a.guid+'.iskein'),serializeVector(a));
  await f.manager.openTestManager(f.root,f.context,()=>{},async (...args)=>calls.push(args));
  const panel=f.panels.at(-1);
  assert.match(panel.webview.html,/id="play-composition" disabled/);
  panel.receive.fire({ type:'testManager.composition',action:'load',reference:{ type:'icomposition',guid:c.guid } });
  await settled(()=>panel.messages.at(-1).composition.committed?.guid===c.guid);
  panel.receive.fire({ type:'testManager.composition',action:'play',commands:['rogue'] });
  await settled(()=>calls.length===1 && !panel.messages.at(-1).busy);
  assert.deepEqual(calls[0][0],['look']);
  assert.equal(calls[0][3].guid,c.guid);
  calls[0][4]({ kind:'complete',message:'Composition Route complete. You can continue playing.' });
  await settled(()=>panel.messages.at(-1).operation.includes('complete'));
  assert.equal(await fs.readFile(file,'utf8'),source);
  panel.receive.fire({ type:'testManager.composition',action:'name',name:'Unsaved' });
  await settled(()=>panel.messages.at(-1).composition.name==='Unsaved');
  panel.receive.fire({ type:'testManager.composition',action:'play' });
  await settled(()=>panel.messages.at(-1).operation.includes('failed'));
  assert.equal(calls.length,1);
});

test('live composition origin enables existing continuation workflow without a selected vector or replay', async t => {
  const f = await fixture(t), calls = [], changes = event();
  let origin = { name: 'Nested route' };
  await f.manager.openTestManager(f.root, f.context, () => {}, () => {}, () => assert.fail('Must not replay a vector'), {
    continuationOrigin: project => { assert.equal(project, f.root); return origin; },
    onPlaybackSessionChange: changes.subscribe,
    recordLiveContinuation: async project => { calls.push(project); origin = undefined; changes.fire(); }
  });
  const panel = f.panels.at(-1);
  assert.equal(panel.messages.at(-1).selectedGuid, null);
  assert.equal(panel.messages.at(-1).continuationOrigin.name, 'Nested route');
  panel.receive.fire({ type: 'testManager.recordContinuation' });
  await settled(() => calls.length === 1 && !panel.messages.at(-1).busy);
  assert.match(panel.messages.at(-1).operation, /live END/);
  assert.equal(panel.messages.at(-1).continuationOrigin, undefined);
  panel.dispose();
  assert.equal(changes.size(), 0);
});

test('composition continuation replays the loaded disk commands and rejects unloaded or dirty work', async t => {
  const f = await fixture(t), calls = [];
  const { saveComposition } = require('../composition-library');
  const vector = createVector({ entry: 'initial', name: 'Start', start: endpoint('A'), end: endpoint('B'),
    turns: [{ command: 'east', result: '' }, { command: 'look', result: '' }] });
  const directory = path.join(f.root, '.informant', 'test-vectors');
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, vector.guid + '.iskein'), serializeVector(vector));
  const composition = await saveComposition(f.root, { name: 'Route', members: [{ type: 'iskein', guid: vector.guid }] });
  await f.manager.openTestManager(f.root, f.context, () => {}, () => assert.fail('Playback callback should not run'),
    async (...args) => calls.push(args));
  const panel = f.panels.at(-1);
  assert.match(panel.webview.html, /Save Composition<\/button><button id="play-composition" disabled>Play Composition<\/button><button id="record-composition-continuation" disabled>Record Continuation/);
  async function action(action, extra = {}) {
    const count = panel.messages.length;
    panel.receive.fire({ type: 'testManager.composition', action, ...extra });
    await settled(() => panel.messages.length > count && !panel.messages.at(-1).busy);
  }
  await action('record');
  assert.equal(calls.length, 0);
  await action('load', { reference: { type: 'icomposition', guid: composition.guid } });
  await action('record', { commands: ['rogue'] });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0].name, 'Route');
  assert.deepEqual(Array.from(calls[0][0].turns, turn => turn.command), ['east', 'look']);
  assert.equal(typeof calls[0][1], 'function');
  assert.equal(calls[0][2].aborted, false);
  await action('name', { name: 'Unsaved' });
  await action('record');
  assert.equal(calls.length, 1);
});


test('restores last opened vector and composition per project across manager reloads', async t => {
  const f = await fixture(t);
  const { saveComposition } = require('../composition-library');
  const vector = createVector({ entry: 'initial', name: 'Remember me', start: endpoint('A'), end: endpoint('B'), turns: [] });
  const directory = path.join(f.root, '.informant', 'test-vectors');
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, vector.guid + '.iskein'), serializeVector(vector));
  for (const observation of [endpoint('B').observation, 'FFFFFFFF']) {
    const candidate = createVector({ entry: 'continuation', name: 'Continue ' + observation,
      start: { ...endpoint('B'), observation }, end: endpoint('C'), turns: [] });
    await fs.writeFile(path.join(directory, candidate.guid + '.iskein'), serializeVector(candidate));
  }
  const composition = await saveComposition(f.root, { name: 'Remember route', members: [{ type: 'iskein', guid: vector.guid }] });
  await f.open();
  let panel = f.panels.at(-1);
  assert.equal(panel.messages.at(-1).selectedGuid, null);
  assert.equal(panel.messages.at(-1).composition.committed, null);
  panel.receive.fire({ type: 'testManager.selectVector', guid: vector.guid });
  await settled(() => panel.messages.at(-1).selectedGuid === vector.guid);
  panel.receive.fire({ type: 'testManager.composition', action: 'load', reference: { type: 'icomposition', guid: composition.guid } });
  await settled(() => panel.messages.at(-1).composition.committed?.guid === composition.guid);
  panel.receive.fire({ type: 'testManager.composition', action: 'name', name: 'Unsaved change' });
  await settled(() => panel.messages.at(-1).composition.name === 'Unsaved change');
  panel.dispose();
  // A fresh module simulates extension reload; only persistent state is shared.
  const manager = f.load('test-manager.js');
  await manager.openTestManager(f.root, f.context);
  panel = f.panels.at(-1);
  assert.equal(panel.messages.at(-1).selectedGuid, vector.guid);
  assert.equal(panel.messages.at(-1).composition.committed.guid, composition.guid);
  assert.equal(panel.messages.at(-1).composition.name, composition.name);
  const elements = {};
  let receive;
  function element() {
    return { showModal() { this.open = true; }, close() { this.open = false; }, children: [], dataset: {}, attrs: {}, textContent: '', scrollTop: 0,
      appendChild(node) { this.children.push(node); }, replaceChildren() { this.children = []; },
      setAttribute(key, value) { this.attrs[key] = value; }, addEventListener(key, fn) { this[key] = fn; },
      focus() { document.activeElement = this; } };
  }
  const document = { createElement: element, getElementById(id) { return elements[id] ||= element(); } };
  vm.runInNewContext(/<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(panel.webview.html)[1], {
    document, acquireVsCodeApi: () => ({ postMessage() {} }), window: { addEventListener(type, fn) { receive = fn; } }
  });
  receive({ data: panel.messages.at(-1) });
  const descendants = node => node.children.flatMap(child => [child, ...descendants(child)]);
  for (const label of ['Play', 'Record Continuation']) {
    assert.equal(descendants(elements['vector-details']).find(node => node.textContent === label).disabled, false);
  }
  assert.equal(elements.members.children.at(-1).children[0].attrs['aria-pressed'], 'true');
  assert.equal(elements.members.children.flatMap(row => row.children).find(node => node.id === 'remove-member').disabled, false);
  for (const strength of ['strong', 'weak']) {
    assert.ok(elements.playables.children.some(row => row.className === 'candidate-' + strength));
  }
  panel.dispose();
  await manager.openTestManager(f.temp, f.context);
  panel = f.panels.at(-1);
  assert.equal(panel.messages.at(-1).selectedGuid, null);
  assert.equal(panel.messages.at(-1).composition.committed, null);
  panel.dispose();
  await fs.rm(path.join(f.root, '.informant'), { recursive: true });
  await manager.openTestManager(f.root, f.context);
  panel = f.panels.at(-1);
  assert.equal(panel.messages.at(-1).selectedGuid, null);
  assert.equal(panel.messages.at(-1).composition.committed, null);
});

test('suite selection filters both libraries, resolves children globally, reports missing references and survives reload', async t => {
  const f = await fixture(t);
  const { saveNewCollection } = require('../collection-library');
  const { serializeCollection } = require('../icollection');
  const { saveComposition } = require('../composition-library');
  const { randomUUID } = require('node:crypto');
  const directory = path.join(f.root, '.informant', 'test-vectors');
  await fs.mkdir(directory, { recursive: true });
  const vectors = ['Member', 'Child outside suite'].map(name => createVector({ name, entry: 'initial', start: endpoint('A'), end: endpoint('B'), turns: [] }));
  for (const vector of vectors) await fs.writeFile(path.join(directory, vector.guid + '.iskein'), serializeVector(vector));
  const composition = await saveComposition(f.root, { name: 'Composite member', members: [{ type: 'iskein', guid: vectors[1].guid }] });
  const suite = await saveNewCollection(f.root, 'Mixed');
  const missing = { type: 'iskein', guid: randomUUID() };
  const members = [{ type: 'iskein', guid: vectors[0].guid }, { type: 'icomposition', guid: composition.guid }, missing];
  await fs.writeFile(suite.file, serializeCollection({ ...suite, members }));
  const empty = await saveNewCollection(f.root, 'Empty');
  await f.open(); const panel = f.panels.at(-1);
  const state = () => panel.messages.at(-1);
  panel.receive.fire({ type: 'testManager.selectSuite', guid: suite.guid });
  await settled(() => state().activeCollectionGuid === suite.guid);
  assert.deepEqual(state().library.vectors.map(v => v.guid), [vectors[0].guid]);
  assert.equal(state().composition.candidates.length, 2);
  assert.match(state().collectionIssues[0].message, new RegExp('Missing iskein: ' + missing.guid));
  panel.receive.fire({ type: 'testManager.composition', action: 'load', reference: { type: 'icomposition', guid: composition.guid } });
  await settled(() => state().composition.committed?.guid === composition.guid);
  assert.equal(state().composition.error, '');
  assert.equal(state().composition.members[0].playable.guid, vectors[1].guid);
  panel.receive.fire({ type: 'testManager.selectSuite', guid: empty.guid });
  await settled(() => state().activeCollectionGuid === empty.guid);
  assert.equal(state().library.vectors.length, 0);
  assert.equal(state().composition.candidates.length, 0);
  assert.equal(state().composition.committed.guid, composition.guid); // Do not discard working edits on suite changes.
  panel.dispose(); await f.load('test-manager.js').openTestManager(f.root, f.context);
  const reloaded = f.panels.at(-1);
  assert.equal(reloaded.messages.at(-1).activeCollectionGuid, empty.guid);
  await fs.unlink(empty.file);
  f.watchers.filter(w => !w.disposed && w.pattern.pattern === '.informant/collections/**')[0].remove.fire();
  await settled(() => reloaded.messages.at(-1).activeCollectionGuid === suite.guid);
});

test('suite creation selects the new suite and trusts only host-side source membership', async t => {
  const f = await fixture(t);
  const { saveNewCollection, discoverCollections } = require('../collection-library');
  const { serializeCollection } = require('../icollection');
  const { randomUUID } = require('node:crypto');
  const source = await saveNewCollection(f.root, 'Source');
  const members = [{ type: 'icomposition', guid: randomUUID(), behavior: 'stepwise' }];
  await fs.writeFile(source.file, serializeCollection({ ...source, members }));
  await f.open(); const panel = f.panels.at(-1);
  async function create(name, sourceGuid) {
    const before = panel.messages.length;
    panel.receive.fire({ type: 'testManager.createSuite', name, sourceGuid, members: [], project: '/untrusted' });
    await settled(() => panel.messages.length > before && !panel.messages.at(-1).busy && panel.messages.at(-1).collectionResult);
    return panel.messages.at(-1);
  }
  const inherited = await create('Inherited', source.guid);
  assert.equal(inherited.activeCollectionGuid, inherited.collectionResult.guid);
  assert.notEqual(inherited.activeCollectionGuid, source.guid);
  assert.deepEqual((await discoverCollections(f.root)).collections.find(c => c.guid === inherited.activeCollectionGuid).members, members);
  const empty = await create('Empty', null);
  assert.equal(empty.library.vectors.length, 0);
  assert.equal(empty.composition.candidates.length, 0);
  assert.equal(empty.collectionIssues.length, 0);
  const invalid = await create('Stale source', randomUUID());
  assert.match(invalid.collectionResult.error, /no longer available/);
  assert.equal(invalid.activeCollectionGuid, empty.activeCollectionGuid);
  assert.equal((await discoverCollections(f.root)).collections.length, 3);
});

test('suite browser stays closed on first run, supports cancel/create/all inheritance, escapes names, and leaves HELP inert', async t => {
  const f = await fixture(t); await f.open();
  const panel = f.panels[0], elements = {}, posted = []; let receive;
  function element() {
    return { children: [], dataset: {}, attrs: {}, textContent: '', value: '', scrollTop: 0,
      appendChild(node) { this.children.push(node); }, replaceChildren() { this.children = []; },
      setAttribute(key, value) { this.attrs[key] = value; }, addEventListener(key, fn) { this[key] = fn; },
      showModal() { this.open = true; this.openCount = (this.openCount || 0) + 1; }, close() { this.open = false; },
      focus() { document.activeElement = this; } };
  }
  const document = { createElement: element, getElementById(id) { return elements[id] ||= element(); } };
  vm.runInNewContext(/<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(panel.webview.html)[1], {
    document, acquireVsCodeApi: () => ({ postMessage: message => posted.push(message) }),
    window: { addEventListener(type, fn) { receive = fn; } }
  });
  const state = panel.messages.at(-1), dialog = elements['create-suite-dialog'];
  receive({ data: state });
  assert.equal(dialog.open, undefined);
  assert.equal(dialog.openCount, undefined);
  elements['test-suite'].value = 'create'; elements['test-suite'].change();
  assert.equal(dialog.open, true);
  assert.equal(document.activeElement, elements['suite-name']);
  assert.equal(elements['suite-inherit'].children[0].textContent, 'None');
  elements['cancel-suite'].click(); receive({ data: state });
  assert.equal(dialog.open, false); assert.equal(dialog.openCount, 1);
  assert.equal(posted.length, 1); // Only the ready handshake; cancel has no persistence action.
  const suite = { guid: 'source-guid', name: '<img onerror="bad()">' };
  receive({ data: { ...state, collections: [suite], activeCollectionGuid: suite.guid } });
  assert.equal(elements['test-suite'].children[0].textContent, suite.name);
  assert.equal(elements['test-suite'].children.at(-1).textContent, '<create new suite>');
  elements['test-suite'].value = 'create'; elements['test-suite'].change();
  assert.equal(dialog.open, true);
  assert.equal(elements['test-suite'].value, suite.guid);
  assert.equal(elements['suite-inherit'].children[1].textContent, 'All Playables');
  assert.equal(elements['suite-inherit'].children[1].value, 'all');
  assert.equal(elements['suite-inherit'].children[2].value, suite.guid);
  elements['suite-name'].value = ' New suite '; elements['suite-inherit'].value = suite.guid;
  receive({ data: { ...state, collections: [suite], activeCollectionGuid: suite.guid, busy: true } });
  assert.equal(elements['create-suite'].disabled, true);
  elements['create-suite-form'].submit({ preventDefault() {} });
  assert.equal(posted.length, 1);
  receive({ data: { ...state, collections: [suite], activeCollectionGuid: suite.guid } });
  elements['create-suite-form'].submit({ preventDefault() {} });
  assert.equal(posted.at(-1).type, 'testManager.createSuite');
  assert.equal(posted.at(-1).name, 'New suite'); assert.equal(posted.at(-1).sourceGuid, suite.guid);
  receive({ data: { ...state, collectionResult: { error: 'Source removed' } } });
  assert.equal(dialog.open, true); assert.equal(elements['suite-error'].textContent, 'Source removed');
  assert.equal(elements['create-suite'].disabled, false);
  elements['suite-inherit'].value = 'all';
  elements['create-suite-form'].submit({ preventDefault() {} });
  assert.equal(posted.at(-1).sourceGuid, 'all');
  receive({ data: { ...state, collections: [suite], activeCollectionGuid: suite.guid, collectionResult: { guid: suite.guid } } });
  assert.equal(dialog.open, false);
  assert.match(panel.webview.html, /id="suite-help" type="button">HELP/);
  assert.equal(elements['suite-help'], undefined); // No listener or action is attached.
});

test('without suites libraries remain unfiltered; All Playables creation snapshots both types', async t => {
  const f = await fixture(t);
  const { saveComposition } = require('../composition-library');
  const { discoverCollections } = require('../collection-library');
  const directory = path.join(f.root, '.informant', 'test-vectors');
  await fs.mkdir(directory, { recursive: true });
  const vectors = ['initial', 'continuation'].map(entry => createVector({ name: entry, entry, start: endpoint('A'), end: endpoint('B'), turns: [] }));
  for (const vector of vectors) await fs.writeFile(path.join(directory, vector.guid + '.iskein'), serializeVector(vector));
  const composition = await saveComposition(f.root, { name: 'Composition', members: [{ type: 'iskein', guid: vectors[0].guid }] });
  await f.open();
  const panel = f.panels.at(-1), state = () => panel.messages.at(-1);
  assert.equal(state().collections.length, 0);
  assert.equal(state().activeCollectionGuid, null);
  assert.equal(state().library.vectors.length, 2);
  assert.ok(state().composition.candidates.some(value => value.guid === composition.guid));
  const files = [...vectors.map(value => path.join(directory, value.guid + '.iskein')), composition.file];
  const before = await Promise.all(files.map(file => fs.readFile(file, 'utf8')));
  panel.receive.fire({ type: 'testManager.createSuite', name: 'Everything', sourceGuid: 'all', members: [] });
  await settled(() => state().collectionResult?.guid && !state().busy);
  const suite = (await discoverCollections(f.root)).collections[0];
  assert.equal(state().activeCollectionGuid, suite.guid);
  const expected = [...vectors.map(({ guid }) => ({ type: 'iskein', guid, behavior: 'stepwise' })), { type: 'icomposition', guid: composition.guid, behavior: 'stepwise' }];
  assert.deepEqual(suite.members.map(value => JSON.stringify(value)).sort(), expected.map(value => JSON.stringify(value)).sort());
  assert.deepEqual(await Promise.all(files.map(file => fs.readFile(file, 'utf8'))), before);
  const later = createVector({ name: 'Later', entry: 'initial', start: endpoint('A'), end: endpoint('B'), turns: [] });
  await fs.writeFile(path.join(directory, later.guid + '.iskein'), serializeVector(later));
  const count = panel.messages.length;
  panel.receive.fire({ type: 'testManager.refresh' });
  await settled(() => panel.messages.length > count);
  assert.equal(state().library.vectors.length, 2);
  assert.deepEqual((await discoverCollections(f.root)).collections[0].members, suite.members);
});

test('new starters, continuations and compositions join the selected suite and persist on reopen', async t => {
  const f = await fixture(t);
  const { saveNewCollection, discoverCollections } = require('../collection-library');
  const first = await saveNewCollection(f.root, 'First');
  const second = await saveNewCollection(f.root, 'Second');
  const continuation = createVector({ name: 'Continuation', entry: 'continuation',
    start: endpoint('B'), end: endpoint('C'), turns: [] });
  const manager = f.load('test-manager.js', {
    './working-iskein': { ...require('../working-iskein'), async acceptContinuation() {
      const file = path.join(f.root, '.informant', 'test-vectors', continuation.guid + '.iskein');
      await fs.writeFile(file, serializeVector(continuation));
      return { ...continuation, file };
    } }
  });
  f.vscode.window.showInputBox = async () => 'Created item';
  await fs.writeFile(path.join(f.root, 'Skein.skein'), recorded(['wait']));
  await manager.openTestManager(f.root, f.context, async () => ({ start: endpoint('A'), end: endpoint('B') }));
  let panel = f.panels.at(-1);
  const state = () => panel.messages.at(-1);
  async function send(message) {
    const before = panel.messages.length;
    panel.receive.fire(message);
    await settled(() => panel.messages.length > before && !state().busy);
  }
  await send({ type: 'testManager.selectSuite', guid: first.guid });
  await send({ type: 'testManager.selectSuite', guid: second.guid });
  await send({ type: 'testManager.makeVector' });
  assert.match(state().operation, /Created/);
  assert.equal(state().library.vectors.length, 1);
  const starter = state().library.vectors[0];
  await send({ type: 'testManager.acceptContinuation' });
  assert.match(state().operation, /Accepted/);
  assert.equal(state().library.vectors.length, 2);
  await send({ type: 'testManager.composition', action: 'add', reference: { type: 'iskein', guid: starter.guid } });
  await send({ type: 'testManager.composition', action: 'save' });
  assert.match(state().operation, /Saved/);
  const composition = state().composition.committed;
  assert.ok(state().composition.candidates.some(item => item.guid === composition.guid));
  await send({ type: 'testManager.composition', action: 'save' });
  const suites = (await discoverCollections(f.root)).collections;
  assert.deepEqual(suites.find(item => item.guid === first.guid).members, []);
  assert.deepEqual(suites.find(item => item.guid === second.guid).members, [
    { type: 'iskein', guid: starter.guid, behavior: 'stepwise' }, { type: 'iskein', guid: continuation.guid, behavior: 'stepwise' },
    { type: 'icomposition', guid: composition.guid, behavior: 'stepwise' }
  ]);
  panel.dispose();
  await manager.openTestManager(f.root, f.context);
  panel = f.panels.at(-1);
  assert.equal(state().activeCollectionGuid, second.guid);
  assert.equal(state().library.vectors.length, 2);
  assert.ok(state().composition.candidates.some(item => item.guid === composition.guid));
});

test('Test tab filters suite membership, exports results, and clears runs on leave, cancellation and reopen', async t => {
  const f = await fixture(t);
  const { saveNewCollection, addCollectionMember } = require('../collection-library');
  const dir = path.join(f.root, '.informant', 'test-vectors'); await fs.mkdir(dir, { recursive: true });
  const a = createVector({ name: 'First', entry: 'initial', start: endpoint('A'), end: endpoint('B'), turns: [{ command: 'north', result: 'B' }] });
  const b = createVector({ name: 'Dependent', entry: 'continuation', start: endpoint('B'), end: endpoint('C'), turns: [] });
  const outside = createVector({ ...a, name: 'Outside', guid: undefined });
  for (const value of [a, b, outside]) await fs.writeFile(path.join(dir, value.guid + '.iskein'), serializeVector(value));
  const suite = await saveNewCollection(f.root, 'Suite');
  for (const value of [a, b]) await addCollectionMember(f.root, suite.guid, { type: 'iskein', guid: value.guid });
  let finish, signal, calls = 0;
  const execute = async (plan, abortSignal) => {
    assert.equal(plan.behavior, 'endpoint');
    calls++; signal = abortSignal;
    return new Promise(resolve => { finish = resolve; });
  };
  await f.manager.openTestManager(f.root, f.context, undefined, undefined, undefined, {}, execute);
  let panel = f.panels.at(-1);
  const state = () => panel.messages.filter(message => message.type === 'testManager.state').at(-1);
  assert.deepEqual(Array.from(state().tests, value => value.guid), [a.guid]);
  const send = message => panel.receive.fire(message);
  const run = () => send({ type: 'testManager.runTests', references: [{ type: 'iskein', guid: a.guid }] });
  send({ type: 'testManager.setBehavior', collectionGuid: suite.guid, references: [{ type: 'iskein', guid: a.guid }], behavior: 'END' });
  await settled(() => !state().busy && state().tests[0].behavior === 'endpoint');
  send({ type: 'testManager.tab', view: 'test' }); run();
  await settled(() => calls === 1);
  finish({ status: 'FAIL', position: 1, received: 'Changed', reason: 'Response mismatch.' });
  await settled(() => state().testRun?.state === 'Complete');
  assert.equal(state().testRun.results[0].failure.expected, 'B');
  let written;
  f.vscode.window.showSaveDialog = async () => ({ fsPath: path.join(f.temp, 'results.zip') });
  f.vscode.workspace.fs = { async writeFile(uri, bytes) { written = bytes; } };
  send({ type: 'testManager.saveResults' }); await settled(() => written);
  assert.equal(written.readUInt32LE(0), 0x04034b50);
  send({ type: 'testManager.tab', view: 'vectors' });
  await settled(() => state().testRun === null);
  send({ type: 'testManager.tab', view: 'test' }); run();
  await settled(() => calls === 2);
  send({ type: 'testManager.tab', view: 'compositions' });
  assert.equal(signal.aborted, true);
  finish({ status: 'PASS', completed: 1, compared: 1 });
  await settled(() => state().testRun === null && !state().busy);
  send({ type: 'testManager.tab', view: 'test' });
  assert.equal(state().testRun, null);
  run(); await settled(() => calls === 3);
  send({ type: 'testManager.cancelTests' }); assert.equal(signal.aborted, true);
  finish({ status: 'PASS', completed: 1, compared: 1 });
  await settled(() => state().testRun?.state === 'Cancelled');
  assert.equal(state().testRun.results[0].status, 'CANCELLED');
  panel.dispose();
  await f.manager.openTestManager(f.root, f.context, undefined, undefined, undefined, {}, execute);
  panel = f.panels.at(-1);
  assert.equal(state().testRun, null);
  // No run artifacts were written inside the project.
  assert.deepEqual((await fs.readdir(path.join(f.root, '.informant'))).sort(), ['collections', 'test-vectors']);
});

test('Test tab browser resets selection and details on leave and renders failure strings as text', async t => {
  const f = await fixture(t); await f.open();
  const elements = {}, posted = [], revoked = []; let receive;
  function element(tag = '') { return { tag, contentWindow: {}, children: [], attrs: {}, dataset: {}, value: '',
    appendChild(node) { this.children.push(node); }, replaceChildren() { this.children = []; },
    setAttribute(name, value) { this.attrs[name] = value; }, addEventListener(type, fn) { this[type] = fn; } }; }
  const document = { createElement: element, getElementById(id) { return elements[id] ||= element(); } };
  vm.runInNewContext(/<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(f.panels[0].webview.html)[1], {
    URL: { createObjectURL: () => 'blob:test', revokeObjectURL: value => revoked.push(value) }, Blob: class {},
    document, acquireVsCodeApi: () => ({ postMessage: message => posted.push(message) }),
    window: { addEventListener(type, fn) { receive = fn; } }
  });
  const guid = require('node:crypto').randomUUID();
  const data = { type: 'testManager.state', activeCollectionGuid: 'suite', project: f.root, skein: { status: 'missing' }, tests: [{ guid, name: '<img>', type: 'iskein', turnCount: 1 }] };
  receive({ data }); elements['test-tab'].click();
  elements['test-all'].click(); assert.equal(elements['run-tests'].disabled, false);
  assert.equal(elements['behavior-endpoint'].disabled, false);
  elements['behavior-endpoint'].click();
  assert.equal(posted.at(-1).type, 'testManager.setBehavior');
  assert.equal(posted.at(-1).behavior, 'endpoint');
  assert.equal(elements['behavior-endpoint'].attrs['aria-pressed'], 'true');
  data.tests[0].behavior = 'endpoint'; receive({ data });
  assert.equal(elements['test-list'].children[0].children[1].textContent, 'E');
  const checkbox = elements['test-list'].children[0].children[0].children[0];
  checkbox.checked = false; checkbox.change();
  for (const behavior of ['stepwise', 'endpoint', 'none']) assert.equal(elements['behavior-' + behavior].attrs['aria-pressed'], 'false');
  assert.equal(elements['test-list'].children[0].children[1].textContent, 'E');
  elements['test-all'].click();
  elements['run-tests'].click(); assert.equal(posted.at(-1).references[0].guid, guid);
  data.testRun = { state: 'Running', results: [{ guid, name: '<img>', status: 'RUNNING', currentStep: 'Step 1/1: <look>' }] };
  receive({ data });
  assert.equal(elements['test-results'].children[0].children[0].textContent, '1. <img> — RUNNING · Step 1/1: <look>');
  data.testRun = { state: 'Complete', results: [{ guid, name: '<img>', status: 'FAIL', turnCount: 1,
    failure: { playableName: '<img>', playableGuid: guid, position: 1, reason: 'Mismatch', command: 'look', expected: '<script>expected</script>', received: ' Received\n ' } }] };
  receive({ data }); elements['test-results'].children[0].children[0].click();
  assert.ok(elements['test-failure'].children.some(node => node.tag === 'pre' && node.textContent === '<script>expected</script>'));
  assert.equal(elements['save-results'].disabled, false);
  receive({ data: { type: 'test.frame.load', token: 'one', html: '<html></html>' } });
  const frame = elements['test-frame-host'].children[0];
  assert.equal(frame.tag, 'iframe'); assert.equal(frame.src, 'blob:test');
  const count = posted.length;
  receive({ source: {}, data: { type: 'test.frame', token: 'one', message: { type: 'test.result' } } });
  assert.equal(posted.length, count, 'ignore messages from other frames');
  receive({ source: frame.contentWindow, data: { type: 'test.frame', token: 'one', message: { type: 'test.result' } } });
  assert.equal(posted.at(-1).type, 'test.frame');
  receive({ data: { type: 'test.frame.remove', token: 'old' } });
  assert.equal(elements['test-frame-host'].children.length, 1, 'late cleanup cannot remove a new VM');
  elements['vectors-tab'].click();
  assert.equal(elements['test-frame-host'].children.length, 0);
  assert.deepEqual(revoked, ['blob:test']);
  assert.equal(elements['test-results'].children.length, 0);
  assert.equal(elements['test-failure'].children.length, 0);
  elements['test-tab'].click();
  assert.equal(elements['run-tests'].disabled, true);
  assert.equal(elements['save-results'].disabled, true);
});


test('source toolbar defaults and settings changes update menu visibility', async t => {
  const f = await fixture(t);
  const manifest = require('../package.json');
  const actions = manifest.contributes.menus['editor/title'];
  const visible = () => actions.filter(action => {
    if (action.command === 'informant.configureSourceActions') {
      assert.equal(action.when, 'editorLangId == inform7');
      return true;
    }
    const match = /^editorLangId == inform7 && ([\w.]+)$/.exec(action.when);
    assert.ok(match, `Expected a boolean visibility context: ${action.when}`);
    assert.ok(f.contexts.has(match[1]));
    return f.contexts.get(match[1]);
  }).map(action => action.command);
  assert.deepEqual(visible(), ['informant.compile', 'informant.play', 'informant.configureSourceActions']);
  f.setSourceActions(['informant.openDocs']);
  assert.deepEqual(visible(), ['informant.openDocs', 'informant.configureSourceActions']);
  f.setSourceActions([]);
  assert.deepEqual(visible(), ['informant.configureSourceActions']);
  f.setSourceActions(undefined);
  assert.deepEqual(visible(), ['informant.compile', 'informant.play', 'informant.configureSourceActions']);
});

for (const existingSuite of [false, true]) test(`Skein import creates a new suite with ${existingSuite ? 'an existing suite' : 'no existing suite'}, preserves recording and ignores duplicate clicks`, async t => {
  const f = await fixture(t);
  const { saveNewCollection, discoverCollections } = require('../collection-library');
  const suite = existingSuite ? await saveNewCollection(f.root, 'Existing') : null;
  const source = recorded(['look', 'north']);
  await fs.writeFile(path.join(f.root, 'Skein.skein'), source);
  let dialogs = 0, prompts = 0, calls = 0;
  f.vscode.window.showOpenDialog = async () => { dialogs++; return [{ fsPath: path.join(f.root, 'Skein.skein') }]; };
  f.vscode.window.showInputBox = async () => { prompts++; return 'Imported'; };
  await f.manager.openTestManager(f.root, f.context, async commands => {
    calls++; assert.deepEqual(Array.from(commands), ['look', 'north']);
    return { start: endpoint('Start'), end: endpoint('End') };
  });
  const panel = f.panels[0];
  assert.match(panel.webview.html, /id="test-suite"[\s\S]*id="import-skein"[\s\S]*id="suite-help"/);
  panel.receive.fire({ type: 'testManager.importSkein' });
  panel.receive.fire({ type: 'testManager.importSkein' });
  await settled(() => panel.messages.some(m => m.operation?.startsWith('Imported 1 starter')));
  assert.equal(dialogs, 1); assert.equal(calls, 1); assert.equal(prompts, 1);
  const saved = (await discoverCollections(f.root)).collections;
  assert.equal(saved.length, existingSuite ? 2 : 1);
  const importedSuite = saved.find(value => value.name === 'Imported');
  assert.equal(importedSuite.members.length, 1);
  if (suite) assert.equal(saved.find(value => value.guid === suite.guid).members.length, 0);
  assert.equal(panel.messages.at(-1).activeCollectionGuid, importedSuite.guid);
  assert.equal(await fs.readFile(path.join(f.root, 'Skein.skein'), 'utf8'), source);
});

test('cancelling the import suite prompt saves nothing and does not qualify', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, 'Skein.skein'), recorded(['look']));
  f.vscode.window.showOpenDialog = async () => [{ fsPath: path.join(f.root, 'Skein.skein') }];
  let prompted = false;
  f.vscode.window.showInputBox = async () => { prompted = true; return undefined; };
  await f.manager.openTestManager(f.root, f.context, () => assert.fail('must not qualify'));
  const panel = f.panels[0];
  panel.receive.fire({ type: 'testManager.importSkein' });
  await settled(() => prompted && panel.messages.at(-1).busy === false);
  assert.equal((await discoverTestVectors(f.root)).vectors.length, 0);
  assert.equal(panel.messages.at(-1).collections.length, 0);
});

test('branching Skein import saves starters, continuations and compositions in the new selected suite', async t => {
  const f = await fixture(t);
  const { saveNewCollection, discoverCollections } = require('../collection-library');
  const { discoverPlayables } = require('../composition-library');
  const existing = await saveNewCollection(f.root, 'Existing');
  const source = '<Skein rootNode="root">' + [
    ['root', '- start -', ['a']], ['a', 'look', ['b', 'c']], ['b', 'north', []], ['c', 'south', []]
  ].map(([id, command, children]) => `<item nodeId="${id}"><command>${command}</command><result>Recorded ${command}</result><children>${children.map(child => `<child nodeId="${child}"/>`).join('')}</children></item>`).join('') + '</Skein>';
  await fs.writeFile(path.join(f.root, 'Skein.skein'), source);
  f.vscode.window.showOpenDialog = async () => [{ fsPath: path.join(f.root, 'Skein.skein') }];
  f.vscode.window.showInputBox = async options => {
    assert.ok(options.validateInput('   '));
    return '  Extracted routes  ';
  };
  await f.manager.openTestManager(f.root, f.context, async () => ({ start: endpoint('Start'), end: endpoint('End') }));
  const panel = f.panels[0];
  panel.receive.fire({ type: 'testManager.importSkein' });
  await settled(() => panel.messages.some(m => m.operation?.startsWith('Imported 1 starter vectors, 2 continuation vectors, and 2 compositions')));
  const suites = (await discoverCollections(f.root)).collections;
  const suite = suites.find(value => value.name === 'Extracted routes');
  assert.ok(suite);
  assert.equal(suites.find(value => value.guid === existing.guid).members.length, 0);
  const library = await discoverPlayables(f.root);
  assert.equal(library.vectors.vectors.length, 3);
  assert.equal(library.compositions.compositions.length, 2);
  assert.deepEqual(library.vectors.issues, []);
  assert.deepEqual(library.compositions.issues, []);
  assert.deepEqual(new Set(suite.members.map(value => value.guid)), new Set(library.playables.map(value => value.guid)));
  const state = panel.messages.at(-1);
  assert.equal(state.activeCollectionGuid, suite.guid);
  assert.equal(state.library.vectors.length, 3);
  assert.equal(state.composition.candidates.filter(value => value.type === 'icomposition').length, 2);
  assert.equal(state.library.vectors.filter(value => value.entry === 'continuation').length, 2);
  assert.equal(await fs.readFile(path.join(f.root, 'Skein.skein'), 'utf8'), source);
});


test('import qualification failure reports the vector and returns to Test Manager', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, 'Skein.skein'), recorded(['look']));
  f.vscode.window.showOpenDialog = async () => [{ fsPath: path.join(f.root, 'Skein.skein') }];
  f.vscode.window.showInputBox = async () => 'Routes';
  await f.manager.openTestManager(f.root, f.context, async () => { throw new Error('No test story'); });
  const panel = f.panels[0];
  panel.receive.fire({ type: 'testManager.importSkein' });
  await settled(() => panel.messages.some(m => !m.busy && m.operation?.startsWith('Skein import failed:')));
  assert.match(f.errors[0], /Routes-starter-1: No test story/);
  assert.equal(panel.reveals, 1);
  assert.equal((await discoverTestVectors(f.root)).vectors.length, 0);
});


test('import omits unanswered final quit and saves fresh named GUID artifacts without changing the source', async t => {
  const f = await fixture(t);
  const { discoverCollections } = require('../collection-library');
  const source = recorded(['look', 'quit']);
  const file = path.join(f.root, 'Skein.skein');
  await fs.writeFile(file, source);
  f.vscode.window.showOpenDialog = async () => [{ fsPath: file }];
  f.vscode.window.showInputBox = async () => 'Routes';
  await f.manager.openTestManager(f.root, f.context, async commands => {
    assert.deepEqual(Array.from(commands), ['look']);
    return { start: endpoint('Start'), end: endpoint('End') };
  });
  const panel = f.panels[0];
  for (let run = 0; run < 2; run++) {
    panel.receive.fire({ type: 'testManager.importSkein' });
    await settled(() => panel.reveals === run + 1 && panel.messages.at(-1).busy === false);
  }
  const vectors = (await discoverTestVectors(f.root)).vectors;
  const suites = (await discoverCollections(f.root)).collections;
  assert.equal(vectors.length, 2);
  assert.equal(suites.length, 2);
  assert.equal(new Set([...vectors, ...suites].map(v => v.guid)).size, 4);
  for (const vector of vectors) {
    assert.equal(vector.name, 'Routes-starter-1');
    assert.deepEqual(vector.turns.map(t => t.command), ['look']);
  }
  for (const suite of suites) {
    assert.equal(suite.members.length, 1);
    assert.ok(vectors.some(v => v.guid === suite.members[0].guid));
  }
  assert.match(panel.messages.at(-1).operation, /Omitted 1 unanswered trailing quit/);
  assert.equal(await fs.readFile(file, 'utf8'), source);
  assert.deepEqual(f.errors, []);
});
