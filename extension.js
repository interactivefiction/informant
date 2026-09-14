'use strict';

const vscode = require('vscode');
const { openDocumentation } = require('./documentation-viewer');
const cp = require('child_process');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const https = require('https');
const crypto = require('crypto');
const util = require('util');
const { pipeline } = require('stream/promises');
const execFile = util.promisify(cp.execFile);
const exec = util.promisify(cp.exec);

let output;
let diagnostics;
let contextRef;
let lastErrors = [];
let lastBuildRoot;

function activate(context) {
  contextRef = context;
  output = vscode.window.createOutputChannel('Informant');
  diagnostics = vscode.languages.createDiagnosticCollection('informant');
  context.subscriptions.push(output, diagnostics);

  register(context, 'informant.compile', () => compileProject(false));
  register(context, 'informant.compileAndPlay', () => compileProject(true));
  register(context, 'informant.play', playLatest);
  register(context, 'informant.test', testStory);
  register(context, 'informant.showErrors', showErrors);
  register(context, 'informant.openDocs', openDocs);
  register(context, 'informant.createProject', createProject);
  register(context, 'informant.openProject', openProject);
  register(context, 'informant.installExtension', installI7xExtension);
  register(context, 'informant.clean', cleanProject);
  register(context, 'informant.installToolchain', installToolchain);
  register(context, 'informant.manageToolchains', manageToolchains);
  register(context, 'informant.selectToolchain', selectToolchain);
  register(context, 'informant.showStorage', showStorage);
}

function register(context, command, fn) {
  context.subscriptions.push(vscode.commands.registerCommand(command, async () => {
    try { await fn(); }
    catch (err) {
      const message = err && err.message ? err.message : String(err);
      output.appendLine(`[error] ${err && err.stack ? err.stack : message}`);
      output.show(true);
      vscode.window.showErrorMessage(`Informant: ${message}`);
    }
  }));
}

