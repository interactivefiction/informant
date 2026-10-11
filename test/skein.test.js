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
const { Skein } = require('../skein');
const { installSkeinRecording } = require('../skein-recording-adapter');

const windows = [{ id: 1, type: 'buffer' }, { id: 2, type: 'grid' }, { id: 3, type: 'graphics' }];
function update(gen, text, input = null, extra = {}) {
  return { input, output: { type: 'update', gen, windows, content: [{ id: 1, text }], input: [{ id: 1, type: 'line', gen }], ...extra } };
}
const para = (text, append = true, style = 'normal') => ({ append, content: [style, text] });
function model(warn) { let id = 0; return new Skein({ id: () => `node-${id++}`, warn }); }

test('root-only XML exactly matches the demonstrated structure and initial values', () => {
  const skein = model();
  assert.equal(skein.serialize(), `<?xml version="1.0" encoding="UTF-8"?>
<Skein rootNode="node-0" xmlns="http://www.logicalshift.org.uk/IF/Skein">
  <generator>Inform 7</generator>
  <activeNode nodeId="node-0"/>
  <item nodeId="node-0">
    <command xml:space="preserve">- start -</command>
    <result xml:space="preserve"></result>
    <commentary xml:space="preserve"></commentary>
    <played>YES</played>
    <changed>NO</changed>
    <temporary score="0">YES</temporary>
    <annotation xml:space="preserve"></annotation>
  </item>
</Skein>
`);
});

test('startup, multiline paragraphs, Unicode, styles, prompts, and narrative windows are preserved', () => {
  const skein = model();
  skein.consume(update(1, [{}, {}, {}, {}, { append: true, content: ['header', 'Peaches 🍑', { style: 'normal', text: ' & crème' }] }, {}, para('Room', false), {}, para('>', false)], null));
  skein.consume(update(2, [para(' ')], { type: 'arrange', gen: 1 }, {
    windows: undefined,
    content: [{ id: 2, lines: [{ content: ['normal', 'STATUS SCORE 9'] }] }, { id: 3, draw: [{}] }, { id: 1, text: [para(' ')] }]
  }));
  assert.equal(skein.items[0].result, '\n\n\n\nPeaches 🍑 & crème\n\nRoom\n\n> ');
  assert.equal(skein.items.length, 1);
  assert.ok(skein.ready);
});

test('commands create a linear path; only the actual echo and its newline are removed', () => {
  const skein = model();
  skein.consume(update(1, [para('Start'), {}, para('>', false)]));
  skein.consume(update(2, [para('wait', true, 'input'), para('First paragraph.', false), {}, para('Second paragraph.', false), {}, para('>', false)], { type: 'line', value: 'wait', window: 1, gen: 1 }));
  skein.consume(update(3, [para('wait', true, 'input'), para('wait', false, 'input'), para(' is narrative.', true), {}, para('>', false)], { type: 'line', value: 'wait', window: 1, gen: 2 }));
  assert.deepEqual(skein.items.map(i => i.command), ['- start -', 'wait', 'wait']);
  assert.equal(skein.items[1].result, 'First paragraph.\n\nSecond paragraph.\n\n>');
  assert.equal(skein.items[2].result, 'wait is narrative.\n\n>');
  assert.equal(new Set(skein.items.map(i => i.id)).size, 3);
  assert.deepEqual(skein.items.map(i => i.childId), ['node-1', 'node-2', null]);
  assert.equal((skein.serialize().match(/<child nodeId=/g) || []).length, 2);
  assert.equal((skein.serialize().match(/<played>NO<\/played>\n    <changed>YES<\/changed>/g) || []).length, 2);
  assert.match(skein.serialize(), /<activeNode nodeId="node-0"\/>/);
});

