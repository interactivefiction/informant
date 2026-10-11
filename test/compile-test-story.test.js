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
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const util = require('node:util');
const manifest = require('../package.json');

async function fixture(t, { clean = false, failStage, failureOutput = { stdout: 'Source/story.ni:2: error: fixture problem' }, omitOutput = false, inblorb = true, container = false } = {}) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'informant-build-'));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const workspace = container ? path.join(temporary, 'PeachesNCream.informant') : path.join(temporary, 'PeachesNCream.inform');
  const root = container ? path.join(workspace, 'PeachesNCream.inform') : workspace;
  const storage = path.join(temporary, 'storage');
  const internal = path.join(storage, 'toolchains', '10.1.2');
  const bin = path.join(internal, 'Compilers');
  await fs.mkdir(path.join(root, 'Source'), { recursive: true });
  await fs.mkdir(path.join(root, 'Build'));
  await fs.mkdir(bin, { recursive: true });
  await fs.writeFile(path.join(root, 'Source', 'story.ni'), '"Fixture"\nThe Laboratory is a room.');
  for (const name of ['inform7', 'inform6', ...(inblorb ? ['inblorb'] : [])]) {
    await fs.writeFile(path.join(bin, process.platform === 'win32' ? name + '.exe' : name), '');
  }
  let managerArgs;
  const commands = new Map(), calls = [], errors = [], messages = [], logs = [], plays = [], published = [];
  let saves = 0;
  const execFile = () => {};
  execFile[util.promisify.custom] = async (file, args, options) => {
    const stage = path.basename(file).replace(/\.exe$/, '');
    calls.push({ stage, args: Array.from(args), cwd: options.cwd });
    if (stage === failStage) throw Object.assign(new Error('compiler failed'), { code: 1, ...failureOutput });
    if (stage === 'inform7') {
      await fs.mkdir(path.join(root, 'Build'), { recursive: true });
      await fs.writeFile(path.join(root, 'Build', 'auto.inf'), 'generated intermediate');
    } else if (!omitOutput) await fs.writeFile(args.at(-1), stage + ' artifact');
    return { stdout: '', stderr: '' };
  };
  const vscode = {
    commands: { executeCommand() {}, registerCommand(id, fn) { assert.ok(!commands.has(id)); commands.set(id, fn); return { dispose() {} }; } },
    workspace: { onDidChangeConfiguration: () => ({ dispose() {} }), workspaceFolders: [{ uri: { fsPath: workspace } }], getConfiguration: () => ({ get: (key, fallback) => key === 'build.cleanBeforeCompile' ? clean : fallback }) },
    window: {
      activeTextEditor: { document: { uri: { fsPath: path.join(root, 'Source', 'story.ni') }, async save() { saves++; } } },
      createOutputChannel: () => ({ clear() {}, show() {}, append: text => logs.push(text), appendLine: text => logs.push(text) }),
      showErrorMessage: message => errors.push(message), showInformationMessage: message => messages.push(message)
    },
    languages: { createDiagnosticCollection: () => ({ clear() {}, set: (uri, values) => published.push({ uri, values }) }) },
    Uri: { file: fsPath => ({ fsPath }) },
    Range: class { constructor(...args) { this.args = args; } },
    Diagnostic: class { constructor(range, message) { this.range = range; this.message = message; } },
    DiagnosticSeverity: { Error: 0 }
  };
  if (container) vscode.window.activeTextEditor = undefined;
  const sandbox = { module: { exports: {} }, process, require(name) {
    if (name === './test-manager') return { openTestManager: async (...args) => { managerArgs = args; } };
    if (name === './package.json') return require('../package.json');
    if (name === './skein') return require('../skein');
    if (name === 'vscode') return vscode;
    if (name === 'child_process') return { ...require(name), execFile };
    if (name === './quixe-player') return { openPlayer: async (...args) => plays.push(args), runHiddenTest: async (...args) => plays.push(args) };
    if (name === './documentation-viewer' || name === './index-viewer') return {};
    return require(name);
  } };
  vm.runInNewContext(await fs.readFile(path.join(__dirname, '..', 'extension.js'), 'utf8'), sandbox);
  sandbox.module.exports.activate({ subscriptions: [], globalStorageUri: { fsPath: storage } });
  return { vscode, managerArgs: () => managerArgs, root, internal, commands, calls, errors, messages, logs, plays, published, saves: () => saves,
    setActiveFile(file) { vscode.window.activeTextEditor.document.uri.fsPath = file; },
    forbidStoryDiscovery() { vm.runInNewContext('findStory = () => { throw new Error("Story discovery must not run"); };', sandbox); }
  };
}

