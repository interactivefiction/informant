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
const endpoint = location => ({ location, observation: 'CBF43926' });
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { Skein, parseLinearSkeinTurns } = require('../skein');
const { createVector, serializeVector } = require('../iskein');
const { makeTestVector } = require('../make-test-vector');

const turns = [
  { command: 'wait', result: '  First\n\n >\t\r\n' },
  { command: 'wait', result: 'Second <&> "peach" \'🍑\'\n' },
  { command: 'n', result: '  DefectN Room\n>' }
];
function recording() {
  const skein = new Skein();
  skein.items[0].result = 'Startup must not be persisted';
  for (const turn of turns) {
    const item = Object.assign(skein.item(turn.command), turn);
    skein.items.at(-1).childId = item.id; skein.items.push(item);
  }
  return skein.serialize();
}
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'informant-vector-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'Skein.skein');
  await fs.writeFile(file, recording());
  return { root, file, library: path.join(root, '.informant', 'test-vectors') };
}
const qualified = async () => ({ start: endpoint('Ripening Room - room'), end: endpoint("Defect'n Room"), object: 553957, symbol: 'I_ripening_room_U1' });
async function accepted(f) { return (await fs.readdir(f.library).catch(() => [])).filter(name => name.endsWith('.iskein')); }

test('linear model preserves commands, repeated turns, results and whitespace without startup', () => {
  assert.deepEqual(parseLinearSkeinTurns(recording()), turns);
});

