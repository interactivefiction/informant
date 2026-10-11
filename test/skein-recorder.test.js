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
const { SkeinRecorder } = require('../skein-recorder');

async function fixture(t, io = fs) {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'informant-skein-'));
  t.after(() => fs.rm(project, { recursive: true, force: true }));
  const destination = path.join(project, 'Skein.skein');
  await fs.writeFile(destination, '<previous-valid-skein/>');
  const errors = [];
  const recorder = new SkeinRecorder(project, { io, onError: e => errors.push(e.message) });
  let sequence = 0;
  const send = (kind, payload, sessionId = recorder.sessionId) => recorder.receive({ type: 'skein.recording', sessionId, sequence: ++sequence, kind, payload });
  return { project, destination, recorder, errors, send, read: () => fs.readFile(destination, 'utf8') };
}
function frame(gen, text = 'Startup\n\n>', input = null, exit = false) {
  return { input, output: { type: 'update', gen, windows: [{ id: 1, type: 'buffer' }], content: [{ id: 1, text: [{ append: true, content: ['normal', text] }] }], input: exit ? [] : [{ id: 1, type: 'line', gen }], exit } };
}

test('startup failure and early disposal preserve previous Skein without merging or writing', async t => {
  const f = await fixture(t);
  f.send('update', frame(1));
  await f.recorder.queue;
  assert.equal(await f.read(), '<previous-valid-skein/>');
  f.send('error', 'startup failed');
  await f.recorder.finalize();
  assert.equal(await f.read(), '<previous-valid-skein/>');
  assert.deepEqual(f.errors, ['startup failed']);
  const other = new SkeinRecorder(f.project);
  await other.finalize();
  assert.equal(await f.read(), '<previous-valid-skein/>');
});

test('ready replaces previous Skein with a root-only recording; later invocation starts fresh', async t => {
  const f = await fixture(t);
  f.send('update', frame(1)); f.send('ready');
  await f.recorder.queue;
  const first = await f.read();
  assert.ok(!first.includes('previous'));
  assert.equal((first.match(/<item /g) || []).length, 1);
  assert.match(first, /Startup\n\n&gt;/);
  f.send('update', frame(2, 'Answer>', { type: 'line', value: 'look', window: 1, gen: 1 }));
  await f.recorder.finalize();
  assert.match(await f.read(), />look<\/command>/);
  const next = new SkeinRecorder(f.project);
  next.receive({ type: 'skein.recording', sessionId: next.sessionId, sequence: 1, kind: 'update', payload: frame(1, 'Fresh>') });
  next.receive({ type: 'skein.recording', sessionId: next.sessionId, sequence: 2, kind: 'ready' });
  await next.finalize();
  const second = await f.read();
  assert.ok(!second.includes('look') && !second.includes('Startup'));
  assert.notEqual(next.model.items[0].id, f.recorder.model.items[0].id);
  assert.equal((second.match(/<item /g) || []).length, 1);
});

test('stale sessions are ignored and message gaps stop recording before replacement', async t => {
  const f = await fixture(t);
  f.recorder.receive({ type: 'skein.recording', sessionId: 'old', sequence: 1, kind: 'ready' });
  assert.equal(f.recorder.sequence, 0);
  f.recorder.receive({ type: 'skein.recording', sessionId: f.recorder.sessionId, sequence: 2, kind: 'ready' });
  assert.match(f.errors[0], /order/);
  await f.recorder.finalize();
  assert.equal(await f.read(), '<previous-valid-skein/>');
});

for (const stage of ['writeFile', 'rename']) test(`failed ${stage} preserves destination and cleans temporary file`, async t => {
  const io = { ...fs, [stage]: async () => { throw new Error('injected failure'); } };
  const f = await fixture(t, io);
  f.send('update', frame(1)); f.send('ready');
  await f.recorder.queue;
  assert.equal(await f.read(), '<previous-valid-skein/>');
  assert.match(f.errors[0], /Cannot save Skein: injected failure/);
  assert.deepEqual(await fs.readdir(f.project), ['Skein.skein']);
});

test('writes are serialized; finalization is idempotent and freezes received progress', async t => {
  let writing = false, count = 0;
  const io = { ...fs, async writeFile(...args) {
    assert.equal(writing, false); writing = true;
    await new Promise(resolve => setTimeout(resolve, 3));
    await fs.writeFile(...args); writing = false; count++;
  } };
  const f = await fixture(t, io);
  f.send('update', frame(1)); f.send('ready');
  f.send('update', frame(2, 'Second>', { type: 'line', value: 'wait', window: 1, gen: 1 }));
  f.send('update', frame(3, 'Extra'));
  const finishing = f.recorder.finalize();
  assert.equal(f.recorder.finalize(), finishing);
  f.send('update', frame(4, 'STALE'));
  await finishing;
  assert.equal(count, 4);
  const result = await f.read();
  assert.match(result, /Second&gt;Extra/);
  assert.ok(!result.includes('STALE'));
});

test('normal exit records final output; malformed or unsupported input preserves previous checkpoints', async t => {
  const f = await fixture(t);
  f.send('update', frame(1)); f.send('ready');
  await f.recorder.queue;
  f.send('update', frame(2, 'Bye', { type: 'line', value: 'quit', window: 1, gen: 1 }, true));
  await f.recorder.finalize();
  assert.match(await f.read(), /Bye/);
  assert.ok(f.recorder.closed);
  const g = await fixture(t);
  g.send('update', frame(1)); g.send('ready'); await g.recorder.queue;
  const before = await g.read();
  g.send('update', frame(2, 'bad', { type: 'char', value: 'x' }));
  await g.recorder.finalize();
  assert.equal(await g.read(), before);
  assert.match(g.errors[0], /Invalid Skein keyboard input/);
});

test('later checkpoint failure preserves the last valid XML and stops queued replacements', async t => {
  let renames = 0;
  const io = { ...fs, async rename(...args) {
    if (++renames > 1) throw new Error('later rename failed');
    return fs.rename(...args);
  } };
  const f = await fixture(t, io);
  f.send('update', frame(1)); f.send('ready');
  await f.recorder.queue;
  const valid = await f.read();
  assert.match(valid, /^<\?xml/);
  f.send('update', frame(2, 'Second'));
  f.send('update', frame(3, 'Third'));
  await f.recorder.queue;
  assert.equal(await f.read(), valid);
  assert.equal(renames, 2);
  assert.ok(f.recorder.closed);
  assert.deepEqual(await fs.readdir(f.project), ['Skein.skein']);
});

test('startup character prompt checkpoints immediately and persists typed keypresses', async t => {
  const f = await fixture(t);
  const initial = frame(1, 'Press Space');
  initial.output.input = [{ type: 'char', id: 1, gen: 1 }];
  f.send('update', initial); f.send('ready'); await f.recorder.queue;
  assert.match(await f.read(), /Press Space/);
  f.send('update', frame(2, 'Room>', { type: 'char', value: ' ', window: 1, gen: 1 }));
  await f.recorder.finalize();
  assert.deepEqual(f.errors, []);
  assert.deepEqual(require('../skein').parseLinearSkein(await f.read()), [{ type: 'char', value: ' ' }]);
});
