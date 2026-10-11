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
const vm = require('node:vm');
const { Skein, runs } = require('../skein');
const { qualifiedTests, runTests, installTestPlayback } = require('../test-runner');
const { installCompositionPlayback } = require('../composition-playback');
const { installSkeinPlayback } = require('../skein-playback-adapter');
const { exportResults } = require('../test-results');
const endpoint = { location: 'Room', observation: '12345678' };
const vector = (name, entry = 'initial', result = 'Taken.\n>') => ({ type: 'iskein', guid: randomUUID(), name, entry,
  start: endpoint, end: endpoint, turns: [{ command: name, result }] });
const composition = (...members) => ({ type: 'icomposition', guid: randomUUID(), name: 'Nested route', entry: 'initial',
  start: endpoint, end: members.at(-1).end, members: members.map(({ type, guid }) => ({ type, guid })) });

test('qualification filters continuation, incomplete endpoints, missing members and cycles; resolves outside suite', () => {
  const a = vector('take'), b = vector('north', 'continuation'), nested = composition(a, b), root = composition(nested);
  const malformed = { ...vector('bad'), end: undefined }, missing = composition(vector('missing'));
  const cycle = composition(a); cycle.members = [{ type: cycle.type, guid: cycle.guid }];
  const playables = [a, b, nested, root, malformed, missing, cycle];
  assert.deepEqual(qualifiedTests(playables).map(p => p.guid), [a.guid, nested.guid, root.guid]);
  const [plan] = qualifiedTests(playables, p => p.guid === root.guid);
  assert.deepEqual(plan.commands, ['take', 'north']);
  assert.equal(plan.turns[1].vectorGuid, b.guid);
  assert.match(plan.turns[1].context, /member 1.*member 2/);
  assert.equal(plan.turns[1].result, b.turns[0].result);
  const terminal = { ...vector('quit'), end: { type: 'termination' } };
  assert.equal(qualifiedTests([terminal])[0].endpoint, 'termination');
});

function runtime(plan) {
  let next = 0, input;
  const timers = new Map(), messages = [], events = [];
  const sandbox = { setTimeout(fn, delay) { timers.set(++next, { fn, delay }); return next; }, clearTimeout(id) { timers.delete(id); } };
  const embed = fn => vm.runInNewContext(`(${fn})`, sandbox);
  // Exercise the exact sources embedded in the production player document.
  const Capture = vm.runInNewContext(`const runs = ${runs}; (${Skein})`, sandbox);
  const options = {};
  class GlkOte {
    init(iface) { this.iface = iface; }
    getinterface() { return this.iface; }
    // Direct interpreter input does not enter GlkOte's UI recording state.
    update(output) { options.recording_handler?.({ input: null, output }); input = undefined; }
    error() {}
  }
  const adapter = embed(installTestPlayback)(options, GlkOte, plan, 'test', message => messages.push(message),
    embed(installCompositionPlayback), embed(installSkeinPlayback), Capture);
  const glk = options.GlkOte;
  glk.init({ accept(event) { input = event; events.push(event); } }); adapter.started();
  function update(gen, text, extra = {}) {
    const paragraphs = input ? [{ append: true, content: ['input', input.value] }, { content: ['normal', text] }]
      : [{ append: true, content: ['normal', text] }];
    glk.update({ type: 'update', gen, windows: [{ id: 1, type: 'buffer' }, { id: 2, type: 'grid' }],
      content: [{ id: 1, text: paragraphs }, { id: 2, text: [{ content: ['normal', 'Status bar excluded'] }] }],
      input: [{ type: 'line', id: 1, gen, maxlen: 256 }], ...extra });
  }
  function tick(delay = 180) { for (const [id, timer] of [...timers]) if (timer.delay === delay) { timers.delete(id); timer.fn(); } }
  return { update, tick, messages, events, adapter };
}

