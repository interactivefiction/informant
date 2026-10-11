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
const path = require('node:path');
const os = require('node:os');
const { createVector, serializeVector } = require('../iskein');
const { parseVector, discoverTestVectors } = require('../test-vector-library');
const { makeTestVector } = require('../make-test-vector');
const { Skein } = require('../skein');
const endpoint = { location: '  桃の部屋 — pièce 🍑  ', observation: '08A31F09' };
const turns = [{ command: 'examine "peach" & <bell>', result: '  A peach.\r\n\n<&> 🍑  ' }, { command: '', result: '' }];
function vector(number = 1, name = 'Peaches', end = endpoint) {
  return createVector({ entry: 'initial', guid: `550e8400-e29b-41d4-a716-${String(number).padStart(12, '0')}`, name, start: endpoint, end, turns });
}
async function fixture(t) {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'informant-library-'));
  t.after(() => fs.rm(project, { recursive: true, force: true }));
  const directory = path.join(project, '.informant', 'test-vectors');
  async function save(value, source = serializeVector(value)) {
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, value.guid + '.iskein'), source);
  }
  return { project, directory, save, load: () => discoverTestVectors(project) };
}

test('v4 parsing preserves identity, opaque Unicode endpoints and exact recorded transcript', () => {
  const value = vector();
  assert.deepEqual(parseVector(serializeVector(value)), value);
  assert.deepEqual(parseVector(serializeVector(vector(2, 'Quit', { type: 'termination' }))), vector(2, 'Quit', { type: 'termination' }));
  assert.deepEqual(parseVector(serializeVector(value).replace(/\n/g, '\r\n')), value);
  assert.deepEqual(parseVector(serializeVector(value).replace('<command></command>', '<command/>')), value);
});

test('valid discovery exposes file identity, endpoints, count and transcript without writes', async t => {
  const f = await fixture(t), value = vector(); await f.save(value);
  const file = path.join(f.directory, value.guid + '.iskein');
  const before = await fs.readFile(file), stat = await fs.stat(file);
  const library = await f.load();
  assert.equal(library.status, 'available'); assert.deepEqual(library.issues, []);
  assert.deepEqual(library.vectors, [{ ...value, file, turnCount: 2 }]);
  assert.deepEqual(await fs.readFile(file), before); assert.equal((await fs.stat(file)).mtimeMs, stat.mtimeMs);
});

test('multiple vectors sort deterministically by exact name then GUID', async t => {
  const f = await fixture(t);
  for (const value of [vector(3, 'Zebra'), vector(2, 'Apple'), vector(1, 'Apple', { type: 'termination' })]) await f.save(value);
  const first = await f.load(), second = await f.load();
  assert.deepEqual(first, second);
  assert.deepEqual(first.vectors.map(v => v.guid), [vector(1).guid, vector(2).guid, vector(3).guid]);
  assert.deepEqual(first.vectors[0].end, { type: 'termination' });
});

test('missing and empty directories are normal empty states; unrelated paths are ignored', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.project, vector().guid + '.iskein'), serializeVector(vector()));
  assert.deepEqual(await f.load(), { status: 'missing', vectors: [], issues: [] });
  await fs.mkdir(f.directory, { recursive: true });
  await fs.writeFile(path.join(f.directory, '.partial.tmp'), '<invalid>');
  await fs.mkdir(path.join(f.directory, 'nested'));
  await fs.writeFile(path.join(f.directory, 'nested', vector().guid + '.iskein'), serializeVector(vector()));
  assert.deepEqual(await f.load(), { status: 'available', vectors: [], issues: [] });
});

test('malformed and unsupported files are isolated from valid vectors', async t => {
  const f = await fixture(t);
  await f.save(vector(1));
  await f.save(vector(2), '<iskein version="4"><identity>');
  await f.save(vector(3), serializeVector(vector(3)).replace('version="4"', 'version="2"'));
  await f.save(vector(4), Buffer.from([0xff]));
  const library = await f.load();
  assert.equal(library.vectors.length, 1); assert.equal(library.issues.length, 3);
  assert.match(library.issues[0].message, /Malformed/);
  assert.match(library.issues[1].message, /Unsupported ISkein version: 2/);
});

