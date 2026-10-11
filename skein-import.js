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

const { replayInput, Skein } = require('./skein');

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { readArtifactXml } = require('./artifact-xml');
const { createVector, serializeVector } = require('./iskein');
const { commitComposition, resolver, serializeComposition } = require('./icomposition');
const { createCollection, serializeCollection } = require('./icollection');

// Inform's root is startup output, never a command. A vector is a maximal
// unbranched run; each leaf retains its ordered references for the second pass.
function extractSkein(source) {
  const { root, invalid } = readArtifactXml(source, 'Inform Skein');
  if (root.name !== 'Skein' || !root.attrs.rootNode) invalid('expected Skein with rootNode');
  const nodes = new Map();
  for (const item of root.children.filter(child => child.name === 'item')) {
    const id = item.attrs.nodeId;
    if (!id || nodes.has(id)) invalid('missing or duplicate node ID');
    function field(name, required = true) {
      const found = item.children.filter(child => child.name === name);
      if (found.length > 1 || (required && !found.length) || found[0]?.children.length) invalid(`invalid ${name} in ${id}`);
      return found[0]?.text || '';
    }
    const children = item.children.filter(child => child.name === 'children');
    if (children.length > 1 || children[0]?.text.trim()) invalid('invalid children');
    const links = (children[0]?.children || []).map(child => {
      if (child.name !== 'child' || !child.attrs.nodeId || child.children.length || child.text.trim()) invalid('invalid child reference');
      return child.attrs.nodeId;
    });
    const command = field('command');
    const inputType = item.children.find(child => child.name === 'command').attrs.input;
    if (inputType !== undefined && inputType !== 'char') invalid('unsupported command input type');
    if (inputType === 'char' && !Skein.validChar(command)) invalid('invalid character key');
    if (/[\r\n]/.test(command)) invalid('multiline command');
    nodes.set(id, { id, command, ...(inputType ? { inputType } : {}), result: field('result'), annotation: field('annotation', false), children: links });
  }
  const start = nodes.get(root.attrs.rootNode);
  if (!start || start.inputType) invalid('missing or invalid root node');
  const seen = new Set(), stack = [start];
  while (stack.length) {
    const node = stack.pop();
    if (seen.has(node.id)) invalid('cycle or shared child');
    seen.add(node.id);
    for (const id of node.children) {
      if (!nodes.has(id)) invalid(`missing child ${id}`);
      stack.push(nodes.get(id));
    }
  }
  if (seen.size !== nodes.size) invalid('unreachable nodes');
  // A leaf quit has no recorded confirmation. It leaves the interpreter at a
  // yes/no prompt where SHOWME cannot qualify an endpoint. Omit that incomplete
  // command from the imported graph only; retain confirmed quit -> y paths.
  const incompleteQuits = new Set([...nodes.values()]
    .filter(node => node !== start && !node.inputType && !node.children.length && /^(?:quit|q)$/i.test(node.command.trim()))
    .map(node => node.id));
  for (const node of nodes.values()) node.children = node.children.filter(id => !incompleteQuits.has(id));
  const segments = [], paths = [];
  const pending = start.children.map(id => ({ id, parent: null, chain: [] })).reverse();
  while (pending.length) {
    const { id, parent, chain } = pending.pop();
    let node = nodes.get(id);
    const turns = [];
    while (true) {
      turns.push({ command: node.command, result: node.result, ...(node.inputType ? { inputType: node.inputType } : {}) });
      if (node.children.length !== 1) break;
      node = nodes.get(node.children[0]);
    }
    const index = segments.length;
    segments.push({ parent, turns, label: node.annotation.trim() || turns[0].command || 'Empty command' });
    const next = [...chain, index];
    if (!node.children.length) paths.push(next);
    for (const child of [...node.children].reverse()) pending.push({ id: child, parent: index, chain: next });
  }
  if (!segments.length) throw new Error('Skein has no recorded commands to import after omitting any unanswered trailing quit.');
  return { segments, paths, omittedQuits: incompleteQuits.size };
}

