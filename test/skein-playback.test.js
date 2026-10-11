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
const vm = require('node:vm');
const { Skein, parseLinearSkein } = require('../skein');
const { installSkeinPlayback } = require('../skein-playback-adapter');

function recorded(commands) {
  let id = 0;
  const skein = new Skein({ id: () => `n${id++}` });
  for (const command of commands) {
    const item = skein.item(command);
    skein.items.at(-1).childId = item.id;
    skein.items.push(item);
  }
  return skein.serialize();
}

test('linear parser omits root, retains exact command text/order/repeats, ignores results and state', () => {
  const commands = ['wait', 'wait', 'n', 'look', 's', '', '  "<&\' 🍑  '];
  const source = recorded(commands);
  assert.deepEqual(parseLinearSkein(source), commands);
  assert.deepEqual(parseLinearSkein(source.replace('<played>YES</played>', '<played>NO</played>').replace('score="0"', 'score="999"')), commands);
  assert.deepEqual(parseLinearSkein(recorded([])), []);
  assert.deepEqual(parseLinearSkein(recorded(['&']).replace('&amp;', '&#38;')), ['&']);
});

for (const [name, change] of [
  ['branch', s => s.replace('<child nodeId="n1"/>', '<child nodeId="n1"/><child nodeId="n2"/>')],
  ['cycle', s => s.replace('<child nodeId="n2"/>', '<child nodeId="n0"/>')],
  ['dangling', s => s.replace('<child nodeId="n2"/>', '<child nodeId="missing"/>')],
  ['disconnected', s => s.replace(/\s*<children>[\s\S]*?<\/children>/, '')],
  ['duplicate', s => s.replace('<item nodeId="n2">', '<item nodeId="n1">')],
  ['wrong root', s => s.replace('- start -', 'start')],
  ['invalid active', s => s.replace('<activeNode nodeId="n0"/>', '<activeNode nodeId="absent"/>')],
  ['truncated', s => s.slice(0, -10)],
  ['trailing', s => s + '<other/>'],
  ['invalid entity', s => s.replace('wait', '&unknown;')],
  ['invalid scalar', s => s.replace('wait', '&#0;')],
  ['out-of-range scalar', s => s.replace('wait', '&#x110000;')],
  ['multiline command', s => s.replace('wait', 'wait&#13;look')],
  ['DTD', s => s.replace('<Skein ', '<!DOCTYPE Skein><Skein ')],
  ['mismatched tag', s => s.replace('</result>', '</command>')]
]) test(`linear parser rejects ${name}`, () => {
  assert.throws(() => parseLinearSkein(change(recorded(['wait', 'look']))), /Cannot play Skein/);
});

function runtime(commands, observer = {}) {
  const timers = new Map(), events = [], messages = [], displays = [];
  let next = 0, onAccept = () => {};
  class GlkOte {
    init(iface) { this.iface = iface; }
    getinterface() { return this.iface; }
    update(output) { displays.push(output); }
    error() {}
  }
  const install = vm.runInNewContext(`(${installSkeinPlayback.toString()})`, {
    setTimeout(fn) { const id = ++next; timers.set(id, fn); return id; },
    clearTimeout(id) { timers.delete(id); }
  });
  const options = {};
  const adapter = install(options, GlkOte, commands, 'session', message => messages.push(message), observer);
  const glkote = options.GlkOte;
  glkote.init({ accept(event) { events.push(JSON.parse(JSON.stringify(event))); onAccept(event); } });
  adapter.started();
  return { adapter, options, glkote, events, messages, displays,
    accept(fn) { onAccept = fn; },
    update(gen, id = 7, requestGen = gen, extra = {}) {
      glkote.update({ type: 'update', gen, input: [{ type: 'line', id, gen: requestGen, maxlen: 256 }], ...extra });
    },
    tick() { const pending = [...timers.values()]; timers.clear(); for (const fn of pending) fn(); },
    pending: () => timers.size,
    callback: () => [...timers.values()][0]
  };
}

test('one command per request uses live generation/window; completion preserves human input', () => {
  const commands = ['wait', 'wait', 'n', 'look', 's'];
  const f = runtime(commands);
  assert.equal(f.options.do_vm_autosave, false);
  f.update(20, 99);
  for (let i = 0; i < commands.length; i++) {
    assert.equal(f.events.length, i, 'nothing submitted before timer');
    f.tick(); f.tick();
    assert.deepEqual(f.events[i], { type: 'line', gen: 20 + i, window: 99 + i, value: commands[i] });
    assert.equal(f.events.length, i + 1);
    f.update(21 + i, 100 + i);
  }
  f.tick();
  assert.equal(f.events.length, 5);
  assert.equal(f.messages.at(-1).kind, 'complete');
  f.update(30); f.tick();
  assert.equal(f.events.length, 5);
  f.glkote.getinterface().accept({ type: 'line', gen: 30, window: 7, value: 'human look' });
  assert.equal(f.events.at(-1).value, 'human look');
});

test('synchronous VM updates do not recursively submit and duplicate requests cannot consume another command', () => {
  const f = runtime(['wait', 'wait']);
  f.accept(() => f.update(2, 7, 1)); // Same pending request; not a new turn.
  f.update(1); f.tick();
  assert.equal(f.events.length, 1);
  f.tick(); assert.equal(f.events.length, 1);
  f.update(3, 8, 3); f.update(2, 7, 1); f.tick();
  assert.equal(f.events.length, 2);
  assert.equal(f.events[1].gen, 3);
});

