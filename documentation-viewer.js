'use strict';

const vscode = require('vscode');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

const entries = [
  ['Writing with Inform', 'book/WI_1_1.html'],
  ['The Inform Recipe Book', 'book/RB_1_1.html'],
  ['General Index', 'book/general_index.html'],
  ['Examples — Alphabetical', 'book/examples_alphabetical.html'],
  ['Examples — Numerical', 'book/examples_numerical.html'],
  ['Examples — Thematic', 'book/examples_thematic.html']
];
const site = 'https://informant.invalid/';
let viewer;

function within(root, file) {
  const relative = path.relative(root, file);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function localFile(root, url) {
  if (url.origin !== new URL(site).origin) throw new Error('Unsupported documentation resource.');
  const file = path.resolve(root, `.${decodeURIComponent(url.pathname)}`);
  if (!within(root, file)) throw new Error('Documentation path is outside the documentation directory.');
  const real = await fs.realpath(file);
  if (!within(root, real)) throw new Error('Documentation symlink points outside the documentation directory.');
  if (!(await fs.stat(real)).isFile()) throw new Error('Documentation destination is not a file.');
  return real;
}

function escapeHtml(value) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
}

async function replaceAsync(text, pattern, replace) {
  const matches = [...text.matchAll(pattern)];
  let result = '', end = 0;
  for (const match of matches) {
    result += text.slice(end, match.index) + await replace(match);
    end = match.index + match[0].length;
  }
  return result + text.slice(end);
}

async function resourceUri(state, url) {
  const file = await localFile(state.root, url);
  return state.panel.webview.asWebviewUri(vscode.Uri.file(file)).toString();
}