for (const response of ['Taken.\n>', 'Taken!\n>', 'Taken.\n> ', 'Taken.\r\n>', '  桃 🍑\n\n>']) {
  test(`exact response comparison, without normalizing ${JSON.stringify(response)}`, async () => {
    const a = vector('take'), b = vector('north', 'continuation'), root = composition(a, b);
    const [plan] = qualifiedTests([a, b, root], p => p === root);
    const before = JSON.stringify(plan);
    const f = runtime(plan);
    f.update(1, 'Welcome>'); f.tick();
    assert.equal(f.messages.at(-1).type, 'test.step');
    assert.equal(f.messages.at(-1).position, 1);
    f.update(2, response); f.tick(); await Promise.resolve();
    if (response === a.turns[0].result) {
      assert.equal(f.events.length, 2);
      f.update(3, b.turns[0].result); f.tick(); await Promise.resolve();
      assert.equal(f.messages.at(-1).status, 'PASS');
      assert.equal(f.messages.at(-1).compared, 2);
    } else {
      assert.equal(f.events.length, 1, 'never submit the next command after mismatch');
      assert.equal(f.messages.at(-1).status, 'FAIL');
      assert.equal(f.messages.at(-1).position, 1);
      assert.equal(f.messages.at(-1).received, response);
    }
    assert.equal(JSON.stringify(plan), before, 'expected responses are immutable');
  });
}

test('normal termination captures the final update before comparing; mismatched final response fails', async () => {
  for (const actual of ['Goodbye.', 'Different.']) {
    const a = { ...vector('quit', 'initial', 'Goodbye.'), end: { type: 'termination' } };
    const f = runtime(qualifiedTests([a])[0]);
    f.update(1, '>'); f.tick();
    f.update(2, actual, { exit: true, disable: true, input: [] });
    await Promise.resolve();
    assert.equal(f.messages.at(-1).status, actual === 'Goodbye.' ? 'PASS' : 'FAIL');
  }
});

test('interpreter timeout and unsupported input fail rather than passing incomplete tests', async () => {
  for (const kind of ['timeout', 'char', 'exit']) {
    const f = runtime(qualifiedTests([vector('take')])[0]);
    f.update(1, '>'); f.tick();
    if (kind === 'timeout') f.tick(30000);
    else f.update(2, '', kind === 'char' ? { input: [{ type: 'char', id: 1, gen: 2 }] } : { exit: true, input: [] });
    await Promise.resolve();
    assert.equal(f.messages.at(-1).status, 'FAIL');
    assert.equal(f.events.length, 1);
  }
});

test('each selected test executes independently; mismatch retains nested vector identity and next test runs', async () => {
  const a = vector('take'), b = vector('north', 'continuation'), child = composition(a, b), root = composition(child);
  const plans = qualifiedTests([a, b, child, root], p => [a, root].includes(p));
  const calls = [], updates = [], abort = new AbortController();
  const results = await runTests(plans, async plan => {
    calls.push(plan.guid);
    return plan.guid === a.guid ? { status: 'PASS', completed: 1, compared: 1 }
      : { status: 'FAIL', position: 2, received: 'Locked!', reason: 'Response mismatch.' };
  }, abort.signal, results => updates.push(results.map(row => row.status)));
  assert.deepEqual(calls, plans.map(p => p.guid));
  assert.deepEqual(results.map(row => row.status), ['PASS', 'FAIL']);
  assert.equal(results[1].failure.vectorGuid, b.guid);
  assert.equal(results[1].failure.vectorTurn, 1);
  assert.equal(results[1].failure.expected, b.turns[0].result);
  assert.match(results[1].failure.context, /member 1.*member 2/);
  assert.deepEqual(updates[0], ['RUNNING']);
  const reverse = await runTests(plans.toReversed(), async plan => plan.guid === root.guid
    ? { status: 'FAIL', position: 1, received: '' } : { status: 'PASS', completed: 1, compared: 1 }, abort.signal);
  assert.deepEqual(reverse.map(row => row.status), ['FAIL', 'PASS']);
});

test('cancellation stops subsequent tests; errors and incomplete comparisons never pass', async () => {
  const plans = qualifiedTests([vector('one'), vector('two')]), abort = new AbortController();
  let calls = 0;
  const cancelled = await runTests(plans, async () => { calls++; abort.abort(); throw new Error('cancelled'); }, abort.signal);
  assert.equal(calls, 1); assert.equal(cancelled[0].status, 'CANCELLED');
  const results = await runTests(plans, async plan => {
    if (plan === plans[0]) throw new Error('Missing runtime');
    return { status: 'PASS', compared: 0 };
  }, new AbortController().signal);
  assert.deepEqual(results.map(row => row.status), ['FAIL', 'FAIL']);
});

