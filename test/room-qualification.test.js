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
const { installSkeinPlayback } = require('../skein-playback-adapter');
const { installRoomQualification } = require('../room-qualification');
const { observeShowme } = require('../showme-observation');

function runtime(commands = ['wait', 'wait', 'n'], prompt = '>') {
  const timers = new Map(), events = [], messages = [], displayed = [];
  let next = 0;
  class GlkOte {
    init(iface) { this.iface = iface; }
    getinterface() { return this.iface; }
    update(output) { displayed.push(output); }
    error() {}
  }
  const context = vm.createContext({ setTimeout(fn) { timers.set(++next, fn); return next; }, clearTimeout(id) { timers.delete(id); } });
  const install = vm.runInContext(`(${installRoomQualification.toString()})`, context);
  const playback = vm.runInContext(`(${installSkeinPlayback.toString()})`, context);
  const options = {};
  const adapter = install(options, GlkOte, commands, 'qualification', message => messages.push(message), playback, observeShowme);
  options.GlkOte.init({ accept(event) { events.push(event); } });
  adapter.started();
  return { events, messages, displayed, adapter, error: message => options.GlkOte.error(message),
    update(gen, text, extra = {}) {
      options.GlkOte.update({ type: 'update', gen, windows: [{ id: 7, type: 'buffer' }, { id: 8, type: 'grid' }],
        input: [{ id: 7, gen, type: 'line', maxlen: 256 }],
        content: [{ id: 8, lines: [{ content: ['normal', 'UNTRUSTED STATUS ROOM'] }] },
          { id: 7, text: [...(text === undefined ? [] : [{ append: true, content: ['input', 'showme'] }, ...text.split('\n').map(line => ({ content: ['normal', line] })), {}]), { content: ['normal', prompt] }] }], ...extra });
    },
    tick() { const callbacks = [...timers.values()]; timers.clear(); for (const cb of callbacks) cb(); }
  };
}

test('queries START before recorded commands and END after final settled command; does not submit root', () => {
  const f = runtime();
  f.update(1, 'Unrelated startup narrative'); f.tick();
  assert.deepEqual(f.events.map(e => e.value), ['showme']);
  f.update(2, "Ripening Room - room\n    yourself - person"); f.tick();
  f.update(3, 'wait result'); f.tick();
  f.update(4, 'wait result'); f.tick();
  f.update(5, 'north result');
  assert.equal(f.events.length, 4, 'final recorded command finished; END diagnostic not yet submitted');
  f.tick();
  assert.deepEqual(f.events.map(e => e.value), ['showme', 'wait', 'wait', 'n', 'showme']);
  assert.ok(!f.messages.some(m => m.kind === 'complete'));
  f.update(6, "Defect'n Room - room\n    yourself - person"); f.tick();
  const result = f.messages.at(-1);
  assert.equal(result.kind, 'complete');
  assert.deepEqual(JSON.parse(JSON.stringify(result.endpoints)), { start: observeShowme(['Ripening Room - room', '    yourself - person']), end: observeShowme(["Defect'n Room - room", '    yourself - person']) });
  assert.equal(result.submitted, 5);
});

for (const text of ['', '   ', '\nLater line must not become the location']) {
  test(`missing first diagnostic line fails: ${JSON.stringify(text)}`, () => {
    const f = runtime(); f.update(1); f.tick(); f.update(2, text); f.tick();
    assert.equal(f.messages.at(-1).kind, 'stopped');
    assert.match(f.messages.at(-1).message, /start SHOWME/);
    assert.equal(f.events.length, 1);
  });
}

test('missing END room fails instead of accepting START twice', () => {
  const f = runtime(['n']);
  f.update(1); f.tick(); f.update(2, 'Start - room'); f.tick(); f.update(3); f.tick();
  f.update(4); f.tick();
  assert.equal(f.messages.at(-1).kind, 'stopped');
  assert.match(f.messages.at(-1).message, /end SHOWME/);
});

