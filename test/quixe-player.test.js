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

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'informant-player-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const runtime = path.join(root, 'Quixe');
  for (const name of ['lib/jquery-1.12.4.min.js', 'lib/glkote.min.js', 'lib/quixe.min.js', 'media/glkote.css', 'media/dialog.css', 'media/waiting.gif']) {
    await fs.mkdir(path.dirname(path.join(runtime, name)), { recursive: true });
    await fs.writeFile(path.join(runtime, name), '');
  }
  const story = path.join(root, 'output-test.ulx');
  const bytes = Buffer.alloc(36); bytes.write('Glul'); await fs.writeFile(story, bytes);
  const errors = [], warnings = [], panels = [], timers = [], notices = [], posted = [];
  const vscode = {
    Uri: { file: fsPath => ({ fsPath }) }, ViewColumn: { Active: 1 },
    window: {
      showErrorMessage: e => errors.push(e), showWarningMessage: e => warnings.push(e), showInformationMessage: e => notices.push(e),
      createWebviewPanel() {
        let disposed = false;
        const panel = { reveal() {}, onDidDispose(fn) { this.onDispose = fn; }, dispose() { if (!disposed) { disposed = true; this.onDispose(); } },
          webview: { postMessage: async message => { posted.push(message); return true; }, cspSource: 'vscode-resource:', asWebviewUri: u => ({ toString: () => u.fsPath }),
            onDidReceiveMessage(fn) { panel.receive = fn; return { dispose() {} }; } } };
        const webview = panel.webview;
        Object.defineProperty(panel, 'webview', { get() {
          if (disposed) throw new Error('Webview is disposed');
          return webview;
        } });
        panels.push(panel); return panel;
      }
    }
  };
  const file = path.join(__dirname, '..', 'quixe-player.js');
  const localRequire = createRequire(file);
  const sandbox = { require: name => name === 'vscode' ? vscode : localRequire(name), module: { exports: {} },
    setTimeout(fn) { const timer = { fn, unref() {} }; timers.push(timer); return timer; }, clearTimeout(timer) { if (timer) timer.cleared = true; } };
  vm.runInNewContext(await fs.readFile(file, 'utf8'), sandbox);
  const api = sandbox.module.exports;
  t.after(() => api.shutdownPlayer());
  const context = { subscriptions: [] };
  const open = recording => api.openPlayer(runtime, story, context, recording ? { recordingProject: root } : undefined);
  const session = () => panels.at(-1).webview.html.match(/message => vscode.postMessage\(message\), "([^"]+)"/)[1];
  const send = (sessionId, sequence, kind, payload) => panels.at(-1).receive({ type: 'skein.recording', sessionId, sequence, kind, payload });
  const start = id => { send(id, 1, 'update', { input: null, output: { type: 'update', gen: 1, windows: [{ id: 1, type: 'buffer' }], content: [{ id: 1, text: [{ append: true, content: ['normal', 'Start>'] }] }], input: [{ id: 1, type: 'line', gen: 1 }] } }); send(id, 2, 'ready'); };
  return { root, runtime, story, errors, warnings, panels, timers, notices, posted, api, context, open, session, send, start };
}

test('player configures hook before load_run; fresh document, replacement, and stale callbacks are isolated', async t => {
  const f = await fixture(t);
  await f.open(true);
  const id = f.session(); const panel = f.panels[0];
  assert.ok(panel.webview.html.indexOf('recording_format') < panel.webview.html.indexOf('GiLoad.load_run'));
  assert.ok(panel.webview.html.includes('options.GlkOte = glkote'));
  f.start(id);
  await f.open(true);
  assert.equal(f.panels.length, 1, 'panel reused with fresh document');
  assert.notEqual(f.session(), id);
  const before = await fs.readFile(path.join(f.root, 'Skein.skein'), 'utf8');
  f.send(id, 3, 'error', 'STALE');
  assert.deepEqual(f.errors, []);
  f.start(f.session());
  await f.api.shutdownPlayer();
  assert.notEqual(await fs.readFile(path.join(f.root, 'Skein.skein'), 'utf8'), before);
  assert.deepEqual(f.errors, []);
});