test('ZIP has readable summary and exact Unicode/whitespace failure JSON, without modifying run', () => {
  const guid = randomUUID();
  const run = { project: '/project', suite: 'Suite', started: '2026-09-25', state: 'Complete', results: [
    { name: '桃', guid, type: 'iskein', status: 'FAIL', turnCount: 1, durationMs: 5,
      failure: { playableName: '桃', playableGuid: guid, position: 1, command: 'look', expected: ' \r\n🍑', received: '\n🍑 ' } },
    { name: 'Passing', guid: randomUUID(), type: 'iskein', status: 'PASS', turnCount: 1 }
  ] };
  const before = JSON.stringify(run), zip = exportResults(run), files = new Map();
  let offset = 0;
  while (zip.readUInt32LE(offset) === 0x04034b50) {
    const size = zip.readUInt32LE(offset + 18), length = zip.readUInt16LE(offset + 26);
    const name = zip.subarray(offset + 30, offset + 30 + length).toString();
    files.set(name, zip.subarray(offset + 30 + length, offset + 30 + length + size).toString());
    offset += 30 + length + size;
  }
  assert.equal(zip.readUInt32LE(offset), 0x02014b50);
  assert.equal(files.size, 2);
  assert.match(files.get('summary.txt'), /FAIL — 桃/); assert.match(files.get('summary.txt'), /PASS — Passing/);
  assert.deepEqual(JSON.parse(files.get(`failures/0001-${guid}.json`)), run.results[0].failure);
  assert.equal(zip.readUInt32LE(zip.length - 22), 0x06054b50);
  assert.equal(JSON.stringify(run), before);
});

for (const status of ['PASS', 'FAIL', 'CANCELLED']) test(`live command steps clear after ${status} and ignore late updates`, async () => {
  const plan = qualifiedTests([vector('north')])[0], abort = new AbortController(), updates = [];
  let late;
  const results = await runTests([plan], async (current, signal, onStep) => {
    late = onStep;
    onStep(1);
    if (status === 'CANCELLED') abort.abort();
    return { status, completed: 1, compared: 1 };
  }, abort.signal, rows => updates.push(rows.map(row => ({ ...row }))));
  assert.equal(updates[1][0].currentStep, 'Step 1/1: north');
  assert.equal(updates[1][0].status, 'RUNNING');
  assert.equal(results[0].status, status);
  assert.equal(results[0].currentStep, undefined);
  late(1);
  assert.equal(updates.length, 3);
});

test('test playback captures typed keys without removing character-response text as a line echo', async () => {
  const value = vector('return', 'initial', 'return\n>');
  value.turns[0].inputType = 'char';
  const f = runtime(qualifiedTests([value])[0]);
  f.update(1, 'Press a key', { input: [{ type: 'char', id: 1, gen: 1 }] }); f.tick();
  assert.equal(f.events[0].type, 'char');
  assert.equal(f.events[0].value, 'return');
  f.update(2, '', { content: [{ id: 1, text: [{ append: true, content: ['input', 'return'] }, { content: ['normal', '>'] }] }] });
  f.tick(); await Promise.resolve();
  assert.equal(f.messages.at(-1).status, 'PASS');
});

for (const behavior of ['stepwise', 'endpoint', 'none']) {
  test(`${behavior} handles intermediate and final mismatches across nested compositions`, async () => {
    for (const finalMatches of [false, true]) {
      const a = vector('take'), b = vector('north', 'continuation');
      const nested = composition(a, b), root = composition(nested);
      const plan = { ...qualifiedTests([a, b, nested, root], p => p === root)[0], behavior };
      const f = runtime(plan);
      f.update(1, '>'); f.tick();
      f.update(2, 'Intermediate mismatch'); f.tick(); await Promise.resolve();
      if (behavior !== 'stepwise') {
        assert.equal(f.events.length, 2);
        f.update(3, finalMatches ? b.turns[0].result : 'Final mismatch'); f.tick(); await Promise.resolve();
      }
      const result = f.messages.at(-1);
      assert.equal(result.status, behavior === 'none' || (behavior === 'endpoint' && finalMatches) ? 'PASS' : 'FAIL');
      if (result.status === 'PASS') {
        assert.equal(result.completed, 2);
        assert.equal(result.compared, behavior === 'none' ? 0 : 1);
        assert.equal((await runTests([plan], async () => result, new AbortController().signal))[0].status, 'PASS');
      }
    }
  });
  test(`${behavior} rejects incomplete execution`, async () => {
    const plan = { ...qualifiedTests([vector('take')])[0], behavior };
    const f = runtime(plan);
    f.update(1, '>'); f.tick(); f.tick(30000); await Promise.resolve();
    assert.equal(f.messages.at(-1).status, 'FAIL');
    assert.equal((await runTests([plan], async () => ({ status: 'PASS', completed: 0, compared: behavior === 'none' ? 0 : 1 }), new AbortController().signal))[0].status, 'FAIL');
  });
}
