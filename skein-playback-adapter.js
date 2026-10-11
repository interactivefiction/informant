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

// Embedded in the existing player document; no dependencies or VM internals.
function installSkeinPlayback(options, GlkOteClass, commands, sessionId, notify, observer = {}, seed) {
  const glkote = new GlkOteClass();
  options.GlkOte = glkote;
  options.do_vm_autosave = false;
  let started = false, stopped = false, injecting = false;
  let position = 0, generation = -1, current, timer;
  const submitted = new Set();
  let wrappedInterface, originalAccept, wrappedAccept;
  function cancel() { clearTimeout(timer); timer = undefined; }
  function stop(message, kind = 'stopped') {
    if (stopped) return;
    stopped = true;
    cancel();
    notify({ type: 'skein.playback', sessionId, kind, message, submitted: position });
  }
  function schedule() {
    cancel();
    if (!started || stopped || !current) return;
    // Let the display update finish and paint before each turn. Never recurse
    // into the VM from its own output callback.
    timer = setTimeout(() => {
      timer = undefined;
      if (stopped || !current) return;
      const { gen, input = [] } = current;
      if (input.length !== 1 || !['line', 'char'].includes(input[0].type)) return;
      const request = input[0];
      const key = `${request.id}:${request.gen}`;
      if (submitted.has(key)) return;
      try { observer.boundary?.(position); }
      catch (error) { stop(`Skein qualification failed: ${error.message || error}`); return; }
      if (position === commands.length) {
        stop('Skein playback complete. You can continue playing.', 'complete');
        return;
      }
      const recorded = commands[position];
      const type = typeof recorded === 'string' ? 'line' : recorded?.type;
      const command = typeof recorded === 'string' ? recorded : recorded?.value;
      if (type !== request.type || typeof command !== 'string') {
        stop(`Skein playback stopped: recorded ${type || 'invalid'} input does not match the interpreter's ${request.type} request.`);
        return;
      }
      if (type === 'line' && (!Number.isInteger(request.maxlen) || command.length > request.maxlen)) {
        stop('Skein playback stopped: command exceeds the current line-input limit.');
        return;
      }
      submitted.add(key);
      try { observer.beforeCommand?.(position, request); }
      catch (error) { stop(`Skein qualification failed: ${error.message || error}`); return; }
      position++;
      current = undefined;
      injecting = true;
      try {
        // Glk installs accept_ui_event on THIS interface during init. That
        // function dispatches keyboard events to Glk and resumes the VM.
        glkote.getinterface().accept({ type, gen, window: request.id, value: command });
      } catch (error) { stop(`Skein playback stopped: ${error.message || error}`); }
      finally { injecting = false; }
    }, 180);
  }
  function wrapInterface(iface) {
    const accept = iface.accept;
    if (typeof accept !== 'function') throw new Error('Packaged Glk input interface is unavailable.');
    wrappedInterface = iface; originalAccept = accept;
    iface.accept = wrappedAccept = function(event) {
      if (!injecting && observer.allowInput?.(event) === false) return;
      cancel();
      current = undefined;
      if (!injecting && !['init', 'refresh', 'arrange', 'redraw', 'timer'].includes(event.type)) {
        stop('Skein playback stopped: human or unsupported input received. You can continue playing.');
      }
      return accept.call(iface, event);
    };
  }
  const init = glkote.init;
  glkote.init = function(iface) { wrapInterface(iface); return init.call(glkote, iface); };
  if (seed) {
    wrapInterface(glkote.getinterface());
    observer.update?.(seed);
    generation = seed.gen;
    current = { gen: seed.gen, input: seed.input };
  }
  const update = glkote.update;
  glkote.update = function(output) {
    // Filter before observation advances the probe state; capture and scheduling
    // still consume the unmodified VM output.
    const displayOutput = stopped ? output : (observer.displayOutput?.(output) ?? output);
    if (output.type === 'error') stop(`Skein playback stopped: ${output.message || 'Interpreter error.'}`);
    if (!stopped && output.type === 'update' && Number.isInteger(output.gen) && output.gen > generation) {
      cancel();
      generation = output.gen;
      try { observer.update?.(output); }
      catch (error) { stop(`Skein qualification failed: ${error.message || error}`); }
      current = undefined;
      if (output.specialinput) stop('Skein playback stopped: file selection or other special input requires human input.');
      else if (output.exit) {
        // Glk's normal glk_exit emits exit:true (and disable:true). Fatal
        // errors call GlkOte.error first, which permanently stops this replay.
        try {
          if (!stopped && output.exit === true && (!output.input || (Array.isArray(output.input) && !output.input.length)) && observer.termination?.(position)) {
            stop('Skein playback complete: story terminated normally.', 'complete');
          } else stop('Skein playback stopped: the interpreter exited.');
        } catch (error) { stop(`Skein qualification failed: ${error.message || error}`); }
      }
      else if (output.disable) stop('Skein playback stopped: interpreter input is disabled.');
      else {
        const input = output.input || [];
        if (!Array.isArray(input) || input.some(request => !['line', 'char'].includes(request.type) || request.hyperlink || request.mouse) || input.length > 1) {
          stop('Skein playback stopped: unsupported or ambiguous input request.');
        } else if (input.length) {
          const request = input[0];
          if (!Number.isInteger(request.id) || !Number.isInteger(request.gen)) stop('Skein playback stopped: invalid runtime input request.');
          else if (request.type !== (typeof commands[position] === 'object' ? commands[position]?.type : 'line')) {
            stop(`Skein playback stopped: recorded input does not match the interpreter's ${request.type} request.`);
          } else current = { gen: output.gen, input: input.map(request => ({ ...request })) };
        }
      }
    }
    const result = update.call(glkote, displayOutput);
    schedule();
    return result;
  };
  const error = glkote.error;
  glkote.error = function(message) { stop(`Skein playback stopped: ${message}`); return error.call(glkote, message); };
  return {
    dispose() {
      stopped = true; cancel();
      glkote.init = init; glkote.update = update; glkote.error = error;
      if (wrappedInterface?.accept === wrappedAccept) wrappedInterface.accept = originalAccept;
    },
    started() { started = true; schedule(); },
    stop,
    receive(message) {
      if (message?.type === 'skein.playback.stop' && message.sessionId === sessionId) stop('Skein playback stopped.');
    }
  };
}

module.exports = { installSkeinPlayback };