test('split echoes and intermediate updates accumulate without creating timer/resize commands', () => {
  const skein = model();
  skein.consume(update(1, [para('>')]));
  skein.consume(update(2, [para('wa', true, 'input')], { type: 'line', value: 'wait', window: 1, gen: 1 }, { input: [] }));
  skein.consume(update(3, [para('it', true, 'input')], null, { input: [] }));
  skein.consume(update(4, [para('First', false)], { type: 'timer', gen: 3 }, { input: [] }));
  skein.consume(update(5, [para(' second'), {}, para('>', false)], { type: 'arrange', gen: 4 }));
  assert.equal(skein.items[1].result, 'First second\n\n>');
  assert.equal(skein.items.length, 2);
  skein.consume(update(5, [para('duplicate')]));
  skein.consume(update(2, [para('old')]));
  assert.equal(skein.items[1].result, 'First second\n\n>');
});

test('packaged Glk null lists mean unchanged windows or no content', () => {
  const skein = model();
  skein.consume(update(1, [para('>')]));
  skein.consume(update(2, [], { type: 'arrange', gen: 1 }, { windows: null, content: null, input: null }));
  skein.consume(update(3, [para('More')], null, { windows: null }));
  assert.equal(skein.items[0].result, '>More');
});

test('echo disabled, unmatched input styling, and uncertain partial echoes preserve text', () => {
  const skein = model();
  skein.consume(update(1, [para('>')]));
  skein.consume(update(2, [para('Narrative', false, 'input')], { type: 'line', value: 'wait', window: 1, gen: 1 }));
  assert.equal(skein.items[1].result, '\nNarrative');
  skein.consume(update(3, [para('wa', true, 'input')], { type: 'line', value: 'wait', window: 1, gen: 2 }));
  skein.flushEcho();
  assert.equal(skein.items[2].result, 'wa');
});

test('empty line keeps ambiguous newline and warns once, without general whitespace trimming', () => {
  const warnings = [];
  const skein = model(message => warnings.push(message));
  skein.consume(update(1, [para('>')]));
  for (let gen = 2; gen <= 3; gen++) skein.consume(update(gen, [para('  Answer  ', false), {}, para('>', false)], { type: 'line', value: '', window: 1, gen: gen - 1 }));
  assert.deepEqual(skein.items.slice(1).map(i => i.command), ['', '']);
  assert.equal(skein.items[1].result, '\n  Answer  \n\n>');
  assert.equal(warnings.length, 1);
});

test('clear does not erase history; subsequent narrative buffers retain protocol ordering', () => {
  const skein = model();
  skein.consume(update(1, [para('Before')]));
  skein.consume(update(2, [], null, { windows: [{ id: 4, type: 'buffer' }, ...windows], content: [
    { id: 1, clear: true, text: [para('After', false)] }, { id: 4, text: [para('Another')] }
  ] }));
  assert.equal(skein.items[0].result, 'Before\nAfterAnother');
});

test('normal exit consumes final output; substantive non-line input is rejected', () => {
  const skein = model();
  skein.consume(update(1, [para('Goodbye')], null, { input: [], exit: true, disable: true }));
  assert.equal(skein.items[0].result, 'Goodbye');
  assert.ok(skein.exited && skein.ready);
  for (const type of ['hyperlink', 'mouse', 'specialresponse', 'external', 'debuginput']) {
    assert.throws(() => model().consume(update(1, [], { type, value: 'x' })), /does not support/);
  }
});