for (const extra of [{ input: [{ id: 7, type: 'char', gen: 1 }] }, { specialinput: {} }, { exit: true }, { disable: true }]) {
  test(`qualification refuses unsupported interaction ${JSON.stringify(extra)}`, () => {
    const f = runtime(); f.update(1, undefined, extra); f.tick();
    assert.equal(f.messages.at(-1).kind, 'stopped'); assert.equal(f.events.length, 0);
  });
}

test('room diagnostic preserves punctuation and spacing and ignores repeated output generation', () => {
  const f = runtime([]);
  f.update(1); f.tick();
  f.update(2, 'A & <B>  - room'); f.update(2, 'Spoof - room'); f.tick();
  f.update(3, 'C "D" - room'); f.tick();
  assert.equal(f.messages.at(-1).endpoints.start.location, 'A & <B>  - room');
  assert.equal(f.messages.at(-1).endpoints.end.location, 'C "D" - room');
});

test('opaque Unicode labels, custom prompt, contents changes and blank diagnostic lines are retained', () => {
  const f = runtime([], '¿Orden? ');
  const first = ['  Salle de mûrissement — pièce 🍑  ', '    boîte\t  ', '', '    pêche  ', ''];
  const second = ['  Salle de mûrissement — pièce 🍑  ', '    boîte\t  ', '', '    poire  ', ''];
  f.update(1); f.tick(); f.update(2, first.join('\n')); f.tick(); f.update(3, second.join('\n')); f.tick();
  const { start, end } = f.messages.at(-1).endpoints;
  assert.deepEqual(JSON.parse(JSON.stringify(start)), observeShowme(first));
  assert.deepEqual(JSON.parse(JSON.stringify(end)), observeShowme(second));
  assert.equal(start.location, first[0]); assert.equal(start.location, end.location);
  assert.notEqual(start.observation, end.observation);
});

test('capture joins split echo/text runs and updates; excludes other windows and repeated generations', () => {
  const f = runtime([]);
  f.update(1); f.tick();
  f.update(2, undefined, { input: [], content: [{ id: 7, text: [
    { append: true, content: ['input', 'sho', 'input', 'wme'] },
    { content: ['normal', '場所'] }
  ] }] });
  f.update(3, undefined, { content: [
    { id: 99, text: [{ content: ['normal', 'unrelated'] }] },
    { id: 7, text: [{ append: true, content: [{ style: 'normal', text: ' 🍑  ' }] },
      { content: ['input', '    diagnostic styled as input'] }, {}, { content: ['normal', '>'] }] }
  ] });
  assert.ok(!f.displayed.at(-2).content.some(block => block.id === 7));
  assert.deepEqual(Array.from(f.displayed.at(-1).content, block => block.id), [99]);
  f.tick();
  f.update(4, 'End'); f.tick();
  assert.deepEqual(JSON.parse(JSON.stringify(f.messages.at(-1).endpoints.start)),
    observeShowme(['場所 🍑  ', '    diagnostic styled as input']));
});

test('unrecognized or changed trailing prompt fails instead of hashing transport text', () => {
  const f = runtime([]); f.update(1); f.tick();
  f.update(2, undefined, { content: [{ id: 7, text: [{ content: ['normal', 'Location'] }, {}, { content: ['normal', 'changed prompt'] }] }] });
  f.tick();
  assert.equal(f.messages.at(-1).kind, 'stopped');
  assert.match(f.messages.at(-1).message, /trailing command prompt/);
});

test('output after the diagnostic settles cannot contaminate its observation', () => {
  const f = runtime([]);
  f.update(1); f.tick();
  f.update(2, 'Location\n    peach');
  f.update(3, 'Unrelated timer output'); // Before the scheduler's deferred callback.
  f.tick();
  f.update(4, 'End'); f.tick();
  assert.deepEqual(JSON.parse(JSON.stringify(f.messages.at(-1).endpoints.start)), observeShowme(['Location', '    peach']));
});

