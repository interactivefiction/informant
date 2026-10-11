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
const { createVector, serializeVector } = require('../iskein');
const { serializeComposition, parseComposition, createWorkingComposition, deriveEnvelope, editMembers, commitComposition,
  reference, resolver, compositionView, compatibility } = require('../icomposition');
const { discoverCompositions, discoverPlayables, saveComposition } = require('../composition-library');
const endpoint = (location, observation = 'CBF43926') => ({ location, observation });
const vector = (name = 'Vector', start = endpoint('Start'), end = endpoint('End'), entry = 'initial') => ({
  ...createVector({ name, start, end, entry, turns: [{ command: 'look', result: 'Room' }] }), type: 'iskein' });
const working = members => ({ ...createWorkingComposition(), name: 'Composition <&> 雪', members: members.map(reference) });
const accepted = members => ({ ...commitComposition(working(members), resolver(members)), type: 'icomposition' });

for (const end of [endpoint('終わり & room'), { type: 'termination' }]) test(`v1 XML deterministic reference-only round trip: ${end.type || 'location'}`, () => {
  const a = vector('first'), b = vector('last', endpoint('End'), end), child = accepted([a]);
  const value = commitComposition(working([a, child, b]), resolver([a, child, b]));
  const source = serializeComposition(value);
  assert.equal(serializeComposition(parseComposition(source)), source);
  assert.deepEqual(parseComposition(source), value);
  assert.deepEqual(parseComposition(source).members, [reference(a), reference(child), reference(b)]);
  assert.match(source, /<icomposition version="1">/);
  assert.match(source, /<name>Composition &lt;&amp;&gt; 雪<\/name>/);
  assert.doesNotMatch(source, /transcript|turn|provenance|first|last|guidance|file=/);
  assert.equal((source.match(/<location>/g) || []).length, end.type ? 1 : 2);
});

