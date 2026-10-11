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

const { replayInput } = require('./skein');

const { reference, resolver, serializeComposition } = require('./icomposition');
const { serializeVector } = require('./iskein');
const { discoverPlayables } = require('./composition-library');

// Resolve the complete execution snapshot before replacing any live player.
// The explicit stack traverses recursively authored members without JS stack limits.
function planComposition(root, resolve) {
  const commands = [], leaves = [], turns = [], active = new Set();
  const stack = [{ ref: reference(root), path: 'Root', first: true }];
  let terminated = false, name;
  while (stack.length) {
    const frame = stack.pop();
    if (frame.leave) { active.delete(frame.leave); if (frame.termination) terminated = true; continue; }
    const context = `${frame.path} / ${frame.ref.type}:${frame.ref.guid}`;
    try {
      const ref = reference(frame.ref), key = `${ref.type}:${ref.guid.toLowerCase()}`;
      if (terminated) throw new Error('Executable member after termination.');
      if (active.has(key)) throw new Error('Composition cycle.');
      const value = resolve(ref);
      if (!value) throw new Error('Missing referenced Playable.');
      if (!name) name = value.name;
      if (frame.first && value.entry !== 'initial') throw new Error('First member must be initial.');
      if (ref.type === 'iskein') {
        serializeVector(value);
        const start = commands.length;
        for (const [index, turn] of value.turns.entries()) {
          commands.push(replayInput(turn));
          turns.push({ ...turn, vectorGuid: value.guid, vectorName: value.name, vectorTurn: index + 1, context });
        }
        leaves.push({ context, start, end: commands.length, endpoint: value.end.type || 'location' });
        terminated = value.end.type === 'termination';
      } else {
        if (Array.isArray(value.members)) value.members.forEach((member, index) => {
          try { reference(member); }
          catch (error) { throw new Error(`member ${index + 1} ${member?.type}:${member?.guid}: ${error.message}`); }
        });
        serializeComposition(value);
        active.add(key);
        stack.push({ leave: key, termination: value.end.type === 'termination' });
        for (let i = value.members.length - 1; i >= 0; i--) {
          stack.push({ ref: value.members[i], path: `${context} (“${value.name}”) / member ${i + 1}`, first: i === 0 });
        }
      }
    } catch (error) { throw new Error(`${context}: ${error.message}`); }
  }
  return { guid: root.guid, name, commands, leaves, turns, endpoint: leaves.at(-1).endpoint };
}

async function loadCompositionPlayback(project, guid) {
  const library = await discoverPlayables(project), resolve = resolver(library.playables);
  return planComposition({ type: 'icomposition', guid }, ref => {
    const value = resolve(ref);
    if (value) return value;
    const issues = ref.type === 'iskein' ? library.vectors.issues : library.compositions.issues;
    const issue = issues.find(item => item.file.toLowerCase() === `${ref.guid}.${ref.type}`.toLowerCase());
    if (issue) throw new Error(`Malformed or unreadable artifact: ${issue.message}`);
    return undefined;
  });
}

// Only orchestration/context: all Glk input and replay scheduling stays in the
// same adapter used by Play ISkein. No probes or VM restarts at leaf boundaries.
function installCompositionPlayback(options, GlkOteClass, plan, sessionId, notify, installReplay, observer = {}) {
  let leaf = 0, timer, finished = false;
  const context = () => plan.leaves[leaf]?.context || `icomposition:${plan.guid}`;
  function report(message) {
    if (finished) return;
    if (message.kind !== 'progress') { finished = true; clearTimeout(timer); }
    notify({ ...message, message: message.kind === 'complete'
      ? `Composition “${plan.name}” complete.${plan.endpoint === 'termination' ? ' Story terminated normally.' : ' You can continue playing.'}`
      : `Composition “${plan.name}” — ${context()}: ${message.message}` });
  }
  function arm() {
    clearTimeout(timer);
    timer = setTimeout(() => adapter.stop('Playback timed out waiting for eligible keyboard input.'), 30000);
  }
  const adapter = installReplay(options, GlkOteClass, plan.commands, sessionId, report, {
    update(output) { observer.update?.(output); },
    boundary(position) {
      while (leaf < plan.leaves.length - 1 && position >= plan.leaves[leaf].end) leaf++;
      observer.boundary?.(position);
    },
    beforeCommand(position, request) { arm(); observer.beforeCommand?.(position, request); },
    termination(position) { return plan.endpoint === 'termination' && position === plan.commands.length; }
  });
  return {
    started() { arm(); adapter.started(); },
    stop: adapter.stop,
    receive: adapter.receive,
    dispose() { finished = true; clearTimeout(timer); adapter.dispose(); }
  };
}

module.exports = { planComposition, loadCompositionPlayback, installCompositionPlayback };
