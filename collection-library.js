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
const { discoverPlayables } = require('./composition-library');
const { parseCollection, serializeCollection, createCollection, memberKey, normalizeBehavior, collectionMembers } = require('./icollection');

function contained(root, file) {
  const relative = path.relative(root, file);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Collection library path is outside the project.');
}
async function discoverCollections(project) {
  const collections = [], issues = [], directory = path.join(project, '.informant', 'collections');
  try {
    const root = await fs.realpath(project);
    contained(root, await fs.realpath(directory));
    for (const name of (await fs.readdir(directory)).sort()) {
      if (!name.endsWith('.icollection')) continue;
      try {
        const file = path.join(directory, name);
        contained(root, await fs.realpath(file));
        if (!(await fs.stat(file)).isFile()) throw new Error('Not a regular file.');
        const collection = parseCollection(new TextDecoder('utf-8', { fatal: true }).decode(await fs.readFile(file)));
        if (name.toLowerCase() !== `${collection.guid.toLowerCase()}.icollection`) throw new Error('Filename does not match collection GUID.');
        if (collections.some(item => item.guid.toLowerCase() === collection.guid.toLowerCase())) throw new Error('Duplicate collection GUID.');
        collections.push({ ...collection, file });
      } catch (error) { issues.push({ file: name, message: error.message }); }
    }
  } catch (error) {
    if (error.code === 'ENOENT') return { status: 'missing', collections, issues };
    issues.push({ file: '.informant/collections', message: error.message });
    return { status: 'unreadable', collections, issues };
  }
  return { status: 'available', collections, issues };
}
async function saveNewCollection(project, name, sourceGuid = null) {
  // Resolve the source on the host at creation time, never accept webview members.
  let sourceCollection;
  if (sourceGuid === 'all') {
    // Snapshot accepted identities once; later library additions do not change the suite.
    const library = await discoverPlayables(project);
    sourceCollection = { members: library.playables };
  } else if (sourceGuid) {
    const library = await discoverCollections(project);
    sourceCollection = library.collections.find(item => item.guid.toLowerCase() === sourceGuid.toLowerCase());
    if (!sourceCollection) throw new Error('The source Test Suite is no longer available.');
  }
  const value = createCollection(name, sourceCollection);
  const source = serializeCollection(value);
  const root = await fs.realpath(project);
  let directory = root;
  for (const component of ['.informant', 'collections']) {
    directory = path.join(directory, component);
    await fs.mkdir(directory).catch(error => { if (error.code !== 'EEXIST') throw error; });
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Collection state directories must be real directories.');
    contained(root, await fs.realpath(directory));
  }
  const file = path.join(directory, `${value.guid}.icollection`);
  const temporary = path.join(directory, `.${value.guid}.${randomUUID()}.tmp`);
  let handle, created = false;
  try {
    handle = await fs.open(temporary, 'wx'); created = true;
    await handle.writeFile(source, 'utf8'); await handle.sync(); await handle.close(); handle = null;
    await fs.link(temporary, file); // Publish atomically without overwriting an existing identity.
  } finally {
    await handle?.close().catch(() => {});
    if (created) await fs.unlink(temporary).catch(() => {});
  }
  return { ...value, file };
}
async function addCollectionMember(project, guid, member) {
  const library = await discoverCollections(project);
  const collection = library.collections.find(value => value.guid.toLowerCase() === guid.toLowerCase());
  if (!collection) throw new Error('The active Test Suite is no longer available.');
  if (collection.members.some(value => memberKey(value) === memberKey(member))) return;
  await writeCollection(collection, [...collection.members, member]);
}
async function setCollectionBehavior(project, guid, references, behavior) {
  const normalized = normalizeBehavior(behavior);
  const keys = new Set(collectionMembers(references).map(memberKey));
  if (!keys.size) throw new Error('Select at least one test.');
  const library = await discoverCollections(project);
  const collection = library.collections.find(value => value.guid === guid);
  if (!collection) throw new Error('The active Test Suite is no longer available.');
  if ([...keys].some(key => !collection.members.some(member => memberKey(member) === key))) throw new Error('A selected test is no longer in this Test Suite.');
  await writeCollection(collection, collection.members.map(member => keys.has(memberKey(member)) ? { ...member, behavior: normalized } : member));
}
async function writeCollection(collection, members) {
  const source = serializeCollection({ ...collection, members });
  const temporary = path.join(path.dirname(collection.file), `.${collection.guid}.${randomUUID()}.tmp`);
  let handle, created = false;
  try {
    handle = await fs.open(temporary, 'wx'); created = true;
    await handle.writeFile(source, 'utf8'); await handle.sync(); await handle.close(); handle = null;
    await fs.rename(temporary, collection.file);
  } finally {
    await handle?.close().catch(() => {});
    if (created) await fs.unlink(temporary).catch(() => {});
  }
}
module.exports = { discoverCollections, saveNewCollection, addCollectionMember, setCollectionBehavior };
