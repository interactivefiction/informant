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
const { Skein, runs } = require('./skein');
const { installTestPlayback } = require('./test-runner');
const { SkeinRecorder } = require('./skein-recorder');
const { installSkeinRecording } = require('./skein-recording-adapter');
const { installSkeinPlayback } = require('./skein-playback-adapter');
const { installRoomQualification } = require('./room-qualification');
const { observeShowme } = require('./showme-observation');
const { copyEndpoint } = require('./iskein');
const { WorkingISkein, ensureNoWorking } = require('./working-iskein');
const { installCompositionPlayback } = require('./composition-playback');
const { installContinuation } = require('./continuation-adapter');

const { installPlayableContinuation } = require('./playable-continuation');
const sessionListeners = new Set();
const notifySession = () => { for (const listener of sessionListeners) listener(); };
function onPlaybackSessionChange(listener) { sessionListeners.add(listener); return { dispose: () => sessionListeners.delete(listener) }; }
function continuationOrigin(project) {
  const s = activeSession;
  return s && !s.closed && s.project === project && s.continuationEligible && !s.continuation ? { name: s.sourceName } : undefined;
}
async function recordLiveContinuation(project, onChange, signal) {
  const session = activeSession;
  await ensureNoWorking(project);
  signal?.throwIfAborted();
  if (session !== activeSession || !continuationOrigin(project)) throw new Error('No eligible live playback endpoint.');
  attachContinuation(session, project, session.sourceName, onChange);
  session.continuationEligible = false;
  notifySession();
  try {
    if (!await session.panel.webview.postMessage({ type: 'playable.continuation.start', replayId: session.replayId, sessionId: session.continuation.sessionId })) throw new Error('Player is unavailable.');
  } catch (error) { session.continuation.fail(error); throw error; }
}
function attachContinuation(session, project, sourceName, onChange) {
  session.continuation = new WorkingISkein(project, sourceName, { onChange,
    onError: error => vscode.window.showErrorMessage(`Informant Continuation Recording: ${error.message}`) });
  session.continuation.send = message => session.panel.webview.postMessage(message);
  session.armContinuationTimeout = () => {
    clearTimeout(session.timer);
    session.timer = setTimeout(() => session.continuation.fail(new Error('Replay timed out waiting for a settled line-input boundary.')), 30000);
    session.timer.unref?.();
  };
  session.armContinuationTimeout();
}

const scripts = ['lib/jquery-1.12.4.min.js', 'lib/glkote.min.js', 'lib/quixe.min.js'];
const styles = ['media/glkote.css', 'media/dialog.css'];
let playerPanel;
let requestNumber = 0;
let activeSession;
const closing = new Set();

function finishSession(session, panelDisposed = false) {
  if (!session) return Promise.resolve();
  clearTimeout(session.timer);
  const stopped = session.replayId && !session.closed && !panelDisposed
    ? session.panel.webview.postMessage(session.continuation
      ? { type: 'iskein.continuation.discard', sessionId: session.continuation.sessionId }
      : { type: 'skein.playback.stop', sessionId: session.replayId })
    : undefined;
  session.settle?.(new Error('Qualification cancelled: player closed or replaced.'));
  if (session.composition && !session.playbackResult) session.onPlaybackChange?.({ kind: 'stopped', message: `Composition “${session.composition.name}” stopped: player closed or replaced.` });
  session.closed = true;
  notifySession();
  const done = Promise.all([session.recorder?.finalize(), session.continuation?.finalize(), stopped]).then(() => {});
  closing.add(done);
  done.finally(() => closing.delete(done));
  return done;
}

async function shutdownPlayer() {
  ++requestNumber;
  await finishSession(activeSession);
  await Promise.all([...closing]);
}

