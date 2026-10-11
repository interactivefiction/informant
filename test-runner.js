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

const { resolver } = require('./icomposition');
const { planComposition } = require('./composition-playback');
const { copyEndpoint } = require('./iskein');

function qualifiedTests(playables, includes = () => true) {
  const resolve = resolver(playables), tests = [];
  for (const playable of playables) {
    if (!includes(playable) || playable.entry !== 'initial') continue;
    try {
      copyEndpoint(playable.start); copyEndpoint(playable.end, true);
      const plan = planComposition(playable, resolve);
      tests.push({ ...plan, type: playable.type, turnCount: plan.commands.length });
    } catch { /* Unresolved or malformed graphs cannot run independently. */ }
  }
  return tests;
}

// No filesystem state: each invocation is a snapshot of independent playables.
async function runTests(plans, execute, signal, changed = () => {}) {
  const results = [];
  for (const plan of plans) {
    if (signal.aborted) break;
    const behavior = plan.behavior || 'stepwise';
    const row = { behavior, guid: plan.guid, name: plan.name, type: plan.type, turnCount: plan.commands.length, status: 'RUNNING' };
    results.push(row); changed(results);
    const start = Date.now();
    try {
      const outcome = await execute(plan, signal, position => {
        if (signal.aborted || row.status !== 'RUNNING' || !Number.isInteger(position) || position < 1 || position > plan.commands.length) return;
        const command = plan.commands[position - 1];
        const label = typeof command === 'string' ? command : `[key: ${command.value === ' ' ? 'Space' : command.value}]`;
        row.currentStep = `Step ${position}/${plan.commands.length}: ${label}`;
        changed(results);
      });
      if (signal.aborted) row.status = 'CANCELLED';
      else if (outcome?.status === 'PASS' && outcome.completed === plan.turns.length && outcome.compared === (behavior === 'none' ? 0 : behavior === 'endpoint' ? Math.min(1, plan.turns.length) : plan.turns.length)) row.status = 'PASS';
      else {
        row.status = 'FAIL';
        const position = outcome?.position;
        const turn = Number.isInteger(position) && position > 0 ? plan.turns[position - 1] : undefined;
        row.failure = { playableName: plan.name, playableGuid: plan.guid, position,
          ...turn, expected: turn?.result, received: outcome?.received,
          reason: outcome?.reason || 'Playback did not complete all steps and required comparisons.' };
        delete row.failure.result;
      }
    } catch (error) {
      row.status = signal.aborted ? 'CANCELLED' : 'FAIL';
      if (!signal.aborted) row.failure = { playableName: plan.name, playableGuid: plan.guid, reason: error.message };
    }
    delete row.currentStep;
    row.durationMs = Date.now() - start;
    changed(results);
  }
  return results;
}

// Embedded beside the replay adapter and Skein capture class. Capture uses
// replay input and raw VM output; comparison precedes the next command.
function installTestPlayback(options, GlkOteClass, plan, sessionId, post, installComposition, installReplay, SkeinClass) {
  let id = 0, completed = 0, compared = 0, done = false, captureError, pendingInput;
  const capture = new SkeinClass({ id: () => String(++id) });
  function finish(outcome) {
    if (done) return;
    done = true;
    post({ type: 'test.result', sessionId, ...outcome, completed, compared });
  }
  function compare(position) {
    if (captureError) throw captureError;
    if (done) throw new Error('Test already stopped.');
    if (position === completed) return;
    capture.flushEcho();
    const expected = plan.turns[completed], received = capture.items[completed + 1];
    if (position !== completed + 1 || !received || (received.command !== expected.command || received.inputType !== expected.inputType)) throw new Error('Recorded command capture is incomplete or out of order.');
    const verify = !plan.behavior || plan.behavior === 'stepwise' || (plan.behavior === 'endpoint' && position === plan.turns.length);
    if (verify && expected.result !== received.result) {
      finish({ status: 'FAIL', position, received: received.result, reason: 'Response mismatch.' });
      throw new Error('Response mismatch.');
    }
    completed++;
    if (verify) compared++;
    post({ type: 'test.progress', sessionId, completed, compared });
  }
  const adapter = installComposition(options, GlkOteClass, plan, sessionId, message => {
    // Defer completion until the interpreter update has finished.
    Promise.resolve().then(() => {
      if (done) return;
      try {
        if (message.kind === 'complete') {
          compare(plan.commands.length);
          if (completed !== plan.turns.length) throw new Error('Not every command was completed.');
          if ((plan.endpoint === 'termination') !== capture.exited) throw new Error('Playback did not reach the expected endpoint kind.');
          finish({ status: 'PASS' });
        } else if (message.kind === 'stopped') throw new Error(message.message);
      } catch (error) {
        finish({ status: 'FAIL', position: Math.min(completed + 1, plan.turns.length) || undefined,
          received: capture.items[completed + 1]?.result, reason: error.message });
      }
    });
  }, installReplay, {
    boundary: compare,
    beforeCommand(position, request) {
      post({ type: 'test.step', sessionId, position: position + 1 });
      // Replay calls the interpreter directly, bypassing GlkOte's UI recording.
      const command = plan.commands[position];
      pendingInput = { type: request.type, gen: request.gen, window: request.id, value: typeof command === 'string' ? command : command.value };
    },
    update(output) {
      if (done) return;
      try { capture.consume({ input: pendingInput, output }); }
      catch (error) { captureError = error; }
      pendingInput = undefined;
    }
  });
  return adapter;
}

module.exports = { qualifiedTests, runTests, installTestPlayback };
