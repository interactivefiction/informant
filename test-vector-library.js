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

const fs = require('node:fs/promises');
const path = require('node:path');
const { TextDecoder } = require('node:util');
const { readArtifactXml } = require('./artifact-xml');
const { serializeVector } = require('./iskein');

// A small, closed XML reader for the v4 vocabulary. No DTD, external entities,
// namespaces other than xml:space, or unknown structure are accepted.
function parseVector(source, working = false) {
  const { root, invalid, attributes, children, text } = readArtifactXml(source, 'ISkein');
  if (root.name !== (working ? 'working-iskein' : 'iskein')) invalid('expected iskein root');
  if (root.attrs.version === '3') throw new Error('Unsupported ISkein version: 3. v3 has no entry semantics; regenerate through the original creation workflow or use an explicit migration decision.');
  if (root.attrs.version !== undefined && root.attrs.version !== '4') throw new Error(`Unsupported ISkein version: ${root.attrs.version}`);
  attributes(root, { version: '4' });
  const [identity, entry, endpoints, provenance, transcript] = children(root, ['identity', 'entry', 'endpoints', 'provenance', 'transcript']);
  for (const node of [identity, endpoints, provenance, transcript]) attributes(node);
  const [guid, name] = children(identity, ['guid', 'name']);
  const [start, end] = children(endpoints, working && !endpoints.children.some(node => node.name === 'end') ? ['start'] : ['start', 'end']);
  function endpoint(node, isEnd = false) {
    if (isEnd && node.attrs.type === 'termination') {
      attributes(node, { type: 'termination' }); children(node, []);
      return { type: 'termination' };
    }
    attributes(node, isEnd ? { type: 'location' } : {});
    const [location, observation] = children(node, ['location', 'observation']);
    return { location: text(location), observation: text(observation, { algorithm: 'crc32' }) };
  }
  const [generator, sourceFormat] = children(provenance, ['generator', 'source-format']);
  text(generator); text(sourceFormat);
  if (transcript.text.trim()) invalid('unexpected transcript text');
  const turns = transcript.children.map((turn, index) => {
    if (turn.name !== 'turn') invalid('expected transcript turn');
    attributes(turn, { sequence: String(index + 1) });
    const [command, result] = children(turn, ['command', 'result']);
    return { command: text(command, command.attrs.input === 'char' ? { input: 'char' } : {}),
      result: text(result, { 'xml:space': 'preserve' }), ...(command.attrs.input === 'char' ? { inputType: 'char' } : {}) };
  });
  const vector = { entry: text(entry), guid: text(guid), name: text(name), start: endpoint(start), end: end ? endpoint(end, true) : undefined, turns };
  serializeVector(vector, working); // Reuse the existing v4 value validation without writing.
  return vector;
}

async function discoverTestVectors(project) {
  const vectors = [], issues = [];
  const directory = path.join(project, '.informant', 'test-vectors');
  try {
    // Resolve the directory and every candidate to keep symlinks inside the bound project.
    const root = await fs.realpath(project);
    const contained = file => {
      const relative = path.relative(root, file);
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Library path is outside the project.');
    };
    contained(await fs.realpath(directory));
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => compare(a.name, b.name))) {
      if (!entry.name.endsWith('.iskein')) continue;
      try {
        const file = path.join(directory, entry.name);
        contained(await fs.realpath(file));
        if (!(await fs.stat(file)).isFile()) throw new Error('Not a regular file.');
        const vector = parseVector(new TextDecoder('utf-8', { fatal: true }).decode(await fs.readFile(file)));
        if (entry.name.toLowerCase() !== `${vector.guid.toLowerCase()}.iskein`) throw new Error('Filename does not match the vector GUID.');
        if (vectors.some(item => item.guid.toLowerCase() === vector.guid.toLowerCase())) throw new Error('Duplicate vector GUID.');
        vectors.push({ ...vector, file, turnCount: vector.turns.length });
      } catch (error) { issues.push({ file: entry.name, message: error.message }); }
    }
  } catch (error) {
    if (error.code === 'ENOENT') return { status: 'missing', vectors, issues };
    issues.push({ file: '.informant/test-vectors', message: error.message });
    return { status: 'unreadable', vectors, issues };
  }
  vectors.sort((a, b) => compare(a.name, b.name) || compare(a.guid, b.guid) || compare(a.file, b.file));
  return { status: 'available', vectors, issues };
}

// Code-point ordering is independent of the host locale and filesystem order.
function compare(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

module.exports = { parseVector, discoverTestVectors };