async function openPlayer(runtimeRoot, storyPath, context, { recordingProject, replayCommands, qualification = false, replayEndpoint, signal, continuationProject, sourceName, onContinuationChange, composition, onPlaybackChange, project } = {}) {
  signal?.throwIfAborted();
  if (composition) {
    replayCommands = composition.commands;
    replayEndpoint = composition.endpoint;
  }
  if (continuationProject) {
    if (!replayCommands || qualification || recordingProject || replayEndpoint) throw new Error('Invalid continuation options.');
    await ensureNoWorking(continuationProject);
    if (activeSession?.recorder && !activeSession.closed) throw new Error('Close Record Skein before recording a continuation.');
  }
  if (qualification && (!replayCommands || recordingProject)) throw new Error('Qualification requires replay commands.');
  if (qualification && activeSession?.recorder && !activeSession.closed) throw new Error('Close the recording player before making a test vector.');
  if (recordingProject && replayCommands) throw new Error('Recording and playback cannot share a session.');
  if (replayCommands && (!Array.isArray(replayCommands) || replayCommands.some(command => typeof command !== 'string' && (command?.type !== 'char' || !Skein.validChar(command.value))))) {
    throw new Error('Invalid Skein replay commands.');
  }
  if (replayEndpoint !== undefined) {
    if (!['location', 'termination'].includes(replayEndpoint) || !replayCommands || qualification || recordingProject) {
      throw new Error('Invalid ISkein playback options.');
    }
    // Finalizing a recorder can write Skein.skein; library playback is read-only.
    if (activeSession?.recorder && !activeSession.closed) throw new Error('Close the recording player before playing an ISkein.');
  }
  const request = ++requestNumber;
  const { root, assets, bytes } = await playerResources(runtimeRoot, storyPath);
  const glulx = bytes.length >= 36 && bytes.toString('ascii', 0, 4) === 'Glul';
  const blorb = bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'FORM' && bytes.toString('ascii', 8, 12) === 'IFRS';
  if (!glulx && !blorb) throw new Error('Unsupported story format: Quixe requires a Glulx story or Glulx Blorb.');
  if (recordingProject && !glulx) throw new Error('Record Skein requires a Glulx output-test.ulx. Run Compile Test Story first.');
  if (replayCommands && !glulx) throw new Error('Play Skein requires a Glulx output-test.ulx. Run Informant: Compile Test Story first.');
  signal?.throwIfAborted();
  if (request !== requestNumber) {
    if (continuationProject) throw new Error('Continuation launch was superseded.');
    if (qualification) throw new Error('Qualification launch was superseded.');
    if (replayEndpoint) throw new Error('ISkein playback launch was superseded.');
    return;
  }
  if (continuationProject && activeSession?.recorder && !activeSession.closed) throw new Error('Close Record Skein before recording a continuation.');
  if (replayEndpoint && activeSession?.recorder && !activeSession.closed) throw new Error('Close the recording player before playing an ISkein.');
  // Validate first. A failed new launch must not invalidate the current session.
  await finishSession(activeSession);
  await Promise.all([...closing]);
  signal?.throwIfAborted();
  if (request !== requestNumber) {
    if (continuationProject) throw new Error('Continuation launch was superseded.');
    if (qualification) throw new Error('Qualification launch was superseded.');
    if (replayEndpoint) throw new Error('ISkein playback launch was superseded.');
    return;
  }
  if (!playerPanel) {
    const panel = vscode.window.createWebviewPanel('informant.player', 'Informant Player', vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.file(root)] });
    playerPanel = panel;
    const messages = panel.webview.onDidReceiveMessage(message => {
      const session = activeSession;
      if (playerPanel !== panel || !session) return;
      if (message?.type === 'playable.continuation' && message.sessionId === session.replayId && !session.closed) {
        session.continuationEligible = message.eligible === true && session.playbackResult?.kind === 'complete' && session.replayEndpoint === 'location';
        notifySession();
      } else if (message?.type === 'iskein.continuation') {
        session.continuation?.receive(message);
        if (message.sessionId === session.continuation?.sessionId) {
          if (['ready', 'ended', 'error'].includes(message.kind)) clearTimeout(session.timer);
          else if (message.kind === 'progress' && !session.continuation?.start) session.armContinuationTimeout?.();
        }
      } else if (message?.type === 'skein.recording') {
        session.recorder?.receive(message);
        if (session.recorder?.started || session.recorder?.closed) clearTimeout(session.timer);
      } else if (message?.type === 'skein.playback' && session.replayId === message.sessionId && !session.closed) {
        if (typeof message.message !== 'string') return;
        if (session.settle) {
          if (message.kind === 'progress') session.armTimeout();
          else if (message.kind === 'complete') {
            const endpoints = message.endpoints;
            try {
              if (message.submitted !== session.commandCount + (endpoints?.end?.type === 'termination' ? 1 : 2)) throw new Error('Invalid qualification command count.');
              session.settle(null, { start: copyEndpoint(endpoints?.start), end: copyEndpoint(endpoints?.end, true) });
            } catch (error) { session.settle(error); }
            void finishSession(session);
          } else if (message.kind === 'stopped') {
            session.settle(new Error(message.message));
            void finishSession(session);
          }
          return;
        }
        if (['complete', 'stopped'].includes(message.kind) && !session.playbackResult) {
          session.playbackResult = message;
          session.onPlaybackChange?.(message);
        }
        if (message.kind === 'complete') vscode.window.showInformationMessage(message.message);
        else if (message.kind === 'stopped') vscode.window.showWarningMessage(message.message);
      } else if (message?.type === 'error' && message.request === session.request && typeof message.message === 'string') {
        clearTimeout(session.timer);
        session.continuationEligible = false;
        notifySession();
        if (session.composition && !session.playbackResult) {
          session.playbackResult = { kind: 'stopped', message: `Composition “${session.composition.name}” failed: ${message.message}` };
          session.onPlaybackChange?.(session.playbackResult);
        }
        if (session.settle) { session.settle(new Error(message.message)); void finishSession(session); }
        else if (session.continuation) session.continuation.fail(new Error(message.message));
        else if (session.recorder) session.recorder.fail(new Error(message.message));
        else vscode.window.showErrorMessage(`Informant Player: ${message.message}`);
      }
    });
    panel.onDidDispose(() => {
      messages.dispose();
      if (playerPanel === panel) {
        const session = activeSession;
        activeSession = undefined;
        playerPanel = undefined;
        // The Webview is already disposed; only finalize host-side state.
        void finishSession(session, true);
      }
    });
    context.subscriptions.push(panel);
  }
  const panel = playerPanel;
  const recorder = recordingProject ? new SkeinRecorder(recordingProject, {
    onError: error => vscode.window.showErrorMessage(`Informant Record Skein: ${error.message}`),
    onWarning: message => vscode.window.showWarningMessage(`Informant Record Skein: ${message}`)
  }) : undefined;
  const replayId = replayCommands ? crypto.randomUUID() : undefined;
  const session = { request, recorder, replayId, panel, composition, onPlaybackChange, project, replayEndpoint,
    sourceName: composition?.name || sourceName || 'ISkein' };
  if (continuationProject) attachContinuation(session, continuationProject, sourceName, onContinuationChange);
  activeSession = session;
  notifySession();
  let completion;
  if (qualification) {
    session.commandCount = replayCommands.length;
    completion = new Promise((resolve, reject) => {
      let settled = false;
      const abort = () => { session.settle(new Error('Qualification cancelled.')); void finishSession(session); };
      session.settle = (error, endpoints) => {
        if (settled) return;
        settled = true;
        clearTimeout(session.timer);
        signal?.removeEventListener('abort', abort);
        if (error) reject(error); else resolve(endpoints);
      };
      session.armTimeout = () => {
        clearTimeout(session.timer);
        session.timer = setTimeout(() => {
          session.settle(new Error('Qualification timed out waiting for a settled line-input boundary.'));
          void finishSession(session);
        }, 30000);
        session.timer.unref?.();
      };
      signal?.addEventListener('abort', abort, { once: true });
      session.armTimeout();
    });
  }
  if (recorder) {
    session.timer = setTimeout(() => {
      if (!recorder.started && !recorder.closed) recorder.fail(new Error('Recording did not start. The previous Skein has been preserved.'));
    }, 15000);
    session.timer.unref?.();
  }
  try {
    panel.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.file(root)] };
    const uri = name => panel.webview.asWebviewUri(vscode.Uri.file(assets[name])).toString().replace(/&/g, '&amp;').replace(/"/g, '&quot;');
    const nonce = crypto.randomBytes(16).toString('hex');
    const source = panel.webview.cspSource;
    panel.webview.html = playerDocument({ uri, nonce, source, bytes, request, recorder, project, replayEndpoint,
      replayId, replayCommands, continuationProject, composition, qualification, session });
    panel.reveal();
  } catch (error) {
    if (!qualification) { session.continuation?.fail(error); throw error; }
    session.settle(error);
    void finishSession(session);
  }
  return completion;
}