test('strict parser rejects unsupported, malformed and presentation-only fields', () => {
  const source = serializeComposition(accepted([vector()]));
  const variants = [source.replace('version="1"', 'version="2"'), source.replace('<entry>initial</entry>', ''),
    source.replace('<entry>initial</entry>', '<entry>continuation</entry>'), source.replace('algorithm="crc32"', 'algorithm="sha256"'),
    source.replace('CBF43926', 'bad'), source.replace('type="iskein"', 'type="skein"'),
    source.replace(/<playable[^>]+\/>/, ''), source.replace('<members>', '<members>text'),
    source.replace('type="iskein"', 'name="copied" type="iskein"'), source.replace('<identity>', '<identity><guid>duplicate</guid>'),
    source.replace('</members>', '<transcript/></members>'), source + '<other/>', source.replace('Composition', '&unknown;'),
    source.replace('<icomposition', '<!DOCTYPE x><icomposition'), source.replace('type="iskein"', 'type="iskein" type="iskein"'),
    source.replace(/guid="[^"]+"/, 'guid="invalid"'), source.replace('type="location"', 'type="termination"')];
  for (const invalid of variants) assert.throws(() => parseComposition(invalid), undefined, invalid);
});

test('working add/remove/replace/reorder derives live boundaries without mutating committed snapshots', () => {
  const a = vector('a'), b = vector('b', a.end, endpoint('C')), c = vector('c', endpoint('D'), { type: 'termination' });
  const resolve = resolver([a, b, c]); let w = working([]);
  assert.deepEqual(deriveEnvelope(w, resolve), { start: null, end: null });
  w = editMembers(w, 'add', null, a, resolve);
  assert.deepEqual(deriveEnvelope(w, resolve), { start: a.start, end: a.end });
  w = editMembers(w, 'add', null, b, resolve);
  assert.deepEqual(deriveEnvelope(w, resolve), { start: a.start, end: b.end });
  const baseline = commitComposition(w, resolve); w = createWorkingComposition(baseline);
  w = editMembers(w, 'up', 1, null, resolve);
  assert.deepEqual(deriveEnvelope(w, resolve), { start: b.start, end: a.end });
  w = editMembers(w, 'down', 0, null, resolve);
  w = editMembers(w, 'replace', 1, c, resolve);
  assert.deepEqual(deriveEnvelope(w, resolve), { start: a.start, end: c.end });
  w = editMembers(w, 'remove', 0, null, resolve);
  assert.deepEqual(deriveEnvelope(w, resolve), { start: c.start, end: c.end });
  assert.deepEqual(w.committed, baseline);
  assert.deepEqual(baseline.members, [reference(a), reference(b)]);
});

test('commit requires nonempty, named, resolvable, initial-first members and final termination', () => {
  const a = vector(), continuation = vector('Continuation', endpoint('Other'), endpoint('Room'), 'continuation');
  const terminal = vector('Quit', endpoint('Room'), { type: 'termination' });
  const resolve = resolver([a, continuation, terminal]);
  assert.throws(() => commitComposition(working([]), resolve), /at least one/);
  assert.throws(() => commitComposition({ ...working([a]), name: '' }, resolve), /name/);
  assert.throws(() => commitComposition(working([continuation, a]), resolve), /first member/);
  assert.throws(() => commitComposition(working([a, terminal, a]), resolve), /terminating/);
  assert.throws(() => commitComposition(working([vector()]), resolve), /Missing/);
  assert.throws(() => commitComposition({ ...working([a]), members: [{ type: 'other', guid: a.guid }] }, resolve), /type or GUID/);
  assert.doesNotThrow(() => commitComposition(working([a, continuation, a]), resolve));
  assert.deepEqual(commitComposition(working([a, terminal]), resolve).end, { type: 'termination' });
});

test('nested compositions preserve boundaries, and broken nested references prevent commit', () => {
  const a = vector(), child = accepted([a]), resolve = resolver([a, child]);
  const parent = commitComposition(working([child, a, child]), resolve);
  assert.deepEqual(parent.members, [reference(child), reference(a), reference(child)]);
  assert.deepEqual(parent.start, child.start); assert.deepEqual(parent.end, child.end);
  assert.throws(() => commitComposition(working([child]), resolver([child])), /Missing iskein/);
});

test('direct and transitive cycles are rejected on add and commit; shared children are allowed', () => {
  const a = vector(), child = accepted([a]), parent = accepted([a]);
  const w = createWorkingComposition(parent);
  const resolve = resolver([a, child, parent]);
  assert.throws(() => editMembers(w, 'add', null, parent, resolve), /cycle/);
  child.members = [reference(parent)];
  assert.throws(() => editMembers(w, 'add', null, child, resolve), /cycle/);
  assert.throws(() => commitComposition({ ...w, members: [reference(child)] }, resolve), /cycle/);
  child.members = [reference(child)];
  assert.throws(() => commitComposition(working([child]), resolve), /cycle/);
  child.members = [reference(a)];
  assert.doesNotThrow(() => commitComposition(working([child, a, child]), resolve));
});

test('rename and internal edits with the same envelope preserve GUID', () => {
  const a = vector('a'), b = vector('b'), c = vector('c');
  const value = accepted([a, b, c]), resolve = resolver([a, b, c]);
  const w = createWorkingComposition(value); w.name = 'Renamed';
  assert.equal(commitComposition(w, resolve).guid, value.guid);
  w.members = [reference(c), reference(a), reference(b)];
  assert.equal(commitComposition(w, resolve).guid, value.guid);
  w.members = [reference(a), reference(c)];
  assert.equal(commitComposition(w, resolve).guid, value.guid);
});
for (const change of ['start', 'end', 'both', 'start CRC', 'end CRC', 'termination']) test(`changed ${change} gets a new GUID`, () => {
  const a = vector(), value = accepted([a]);
  const b = vector('changed');
  if (change === 'start' || change === 'both') b.start.location += ' changed';
  if (change === 'end' || change === 'both') b.end.location += ' changed';
  if (change === 'start CRC') b.start.observation = '00000000';
  if (change === 'end CRC') b.end.observation = '00000000';
  if (change === 'termination') b.end = { type: 'termination' };
  const w = createWorkingComposition(value); w.members = [reference(b)];
  assert.notEqual(commitComposition(w, resolver([a, b])).guid, value.guid);
});

test('termination equals termination; structural guidance never vetoes a mismatching joint', () => {
  const a = vector(), b = vector('other', endpoint('Different'), { type: 'termination' }), value = accepted([b]);
  const w = createWorkingComposition(value); w.name = 'renamed';
  assert.equal(commitComposition(w, resolver([b])).guid, value.guid);
  assert.equal(compatibility(a.end, b.start), 'Different location');
  assert.equal(compatibility(a.end, endpoint(a.end.location, '00000000')), 'Same location; observation differs');
  assert.equal(compatibility(a.end, a.end), 'Strong structural candidate');
  assert.doesNotThrow(() => commitComposition(working([a, b]), resolver([a, b])));
});

async function fixture(t) {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'informant-composition-'));
  t.after(() => fs.rm(project, { recursive: true, force: true }));
  const directory = path.join(project, '.informant', 'test-vectors'); await fs.mkdir(directory, { recursive: true });
  const a = vector('Starter'); await fs.writeFile(path.join(directory, `${a.guid}.iskein`), serializeVector(a));
  return { project, a, directory, compositions: path.join(project, '.informant', 'compositions') };
}
test('atomic save/load, same-GUID update and new-envelope identity leave parents and old artifacts unchanged', async t => {
  const { project, a, compositions } = await fixture(t);
  const first = await saveComposition(project, working([a]));
  assert.equal(path.basename(first.file), `${first.guid}.icomposition`);
  const parent = await saveComposition(project, working([{ ...first, type: 'icomposition' }]));
  const parentBytes = await fs.readFile(parent.file);
  const edit = createWorkingComposition(first); edit.name = 'Rename';
  const renamed = await saveComposition(project, edit);
  assert.equal(renamed.guid, first.guid);
  const terminal = vector('Quit', a.start, { type: 'termination' });
  await fs.writeFile(path.join(project, '.informant', 'test-vectors', `${terminal.guid}.iskein`), serializeVector(terminal));
  const changed = createWorkingComposition(renamed); changed.members = [reference(terminal)];
  const next = await saveComposition(project, changed);
  assert.notEqual(next.guid, first.guid);
  assert.equal(parseComposition(await fs.readFile(first.file, 'utf8')).name, 'Rename');
  assert.deepEqual(await fs.readFile(parent.file), parentBytes);
  assert.equal((await discoverCompositions(project)).compositions.length, 3);
  assert.equal((await discoverPlayables(project)).playables.length, 5);
  assert.ok((await fs.readdir(compositions)).every(name => name.endsWith('.icomposition')));
});