function config() { return vscode.workspace.getConfiguration('informant'); }
function activePath() { return vscode.window.activeTextEditor?.document?.uri?.fsPath; }
function storageRoot() { return contextRef.globalStorageUri.fsPath; }
function toolchainsRoot() { return path.join(storageRoot(), 'toolchains'); }
function platformKey() { return `${process.platform}-${process.arch}`; }
function exe(name) { return process.platform === 'win32' ? `${name}.exe` : name; }
function quoteShell(s) { return process.platform === 'win32' ? `"${String(s).replace(/"/g, '\\"')}"` : `'${String(s).replace(/'/g, `'\\''`)}'`; }
function expandHome(value) { return String(value || '').replace(/^~(?=$|[\\/])/, os.homedir()); }

function findProjectRoot(start = activePath()) {
  let p = start;
  if (!p && vscode.workspace.workspaceFolders?.length) p = vscode.workspace.workspaceFolders[0].uri.fsPath;
  if (!p) return undefined;
  if (fs.existsSync(p) && fs.statSync(p).isFile()) p = path.dirname(p);
  let cur = path.resolve(p);
  while (true) {
    if (cur.endsWith('.inform') || fs.existsSync(path.join(cur, 'Source', 'story.ni'))) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

async function ensureDir(dir) { await fsp.mkdir(dir, { recursive: true }); }
async function exists(p) { try { await fsp.access(p); return true; } catch { return false; } }

async function listToolchains() {
  await ensureDir(toolchainsRoot());
  const names = await fsp.readdir(toolchainsRoot()).catch(() => []);
  const items = [];
  for (const name of names) {
    const root = path.join(toolchainsRoot(), name);
    if (!(await exists(root)) || !(await fsp.stat(root)).isDirectory()) continue;
    const manifestPath = path.join(root, 'informant-toolchain.json');
    let manifest = { id: name, version: name, platform: 'unknown', importedAt: undefined };
    if (await exists(manifestPath)) {
      try { manifest = Object.assign(manifest, JSON.parse(await fsp.readFile(manifestPath, 'utf8'))); } catch { }
    }
    const binDir = await findBinDir(root);
    const internalRoot = binDir && path.basename(binDir) === 'Compilers' ? path.dirname(binDir) : undefined;
    items.push({ id: name, root, binDir, internalRoot, manifest, hasInform7: !!(binDir && await exists(path.join(binDir, exe('inform7')))) });
  }
  items.sort((a, b) => String(b.manifest.importedAt || '').localeCompare(String(a.manifest.importedAt || '')) || b.id.localeCompare(a.id));
  return items;
}

async function findBinDir(root) {
  const candidates = [path.join(root, 'bin'), root, path.join(root, 'inform', 'bin'), path.join(root, 'Compilers')];
  for (const c of candidates) if (await exists(path.join(c, exe('inform7')))) return c;
  // Shallow scan for imported archives with one containing top-level directory.
  const queue = [root];
  while (queue.length) {
    const cur = queue.shift();
    const entries = await fsp.readdir(cur, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const p = path.join(cur, e.name);
      if (await exists(path.join(p, exe('inform7')))) return p;
      if (await exists(path.join(p, 'bin', exe('inform7')))) return path.join(p, 'bin');
      if (path.relative(root, p).split(path.sep).length < 3) queue.push(p);
    }
  }
  return undefined;
}

async function selectedToolchain() {
  const project = findProjectRoot();
  const projectFile = project ? path.join(project, '.informant.json') : undefined;
  let preferred = config().get('toolchain.preferredVersion', 'latest');
  if (projectFile && await exists(projectFile)) {
    try {
      const data = JSON.parse(await fsp.readFile(projectFile, 'utf8'));
      preferred = data.toolchainVersion || preferred;
    } catch { }
  }
  const list = await listToolchains();
  if (!list.length) return undefined;
  if (preferred && preferred !== 'latest') return list.find(t => t.id === preferred || t.manifest.version === preferred) || list[0];
  return list[0];
}

async function resolveTool(name, toolchain) {
  if (toolchain?.binDir) {
    const p = path.join(toolchain.binDir, exe(name));
    if (await exists(p)) return p;
  }
  if (config().get('toolchain.allowSystemFallback', false) && await hasCommand(name)) return name;
  return undefined;
}

async function compileProject(playAfter) {
  const root = findProjectRoot();
  if (!root) throw new Error('Open an Inform project or story.ni first.');
  lastBuildRoot = root;
  await vscode.window.activeTextEditor?.document?.save();
  diagnostics.clear();
  lastErrors = [];
  output.clear();
  output.show(true);

  if (config().get('build.cleanBeforeCompile', false)) await removeBuildArtifacts(root);

  const toolchain = await selectedToolchain();
  if (!toolchain && !config().get('toolchain.allowSystemFallback', false)) {
    const choice = await vscode.window.showWarningMessage(
      'No private Informant toolchain is installed. Install/import one now?',
      'Install Toolchain', 'Use PATH This Time', 'Cancel'
    );
    if (choice === 'Install Toolchain') { await installToolchain(); return; }
    if (choice !== 'Use PATH This Time') return;
  }

  if (!toolchain?.internalRoot || !toolchain.binDir ||
      !(await fsp.stat(toolchain.internalRoot).catch(() => undefined))?.isDirectory()) {
    vscode.window.showErrorMessage('Informant: A packaged toolchain with a valid Internal resource directory is required.');
    return;
  }
  const tools = {};
  for (const name of ['inform7', 'inform6', 'inblorb']) {
    const file = path.join(toolchain.binDir, exe(name));
    if (!(await fsp.stat(file).catch(() => undefined))?.isFile()) {
      vscode.window.showErrorMessage(`Informant: Packaged toolchain is incomplete: missing compiler ${file}.`);
      return;
    }
    tools[name] = file;
  }

  const story = path.join(root, 'Build', 'output.gblorb');
  const stages = [
    { name: 'Stage 1 — Inform 7', executable: tools.inform7,
      args: ['-internal', toolchain.internalRoot, '-format=ulx', '-project', root, '-release'] },
    { name: 'Stage 2 — Inform 6', executable: tools.inform6,
      args: ['-wxE2~S~DG', path.join(root, 'Build', 'auto.inf'), path.join(root, 'Build', 'output.ulx')] },
    { name: 'Stage 3 — Inblorb', executable: tools.inblorb,
      args: [path.join(root, 'Release.blurb'), story] }
  ];
  output.appendLine(`Informant private storage: ${storageRoot()}`);
  output.appendLine(`Toolchain: ${toolchain.id} (${toolchain.root})`);
  output.appendLine(`Internal resources: ${toolchain.internalRoot}`);
  output.appendLine(`cwd: ${root}\n`);

  const captured = [];
  for (const stage of stages) {
    output.appendLine(stage.name);
    output.appendLine(`> ${[stage.executable, ...stage.args].map(quoteShell).join(' ')}`);
    let stdout = '', stderr = '', failure;
    try {
      const result = await execFile(stage.executable, stage.args, { cwd: root, maxBuffer: 32 * 1024 * 1024, env: process.env });
      stdout = result.stdout || ''; stderr = result.stderr || '';
    } catch (err) {
      failure = err;
      stdout = err.stdout || ''; stderr = err.stderr || '';
    }
    const text = [stdout, stderr].filter(Boolean).join('\n');
    captured.push(text);
    output.append(text || '(stage produced no output)\n');
    output.appendLine('');
    if (failure) {
      const status = failure.signal ? `signal ${failure.signal}`
        : failure.code !== undefined ? `exit code ${failure.code}` : failure.message;
      const message = `Informant: ${stage.name} failed (${status}).`;
      output.appendLine(message);
      if (failure.message) output.appendLine(failure.message);
      parseAndPublishErrors(captured.join('\n'), root);
      vscode.window.showErrorMessage(message);
      return;
    }
  }
  parseAndPublishErrors(captured.join('\n'), root);
  if (!(await exists(story))) {
    vscode.window.showErrorMessage(`Informant build did not complete: expected output was not found at ${story}.`);
    return;
  }

  vscode.window.showInformationMessage(`Informant build completed: ${path.basename(story)}`);
  if (playAfter) await playLatest(story);
}

function renderTemplate(template, values) {
  return String(template).replace(/\{([a-zA-Z0-9_]+)\}/g, (_, key) => {
    const value = values[key];
    if (!value) return '';
    return quoteShell(value);
  });
}

async function removeBuildArtifacts(root) {
  for (const name of ['Build', 'Build.output', 'Index']) {
    const p = path.join(root, name);
    if (await exists(p)) await fsp.rm(p, { recursive: true, force: true });
  }
}

function parseAndPublishErrors(text, root) {
  const patterns = [
    /(?:^|\n)([^\n:]+\.(?:ni|i7x)):(\d+)(?::(\d+))?:\s*(?:error|Error|problem|Problem)?\s*:?\s*([^\n]+)/g,
    /(?:^|\n)(?:Error|Problem).*?(?:line|Line)\s+(\d+).*?(?:of|in)\s+([^\n]+?\.(?:ni|i7x))[: ]+([^\n]+)/g,
    /(?:^|\n)([^\n]+?\.(?:ni|i7x))\s+line\s+(\d+)[: ]+([^\n]+)/g
  ];
  for (const raw of config().get('errors.extraPatterns', [])) { try { patterns.push(new RegExp(raw, 'gm')); } catch { } }

  const seen = new Set();
  for (let pi = 0; pi < patterns.length; pi++) {
    const re = patterns[pi];
    let m;
    while ((m = re.exec(text))) {
      let file, line, col = 1, message;
      if (pi === 1) { line = +m[1]; file = m[2].trim(); message = m[3].trim(); }
      else { file = m[1].trim(); line = +m[2]; if (m[4]) { col = +(m[3] || 1); message = m[4].trim(); } else { message = (m[3] || 'Inform compiler problem').trim(); } }
      const abs = resolveSourceFile(root, file);
      if (!abs) continue;
      const key = `${abs}:${line}:${col}:${message}`;
      if (seen.has(key)) continue;
      seen.add(key);
      lastErrors.push({ file: abs, line: Math.max(1, line), col: Math.max(1, col), message });
    }
  }

  const grouped = new Map();
  for (const item of lastErrors) {
    const uri = vscode.Uri.file(item.file);
    const arr = grouped.get(uri.fsPath) || { uri, values: [] };
    arr.values.push(new vscode.Diagnostic(
      new vscode.Range(item.line - 1, item.col - 1, item.line - 1, Math.max(item.col, item.col)),
      item.message,
      vscode.DiagnosticSeverity.Error
    ));
    grouped.set(uri.fsPath, arr);
  }
  for (const { uri, values } of grouped.values()) diagnostics.set(uri, values);
}

function resolveSourceFile(root, f) {
  const cleaned = f.replace(/^\"|\"$/g, '');
  const candidates = [cleaned, path.join(root, cleaned), path.join(root, 'Source', path.basename(cleaned))];
  for (const c of candidates) if (c && fs.existsSync(c)) return path.resolve(c);
  return undefined;
}

async function showErrors() {
  if (!lastErrors.length) {
    vscode.window.showInformationMessage('Informant has no parsed build errors. Compile the project first.');
    return;
  }
  const pick = await vscode.window.showQuickPick(lastErrors.map((e, i) => ({
    label: `$(error) ${path.basename(e.file)}:${e.line}:${e.col}`,
    description: e.message,
    index: i
  })), { placeHolder: 'Select a compiler problem to jump to its source line' });
  if (!pick) return;
  const e = lastErrors[pick.index];
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(e.file));
  const editor = await vscode.window.showTextDocument(doc);
  const pos = new vscode.Position(e.line - 1, e.col - 1);
  editor.selection = new vscode.Selection(pos, pos);
  editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
}

function findStory(root) {
  const preferred = ['story.gblorb', 'output.gblorb', 'story.ulx', 'output.ulx', 'story.z8', 'output.z8', 'story.z5', 'output.z5'];
  const roots = [path.join(root, 'Build'), root];
  for (const r of roots) for (const n of preferred) {
    const p = path.join(r, n); if (fs.existsSync(p)) return p;
  }
  let newest;
  for (const r of roots) {
    if (!fs.existsSync(r)) continue;
    for (const n of fs.readdirSync(r)) {
      if (!/\.(gblorb|glb|ulx|z[3-8])$/i.test(n)) continue;
      const p = path.join(r, n); const stat = fs.statSync(p);
      if (!newest || stat.mtimeMs > newest.mtimeMs) newest = { p, mtimeMs: stat.mtimeMs };
    }
  }
  return newest?.p;
}

async function hasCommand(cmd) {
  if (!cmd) return false;
  if (/[\\/]/.test(cmd)) return exists(cmd);
  try { await execFile(process.platform === 'win32' ? 'where' : 'which', [cmd]); return true; } catch { return false; }
}

async function playLatest(explicitStory) {
  const root = lastBuildRoot || findProjectRoot();
  if (!root) throw new Error('No Inform project is open.');
  const story = explicitStory || findStory(root);
  if (!story) throw new Error('No compiled story file found. Compile first.');

  const toolchain = await selectedToolchain();
  let player = expandHome(config().get('player.command', '').trim());
  const args = config().get('player.args', []);
  if (!player && toolchain) {
    const ext = path.extname(story).toLowerCase();
    const choices = (ext === '.ulx' || ext === '.gblorb' || ext === '.glb') ? ['glulxe', 'git'] : ['dumb-frotz', 'frotz'];
    for (const c of choices) {
      const candidate = path.join(toolchain.binDir || '', exe(c));
      if (await exists(candidate)) { player = candidate; break; }
    }
  }
  if (!player && config().get('toolchain.allowSystemFallback', false)) {
    const ext = path.extname(story).toLowerCase();
    const choices = (ext === '.ulx' || ext === '.gblorb' || ext === '.glb') ? ['glulxe', 'git'] : ['dumb-frotz', 'frotz'];
    for (const c of choices) if (await hasCommand(c)) { player = c; break; }
  }
  if (!player) {
    await vscode.env.openExternal(vscode.Uri.file(story));
    return;
  }
  const terminal = vscode.window.createTerminal({ name: 'Informant Player', cwd: root });
  terminal.show();
  terminal.sendText([quoteShell(player), ...args.map(quoteShell), quoteShell(story)].join(' '));
}

async function testStory() {
  await compileProject(false);
  vscode.window.showInformationMessage('Informant test command currently compiles the story. Transcript/Skein-style testing is reserved for a later revision.');
}

async function openDocs() {
  const toolchain = await selectedToolchain();
  if (!toolchain?.internalRoot) throw new Error('Select an installed Informant toolchain with packaged documentation first.');
  await openDocumentation(path.join(toolchain.internalRoot, 'Documentation'), contextRef);
}

async function createProject() {
  const panel = vscode.window.createWebviewPanel(
    'informant.newProject',
    'Create Inform Project',
    vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: false }
  );

  let parentUri = vscode.Uri.file(os.homedir());
  const currentFolder = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (currentFolder?.scheme === 'file') {
    parentUri = vscode.Uri.file(path.dirname(currentFolder.fsPath));
  }

  panel.webview.html = newProjectHtml(panel.webview, displayUri(parentUri));

  const messageSubscription = panel.webview.onDidReceiveMessage(async message => {
    try {
      if (!message || typeof message !== 'object') return;

      if (message.command === 'browse') {
        const pick = await vscode.window.showOpenDialog({
          defaultUri: parentUri,
          canSelectFolders: true,
          canSelectFiles: false,
          canSelectMany: false,
          openLabel: 'Use This Folder',
          title: 'Choose where Informant should create the project'
        });
        if (!pick?.length) return;
        parentUri = pick[0];
        await panel.webview.postMessage({ command: 'destination', value: displayUri(parentUri) });
        return;
      }

      if (message.command === 'cancel') {
        panel.dispose();
        return;
      }

      if (message.command !== 'create') return;

      const title = String(message.title || '').trim();
      const author = String(message.author || '').trim() || 'Author';
      const projectType = String(message.projectType || 'inform7-story');
      const openAfterCreate = message.openAfterCreate !== false;

      if (projectType !== 'inform7-story') throw new Error('Unsupported project type.');
      if (!title) {
        await panel.webview.postMessage({ command: 'validation', field: 'title', message: 'Enter a story title.' });
        return;
      }

      await panel.webview.postMessage({ command: 'busy', value: true });
      const created = await createInform7StoryProject(parentUri, title, author);
      panel.dispose();

      if (openAfterCreate) {
        await vscode.commands.executeCommand('vscode.openFolder', created.rootUri, false);
        return;
      }

      const choice = await vscode.window.showInformationMessage(
        `Created ${created.projectName}`,
        'Open Project',
        'Reveal Folder'
      );
      if (choice === 'Open Project') {
        await vscode.commands.executeCommand('vscode.openFolder', created.rootUri, false);
      } else if (choice === 'Reveal Folder') {
        await vscode.commands.executeCommand('revealFileInOS', created.rootUri);
      }
    } catch (err) {
      await panel.webview.postMessage({ command: 'busy', value: false });
      await panel.webview.postMessage({ command: 'error', message: err && err.message ? err.message : String(err) });
      const messageText = err && err.message ? err.message : String(err);
      output.appendLine(`[error] ${err && err.stack ? err.stack : messageText}`);
      output.show(true);
    }
  });

  panel.onDidDispose(() => messageSubscription.dispose());
}

async function createInform7StoryProject(parentUri, name, author) {
  const safe = sanitizeProjectName(name);
  if (!safe) throw new Error('The project title does not contain any usable filename characters.');

  const rootUri = vscode.Uri.joinPath(parentUri, `${safe}.inform`);
  const sourceDirUri = vscode.Uri.joinPath(rootUri, 'Source');
  const uuidUri = vscode.Uri.joinPath(rootUri, 'uuid.txt');
  const storyUri = vscode.Uri.joinPath(sourceDirUri, 'story.ni');
  const configUri = vscode.Uri.joinPath(rootUri, '.informant.json');

  if (await uriExists(rootUri)) {
    const entries = await vscode.workspace.fs.readDirectory(rootUri).catch(() => []);
    if (entries.length) {
      throw new Error(`A non-empty project folder already exists: ${displayUri(rootUri)}`);
    }
  }

  output.show(true);
  output.appendLine(`Creating project at: ${rootUri.toString(true)}`);

  await vscode.workspace.fs.createDirectory(sourceDirUri);

  const source = `"${escapeInformString(name.trim())}" by "${escapeInformString(author)}"\n\nThe Starting Room is a room.\n`;
  await vscode.workspace.fs.writeFile(storyUri, Buffer.from(source, 'utf8'));
  await vscode.workspace.fs.writeFile(uuidUri, Buffer.from(crypto.randomUUID(), 'utf8'));

  const projectConfig = JSON.stringify({
    projectType: 'inform7-story',
    toolchainVersion: config().get('toolchain.preferredVersion', 'latest')
  }, null, 2) + '\n';
  await vscode.workspace.fs.writeFile(configUri, Buffer.from(projectConfig, 'utf8'));

  if (!(await uriExists(storyUri)) || !(await uriExists(uuidUri)) || !(await uriExists(configUri))) {
    throw new Error(`Project creation failed verification at ${displayUri(rootUri)}.`);
  }

  output.appendLine(`Created: ${storyUri.toString(true)}`);
  output.appendLine(`Created: ${uuidUri.toString(true)}`);
  output.appendLine(`Created: ${configUri.toString(true)}`);
  return { rootUri, storyUri, configUri, projectName: `${safe}.inform` };
}

function displayUri(uri) {
  return uri.scheme === 'file' ? uri.fsPath : uri.toString(true);
}

function newProjectHtml(webview, destination) {
  const nonce = crypto.randomBytes(16).toString('hex');
  const initialDestination = JSON.stringify(destination).replace(/</g, '\\u003c');
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Create Inform Project</title>
  <style>
    body {
      font-family: var(--vscode-font-family);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      padding: 28px;
    }
    .dialog {
      max-width: 680px;
      margin: 0 auto;
      border: 1px solid var(--vscode-widget-border);
      background: var(--vscode-sideBar-background);
      padding: 24px;
      box-shadow: 0 8px 28px rgba(0,0,0,.18);
    }
    h1 { font-size: 20px; font-weight: 600; margin: 0 0 6px; }
    .subtitle { color: var(--vscode-descriptionForeground); margin-bottom: 22px; }
    .field { margin: 0 0 16px; }
    label { display: block; margin-bottom: 6px; font-weight: 600; }
    input, select {
      box-sizing: border-box;
      width: 100%;
      color: var(--vscode-input-foreground);
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, transparent);
      padding: 7px 9px;
      outline: none;
    }
    input:focus, select:focus { border-color: var(--vscode-focusBorder); }
    .location { display: grid; grid-template-columns: 1fr auto; gap: 8px; }
    button {
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
      border: 0;
      padding: 7px 14px;
      cursor: pointer;
    }
    button:hover { background: var(--vscode-button-hoverBackground); }
    button.secondary {
      color: var(--vscode-button-secondaryForeground);
      background: var(--vscode-button-secondaryBackground);
    }
    button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
    button:disabled { opacity: .55; cursor: default; }
    .checkbox { display: flex; align-items: center; gap: 8px; margin-top: 2px; }
    .checkbox input { width: auto; }
    .preview {
      margin: 18px 0 0;
      padding: 10px 12px;
      background: var(--vscode-textCodeBlock-background);
      color: var(--vscode-descriptionForeground);
      font-family: var(--vscode-editor-font-family);
      font-size: 12px;
      overflow-wrap: anywhere;
    }
    .error { min-height: 18px; margin-top: 12px; color: var(--vscode-errorForeground); }
    .actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 20px; }
  </style>
</head>
<body>
  <main class="dialog">
    <h1>Create Inform Project</h1>
    <div class="subtitle">Create a standard Inform 7 project that Informant can reopen and build later.</div>

    <div class="field">
      <label for="projectType">Project type</label>
      <select id="projectType">
        <option value="inform7-story">Inform 7 Story</option>
      </select>
    </div>

    <div class="field">
      <label for="title">Story title</label>
      <input id="title" type="text" value="My Story" autofocus>
    </div>

    <div class="field">
      <label for="author">Author</label>
      <input id="author" type="text" value="Author">
    </div>

    <div class="field">
      <label for="destination">Location</label>
      <div class="location">
        <input id="destination" type="text" readonly>
        <button id="browse" class="secondary" type="button">Browse…</button>
      </div>
      <div id="preview" class="preview"></div>
    </div>

    <label class="checkbox">
      <input id="openAfterCreate" type="checkbox" checked>
      <span>Open project after creation</span>
    </label>

    <div id="error" class="error" role="alert"></div>

    <div class="actions">
      <button id="cancel" class="secondary" type="button">Cancel</button>
      <button id="create" type="button">Create Project</button>
    </div>
  </main>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const destination = document.getElementById('destination');
    const title = document.getElementById('title');
    const author = document.getElementById('author');
    const projectType = document.getElementById('projectType');
    const openAfterCreate = document.getElementById('openAfterCreate');
    const preview = document.getElementById('preview');
    const error = document.getElementById('error');
    const create = document.getElementById('create');
    const browse = document.getElementById('browse');
    const cancel = document.getElementById('cancel');

    destination.value = ${initialDestination};

    function safeName(value) {
      return String(value || '').replace(/[\\/:*?"<>|]/g, '-').replace(/[. ]+$/g, '').trim();
    }

    function updatePreview() {
      const base = destination.value || '(choose a location)';
      const separator = base.includes('\\\\') || /^[A-Za-z]:/.test(base) ? '\\\\' : '/';
      preview.textContent = base.replace(/[\\\\/]$/, '') + separator + (safeName(title.value) || 'My Story') + '.inform';
      create.disabled = !title.value.trim() || !destination.value;
      error.textContent = '';
    }

    browse.addEventListener('click', () => vscode.postMessage({ command: 'browse' }));
    cancel.addEventListener('click', () => vscode.postMessage({ command: 'cancel' }));
    create.addEventListener('click', () => {
      vscode.postMessage({
        command: 'create',
        projectType: projectType.value,
        title: title.value,
        author: author.value,
        openAfterCreate: openAfterCreate.checked
      });
    });
    title.addEventListener('input', updatePreview);

    window.addEventListener('message', event => {
      const message = event.data;
      if (message.command === 'destination') {
        destination.value = message.value;
        updatePreview();
      } else if (message.command === 'busy') {
        create.disabled = !!message.value;
        browse.disabled = !!message.value;
        cancel.disabled = !!message.value;
        create.textContent = message.value ? 'Creating…' : 'Create Project';
      } else if (message.command === 'validation') {
        error.textContent = message.message || 'Please check the form.';
        if (message.field === 'title') title.focus();
      } else if (message.command === 'error') {
        error.textContent = message.message || 'Project creation failed.';
      }
    });

    updatePreview();
    title.select();
  </script>
</body>
</html>`;
}