test('invalid v4 structures and values never become accepted vectors', () => {
  const source = serializeVector(vector());
  const invalid = [
    source.replace('version="4"', ''),
    source.replace('<guid>', '<guid>bad'),
    source.replace('<name>Peaches</name>', '<name/>'),
    source.replace('<identity>', '<identity><guid>duplicate</guid>'),
    source.replace('algorithm="crc32"', 'algorithm="md5"'),
    source.replace('08A31F09', '08a31f09'),
    source.replace('<end type="location">', '<end>'),
    source.replace('<end type="location">', '<end type="termination">'),
    source.replace('<start>', '<start type="termination">'),
    source.replace('sequence="2"', 'sequence="1"'),
    source.replace('xml:space="preserve"', 'xml:space="default"'),
    source.replace('<result xml:space="preserve">', '<result xml:space="preserve"><script/>'),
    source.replace('</iskein>', '</iskein><extra/>'),
    source.replace('<name>Peaches</name>', '<name>&unknown;</name>'),
    source.replace('<name>Peaches</name>', '<name>&#0;</name>'),
    source.replace('<name>Peaches</name>', '<name>&#x110000;</name>'),
    source.replace('<name>Peaches</name>', '<name>bad]]></name>'),
    source.replace('<iskein', '<!DOCTYPE iskein SYSTEM "file:///etc/passwd"><iskein'),
    source.replace('version="4"', 'version="4" version="4"'),
    source.replace('</identity>', '</wrong>')
  ];
  for (const candidate of invalid) assert.throws(() => parseVector(candidate));
});

test('refresh reloads additions, persisted changes and deletions', async t => {
  const f = await fixture(t); await f.save(vector(1));
  assert.equal((await f.load()).vectors.length, 1);
  await f.save(vector(2)); await f.save(vector(1, 'Changed', { type: 'termination' }));
  const library = await f.load(); assert.equal(library.vectors.length, 2);
  assert.equal(library.vectors[0].name, 'Changed'); assert.deepEqual(library.vectors[0].end, { type: 'termination' });
  await fs.unlink(path.join(f.directory, vector(1).guid + '.iskein'));
  assert.equal((await f.load()).vectors.length, 1);
});

test('Make Test Vector output is immediately discoverable with original results', async t => {
  const f = await fixture(t), skein = new Skein();
  const item = skein.item('look'); item.result = 'Original result\n  🍑';
  skein.items[0].childId = item.id; skein.items.push(item);
  const file = path.join(f.project, 'Skein.skein'), source = skein.serialize();
  await fs.writeFile(file, source);
  const value = await makeTestVector(f.project, { name: 'Created', qualify: async () => ({ start: endpoint, end: { type: 'termination' } }) });
  assert.deepEqual((await f.load()).vectors, [{ ...value, turnCount: 1 }]);
  await assert.rejects(fs.readFile(file), { code: 'ENOENT' });
});

test('containment rejects escaping directory/file symlinks and mismatched filenames', async t => {
  const f = await fixture(t), outside = await fixture(t);
  await outside.save(vector());
  await fs.mkdir(path.dirname(f.directory), { recursive: true });
  await fs.symlink(outside.directory, f.directory);
  assert.equal((await f.load()).status, 'unreadable');
  await fs.unlink(f.directory); await fs.mkdir(f.directory);
  await fs.symlink(path.join(outside.directory, vector().guid + '.iskein'), path.join(f.directory, vector().guid + '.iskein'));
  await fs.writeFile(path.join(f.directory, 'wrong.iskein'), serializeVector(vector()));
  const library = await f.load(); assert.equal(library.vectors.length, 0); assert.equal(library.issues.length, 2);
  assert.match(library.issues[0].message, /outside the project/);
  assert.match(library.issues[1].message, /Filename/);
});

test('v4 parser requires exactly one valid entry field', () => {
  const source = serializeVector(vector());
  for (const entry of ['', '<entry/>', '<entry>Initial</entry>', '<entry> initial </entry>',
    '<entry>unknown</entry>', '<entry>initial</entry><entry>continuation</entry>',
    '<entry value="initial"/>', '<entry><initial/></entry>']) {
    assert.throws(() => parseVector(source.replace('<entry>initial</entry>', entry)));
  }
});

test('v3 is reported read-only without invented entry semantics alongside valid v4 vectors', async t => {
  const f = await fixture(t);
  const legacy = serializeVector(vector()).replace('version="4"', 'version="3"').replace('  <entry>initial</entry>\n', '');
  await f.save(vector(), legacy);
  await f.save({ ...vector(2), entry: 'continuation' });
  const file = path.join(f.directory, vector().guid + '.iskein');
  const before = await fs.stat(file);
  assert.throws(() => parseVector(legacy), /v3 has no entry semantics/);
  const library = await f.load();
  assert.equal(library.vectors.length, 1);
  assert.equal(library.vectors[0].entry, 'continuation');
  assert.match(library.issues[0].message, /v3 has no entry semantics/);
  assert.equal(await fs.readFile(file, 'utf8'), legacy);
  assert.equal((await fs.stat(file)).mtimeMs, before.mtimeMs);
});