test('failed asset validation preserves the active recording; startup timeout preserves existing Skein', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, 'Skein.skein'), 'original');
  await f.open(true);
  await assert.rejects(f.api.openPlayer(path.join(f.root, 'missing'), f.story, f.context), /directory is missing/);
  f.start(f.session());
  await f.api.shutdownPlayer();
  assert.match(await fs.readFile(path.join(f.root, 'Skein.skein'), 'utf8'), /Start&gt;/);
  const before = await fs.readFile(path.join(f.root, 'Skein.skein'), 'utf8');
  await f.open(true);
  f.timers.at(-1).fn();
  await f.api.shutdownPlayer();
  assert.equal(await fs.readFile(path.join(f.root, 'Skein.skein'), 'utf8'), before);
  assert.match(f.errors[0], /Recording did not start/);
});

test('ordinary play installs no hook and disposal drains recording progress', async t => {
  const f = await fixture(t);
  await f.open(true); f.start(f.session());
  f.panels[0].dispose();
  await f.api.shutdownPlayer();
  const before = await fs.readFile(path.join(f.root, 'Skein.skein'), 'utf8');
  await f.open(false);
  assert.ok(!f.panels.at(-1).webview.html.includes('recording_handler'));
  f.panels.at(-1).dispose();
  await f.api.shutdownPlayer();
  assert.equal(await fs.readFile(path.join(f.root, 'Skein.skein'), 'utf8'), before);
});

test('overlapping launches leave only the latest session able to save', async t => {
  const f = await fixture(t);
  await Promise.all([f.open(true), f.open(true)]);
  assert.equal(f.panels.length, 1);
  f.start(f.session());
  await f.api.shutdownPlayer();
  const xml = await fs.readFile(path.join(f.root, 'Skein.skein'), 'utf8');
  assert.equal((xml.match(/<item /g) || []).length, 1);
  assert.deepEqual(f.errors, []);
});

test('replay reuses player, embeds escaped commands, isolates sessions, stops on replacement and shutdown without Skein writes', async t => {
  const f = await fixture(t);
  const destination = path.join(f.root, 'Skein.skein');
  await fs.writeFile(destination, 'unchanged');
  const open = commands => f.api.openPlayer(f.runtime, f.story, f.context, { replayCommands: commands });
  const id = () => f.panels[0].webview.html.match(/\], "([^"]+)", message => vscode.postMessage/)[1];
  await open(['wait', '</script><script>bad</script>']);
  const first = id(); const panel = f.panels[0];
  assert.ok(panel.webview.html.includes('installSkeinPlayback'));
  assert.ok(!panel.webview.html.includes('recording_handler'));
  assert.ok(!panel.webview.html.includes('</script><script>bad'));
  assert.ok(panel.webview.html.includes('\\u003c/script>'));
  await assert.rejects(f.api.openPlayer('missing', f.story, f.context, { replayCommands: [] }));
  assert.equal(f.posted.length, 0, 'failed validation leaves replay intact');
  await open(['look']);
  assert.equal(f.panels.length, 1); assert.notEqual(id(), first);
  assert.deepEqual(JSON.parse(JSON.stringify(f.posted[0])), { type: 'skein.playback.stop', sessionId: first });
  panel.receive({ type: 'skein.playback', sessionId: first, kind: 'complete', message: 'stale' });
  assert.deepEqual(f.notices, []);
  panel.receive({ type: 'skein.playback', sessionId: id(), kind: 'complete', message: 'complete' });
  assert.deepEqual(f.notices, ['complete']);
  assert.equal(f.posted.length, 1, 'completion does not close/restart player');
  await f.api.shutdownPlayer();
  assert.equal(f.posted.at(-1).sessionId, id());
  panel.receive({ type: 'skein.playback', sessionId: id(), kind: 'stopped', message: 'closed' });
  assert.deepEqual(f.warnings, []);
  assert.equal(await fs.readFile(destination, 'utf8'), 'unchanged');
});

test('disposing a replay panel allows a fresh player without messaging the closed Webview', async t => {
  const f = await fixture(t);
  await f.api.openPlayer(f.runtime, f.story, f.context, { replayCommands: ['wait'] });
  f.panels[0].dispose();
  await f.api.shutdownPlayer();
  assert.equal(f.posted.length, 0);
  await f.api.openPlayer(f.runtime, f.story, f.context, { replayCommands: ['look'] });
  assert.equal(f.panels.length, 2);
});

async function qualification(f, extra = {}) {
  const promise = f.api.openPlayer(f.runtime, f.story, f.context, { replayCommands: ['n'], qualification: true, ...extra });
  // Attach immediately so an intentionally cancelled launch is always handled.
  promise.catch(() => {});
  for (let i = 0; i < 100 && !f.panels.at(-1)?.webview.html; i++) await new Promise(resolve => setTimeout(resolve, 2));
  const panel = f.panels.at(-1);
  const id = panel.webview.html.match(/\], "([^"]+)", message => vscode.postMessage/)[1];
  return { promise, panel, id };
}