async function uriExists(uri) {
  try { await vscode.workspace.fs.stat(uri); return true; }
  catch { return false; }
}

function sanitizeProjectName(value) {
  return String(value || '')
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/[. ]+$/g, '')
    .trim();
}

function escapeInformString(value) {
  return String(value || '').replace(/"/g, "'");
}

async function openProject() {
  const pick = await vscode.window.showOpenDialog({
    canSelectFolders: true,
    canSelectFiles: false,
    canSelectMany: false,
    openLabel: 'Open Inform Project',
    title: 'Select an Inform 7 .inform project folder'
  });
  if (!pick?.length) return;

  const rootUri = pick[0];
  const storyUri = vscode.Uri.joinPath(rootUri, 'Source', 'story.ni');
  if (!(rootUri.path.endsWith('.inform') || await uriExists(storyUri))) {
    const choice = await vscode.window.showWarningMessage(
      'That folder does not look like an Inform 7 project (Source/story.ni was not found). Open it anyway?',
      'Open Anyway', 'Cancel'
    );
    if (choice !== 'Open Anyway') return;
  }
  await vscode.commands.executeCommand('vscode.openFolder', rootUri, false);
}

async function installI7xExtension() {
  const pick = await vscode.window.showOpenDialog({ canSelectFolders: false, canSelectFiles: true, canSelectMany: false, filters: { 'Inform 7 Extension': ['i7x'] }, openLabel: 'Install Inform Extension' });
  if (!pick?.length) return;
  const file = pick[0].fsPath;
  const root = findProjectRoot();
  let folder = expandHome(config().get('extensions.folder', '').trim());
  if (!folder) {
    if (!root) throw new Error('Open a project or set informant.extensions.folder.');
    folder = path.join(root, 'Extensions');
  }
  await ensureDir(folder);
  await fsp.copyFile(file, path.join(folder, path.basename(file)));
  vscode.window.showInformationMessage(`Installed ${path.basename(file)} into ${folder}.`);
}

async function cleanProject() {
  const root = findProjectRoot();
  if (!root) throw new Error('No Inform project is open.');
  await removeBuildArtifacts(root);
  vscode.window.showInformationMessage('Informant cleaned project build artifacts.');
}

async function installToolchain() {
  const choices = [
    { label: config().get('toolchain.manifestUrl', '').trim()
      ? '$(cloud-download) Download from configured manifest URL'
      : '$(cloud-download) Download official Informant toolchain', kind: 'download' },
    { label: '$(folder) Import existing toolchain folder', kind: 'folder' },
    { label: '$(file-zip) Import toolchain archive (.zip/.tar.gz)', kind: 'archive' },
    { label: '$(globe) Open Inform download page', kind: 'openDocs' }
  ];
  const pick = await vscode.window.showQuickPick(choices, { placeHolder: 'Install a private Informant toolchain' });
  if (!pick) return;
  if (pick.kind === 'folder') return importToolchainFolder();
  if (pick.kind === 'archive') return importToolchainArchive();
  if (pick.kind === 'download') return downloadToolchainFromManifest();
  return vscode.env.openExternal(vscode.Uri.parse('https://ganelson.github.io/inform-website/downloads/'));
}

async function importToolchainFolder() {
  const pick = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false, openLabel: 'Import Toolchain Folder' });
  if (!pick?.length) return;
  const src = pick[0].fsPath;
  const bin = await findBinDir(src);
  if (!bin || !(await exists(path.join(bin, exe('inform7'))))) throw new Error('Selected folder does not appear to contain an inform7 executable.');
  const idDefault = `inform-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}-${platformKey()}`;
  const id = await vscode.window.showInputBox({ prompt: 'Toolchain ID/version folder', value: idDefault, validateInput: v => /^[A-Za-z0-9._+-]+$/.test(v) ? undefined : 'Use letters, numbers, dot, underscore, plus, or hyphen.' });
  if (!id) return;
  const dest = path.join(toolchainsRoot(), id);
  if (await exists(dest)) throw new Error(`Toolchain ${id} already exists.`);
  await ensureDir(toolchainsRoot());
  await copyDir(src, dest);
  await writeToolchainManifest(dest, { id, version: id, platform: platformKey(), source: 'folder-import', importedAt: new Date().toISOString() });
  await chmodExecutables(dest);
  vscode.window.showInformationMessage(`Installed Informant toolchain: ${id}`);
}