test('missing references remain readable with frozen snapshots and explicit identities, never fabricated details', async t => {
  const { project, a, directory } = await fixture(t);
  const value = await saveComposition(project, working([a]));
  await fs.unlink(path.join(directory, `${a.guid}.iskein`));
  const library = await discoverPlayables(project), loaded = library.compositions.compositions[0];
  assert.deepEqual(loaded.start, value.start); assert.deepEqual(loaded.end, value.end);
  const view = compositionView(createWorkingComposition(loaded), library.playables);
  assert.equal(view.members[0].playable, null); assert.equal(view.members[0].guid, a.guid);
  assert.equal(view.start, null); assert.equal(view.end, null); assert.match(view.error, /Missing iskein/);
  await assert.rejects(saveComposition(project, createWorkingComposition(loaded)), /Missing/);
  assert.equal((await discoverCompositions(project)).compositions.length, 1);
});

test('discovery isolates malformed XML, invalid UTF-8, mismatched filenames and escaping symlinks', async t => {
  const { project, a, compositions } = await fixture(t);
  const saved = await saveComposition(project, working([a]));
  await fs.writeFile(path.join(compositions, 'bad.icomposition'), '<icomposition/>');
  await fs.writeFile(path.join(compositions, 'utf8.icomposition'), Buffer.from([0xff]));
  await fs.writeFile(path.join(compositions, `${randomUUID()}.icomposition`), serializeComposition(saved));
  await fs.symlink('/etc/passwd', path.join(compositions, 'escape.icomposition'));
  const result = await discoverCompositions(project);
  assert.equal(result.compositions.length, 1); assert.equal(result.issues.length, 4);
  assert.ok(result.issues.some(issue => /outside/.test(issue.message)));
});

test('stale edits and symlink state directories cannot overwrite accepted data', async t => {
  const { project, a, compositions } = await fixture(t);
  const saved = await saveComposition(project, working([a]));
  const edit = createWorkingComposition(saved); edit.name = 'New name'; await saveComposition(project, edit);
  await assert.rejects(saveComposition(project, createWorkingComposition(saved)), /changed or was removed/);
  await fs.rename(compositions, compositions + '-original'); await fs.symlink(compositions + '-original', compositions);
  await assert.rejects(saveComposition(project, working([a])), /real directories/);
});

