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

// Embedded in the player. SHOWME is a diagnostic command, not a VM room API.
// Read only its response in the command buffer, never status-grid/narrative labels.
function installRoomQualification(options, GlkOteClass, commands, sessionId, notify, installPlayback, observeShowme, config = {}) {
  let query, lines, windowId, prompt, echoed, prefix, size, complete, start, end;
  const windows = new Map(), tails = new Map();
  // Startup keypresses must run before SHOWME can reach a line-input prompt.
  let startup = 0;
  while (commands[startup]?.type === 'char') startup++;
  const sequence = [...commands, 'showme'];
  if (!config.boundaryOnly) sequence.splice(startup, 0, 'showme');
  const observer = {
    allowInput: config.allowInput,
    displayOutput(output) {
      if (!query || complete || output.type !== 'update') return output;
      // Keep the existing prompt while capturing the original diagnostic below.
      // Input requests and other windows must still reach the display normally.
      return { ...output, content: (output.content || []).filter(block => block.id !== windowId) };
    },
    termination(index) {
      // Only the final recorded command may terminate; never a SHOWME probe.
      if (config.boundaryOnly || !start || query || index !== commands.length + 1) return false;
      end = { type: 'termination' };
      return true;
    },
    beforeCommand(index, request) {
      if ((!config.boundaryOnly && index === startup) || index === sequence.length - 1) {
        query = config.boundaryOnly || index !== startup ? 'end' : 'start';
        lines = []; echoed = ''; prefix = false; size = 0; complete = false;
        windowId = request.id;
        prompt = tails.get(windowId);
        if (windows.get(windowId) !== 'buffer') throw new Error('SHOWME requires a text-buffer command window.');
        if (typeof prompt !== 'string' || !prompt.trim() || /[\r\n]/.test(prompt)) throw new Error('Cannot isolate the command prompt for SHOWME.');
      }
    },
    update(output) {
      if (output.windows) {
        windows.clear();
        for (const win of output.windows) windows.set(win.id, win.type);
      }
      for (const block of output.content || []) {
        if (windows.get(block.id) !== 'buffer') continue;
        if (block.id !== windowId && !output.input?.some(input => input.type === 'line' && input.id === block.id)) continue;
        if (!Array.isArray(block.text)) throw new Error('Unsupported SHOWME output.');
        for (const paragraph of block.text) {
          const capture = query && !complete && block.id === windowId;
          if (!paragraph.append) tails.set(block.id, '');
          if (capture && (!paragraph.append || !lines.length)) {
            if (!lines.length) prefix = !!paragraph.append;
            lines.push('');
          }
          const content = paragraph.content || [];
          for (let i = 0; i < content.length; i++) {
            const run = content[i];
            let style, value;
            if (typeof run === 'string') { style = run; value = content[++i]; }
            else if (run && typeof run === 'object' && typeof run.text === 'string') { style = run.style; value = run.text; }
            else {
              if (capture) throw new Error('Unsupported SHOWME output run.');
              tails.delete(block.id);
              continue;
            }
            if (typeof value !== 'string') throw new Error('Invalid SHOWME text.');
            tails.set(block.id, (tails.get(block.id) || '') + value);
            if (!capture) continue;
            size += value.length;
            // Strip only the initial exact input echo, including split runs.
            // Later input-styled diagnostic characters are still diagnostic data.
            if (prefix && lines.length === 1 && !lines[0] && style === 'input' && echoed !== 'showme') {
              echoed += value;
              if (!'showme'.startsWith(echoed)) throw new Error('Cannot isolate SHOWME command echo.');
            } else lines[lines.length - 1] += value;
          }
        }
      }
      // Freeze the response at its first settled line request. Later timer or
      // redraw output before the scheduler callback is not part of SHOWME.
      if (query && output.input?.length === 1 && output.input[0].type === 'line' && output.input[0].id === windowId) complete = true;
      if (query && size > 1024 * 1024) throw new Error('SHOWME response is too large.');
    },
    boundary(index) {
      if (query) {
        try {
          if (!complete) throw new Error('Diagnostic did not reach a settled boundary.');
          if (echoed && echoed !== 'showme') throw new Error('Incomplete command echo.');
          if (prefix) {
            if (lines[0] !== '') throw new Error('Unexpected text alongside command echo.');
            lines.shift();
          }
          // The supported Inform prompt is a separate final paragraph, identical
          // to the prompt observed immediately before the probe. No English text
          // or literal ">" is assumed. Remove its one empty separator paragraph,
          // not arbitrary blank diagnostic lines or any spaces within a line.
          if (!lines.length || lines.pop() !== prompt) throw new Error('Cannot isolate trailing command prompt.');
          if (lines.pop() !== '') throw new Error('Cannot isolate the prompt separator.');
          const endpoint = observeShowme(lines);
          if (query === 'start') start = endpoint; else end = endpoint;
        } catch (error) { throw new Error(`Cannot obtain ${query} SHOWME observation: ${error.message}`); }
        query = undefined;
      }
      notify({ type: 'skein.playback', sessionId, kind: 'progress', message: 'Qualifying test vector…', submitted: index });
    }
  };
  return installPlayback(options, GlkOteClass, sequence, sessionId, message => {
    if (message.kind === 'complete') {
      if ((!config.boundaryOnly && !start) || !end) notify({ ...message, kind: 'stopped', message: 'Missing qualified SHOWME observation.' });
      else notify({ ...message, endpoints: { start, end } });
    } else notify(message);
  }, observer, config.seed);
}

module.exports = { installRoomQualification };