async function importToolchainArchive() {
  const pick = await vscode.window.showOpenDialog({ canSelectFolders: false, canSelectFiles: true, canSelectMany: false, filters: { 'Archives': ['zip', 'tgz', 'gz', 'tar'] }, openLabel: 'Import Toolchain Archive' });
  if (!pick?.length) return;
  const archive = pick[0].fsPath;
  const idDefault = path.basename(archive).replace(/\.(tar\.gz|tgz|zip|tar)$/i, '').replace(/[^A-Za-z0-9._+-]/g, '-');
  const id = await vscode.window.showInputBox({ prompt: 'Toolchain ID/version folder', value: idDefault, validateInput: v => /^[A-Za-z0-9._+-]+$/.test(v) ? undefined : 'Use letters, numbers, dot, underscore, plus, or hyphen.' });
  if (!id) return;
  const dest = path.join(toolchainsRoot(), id);
  if (await exists(dest)) throw new Error(`Toolchain ${id} already exists.`);
  await ensureDir(dest);
  await extractArchive(archive, dest);
  const bin = await findBinDir(dest);
  if (!bin || !(await exists(path.join(bin, exe('inform7'))))) {
    await fsp.rm(dest, { recursive: true, force: true });
    throw new Error('Archive did not contain an inform7 executable in a recognizable location.');
  }
  await writeToolchainManifest(dest, { id, version: id, platform: platformKey(), source: 'archive-import', archive: path.basename(archive), importedAt: new Date().toISOString() });
  await chmodExecutables(dest);
  vscode.window.showInformationMessage(`Installed Informant toolchain: ${id}`);
}