test('candidate visibility and strength follow the current composition tail', () => {
  const starter = vector('Starter', endpoint('Start'), endpoint('Hall'));
  const strong = vector('Strong', endpoint('Hall'), endpoint('Garden'), 'continuation');
  const weak = vector('Weak', endpoint('Hall', '00000000'), endpoint('Hall'), 'continuation');
  const other = vector('Other', endpoint('Garden'), { type: 'termination' }, 'continuation');
  const child = accepted([starter]);
  const playables = [starter, strong, weak, other, child], resolve = resolver(playables);
  let current = createWorkingComposition();
  let view = compositionView(current, playables);
  assert.deepEqual(view.candidates.map(value => value.guid), [starter.guid, child.guid]);
  assert.ok(view.candidates.every(value => value.strength === null));
  current = editMembers(current, 'add', null, child, resolve);
  view = compositionView(current, playables);
  assert.equal(view.candidates.length, playables.length);
  assert.deepEqual(view.candidates.map(value => value.strength), [null, 'strong', 'weak', null, null]);
  current = editMembers(current, 'add', null, strong, resolve);
  assert.deepEqual(compositionView(current, playables).candidates.map(value => value.strength), [null, null, null, 'strong', null]);
  current = editMembers(current, 'add', null, other, resolve);
  assert.ok(compositionView(current, playables).candidates.every(value => value.strength === null));
  current = editMembers(current, 'remove', 2, null, resolve);
  current = editMembers(current, 'remove', 1, null, resolve);
  current = editMembers(current, 'remove', 0, null, resolve);
  view = compositionView(current, playables);
  assert.equal(view.candidates.length, 2);
  assert.ok(view.candidates.every(value => value.strength === null));
});


test('consecutive duplicate identities are rejected while matching distinct playables and later reuse are allowed', () => {
  const a = vector('Same', endpoint('Room'), endpoint('Room'));
  const b = vector('Same', a.start, a.end), child = accepted([a]);
  const playables = [a, b, child], resolve = resolver(playables);
  for (const playable of [a, child]) {
    const current = working([playable]);
    assert.throws(() => editMembers(current, 'add', null, { ...playable, guid: playable.guid.toUpperCase() }, resolve), /twice in a row/);
    assert.equal(current.members.length, 1);
    assert.throws(() => commitComposition(working([playable, playable]), resolve), /twice in a row/);
    const candidate = compositionView(current, playables).candidates.find(value => value.guid === playable.guid);
    assert.match(candidate.reason, /twice in a row/);
    assert.equal(candidate.strength, null);
    assert.doesNotMatch(candidate.guidance, /Strong/);
  }
  assert.doesNotThrow(() => editMembers(working([a]), 'add', null, b, resolve));
  assert.doesNotThrow(() => commitComposition(working([a, b, a]), resolve));
  for (const [action, index, value] of [['remove', 1, null], ['down', 0, null], ['replace', 1, a]]) {
    assert.throws(() => editMembers(working([a, b, a]), action, index, value, resolve), /twice in a row/);
  }
});


test('different-location vectors and compositions cannot be appended', () => {
  const starter = vector('Starter', endpoint('Start'), endpoint('Hall'));
  const other = vector('Other', endpoint('Garden'), endpoint('Hall'));
  const child = accepted([other]);
  const strong = vector('Strong', endpoint('Hall'), endpoint('Garden'), 'continuation');
  const weak = vector('Weak', endpoint('Hall', '00000000'), endpoint('Garden'), 'continuation');
  const playables = [starter, other, child, strong, weak], resolve = resolver(playables);
  const current = working([starter]);
  for (const playable of [other, child]) {
    const candidate = compositionView(current, playables).candidates.find(value => value.guid === playable.guid);
    assert.match(candidate.reason, /Different location/);
    assert.equal(candidate.strength, null);
    assert.throws(() => editMembers(current, 'add', null, playable, resolve), /Different location/);
    assert.deepEqual(current.members, [reference(starter)]);
    assert.doesNotThrow(() => editMembers(createWorkingComposition(), 'add', null, playable, resolve));
    const moved = editMembers(current, 'add', null, strong, resolve);
    assert.equal(compositionView(moved, playables).candidates.find(value => value.guid === playable.guid).reason, '');
    assert.doesNotThrow(() => editMembers(moved, 'add', null, playable, resolve));
  }
  for (const playable of [strong, weak]) {
    assert.equal(compositionView(current, playables).candidates.find(value => value.guid === playable.guid).reason, '');
    assert.doesNotThrow(() => editMembers(current, 'add', null, playable, resolve));
  }
});