async function qualifySkein(extracted, { qualify, suiteName = 'Imported', signal, progress = async () => {} }) {
  const vectors = [], prefixes = [];
  const counts = { starter: 0, continuation: 0 };
  for (const [index, segment] of extracted.segments.entries()) {
    signal?.throwIfAborted();
    await progress(index + 1, extracted.segments.length);
    const parent = segment.parent === null ? null : vectors[segment.parent];
    if (parent?.end.type === 'termination') throw new Error('Skein branches after a terminating command.');
    const commands = [...(segment.parent === null ? [] : prefixes[segment.parent]), ...segment.turns.map(replayInput)];
    const kind = parent ? 'continuation' : 'starter';
    const name = `${suiteName.trim()}-${kind}-${++counts[kind]}`;
    let endpoints;
    try { endpoints = await qualify(commands, signal); }
    catch (error) { throw new Error(`Could not qualify ${name}: ${error.message}`, { cause: error }); }
    signal?.throwIfAborted();
    vectors.push(createVector({ entry: parent ? 'continuation' : 'initial',
      name,
      start: parent ? parent.end : endpoints.start, end: endpoints.end, turns: segment.turns }));
    prefixes.push(commands);
  }
  const resolve = resolver(vectors.map(vector => ({ ...vector, type: 'iskein' })));
  const compositions = extracted.paths.filter(indices => indices.length > 1).map((indices, index) => commitComposition({
    name: `${suiteName.trim()}-composition-${index + 1}`,
    members: indices.map(i => ({ type: 'iskein', guid: vectors[i].guid }))
  }, resolve));
  return { vectors, compositions };
}

// Publish artifacts first, then one complete suite update. On failure, remove
// only files created by this import; existing vectors and suite remain intact.
async function saveSkeinImport(project, imported, { suiteName, signal }) {
  signal?.throwIfAborted();
  const suite = createCollection(suiteName);
  const members = [...imported.vectors.map(value => ({ type: 'iskein', guid: value.guid })),
    ...imported.compositions.map(value => ({ type: 'icomposition', guid: value.guid }))];
  const suiteSource = serializeCollection({ ...suite, members: [...suite.members, ...members] });
  const root = await fs.realpath(project);
  async function directory(name) {
    let current = root;
    for (const part of ['.informant', name]) {
      current = path.join(current, part);
      await fs.mkdir(current).catch(error => { if (error.code !== 'EEXIST') throw error; });
      const stat = await fs.lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Import state directories must be real directories.');
    }
    return current;
  }
  const created = [];
  let temporary;
  try {
    for (const [name, extension, values, serialize] of [
      ['test-vectors', 'iskein', imported.vectors, serializeVector],
      ['compositions', 'icomposition', imported.compositions, serializeComposition]
    ]) {
      const dir = await directory(name);
      for (const value of values) {
        signal?.throwIfAborted();
        const file = path.join(dir, `${value.guid}.${extension}`);
        const handle = await fs.open(file, 'wx');
        created.push(file);
        try { await handle.writeFile(serialize(value), 'utf8'); await handle.sync(); } finally { await handle.close(); }
      }
    }
    const dir = await directory('collections');
    const file = path.join(dir, `${suite.guid}.icollection`);
    temporary = path.join(dir, `.${randomUUID()}.tmp`);
    await fs.writeFile(temporary, suiteSource, { flag: 'wx' });
    signal?.throwIfAborted();
    await fs.link(temporary, file);
    return { ...suite, members: [...suite.members, ...members], file };
  } catch (error) {
    const failures = [];
    for (const file of created.reverse()) await fs.unlink(file).catch(problem => failures.push(problem.message));
    if (failures.length) error.message += `; cleanup failed: ${failures.join('; ')}`;
    throw error;
  } finally {
    if (temporary) await fs.unlink(temporary).catch(() => {});
  }
}

module.exports = { extractSkein, qualifySkein, saveSkeinImport };