const oldCommands = ['compile', 'compileAndPlay', 'play', 'showErrors', 'openDocs', 'openIndex', 'createProject', 'openProject', 'installExtension', 'clean', 'installToolchain', 'manageToolchains', 'selectToolchain', 'showStorage'];
test('new command is activated, registered, and contributed to the Command Palette alongside existing commands', async t => {
  const f = await fixture(t);
  assert.ok(manifest.activationEvents.includes('onCommand:informant.compileTestStory'));
  assert.equal(manifest.contributes.commands.find(c => c.command === 'informant.compileTestStory').title, 'Informant: Compile Test Story');
  assert.ok(manifest.contributes.menus.commandPalette.some(c => c.command === 'informant.compileTestStory' && !c.when));
  for (const id of [...oldCommands, 'compileTestStory', 'playForTest']) {
    assert.equal(typeof f.commands.get('informant.' + id), 'function');
    assert.ok(manifest.contributes.commands.some(c => c.command === 'informant.' + id));
  }
});

for (const clean of [false, true]) test(`test build preserves normal artifacts (cleanBeforeCompile=${clean})`, async t => {
  const f = await fixture(t, { clean, inblorb: false });
  const normal = path.join(f.root, 'Build', 'output.ulx');
  const blorb = path.join(f.root, 'Build', 'output.gblorb');
  await fs.writeFile(normal, 'existing normal story');
  await fs.writeFile(blorb, 'existing release');
  const before = await fs.stat(normal);
  await f.commands.get('informant.compileTestStory')();
  assert.deepEqual(f.calls, [
    { stage: 'inform7', args: ['-internal', f.internal, '-format=Inform6/32d', '-project', f.root], cwd: f.root },
    { stage: 'inform6', args: ['-wxE2kSDG', '$huge', path.join(f.root, 'Build', 'auto.inf'), path.join(f.root, 'Build', 'output-test.ulx')], cwd: f.root }
  ]);
  assert.equal(await fs.readFile(normal, 'utf8'), 'existing normal story');
  assert.equal((await fs.stat(normal)).mtimeMs, before.mtimeMs);
  assert.equal(await fs.readFile(blorb, 'utf8'), 'existing release');
  assert.equal(await fs.readFile(path.join(f.root, 'Build', 'output-test.ulx'), 'utf8'), 'inform6 artifact');
  assert.deepEqual(f.errors, []);
  assert.deepEqual(f.messages, ['Informant build completed: output-test.ulx']);
  assert.equal(f.saves(), 1);
  assert.equal(f.plays.length, 0);
});

test('test build creates neither normal ULX nor GBlorb and existing Play recognizes test ULX as fallback', async t => {
  const f = await fixture(t);
  await f.commands.get('informant.compileTestStory')();
  for (const name of ['output.ulx', 'output.gblorb']) await assert.rejects(fs.access(path.join(f.root, 'Build', name)), { code: 'ENOENT' });
  await f.commands.get('informant.play')();
  assert.equal(f.plays[0][1], path.join(f.root, 'Build', 'output-test.ulx'));
});

