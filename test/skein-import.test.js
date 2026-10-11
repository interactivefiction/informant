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
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { extractSkein, qualifySkein, saveSkeinImport } = require('../skein-import');
const { discoverPlayables } = require('../composition-library');
const { discoverCollections } = require('../collection-library');
const { xml } = require('../skein');

function tree(items) {
  return `<Skein rootNode="root">${items.map(([id, command, children = []]) => `<item nodeId="${id}"><command>${xml(command)}</command><result>${xml('Output: ' + command)}</result><children>${children.map(child => `<child nodeId="${child}"/>`).join('')}</children></item>`).join('')}</Skein>`;
}
const source = tree([['root', '- start -', ['a', 'z']], ['a', 'look', ['b']], ['b', 'take peach', ['c', 'd']],
  ['c', 'north', ['e', 'f']], ['d', 'eat peach'], ['e', 'wait'], ['f', 'south'], ['z', 'inventory']]);
const endpoint = commands => ({ location: 'Room - room', observation: commands.length.toString(16).toUpperCase().padStart(8, '0') });
const qualify = async commands => ({ start: endpoint([]), end: endpoint(commands) });

test('splits at nested forks and reconstructs all original leaf paths without duplicating commands', async () => {
  const extracted = extractSkein(source);
  assert.equal(extracted.segments.length, 6);
  const calls = [];
  const imported = await qualifySkein(extracted, { qualify: async commands => { calls.push(commands); return qualify(commands); } });
  assert.equal(imported.vectors.filter(v => v.entry === 'initial').length, 2);
  assert.equal(imported.compositions.length, 3);
  const byGuid = new Map(imported.vectors.map(v => [v.guid, v]));
  const paths = imported.compositions.map(c => c.members.flatMap(ref => byGuid.get(ref.guid).turns.map(t => t.command)));
  assert.deepEqual(paths, [['look', 'take peach', 'north', 'wait'], ['look', 'take peach', 'north', 'south'], ['look', 'take peach', 'eat peach']]);
  assert.equal(imported.compositions[0].members[0].guid, imported.compositions[2].members[0].guid);
  assert.deepEqual(imported.vectors[1].start, imported.vectors[0].end);
  assert.deepEqual(calls[2], paths[0]);
  assert.equal(imported.vectors[0].turns[1].result, 'Output: take peach');
});

test('linear, empty, entities and invalid graphs', () => {
  const parsed = extractSkein(tree([['root', '- start -', ['a']], ['a', 'say <peach> & hello']]));
  assert.equal(parsed.segments[0].turns[0].command, 'say <peach> & hello');
  for (const items of [ [['root', '- start -']], [['root', '- start -', ['missing']]],
    [['root', '- start -', ['a']], ['a', 'look', ['root']]],
    [['root', '- start -', ['a', 'a']], ['a', 'look']],
    [['root', '- start -', ['a']], ['a', 'look'], ['a', 'wait']],
    [['root', '- start -', ['a']], ['a', 'look'], ['orphan', 'wait']] ]) {
    assert.throws(() => extractSkein(tree(items)));
  }
  assert.throws(() => extractSkein('<!DOCTYPE Skein><Skein/>'));
});

test('qualification failure and cancellation do not produce an import; termination cannot be continued', async () => {
  const extracted = extractSkein(source);
  await assert.rejects(qualifySkein(extracted, { qualify: async () => { throw new Error('No test story'); } }), /No test story/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(qualifySkein(extracted, { qualify, signal: controller.signal }), /abort/i);
  await assert.rejects(qualifySkein(extracted, { qualify: async () => ({ start: endpoint([]), end: { type: 'termination' } }) }), /terminating/);
});

test('persists into separate new suites, preserving existing members and source Skein', async t => {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'skein-import-'));
  t.after(() => fs.rm(project, { recursive: true, force: true }));
  await fs.writeFile(path.join(project, 'Skein.skein'), source);
  const imported = await qualifySkein(extractSkein(source), { qualify });
  const suite = await saveSkeinImport(project, imported, { suiteName: 'Imported suite' });
  assert.equal(suite.members.length, 9);
  const library = await discoverPlayables(project);
  assert.equal(library.playables.length, 9);
  assert.deepEqual(library.vectors.issues, []);
  assert.deepEqual(library.compositions.issues, []);
  const next = await qualifySkein(extractSkein(tree([['root', '- start -', ['a']], ['a', 'look']])), { qualify });
  await saveSkeinImport(project, next, { suiteName: 'Second import' });
  const collections = await discoverCollections(project);
  assert.equal(collections.collections.length, 2);
  assert.equal(collections.collections.find(value => value.guid === suite.guid).members.length, 9);
  assert.equal(collections.collections.find(value => value.name === 'Second import').members.length, 1);
  assert.equal(await fs.readFile(path.join(project, 'Skein.skein'), 'utf8'), source);
  await assert.rejects(saveSkeinImport(project, next, { suiteName: 'Second import' }), /EEXIST/);
  assert.equal((await discoverPlayables(project)).playables.length, 10);
});