test('qualification completion returns only v3 endpoint data, isolates stale messages, installs SHOWME wrapper', async t => {
  const f = await fixture(t);
  const { promise, panel, id } = await qualification(f);
  assert.match(panel.webview.html, /installRoomQualification/);
  assert.match(panel.webview.html, /installSkeinPlayback/);
  panel.receive({ type: 'skein.playback', sessionId: 'stale', kind: 'complete', message: 'wrong', submitted: 3, endpoints: { start: endpoint('Wrong'), end: endpoint('Wrong') } });
  panel.receive({ type: 'skein.playback', sessionId: id, kind: 'complete', message: 'done', submitted: 3,
    endpoints: { start: endpoint('Ripening Room - room'), end: endpoint('DefectN Room'), object: 553957 } });
  assert.deepEqual(JSON.parse(JSON.stringify(await promise)), { start: endpoint('Ripening Room - room'), end: endpoint('DefectN Room') });
  assert.deepEqual(f.notices, []);
  assert.equal(f.timers.at(-1).cleared, true);
});

for (const failure of ['timeout', 'dispose', 'abort', 'runtime', 'unsupported', 'invalid completion', 'replace']) {
  test(`qualification ${failure} rejects the pending operation`, async t => {
    const f = await fixture(t), controller = new AbortController();
    const { promise, panel, id } = await qualification(f, { signal: controller.signal });
    const rejection = assert.rejects(promise);
    if (failure === 'timeout') f.timers.at(-1).fn();
    if (failure === 'dispose') panel.dispose();
    if (failure === 'abort') controller.abort();
    if (failure === 'runtime') panel.receive({ type: 'error', request: 1, message: 'Runtime failed' });
    if (failure === 'unsupported') panel.receive({ type: 'skein.playback', sessionId: id, kind: 'stopped', message: 'Unsupported non-line input' });
    if (failure === 'invalid completion') panel.receive({ type: 'skein.playback', sessionId: id, kind: 'complete', message: 'done', submitted: 3, endpoints: { start: endpoint('Room') } });
    if (failure === 'replace') await f.open(false);
    await rejection;
  });
}

test('qualification refuses to finalize an active recording or launch without valid runtime assets', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, 'Skein.skein'), 'original');
  await f.open(true);
  await assert.rejects(f.api.openPlayer(f.runtime, f.story, f.context, { replayCommands: ['look'], qualification: true }), /Close the recording/);
  assert.equal(await fs.readFile(path.join(f.root, 'Skein.skein'), 'utf8'), 'original');
  await f.api.shutdownPlayer();
  await assert.rejects(f.api.openPlayer('missing', f.story, f.context, { replayCommands: ['look'], qualification: true }), /directory/);
});

for (const replayEndpoint of ['location', 'termination']) test(`ISkein ${replayEndpoint} uses fresh shared playback without qualification or recording`, async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, 'Skein.skein'), 'untouched');
  const open = () => f.api.openPlayer(f.runtime, f.story, f.context, { replayCommands: ['quit', 'y'], replayEndpoint });
  await open();
  const panel = f.panels[0], previous = panel.webview.html;
  await open();
  assert.notEqual(panel.webview.html, previous);
  assert.match(panel.webview.html, /installSkeinPlayback/);
  assert.doesNotMatch(panel.webview.html, /installRoomQualification|recording_handler|showme/i);
  assert.equal(panel.webview.html.includes('termination: position => position === 2'), replayEndpoint === 'termination');
  assert.equal(await fs.readFile(path.join(f.root, 'Skein.skein'), 'utf8'), 'untouched');
});

test('ISkein refuses to finalize an active recorder', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, 'Skein.skein'), 'untouched');
  await f.open(true);
  await assert.rejects(f.api.openPlayer(f.runtime, f.story, f.context, { replayCommands: ['look'], replayEndpoint: 'location' }), /Close the recording player/);
  assert.equal(await fs.readFile(path.join(f.root, 'Skein.skein'), 'utf8'), 'untouched');
});

