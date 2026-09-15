'use strict';

const vscode = require('vscode');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

const scripts = ['lib/jquery-1.12.4.min.js', 'lib/glkote.min.js', 'lib/quixe.min.js'];
const styles = ['media/glkote.css', 'media/dialog.css'];
let playerPanel;
let requestNumber = 0;

async function openPlayer(runtimeRoot, storyPath, context) {
  const request = ++requestNumber;
  const root = await fs.realpath(runtimeRoot).catch(() => undefined);
  if (!root || !(await fs.stat(root)).isDirectory()) throw new Error('Packaged Player/Quixe directory is missing.');
  const assets = {};
  for (const name of [...scripts, ...styles, 'media/waiting.gif']) {
    const file = await fs.realpath(path.join(root, name)).catch(() => undefined);
    const relative = file && path.relative(root, file);
    if (!file || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || !(await fs.stat(file)).isFile()) {
      throw new Error(`Required Quixe runtime file is missing or outside the package: ${name}`);
    }
    assets[name] = file;
  }
  const bytes = await fs.readFile(storyPath).catch(err => { throw new Error(`Cannot read story ${storyPath}: ${err.message}`); });
  const glulx = bytes.length >= 36 && bytes.toString('ascii', 0, 4) === 'Glul';
  const blorb = bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'FORM' && bytes.toString('ascii', 8, 12) === 'IFRS';
  if (!glulx && !blorb) throw new Error('Unsupported story format: Quixe requires a Glulx story or Glulx Blorb.');
  if (request !== requestNumber) return;
  if (!playerPanel) {
    const panel = vscode.window.createWebviewPanel('informant.player', 'Informant Player', vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.file(root)] });
    playerPanel = panel;
    const messages = panel.webview.onDidReceiveMessage(message => {
      if (message?.type === 'error' && message.request === requestNumber && typeof message.message === 'string') {
        vscode.window.showErrorMessage(`Informant Player: ${message.message}`);
      }
    });
    panel.onDidDispose(() => { messages.dispose(); if (playerPanel === panel) playerPanel = undefined; });
    context.subscriptions.push(panel);
  }
  const panel = playerPanel;
  panel.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.file(root)] };
  const uri = name => panel.webview.asWebviewUri(vscode.Uri.file(assets[name])).toString().replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  const nonce = crypto.randomBytes(16).toString('hex');
  const source = panel.webview.cspSource;
  panel.webview.html = `<!doctype html><html><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}' 'unsafe-eval'; style-src ${source} 'unsafe-inline'; img-src ${source} data: blob:; font-src ${source}; connect-src 'none'; media-src 'none'; base-uri 'none'; form-action 'none';">
<title>Informant Player</title>
${styles.map(name => `<link rel="stylesheet" href="${uri(name)}">`).join('\n')}
<style>html, body { height: 100%; margin: 0; padding: 0; } #gameport { position: absolute; inset: 0; }
body, #gameport, #windowport,
.BufferWindow, .GridWindow {
  background-color: var(--vscode-editor-background);
  color: var(--vscode-editor-foreground);
}

.Input, .Style_input {
  color: var(--vscode-editor-foreground);
}

.Input {
  caret-color: var(--vscode-editor-foreground);
}

.Style_blockquote {
  background-color: transparent;
}

#loadingpane {
  color: var(--vscode-editor-foreground);
}

#errorpane,
#errorpane:hover,
#errorpane.WarningPane,
#errorpane.WarningPane:hover {
  background-color: var(--vscode-editor-background);
  color: var(--vscode-editor-foreground);
  border-bottom-color: var(--vscode-errorForeground);
}

#errorpane.WarningPane,
#errorpane.WarningPane:hover {
  border-bottom-color: var(--vscode-editorWarning-foreground);
}
</style>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
function reportPlayerError(message) {
  const text = String(message);
  const error = document.getElementById('errorcontent');
  if (error) {
    error.textContent = text;
    document.getElementById('errorpane').style.display = 'block';
    document.getElementById('loadingpane').style.display = 'none';
  }
  vscode.postMessage({ type: 'error', request: ${request}, message: text });
}
window.addEventListener('error', event => reportPlayerError(event.message || 'A packaged Quixe script could not load.'), true);
window.addEventListener('unhandledrejection', event => reportPlayerError(event.reason?.message || event.reason));
window.game_options = { use_query_story: false, set_page_title: false, inspacing: 0, outspacing: 0 };
</script>
${scripts.map(name => `<script nonce="${nonce}" src="${uri(name)}"></script>`).join('\n')}
</head><body>
<div id="gameport"><div id="windowport"></div>
<div id="loadingpane"><img src="${uri('media/waiting.gif')}" alt="Loading"><br><em>Loading...</em></div>
<div id="errorpane" style="display:none;"><div id="errorcontent"></div></div></div>
<script nonce="${nonce}">
if (typeof $ !== 'function' || typeof GiLoad === 'undefined') {
  reportPlayerError('Packaged Quixe runtime failed to load.');
} else {
  $(document).ready(function() {
    try {
      GiLoad.load_run(null, '${bytes.toString('base64')}', 'base64');
      if (!GiLoad.inited()) {
        reportPlayerError(document.getElementById('errorcontent').textContent || 'Quixe could not initialize this story.');
      }
    } catch (error) { reportPlayerError(error.message || error); }
  });
}
</script></body></html>`;
  panel.reveal();
}

module.exports = { openPlayer };