test('v4 XML vocabulary, escaping, required fields, default names and exact supplied name', () => {
  const guid = '550e8400-e29b-41d4-a716-44665544a92f';
  for (const name of [undefined, '', ' \t ']) {
    const vector = createVector({ entry: 'initial', name, guid, start: endpoint('Ripening Room - room'), end: endpoint('End'), turns });
    assert.equal(vector.name, 'Ripening Room - room A92F');
  }
  const vector = createVector({ entry: 'initial', name: '  <Peach & "Cream">  ', guid, start: endpoint('<start>'), end: endpoint("Defect'n Room"), turns });
  assert.equal(vector.name, '  <Peach & "Cream">  ');
  const xml = serializeVector(vector);
  assert.match(xml, /<iskein version="4">/);
  assert.match(xml, /<name>  &lt;Peach &amp; &quot;Cream&quot;&gt;  <\/name>/);
  assert.match(xml, /<start>\s*<location>&lt;start&gt;<\/location>\s*<observation algorithm="crc32">CBF43926<\/observation>\s*<\/start>/);
  assert.match(xml, /<end type="location">\s*<location>Defect&apos;n Room<\/location>/);
  assert.match(xml, /<result xml:space="preserve">  First\n\n &gt;\t&#13;\n<\/result>/);
  assert.equal((xml.match(/<turn sequence=/g) || []).length, 3);
  assert.doesNotMatch(xml, /- start -|Startup|symbol|object|address|gameinfo|fingerprint/);
  for (const changes of [{ start: endpoint('') }, { end: undefined }, { name: ' ' }, { guid: '../bad' }, { turns: [{ command: 'look', result: '\0' }] }]) {
    assert.throws(() => serializeVector({ ...vector, ...changes }));
  }
});

test('conversion qualifies exact command snapshot then atomically saves one GUID file then removes Skein', async t => {
  const f = await fixture(t);
  const vector = await makeTestVector(f.root, { name: 'My Peach', qualify: async commands => {
    assert.deepEqual(commands, turns.map(t => t.command));
    assert.deepEqual(await accepted(f), []);
    return qualified();
  } });
  assert.match(vector.guid, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(path.basename(vector.file), vector.guid + '.iskein');
  assert.equal(vector.name, 'My Peach');
  assert.equal(vector.entry, 'initial');
  assert.deepEqual(vector.turns, turns);
  const xml = await fs.readFile(vector.file, 'utf8');
  assert.ok(xml.includes(`<guid>${vector.guid}</guid>`));
  assert.doesNotMatch(xml, /553957|I_ripening_room|symbol|object|address/);
  assert.deepEqual(await fs.readdir(f.library), [vector.guid + '.iskein']);
  await assert.rejects(fs.readFile(f.file), { code: 'ENOENT' });
});

for (const problem of ['missing', 'unreadable', 'malformed', 'nonlinear', 'invalid UTF8', 'empty']) {
  test(`${problem} Working Skein cannot qualify or create a vector`, async t => {
    const f = await fixture(t);
    if (problem === 'missing' || problem === 'unreadable') await fs.unlink(f.file);
    if (problem === 'unreadable') await fs.mkdir(f.file);
    if (problem === 'malformed') await fs.writeFile(f.file, '<Skein/>');
    if (problem === 'nonlinear') await fs.writeFile(f.file, recording().replace(/(<child[^>]+\/>)/, '$1$1'));
    if (problem === 'invalid UTF8') await fs.writeFile(f.file, Buffer.from([0xff]));
    if (problem === 'empty') await fs.writeFile(f.file, new Skein().serialize());
    await assert.rejects(makeTestVector(f.root, { qualify() { assert.fail('Must not launch'); } }));
    assert.deepEqual(await accepted(f), []);
  });
}

for (const [label, qualify] of [
  ['replay fails', async () => { throw new Error('Unsupported non-line interaction'); }],
  ['missing start', async () => ({ end: endpoint('Room') })],
  ['missing end', async () => ({ start: endpoint('Room') })],
  ['invalid XML room text', async () => ({ start: endpoint('Room'), end: endpoint('\0') })]
]) test(`${label} leaves no vector and preserves source`, async t => {
  const f = await fixture(t), before = await fs.readFile(f.file);
  await assert.rejects(makeTestVector(f.root, { qualify }));
  assert.deepEqual(await accepted(f), []);
  assert.deepEqual(await fs.readFile(f.file), before);
});

for (const stage of ['mkdir', 'open', 'write', 'sync', 'link']) test(`persistence failure at ${stage} leaves no partial accepted vector`, async t => {
  const f = await fixture(t), io = { ...fs };
  const before = await fs.readFile(f.file, 'utf8');
  const fail = async () => { throw new Error('Injected disk error'); };
  if (['mkdir', 'open', 'link'].includes(stage)) io[stage] = fail;
  else io.open = async (...args) => {
    const handle = await fs.open(...args);
    return { writeFile: stage === 'write' ? fail : handle.writeFile.bind(handle),
      sync: stage === 'sync' ? fail : handle.sync.bind(handle), close: handle.close.bind(handle) };
  };
  await assert.rejects(makeTestVector(f.root, { qualify: qualified, io }), /disk error/);
  assert.deepEqual(await fs.readdir(f.library).catch(() => []), []);
  assert.equal(await fs.readFile(f.file, 'utf8'), before);
});

test('GUID collision never overwrites existing accepted file', async t => {
  const f = await fixture(t);
  const io = { ...fs, async link(temp, destination) {
    await fs.writeFile(destination, 'existing vector');
    return fs.link(temp, destination);
  } };
  await assert.rejects(makeTestVector(f.root, { qualify: qualified, io }), /EEXIST/);
  const files = await fs.readdir(f.library);
  assert.equal(files.length, 1);
  assert.equal(await fs.readFile(path.join(f.library, files[0]), 'utf8'), 'existing vector');
});

test('cancellation after replay cannot commit', async t => {
  const f = await fixture(t), controller = new AbortController();
  await assert.rejects(makeTestVector(f.root, { signal: controller.signal, qualify: async () => {
    controller.abort(); return qualified();
  } }));
  assert.deepEqual(await accepted(f), []);
});

test('v4 refuses legacy room strings or absent/malformed observations before accepting a file', async t => {
  const f = await fixture(t);
  for (const start of ['Ripening Room', { location: 'Room' }, { location: 'Room', observation: 'cbf43926' },
    { location: 'Room', observation: '1234567' }, { location: 'Room', observation: 'ZZZZZZZZ' }]) {
    await assert.rejects(makeTestVector(f.root, { qualify: async () => ({ start, end: endpoint('End') }) }));
    assert.deepEqual(await accepted(f), []);
  }
});

test('v4 endpoint copies retain only location/observation and never publish runtime identities', () => {
  const start = { ...endpoint('  場所 — 部屋 🍑  '), object: 123, symbol: 'I_room_U1', diagnostic: 'raw output' };
  const vector = createVector({ entry: 'initial', start, end: start, turns });
  assert.deepEqual(vector.start, endpoint('  場所 — 部屋 🍑  '));
  start.location = 'changed';
  const xml = serializeVector(vector);
  assert.match(xml, /<location>  場所 — 部屋 🍑  <\/location>/);
  assert.equal((xml.match(/<observation algorithm="crc32">CBF43926<\/observation>/g) || []).length, 2);
  assert.doesNotMatch(xml, /<room>|I_room_U1|raw output|<object>|changed/);
});

test('termination endpoint preserves every original quitting command and result', async t => {
  const f = await fixture(t);
  const skein = new Skein();
  const quitting = [{ command: 'quit', result: 'Are you sure?\n' }, { command: 'y', result: 'Goodbye.\n' }];
  for (const turn of quitting) {
    const item = Object.assign(skein.item(turn.command), turn);
    skein.items.at(-1).childId = item.id; skein.items.push(item);
  }
  await fs.writeFile(f.file, skein.serialize());
  const vector = await makeTestVector(f.root, { qualify: async commands => {
    assert.deepEqual(commands, ['quit', 'y']);
    return { start: endpoint('Room'), end: { type: 'termination' } };
  } });
  assert.deepEqual(vector.turns, quitting);
  assert.match(await fs.readFile(vector.file, 'utf8'), /<end type="termination"\/>/);
  await assert.rejects(fs.readFile(f.file), { code: 'ENOENT' });
  for (const end of [{ type: 'failure' }, { type: 'termination', location: 'Room' }]) {
    assert.throws(() => createVector({ entry: 'initial', start: endpoint('Room'), end, turns }));
  }
  assert.throws(() => createVector({ entry: 'initial', start: { type: 'termination' }, end: endpoint('Room'), turns }));
});

for (const entry of ['initial', 'continuation']) {
  for (const end of [endpoint('Ripening Room - room'), { type: 'termination' }]) {
    test(`v4 ${entry} model supports ${end.type || 'location'} end independently of initial location`, () => {
      const guid = '550e8400-e29b-41d4-a716-44665544a92f';
      // The future Working ISkein acceptance path supplies continuation explicitly
      // and preserves the GUID assigned when recording was initialized.
      const vector = createVector({ entry, guid, start: endpoint('Ripening Room - room'), end, turns });
      const source = serializeVector(vector);
      assert.equal(vector.entry, entry);
      assert.equal(vector.guid, guid);
      assert.match(source, /<iskein version="4">/);
      assert.ok(source.includes(`</identity>\n  <entry>${entry}</entry>\n  <endpoints>`));
      assert.deepEqual(require('../test-vector-library').parseVector(source), vector);
      assert.deepEqual(vector.turns, turns);
    });
  }
}

test('v4 model and serializer require entry without location or observation inference', () => {
  const fields = { start: endpoint('Ripening Room - room'), end: endpoint('Ripening Room - room'), turns };
  const valid = createVector({ ...fields, entry: 'initial' });
  for (const entry of [undefined, null, '', 'Initial', ' initial ', 'unknown', 0]) {
    assert.throws(() => createVector({ ...fields, entry }), /entry/);
    assert.throws(() => serializeVector({ ...valid, entry }), /entry/);
  }
});

test('Working Skein conversion stays initial when it returns to its starting location', async t => {
  const f = await fixture(t);
  const vector = await makeTestVector(f.root, { qualify: async () => ({
    start: endpoint('Ripening Room - room'), end: endpoint('Ripening Room - room'), entry: 'continuation'
  }) });
  assert.equal(vector.entry, 'initial');
  assert.match(await fs.readFile(vector.file, 'utf8'), /<entry>initial<\/entry>/);
});

test('cleanup failure reports the saved vector and preserves the recording', async t => {
  const f = await fixture(t);
  const before = await fs.readFile(f.file, 'utf8');
  const io = { ...fs, async unlink(file) {
    if (file === f.file) throw new Error('permission denied');
    return fs.unlink(file);
  } };
  await assert.rejects(makeTestVector(f.root, { qualify: qualified, io }), /Vector saved at .*cannot remove Starter Recording: permission denied/);
  assert.equal((await accepted(f)).length, 1);
  assert.equal(await fs.readFile(f.file, 'utf8'), before);
});