for (const replayEndpoint of ['location', 'termination']) test(`completed ISkein ${replayEndpoint} can play again after closing the player`, async t => {
  const f = await fixture(t);
  const open = () => f.api.openPlayer(f.runtime, f.story, f.context, { replayCommands: ['look'], replayEndpoint });
  for (let run = 0; run < 3; run++) {
    await open();
    assert.equal(f.panels.length, run + 1);
    const panel = f.panels.at(-1);
    const sessionId = panel.webview.html.match(/\], "([^"]+)", message => vscode.postMessage/)[1];
    panel.receive({ type: 'skein.playback', sessionId, kind: 'complete', message: 'ISkein playback complete.' });
    panel.dispose();
  }
  await f.api.shutdownPlayer();
  assert.equal(f.notices.length, 3);
  assert.equal(f.posted.length, 0);
  assert.deepEqual(f.errors, []);
});

test('composition host retains live document/session after success and ignores stale completion', async t => {
  const f = await fixture(t), changes = [];
  const composition = { guid: 'root', name: 'Nested route', commands: ['look','north'], endpoint: 'location',
    leaves: [{ context: 'root/member 1', start: 0, end: 1 }, { context: 'root/child/member 1', start: 1, end: 2 }] };
  await f.api.openPlayer(f.runtime,f.story,f.context,{ composition,onPlaybackChange: message => changes.push(message) });
  const panel=f.panels[0], html=panel.webview.html;
  assert.match(html,/installCompositionPlayback/);
  assert.doesNotMatch(html,/installRoomQualification|recording_handler|showme/i);
  assert.equal((html.match(/GiLoad.load_run/g)||[]).length,1);
  const sessionId=html.match(/"([0-9a-f-]{36})", message => vscode.postMessage\(message\)/)[1];
  panel.receive({ type:'skein.playback',sessionId:'stale',kind:'complete',message:'stale' });
  assert.equal(changes.length,0);
  panel.receive({ type:'skein.playback',sessionId,kind:'complete',message:'Composition complete.',submitted:2 });
  assert.equal(changes.length,1);
  assert.equal(panel.webview.html,html);
  assert.equal(f.posted.length,0,'completion does not stop or close the session');
  await f.api.shutdownPlayer();
  assert.equal(f.posted.at(-1).sessionId,sessionId,'session remains available until explicit shutdown');
});

