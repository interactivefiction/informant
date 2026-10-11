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
// Optional real-compiler/real-Quixe vertical slice. Only the GlkOte display is
// replaced with an in-memory renderer; the packaged loader, Glk, dispatcher,
// Quixe, extension commands and production player document run unchanged.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { execFileSync } = require('node:child_process');
const { parseLinearSkeinTurns } = require('../skein');
const original = process.env.SKEIN_PROJECT;
const internal = process.env.SKEIN_INTERNAL;

async function until(predicate) {
  for (let i = 0; i < 1000; i++) {
    try { if (await predicate()) return; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Acceptance timed out');
}

test('PeachesNCream Make Test Vector: automatic real-runtime qualification and transactional v4 acceptance',
  { skip: !original || !internal, timeout: 60000 }, async t => {
    const canonicalFile = path.join(original, 'Skein.skein');
    const canonical = await fs.readFile(canonicalFile), canonicalStat = await fs.stat(canonicalFile);
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'informant-vector-runtime-'));
    t.after(() => fs.rm(temp, { recursive: true, force: true }));
    const project = path.join(temp, 'PeachesNCream.inform');
    await fs.mkdir(project);
    await fs.cp(path.join(original, 'Source'), path.join(project, 'Source'), { recursive: true });
    for (const name of ['Settings.plist', 'uuid.txt']) await fs.copyFile(path.join(original, name), path.join(project, name));
    const skeinFile = path.join(project, 'Skein.skein');
    await fs.writeFile(skeinFile, canonical);
    const storage = path.join(temp, 'storage');
    await fs.mkdir(path.join(storage, 'toolchains'), { recursive: true });
    await fs.symlink(internal, path.join(storage, 'toolchains', '10.1.2'), 'dir');
    const panels = [], commands = new Map(), errors = [], logs = [], runtimeMessages = [], runtimeEvents = [];
    let suppliedName = 'Peaches acceptance';
    const disposable = () => ({ dispose() {} });
    const vscode = {
      commands: { executeCommand() {}, registerCommand(id, fn) { commands.set(id, fn); return disposable(); } },
      languages: { createDiagnosticCollection: () => ({ clear() {}, set() {}, dispose() {} }) },
      Uri: { file: fsPath => ({ fsPath }) }, ViewColumn: { Active: 1 }, Range: class {}, Diagnostic: class {}, DiagnosticSeverity: { Error: 0 },
      RelativePattern: class {},
      workspace: { onDidChangeConfiguration: () => ({ dispose() {} }), getConfiguration: () => ({ get: (key, fallback) => fallback }),
        createFileSystemWatcher: () => ({ dispose() {}, onDidCreate: disposable, onDidChange: disposable, onDidDelete: disposable }) },
      window: {
        activeTextEditor: { document: { uri: { fsPath: path.join(project, 'Source', 'story.ni') }, async save() {} } },
        createOutputChannel: () => ({ clear() {}, show() {}, append: text => logs.push(text), appendLine: text => logs.push(text) }),
        showErrorMessage: text => errors.push(text), showInformationMessage() {}, showWarningMessage() {},
        showInputBox: async () => suppliedName,
        createWebviewPanel(type) {
          const panel = { type, messages: [], reveal() {}, onDidDispose(fn) { this.onDispose = fn; }, onDidChangeViewState: disposable,
            dispose() { this.onDispose?.(); }, webview: {
              cspSource: 'vscode-resource:', asWebviewUri: uri => ({ toString: () => uri.fsPath }),
              onDidReceiveMessage(fn) { panel.receive = fn; return disposable(); },
              async postMessage(message) {
                panel.messages.push(message);
                if (panel.browser) panel.browser.handlers.message?.({ data: message });
                return true;
              }
            } };
          let html;
          Object.defineProperty(panel.webview, 'html', { get: () => html, set(value) {
            html = value;
            if (type === 'informant.player') launch(panel, value);
          } });
          panels.push(panel); return panel;
        }
      }
    };
    const runtimeScripts = await Promise.all(['quixe.min.js', 'glkote.min.js'].map(name => fs.readFile(path.join(internal, 'Player', 'Quixe', 'lib', name), 'utf8')));
    function launch(panel, html) {
      const handlers = {};
      const browser = { console, setTimeout, clearTimeout, handlers, Uint8Array, TextEncoder, atob: text => Buffer.from(text, 'base64').toString('binary'),
        document: { createElement: () => ({}), getElementById: () => ({ textContent: '', style: {} }) },
        $: () => ({ on() {}, ready(fn) { fn(); } }),
        addEventListener(type, fn) { handlers[type] = fn; },
        acquireVsCodeApi: () => ({ postMessage(message) { runtimeMessages.push(message); panel.receive(message); } }) };
      browser.window = browser; panel.browser = browser;
      vm.createContext(browser);
      for (const source of runtimeScripts) vm.runInContext(source, browser);
      browser.GlkOteClass = class {
        init(iface) {
          this.iface = iface; panel.display = this;
          const accept = iface.accept;
          iface.accept = event => { this.input = event; runtimeEvents.push(event); return accept(event); };
          iface.accept({ type: 'init', gen: 0, metrics: { width: 800, height: 600, charwidth: 8, charheight: 16 } });
        }
        getinterface() { return this.iface; }
        update(output) {
          this.output = output;
          this.iface.recording_handler?.({ input: this.input || null, output });
          this.input = undefined;
        }
        getlibrary() { return null; }
        log() {}
        error(message) { throw new Error(message); }
        warning() {}
      };
      for (const match of html.matchAll(/<script nonce="[^"]+">([\s\S]*?)<\/script>/g)) vm.runInContext(match[1], browser);
    }
    function load(name, overrides = {}) {
      const file = path.join(__dirname, '..', name), local = createRequire(file);
      const scope = { module: { exports: {} }, process, setTimeout, clearTimeout, AbortController,
        require: id => id === 'vscode' ? vscode : overrides[id] || local(id) };
      vm.runInNewContext(require('node:fs').readFileSync(file, 'utf8'), scope, { filename: file });
      return scope.module.exports;
    }
    const player = load('quixe-player.js');
    const manager = load('test-manager.js');
    const extension = load('extension.js', { './quixe-player': player, './test-manager': manager, './documentation-viewer': {}, './index-viewer': {} });
    extension.activate({ subscriptions: [], globalStorageUri: { fsPath: storage } });
    t.after(async () => { await player.shutdownPlayer(); for (const panel of panels) panel.dispose(); });
    await commands.get('informant.compileTestStory')();
    assert.deepEqual(errors, [], logs.join('\n'));
    await commands.get('informant.openTestManager')();
    const panel = panels.find(p => p.type === 'informant.testManager');
    const library = path.join(project, '.informant', 'test-vectors');
    // Regenerate via Record Skein in the disposable copy: the supplied recording
    // may be incomplete, and existing v3 vectors do not declare entry semantics.
    await commands.get('informant.recordSkein')();
    const terminalPlayer = panels.find(p => p.type === 'informant.player');
    for (const command of ['quit', 'y']) {
      const output = terminalPlayer.display.output, request = output.input.find(input => input.type === 'line');
      terminalPlayer.display.getinterface().accept({ type: 'line', gen: output.gen, window: request.id, value: command });
    }
    await player.shutdownPlayer();
    const terminalRecording = await fs.readFile(skeinFile);
    async function playAccepted(vector) {
      const snapshots = await Promise.all([vector.file].map(async file => ({
        file, bytes: await fs.readFile(file), stat: await fs.stat(file)
      })));
      assert.equal(vector.entry, 'initial');
      panel.receive({ type: 'testManager.selectVector', guid: vector.guid });
      await until(() => panel.messages.at(-1).selectedGuid === vector.guid);
      const eventsBefore = runtimeEvents.length, messagesBefore = runtimeMessages.length;
      panel.receive({ type: 'testManager.playVector' });
      await until(() => !panel.messages.at(-1).busy && /^(Playing|Play ISkein failed)/.test(panel.messages.at(-1).operation));
      assert.match(panel.messages.at(-1).operation, /^Playing/);
      await until(() => runtimeMessages.slice(messagesBefore).some(m => m.type === 'skein.playback' && m.kind === 'complete'));
      const completed = runtimeMessages.slice(messagesBefore).find(m => m.type === 'skein.playback' && m.kind === 'complete');
      assert.match(completed.message, vector.end.type === 'termination' ? /terminated normally/ : /continue playing/);
      assert.deepEqual(runtimeEvents.slice(eventsBefore).filter(e => e.type === 'line').map(e => e.value), vector.turns.map(t => t.command));
      for (const snapshot of snapshots) {
        assert.deepEqual(await fs.readFile(snapshot.file), snapshot.bytes);
        assert.equal((await fs.stat(snapshot.file)).mtimeMs, snapshot.stat.mtimeMs);
      }
      await player.shutdownPlayer();
      await assert.rejects(fs.readFile(skeinFile), { code: 'ENOENT' });
      t.diagnostic(`v4 Initial Vector: ${vector.turns.length} commands played standalone to ${vector.end.type || 'location'}; saved files unchanged.`);
    }
    const currentTurns = parseLinearSkeinTurns(terminalRecording.toString('utf8'));
    const terminalEventsBefore = runtimeEvents.length;
    assert.equal(currentTurns.at(-2)?.command.toLowerCase(), 'quit');
    assert.equal(currentTurns.at(-1)?.command.toLowerCase(), 'y');
    panel.receive({ type: 'testManager.makeVector' });
    await until(() => !panel.messages.at(-1).busy && /^(Created|Accept Starter Vector failed)/.test(panel.messages.at(-1).operation));
    assert.match(panel.messages.at(-1).operation, /^Created/);
    assert.equal(panel.messages.at(-1).library.vectors.length, 1);
    assert.deepEqual(panel.messages.at(-1).library.vectors[0].end, { type: 'termination' });
    const terminationFiles = await fs.readdir(library);
    assert.equal(terminationFiles.length, 1);
    const terminatingXML = await fs.readFile(path.join(library, terminationFiles[0]), 'utf8');
    const terminated = JSON.parse(execFileSync('python3', ['-c', `import sys,json,xml.etree.ElementTree as E
r=E.fromstring(sys.stdin.read()); e=r.find('endpoints/end')
print(json.dumps({'version':r.attrib['version'],'entry':r.findtext('entry'),'end':e.attrib,'children':len(e),'turns':[{'command':t.findtext('command') or '', 'result':t.findtext('result') or ''} for t in r.findall('transcript/turn')]}))`], { input: terminatingXML, encoding: 'utf8' }));
    assert.equal(terminated.version, '4');
    assert.equal(terminated.entry, 'initial');
    assert.deepEqual(terminated.end, { type: 'termination' });
    assert.equal(terminated.children, 0);
    assert.deepEqual(terminated.turns, currentTurns);
    assert.deepEqual(runtimeEvents.slice(terminalEventsBefore).filter(e => e.type === 'line').map(e => e.value), ['showme', ...currentTurns.map(t => t.command)]);
    await assert.rejects(fs.readFile(skeinFile), { code: 'ENOENT' });
    t.diagnostic(`Current ${currentTurns.length}-command PeachesNCream Working Skein ending quit/y accepted as v4 termination: ${terminationFiles[0]}`);
    await playAccepted(panel.messages.at(-1).library.vectors[0]);
    // Make a supported working recording using the existing Record Skein path,
    // solely in this disposable copy of the same PeachesNCream source.
    await commands.get('informant.recordSkein')();
    await until(async () => (await fs.readFile(skeinFile, 'utf8')).includes('- start -'));
    let playerPanel = panels.find(p => p.type === 'informant.player');
    for (const command of ['wait', 'wait', 'n', 'look', 's']) {
      const output = playerPanel.display.output, request = output.input.find(input => input.type === 'line');
      playerPanel.display.getinterface().accept({ type: 'line', gen: output.gen, window: request.id, value: command });
    }
    await player.shutdownPlayer();
    const recording = await fs.readFile(skeinFile);
    const expected = parseLinearSkeinTurns(recording.toString('utf8'));
    assert.deepEqual(expected.map(t => t.command), ['wait', 'wait', 'n', 'look', 's']);
    for (const name of ['Peaches acceptance', '']) {
      await fs.writeFile(skeinFile, recording);
      suppliedName = name;
      const previous = panel.messages.length;
      const eventsBefore = runtimeEvents.length;
      panel.receive({ type: 'testManager.makeVector' });
      await until(() => panel.messages.length > previous && !panel.messages.at(-1).busy && /^(Created|Accept Starter Vector failed)/.test(panel.messages.at(-1).operation));
      assert.match(panel.messages.at(-1).operation, /^Created/);
      const completion = runtimeMessages.findLast(m => m.type === 'skein.playback' && m.kind === 'complete');
      assert.equal(completion.endpoints.start.location, 'Ripening Room - room');
      assert.equal(completion.endpoints.end.location, 'Ripening Room - room');
      const diagnostic = ['Ripening Room - room', '    yourself - person', '    shelves - supporter',
        '        folded cloth - supporter', '            peach', '        brass bell', '    north door', '    notice'].join('\n');
      const crc = execFileSync('python3', ['-c', 'import sys,zlib;print(format(zlib.crc32(sys.stdin.buffer.read()), "08X"))'], { input: diagnostic, encoding: 'utf8' }).trim();
      assert.equal(completion.endpoints.start.observation, crc);
      assert.equal(completion.endpoints.end.observation, crc);
      assert.deepEqual(runtimeEvents.slice(eventsBefore).filter(e => e.type === 'line').map(e => e.value), ['showme', 'wait', 'wait', 'n', 'look', 's', 'showme']);
      const files = await fs.readdir(library);
      assert.equal(files.length, name ? 2 : 3);
      assert.equal(panel.messages.at(-1).library.vectors.length, files.length);
      const file = files.find(file => panel.messages.at(-1).operation.includes(file));
      const xml = await fs.readFile(path.join(library, file), 'utf8');
      // Use an independent XML parser for the real emitted document.
      const parsed = JSON.parse(execFileSync('python3', ['-c', `import sys,json,xml.etree.ElementTree as E
r=E.fromstring(sys.stdin.read())
print(json.dumps({'version':r.attrib['version'],'entry':r.findtext('entry'),'guid':r.findtext('identity/guid'),'name':r.findtext('identity/name'),'start':{'location':r.findtext('endpoints/start/location'),'observation':r.findtext('endpoints/start/observation')},'end':{'location':r.findtext('endpoints/end/location'),'observation':r.findtext('endpoints/end/observation')},'turns':[{'command':t.findtext('command'),'result':t.findtext('result'),'sequence':t.attrib['sequence']} for t in r.findall('transcript/turn')]}))`], { input: xml, encoding: 'utf8' }));
      assert.match(xml, /<end type="location">/);
      const discovered = panel.messages.at(-1).library.vectors.find(vector => vector.guid === parsed.guid);
      assert.ok(discovered);
      assert.equal(discovered.entry, 'initial');
      assert.equal(parsed.entry, 'initial');
      assert.deepEqual(discovered.turns, expected);
      panel.receive({ type: 'testManager.selectVector', guid: parsed.guid });
      await until(() => panel.messages.at(-1).selectedGuid === parsed.guid);
      assert.deepEqual(panel.messages.at(-1).library.vectors.find(vector => vector.guid === parsed.guid), discovered);
      assert.equal(parsed.version, '4'); assert.equal(file, parsed.guid + '.iskein');
      assert.equal(parsed.name, name || `Ripening Room - room ${parsed.guid.slice(-4).toUpperCase()}`);
      assert.deepEqual(parsed.start, JSON.parse(JSON.stringify(completion.endpoints.start))); assert.deepEqual(parsed.end, JSON.parse(JSON.stringify(completion.endpoints.end)));
      assert.deepEqual(parsed.turns.map(({ command, result }) => ({ command, result })), expected);
      assert.deepEqual(parsed.turns.map(t => t.sequence), ['1', '2', '3', '4', '5']);
      assert.doesNotMatch(xml, /symbol=|object=|address=|I_ripening_room|gameinfo|553957|<command>showme<\/command>/);
      await assert.rejects(fs.readFile(skeinFile), { code: 'ENOENT' });
      await playAccepted(discovered);
      t.diagnostic(JSON.stringify({ commandCount: expected.length, start: parsed.start, end: parsed.end, guid: parsed.guid, filename: file, name: parsed.name, transcriptTurns: parsed.turns.length }));
    }
    // Continue from an accepted Starter in the same real Quixe instance.
    const { readWorking, workingPath } = require('../working-iskein');
    const source = panel.messages.at(-1).library.vectors.find(v => v.end.type !== 'termination');
    const sourceBytes = await fs.readFile(source.file);
    const storyBytes = await fs.readFile(path.join(project, 'Build', 'output-test.ulx'));
    for (const continuationCommands of [['wait', 'wait', 'n', 'look'], ['quit', 'y'], ['look']]) {
      panel.receive({ type: 'testManager.selectVector', guid: source.guid });
      await until(() => panel.messages.at(-1).selectedGuid === source.guid);
      const eventsBefore = runtimeEvents.length;
      panel.receive({ type: 'testManager.recordContinuation' });
      await until(() => panel.messages.at(-1).continuation?.message.includes('Recording') && !panel.messages.at(-1).busy);
      playerPanel = panels.findLast(p => p.type === 'informant.player');
      const liveDisplay = playerPanel.display;
      const working = await readWorking(project);
      assert.equal(working.entry, 'continuation');
      assert.deepEqual(working.start, source.end);
      assert.deepEqual(working.turns, []);
      assert.deepEqual(runtimeEvents.slice(eventsBefore).filter(e => e.type === 'line').map(e => e.value), [...source.turns.map(t => t.command), 'showme']);
      for (const command of continuationCommands) {
        const output = liveDisplay.output, request = output.input.find(input => input.type === 'line');
        liveDisplay.getinterface().accept({ type: 'line', gen: output.gen, window: request.id, value: command });
        if (command !== 'quit') await until(async () => !!(await readWorking(project)).end);
      }
      await until(() => panel.messages.at(-1).continuation?.count === continuationCommands.length);
      const recorded = await readWorking(project);
      assert.deepEqual(recorded.turns.map(t => t.command), continuationCommands);
      assert.ok(recorded.turns.some(t => t.result.length));
      const beforeCount = panel.messages.at(-1).library.vectors.length;
      if (continuationCommands.length === 1) {
        panel.receive({ type: 'testManager.discardContinuation' });
        await until(() => panel.messages.at(-1).operation === 'Continuation Recording discarded.');
        assert.equal(panel.messages.at(-1).library.vectors.length, beforeCount);
      } else {
        suppliedName = '';
        panel.receive({ type: 'testManager.acceptContinuation' });
        await until(() => !panel.messages.at(-1).busy && /^(Accepted|Continuation accept failed)/.test(panel.messages.at(-1).operation));
        assert.match(panel.messages.at(-1).operation, /^Accepted/);
        assert.equal(playerPanel.display, liveDisplay, 'same interpreter from replay through acceptance');
        const accepted = panel.messages.at(-1).library.vectors.find(v => v.guid === working.guid);
        assert.ok(accepted); assert.equal(accepted.entry, 'continuation');
        assert.deepEqual(accepted.start, source.end);
        assert.deepEqual(accepted.turns, recorded.turns);
        if (continuationCommands[0] === 'quit') assert.deepEqual(accepted.end, { type: 'termination' });
        else assert.equal(accepted.end.location, 'DefectN Room - room');
        const acceptedXML = await fs.readFile(accepted.file, 'utf8');
        assert.match(acceptedXML, /<iskein version="4">/);
        assert.match(acceptedXML, /<entry>continuation<\/entry>/);
        assert.doesNotMatch(acceptedXML, /predecessor|successor|<command>showme/);
        assert.equal(panel.messages.at(-1).library.vectors.length, beforeCount + 1);
        panel.receive({ type: 'testManager.playVector' });
        await until(() => panel.messages.at(-1).operation.includes('requires prior state/composition'));
        t.diagnostic(`Continuation accepted: ${JSON.stringify({ guid: accepted.guid, start: accepted.start, end: accepted.end, commands: continuationCommands })}`);
      }
      if (continuationCommands[0] === 'wait') {
        const previous = panel.messages.at(-1).library.vectors.find(v => v.guid === working.guid);
        await until(async () => (await readWorking(project)).guid !== previous.guid);
        const next = await readWorking(project);
        assert.deepEqual(next.start, previous.end);
        assert.deepEqual(next.turns, []);
        const output = liveDisplay.output, request = output.input[0];
        liveDisplay.getinterface().accept({ type: 'line', gen: output.gen, window: request.id, value: 'look' });
        await until(async () => !!(await readWorking(project)).end);
        const secondRecording = await readWorking(project);
        playerPanel.browser.handlers.pagehide();
        playerPanel.dispose();
        await until(() => panel.messages.at(-1).continuation?.message.includes('Player closed; ready to accept'));
        assert.equal(panel.messages.at(-1).continuation.canAccept, true);
        panel.receive({ type: 'testManager.acceptContinuation' });
        await until(() => !panel.messages.at(-1).busy && panel.messages.at(-1).library.vectors.some(v => v.guid === next.guid));
        const second = panel.messages.at(-1).library.vectors.find(v => v.guid === next.guid);
        assert.deepEqual(second.start, previous.end);
        assert.deepEqual(second.turns, secondRecording.turns);
        assert.deepEqual(second.turns.map(t => t.command), ['look']);
        assert.notEqual(second.guid, previous.guid);
        t.diagnostic('Second segment recorded in the same VM and accepted after player disposal.');
      }
      await assert.rejects(fs.stat(workingPath(project)), /ENOENT/);
      assert.deepEqual(await fs.readFile(source.file), sourceBytes);
      await assert.rejects(fs.readFile(skeinFile), { code: 'ENOENT' });
      assert.deepEqual(await fs.readFile(path.join(project, 'Build', 'output-test.ulx')), storyBytes);
    }
    // Play a saved nested composition, then attach the existing continuation
    // recorder to the exact production VM without replaying any source command.
    const { randomUUID } = require('node:crypto');
    const { serializeComposition } = require('../icomposition');
    const compositionDirectory = path.join(project, '.informant', 'compositions');
    await fs.mkdir(compositionDirectory, { recursive: true });
    const child = { guid: randomUUID(), name: 'Peaches child', entry: 'initial', start: source.start, end: source.end,
      members: [{ type: 'iskein', guid: source.guid }] };
    const parent = { ...child, guid: randomUUID(), name: 'Peaches parent', members: [{ type: 'icomposition', guid: child.guid }] };
    for (const value of [child, parent]) await fs.writeFile(path.join(compositionDirectory, value.guid + '.icomposition'), serializeComposition(value));
    panel.receive({ type: 'testManager.composition', action: 'load', reference: { type: 'icomposition', guid: parent.guid } });
    await until(() => panel.messages.at(-1).composition.committed?.guid === parent.guid);
    const eventsBeforeComposition = runtimeEvents.length;
    panel.receive({ type: 'testManager.composition', action: 'play' });
    await until(() => !!panel.messages.at(-1).continuationOrigin);
    playerPanel = panels.findLast(p => p.type === 'informant.player');
    const compositionDisplay = playerPanel.display, compositionHtml = playerPanel.webview.html;
    assert.deepEqual(runtimeEvents.slice(eventsBeforeComposition).filter(e => e.type === 'line').map(e => e.value), source.turns.map(t => t.command));
    const eventsBeforeRecording = runtimeEvents.length;
    panel.receive({ type: 'testManager.recordContinuation' });
    await until(() => panel.messages.at(-1).continuation?.message.includes('Recording') && !panel.messages.at(-1).busy);
    assert.equal(playerPanel.display, compositionDisplay);
    assert.equal(playerPanel.webview.html, compositionHtml);
    assert.deepEqual(runtimeEvents.slice(eventsBeforeRecording).filter(e => e.type === 'line').map(e => e.value), ['showme']);
    for (const command of ['look', 'wait']) {
      const working = await readWorking(project);
      const output = compositionDisplay.output;
      compositionDisplay.getinterface().accept({ type: 'line', gen: output.gen, window: output.input[0].id, value: command });
      await until(async () => !!(await readWorking(project)).end);
      panel.receive({ type: 'testManager.acceptContinuation' });
      await until(() => !panel.messages.at(-1).busy && panel.messages.at(-1).library.vectors.some(v => v.guid === working.guid));
      const accepted = panel.messages.at(-1).library.vectors.find(v => v.guid === working.guid);
      assert.equal(accepted.entry, 'continuation');
      assert.deepEqual(accepted.turns.map(t => t.command), [command]);
      assert.match(await fs.readFile(accepted.file, 'utf8'), /<iskein version="4">/);
      assert.equal(playerPanel.display, compositionDisplay);
      await until(async () => (await readWorking(project)).guid !== working.guid);
    }
    for (const value of [child, parent]) assert.equal(await fs.readFile(path.join(compositionDirectory, value.guid + '.icomposition'), 'utf8'), serializeComposition(value));
    t.diagnostic('Nested Composition → live recording → two v4 Continuation Vectors: same real Quixe VM, no source replay, unchanged compositions.');
    assert.deepEqual(errors, []);
    assert.deepEqual(await fs.readFile(canonicalFile), canonical);
    assert.equal((await fs.stat(canonicalFile)).mtimeMs, canonicalStat.mtimeMs);
  });