module.exports = { openPlayer, shutdownPlayer, continuationOrigin, recordLiveContinuation, onPlaybackSessionChange };

async function playerResources(runtimeRoot, storyPath) {
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
  return { root, assets, bytes };
}

function playerDocument({ uri, nonce, source, bytes, request = 0, recorder, project, replayEndpoint,
  replayId, replayCommands, continuationProject, composition, qualification, session = {}, testPlan, bridge, embedded }) {
  return `<!doctype html><html><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}' 'unsafe-eval'; style-src ${source} 'unsafe-inline'; img-src ${source} data: blob:; font-src ${source}; connect-src 'none'; media-src 'none'; base-uri 'none'; form-action 'none';">
<title>Informant Player</title>
${styles.map(name => embedded ? `<style>${embedded[name].toString().replace(/<\/style/gi, '<\\/style')}</style>` : `<link rel="stylesheet" href="${uri(name)}">`).join('\n')}
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

.Input:focus {
    outline: 1px solid var(--vscode-focusBorder, var(--vscode-editor-foreground));
    outline-offset: -1px;
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
const vscode = ${bridge ? `({ postMessage: message => parent.postMessage({ type: 'test.frame', token: ${JSON.stringify(bridge)}, message }, '*') })` : 'acquireVsCodeApi()'};
let recordingAdapter;
let playbackAdapter;
window.addEventListener('message', event => playbackAdapter?.receive(event.data));
window.addEventListener('pagehide', () => {
  if (playbackAdapter?.close) playbackAdapter.close();
  else playbackAdapter?.stop('Skein playback stopped: player closed.');
});
function reportPlayerError(message) {
  const text = String(message);
  playbackAdapter?.stop(text);
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
${scripts.map(name => embedded ? `<script nonce="${nonce}">${embedded[name].toString().replace(/<\/script/gi, '<\\/script')}</script>` : `<script nonce="${nonce}" src="${uri(name)}"></script>`).join('\n')}
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
      ${testPlan ? `const runs = ${runs.toString()}; const Skein = ${Skein.toString()};
      playbackAdapter = (${installTestPlayback.toString()})(window.game_options, GlkOteClass,
        ${JSON.stringify(testPlan).replace(/</g, '\\u003c')}, ${JSON.stringify(bridge)}, message => vscode.postMessage(message),
        (${installCompositionPlayback.toString()}), (${installSkeinPlayback.toString()}), Skein);` : ''}
      ${recorder ? `recordingAdapter = (${installSkeinRecording.toString()})(window.game_options, GlkOteClass,
        message => vscode.postMessage(message), ${JSON.stringify(recorder.sessionId)}, reportPlayerError);` : ''}
      ${project && replayEndpoint ? `playbackAdapter = (${installPlayableContinuation.toString()})(window.game_options, ${JSON.stringify(replayId)}, ${JSON.stringify(replayEndpoint)}, message => vscode.postMessage(message), notify => { let replayAdapter;` : ''}
      ${replayId && !continuationProject && !composition ? `${project && replayEndpoint ? 'replayAdapter' : 'playbackAdapter'} = (${(qualification ? installRoomQualification : installSkeinPlayback).toString()})(window.game_options, GlkOteClass,
        ${JSON.stringify(replayCommands).replace(/</g, '\\u003c')}, ${JSON.stringify(replayId)}, message => ${project && replayEndpoint ? 'notify' : 'vscode.postMessage'}(${replayEndpoint ? "{ ...message, message: message.message.replace(/^Skein/, 'ISkein') }" : 'message'})${qualification ? `, (${installSkeinPlayback.toString()}), (${observeShowme.toString()})` : replayEndpoint === 'termination' ? `, { termination: position => position === ${replayCommands.length} }` : ''});` : ''}
      ${composition ? `${project && replayEndpoint ? 'replayAdapter' : 'playbackAdapter'} = (${installCompositionPlayback.toString()})(window.game_options, GlkOteClass,
        ${JSON.stringify(composition).replace(/</g, '\\u003c')}, ${JSON.stringify(replayId)}, message => ${project && replayEndpoint ? 'notify' : 'vscode.postMessage'}(message), (${installSkeinPlayback.toString()}));` : ''}
      ${project && replayEndpoint ? `return replayAdapter; }, (${installContinuation.toString()}), (${installSkeinPlayback.toString()}), (${installRoomQualification.toString()}), (${observeShowme.toString()}));` : ''}
      ${session.continuation ? `playbackAdapter = (${installContinuation.toString()})(window.game_options, GlkOteClass,
        ${JSON.stringify(replayCommands).replace(/</g, '\\u003c')}, ${JSON.stringify(session.continuation.sessionId)}, message => vscode.postMessage(message),
        (${installSkeinPlayback.toString()}), (${installRoomQualification.toString()}), (${observeShowme.toString()}));` : ''}
      GiLoad.load_run(null, '${bytes.toString('base64')}', 'base64');
      if (!GiLoad.inited()) {
        reportPlayerError(document.getElementById('errorcontent').textContent || 'Quixe could not initialize this story.');
      } else {
        recordingAdapter?.started();
        playbackAdapter?.started();
      }
    } catch (error) {
      if (recordingAdapter) recordingAdapter.fail(error.message || error);
      else reportPlayerError(error.message || error);
    }
  });
}
</script></body></html>`;
}