for (const command of ['compile', 'compileAndPlay']) test(`existing ${command} keeps the exact normal/release pipeline`, async t => {
  const f = await fixture(t, { clean: true });
  await f.commands.get('informant.compileTestStory')();
  f.calls.length = 0;
  await f.commands.get('informant.' + command)();
  assert.deepEqual(f.calls, [
    { stage: 'inform7', args: ['-internal', f.internal, '-format=ulx', '-project', f.root, '-release'], cwd: f.root },
    { stage: 'inform6', args: ['-wxE2~S~DG', path.join(f.root, 'Build', 'auto.inf'), path.join(f.root, 'Build', 'output.ulx')], cwd: f.root },
    { stage: 'inblorb', args: [path.join(f.root, 'Release.blurb'), path.join(f.root, 'Build', 'output.gblorb')], cwd: f.root }
  ]);
  assert.deepEqual(f.errors, []);
  assert.equal(f.plays.length, command === 'compileAndPlay' ? 1 : 0);
  if (f.plays.length) assert.equal(f.plays[0][1], path.join(f.root, 'Build', 'output.gblorb'));
  await f.commands.get('informant.compileTestStory')();
  await f.commands.get('informant.play')();
  assert.equal(f.plays.at(-1)[1], path.join(f.root, 'Build', 'output.gblorb'), 'test artifact does not replace the preferred normal story');
});

for (const stage of ['inform7', 'inform6']) test(`test build stops and reports diagnostics on ${stage} failure`, async t => {
  const f = await fixture(t, { failStage: stage });
  await f.commands.get('informant.compileTestStory')();
  assert.deepEqual(f.calls.map(c => c.stage), stage === 'inform7' ? ['inform7'] : ['inform7', 'inform6']);
  assert.match(f.errors[0], /failed \(exit code 1\)/);
  assert.match(f.published[0].values[0].message, /fixture problem/);
  assert.equal(f.messages.length, 0);
  assert.equal(f.plays.length, 0);
});

test('missing test artifact reports failure even when a normal artifact exists', async t => {
  const f = await fixture(t, { omitOutput: true });
  await fs.writeFile(path.join(f.root, 'Build', 'output.ulx'), 'normal');
  await f.commands.get('informant.compileTestStory')();
  assert.match(f.errors[0], /expected output was not found.*output-test\.ulx/);
  assert.equal(f.messages.length, 0);
});

test('Play For Test is activated and contributed to the Command Palette', async t => {
  const f = await fixture(t);
  assert.equal(typeof f.commands.get('informant.playForTest'), 'function');
  assert.ok(manifest.activationEvents.includes('onCommand:informant.playForTest'));
  assert.equal(manifest.contributes.commands.find(c => c.command === 'informant.playForTest').title, 'Informant: Play For Test');
  assert.ok(manifest.contributes.menus.commandPalette.some(c => c.command === 'informant.playForTest' && !c.when));
});

test('Play For Test passes only the exact test artifact to existing Quixe without discovery, writes, or compilation', async t => {
  const f = await fixture(t);
  const story = path.join(f.root, 'Build', 'output-test.ulx');
  const contents = Buffer.alloc(36);
  contents.write('Glul');
  await fs.writeFile(story, contents);
  await fs.utimes(story, 1, 1);
  for (const name of ['output.ulx', 'output.gblorb', 'newest.ulx']) await fs.writeFile(path.join(f.root, 'Build', name), name);
  f.forbidStoryDiscovery();
  const before = await fs.stat(story);
  await f.commands.get('informant.playForTest')();
  assert.deepEqual(f.errors, []);
  assert.equal(f.plays.length, 1);
  assert.equal(f.plays[0][0], path.join(f.internal, 'Player', 'Quixe'));
  assert.equal(f.plays[0][1], story);
  assert.ok(f.plays[0][2].subscriptions);
  assert.deepEqual(f.calls, [], 'no compiler invoked');
  assert.equal(f.saves(), 0);
  assert.deepEqual(await fs.readFile(story), contents);
  assert.equal((await fs.stat(story)).mtimeMs, before.mtimeMs);
  for (const name of ['output.ulx', 'output.gblorb', 'newest.ulx']) assert.equal(await fs.readFile(path.join(f.root, 'Build', name), 'utf8'), name);
});