async function downloadToolchainFromManifest() {
  const manifestUrl = config().get('toolchain.manifestUrl', '').trim();
  output.show(true);
  output.appendLine(manifestUrl ? `Downloading manifest: ${manifestUrl}` : 'Using bundled official Informant toolchain manifest.');
  const manifestText = manifestUrl
    ? await downloadText(manifestUrl)
    : await fsp.readFile(path.join(__dirname, 'resources', 'toolchains', 'official-manifest.json'), 'utf8');
  const manifest = JSON.parse(manifestText);
  const entries = (manifest.toolchains || []).filter(t => !t.platform || t.platform === platformKey());
  if (!entries.length) throw new Error(`Manifest has no toolchain for ${platformKey()}.`);
  const pick = await vscode.window.showQuickPick(entries.map(t => ({ label: t.version || t.id, description: t.platform || platformKey(), detail: t.url, toolchain: t })), { placeHolder: 'Select toolchain to download' });
  if (!pick) return;
  const t = pick.toolchain;
  if (!t.url) throw new Error('Selected manifest entry has no url.');
  if (t.url === 'REPLACE_WITH_GITHUB_RELEASE_ASSET_URL' || t.sha256 === 'REPLACE_WITH_RELEASE_ASSET_SHA256') {
    throw new Error('The official toolchain release is not configured yet. Replace the URL and SHA-256 placeholders in resources/toolchains/official-manifest.json.');
  }
  const archivePath = path.join(os.tmpdir(), `informant-${Date.now()}-${path.basename(new URL(t.url).pathname)}`);
  output.appendLine(`Downloading archive: ${t.url}`);
  await downloadFile(t.url, archivePath);
  if (t.sha256) {
    const actual = await sha256File(archivePath);
    if (actual.toLowerCase() !== t.sha256.toLowerCase()) throw new Error(`SHA-256 mismatch. Expected ${t.sha256}, got ${actual}.`);
  }
  const id = t.id || `${t.version}-${platformKey()}`;
  const dest = path.join(toolchainsRoot(), id);
  if (await exists(dest)) throw new Error(`Toolchain ${id} already exists.`);
  await ensureDir(dest);
  await extractArchive(archivePath, dest);
  await writeToolchainManifest(dest, Object.assign({}, t, { id, platform: platformKey(), source: 'manifest-download', importedAt: new Date().toISOString() }));
  await chmodExecutables(dest);
  vscode.window.showInformationMessage(`Downloaded Informant toolchain: ${id}`);
}

