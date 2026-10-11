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

async function fixture(t) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'informant-workspace-'));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const uri = fsPath => ({ fsPath, path: fsPath, scheme: 'file', toString: () => fsPath });
  let receive;
  const opened = [];
  const messages = [];
  const panels = [];
  const vscode = {
    Uri: { file: uri, joinPath: (base, ...parts) => uri(path.join(base.fsPath, ...parts)) },
    ViewColumn: { Active: 1 },
    commands: { executeCommand: async (...args) => opened.push(args) },
    workspace: {
      workspaceFolders: [{ uri: uri(path.join(parent, 'current')) }],
      getConfiguration: () => ({ get: (_, fallback) => fallback }),
      fs: {
        stat: u => fs.stat(u.fsPath), readDirectory: u => fs.readdir(u.fsPath),
        createDirectory: u => fs.mkdir(u.fsPath, { recursive: true }),
        writeFile: (u, bytes) => fs.writeFile(u.fsPath, bytes)
      }
    },
    window: {
      createWebviewPanel: () => { const panel = { webview: { postMessage: async m => messages.push(m), onDidReceiveMessage: fn => { receive = fn; return { dispose() {} }; } }, dispose() {}, onDidDispose() {} }; panels.push(panel); return panel; },
      showOpenDialog: async () => [uri(parent)],
      showInformationMessage: async () => 'Open Project'
    }
  };
  const sandbox = { module: { exports: {} }, process, Buffer, require(name) {
    if (name === 'vscode') return vscode;
    if (name === './project-conversion') return require('../project-conversion');
    if (name.startsWith('./')) return {};
    return require(name);
  } };
  vm.createContext(sandbox);
  vm.runInContext(await fs.readFile(path.join(__dirname, '../extension.js'), 'utf8'), sandbox);
  vm.runInContext('output = { show() {}, appendLine() {} };', sandbox);
  return { parent, vscode, opened, messages, panels, run: code => vm.runInContext(code, sandbox), receive: message => receive(message) };
}

for (const openAfterCreate of [true, false]) test(`creation opens container (immediate=${openAfterCreate}) and preserves native metadata`, async t => {
  const f = await fixture(t);
  await f.run('createProject()');
  await f.receive({ command: 'browse' });
  await f.receive({ command: 'create', title: 'PeachesNCream', author: 'Author', openAfterCreate });
  const workspace = path.join(f.parent, 'PeachesNCream.informant');
  const project = path.join(workspace, 'PeachesNCream.inform');
  assert.deepEqual(await fs.readdir(workspace), ['PeachesNCream.inform']);
  assert.deepEqual((await fs.readdir(project)).sort(), ['.informant.json', 'Source', 'uuid.txt']);
  assert.match(await fs.readFile(path.join(project, 'Source/story.ni'), 'utf8'), /"PeachesNCream"/);
  assert.equal(f.opened[0][0], 'vscode.openFolder');
  assert.equal(f.opened[0][1].fsPath, workspace);
  f.vscode.workspace.workspaceFolders = [{ uri: f.vscode.Uri.file(workspace) }];
  assert.equal(f.run('findProjectRoot()'), project);
  assert.equal(f.run('findProjectPaths().materialsRoot'), path.join(workspace, 'PeachesNCream.materials'));
  await assert.rejects(f.run(`createInform7StoryProject(vscode.Uri.file(${JSON.stringify(f.parent)}), 'PeachesNCream', 'Author')`), /non-empty workspace/);
});

for (const container of [false, true]) test(`resolution and opening preserve existing layout container=${container}`, async t => {
  const f = await fixture(t);
  const workspace = container ? path.join(f.parent, 'PeachesNCream.informant') : f.parent;
  const project = path.join(workspace, 'PeachesNCream.inform');
  await fs.mkdir(path.join(project, 'Source'), { recursive: true });
  await fs.writeFile(path.join(project, 'Source/story.ni'), '"PeachesNCream"');
  const openedFolder = container ? workspace : project;
  f.vscode.workspace.workspaceFolders = [{ uri: f.vscode.Uri.file(openedFolder) }];
  for (const active of [undefined, path.join(project, 'Source/story.ni'), path.join(project, '.informant/working/iskein.iskein'), path.join(workspace, 'PeachesNCream.materials/Release')]) {
    f.vscode.window.activeTextEditor = active ? { document: { uri: f.vscode.Uri.file(active) } } : undefined;
    assert.equal(f.run('findProjectRoot()'), project);
    assert.equal(f.run('findProjectPaths().workspaceRoot'), openedFolder);
    assert.equal(f.run('findProjectPaths().materialsRoot'), path.join(workspace, 'PeachesNCream.materials'));
  }
  f.vscode.window.showOpenDialog = async () => [f.vscode.Uri.file(openedFolder)];
  await f.run('openProject()');
  if (!container) {
    assert.equal(f.opened.length, 0);
    await f.receive({ command: 'openOriginal' });
  }
  assert.equal(f.opened[0][1].fsPath, openedFolder);
  assert.deepEqual(await fs.readdir(project), ['Source']);
  assert.deepEqual(await fs.readdir(workspace), ['PeachesNCream.inform']);
});

