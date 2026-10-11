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
const { readArtifactXml } = require('./artifact-xml');
const { reference } = require('./icomposition');

const memberKey = value => `${value.type}:${value.guid.toLowerCase()}`;
function normalizeBehavior(value = 'stepwise') {
  const behavior = typeof value === 'string' ? value.toLowerCase() : '';
  const normalized = { step: 'stepwise', stepwise: 'stepwise', end: 'endpoint', endpoint: 'endpoint', none: 'none' }[behavior];
  if (typeof normalized !== 'string') throw new Error('Invalid test verification behavior.');
  return normalized;
}
function collectionMembers(members) {
  if (!Array.isArray(members)) throw new Error('Collection members are required.');
  // Membership is a set; retain a single reference in stable order for deterministic XML.
  return [...new Map(members.map(member => ({ ...reference(member), behavior: normalizeBehavior(member.behavior) })).map(member => [memberKey(member), member])).values()];
}
function serializeCollection(value) {
  reference({ type: 'iskein', guid: value.guid });
  if (typeof value.name !== 'string' || !value.name.trim()) throw new Error('Collection name is required.');
  const members = collectionMembers(value.members);
  return ['<?xml version="1.0" encoding="UTF-8"?>', '<icollection version="2">',
    '  <identity>', `    <guid>${xml(value.guid)}</guid>`, `    <name>${xml(value.name)}</name>`, '  </identity>',
    '  <members>', ...members.map(member => `    <playable type="${member.type}" guid="${member.guid}" behavior="${member.behavior}"/>`),
    '  </members>', '</icollection>', ''].join('\n');
}
function parseCollection(source) {
  const { root, invalid, attributes, children, text } = readArtifactXml(source, 'ICollection');
  if (root.name !== 'icollection') invalid('expected icollection root');
  if (!['1', '2'].includes(root.attrs.version)) throw new Error(`Unsupported ICollection version: ${root.attrs.version}`);
  attributes(root, { version: root.attrs.version });
  const [identity, members] = children(root, ['identity', 'members']);
  attributes(identity); attributes(members);
  const [guid, name] = children(identity, ['guid', 'name']);
  if (members.text.trim()) invalid('unexpected members text');
  const value = { guid: text(guid), name: text(name), members: collectionMembers(members.children.map(node => {
    if (node.name !== 'playable') invalid('expected playable member');
    attributes(node, { type: node.attrs.type, guid: node.attrs.guid,
      ...(root.attrs.version === '2' && node.attrs.behavior !== undefined ? { behavior: node.attrs.behavior } : {}) }); children(node, []);
    return { ...reference(node.attrs), behavior: root.attrs.version === '1' ? 'stepwise' : normalizeBehavior(node.attrs.behavior) };
  })) };
  serializeCollection(value);
  return value;
}
function createCollection(name, source) {
  const value = { guid: randomUUID(), name: typeof name === 'string' ? name.trim() : name,
    members: collectionMembers(source ? source.members : []) };
  serializeCollection(value);
  return value;
}
module.exports = { serializeCollection, parseCollection, createCollection, collectionMembers, memberKey, normalizeBehavior };