for (const invalid of ['directory']) test(`Play For Test rejects ${invalid} test artifact without fallback or compilation`, async t => {
  const f = await fixture(t);
  const story = path.join(f.root, 'Build', 'output-test.ulx');
  if (invalid === 'directory') await fs.mkdir(story);
  for (const name of ['output.ulx', 'output.gblorb', 'other.ulx']) await fs.writeFile(path.join(f.root, 'Build', name), name);
  f.forbidStoryDiscovery();
  await f.commands.get('informant.playForTest')();
  assert.deepEqual(f.errors, ['Informant: Test story is missing or unreadable. Run Informant: Compile Test Story first.']);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.plays, []);
});

test('Play For Test uses the current project rather than the last compiled project', async t => {
  const f = await fixture(t);
  await f.commands.get('informant.compileTestStory')();
  assert.equal(f.plays.length, 0, 'compilation remains independent');
  const other = path.join(path.dirname(f.root), 'Other.inform');
  await fs.mkdir(path.join(other, 'Source'), { recursive: true });
  await fs.mkdir(path.join(other, 'Build'));
  await fs.writeFile(path.join(other, 'Source', 'story.ni'), '"Other"');
  const story = path.join(other, 'Build', 'output-test.ulx');
  await fs.writeFile(story, 'other test story');
  f.setActiveFile(path.join(other, 'Source', 'story.ni'));
  f.calls.length = 0;
  f.forbidStoryDiscovery();
  await f.commands.get('informant.playForTest')();
  assert.deepEqual(f.errors, []);
  assert.equal(f.plays[0][1], story);
  assert.deepEqual(f.calls, []);
});

test('Record Skein is registered and selects exactly the current project test artifact without compiling or merging', async t => {
  const f = await fixture(t);
  assert.ok(manifest.activationEvents.includes('onCommand:informant.recordSkein'));
  assert.equal(manifest.contributes.commands.find(c => c.command === 'informant.recordSkein').title, 'Informant: Record Skein');
  assert.ok(manifest.contributes.menus.commandPalette.some(c => c.command === 'informant.recordSkein' && !c.when));
  await f.commands.get('informant.compileTestStory')();
  const other = path.join(path.dirname(f.root), 'Other.inform');
  await fs.mkdir(path.join(other, 'Source'), { recursive: true });
  await fs.mkdir(path.join(other, 'Build'));
  await fs.writeFile(path.join(other, 'Source', 'story.ni'), '"Other"');
  const story = path.join(other, 'Build', 'output-test.ulx');
  await fs.writeFile(story, 'test bytes');
  for (const name of ['output.ulx', 'output.gblorb', 'newest.ulx']) await fs.writeFile(path.join(other, 'Build', name), 'not test');
  await fs.writeFile(path.join(other, 'Skein.skein'), 'existing branched skein');
  f.setActiveFile(path.join(other, 'Source', 'story.ni'));
  f.forbidStoryDiscovery(); f.calls.length = 0;
  const saved = f.saves();
  await f.commands.get('informant.recordSkein')();
  assert.deepEqual(f.errors, []);
  assert.deepEqual(f.calls, []);
  assert.equal(f.saves(), saved);
  assert.equal(f.plays[0][1], story);
  assert.equal(f.plays[0][3].recordingProject, other);
  assert.equal(await fs.readFile(path.join(other, 'Skein.skein'), 'utf8'), 'existing branched skein', 'command does not replace before player readiness');
  assert.equal(await fs.readFile(story, 'utf8'), 'test bytes');
});

