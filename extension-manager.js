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

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const catalogTools = require('./extension-catalog');
const manifest = require('./resources/extensions/official-manifest.json');
let activePanel;
let catalogJob;
let installing = false;

async function loadCatalog(storage, downloadFile, extractArchive, refresh = false) {
  if (catalogJob) return catalogJob;
  catalogJob = (async () => {
    const parent = path.join(storage, 'extension-catalogs');
    const cache = path.join(parent, manifest.id + '.xml');
    const receipt = cache + '.json';
    const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
    if (!refresh) {
      try {
        const bytes = await fsp.readFile(cache);
        const saved = JSON.parse(await fsp.readFile(receipt, 'utf8'));
        if (saved.archiveSha256 === manifest.sha256 && saved.xmlSha256 === digest(bytes)) return catalogTools.parseCatalog(bytes.toString('utf8'));
      } catch { /* Missing or damaged cache: fetch the verified release again. */ }
    }
    await fsp.mkdir(parent, { recursive: true });
    const temporary = await fsp.mkdtemp(path.join(parent, '.download-'));
    try {
      const archive = path.join(temporary, 'extension-catalog.zip');
      await downloadFile(manifest.url, archive);
      if (digest(await fsp.readFile(archive)) !== manifest.sha256) throw new Error('Extension catalog SHA-256 mismatch.');
      const unpacked = path.join(temporary, 'unpacked');
      await fsp.mkdir(unpacked);
      await extractArchive(archive, unpacked);
      const matches = [];
      async function find(dir) {
        for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
          if (entry.isDirectory()) await find(path.join(dir, entry.name));
          else if (entry.isFile() && entry.name === manifest.catalogFile) matches.push(path.join(dir, entry.name));
        }
      }
      await find(unpacked);
      if (matches.length !== 1) throw new Error('Catalog archive must contain exactly one extensions.xml.');
      const bytes = await fsp.readFile(matches[0]);
      const parsed = catalogTools.parseCatalog(bytes.toString('utf8'));
      await fsp.writeFile(cache, bytes);
      await fsp.writeFile(receipt, JSON.stringify({ archiveSha256: manifest.sha256, xmlSha256: digest(bytes) }));
      return parsed;
    } finally { await fsp.rm(temporary, { recursive: true, force: true }); }
  })();
  try { return await catalogJob; } finally { catalogJob = undefined; }
}