// The Test Manager owns this frame. It never opens, replaces, or reveals the
// normal player panel; removing the frame destroys its VM and pending timers.
async function runHiddenTest(runtimeRoot, storyPath, panel, nonce, plan, signal, onStep = () => {}) {
  signal.throwIfAborted();
  const { root, assets, bytes } = await playerResources(runtimeRoot, storyPath);
  if (bytes.length < 36 || bytes.toString('ascii', 0, 4) !== 'Glul') throw new Error('Compile Test Story first: a Glulx output-test.ulx is required.');
  signal.throwIfAborted();
  const token = crypto.randomUUID();
  if (!panel.webview.options.localResourceRoots?.some(uri => uri.fsPath === root)) {
    throw new Error('The test runtime is not available to this panel. Close and reopen Test Manager after installing a toolchain.');
  }
  const uri = name => panel.webview.asWebviewUri(vscode.Uri.file(assets[name])).toString().replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  // Blob frames have no webview id in their URL, so VS Code's resource
  // service worker cannot route their asWebviewUri requests. Embed the trusted
  // packaged runtime instead, retaining nonce authorization for every script.
  const embedded = Object.fromEntries(await Promise.all(
    Object.entries(assets).map(async ([name, file]) => [name, await fs.readFile(file)])));
  signal.throwIfAborted();
  const html = playerDocument({ uri: name => name === 'media/waiting.gif'
    ? `data:image/gif;base64,${embedded[name].toString('base64')}` : uri(name),
    nonce, source: panel.webview.cspSource, bytes, testPlan: plan, bridge: token, embedded });
  return new Promise((resolve, reject) => {
    let finished = false, timer, completed = 0;
    const settle = (error, result) => {
      if (finished) return;
      finished = true; clearTimeout(timer);
      signal.removeEventListener('abort', abort); messages.dispose(); closed.dispose();
      try { Promise.resolve(panel.webview.postMessage({ type: 'test.frame.remove', token })).catch(() => {}); }
      catch { /* A disposed panel already destroyed the frame. */ }
      if (error) reject(error); else resolve(result);
    };
    const arm = () => { clearTimeout(timer); timer = setTimeout(() => settle(null, { status: 'FAIL', position: Math.min(completed + 1, plan.turns.length) || undefined, reason: 'Test timed out waiting for command response.' }), 30000); };
    const abort = () => settle(new Error('Test cancelled.'));
    const messages = panel.webview.onDidReceiveMessage(event => {
      if (event?.type !== 'test.frame' || event.token !== token) return;
      const message = event.message;
      if (message?.type === 'error') settle(null, { status: 'FAIL', reason: String(message.message) });
      if (message?.sessionId !== token) return;
      if (!finished && message.type === 'test.step' && Number.isInteger(message.position) && message.position === completed + 1 && message.position <= plan.commands.length) onStep(message.position);
      if (message.type === 'test.progress' && message.completed === completed + 1 && message.completed <= plan.turns.length) { completed = message.completed; arm(); }
      if (message.type === 'test.result') settle(null, message);
    });
    const closed = panel.onDidDispose(abort);
    signal.addEventListener('abort', abort, { once: true });
    arm();
    if (signal.aborted) { abort(); return; }
    Promise.resolve(panel.webview.postMessage({ type: 'test.frame.load', token, html })).then(sent => {
      if (sent === false) settle(new Error('Test Manager is unavailable.'));
    }, error => settle(error));
  });
}
module.exports.runHiddenTest = runHiddenTest;