for (const invalid of ['directory']) test(`Record Skein rejects ${invalid} test artifact without fallback or Skein writes`, async t => {
  const f = await fixture(t);
  const story = path.join(f.root, 'Build', 'output-test.ulx');
  if (invalid === 'directory') await fs.mkdir(story);
  await fs.writeFile(path.join(f.root, 'Build', 'output.ulx'), 'normal');
  await fs.writeFile(path.join(f.root, 'Skein.skein'), 'previous');
  f.forbidStoryDiscovery();
  await f.commands.get('informant.recordSkein')();
  assert.match(f.errors[0], /Test story is missing or unreadable/);
  assert.deepEqual(f.plays, []); assert.deepEqual(f.calls, []);
  assert.equal(await fs.readFile(path.join(f.root, 'Skein.skein'), 'utf8'), 'previous');
});

test('Record Skein refuses a workspace without Source/story.ni', async t => {
  const f = await fixture(t);
  await fs.unlink(path.join(f.root, 'Source', 'story.ni'));
  await f.commands.get('informant.recordSkein')();
  assert.match(f.errors[0], /No Inform project/);
  assert.deepEqual(f.plays, []);
});

test('ordinary Play and Play For Test never request recording', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, 'Build', 'output-test.ulx'), 'test');
  await fs.writeFile(path.join(f.root, 'Build', 'output.ulx'), 'normal');
  await fs.writeFile(path.join(f.root, 'Skein.skein'), 'keep');
  await f.commands.get('informant.play')();
  await f.commands.get('informant.playForTest')();
  assert.equal(f.plays.length, 2);
  assert.ok(f.plays.every(args => args.length === 3));
  assert.equal(await fs.readFile(path.join(f.root, 'Skein.skein'), 'utf8'), 'keep');
});

test('Record Skein rejects an unreadable test artifact and preserves the old Skein', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, async t => {
  const f = await fixture(t);
  const story = path.join(f.root, 'Build', 'output-test.ulx');
  await fs.writeFile(story, 'test');
  await fs.chmod(story, 0);
  t.after(() => fs.chmod(story, 0o600).catch(() => {}));
  await fs.writeFile(path.join(f.root, 'Skein.skein'), 'previous');
  await fs.writeFile(path.join(f.root, 'Build', 'output.gblorb'), 'fallback');
  f.forbidStoryDiscovery();
  await f.commands.get('informant.recordSkein')();
  assert.match(f.errors[0], /missing or unreadable/);
  assert.deepEqual(f.plays, []); assert.deepEqual(f.calls, []);
  assert.equal(await fs.readFile(path.join(f.root, 'Skein.skein'), 'utf8'), 'previous');
});

test('Play Skein is contributed and launches only current project test story with parsed commands', async t => {
  const { Skein } = require('../skein');
  const f = await fixture(t);
  assert.ok(manifest.activationEvents.includes('onCommand:informant.playSkein'));
  assert.equal(manifest.contributes.commands.find(c => c.command === 'informant.playSkein').title, 'Informant: Play Skein');
  assert.ok(manifest.contributes.menus.commandPalette.some(c => c.command === 'informant.playSkein' && !c.when));
  await f.commands.get('informant.compileTestStory')();
  const project = path.join(path.dirname(f.root), 'Current.inform');
  await fs.mkdir(path.join(project, 'Source'), { recursive: true });
  await fs.mkdir(path.join(project, 'Build'));
  await fs.writeFile(path.join(project, 'Source', 'story.ni'), '"Current"');
  f.setActiveFile(path.join(project, 'Source', 'story.ni'));
  f.forbidStoryDiscovery(); f.calls.length = 0;
  const skein = new Skein();
  for (const command of ['wait', 'wait', 'n', 'look', 's']) {
    const item = skein.item(command); skein.items.at(-1).childId = item.id; skein.items.push(item);
  }
  const source = skein.serialize(), file = path.join(project, 'Skein.skein');
  await fs.writeFile(file, source);
  const before = await fs.stat(file);
  for (const name of ['output-test.ulx', 'output.ulx', 'output.gblorb', 'newest.ulx']) await fs.writeFile(path.join(project, 'Build', name), name);
  const saves = f.saves();
  await f.commands.get('informant.playSkein')();
  assert.deepEqual(f.errors, []); assert.deepEqual(f.calls, []);
  assert.equal(f.saves(), saves); assert.equal(f.plays.length, 1);
  assert.equal(f.plays[0][1], path.join(project, 'Build', 'output-test.ulx'));
  assert.deepEqual(f.plays[0][3].replayCommands, ['wait', 'wait', 'n', 'look', 's']);
  assert.equal(f.plays[0][3].recordingProject, undefined);
  assert.equal(await fs.readFile(file, 'utf8'), source);
  assert.equal((await fs.stat(file)).mtimeMs, before.mtimeMs);
});

