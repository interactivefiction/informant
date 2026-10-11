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

// Keep the recording callback installed at VM startup, then hand the same GlkOte
// and settled output to the existing recorder only on an explicit host request.
function installPlayableContinuation(options, replayId, endpoint, post, createReplay, installContinuation, installPlayback, installQualification, observeShowme) {
  let adapter, recording, eligible = false, finished = false, latest, originalAccept, iface;
  const windows = new Map(), paragraphs = new Map();
  function availability(value) {
    if (eligible === value) return;
    eligible = value;
    post({ type: 'playable.continuation', sessionId: replayId, eligible });
  }
  const capture = state => {
    if (recording) { recording(state); return; }
    const output = state.output;
    if (finished && (output?.type === 'error' || output?.exit || output?.disable || output?.specialinput ||
      output?.input?.length !== 1 || output.input[0].type !== 'line')) availability(false);
    if (output?.windows) { windows.clear(); for (const win of output.windows) windows.set(win.id, win); }
    for (const block of output?.content || []) for (const paragraph of block.text || []) {
      const prior = paragraphs.get(block.id);
      paragraphs.set(block.id, paragraph.append && prior
        ? { content: [...(prior.content || []), ...(paragraph.content || [])] }
        : { ...paragraph });
    }
    if (output?.type === 'update') latest = { ...output, windows: [...windows.values()],
      content: [...paragraphs].map(([id, paragraph]) => ({ id, text: [paragraph] })) };
  };
  options.recording_format = 'glkote';
  options.recording_handler = capture;
  adapter = createReplay(message => {
    post(message);
    if (message.kind !== 'progress') {
      finished = true;
      availability(message.kind === 'complete' && endpoint !== 'termination' && !latest?.exit && !latest?.disable && latest?.input?.length === 1);
    }
  });
  const glkote = options.GlkOte, originalError = glkote.error;
  glkote.error = function(message) { availability(false); return originalError.call(glkote, message); };
  return {
    started() {
      adapter.started();
      iface = glkote.getinterface(); originalAccept = iface.accept;
      iface.accept = function(event) {
        if (!['init', 'refresh', 'arrange', 'redraw'].includes(event.type)) availability(false);
        return originalAccept.call(iface, event);
      };
    },
    stop(message) { availability(false); adapter.stop(message); },
    receive(message) {
      if (message?.type !== 'playable.continuation.start') { adapter.receive(message); return; }
      if (message.replayId !== replayId) return;
      if (!eligible || recording) {
        post({ type: 'iskein.continuation', sessionId: message.sessionId, sequence: 1, kind: 'error', payload: 'The live playback endpoint is no longer available.' });
        return;
      }
      availability(false);
      iface.accept = originalAccept;
      glkote.error = originalError;
      adapter.dispose();
      adapter = installContinuation(options, function() { return glkote; }, [], message.sessionId, post,
        installPlayback, installQualification, observeShowme, latest);
      recording = options.recording_handler;
      // Glk may retain the original callback on its interface.
      options.recording_handler = capture;
      adapter.started();
    }
  };
}
module.exports = { installPlayableContinuation };
