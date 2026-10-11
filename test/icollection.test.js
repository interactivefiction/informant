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
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createCollection, parseCollection, serializeCollection } = require('../icollection');
const { discoverCollections, saveNewCollection, setCollectionBehavior, addCollectionMember } = require('../collection-library');
const { discoverPlayables } = require('../composition-library');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'informant-collection-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('v2 round trip is reference-only, permits empty sets, and preserves identity across edits', () => {
  const empty = createCollection('Suite <&> 雪');
  assert.deepEqual(parseCollection(serializeCollection(empty)), empty);
  const members = ['iskein', 'icomposition'].map(type => ({ type, guid: randomUUID(), name: 'Never copied', entry: 'initial' }));
  const suite = createCollection('Mixed', { members });
  assert.deepEqual(suite.members, members.map(({ type, guid }) => ({ type, guid, behavior: 'stepwise' })));
  const source = serializeCollection(suite);
  assert.doesNotMatch(source, /Never copied|entry|endpoint|transcript|inherit/);
  assert.deepEqual(parseCollection(source), suite);
  const edited = parseCollection(serializeCollection({ ...suite, name: 'Renamed', members: [] }));
  assert.equal(edited.guid, suite.guid);
  const copy = createCollection('Independent', suite);
  assert.notEqual(copy.guid, suite.guid);
  copy.members[0].guid = randomUUID();
  assert.notEqual(copy.members[0].guid, suite.members[0].guid);
  const duplicate = { ...suite, members: [...suite.members, { ...suite.members[0], guid: suite.members[0].guid.toUpperCase() }] };
  assert.equal(parseCollection(serializeCollection(duplicate)).members.length, 2);
});

test('strict XML rejects malformed, unsupported, executable and inherited fields', () => {
  const source = serializeCollection(createCollection('Suite', { members: [{ type: 'iskein', guid: randomUUID() }] }));
  for (const invalid of [source.replace('version="2"', 'version="3"'), source.replace('<members>', '<members>text'),
    source.replace(/<members>[\s\S]*<\/members>/, ''), source.replace('type="iskein"', 'type="icollection"'),
    source.replace(/guid="[^"]+"/, 'guid="bad"'), source.replace('<name>Suite</name>', '<name> </name>'),
    source.replace('</identity>', '<inherit>parent</inherit></identity>'), source.replace('</icollection>', '<entry>initial</entry></icollection>'),
    source.replace('type="iskein"', 'name="copied" type="iskein"'), source.replace('<icollection', '<!DOCTYPE x><icollection'),
    source.replace('Suite', '&unknown;'), source + '<extra/>']) assert.throws(() => parseCollection(invalid));
  assert.throws(() => createCollection(''));
  assert.throws(() => serializeCollection({ guid: randomUUID(), name: 'Missing members' }));
});

test('discovery and creation copy references once, keep missing members, and never create Playables', async t => {
  const root = await fixture(t);
  assert.equal((await discoverCollections(root)).status, 'missing');
  const empty = await saveNewCollection(root, 'Source');
  const members = ['iskein', 'icomposition'].map(type => ({ type, guid: randomUUID(), behavior: 'stepwise' }));
  await fs.writeFile(empty.file, serializeCollection({ ...empty, members }));
  const before = await fs.readFile(empty.file, 'utf8');
  const inherited = await saveNewCollection(root, 'Source', empty.guid);
  assert.notEqual(inherited.guid, empty.guid); // Duplicate names are allowed.
  assert.deepEqual(inherited.members, members);
  assert.equal(path.basename(inherited.file), inherited.guid + '.icollection');
  assert.equal(await fs.readFile(empty.file, 'utf8'), before);
  await fs.writeFile(empty.file, serializeCollection({ ...empty, members: [] }));
  assert.deepEqual(parseCollection(await fs.readFile(inherited.file, 'utf8')).members, members);
  assert.deepEqual((await discoverPlayables(root)).playables, []);
  assert.deepEqual(await fs.readdir(path.join(root, '.informant')), ['collections']);
  assert.equal((await discoverCollections(root)).collections.length, 2);
  await assert.rejects(saveNewCollection(root, 'Bad source', randomUUID()), /no longer available/);
  assert.equal((await discoverCollections(root)).collections.length, 2);
});

test('discovery reports invalid UTF-8, filenames, XML, directories and escaping symlinks', async t => {
  const root = await fixture(t), outside = await fixture(t);
  const good = await saveNewCollection(root, 'Good');
  const directory = path.dirname(good.file);
  await fs.writeFile(path.join(directory, 'wrong.icollection'), serializeCollection(good));
  await fs.writeFile(path.join(directory, 'bytes.icollection'), Buffer.from([0xff]));
  await fs.writeFile(path.join(directory, 'broken.icollection'), '<broken>');
  await fs.mkdir(path.join(directory, 'directory.icollection'));
  const foreign = await saveNewCollection(outside, 'Outside');
  await fs.symlink(foreign.file, path.join(directory, foreign.guid + '.icollection'));
  const result = await discoverCollections(root);
  assert.equal(result.collections.length, 1);
  assert.equal(result.issues.length, 5);
  assert.ok(result.issues.some(issue => /outside the project/.test(issue.message)));
  const linked = await fixture(t);
  await fs.symlink(outside, path.join(linked, '.informant'));
  await assert.rejects(saveNewCollection(linked, 'Blocked'), /real directories/);
});

test('V1 and omitted behavior default to stepwise; aliases normalize and unknown values fail', () => {
  const suite = createCollection('Legacy', { members: [{ type: 'iskein', guid: randomUUID() }] });
  const source = serializeCollection(suite).replace(' behavior="stepwise"', '');
  assert.equal(parseCollection(source).members[0].behavior, 'stepwise');
  assert.equal(parseCollection(source.replace('version="2"', 'version="1"')).members[0].behavior, 'stepwise');
  for (const [alias, expected] of [['STEP', 'stepwise'], ['END', 'endpoint'], ['Endpoint', 'endpoint'], ['NONE', 'none']]) {
    assert.equal(parseCollection(source.replace('/>', ` behavior="${alias}"/>`)).members[0].behavior, expected);
  }
  for (const bad of ['unknown', 'constructor', 'toString', '']) assert.throws(() => parseCollection(source.replace('/>', ` behavior="${bad}"/>`)));
});

test('bulk behaviors stay suite-local, survive copying and duplicate additions, and preserve missing references', async t => {
  const root = await fixture(t), suite = await saveNewCollection(root, 'Source');
  const members = ['iskein', 'icomposition'].map(type => ({ type, guid: randomUUID() }));
  for (const member of members) await addCollectionMember(root, suite.guid, member);
  await setCollectionBehavior(root, suite.guid, members, 'END');
  const copy = await saveNewCollection(root, 'Copy', suite.guid);
  await setCollectionBehavior(root, suite.guid, [members[0]], 'NONE');
  await addCollectionMember(root, suite.guid, members[0]);
  const current = parseCollection(await fs.readFile(suite.file, 'utf8'));
  assert.deepEqual(current.members.map(value => value.behavior), ['none', 'endpoint']);
  assert.deepEqual(copy.members.map(value => value.behavior), ['endpoint', 'endpoint']);
  assert.equal(current.guid, suite.guid);
  await assert.rejects(setCollectionBehavior(root, suite.guid, [{ type: 'iskein', guid: randomUUID() }], 'none'));
  assert.deepEqual(parseCollection(await fs.readFile(suite.file, 'utf8')), current);
});
