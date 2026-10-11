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

const vscode = require('vscode');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

const site = 'https://informant-index.invalid/';
const families = ['bg_images', 'doc_images', 'map_icons', 'scene_icons'];
const panels = new Map();
const pagePattern = /^(?:Welcome|Contents|Actions|Kinds|Phrasebook|Rules|Scenes|World)\.html$|^Details\/\d+_A\.html$/;

function within(root, file) {
  const relative = path.relative(root, file);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

async function contained(root, file, directory = false) {
  if (!within(root, file)) throw new Error('Index path is outside its allowed directory.');
  const real = await fs.realpath(file);
  if (!within(root, real)) throw new Error('Index symlink points outside its allowed directory.');
  const stat = await fs.stat(real);
  if (directory ? !stat.isDirectory() : !stat.isFile()) throw new Error('Index destination has the wrong file type.');
  return real;
}

function destination(target, base = site) {
  // Some 10.1.2 detail pages emit root-relative intent with a relative spelling.
  if (new URL(base).pathname.startsWith('/Details/') && /^Details\/\d+_A\.html(?:[?#]|$)/.test(target)) base = site;
  const url = new URL(target, base);
  if (url.origin !== new URL(site).origin || url.username || url.password) throw new Error('Unsupported Index destination.');
  const name = decodeURIComponent(url.pathname.slice(1));
  if (!pagePattern.test(name)) throw new Error('Navigation requires a generated Index report.');
  return url;
}

async function imageryUri(state, value) {
  const url = new URL(value);
  if (url.protocol !== 'inform:' || url.host || url.search || url.hash) throw new Error('Unsupported Index image URL.');
  const parts = decodeURIComponent(url.pathname).split('/');
  const family = parts[1];
  if (parts[0] !== '' || !families.includes(family) || parts.length < 3 || parts.slice(2).some(p => !p || p === '.' || p === '..' || p.includes('\\'))) {
    throw new Error('Unsupported Index image path.');
  }
  const root = state.imagery[family];
  const file = await contained(root, path.resolve(root, ...parts.slice(2)));
  if (!/\.(?:png|gif|jpe?g)$/i.test(file)) throw new Error('Unsupported Index image type.');
  return state.panel.webview.asWebviewUri(vscode.Uri.file(file)).toString();
}

async function pageData(state, target) {
  const url = destination(target);
  // Revalidate the directory after clean/recompile, rather than trusting its old realpath.
  await contained(state.project, state.root, true);
  const file = await contained(state.root, path.join(state.root, decodeURIComponent(url.pathname.slice(1))));
  const html = await fs.readFile(file, 'utf8');
  const resources = {};
  // Includes unquoted attributes, CSS backgrounds, and image swaps in the generated scripts.
  const references = new Set(html.match(/inform:\/(?:bg_images|doc_images|map_icons|scene_icons)\/[^\s'"<>;)]+/g) || []);
  for (const reference of references) resources[reference] = await imageryUri(state, reference);
  return { html, url: url.href, resources };
}

// Serialized into the Webview. Never execute source-provided scripts or handlers.
function browserMain(data) {
  const api = acquireVsCodeApi();
  const main = document.getElementById('content');
  let current = new URL(data.url);
  const actions = new WeakMap();
  const colours = new Map();
  const reportNames = /^(?:Welcome|Contents|Actions|Kinds|Phrasebook|Rules|Scenes|World)\.html$|^Details\/\d+_A\.html$/;
  function target(raw) {
    let base = current;
    if (current.pathname.startsWith('/Details/') && /^Details\/\d+_A\.html(?:[?#]|$)/.test(raw)) base = new URL('/', current);
    const url = new URL(raw, base);
    if (url.origin !== current.origin || url.username || url.password || !reportNames.test(decodeURIComponent(url.pathname.slice(1)))) return undefined;
    return url;
  }
  function disable(el) {
    el.removeAttribute('href');
    el.setAttribute('aria-disabled', 'true');
    el.classList.add('informant-disabled');
    el.title = 'This Inform IDE integration is not available in the Index viewer yet.';
  }
  function css(text) {
    // External styles/imports are unnecessary for generated Index pages.
    return text.replace(/@import\s+[^;]+;/gi, '').replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (_, quote, value) =>
      data.resources[value] ? `url("${data.resources[value]}")` : 'none');
  }
  function recognize(handler) {
    let m = /^\s*window\.location\s*=\s*(['"])([^'"]+)\1;?\s*return false;?\s*$/.exec(handler);
    if (m) { const url = target(m[2]); return url && { type: 'navigate', url: url.href }; }
    m = /^\s*(click_element_box|showBasic)\(\s*(['"])([\w-]+)\2\s*\);?\s*(?:return false;?)?\s*$/.exec(handler);
    if (m) return { type: m[1], id: m[3] };
    m = /^\s*(showExtra|showResp)\(\s*(['"])([\w-]+)\2\s*,\s*(['"])([\w-]+)\4\s*\);?\s*(?:return false;?)?\s*$/.exec(handler);
    if (m) return { type: m[1], id: m[3], image: m[5] };
    if (/^\s*show_all_elements\(\);?\s*(?:return false;?)?\s*$/.test(handler)) return { type: 'all' };
    return undefined;
  }
  const parsed = new DOMParser().parseFromString(data.html || '', 'text/html');
  parsed.querySelectorAll('script,base,meta,link,iframe,frame,object,embed,form,svg,math,audio,video,source').forEach(el => el.remove());
  // Only leaf image-assembly cells need legacy line-box compatibility. Never
  // inherit a marker from generated HTML or apply it to room labels/layout cells.
  parsed.querySelectorAll('.informant-map-image-cell').forEach(el => el.classList.remove('informant-map-image-cell'));
  if (current.pathname === '/World.html') {
    for (const cell of parsed.querySelectorAll('td')) {
      const children = [...cell.childNodes];
      const mapImage = node => node.nodeType === 1 && node.tagName === 'IMG'
        && /^inform:\/map_icons\//.test(node.getAttribute('src') || '')
        && Object.prototype.hasOwnProperty.call(data.resources, node.getAttribute('src'));
      if (children.some(mapImage) && children.every(node =>
        (node.nodeType === 3 && !node.textContent.trim()) || mapImage(node)
        || (node.nodeType === 1 && node.tagName === 'BR'))) {
        cell.classList.add('informant-map-image-cell');
      }
    }
  }
  // Preserve canonical light artwork and data-colored cells, including region
  // badges which do not carry the generated indexmaproom class.
  parsed.querySelectorAll('.informant-index-light').forEach(el => el.classList.remove('informant-index-light'));
  for (const el of parsed.querySelectorAll('[background],td[bgcolor]')) {
    const background = el.getAttribute('background');
    if (background === 'inform:/bg_images/indexcard.png'
      || (current.pathname === '/World.html' && (el.hasAttribute('bgcolor') || background === 'inform:/map_icons/grid.png'))) {
      el.classList.add('informant-index-light');
    }
  }
  for (const el of parsed.querySelectorAll('*')) {
    const handler = el.getAttribute('onclick');
    const action = handler && recognize(handler);
    for (const attr of [...el.attributes]) {
      if (/^on/i.test(attr.name) || /^(?:srcdoc|srcset|action|formaction|data-informant-.*)$/i.test(attr.name)) el.removeAttribute(attr.name);
    }
    if (el.hasAttribute('style')) el.setAttribute('style', css(el.getAttribute('style')));
    for (const attribute of ['src', 'background']) {
      if (!el.hasAttribute(attribute)) continue;
      const uri = data.resources[el.getAttribute(attribute)];
      if (uri) el.setAttribute(attribute, uri);
      else el.removeAttribute(attribute);
    }
    if (action) {
      actions.set(el, action);
      if (el.tagName !== 'A') { el.setAttribute('tabindex', '0'); el.setAttribute('role', 'button'); }
    } else if (handler) disable(el);
    if (el.matches('a[href],area[href]')) {
      const raw = el.getAttribute('href');
      const source = /^source:story\.ni#line([1-9]\d*)$/.exec(raw);
      el.removeAttribute('target');
      let url;
      try { url = target(raw); } catch { /* Unsupported URI: disable below. */ }
      if (action) el.setAttribute('href', '#');
      else if (source && Number.isSafeInteger(Number(source[1]))) {
        actions.set(el, { type: 'revealSource', line: Number(source[1]) });
        el.setAttribute('href', '#');
      }
      else if (url) {
        // A placeholder inside an actionable table cell must reach that cell's action.
        if (raw !== '#') actions.set(el, { type: 'navigate', url: url.href });
        el.setAttribute('href', '#');
      } else disable(el);
    }
  }
  for (const style of parsed.querySelectorAll('style')) style.textContent = css(style.textContent);
  for (const style of [...parsed.head.querySelectorAll('style')]) main.appendChild(style);
  // Move nodes rather than cloning: recognized actions are associated by node identity.
  main.append(...parsed.body.childNodes);
  const segments = [...main.querySelectorAll('[id]')].filter(el => /^segment\d+$/.test(el.id));
  function box(segment) { return main.querySelector(`[id^="box"][id$="_${segment.id.slice(7)}"]`); }
  for (const segment of segments) {
    const tile = box(segment);
    if (tile) colours.set(tile, getComputedStyle(tile).backgroundColor);
  }
  function select(id) {
    const selected = segments.find(el => el.id === id);
    for (const segment of segments) {
      const visible = !selected || segment === selected;
      segment.style.display = visible ? '' : 'none';
      const tile = box(segment);
      if (tile) tile.style.backgroundColor = visible ? colours.get(tile) : 'var(--informant-index-inactive, #cccccc)';
    }
    return !!selected;
  }
  function remember() { api.postMessage({ type: 'location', target: current.href }); }
  function fragment(hash) {
    let id;
    try { id = decodeURIComponent(hash.slice(1)); } catch { return false; }
    if (!id) return true;
    const el = [...main.querySelectorAll('[id],a[name]')].find(node => node.id === id || node.getAttribute('name') === id);
    if (!el) return false;
    for (let parent = el; parent && parent !== main; parent = parent.parentElement) {
      if (getComputedStyle(parent).display === 'none') parent.style.display = '';
    }
    el.scrollIntoView();
    return true;
  }
  function navigate(url) {
    const next = new URL(url);
    if (next.pathname === current.pathname) {
      if (next.search !== current.search) select(next.search.slice(1));
      current = next;
      fragment(current.hash);
      remember();
    } else api.postMessage({ type: 'navigate', target: next.href });
  }
  function run(action) {
    if (action.type === 'revealSource') { api.postMessage({ type: 'revealSource', line: action.line }); return; }
    if (action.type === 'navigate') { navigate(action.url); return; }
    if (action.type === 'all' || action.type === 'click_element_box') {
      const only = segments.filter(el => el.style.display !== 'none');
      const id = action.type === 'all' || (only.length === 1 && only[0].id === action.id) ? '' : action.id;
      select(id); current.search = id ? `?${id}` : ''; current.hash = ''; remember(); return;
    }
    const el = document.getElementById(action.id);
    if (!el || !main.contains(el)) return;
    if (action.type === 'showBasic') { el.style.display = el.style.display === 'none' ? '' : 'none'; return; }
    const open = el.style.display !== 'block';
    el.style.display = open ? 'block' : 'none';
    const img = document.getElementById(action.image);
    const name = action.type === 'showResp' ? (open ? 'responsesclose' : 'responses') : (open ? 'extraclose' : 'extra');
    if (img && main.contains(img) && data.resources[`inform:/doc_images/${name}.png`]) img.src = data.resources[`inform:/doc_images/${name}.png`];
  }
  function dispatch(event) {
    if (event.type === 'keydown' && !['Enter', ' '].includes(event.key)) return;
    let el = event.target;
    while (el && el !== main) {
      if (el.getAttribute && el.getAttribute('aria-disabled') === 'true') { event.preventDefault(); return; }
      if (actions.has(el)) { event.preventDefault(); event.stopPropagation(); run(actions.get(el)); return; }
      el = el.parentElement;
    }
    if (event.target.closest('a,area')) event.preventDefault();
  }
  main.addEventListener('click', dispatch);
  main.addEventListener('keydown', dispatch);
  document.getElementById('index-home').addEventListener('click', () => api.postMessage({ type: 'home' }));
  document.getElementById('index-refresh').addEventListener('click', () => api.postMessage({ type: 'refresh' }));
  if (data.error) document.getElementById('status').textContent = data.error;
  if (current.search && !select(current.search.slice(1))) current.search = '';
  requestAnimationFrame(() => { if (!fragment(current.hash)) current.hash = ''; remember(); });
}

function render(state, data) {
  const nonce = crypto.randomBytes(16).toString('hex');
  const source = state.panel.webview.cspSource;
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${source}; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none';">
<style>
#content #periodictable img[width] { max-width: none; }
.informant-map-image-cell { font-size: 0; line-height: 0; }
.informant-map-image-cell > img { vertical-align: top; }
body { background: white; color: #202020; color-scheme: light; } #index-toolbar { padding: 10px; background: var(--vscode-editor-background); color: var(--vscode-editor-foreground); font-family: var(--vscode-font-family); } #index-toolbar button { margin-right: 8px; cursor: pointer; } #content .informant-disabled { opacity: .55; cursor: not-allowed; text-decoration: underline dotted; } #content .informant-disabled img { opacity: .65; } #status { margin-left: 8px; }</style>
<style>
/* Theme only neutral presentation. Keep generated light mode unchanged. */
body:is(.vscode-dark, .vscode-high-contrast:not(.vscode-high-contrast-light)) {
  --informant-index-inactive: var(--vscode-editorWidget-background, #333333);
  --informant-index-surface: var(--vscode-editorWidget-background, #252526);
  --informant-index-muted: var(--vscode-descriptionForeground, #bbbbbb);
  color-scheme: dark;
  background-color: var(--vscode-editor-background, #1e1e1e);
  color: var(--vscode-editor-foreground, #d4d4d4);
}
body:is(.vscode-dark, .vscode-high-contrast:not(.vscode-high-contrast-light)) #content :is(.headingpanel, .elementbanner, .indexmorebox, .headingrow) {
  background-color: var(--informant-index-surface);
}
body:is(.vscode-dark, .vscode-high-contrast:not(.vscode-high-contrast-light)) #content .stripeone {
  background-color: var(--vscode-editor-background, #1e1e1e);
}
body:is(.vscode-dark, .vscode-high-contrast:not(.vscode-high-contrast-light)) #content .stripetwo {
  background-color: var(--vscode-tree-tableOddRowsBackground, var(--informant-index-surface));
}
body:is(.vscode-dark, .vscode-high-contrast:not(.vscode-high-contrast-light)) #content .tintedrow {
  background-color: var(--vscode-panel-border, #606060);
}
body:is(.vscode-dark, .vscode-high-contrast:not(.vscode-high-contrast-light)) #content :is(.headingpaneltext, .headingpanelrubric) {
  color: var(--vscode-editor-foreground, #d4d4d4);
}
body:is(.vscode-dark, .vscode-high-contrast:not(.vscode-high-contrast-light)) #content :is(.indexgrey, .indexdarkgrey, .phraseword):not(.informant-index-light *) {
  color: var(--informant-index-muted);
}
body:is(.vscode-dark, .vscode-high-contrast:not(.vscode-high-contrast-light)) #content ul.leaders li.leaded :is(span:first-child, span + span) {
  background-color: var(--vscode-editor-background, #1e1e1e);
}
body:is(.vscode-dark, .vscode-high-contrast:not(.vscode-high-contrast-light)) #content .indexactivitycontents {
  background-color: #383526;
}
/* These are Inform semantic roles, not errors or diagnostics. */
body:is(.vscode-dark, .vscode-high-contrast:not(.vscode-high-contrast-light)) #content .indexdullred:not(.informant-index-light *) { color: #f0a0a0; }
body:is(.vscode-dark, .vscode-high-contrast:not(.vscode-high-contrast-light)) #content .indexdullblue:not(.informant-index-light *) { color: #9cdcfe; }
body:is(.vscode-dark, .vscode-high-contrast:not(.vscode-high-contrast-light)) #content .phrasetokentext:not(.informant-index-light *) { color: #f0a0ce; }
body:is(.vscode-dark, .vscode-high-contrast:not(.vscode-high-contrast-light)) #content .phrasetokendesctext:not(.informant-index-light *) { color: #c5b4ff; }
body:is(.vscode-dark, .vscode-high-contrast:not(.vscode-high-contrast-light)) #content a[href]:not(.elementlink, .informant-index-light *) {
  color: var(--vscode-textLink-foreground, #9cdcfe);
}
body:is(.vscode-dark, .vscode-high-contrast:not(.vscode-high-contrast-light)) #content a[href]:not(.elementlink, .informant-index-light *):hover {
  color: var(--vscode-textLink-activeForeground, #b3e3ff);
}
body:is(.vscode-dark, .vscode-high-contrast:not(.vscode-high-contrast-light)) #content hr {
  border-color: var(--vscode-panel-border, #606060);
}
body:is(.vscode-dark, .vscode-high-contrast:not(.vscode-high-contrast-light)) #content .informant-index-light {
  color: #202020;
  color-scheme: light;
}
body:is(.vscode-dark, .vscode-high-contrast:not(.vscode-high-contrast-light)) #content .informant-index-light a[href] { color: #0000ee; }
body:is(.vscode-dark, .vscode-high-contrast) #index-toolbar button {
  background-color: var(--vscode-button-background, #0e639c);
  color: var(--vscode-button-foreground, #ffffff);
  border-color: var(--vscode-contrastBorder, var(--vscode-button-background, #0e639c));
}
body:is(.vscode-dark, .vscode-high-contrast) #index-toolbar button:hover {
  background-color: var(--vscode-button-hoverBackground, #1177bb);
}
body:is(.vscode-dark, .vscode-high-contrast) :focus-visible {
  outline: 1px solid var(--vscode-focusBorder, #007fd4);
  outline-offset: -1px;
}
body.vscode-high-contrast #content :is(.headingpanel, .elementbanner, .indexmorebox, .headingrow, .indexactivitycontents) {
  outline: 1px solid var(--vscode-contrastBorder, currentColor);
  outline-offset: -1px;
}
body.vscode-high-contrast #content :is(.elementbox, .smallelementbox):focus-within {
  outline: 1px solid var(--vscode-contrastActiveBorder, var(--vscode-focusBorder, currentColor));
  outline-offset: -1px;
}
body.vscode-high-contrast #content .informant-disabled,
body.vscode-high-contrast #content .informant-disabled img { opacity: 1; }
</style>
</head><body><nav id="index-toolbar"><button id="index-home">Index Home</button><button id="index-refresh">Refresh</button><span id="status" role="status"></span></nav><main id="content"></main>
<script nonce="${nonce}">(${browserMain.toString()})(${JSON.stringify(data).replace(/</g, '\\u003c')});</script></body></html>`;
}

async function load(state, target, fallback = false) {
  const revision = ++state.revision;
  let data;
  try { data = await pageData(state, target); }
  catch (err) {
    if (!fallback) throw err;
    try { data = await pageData(state, 'Welcome.html'); }
    catch { data = { url: destination('Welcome.html').href, error: `Index unavailable. Compile the project, then Refresh. ${err.message}` }; }
  }
  if (panels.get(state.project) !== state || revision !== state.revision) return;
  state.current = data.url;
  state.panel.webview.html = render(state, data);
}

async function openIndex(projectRoot, internalRoot, context) {
  const project = await fs.realpath(projectRoot);
  await contained(project, path.join(project, 'Source', 'story.ni'));
  const existing = panels.get(project);
  if (existing) { existing.panel.reveal(); return; }
  const root = path.join(project, 'Index');
  try { await contained(project, root, true); await contained(root, path.join(root, 'Welcome.html')); }
  catch { throw new Error('No generated Index is available. Compile this Inform project first.'); }
  const internal = await fs.realpath(internalRoot);
  const imageryRoot = await contained(internal, path.join(internal, 'Imagery'), true);
  const imagery = {};
  for (const family of families) imagery[family] = await contained(imageryRoot, path.join(imageryRoot, family), true);
  const panel = vscode.window.createWebviewPanel('informant.index', `${path.basename(project, '.inform')} — Index`, vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: families.map(family => vscode.Uri.file(imagery[family])) });
  const state = { project, root, imagery, panel, revision: 0, current: destination('Welcome.html').href };
  panels.set(project, state);
  const messages = panel.webview.onDidReceiveMessage(async message => {
    if (panels.get(project) !== state || !message || typeof message !== 'object') return;
    try {
      if (message.type === 'home') await load(state, 'Welcome.html', true);
      else if (message.type === 'refresh') await load(state, state.current, true);
      else if (message.type === 'navigate' && typeof message.target === 'string') await load(state, destination(message.target).href);
      else if (message.type === 'revealSource') {
        if (!Number.isSafeInteger(message.line) || message.line < 1) throw new Error('Invalid source line.');
        const file = await contained(project, path.join(project, 'Source', 'story.ni'));
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
        if (message.line > doc.lineCount) throw new Error('Source line is beyond the end of story.ni. Recompile the project and refresh the Index.');
        const editor = await vscode.window.showTextDocument(doc);
        const pos = new vscode.Position(message.line - 1, 0);
        editor.selection = new vscode.Selection(pos, pos);
        editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
      }
      else if (message.type === 'location' && typeof message.target === 'string') {
        const url = destination(message.target);
        if (url.pathname === new URL(state.current).pathname) state.current = url.href;
      }
    } catch (err) { vscode.window.showErrorMessage(`Informant Index: ${err.message}`); }
  });
  panel.onDidDispose(() => { messages.dispose(); if (panels.get(project) === state) panels.delete(project); });
  context.subscriptions.push(panel);
  try { await load(state, state.current); }
  catch (err) { panel.dispose(); throw err; }
}

module.exports = { openIndex };
