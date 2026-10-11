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
// Optional real Quixe run: the production document, loader, VM, Glk and replay
// all execute; only GlkOte's DOM display and VS Code transport are simulated.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { discoverPlayables } = require('../composition-library');
const { qualifiedTests, runTests } = require('../test-runner');
const project = process.env.TEST_RUNNER_PROJECT, runtime = process.env.TEST_RUNNER_RUNTIME;

test('hidden production document uses fresh real Quixe VMs, captures exact responses and fails fast',
  { skip: !project || !runtime, timeout: 60000 }, async t => {
    const listeners = new Set(), closed = new Set(), browsers = [], events = [], notices = [];
    const scripts = await Promise.all(['quixe.min.js', 'glkote.min.js'].map(name => fs.readFile(path.join(runtime, 'lib', name), 'utf8')));
    const panel = { onDidDispose(fn) { closed.add(fn); return { dispose() { closed.delete(fn); } }; },
      webview: { options: { enableScripts: true, localResourceRoots: [{ fsPath: await fs.realpath(runtime) }] }, cspSource: 'vscode-resource:', asWebviewUri: uri => ({ toString: () => uri.fsPath }),
        onDidReceiveMessage(fn) { listeners.add(fn); return { dispose() { listeners.delete(fn); } }; },
        async postMessage(message) {
          if (message.type === 'test.frame.load') launch(message);
          if (message.type === 'test.frame.remove') browsers.find(b => b.token === message.token)?.dispose();
          return true;
        } } };
    const vscode = { Uri: { file: fsPath => ({ fsPath }) }, window: { createWebviewPanel() { throw new Error('Normal player must remain closed'); },
      showInformationMessage: value => notices.push(value), showErrorMessage: value => notices.push(value) } };
    const file = path.join(__dirname, '..', 'quixe-player.js'), local = createRequire(file);
    const host = { module: { exports: {} }, require: id => id === 'vscode' ? vscode : local(id), setTimeout, clearTimeout };
    vm.runInNewContext(await fs.readFile(file, 'utf8'), host);
    function launch(message) {
      const timers = new Set(), handlers = {};
      const browser = { token: message.token, console, Uint8Array, TextEncoder,
        atob: text => Buffer.from(text, 'base64').toString('binary'),
        setTimeout(fn, delay) { const id = setTimeout(() => { timers.delete(id); fn(); }, delay === 180 ? 0 : delay); timers.add(id); return id; },
        clearTimeout(id) { clearTimeout(id); timers.delete(id); },
        dispose() { for (const id of timers) clearTimeout(id); timers.clear(); },
        document: { createElement: () => ({}), getElementById: () => ({ textContent: '', style: {} }) },
        $: () => ({ on() {}, ready(fn) { fn(); } }),
        addEventListener(type, fn) { handlers[type] = fn; },
        parent: { postMessage(value) { for (const fn of [...listeners]) fn(value); } } };
      browser.window = browser; browsers.push(browser); vm.createContext(browser);
      for (const source of scripts) vm.runInContext(source, browser);
      browser.GlkOteClass = class {
        init(iface) {
          this.iface = iface;
          const accept = iface.accept;
          iface.accept = event => { this.input = event; if (event.type === 'line') events.push({ token: message.token, command: event.value }); return accept(event); };
          iface.accept({ type: 'init', gen: 0, metrics: { width: 800, height: 600, charwidth: 8, charheight: 16 } });
        }
        getinterface() { return this.iface; }
        update(output) { this.iface.recording_handler?.({ input: null, output }); this.input = undefined; }
        getlibrary() { return null; } log() {} warning() {} error(message) { throw new Error(message); }
      };
      // Vendor scripts are loaded above with a simulated DOM; execute only
      // the document's bridge and startup scripts here.
      const inline = [...message.html.matchAll(/<script nonce="[^"]+">([\s\S]*?)<\/script>/g)];
      for (const match of [inline[0], inline.at(-1)]) vm.runInContext(match[1], browser);
    }
    t.after(() => browsers.forEach(browser => browser.dispose()));
    const library = await discoverPlayables(project), plans = qualifiedTests(library.playables);
    assert.ok(plans.some(plan => plan.type === 'iskein' && plan.commands.length));
    const plan = plans.find(plan => plan.type === 'iskein' && plan.commands.length);
    const story = path.join(project, 'Build', 'output-test.ulx');
    const execute = (plan, signal) => host.module.exports.runHiddenTest(runtime, story, panel, 'nonce', plan, signal);
    const first = await execute(plan, new AbortController().signal);
    assert.equal(first.status, 'PASS', JSON.stringify(first));
    const bad = { ...plan, turns: plan.turns.map((turn, index) => index === 0 ? { ...turn, result: turn.result + ' deliberate mismatch' } : turn) };
    const results = await runTests([bad, plan], execute, new AbortController().signal);
    assert.deepEqual(results.map(row => row.status), ['FAIL', 'PASS']);
    assert.equal(events.filter(event => event.token === browsers[1].token).length, 1);
    assert.equal(new Set(browsers.map(browser => browser.token)).size, 3);
    assert.equal(listeners.size, 0); assert.equal(closed.size, 0); assert.deepEqual(notices, []);
    for (const composition of plans.filter(plan => plan.type === 'icomposition')) {
      const result = await execute(composition, new AbortController().signal);
      assert.equal(result.status, 'PASS', `${composition.name}: ${JSON.stringify(result)}`);
    }
    const nested = plans.find(plan => plan.type === 'icomposition' && plan.turns.length > 1);
    if (nested) {
      const target = nested.turns.findIndex(turn => turn.vectorGuid !== nested.turns[0].vectorGuid);
      const index = target < 0 ? 0 : target;
      const changed = { ...nested, turns: nested.turns.map((turn, i) => i === index ? { ...turn, result: turn.result + ' mismatch' } : turn) };
      const [result] = await runTests([changed], execute, new AbortController().signal);
      assert.equal(result.status, 'FAIL');
      assert.equal(result.failure.vectorGuid, nested.turns[index].vectorGuid);
      assert.equal(result.failure.position, index + 1);
    }
  });