for (const outcome of ['complete', 'stopped', 'partial', 'termination']) test(`project-bound composition ${outcome}: host continuation eligibility and same-document start`, async t => {
  const f = await fixture(t);
  const composition = { name: 'Route', guid: 'root', commands: ['look'], endpoint: outcome === 'termination' ? 'termination' : 'location', leaves: [{ context: 'root/member 1', end: 1 }] };
  await f.api.openPlayer(f.runtime, f.story, f.context, { composition, project: f.root });
  const panel = f.panels[0], html = panel.webview.html;
  for (const match of html.matchAll(/<script nonce="[^"]+">([\s\S]*?)<\/script>/g)) new vm.Script(match[1]);
  const replayId = html.match(/installPlayableContinuation[\s\S]*?window.game_options, "([0-9a-f-]{36})"/)[1];
  assert.equal(f.api.continuationOrigin(f.root), undefined);
  if (outcome !== 'partial') panel.receive({ type: 'skein.playback', sessionId: replayId, kind: outcome === 'termination' ? 'complete' : outcome, message: outcome, submitted: 1 });
  panel.receive({ type: 'playable.continuation', sessionId: replayId, eligible: true });
  if (outcome === 'complete') {
    assert.equal(f.api.continuationOrigin(f.root).name, 'Route');
    assert.equal(f.api.continuationOrigin('another project'), undefined);
    await f.api.recordLiveContinuation(f.root, () => {});
    assert.equal(f.posted.at(-1).type, 'playable.continuation.start');
    assert.equal(f.posted.at(-1).replayId, replayId);
    assert.equal(panel.webview.html, html);
    assert.equal(f.api.continuationOrigin(f.root), undefined);
  } else {
    assert.equal(f.api.continuationOrigin(f.root), undefined);
    await assert.rejects(f.api.recordLiveContinuation(f.root, () => {}), /No eligible/);
  }
  panel.dispose();
  assert.equal(f.api.continuationOrigin(f.root), undefined);
});

for (const outcome of ['pass', 'cancel', 'dispose', 'timeout', 'unavailable', 'none-progress']) test(`hidden test ${outcome} cleans up without replacing or revealing normal player`, async t => {
  const f = await fixture(t);
  await f.open();
  const visible = f.panels[0].webview.html;
  const listeners = new Set(), disposal = new Set(), sent = [];
  let disposed = false;
  const webview = { options: { enableScripts: true, localResourceRoots: [{ fsPath: f.runtime }] }, cspSource: 'vscode-resource:', asWebviewUri: uri => ({ toString: () => uri.fsPath }),
    onDidReceiveMessage(fn) { listeners.add(fn); return { dispose() { listeners.delete(fn); } }; },
    async postMessage(message) { sent.push(message); return outcome !== 'unavailable'; } };
  const panel = { get webview() { if (disposed) throw new Error('Disposed'); return webview; },
    onDidDispose(fn) { disposal.add(fn); return { dispose() { disposal.delete(fn); } }; } };
  Object.defineProperty(webview, 'options', { value: webview.options, writable: false }); // Changing roots reloads VS Code's document.
  const plan = { guid: 'test-guid', name: '</script><script>bad()</script>', commands: ['look'],
    turns: [{ command: 'look', result: '<tag> \r\n桃' }], leaves: [{ context: 'Vector', start: 0, end: 1 }], endpoint: 'location' };
  if (outcome === 'none-progress') { plan.behavior = 'none'; plan.commands.push('wait'); plan.turns.push({ command: 'wait', result: 'Ignored' }); plan.leaves[0].end = 2; }
  const abort = new AbortController();
  const steps = [];
  const pending = f.api.runHiddenTest(f.runtime, f.story, panel, 'shared-nonce', plan, abort.signal, position => steps.push(position));
  const rejection = ['cancel', 'dispose', 'unavailable'].includes(outcome) ? assert.rejects(pending, /cancelled|unavailable/) : null;
  for (let i = 0; !sent.length && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 5));
  const load = sent[0]; assert.equal(load.type, 'test.frame.load');
  assert.doesNotMatch(load.html, /<script[^>]+src=|<link[^>]+href=/);
  assert.match(load.html, /src="data:image\/gif;base64,/);
  const scriptTags = [...load.html.matchAll(/<script([^>]*)>/g)];
  assert.equal(scriptTags.length, 5);
  for (const tag of scriptTags) assert.match(tag[1], /nonce="shared-nonce"/);
  assert.doesNotMatch(load.html, /<script>bad/);
  // JSON escapes must decode to the original response, not literal backslash-u.
  const planLine = load.html.split('\n').find(line => line.trim().startsWith('{"guid":"test-guid"'));
  const encoded = planLine.trim().slice(0, planLine.trim().indexOf(`, "${load.token}"`));
  assert.deepEqual(JSON.parse(encoded).turns, plan.turns);
  assert.equal(f.panels.length, 1); assert.equal(f.panels[0].webview.html, visible);
  assert.equal(webview.options.localResourceRoots[0].fsPath, f.runtime);
  const emit = message => { for (const listener of [...listeners]) listener(message); };
  emit({ type: 'test.frame', token: 'stale', message: { type: 'test.result', sessionId: load.token, status: 'PASS', compared: 1 } });
  if (outcome === 'pass') {
    assert.equal(listeners.size, 1);
    for (const [token, sessionId, position] of [['stale', load.token, 1], [load.token, 'stale', 1], [load.token, load.token, 2], [load.token, load.token, 1]]) {
      emit({ type: 'test.frame', token, message: { type: 'test.step', sessionId, position } });
    }
    assert.deepEqual(steps, [1]);
    emit({ type: 'test.frame', token: load.token, message: { type: 'test.result', sessionId: load.token, status: 'PASS', compared: 1 } });
    assert.equal((await pending).status, 'PASS');
  } else if (outcome === 'none-progress') {
    emit({ type: 'test.frame', token: load.token, message: { type: 'test.progress', sessionId: load.token, completed: 1, compared: 0 } });
    emit({ type: 'test.frame', token: load.token, message: { type: 'test.step', sessionId: load.token, position: 2 } });
    assert.deepEqual(steps, [2]);
    f.timers.at(-1).fn();
    const result = await pending;
    assert.equal(result.status, 'FAIL'); assert.equal(result.position, 2);
  } else if (outcome === 'cancel') abort.abort();
  else if (outcome === 'dispose') { disposed = true; for (const listener of [...disposal]) listener(); }
  else if (outcome === 'timeout') {
    f.timers.at(-1).fn();
    const result = await pending;
    assert.equal(result.status, 'FAIL'); assert.equal(result.position, 1);
  }
  if (rejection) await rejection;
  assert.equal(listeners.size, 0); assert.equal(disposal.size, 0);
  assert.equal(f.panels[0].webview.html, visible);
  assert.deepEqual(f.errors, []); assert.deepEqual(f.notices, []);
});
