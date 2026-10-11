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

const { randomUUID } = require('node:crypto');
const { xml } = require('./skein');
const { copyEndpoint } = require('./iskein');
const { readArtifactXml } = require('./artifact-xml');
const guidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function reference(value) {
  if (!value || !['iskein', 'icomposition'].includes(value.type) || !guidPattern.test(value.guid)) throw new Error('Invalid Playable type or GUID.');
  return { type: value.type, guid: value.guid };
}
function key(value) { return `${value.type}:${value.guid.toLowerCase()}`; }
function resolver(playables) {
  const index = new Map(playables.map(playable => [key(playable), playable]));
  return ref => index.get(key(ref));
}
function serializeComposition(value) {
  if (!guidPattern.test(value.guid)) throw new Error('Invalid composition GUID.');
  if (typeof value.name !== 'string' || !value.name.trim()) throw new Error('Composition name is required.');
  if (value.entry !== 'initial') throw new Error('Composition entry must be initial.');
  const start = copyEndpoint(value.start), end = copyEndpoint(value.end, true);
  if (!Array.isArray(value.members) || !value.members.length) throw new Error('Composition must have at least one member.');
  const members = value.members.map(reference);
  return ['<?xml version="1.0" encoding="UTF-8"?>', '<icomposition version="1">',
    '  <identity>', `    <guid>${xml(value.guid)}</guid>`, `    <name>${xml(value.name)}</name>`, '  </identity>',
    '  <entry>initial</entry>', '  <endpoints>',
    ...Object.entries({ start, end }).flatMap(([label, endpoint]) => endpoint.type === 'termination' ? ['    <end type="termination"/>'] : [
      `    <${label}${label === 'end' ? ' type="location"' : ''}>`, `      <location>${xml(endpoint.location)}</location>`,
      `      <observation algorithm="crc32">${endpoint.observation}</observation>`, `    </${label}>`]),
    '  </endpoints>', '  <members>', ...members.map(member => `    <playable type="${member.type}" guid="${member.guid}"/>`),
    '  </members>', '</icomposition>', ''].join('\n');
}
function parseComposition(source) {
  const { root, invalid, attributes, children, text } = readArtifactXml(source, 'IComposition');
  if (root.name !== 'icomposition') invalid('expected icomposition root');
  if (root.attrs.version !== '1') throw new Error(`Unsupported IComposition version: ${root.attrs.version}`);
  attributes(root, { version: '1' });
  const [identity, entry, endpoints, members] = children(root, ['identity', 'entry', 'endpoints', 'members']);
  for (const node of [identity, endpoints, members]) attributes(node);
  const [guid, name] = children(identity, ['guid', 'name']);
  const [start, end] = children(endpoints, ['start', 'end']);
  function endpoint(node, isEnd = false) {
    if (isEnd && node.attrs.type === 'termination') {
      attributes(node, { type: 'termination' }); children(node, []); return { type: 'termination' };
    }
    attributes(node, isEnd ? { type: 'location' } : {});
    const [location, observation] = children(node, ['location', 'observation']);
    return { location: text(location), observation: text(observation, { algorithm: 'crc32' }) };
  }
  if (members.text.trim()) invalid('unexpected members text');
  const value = { guid: text(guid), name: text(name), entry: text(entry), start: endpoint(start), end: endpoint(end, true),
    members: members.children.map(node => {
      if (node.name !== 'playable') invalid('expected playable member');
      attributes(node, { type: node.attrs.type, guid: node.attrs.guid }); children(node, []);
      return reference(node.attrs);
    }) };
  serializeComposition(value);
  return value;
}
function createWorkingComposition(committed) {
  return { name: committed?.name || '', members: committed ? committed.members.map(reference) : [],
    committed: committed ? parseComposition(serializeComposition(committed)) : null };
}
function deriveEnvelope(working, resolve) {
  const first = working.members[0], last = working.members.at(-1);
  const start = first && resolve(first)?.start, end = last && resolve(last)?.end;
  return { start: start ? copyEndpoint(start) : null, end: end ? copyEndpoint(end, true) : null };
}
// Validate references transitively without flattening or copying child artifacts.
function validateGraph(working, resolve, structural = true) {
  const active = new Set(working.committed ? [`icomposition:${working.committed.guid.toLowerCase()}`] : []);
  const checked = new Set();
  function visit(members) {
    if (structural && !members.length) throw new Error('Composition must have at least one member.');
    members.forEach((member, index) => {
      reference(member);
      const id = key(member);
      if (index > 0 && key(members[index - 1]) === id) throw new Error('The same Playable cannot appear twice in a row.');
      if (active.has(id)) throw new Error(`Composition cycle through ${member.guid}.`);
      const playable = resolve(member);
      if (!playable) { if (structural) throw new Error(`Missing ${member.type}: ${member.guid}`); return; }
      if (structural) {
        if (index === 0 && playable.entry !== 'initial') throw new Error('The first member must be an initial Playable.');
        copyEndpoint(playable.start); copyEndpoint(playable.end, true);
        if (playable.end.type === 'termination' && index < members.length - 1) throw new Error('A terminating member cannot have a following member.');
      }
      if (member.type === 'icomposition' && !checked.has(id)) {
        active.add(id); visit(playable.members); active.delete(id); checked.add(id);
      }
    });
  }
  visit(working.members);
}
function editMembers(working, action, index, value, resolve) {
  const members = working.members.map(reference);
  if (action === 'add') members.push(reference(value));
  else {
    if (!Number.isInteger(index) || index < 0 || index >= members.length) throw new Error('Select a composition member.');
    if (action === 'remove') members.splice(index, 1);
    else if (action === 'replace') members[index] = reference(value);
    else if (action === 'up' || action === 'down') {
      const next = index + (action === 'up' ? -1 : 1);
      if (next < 0 || next >= members.length) throw new Error('Cannot move member beyond the sequence.');
      [members[index], members[next]] = [members[next], members[index]];
    } else throw new Error('Unknown composition edit.');
  }
  const candidate = { ...working, members };
  validateGraph(candidate, resolve, false);
  if (action === 'add' && working.members.length) {
    const end = deriveEnvelope(working, resolve).end;
    const start = resolve(members.at(-1))?.start;
    if (end && start && compatibility(end, start) === 'Different location') {
      throw new Error('Different location: the Playable must start at the composition’s current END location.');
    }
  }
  return candidate;
}
function sameEndpoint(a, b, end = false) {
  // v1 permits only crc32; the parser rejects all other algorithms.
  return JSON.stringify(copyEndpoint(a, end)) === JSON.stringify(copyEndpoint(b, end));
}
function commitComposition(working, resolve) {
  validateGraph(working, resolve);
  const { start, end } = deriveEnvelope(working, resolve);
  const prior = working.committed;
  const unchanged = prior && sameEndpoint(start, prior.start) && sameEndpoint(end, prior.end, true);
  const value = { guid: unchanged ? prior.guid : randomUUID(), name: working.name, entry: 'initial', start, end, members: working.members.map(reference) };
  serializeComposition(value);
  return value;
}
function compatibility(end, start) {
  if (!end) return 'No current END';
  if (end.type === 'termination') return 'Cannot follow termination';
  if (end.location !== start.location) return 'Different location';
  return end.observation === start.observation ? 'Strong structural candidate' : 'Same location; observation differs';
}
function compositionView(working, playables) {
  const resolve = resolver(playables), envelope = deriveEnvelope(working, resolve);
  let error = '';
  try { validateGraph(working, resolve); } catch (problem) { error = problem.message; }
  return { name: working.name, committed: working.committed, ...envelope, error,
    members: working.members.map(ref => ({ ...ref, playable: resolve(ref) || null })),
    candidates: playables.filter(playable => working.members.length || playable.entry === 'initial' || playable.type === 'icomposition').map(playable => {
      let reason = '';
      try { editMembers(working, 'add', null, playable, resolve); } catch (problem) { reason = problem.message; }
      const guidance = reason || (working.members.length ? compatibility(envelope.end, playable.start) : 'Initial Playable');
      const strength = reason ? null : guidance === 'Strong structural candidate' ? 'strong' : guidance === 'Same location; observation differs' ? 'weak' : null;
      return { ...playable, guidance, strength, reason };
    }) };
}
module.exports = { serializeComposition, parseComposition, reference, resolver, createWorkingComposition, deriveEnvelope,
  editMembers, validateGraph, commitComposition, sameEndpoint, compatibility, compositionView };