async function adaptCss(state, css, base, seen = new Set()) {
  // Resolve imports and images against the stylesheet, not the HTML page.
  return replaceAsync(css, /@import\s+(?:url\(\s*)?["']([^"']+)["']\s*\)?\s*;|url\(\s*(["']?)(.*?)\2\s*\)/gi, async m => {
    if (m[1] !== undefined) {
      const url = new URL(m[1], base);
      if (seen.has(url.href)) return '';
      seen.add(url.href);
      const file = await localFile(state.root, url);
      return adaptCss(state, await fs.readFile(file, 'utf8'), url, seen);
    }
    if (m[3].startsWith('#')) return m[0];
    return `url("${await resourceUri(state, new URL(m[3], base))}")`;
  });
}

async function pageData(state, target) {
  const url = new URL(target, site);
  const file = await localFile(state.root, url);
  if (!/\.html?$/i.test(file)) throw new Error('Documentation navigation requires an HTML page.');
  const html = await fs.readFile(file, 'utf8');
  const resources = {};
  const styles = {};
  // Gather the resource attributes used by generated Indoc HTML. DOM handling
  // below performs the actual adaptation; this is not an HTML sanitizer.
  for (const match of html.matchAll(/\b(src|href)\s*=\s*(["'])(.*?)\2/gi)) {
    const value = match[3].replace(/&amp;/g, '&');
    if (match[1].toLowerCase() !== 'src' && !/\.css(?:[?#]|$)/i.test(value)) continue;
    const resource = new URL(value, url);
    if (resource.origin !== new URL(site).origin) continue;
    if (/\.css$/i.test(resource.pathname)) {
      const cssFile = await localFile(state.root, resource);
      styles[resource.href] = await adaptCss(state, await fs.readFile(cssFile, 'utf8'), resource);
    } else {
      resources[resource.href] = await resourceUri(state, resource);
    }
  }
  const adapted = await replaceAsync(html, /\bstyle\s*=\s*(["'])(.*?)\1/gi,
    async m => `style="${escapeHtml(await adaptCss(state, m[2].replace(/&quot;/g, '"').replace(/&amp;/g, '&'), url))}"`);
  const withStyles = await replaceAsync(adapted, /<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi,
    async m => `<style>${await adaptCss(state, m[1], url)}</style>`);
  return { html: withStyles, url: url.href, resources, styles };
}

// Runs only inside the Webview. Generated scripts and handlers never execute.
function browserMain(data) {
  const api = acquireVsCodeApi();
  const base = data.url;
  const main = document.getElementById('content');
  function fragment(hash) {
    const id = decodeURIComponent(hash.replace(/^#/, ''));
    if (!id) return;
    const example = /^e(?:\d+_)?(\d+)$/.exec(id);
    if (example) {
      const panel = document.getElementById(`example${example[1]}`);
      if (panel) panel.style.display = 'block';
    }
    const target = document.getElementById(id) || document.getElementsByName(id)[0];
    if (target) target.scrollIntoView();
  }
  if (data.html) {
    const parsed = new DOMParser().parseFromString(data.html, 'text/html');
    parsed.querySelectorAll('script,base,meta,iframe,frame,object,embed,form,svg,math').forEach(el => el.remove());
    for (const el of parsed.querySelectorAll('*')) {
      const handler = el.getAttribute('onclick') || '';
      const toggle = /^\s*showExample\(['"]([\w-]+)['"]\);?\s*(?:return false;?)?\s*$/.exec(handler);
      for (const attr of [...el.attributes]) {
        if (/^on/i.test(attr.name) || /^(srcdoc|srcset|action|formaction|data-informant-.*)$/i.test(attr.name)) el.removeAttribute(attr.name);
      }
      if (toggle) el.setAttribute('data-informant-example', toggle[1]);
      if (el.hasAttribute('src')) {
        const key = new URL(el.getAttribute('src'), base).href;
        if (data.resources[key]) el.setAttribute('src', data.resources[key]);
        else el.removeAttribute('src');
      }
    }
    parsed.querySelectorAll('link').forEach(el => {
      const key = new URL(el.getAttribute('href') || '', base).href;
      if (el.rel === 'stylesheet' && data.styles[key] !== undefined) {
        const style = parsed.createElement('style');
        style.textContent = data.styles[key];
        el.replaceWith(style);
      } else el.remove();
    });
    for (const style of parsed.head.querySelectorAll('style')) document.head.appendChild(document.importNode(style, true));
    // Track only classes added by the generated page; never own VS Code's classes.
    const previousClasses = JSON.parse(document.body.dataset.informantDocumentClasses || '[]');
    for (const name of previousClasses) {
      if (!name.startsWith('vscode-')) document.body.classList.remove(name);
    }
    const documentClasses = [...parsed.body.classList].filter(name =>
      !name.startsWith('vscode-') && !document.body.classList.contains(name));
    document.body.classList.add(...documentClasses);
    document.body.dataset.informantDocumentClasses = JSON.stringify(documentClasses);
    document.body.style.cssText = parsed.body.style.cssText;
    main.replaceChildren(...[...parsed.body.childNodes].map(node => document.importNode(node, true)));
    const compatibilityStyle = document.createElement('style');
    compatibilityStyle.textContent = `body.paper { color: #202020; color-scheme: light; }
body.paper blockquote.code { background-color: transparent; }

body.vscode-dark.paper {
  color-scheme: dark;
  color: var(--vscode-editor-foreground, #d4d4d4);
  background-color: var(--vscode-editor-background, #1e1e1e);
}
body.vscode-dark.paper :is(p.volumeheading, p.chapterheading, p.sectionheading,
  .headingtext, .headingrubric, span.egname, span.footernonlink) {
  color: var(--vscode-editor-foreground, #d4d4d4);
}
body.vscode-dark.paper :is(span.egbanner, span.indexsee, a.footerlink) {
  color: var(--vscode-descriptionForeground, #b0b0b0);
}
body.vscode-dark.paper :is(div.egpanel, div.definition, div.headingboxhigh,
  td.letterinrow, td.midnightrighthalfpage) {
  background-color: var(--vscode-textCodeBlock-background, var(--vscode-editor-background, #252526));
  color: var(--vscode-editor-foreground, #d4d4d4);
}
body.vscode-dark.paper div.definition {
  border-color: var(--vscode-textBlockQuote-border, #608bba);
}
body.vscode-dark.paper :is(div.majuscule, div.stretchymajuscule) {
  background-color: var(--vscode-textCodeBlock-background, var(--vscode-editor-background, #252526));
}
body.vscode-dark.paper span.majusculelettering {
  color: var(--vscode-editor-foreground, #d4d4d4);
}
body.vscode-dark.paper :is(a:link, a:visited, a.eglink, a.indexlink, a.indexlinkalt, a.indexseelink) {
  color: var(--vscode-textLink-foreground, #9cdcfe);
}
body.vscode-dark.paper :is(a:hover, a:active) {
  color: var(--vscode-textLink-activeForeground, #b3e3ff);
}
body.vscode-dark.paper :is(a.indexlink, a.indexlinkalt, a.indexseelink) {
  border-bottom-color: var(--vscode-textSeparator-foreground, #808080);
}
body.vscode-dark.paper blockquote.code {
  color: var(--vscode-textPreformat-foreground, #9cdcfe);
}
body.vscode-dark.paper :is(span.typewriter, table.codetable,
  span.indexsource, span.indexsourcearg, span.indexsourcepartbracketed,
  span.indexphrase, span.indexifphrase, span.indexsayphrase, span.indexoutphrase,
  span.indexassert, span.indexrb, span.indexprop, span.indexpropcat, span.indexadj,
  span.indexrelverb, span.indexglob, span.indexactvar, span.indexconst, span.indexaction,
  span.indexactivity, span.indexactivitycat, span.indexdescactivity,
  span.indexofsourcebracketed, span.indexuseopt, span.indextoken) {
  color: #9cdcfe;
}
body.vscode-dark.paper :is(span.definitionterm, span.indexsourceargbracketed,
  span.indexphrasebracketed, span.indexifphrasebracketed, span.indexsayphrasebracketed,
  span.indexoutphrasebracketed, span.indexassertbracketed, span.indexrbbracketed,
  span.indexpropbracketed, span.indexpropcatbracketed, span.indexadjbracketed,
  span.indexrelbracketed, span.indexrelcatbracketed, span.indexglobbracketed,
  span.indexactvarbracketed, span.indexconstbracketed, span.indexactionbracketed,
  span.indextokenbracketed) {
  color: #c5a5e8;
}
body.vscode-dark.paper :is(span.indexcommand, span.indextestcmd,
  span.indexcommandpartbracketed, span.indexgloss) {
  color: #b5cea8;
}
/* Keep dark lettering over the original light oval artwork. */
body.vscode-dark.paper :is(div.egovalfornumber, div.egovalforxref) a {
  color: #202020;
}
body.vscode-dark.paper :is(div.egovalfornumber, div.egovalforxref) a:hover {
  color: #d00000;
}`;
    document.body.appendChild(compatibilityStyle);
    for (const anchor of main.querySelectorAll('a[href],area[href]')) {
      const raw = anchor.getAttribute('href');
      if (/^\s*(?:javascript|inform|command):/i.test(raw)) {
        anchor.removeAttribute('href');
        anchor.setAttribute('aria-disabled', 'true');
        anchor.title = 'This Inform IDE action is not available in Informant yet.';
      } else {
        anchor.dataset.informantTarget = new URL(raw, base).href;
        anchor.setAttribute('href', '#');
        anchor.removeAttribute('target');
      }
    }
  }
  document.addEventListener('click', event => {
    const element = event.target.closest('a,area,[data-informant-example]');
    if (!element) return;
    event.preventDefault();
    if (element.dataset.informantExample) {
      const example = document.getElementById(element.dataset.informantExample);
      if (example) example.style.display = getComputedStyle(example).display === 'none' ? 'block' : 'none';
      return;
    }
    if (element.hasAttribute('data-home')) { api.postMessage({ type: 'home' }); return; }
    const target = element.dataset.informantTarget;
    if (!target) return;
    const url = new URL(target);
    const current = new URL(base);
    if (url.origin === current.origin && url.pathname === current.pathname && url.search === current.search) fragment(url.hash);
    else api.postMessage({ type: 'navigate', target });
  });
  requestAnimationFrame(() => fragment(new URL(base).hash));
}

function render(state, data) {
  const nonce = crypto.randomBytes(16).toString('hex');
  const source = state.panel.webview.cspSource;
  const landing = entries.map(([label, file]) => `<li><a href="#" data-informant-target="${site + file}">${escapeHtml(label)}</a></li>`).join('');
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  return `<!doctype html><html><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${source}; font-src ${source}; style-src ${source} 'unsafe-inline'; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none';">
<title>Informant Documentation</title>
<style>.informant-home { padding: 10px; background: var(--vscode-editor-background); color: var(--vscode-editor-foreground); font-family: var(--vscode-font-family); } .informant-home a { color: var(--vscode-textLink-foreground); } .informant-landing { padding: 20px; font-family: var(--vscode-font-family); color: var(--vscode-editor-foreground); } .informant-landing li { margin: 12px 0; } .informant-landing a { color: var(--vscode-textLink-foreground); }</style>
</head><body><nav class="informant-home"><a href="#" data-home>Documentation home</a></nav>
<main id="content">${data.html ? '' : `<div class="informant-landing"><h1>Informant Documentation</h1><ul>${landing}</ul></div>`}</main>
<script nonce="${nonce}">(${browserMain.toString()})(${json});</script></body></html>`;
}

async function load(state, target) {
  const revision = ++state.revision;
  const data = target ? await pageData({ root: state.root, panel: state.panel }, target) : { url: site };
  if (viewer !== state || revision !== state.revision) return;
  state.panel.webview.html = render(state, data);
}

async function openDocumentation(documentationRoot, context) {
  const root = await fs.realpath(documentationRoot).catch(() => undefined);
  if (!root || !(await fs.stat(root)).isDirectory()) throw new Error('The selected toolchain has no packaged Documentation directory.');
  if (viewer) {
    viewer.root = root;
    viewer.panel.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.file(root)] };
    viewer.panel.reveal();
    await load(viewer);
    return;
  }
  const panel = vscode.window.createWebviewPanel('informant.documentation', 'Informant Documentation', vscode.ViewColumn.Active,
    { enableScripts: true, localResourceRoots: [vscode.Uri.file(root)], retainContextWhenHidden: true });
  const state = { panel, root, revision: 0 };
  viewer = state;
  const messages = panel.webview.onDidReceiveMessage(async message => {
    try {
      if (viewer !== state || !message || typeof message !== 'object') return;
      if (message.type === 'home') await load(state);
      else if (message.type === 'navigate' && typeof message.target === 'string') {
        const url = new URL(message.target);
        if (url.origin === new URL(site).origin) await load(state, url.href);
        else if (url.protocol === 'https:' || url.protocol === 'http:') await vscode.env.openExternal(vscode.Uri.parse(url.href));
      }
    } catch (err) { vscode.window.showErrorMessage(`Informant documentation: ${err.message}`); }
  });
  panel.onDidDispose(() => { messages.dispose(); if (viewer === state) viewer = undefined; });
  context.subscriptions.push(panel);
  await load(state);
}

module.exports = { openDocumentation };
