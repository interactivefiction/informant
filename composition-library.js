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
const { randomUUID } = require('node:crypto');
const { TextDecoder } = require('node:util');
const { discoverTestVectors } = require('./test-vector-library');
const { parseComposition, serializeComposition, commitComposition, resolver } = require('./icomposition');

function contained(root, file) {
  const relative = path.relative(root, file);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Composition library path is outside the project.');
}
async function discoverCompositions(project) {
  const compositions = [], issues = [], directory = path.join(project, '.informant', 'compositions');
  try {
    const root = await fs.realpath(project);
    contained(root, await fs.realpath(directory));
    for (const name of (await fs.readdir(directory)).sort()) {
      if (!name.endsWith('.icomposition')) continue;
      try {
        const file = path.join(directory, name);
        contained(root, await fs.realpath(file));
        if (!(await fs.stat(file)).isFile()) throw new Error('Not a regular file.');
        const composition = parseComposition(new TextDecoder('utf-8', { fatal: true }).decode(await fs.readFile(file)));
        if (name.toLowerCase() !== `${composition.guid.toLowerCase()}.icomposition`) throw new Error('Filename does not match composition GUID.');
        if (compositions.some(item => item.guid.toLowerCase() === composition.guid.toLowerCase())) throw new Error('Duplicate composition GUID.');
        compositions.push({ ...composition, file });
      } catch (error) { issues.push({ file: name, message: error.message }); }
    }
  } catch (error) {
    if (error.code === 'ENOENT') return { status: 'missing', compositions, issues };
    issues.push({ file: '.informant/compositions', message: error.message });
    return { status: 'unreadable', compositions, issues };
  }
  return { status: 'available', compositions, issues };
}
function playablesFrom(vectors, compositions) {
  return [...vectors.map(vector => ({ ...vector, type: 'iskein' })), ...compositions.map(composition => ({ ...composition, type: 'icomposition' }))];
}
async function discoverPlayables(project) {
  const [vectors, compositions] = await Promise.all([discoverTestVectors(project), discoverCompositions(project)]);
  return { vectors, compositions, playables: playablesFrom(vectors.vectors, compositions.compositions) };
}
async function saveComposition(project, working) {
  // Refresh all references at commit; never trust a webview's resolved objects.
  const library = await discoverPlayables(project);
  const value = commitComposition(working, resolver(library.playables));
  const source = serializeComposition(value);
  const root = await fs.realpath(project);
  let directory = root;
  for (const component of ['.informant', 'compositions']) {
    directory = path.join(directory, component);
    await fs.mkdir(directory).catch(error => { if (error.code !== 'EEXIST') throw error; });
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Composition state directories must be real directories.');
    contained(root, await fs.realpath(directory));
  }
  const previous = working.committed && library.compositions.compositions.find(item => item.guid.toLowerCase() === working.committed.guid.toLowerCase());
  if (working.committed && (!previous || serializeComposition(previous) !== serializeComposition(working.committed))) {
    throw new Error('The loaded composition changed or was removed. Load it again before saving.');
  }
  const replacing = previous && previous.guid === value.guid;
  const file = replacing ? previous.file : path.join(directory, `${value.guid}.icomposition`);
  if (replacing && (await fs.lstat(file)).isSymbolicLink()) throw new Error('Cannot replace a symbolic-link composition.');
  const temporary = path.join(directory, `.${value.guid}.${randomUUID()}.tmp`);
  let handle, created = false;
  try {
    handle = await fs.open(temporary, 'wx'); created = true;
    await handle.writeFile(source, 'utf8'); await handle.sync(); await handle.close(); handle = null;
    if (replacing) await fs.rename(temporary, file);
    else await fs.link(temporary, file); // No overwrite for a new identity; keep old parents intact.
  } finally {
    await handle?.close().catch(() => {});
    if (created) await fs.unlink(temporary).catch(() => {});
  }
  return { ...value, file };
}
module.exports = { discoverCompositions, discoverPlayables, playablesFrom, saveComposition };