test('unrecognized workspace does not become a compiler project', async t => {
  const f = await fixture(t);
  assert.equal(f.run('findProjectRoot()'), undefined);
});

for (const withMaterials of [true, false]) test(`conversion copies native files and optional materials=${withMaterials}`, async t => {
  const f = await fixture(t);
  const source = path.join(f.parent, 'Original.inform');
  const materials = path.join(f.parent, 'Original.materials');
  const destination = path.join(f.parent, 'destination');
  await fs.mkdir(path.join(source, 'Source'), { recursive: true });
  await fs.mkdir(destination);
  await fs.writeFile(path.join(source, 'Source/story.ni'), 'original source');
  await fs.writeFile(path.join(source, 'uuid.txt'), 'original uuid');
  if (withMaterials) {
    await fs.mkdir(path.join(materials, 'Extensions'), { recursive: true });
    await fs.writeFile(path.join(materials, 'Extensions/example.i7x'), 'extension');
  }
  f.vscode.window.showOpenDialog = async () => [f.vscode.Uri.file(source)];
  await f.run('openProject()');
  const html = f.panels[0].webview.html;
  assert.match(html, /Convert Inform Project/);
  assert.match(html, /Open Original/);
  new vm.Script(html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)[1]);
  f.vscode.window.showOpenDialog = async options => {
    assert.equal(options.defaultUri.fsPath, os.homedir());
    return [f.vscode.Uri.file(destination)];
  };
  await f.receive({ command: 'browse' });
  await f.receive({ command: 'create' });
  assert.equal(f.messages.some(m => m.command === 'error'), false);
  const container = path.join(destination, 'Original.informant');
  assert.equal(f.opened[0][1].fsPath, container);
  for (const root of [source, path.join(container, 'Original.inform')]) {
    assert.equal(await fs.readFile(path.join(root, 'Source/story.ni'), 'utf8'), 'original source');
    assert.equal(await fs.readFile(path.join(root, 'uuid.txt'), 'utf8'), 'original uuid');
  }
  if (withMaterials) assert.equal(await fs.readFile(path.join(container, 'Original.materials/Extensions/example.i7x'), 'utf8'), 'extension');
});

test('conversion cancellation leaves the source and workspace untouched', async t => {
  const f = await fixture(t);
  await f.run(`convertProject(vscode.Uri.file(${JSON.stringify(path.join(f.parent, 'Original.inform'))}))`);
  await f.receive({ command: 'cancel' });
  assert.equal(f.opened.length, 0);
  assert.deepEqual(await fs.readdir(f.parent), []);
});

test('conversion rejects source descendants, aliases, and existing destinations', async t => {
  const f = await fixture(t);
  const { copyInformProject } = require('../project-conversion');
  const source = path.join(f.parent, 'Original.inform');
  const materials = path.join(f.parent, 'Original.materials');
  await fs.mkdir(path.join(source, 'Source'), { recursive: true });
  await fs.writeFile(path.join(source, 'Source/story.ni'), 'source');
  await fs.mkdir(materials);
  const alias = path.join(f.parent, 'alias');
  await fs.symlink(source, alias, 'dir');
  for (const destination of [source, path.join(source, 'Source'), materials, alias]) {
    await assert.rejects(copyInformProject(source, destination), /outside the original/);
  }
  await fs.mkdir(path.join(f.parent, 'Original.informant'));
  await assert.rejects(copyInformProject(source, f.parent), /destination already exists/);
  assert.equal(await fs.readFile(path.join(source, 'Source/story.ni'), 'utf8'), 'source');
});

test('conversion preserves Skein and opens the copy without prompting or importing', async t => {
  const f = await fixture(t);
  const source = path.join(f.parent, 'Original.inform');
  const destination = path.join(f.parent, 'destination');
  await fs.mkdir(path.join(source, 'Source'), { recursive: true });
  await fs.mkdir(destination);
  await fs.writeFile(path.join(source, 'Source/story.ni'), 'source');
  await fs.writeFile(path.join(source, 'Skein.skein'), 'skein');
  const copied = path.join(destination, 'Original.informant/Original.inform');
  f.vscode.window.showInformationMessage = async () => {
    assert.fail('Project conversion must not offer Skein import');
  };
  f.run('globalThis.handoff = []; compileProject = async (...args) => handoff.push(args); testStoryPath = async root => root; openProjectTestManager = async (...args) => handoff.push(args);');
  await f.run(`convertProject(vscode.Uri.file(${JSON.stringify(source)}))`);
  f.vscode.window.showOpenDialog = async () => [f.vscode.Uri.file(destination)];
  await f.receive({ command: 'browse' });
  await f.receive({ command: 'create' });
  const handoff = JSON.parse(f.run('JSON.stringify(handoff)'));
  assert.deepEqual(handoff, []);
  assert.equal(f.messages.some(message => message.command === 'error'), false);
  assert.equal(await fs.readFile(path.join(copied, 'Skein.skein'), 'utf8'), 'skein');
  assert.equal(f.opened[0][1].fsPath, path.dirname(copied));
  assert.equal(await fs.readFile(path.join(source, 'Skein.skein'), 'utf8'), 'skein');
});