function installPath(item) {
  // Inform looks up extensions using author/title, not versioned download filenames.
  const component = value => {
    if (/[\\/<>:"|?*\x00-\x1f]/.test(value) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)) throw new Error(`Unsupported extension name: ${value}`);
    return catalogTools.safeRelative(value);
  };
  return `${component(item.author)}/${component(item.title)}.i7x`;
}
async function safeDestination(folder, relative) {
  catalogTools.safeRelative(relative);
  await fsp.mkdir(folder, { recursive: true });
  const root = await fsp.realpath(folder);
  const parts = relative.split('/');
  let current = root;
  for (const part of parts.slice(0, -1)) {
    current = path.join(current, part);
    await fsp.mkdir(current).catch(error => { if (error.code !== 'EEXIST') throw error; });
    const stat = await fsp.lstat(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Unsafe extension destination: ${current}`);
  }
  return path.join(current, parts.at(-1));
}
async function installPlan(plan, folder, downloadFile) {
  const staged = [], written = [];
  const temporary = await fsp.mkdtemp(path.join(require('os').tmpdir(), 'informant-extensions-'));
  try {
    // Verify the complete download set before writing any installed extension.
    for (const [index, item] of plan.downloads.entries()) {
      let bytes = item.bytes;
      if (!bytes) {
        const file = path.join(temporary, `${index}.i7x`);
        await downloadFile(item.download.url, file);
        bytes = await fsp.readFile(file);
        catalogTools.verifyDownload(bytes, item.download);
      }
      const header = catalogTools.parseHeader(bytes);
      if (catalogTools.identity(header) !== catalogTools.identity(item) || (item.version || '') !== header.version) throw new Error(`Source header does not match ${item.title}.`);
      const dest = await safeDestination(folder, installPath(item));
      const existing = await fsp.lstat(dest).catch(error => { if (error.code !== 'ENOENT') throw error; });
      if (existing) {
        if (existing.isFile() && bytes.equals(await fsp.readFile(dest))) continue;
        throw new Error(`An extension already exists at ${dest}. Existing files are not replaced.`);
      }
      if (staged.some(entry => entry.dest.toLowerCase() === dest.toLowerCase())) throw new Error(`Conflicting installation paths: ${dest}`);
      staged.push({ dest, bytes });
    }
    for (const entry of staged) {
      const handle = await fsp.open(entry.dest, 'wx');
      written.push(entry.dest);
      try { await handle.writeFile(entry.bytes); } finally { await handle.close(); }
    }
    return written.length;
  } catch (error) {
    for (const file of written) await fsp.unlink(file).catch(() => {});
    throw error;
  } finally { await fsp.rm(temporary, { recursive: true, force: true }); }
}

function canRemove(item, folder) {
  if (!folder || !item.download) return false;
  try { return path.resolve(item.path) === path.resolve(folder, installPath(item)); }
  catch { return false; }
}

async function removeExtension(item, folder) {
  if (!canRemove(item, folder)) throw new Error('Only catalog extensions in the installation folder can be removed.');
  const root = await fsp.realpath(folder);
  const parts = installPath(item).split('/');
  let file = root;
  for (const [index, part] of parts.entries()) {
    file = path.join(file, part);
    const stat = await fsp.lstat(file);
    if (stat.isSymbolicLink() || (index === parts.length - 1 ? !stat.isFile() : !stat.isDirectory())) {
      throw new Error(`Unsafe extension removal path: ${file}`);
    }
  }
  // Recheck after confirmation to protect locally edited source files.
  catalogTools.verifyDownload(await fsp.readFile(file), item.download);
  await fsp.unlink(file);
}

async function openExtensionManager(vscode, context, options) {
  if (activePanel) { activePanel.reveal(); return; }
  const panel = vscode.window.createWebviewPanel('informant.extensions', 'Manage extensions', vscode.ViewColumn.One, { enableScripts: true, localResourceRoots: [] });
  activePanel = panel;
  panel.onDidDispose(() => { if (activePanel === panel) activePanel = undefined; });
  let catalog = [], installed = [], busy = false;
  const send = data => panel.webview.postMessage(data);
  async function scan() {
    const result = await catalogTools.scanInstalled(options.roots, catalog);
    installed = result.installed.map(item => ({ ...item, removable: canRemove(item, options.folder) }));
    return result.warnings;
  }
  async function update(message = '', refresh = false) {
    let error = '';
    await send({ busy: true, message: 'Loading extensions…' });
    const scanWarnings = await scan();
    await send({ installed, destination: options.folder, message: 'Loading remote catalog…' });
    try { catalog = await loadCatalog(options.storage, options.downloadFile, options.extractArchive, refresh); }
    catch (err) { error = `Remote catalog unavailable: ${err.message}`; }
    const warnings = await scan();
    await send({ catalog, installed, destination: options.folder, busy: false,
      message: [message, error, ...new Set([...scanWarnings, ...warnings])].filter(Boolean).join('\n') });
  }
  async function install(root) {
    await scan();
    if (!options.folder) throw new Error('Install/select a packaged toolchain or configure informant.extensions.folder first.');
    const existing = installed.find(item => catalogTools.identity(item) === catalogTools.identity(root));
    if (existing && !root.local) throw new Error(`${root.title} is already installed at ${existing.path}. Existing versions are not replaced.`);
    const plan = catalogTools.resolveDependencies(root, catalog, installed);
    // Avoid adding a second incompatible version beside an installed dependency.
    for (const item of plan.downloads) {
      const clash = installed.find(local => catalogTools.identity(local) === catalogTools.identity(item));
      if (clash) throw new Error(`Installed version conflict: ${item.title} at ${clash.path}.`);
    }
    const detail = [
      `Destination: ${options.folder}`,
      'Install:\n' + plan.downloads.map(item => `${item.title} by ${item.author}${item.version ? ` (${item.version})` : ''}`).join('\n'),
      plan.provided.length ? 'Already provided:\n' + plan.provided.map(item => `${item.title} — ${item.path}`).join('\n') : '',
      ...plan.warnings
    ].filter(Boolean).join('\n\n');
    const answer = await vscode.window.showInformationMessage(`Install ${plan.downloads.length} extension(s)?`, { modal: true, detail }, 'Install');
    if (answer !== 'Install') return;
    await send({ busy: true, message: 'Downloading and verifying extensions…' });
    const count = await installPlan(plan, options.folder, options.downloadFile);
    await update(`Installed ${count} extension(s).${plan.warnings.length ? '\n' + plan.warnings.join('\n') : ''}`);
  }
  panel.webview.onDidReceiveMessage(async message => {
    if (!message || busy || installing) return;
    busy = true;
    try {
      if (message.type === 'ready' || message.type === 'refresh') await update('', message.type === 'refresh');
      else if (message.type === 'install') {
        const root = catalog.find(item => item.id === message.id);
        if (!root) throw new Error('Unknown catalog extension.');
        installing = true;
        await install(root);
      } else if (message.type === 'remove') {
        installing = true;
        await scan();
        const item = installed.find(entry => entry.id === message.id);
        if (!item?.removable) throw new Error('This extension is no longer available for removal. Refresh the extension list.');
        const dependents = installed.filter(entry => entry.dependencies?.some(ref => ref.kind === 'include' && catalogTools.identity(ref) === catalogTools.identity(item)));
        const detail = [item.path, 'Projects that include this extension will need it reinstalled. Dependencies will remain installed.',
          dependents.length ? 'Installed extensions that include it:\n' + dependents.map(entry => `${entry.title} by ${entry.author}`).join('\n') : ''].filter(Boolean).join('\n\n');
        const answer = await vscode.window.showInformationMessage(`Remove ${item.title} by ${item.author}?`, { modal: true, detail }, 'Remove');
        if (answer !== 'Remove') return;
        await removeExtension(item, options.folder);
        await update(`Removed ${item.title} by ${item.author}.`);
      } else if (message.type === 'local') {
        const picks = await vscode.window.showOpenDialog({ canSelectFiles: true, canSelectFolders: false, canSelectMany: false, filters: { 'Inform 7 extension': ['i7x'] }, openLabel: 'Install local extension' });
        if (!picks?.length) return;
        const bytes = await fsp.readFile(picks[0].fsPath);
        const header = catalogTools.parseHeader(bytes);
        const digest = crypto.createHash('sha256').update(bytes).digest('hex');
        const known = catalog.find(item => item.download.sha256 === digest);
        const root = { ...(known || header), id: 'local-file', path: picks[0].fsPath, bytes,
          warnings: known ? known.warnings : ['This local file is not indexed in the catalog. Its dependencies must be supplied manually.'] };
        installing = true;
        await install(root);
      }
    } catch (error) {
      options.output.appendLine(`[extensions] ${error.stack || error.message}`);
      await send({ message: error.message });
    } finally { busy = false; installing = false; await send({ busy: false }); }
  }, undefined, context.subscriptions);
  panel.webview.html = managerHtml();
}

function managerHtml() {
  const nonce = crypto.randomBytes(18).toString('base64');
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<style nonce="${nonce}">
body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background);padding:20px;max-width:1100px;margin:auto}h1{font-size:24px}nav,.toolbar{display:flex;gap:10px;margin:18px 0;flex-wrap:wrap}button,input{font:inherit;padding:7px 12px}button{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:1px solid transparent;cursor:pointer}button:disabled{opacity:.55;cursor:default}button[aria-selected="true"]{outline:2px solid var(--vscode-focusBorder)}input{background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);flex:1}article{border-top:1px solid var(--vscode-panel-border);padding:16px 0}h2{font-size:16px;margin:0 0 6px}.meta{opacity:.8;margin:6px 0;overflow-wrap:anywhere}#message{white-space:pre-wrap;overflow-wrap:anywhere}#destination{overflow-wrap:anywhere}button:focus-visible,input:focus-visible{outline:2px solid var(--vscode-focusBorder)}
</style></head><body><h1>Manage extensions</h1><p id="destination"></p>
<nav role="tablist" aria-label="Extension views"><button role="tab" id="remote" aria-selected="true">Remote extensions</button><button role="tab" id="local" aria-selected="false">Locally installed</button></nav>
<div class="toolbar"><input id="search" type="search" aria-label="Search extensions" placeholder="Search title or author"><button id="file">Install local .i7x…</button><button id="refresh">Refresh</button></div>
<p id="message" role="status" aria-live="polite">Loading extensions…</p><p id="count"></p><main id="list"></main>
<script nonce="${nonce}">
const vscode=acquireVsCodeApi();let state={catalog:[],installed:[],busy:true},view='remote';
const key=item=>[item.title,item.author].map(value=>value.normalize('NFC').trim().replace(/\\s+/g,' ').toLowerCase()).join('|');
const el=id=>document.getElementById(id);const send=(type,extra={})=>vscode.postMessage({type,...extra});
function text(tag,value,cls){const node=document.createElement(tag);node.textContent=value;if(cls)node.className=cls;return node;}
function render(){el('remote').setAttribute('aria-selected',String(view==='remote'));el('local').setAttribute('aria-selected',String(view==='local'));el('destination').textContent=state.destination?'Install destination: '+state.destination:'Select a packaged toolchain to install extensions.';el('file').disabled=state.busy;el('refresh').disabled=state.busy;const query=el('search').value.toLowerCase();const items=(view==='remote'?state.catalog:state.installed).filter(item=>(item.title+' '+item.author).toLowerCase().includes(query));el('count').textContent=items.length+' extension(s)';el('list').replaceChildren();for(const item of items){const row=text('article','');row.append(text('h2',item.title),text('p','by '+item.author+(item.version?' · Version '+item.version:' · Unversioned'),'meta'));if(item.qualifiers)row.append(text('p',item.qualifiers,'meta'));if(view==='local')row.append(text('p',item.path,'meta'));else{const deps=item.dependencies.filter(ref=>ref.kind==='include');if(deps.length)row.append(text('p','Requires: '+deps.map(ref=>ref.title+' by '+ref.author+(ref['requested-version']?' ('+ref['requested-version']+')':'')).join('; '),'meta'));const installed=state.installed.find(local=>key(local)===key(item));const button=text('button',installed?'Installed'+(installed.version?' ('+installed.version+')':''):'Install');button.disabled=state.busy||!!installed;button.onclick=()=>{state.busy=true;render();send('install',{id:item.id});};row.append(button);}const removable=view==='local'?[item]:state.installed.filter(local=>key(local)===key(item));for(const local of removable.filter(local=>local.removable)){const remove=text('button','Remove');remove.disabled=state.busy;remove.onclick=()=>{state.busy=true;render();send('remove',{id:local.id});};row.append(remove);}for(const warning of item.warnings||[])row.append(text('p',warning,'meta'));el('list').append(row);}if(!items.length)el('list').append(text('p',view==='remote'?'No remote extensions to display.':'No installed extensions found.'));}
el('remote').onclick=()=>{view='remote';render();};el('local').onclick=()=>{view='local';render();};el('search').oninput=render;el('file').onclick=()=>{state.busy=true;render();send('local');};el('refresh').onclick=()=>{state.busy=true;render();send('refresh');};window.addEventListener('message',event=>{state={...state,...event.data};if(event.data.message!==undefined)el('message').textContent=event.data.message;render();});render();send('ready');
</script></body></html>`;
}
module.exports = { openExtensionManager, loadCatalog, installPlan, installPath, removeExtension, managerHtml };
