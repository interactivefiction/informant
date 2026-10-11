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

// This function is embedded in the player document. Keep it self-contained.
function installSkeinRecording(options, GlkOteClass, post, sessionId, reportError) {
  let sequence = 0;
  let started = false;
  let failed = false;
  let ready = false;
  let readySent = false;
  const send = (kind, payload) => post({ type: 'skein.recording', sessionId, sequence: ++sequence, kind, payload });
  function fail(message) {
    if (failed) return;
    failed = true;
    send('error', String(message));
    reportError(String(message));
  }
  function announceReady() {
    // Wait until the update and loader stack have completed without throwing.
    Promise.resolve().then(() => {
      if (started && ready && !failed && !readySent) { readySent = true; send('ready'); }
    });
  }
  const glkote = new GlkOteClass();
  const originalError = glkote.error;
  glkote.error = function(message) { fail(message); return originalError.call(glkote, message); };
  options.GlkOte = glkote;
  options.do_vm_autosave = false;
  options.recording_format = 'glkote';
  options.recording_handler = state => {
    if (failed) return;
    try {
      const copy = JSON.parse(JSON.stringify({ input: state.input, output: state.output }));
      send('update', copy);
      const output = copy.output;
      if (output?.type === 'update' && (output.exit || (!output.disable && output.input?.some(input => ['line', 'char'].includes(input.type))))) ready = true;
      announceReady();
    } catch (error) { fail(error.message || error); }
  };
  return { started() { started = true; announceReady(); }, fail };
}

module.exports = { installSkeinRecording };