test('XML escapes text, preserves CR, and rejects invalid XML characters', () => {
  const skein = model();
  skein.items[0].result = '<&>"\'\r🍑';
  assert.match(skein.serialize(), /&lt;&amp;&gt;&quot;&apos;&#13;🍑/);
  for (const invalid of ['\0', '\u0001', '\ud800', '\uffff']) {
    skein.items[0].result = invalid;
    assert.throws(() => skein.serialize(), /XML 1.0/);
  }
});

test('adapter uses the supplied active instance and copies callbacks synchronously', async () => {
  const messages = [], options = {};
  class GlkOte { error() {} }
  const adapter = installSkeinRecording(options, GlkOte, m => messages.push(m), 'session', assert.fail);
  assert.ok(options.GlkOte instanceof GlkOte);
  assert.equal(options.recording_format, 'glkote');
  assert.equal(options.do_vm_autosave, false);
  const state = update(1, [para('Startup')]);
  options.recording_handler(state);
  state.output.content[0].text[0].content[1] = 'mutated';
  state.input = null; state.output = null;
  assert.equal(messages[0].payload.output.content[0].text[0].content[1], 'Startup');
  await Promise.resolve();
  assert.equal(messages.length, 1, 'not ready before loader success');
  adapter.started(); await Promise.resolve();
  assert.deepEqual(messages.map(m => [m.sessionId, m.sequence, m.kind]), [['session', 1, 'update'], ['session', 2, 'ready']]);
});

test('adapter suppresses pending ready on initialization failure and reports fatal Glk errors', async () => {
  for (const failViaGlk of [false, true]) {
    const messages = [], errors = [], options = {};
    const adapter = installSkeinRecording(options, class { error() {} }, m => messages.push(m), 's', m => errors.push(m));
    options.recording_handler(update(1, []));
    adapter.started();
    if (failViaGlk) options.GlkOte.error('failed'); else adapter.fail('failed');
    await Promise.resolve();
    assert.deepEqual(messages.map(m => m.kind), ['update', 'error']);
    assert.deepEqual(errors, ['failed']);
  }
});

test('character pauses preserve exact keys, consecutive requests, and output across screen clears', () => {
  const { parseLinearSkein, parseLinearSkeinTurns } = require('../skein');
  const skein = model();
  skein.consume(update(1, [para('Please press SPACE')], null, { input: [{ id: 1, type: 'char', gen: 1 }] }));
  assert.ok(skein.ready);
  const keys = ['x', ' ', 'return', 'left', 'é'];
  keys.forEach((value, index) => skein.consume(update(index + 2, [para(`Response ${index}`, false, 'input')],
    { type: 'char', value, gen: index + 1, window: 1 }, { content: [{ id: 1, clear: true, text: [para(`Response ${index}`, false, 'input')] }] })));
  skein.consume(update(7, [para('look', true, 'input'), para('Room', false)], { type: 'line', value: 'look', gen: 6, window: 1 }));
  assert.deepEqual(parseLinearSkein(skein.serialize()), [...keys.map(value => ({ type: 'char', value })), 'look']);
  assert.equal(skein.items[0].result, 'Please press SPACE');
  assert.equal(parseLinearSkeinTurns(skein.serialize())[0].result, '\nResponse 0', 'character output is not stripped as a line echo');
  assert.equal(skein.items.at(-1).result, 'Room');
  assert.throws(() => parseLinearSkein(skein.serialize().replace('input="char"', 'input="mouse"')), /Cannot play/);
  assert.throws(() => parseLinearSkein(skein.serialize().replace('>x</command>', '>bogus</command>')), /character key/);
});

test('invalid character keys are rejected before a node is appended', () => {
  for (const value of ['', 'bogus', '\n', '\0', '\ud800']) {
    const skein = model();
    assert.throws(() => skein.consume(update(2, [], { type: 'char', value, gen: 1, window: 1 })), /character key/);
    assert.equal(skein.items.length, 1);
  }
});

test('recording adapter announces startup readiness at a character prompt', async () => {
  const messages = [], options = {};
  const adapter = installSkeinRecording(options, class { error() {} }, message => messages.push(message), 's', assert.fail);
  options.recording_handler(update(1, [para('Press SPACE')], null, { input: [{ id: 1, type: 'char', gen: 1 }] }));
  adapter.started(); await Promise.resolve();
  assert.deepEqual(messages.map(message => message.kind), ['update', 'ready']);
});