function quittingRuntime() {
  const f = runtime(['quit', 'y']);
  f.update(1); f.tick(); f.update(2, 'Room'); f.tick(); f.update(3); f.tick();
  assert.deepEqual(f.events.map(e => e.value), ['showme', 'quit', 'y']);
  return f;
}
test('normal final quit/y exit qualifies termination without an END SHOWME', () => {
  const f = quittingRuntime();
  f.update(4, undefined, { exit: true, disable: true, input: [] }); f.tick();
  assert.equal(f.messages.at(-1).kind, 'complete');
  assert.deepEqual(JSON.parse(JSON.stringify(f.messages.at(-1).endpoints)), { start: observeShowme(['Room']), end: { type: 'termination' } });
  assert.equal(f.events.length, 3);
});
test('fatal runtime error followed by exit is never successful termination', () => {
  const f = quittingRuntime();
  f.error('VM division by zero');
  f.update(4, undefined, { exit: true, disable: true, input: [] }); f.tick();
  assert.equal(f.messages.at(-1).kind, 'stopped');
  assert.ok(!f.messages.some(m => m.kind === 'complete'));
});
for (const extra of [{ disable: true, input: [] }, { input: [] }, { specialinput: {}, exit: true, input: [] }]) {
  test(`abnormal final loss of input is not termination: ${JSON.stringify(extra)}`, () => {
    const f = quittingRuntime(); f.update(4, undefined, extra); f.tick();
    assert.ok(!f.messages.some(m => m.kind === 'complete'));
  });
}
test('termination during END SHOWME qualification is rejected', () => {
  const f = quittingRuntime(); f.update(4); f.tick();
  f.update(5, undefined, { exit: true, input: [] }); f.tick();
  assert.equal(f.messages.at(-1).kind, 'stopped');
});

test('normal exit before all recorded commands is rejected', () => {
  const f = runtime(['quit', 'y', 'look']);
  f.update(1); f.tick(); f.update(2, 'Room'); f.tick(); f.update(3); f.tick();
  f.update(4, undefined, { exit: true, disable: true, input: [] }); f.tick();
  assert.equal(f.messages.at(-1).kind, 'stopped');
  assert.ok(!f.messages.some(m => m.kind === 'complete'));
});


test('automatic probes stay hidden while recorded SHOWME and ordinary output remain visible', () => {
  const f = runtime(['showme']);
  f.update(1, 'Startup narrative'); f.tick();
  f.update(2, 'Start - room');
  assert.deepEqual(Array.from(f.displayed.at(-1).content, block => block.id), [8]);
  assert.equal(f.displayed.at(-1).input[0].id, 7);
  f.tick();
  f.update(3, 'Recorded SHOWME - room'); f.tick();
  assert.match(JSON.stringify(f.displayed.at(-1)), /Recorded SHOWME/);
  f.update(4, 'End - room'); f.tick();
  assert.deepEqual(Array.from(f.displayed.at(-1).content, block => block.id), [8]);
  assert.equal(f.messages.at(-1).endpoints.start.location, 'Start - room');
  assert.equal(f.messages.at(-1).endpoints.end.location, 'End - room');
  f.update(5, 'Ordinary output after qualification');
  assert.match(JSON.stringify(f.displayed.at(-1)), /Ordinary output after qualification/);
});

test('startup character sequence precedes START SHOWME; later pauses retain their positions', () => {
  const f = runtime([{ type: 'char', value: 'x' }, { type: 'char', value: ' ' }, 'wait', { type: 'char', value: 'return' }]);
  const char = gen => ({ input: [{ type: 'char', id: 7, gen }] });
  f.update(1, undefined, char(1)); f.tick();
  f.update(2, undefined, char(2)); f.tick();
  f.update(3); f.tick();
  f.update(4, 'Starting Room - room'); f.tick();
  f.update(5, undefined, char(5)); f.tick();
  f.update(6); f.tick();
  f.update(7, 'Starting Room - room'); f.tick();
  assert.deepEqual(f.events.map(e => [e.type, e.value]), [['char', 'x'], ['char', ' '], ['line', 'showme'], ['line', 'wait'], ['char', 'return'], ['line', 'showme']]);
  assert.equal(f.messages.at(-1).kind, 'complete');
  assert.equal(f.messages.at(-1).endpoints.start.location, 'Starting Room - room');
});