for (const choice of ['Yes', 'No', undefined]) test(`Play Skein offers recording when missing (choice=${choice})`, async t => {
  const f = await fixture(t);
  f.forbidStoryDiscovery();
  const prompts = [];
  f.vscode.window.showInformationMessage = async (message, ...actions) => {
    if (actions.length) {
      prompts.push({ message, actions });
      // Keep recording bound to the original project while the prompt is open.
      f.setActiveFile('/elsewhere/Source/story.ni');
      return choice;
    }
  };
  await f.commands.get('informant.playSkein')();
  assert.equal(prompts.length, 1);
  assert.match(prompts[0].message, /Would you like to record a skein/);
  assert.deepEqual(prompts[0].actions, ['Yes', 'No']);
  assert.deepEqual(f.errors, []);
  if (choice === 'Yes') {
    assert.deepEqual(f.calls.map(call => call.stage), ['inform7', 'inform6']);
    assert.equal(f.plays.length, 1);
    assert.equal(f.plays[0][1], path.join(f.root, 'Build', 'output-test.ulx'));
    assert.equal(f.plays[0][3].recordingProject, await fs.realpath(f.root));
    assert.equal(f.plays[0][3].replayCommands, undefined);
  } else {
    assert.deepEqual(f.calls, []);
    assert.deepEqual(f.plays, []);
  }
});

for (const invalid of ['malformed Skein', 'non-linear Skein']) test(`Play Skein rejects ${invalid} without fallback, compilation, or writes`, async t => {
  const f = await fixture(t);
  f.forbidStoryDiscovery();
  await fs.writeFile(path.join(f.root, 'Build', 'output.ulx'), 'normal');
  await fs.writeFile(path.join(f.root, 'Build', 'output-test.ulx'), 'test');
  const destination = path.join(f.root, 'Skein.skein');
  let source;
  if (invalid !== 'missing Skein') {
    const { Skein } = require('../skein');
    const skein = new Skein();
    if (invalid === 'non-linear Skein') skein.items.push(skein.item('disconnected'));
    source = invalid === 'malformed Skein' ? '<Skein>broken' : skein.serialize();
    await fs.writeFile(destination, source);
  }
  await f.commands.get('informant.playSkein')();
  assert.match(f.errors[0], /Cannot play Skein/);
  assert.deepEqual(f.calls, []); assert.deepEqual(f.plays, []);
  if (source) assert.equal(await fs.readFile(destination, 'utf8'), source);
});

for (const missing of [false, true]) test(`Play ISkein reuses or builds the bound test artifact (missing=${missing})`, async t => {
  const f = await fixture(t);
  for (const name of ['output.ulx', 'output.gblorb', ...(!missing ? ['output-test.ulx'] : [])]) await fs.writeFile(path.join(f.root, 'Build', name), name);
  f.forbidStoryDiscovery();
  await f.commands.get('informant.openTestManager')();
  assert.deepEqual(f.errors, []);
  const play = f.managerArgs()[3], signal = new AbortController().signal;
  f.setActiveFile('/untrusted/Source/story.ni');
  {
    await play(['wait', 'quit', 'y'], 'termination', signal);
    assert.equal(f.plays[0][1], path.join(f.root, 'Build', 'output-test.ulx'));
    assert.deepEqual(Array.from(f.plays[0][3].replayCommands), ['wait', 'quit', 'y']);
    assert.equal(f.plays[0][3].replayEndpoint, 'termination');
    assert.equal(f.plays[0][3].signal, signal);
    assert.equal(f.plays[0][3].qualification, undefined);
  }
  assert.equal(f.plays.length, 1);
  assert.deepEqual(f.calls.map(c => c.stage), missing ? ['inform7', 'inform6'] : []);
  assert.ok(f.calls.every(c => c.cwd === f.root));
  assert.equal(f.saves(), missing ? 1 : 0);
});

