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

// One live VM supplies every segment and its qualified boundary checkpoints.
function installContinuation(options, GlkOteClass, commands, sessionId, post, installPlayback, installQualification, observeShowme, seed) {
  let mode = 'replay', sequence = 0, latest, endpoint, adapter, probeTimer, probeTimeout, accepting = false, probeActive = false, commandPrompt;
  const windows = new Map(), tails = new Map(), queued = [];
  const send = (kind, payload) => post({ type: 'iskein.continuation', sessionId, sequence: ++sequence, kind, payload });
  function fail(message) {
    if (mode === 'failed' || mode === 'closed') return;
    mode = 'failed'; clearTimeout(probeTimer); clearTimeout(probeTimeout); adapter?.dispose();
    send('error', String(message));
  }
  function allowInput(event) {
    if (event.type === 'timer' && ['checkpoint', 'final'].includes(mode)) return false;
    if (['init', 'refresh', 'arrange', 'redraw', 'timer'].includes(event.type)) return true;
    if (['checkpoint', 'final'].includes(mode) && endpoint?.type !== 'termination' && event.type === 'line') { queued.push({ ...event }); return false; }
    return mode === 'record' || mode === 'replay' || mode === 'closed' || mode === 'failed';
  }
  function drainInput() {
    if (mode !== 'record' || !queued.length) return;
    const request = latest.input[0], event = queued.shift();
    glkote.getinterface().accept({ ...event, gen: latest.gen, window: request.id });
  }
  function atCommandPrompt() {
    const request = latest?.input?.[0];
    return latest?.input?.length === 1 && request.type === 'line' && tails.get(request.id) === commandPrompt;
  }
  function qualify() {
    mode = 'checkpoint';
    // Leave the VM's output callback before installing and submitting a probe.
    probeTimer = setTimeout(() => {
      try {
        probeActive = true;
        adapter = installQualification(options, function() { return glkote; }, [], sessionId, notifyReplay,
        installPlayback, observeShowme, { boundaryOnly: true, seed: latest, allowInput });
        adapter.started();
        probeTimeout = setTimeout(() => fail('Continuation endpoint qualification timed out.'), 30000);
      } catch (error) { fail(error.message || error); }
    }, 0);
  }
  options.recording_format = 'glkote';
  options.recording_handler = state => {
    try {
      const copy = JSON.parse(JSON.stringify({ input: state.input, output: state.output }));
      const output = copy.output;
      if (output?.windows) { windows.clear(); for (const win of output.windows) windows.set(win.id, win); }
      for (const block of output?.content || []) {
        if (windows.get(block.id)?.type !== 'buffer') continue;
        for (const paragraph of block.text || []) {
          if (!paragraph.append) tails.set(block.id, '');
          const content = paragraph.content || [];
          for (let i = 0; i < content.length; i++) {
            const run = content[i], value = typeof run === 'string' ? content[++i] : run?.text;
            if (typeof value === 'string') tails.set(block.id, (tails.get(block.id) || '') + value);
          }
        }
      }
      if (output?.type === 'update') latest = { ...output, windows: [...windows.values()] };
      if (mode !== 'record') return;
      if (output?.type === 'error') throw new Error(output.message || 'Interpreter error.');
      if (output?.specialinput || (output?.disable && output.exit !== true)) throw new Error('Unsupported or disabled interpreter input.');
      if (output?.input?.some(input => !['line', 'char'].includes(input.type) || input.hyperlink || input.mouse) || output?.input?.length > 1) throw new Error('Unsupported or ambiguous interpreter input.');
      endpoint = undefined;
      send('update', copy);
      if (output?.exit === true) {
        if (output.input?.length) throw new Error('Invalid normal termination boundary.');
        mode = 'final'; endpoint = { type: 'termination' }; send('ended', endpoint);
      } else if (output?.type === 'update' && atCommandPrompt()) qualify();
    } catch (error) { fail(error.message || error); }
  };
  const notifyReplay = message => {
    if (message.kind === 'progress') send('progress');
    else if (message.kind === 'stopped') fail(message.message);
    else if (message.kind === 'complete') {
      clearTimeout(probeTimeout);
      adapter.dispose(); probeActive = false;
      endpoint = message.endpoints.end;
      if (mode === 'replay') {
        commandPrompt = tails.get(latest.input[0].id);
        const iface = glkote.getinterface(), accept = iface.accept;
        iface.accept = function(event) {
          if (!(mode === 'checkpoint' && probeActive) && !allowInput(event)) return;
          if (mode === 'record' && !['init', 'refresh', 'arrange', 'redraw'].includes(event.type)) {
            endpoint = undefined; send('dirty');
          }
          return accept.call(iface, event);
        };
        mode = 'record';
        send('ready', { start: endpoint, output: { ...latest, content: [] } });
      } else if (mode === 'checkpoint') {
        mode = accepting ? 'final' : 'record';
        send(accepting ? 'ended' : 'boundary', endpoint);
        drainInput();
      }
    }
  };
  const glkote = new GlkOteClass(), originalError = glkote.error;
  glkote.error = function(message) { fail(message); return originalError.call(glkote, message); };
  if (seed) options.recording_handler({ output: seed });
  adapter = installQualification(options, function() { return glkote; }, commands, sessionId, notifyReplay,
    installPlayback, observeShowme, { boundaryOnly: true, seed });
  function close() {
    mode = 'closed'; clearTimeout(probeTimer); clearTimeout(probeTimeout); adapter.dispose();
  }
  return {
    close,
    started() { adapter.started(); },
    stop(message) { fail(message); },
    receive(message) {
      if (message?.sessionId !== sessionId) return;
      if (message.type === 'iskein.continuation.discard') {
        close(); return;
      }
      if (message.type === 'iskein.continuation.resume') {
        if (mode !== 'final' || endpoint?.type === 'termination') return;
        accepting = false; mode = 'record';
        send('ready', { start: endpoint, output: { ...latest, content: [] } });
        drainInput();
        return;
      }
      if (message.type !== 'iskein.continuation.accept') return;
      if (mode === 'final') { send('ended', endpoint); return; }
      if (queued.length || !['record', 'checkpoint'].includes(mode) || !atCommandPrompt() || latest.disable || latest.exit) {
        send('unavailable', 'Wait for a settled line-input boundary before accepting.'); return;
      }
      accepting = true;
      if (mode === 'checkpoint') return;
      if (endpoint) { mode = 'final'; send('ended', endpoint); }
      else qualify();
    }
  };
}
module.exports = { installContinuation };