async function manageToolchains() {
  const items = await listToolchains();
  if (!items.length) {
    const choice = await vscode.window.showInformationMessage('No Informant toolchains installed.', 'Install Toolchain');
    if (choice) await installToolchain();
    return;
  }
  const pick = await vscode.window.showQuickPick(items.map(t => ({
    label: `${t.hasInform7 ? '$(check)' : '$(warning)'} ${t.id}`,
    description: t.manifest.platform || '',
    detail: t.root,
    toolchain: t
  })), { placeHolder: 'Installed Informant toolchains' });
  if (!pick) return;
  const action = await vscode.window.showQuickPick(['Select for this project', 'Reveal in file manager', 'Delete'], { placeHolder: pick.toolchain.id });
  if (action === 'Select for this project') await setProjectToolchain(pick.toolchain.id);
  else if (action === 'Reveal in file manager') await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(pick.toolchain.root));
  else if (action === 'Delete') {
    const confirm = await vscode.window.showWarningMessage(`Delete private toolchain ${pick.toolchain.id}?`, { modal: true }, 'Delete');
    if (confirm === 'Delete') { await fsp.rm(pick.toolchain.root, { recursive: true, force: true }); vscode.window.showInformationMessage(`Deleted ${pick.toolchain.id}.`); }
  }
}