test('resize/timer updates before submission use the newest generation for the same request', () => {
  const f = runtime(['look']);
  f.update(5, 80, 4);
  f.glkote.getinterface().accept({ type: 'arrange', gen: 5 });
  f.update(6, 80, 4); f.tick();
  assert.deepEqual(f.events.at(-1), { type: 'line', gen: 6, window: 80, value: 'look' });
});

for (const [name, extra] of [
  ['character', { input: [{ type: 'char', id: 7, gen: 1 }] }],
  ['file selection', { specialinput: { type: 'fileref_prompt' } }],
  ['hyperlink', { input: [{ id: 7, hyperlink: true }] }],
  ['mouse', { input: [{ id: 7, mouse: true }] }],
  ['multiple line windows', { input: [{ type: 'line', id: 7, gen: 1 }, { type: 'line', id: 8, gen: 1 }] }],
  ['exit', { exit: true }],
  ['disabled', { disable: true }]
]) test(`${name} stops automation, displays update, and keeps interpreter interface alive`, () => {
  const f = runtime(['wait']);
  f.update(1, 7, 1, extra); f.tick();
  assert.equal(f.events.length, 0);
  assert.equal(f.messages[0].kind, 'stopped');
  assert.equal(f.displays.length, 1);
  f.update(2); f.tick(); assert.equal(f.events.length, 0);
  f.glkote.getinterface().accept({ type: 'char', gen: 2, window: 7, value: 'y' });
  assert.equal(f.events.length, 1);
});

test('wrong-session/control messages cannot drive playback; stop cancels even an already queued callback', () => {
  const f = runtime(['wait', 'look']);
  f.update(1);
  f.adapter.receive({ type: 'skein.playback.stop', sessionId: 'old' });
  f.adapter.receive({ type: 'line', sessionId: 'session', value: 'rogue' });
  f.tick(); assert.equal(f.events.length, 1);
  f.update(2);
  const stale = f.callback();
  f.adapter.receive({ type: 'skein.playback.stop', sessionId: 'session' });
  stale(); f.tick();
  assert.equal(f.events.length, 1);
});

test('human intervention cancels pending playback; empty sequence completes without submitting root', () => {
  const f = runtime(['wait']);
  f.update(1);
  f.glkote.getinterface().accept({ type: 'line', gen: 1, window: 7, value: 'human' });
  f.tick(); assert.equal(f.events.length, 1);
  assert.match(f.messages[0].message, /human/);
  const empty = runtime([]);
  empty.update(1); empty.tick();
  assert.equal(empty.events.length, 0);
  assert.equal(empty.messages[0].kind, 'complete');
});

test('oversize command stops rather than allowing silent interpreter truncation', () => {
  const f = runtime(['look']);
  f.update(1, 7, 1, { input: [{ type: 'line', id: 7, gen: 1, maxlen: 2 }] });
  f.tick(); assert.equal(f.events.length, 0);
  assert.match(f.messages[0].message, /limit/);
});

test('parser rejects JavaScript-only whitespace that is malformed XML', () => {
  assert.throws(() => parseLinearSkein(recorded(['look']).replace('  <generator>', '\u00a0<generator>')), /Cannot play Skein/);
});

test('runtime error stops pending playback even when the runtime uses a private error function', () => {
  const f = runtime(['look']);
  f.update(1);
  f.glkote.update({ type: 'error', message: 'VM failed' });
  f.tick();
  assert.equal(f.events.length, 0);
  assert.match(f.messages[0].message, /VM failed/);
});

for (const scenario of ['normal', 'early', 'error', 'disabled', 'special', 'malformed', 'input on exit']) {
  test(`ISkein expected termination: ${scenario}`, () => {
    const f = runtime(['quit', 'y'], { termination: position => position === 2 });
    f.update(1); f.tick();
    if (scenario !== 'early') { f.update(2); f.tick(); }
    if (scenario === 'error') f.glkote.error('fatal VM error');
    const extra = { input: [], exit: true, disable: true };
    if (scenario === 'disabled') delete extra.exit;
    if (scenario === 'special') extra.specialinput = {};
    if (scenario === 'malformed') extra.exit = 'true';
    if (scenario === 'input on exit') extra.input = [{ type: 'line', id: 1, gen: 3 }];
    f.update(3, 7, 3, extra); f.tick();
    assert.equal(f.messages.length, 1);
    assert.equal(f.messages[0].kind, scenario === 'normal' ? 'complete' : 'stopped');
    assert.equal(f.pending(), 0);
  });
}

test('replays exact character keys and line commands only at matching requests', () => {
  const commands = [{ type: 'char', value: 'x' }, { type: 'char', value: ' ' }, 'look', { type: 'char', value: 'return' }];
  const f = runtime(commands);
  for (const [index, command] of commands.entries()) {
    const type = typeof command === 'string' ? 'line' : 'char';
    f.update(index + 1, 7, index + 1, { input: [{ type, id: 7, gen: index + 1, ...(type === 'line' ? { maxlen: 256 } : {}) }] });
    f.tick(); f.tick();
    assert.equal(f.events.length, index + 1);
    assert.deepEqual(f.events[index], { type, gen: index + 1, window: 7, value: typeof command === 'string' ? command : command.value });
  }
  f.update(5); f.tick();
  assert.equal(f.messages.at(-1).kind, 'complete');
  const wrong = runtime([{ type: 'char', value: 'q' }]);
  wrong.update(1); wrong.tick();
  assert.equal(wrong.events.length, 0);
  assert.match(wrong.messages.at(-1).message, /does not match/);
});