test('reimporting the same Skein generates fresh GUID files and suite-scoped names', async t => {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'skein-reimport-'));
  t.after(() => fs.rm(project, { recursive: true, force: true }));
  const guids = new Set();
  for (let run = 0; run < 2; run++) {
    const imported = await qualifySkein(extractSkein(source), { qualify, suiteName: '  Routes  ' });
    assert.deepEqual(imported.vectors.map(v => v.name), [
      'Routes-starter-1', 'Routes-continuation-1', 'Routes-continuation-2',
      'Routes-continuation-3', 'Routes-continuation-4', 'Routes-starter-2'
    ]);
    assert.deepEqual(imported.compositions.map(c => c.name), [
      'Routes-composition-1', 'Routes-composition-2', 'Routes-composition-3'
    ]);
    const suite = await saveSkeinImport(project, imported, { suiteName: 'Routes' });
    for (const value of [...imported.vectors, ...imported.compositions, suite]) {
      assert.match(value.guid, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      assert.ok(!guids.has(value.guid));
      guids.add(value.guid);
    }
  }
  const library = await discoverPlayables(project);
  const collections = await discoverCollections(project);
  assert.equal(library.playables.length, 18);
  assert.equal(collections.collections.length, 2);
  for (const suite of collections.collections) {
    assert.equal(suite.members.length, 9);
    for (const member of suite.members) assert.ok(library.playables.some(p => p.guid === member.guid));
  }
  assert.equal((await fs.readdir(path.join(project, '.informant', 'test-vectors'))).length, 12);
  assert.equal((await fs.readdir(path.join(project, '.informant', 'compositions'))).length, 6);
  assert.equal((await fs.readdir(path.join(project, '.informant', 'collections'))).length, 2);
});


test('a final quit confirmation imports a termination vector and new suite', async t => {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'skein-quit-import-'));
  t.after(() => fs.rm(project, { recursive: true, force: true }));
  const extracted = extractSkein(tree([
    ['root', '- start -', ['a']], ['a', 'look', ['b']], ['b', 'quit', ['c']], ['c', 'y']
  ]));
  const imported = await qualifySkein(extracted, { suiteName: 'Quit', qualify: async commands => {
    assert.deepEqual(commands, ['look', 'quit', 'y']);
    return { start: endpoint([]), end: { type: 'termination' } };
  } });
  const suite = await saveSkeinImport(project, imported, { suiteName: 'Quit' });
  const library = await discoverPlayables(project);
  assert.equal(library.playables.length, 1);
  assert.equal(library.playables[0].name, 'Quit-starter-1');
  assert.deepEqual(library.playables[0].end, { type: 'termination' });
  assert.equal(suite.members[0].guid, library.playables[0].guid);
  assert.equal((await discoverCollections(project)).collections[0].guid, suite.guid);
});


test('omits only unanswered leaf quits before splitting branches', () => {
  const extracted = extractSkein(tree([
    ['root', '- start -', ['a']], ['a', 'look', ['b', 'c']],
    ['b', 'quit'], ['c', 'north', ['d']], ['d', ' Q ']
  ]));
  assert.equal(extracted.omittedQuits, 2);
  assert.equal(extracted.segments.length, 1);
  assert.deepEqual(extracted.segments[0].turns.map(t => t.command), ['look', 'north']);
  assert.deepEqual(extracted.paths, [[0]]);
  const confirmed = extractSkein(tree([
    ['root', '- start -', ['a']], ['a', 'quit', ['b']], ['b', 'y']
  ]));
  assert.equal(confirmed.omittedQuits, 0);
  assert.deepEqual(confirmed.segments[0].turns.map(t => t.command), ['quit', 'y']);
  assert.throws(() => extractSkein(tree([
    ['root', '- start -', ['a']], ['a', 'quit']
  ])), /no recorded commands to import/);
});

test('typed keys survive import, qualification, vector XML, and composition planning', async () => {
  const { Skein } = require('../skein');
  const { serializeVector } = require('../iskein');
  const { parseVector } = require('../test-vector-library');
  const { planComposition } = require('../composition-playback');
  const model = new Skein();
  for (const [command, inputType] of [[' ', 'char'], ['look'], ['q', 'char']]) {
    const item = { ...model.item(command), ...(inputType ? { inputType } : {}) };
    model.items.at(-1).childId = item.id; model.items.push(item);
  }
  const extracted = extractSkein(model.serialize());
  assert.equal(extracted.omittedQuits, 0, 'a q key is not an unanswered quit command');
  const calls = [];
  const imported = await qualifySkein(extracted, { qualify: async commands => { calls.push(commands); return qualify(commands); } });
  const vector = parseVector(serializeVector(imported.vectors[0]));
  assert.deepEqual(vector.turns, extracted.segments[0].turns);
  const plan = planComposition({ ...vector, type: 'iskein' }, () => vector);
  assert.deepEqual(plan.commands, [{ type: 'char', value: ' ' }, 'look', { type: 'char', value: 'q' }]);
  assert.deepEqual(calls, [plan.commands]);
  assert.throws(() => parseVector(serializeVector(vector).replace('input="char"', 'input="mouse"')), /attributes/);
  assert.throws(() => extractSkein(model.serialize().replace('input="char"', 'input="mouse"')), /input type/);
});