async function selectToolchain() {
  const items = await listToolchains();
  if (!items.length) { await installToolchain(); return; }
  const pick = await vscode.window.showQuickPick(items.map(t => ({ label: t.id, description: t.manifest.platform || '', detail: t.root })), { placeHolder: 'Select project toolchain' });
  if (pick) await setProjectToolchain(pick.label);
}

async function setProjectToolchain(id) {
  const root = findProjectRoot();
  if (!root) throw new Error('Open an Inform project first.');
  const file = path.join(root, '.informant.json');
  let data = {};
  if (await exists(file)) { try { data = JSON.parse(await fsp.readFile(file, 'utf8')); } catch { } }
  data.toolchainVersion = id;
  await fsp.writeFile(file, JSON.stringify(data, null, 2), 'utf8');
  vscode.window.showInformationMessage(`Informant project toolchain set to ${id}.`);
}

async function showStorage() {
  await ensureDir(storageRoot());
  await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(storageRoot()));
}

async function copyDir(src, dest) {
  await ensureDir(dest);
  const entries = await fsp.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) await copyDir(s, d);
    else if (entry.isSymbolicLink()) {
      const link = await fsp.readlink(s);
      await fsp.symlink(link, d).catch(async () => fsp.copyFile(s, d));
    } else await fsp.copyFile(s, d);
  }
}