for (const missing of [false, true]) test(`Record Continuation reuses or builds the bound test artifact (missing=${missing})`, async t => {
  const f = await fixture(t);
  for (const name of ['output.ulx', 'output.gblorb', ...(!missing ? ['output-test.ulx'] : [])]) await fs.writeFile(path.join(f.root, 'Build', name), name);
  f.forbidStoryDiscovery();
  await f.commands.get('informant.openTestManager')();
  const record = f.managerArgs()[4], signal = new AbortController().signal, change = () => {};
  f.setActiveFile('/untrusted/Source/story.ni');
  const vector = { name: 'Selected Starter', turns: [{ command: 'wait', result: 'DO NOT SUBMIT' }] };
  {
    await record(vector, change, signal);
    assert.equal(f.plays[0][1], path.join(f.root, 'Build', 'output-test.ulx'));
    assert.deepEqual(Array.from(f.plays[0][3].replayCommands), ['wait']);
    assert.equal(f.plays[0][3].continuationProject, f.root);
    assert.equal(f.plays[0][3].sourceName, vector.name);
    assert.equal(f.plays[0][3].onContinuationChange, change);
    assert.equal(f.plays[0][3].signal, signal);
    assert.equal(f.plays[0][3].recordingProject, undefined);
  }
  assert.equal(f.plays.length, 1);
  assert.deepEqual(f.calls.map(c => c.stage), missing ? ['inform7', 'inform6'] : []);
  assert.ok(f.calls.every(c => c.cwd === f.root));
  assert.equal(f.saves(), missing ? 1 : 0);
});

for (const container of [false, true]) test(`workspace layout container=${container}: compiler, player and manager receive native project`, async t => {
  const f = await fixture(t, { container });
  await f.commands.get('informant.compile')();
  assert.equal(f.calls.length, 3);
  assert.equal(f.calls[0].args[f.calls[0].args.indexOf('-project') + 1], f.root);
  for (const call of f.calls) assert.equal(call.cwd, f.root);
  assert.equal(f.calls[1].args.at(-1), path.join(f.root, 'Build', 'output.ulx'));
  assert.equal(f.calls[2].args[0], path.join(f.root, 'Release.blurb'));
  await f.commands.get('informant.play')();
  assert.equal(f.plays.at(-1)[1], path.join(f.root, 'Build', 'output.gblorb'));
  await f.commands.get('informant.compileTestStory')();
  await f.commands.get('informant.playForTest')();
  assert.equal(f.plays.at(-1)[1], path.join(f.root, 'Build', 'output-test.ulx'));
  await f.commands.get('informant.openTestManager')();
  assert.equal(f.managerArgs()[0], await fs.realpath(f.root));
  assert.deepEqual(f.errors, []);
});

for (const stream of ['stdout', 'stderr']) test(`Inform 7 build paragraphs from ${stream} populate Problems`, async t => {
  const f = await fixture(t, { failStage: 'inform7', failureOutput: { [stream]: `++ 15% (Drawing inferences)
  >--> The sentence 'The widget is a nonsense' (source text, line 5) appears to
    say two things are the same - I am reading 'widget' and 'nonsense' as two
    different things.
  >--> The sentence 'The frob is a nonsense' (source text,
    line 7) appears to say two things are the same.
  >--> You must provide a room.
++ Ended: Translation failed: 3 problems found
` } });
  await f.commands.get('informant.compile')();
  assert.equal(f.published.length, 1);
  assert.equal(f.published[0].uri.fsPath, path.join(f.root, 'Source', 'story.ni'));
  const problems = f.published[0].values;
  assert.equal(problems.length, 3);
  assert.deepEqual(Array.from(problems, p => p.range.args[0]), [4, 6, 0]);
  assert.match(problems[0].message, /as two different things\.$/);
  assert.match(problems[1].message, /line 7/);
  assert.equal(problems[2].message, 'You must provide a room.');
  assert.ok(problems.every(p => !p.message.includes('Ended:')));
});