async function writeToolchainManifest(root, manifest) {
  await fsp.writeFile(path.join(root, 'informant-toolchain.json'), JSON.stringify(manifest, null, 2), 'utf8');
}

async function chmodExecutables(root) {
  if (process.platform === 'win32') return;
  const names = new Set(['inform7', 'inform6', 'inbuild', 'inter', 'inblorb', 'glulxe', 'git', 'frotz', 'dumb-frotz']);
  async function walk(dir) {
    const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (names.has(e.name)) await fsp.chmod(p, 0o755).catch(() => {});
    }
  }
  await walk(root);
}

async function extractArchive(archive, dest) {
  const lower = archive.toLowerCase();
  if (lower.endsWith('.zip')) {
    if (process.platform === 'win32') {
      await execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `Expand-Archive -LiteralPath ${JSON.stringify(archive)} -DestinationPath ${JSON.stringify(dest)}`], { maxBuffer: 16 * 1024 * 1024 });
    } else {
      await execFile('unzip', ['-q', archive, '-d', dest], { maxBuffer: 16 * 1024 * 1024 });
    }
  } else {
    await execFile('tar', ['-xf', archive, '-C', dest], { maxBuffer: 16 * 1024 * 1024 });
  }
}

function downloadText(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) return resolve(downloadText(new URL(res.headers.location, url).toString()));
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      let data = '';
      res.setEncoding('utf8');
      res.on('data', d => data += d);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

async function downloadFile(url, dest, redirects = 0) {
  const parsedUrl = new URL(url);
  if (parsedUrl.protocol !== 'https:') throw new Error('Toolchain downloads require HTTPS.');
  const res = await new Promise((resolve, reject) => {
    https.get(parsedUrl, resolve).on('error', reject);
  });
  if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
    const location = res.headers.location;
    res.destroy();
    if (redirects >= 10) throw new Error('Too many toolchain download redirects.');
    return downloadFile(new URL(location, parsedUrl).toString(), dest, redirects + 1);
  }
  if (res.statusCode !== 200) {
    res.destroy();
    throw new Error(`HTTP ${res.statusCode}`);
  }
  try {
    await pipeline(res, fs.createWriteStream(dest));
  } catch (err) {
    await fsp.rm(dest, { force: true }).catch(() => {});
    throw err;
  }
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', d => hash.update(d)).on('end', () => resolve(hash.digest('hex'))).on('error', reject);
  });
}

function deactivate() {}
module.exports = { activate, deactivate };