for (const stage of ['inform6', 'inblorb']) test(`${stage} build errors populate Problems`, async t => {
  const file = stage === 'inform6' ? 'Build/auto.inf' : 'Release.blurb';
  const f = await fixture(t, { failStage: stage, failureOutput: { stderr: `"${file}", line 21: Error: invalid command\n` } });
  if (stage === 'inblorb') await fs.writeFile(path.join(f.root, file), 'invalid command');
  await f.commands.get('informant.compile')();
  assert.equal(f.published[0].uri.fsPath, path.join(f.root, file));
  assert.equal(f.published[0].values[0].range.args[0], 20);
  assert.equal(f.published[0].values[0].message, 'invalid command');
});

for (const command of ['recordSkein', 'playForTest', 'playSkein']) {
  for (const failStage of [undefined, 'inform7', 'inform6']) test(`${command} builds a missing test story before launch (failure=${failStage})`, async t => {
    const f = await fixture(t, { failStage, clean: true });
    const source = new (require('../skein').Skein)().serialize();
    await fs.writeFile(path.join(f.root, 'Skein.skein'), source);
    await fs.writeFile(path.join(f.root, 'Build', 'output.ulx'), 'normal');
    f.forbidStoryDiscovery();
    await f.commands.get('informant.' + command)();
    assert.deepEqual(f.calls.map(c => c.stage), failStage === 'inform7' ? ['inform7'] : ['inform7', 'inform6']);
    assert.equal(f.plays.length, failStage ? 0 : 1);
    if (failStage) {
      assert.match(f.errors[0], /failed/);
      assert.ok(f.published.length);
    } else {
      assert.deepEqual(f.errors, []);
      assert.equal(f.plays[0][1], path.join(f.root, 'Build', 'output-test.ulx'));
    }
    assert.equal(await fs.readFile(path.join(f.root, 'Skein.skein'), 'utf8'), source);
    assert.equal(await fs.readFile(path.join(f.root, 'Build', 'output.ulx'), 'utf8'), 'normal');
  });
}

for (const callback of [2, 3, 4, 6]) {
  for (const failStage of [undefined, 'inform6']) test(`Test Manager callback ${callback} builds its bound project (failure=${failStage})`, async t => {
    const f = await fixture(t, { failStage });
    await f.commands.get('informant.openTestManager')();
    f.setActiveFile('/untrusted/Source/story.ni');
    const action = f.managerArgs()[callback];
    const argument = callback === 4 ? { name: 'Starter', turns: [] } : [];
    if (failStage) await assert.rejects(action(argument), /Unable to build/);
    else await action(argument);
    assert.deepEqual(f.calls.map(c => c.stage), ['inform7', 'inform6']);
    assert.ok(f.calls.every(c => c.cwd === f.root));
    assert.equal(f.calls[0].args.at(-1), f.root);
    assert.equal(f.plays.length, failStage ? 0 : 1);
    if (!failStage) {
      await action(argument);
      assert.equal(f.calls.length, 2, 'subsequent actions reuse the build');
    }
  });
}

test('automatic test build does not launch when the compiler produces no artifact', async t => {
  const f = await fixture(t, { omitOutput: true });
  await f.commands.get('informant.recordSkein')();
  assert.equal(f.plays.length, 0);
  assert.match(f.errors[0], /expected output was not found/);
});
