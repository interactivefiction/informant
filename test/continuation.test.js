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
const vm = require('node:vm');
const { WorkingISkein, workingPath, readWorking, workingState, ensureNoWorking, acceptContinuation, discardContinuation } = require('../working-iskein');
const { parseVector, discoverTestVectors } = require('../test-vector-library');
const { installPlayableContinuation } = require('../playable-continuation');
const { installCompositionPlayback } = require('../composition-playback');
const { installContinuation } = require('../continuation-adapter');
const { installSkeinPlayback } = require('../skein-playback-adapter');
const { installRoomQualification } = require('../room-qualification');
const { observeShowme } = require('../showme-observation');
const start = observeShowme(['Original room 🍑', '    yourself']);

async function host(t, io = fs) {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'informant-continuation-'));
  t.after(async () => { await discardContinuation(project); await fs.rm(project, { recursive: true, force: true }); });
  await fs.writeFile(path.join(project, 'Skein.skein'), 'Original Skein');
  const session = new WorkingISkein(project, 'Source vector', { io });
  let sequence = 0;
  const send = (kind, payload) => session.receive({ type: 'iskein.continuation', sessionId: session.sessionId, sequence: ++sequence, kind, payload });
  send('ready', { start, output: { type: 'update', gen: 8, windows: [{ id: 7, type: 'buffer' }], input: [{ type: 'line', id: 7, gen: 8 }], content: [] } });
  await session.queue;
  let gen = 8;
  function turn(command, text = '  Résultat 🍑\n>', extra = {}) {
    const input = { type: 'line', value: command, gen: gen++, window: 7 };
    send('update', { input, output: { type: 'update', gen, input: [{ id: 7, gen, type: 'line' }],
      content: [{ id: 7, text: [{ append: true, content: ['input', command] }, { content: ['normal', text] }] }], ...extra } });
  }
  return { project, session, send, turn };
}

test('Working ISkein initializes a GUID and qualified START, remains continuation in original room, and excludes replay', async t => {
  const f = await host(t), working = await readWorking(f.project);
  assert.equal(working.guid, f.session.guid); assert.equal(working.entry, 'continuation');
  assert.deepEqual(working.start, start); assert.deepEqual(working.turns, []);
  assert.equal(working.end, undefined);
  const xml = await fs.readFile(workingPath(f.project), 'utf8');
  assert.match(xml, /<working-iskein version="4">/); assert.doesNotMatch(xml, /Source vector|predecessor|<end /);
  assert.throws(() => parseVector(xml), /expected iskein/);
  assert.deepEqual((await discoverTestVectors(f.project)).vectors, []);
  await assert.rejects(ensureNoWorking(f.project), /Accept or discard/);
  await assert.rejects(f.session.accept(''), /at least one/);
});

for (const terminal of [false, true]) test(`accept preserves working GUID, repeated Unicode turns and results (${terminal ? 'termination' : 'location'})`, async t => {
  const f = await host(t);
  f.turn('attendre 🍑'); f.turn('attendre 🍑');
  if (terminal) {
    f.turn('quit', 'Confirm?'); f.turn('y', '', { exit: true, disable: true, input: [] });
    f.send('ended', { type: 'termination' });
  }
  await f.session.queue;
  const before = await readWorking(f.project);
  const end = terminal ? { type: 'termination' } : observeShowme(['Other room', '    peach']);
  f.session.send = message => {
    if (message.type === 'iskein.continuation.accept') f.send('ended', end);
    if (message.type === 'iskein.continuation.resume') f.send('ready', { start: end, output: { type: 'update', gen: 8, windows: [{ id: 7, type: 'buffer' }], content: [] } });
  };
  const accepted = await f.session.accept('');
  assert.equal(accepted.guid, before.guid); assert.equal(accepted.entry, 'continuation');
  assert.equal(accepted.name, `${start.location} ${before.guid.slice(-4).toUpperCase()}`);
  assert.deepEqual(accepted.start, start); assert.deepEqual(accepted.end, end);
  assert.deepEqual(accepted.turns, before.turns);
  assert.equal(accepted.turns[0].command, accepted.turns[1].command);
  assert.equal(accepted.turns[0].result, '  Résultat 🍑\n>');
  const xml = await fs.readFile(accepted.file, 'utf8');
  assert.equal(parseVector(xml).entry, 'continuation');
  assert.equal((await discoverTestVectors(f.project)).vectors.length, 1);
  assert.equal((await workingState(f.project)).exists, !terminal);
  assert.equal(await fs.readFile(path.join(f.project, 'Skein.skein'), 'utf8'), 'Original Skein');
});

test('failed atomic publication preserves Working ISkein and can be retried', async t => {
  let fail = true;
  const f = await host(t, { ...fs, link: async (...args) => { if (fail) throw new Error('Simulated full disk'); return fs.link(...args); } });
  f.turn('look'); await f.session.queue;
  const before = await readWorking(f.project);
  f.session.send = message => { if (message.type === 'iskein.continuation.accept') f.send('ended', start); };
  await assert.rejects(f.session.accept('Name'), /full disk/);
  assert.deepEqual((await readWorking(f.project)).turns, before.turns);
  assert.deepEqual(await fs.readdir(path.join(f.project, '.informant', 'test-vectors')), []);
  fail = false;
  assert.equal((await f.session.accept('Name')).guid, before.guid);
});

test('existing GUID collision never overwrites an accepted vector', async t => {
  const f = await host(t); f.turn('look'); await f.session.queue;
  const directory = path.join(f.project, '.informant', 'test-vectors'); await fs.mkdir(directory);
  const file = path.join(directory, `${f.session.guid}.iskein`); await fs.writeFile(file, 'immutable existing vector');
  f.session.send = () => f.send('ended', start);
  await assert.rejects(f.session.accept(''), /EEXIST/);
  assert.equal(await fs.readFile(file, 'utf8'), 'immutable existing vector');
  assert.equal((await readWorking(f.project)).turns.length, 1);
});

test('failure removing working file rolls back only the just-published vector', async t => {
  let block = false;
  const f = await host(t, { ...fs, unlink: async file => { if (block && file.endsWith('/iskein.iskein')) throw new Error('Removal denied'); return fs.unlink(file); } });
  f.turn('look'); await f.session.queue; block = true;
  f.session.send = () => f.send('ended', start);
  await assert.rejects(f.session.accept(''), /Removal denied/);
  assert.equal((await discoverTestVectors(f.project)).vectors.length, 0);
  assert.equal((await readWorking(f.project)).turns.length, 1);
});

test('discard drains queued checkpoints, clears context, and does not create library vectors or touch Skein', async t => {
  const f = await host(t); f.turn('wait'); f.turn('wait');
  await discardContinuation(f.project);
  f.turn('late message'); await f.session.queue;
  await assert.rejects(fs.stat(workingPath(f.project)), /ENOENT/);
  assert.equal((await workingState(f.project)).exists, false);
  assert.equal((await discoverTestVectors(f.project)).vectors.length, 0);
  assert.equal(await fs.readFile(path.join(f.project, 'Skein.skein'), 'utf8'), 'Original Skein');
});

for (const fault of ['error', 'out of order', 'closed']) test(`unhealthy ${fault} session preserves work and cannot accept`, async t => {
  const f = await host(t); f.turn('look'); await f.session.queue;
  const before = await fs.readFile(workingPath(f.project));
  if (fault === 'closed') await f.session.finalize();
  else if (fault === 'error') f.send('error', 'VM fatal error');
  else f.session.receive({ type: 'iskein.continuation', sessionId: f.session.sessionId, sequence: 999, kind: 'ended', payload: { type: 'termination' } });
  await assert.rejects(f.session.accept(''), /healthy live/);
  assert.deepEqual(await fs.readFile(workingPath(f.project)), before);
  assert.equal((await workingState(f.project)).canAccept, false);
});

test('managed working path rejects symlinks outside the project without changing their targets', async t => {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'informant-containment-'));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'informant-outside-'));
  t.after(async () => { await fs.rm(project, { recursive: true, force: true }); await fs.rm(outside, { recursive: true, force: true }); });
  await fs.writeFile(path.join(outside, 'iskein.iskein'), 'untouched');
  await fs.mkdir(path.join(project, '.informant'));
  await fs.symlink(outside, path.join(project, '.informant', 'working'));
  await assert.rejects(readWorking(project), /project-contained/);
  await assert.rejects(discardContinuation(project), /project-contained/);
  assert.equal(await fs.readFile(path.join(outside, 'iskein.iskein'), 'utf8'), 'untouched');
});

function runtime(playable, endpoint = 'location') {
  const timers = new Map(), events = [], messages = [], displayed = [];
  let next = 0, input, generation = 0;
  const options = {};
  class GlkOte {
    init(iface) { this.iface = iface; }
    getinterface() { return this.iface; }
    update(output) { displayed.push(JSON.stringify(output)); options.recording_handler({ input, output }); input = undefined; }
    error() {}
  }
  const scope = vm.createContext({ setTimeout(fn, delay) { timers.set(++next, { fn, delay }); return next; }, clearTimeout(id) { timers.delete(id); } });
  const embed = fn => vm.runInContext(`(${fn.toString()})`, scope);
  const post = message => messages.push(JSON.parse(JSON.stringify(message)));
  const playback = embed(installSkeinPlayback), qualification = embed(installRoomQualification), continuation = embed(installContinuation);
  const adapter = playable ? embed(installPlayableContinuation)(options, 'replay', endpoint, post,
    notify => playable === 'composition'
      ? embed(installCompositionPlayback)(options, GlkOte, { name: 'Nested route', guid: 'root', commands: ['wait', 'north'], endpoint,
        leaves: [{ context: 'root/member 1', end: 1 }, { context: 'root/child/member 1', end: 2 }] }, 'replay', notify, playback)
      : playback(options, GlkOte, ['wait', 'north'], 'replay', notify, { termination: n => endpoint === 'termination' && n === 2 }),
    continuation, playback, qualification, observeShowme)
    : continuation(options, GlkOte, ['wait', 'north'], 'continuation', post, playback, qualification, observeShowme);
  const glkote = options.GlkOte;
  // Mimic Glk retaining the callback registered when the VM starts.
  const recordingHandler = options.recording_handler;
  glkote.update = ((update) => function(output) {
    const handler = options.recording_handler;
    options.recording_handler = recordingHandler;
    try { return update.call(this, output); } finally { options.recording_handler = handler; }
  })(glkote.update);
  glkote.init({ accept(event) { events.push(event); input = event; } }); adapter.started();
  function update(text, extra = {}) {
    const gen = ++generation;
    const paragraphs = [];
    if (input?.value) paragraphs.push({ append: true, content: ['input', input.value] });
    if (text !== undefined) paragraphs.push(...text.split('\n').map(line => ({ content: ['normal', line] })), {});
    paragraphs.push({ content: ['normal', '>'] });
    glkote.update({ type: 'update', gen, windows: [{ id: 7, type: 'buffer' }],
      input: [{ id: 7, gen, type: 'line', maxlen: 256 }], content: [{ id: 7, text: paragraphs }], ...extra });
  }
  function tick() { const callbacks = [...timers.entries()].filter(([, timer]) => timer.delay < 30000); for (const [id, timer] of callbacks) { timers.delete(id); timer.fn(); } }
  function boundary() { tick(); tick(); update('End room\n    peach'); tick(); }
  function manual(command, type = 'line') { glkote.getinterface().accept({ type, gen: generation, window: 7, value: command }); }
  function ready() { update('Startup'); tick(); update('Wait result'); tick(); update('North result'); tick(); update('Original room 🍑\n    yourself'); tick(); }
  return { adapter, events, messages, displayed, update, tick, boundary, manual, ready,
    begin() { adapter.receive({ type: 'playable.continuation.start', replayId: 'replay', sessionId: 'continuation' }); },
    error: message => glkote.error(message),
    timer() { glkote.getinterface().accept({ type: 'timer', gen: generation }); },
    resume() { adapter.receive({ type: 'iskein.continuation.resume', sessionId: 'continuation' }); },
    accept() { adapter.receive({ type: 'iskein.continuation.accept', sessionId: 'continuation' }); } };
}

test('runtime replays commands then qualifies START and records only manual turns through existing GlkOte handler', () => {
  const f = runtime(); f.ready();
  assert.deepEqual(f.events.map(e => e.value), ['wait', 'north', 'showme']);
  assert.deepEqual(f.messages.find(m => m.kind === 'ready').payload.start, start);
  assert.equal(f.messages.filter(m => m.kind === 'update').length, 0);
  f.manual('wait 🍑'); f.update('Result 🍑'); f.boundary(); f.manual('wait 🍑'); f.update('Again');
  const updates = f.messages.filter(m => m.kind === 'update');
  assert.deepEqual(updates.map(m => m.payload.input.value), ['wait 🍑', 'wait 🍑']);
  f.accept(); f.boundary();
  assert.equal(f.messages.filter(m => m.kind === 'update').length, 2, 'END probe is excluded');
  assert.deepEqual(f.messages.at(-1).payload, observeShowme(['End room', '    peach']));
  assert.equal(f.messages.at(-1).kind, 'ended');
});

test('runtime recognizes positive normal termination and skips END SHOWME', () => {
  const f = runtime(); f.ready(); f.manual('quit'); f.update('Confirm?', { content: [{ id: 7, text: [{ content: ['normal', 'Are you sure? '] }] }] }); f.manual('y');
  f.update('Bye', { exit: true, disable: true, input: [] });
  assert.equal(f.messages.at(-1).kind, 'ended'); assert.deepEqual(f.messages.at(-1).payload, { type: 'termination' });
  f.accept(); f.tick(); assert.deepEqual(f.events.map(e => e.value), ['wait', 'north', 'showme', 'quit', 'y']);
});

for (const fault of ['fatal', 'disable', 'special', 'char', 'no input', 'malformed exit']) test(`runtime never accepts ${fault} as normal termination`, () => {
  const f = runtime(); f.ready(); f.manual('quit');
  if (fault === 'fatal') { f.error('Fatal VM error'); f.update('Bye', { exit: true, disable: true, input: [] }); }
  if (fault === 'disable') f.update('', { disable: true, input: [] });
  if (fault === 'special') f.update('', { specialinput: {}, exit: true, input: [] });
  if (fault === 'char') f.update('', { input: [{ type: 'char' }] });
  if (fault === 'no input') f.update('', { input: [] });
  if (fault === 'malformed exit') f.update('', { exit: true });
  f.accept(); f.tick();
  assert.ok(!f.messages.some(m => m.kind === 'ended'));
});

test('source termination and human intervention during replay cannot become recording boundaries', () => {
  for (const human of [false, true]) {
    const f = runtime(); f.update('Startup'); f.tick();
    if (human) f.manual('rogue');
    f.update('Bye', { exit: true, input: [] }); f.tick();
    assert.ok(!f.messages.some(m => m.kind === 'ready'));
    assert.ok(f.messages.some(m => m.kind === 'error'));
  }
});


for (const terminal of [false, true]) test(`closed player accepts persisted ${terminal ? 'termination' : 'location'} endpoint`, async t => {
  const f = await host(t);
  if (terminal) { f.turn('quit', 'Bye', { exit: true, disable: true, input: [] }); f.send('ended', { type: 'termination' }); }
  else { f.turn('north'); f.send('boundary', observeShowme(['North room', '    yourself'])); }
  await f.session.queue;
  const before = await readWorking(f.project);
  await f.session.finalize();
  assert.equal((await workingState(f.project)).canAccept, true);
  f.session.send = () => { throw new Error('Must not contact a disposed player'); };
  const accepted = await acceptContinuation(f.project, 'After closing');
  assert.equal(accepted.guid, before.guid);
  assert.deepEqual(accepted.turns, before.turns);
  assert.deepEqual(accepted.end, before.end);
  assert.equal((await workingState(f.project)).exists, false);
});

test('multiple acceptances reset GUID, START and transcript while keeping the live session', async t => {
  const f = await host(t), originalSession = f.session.sessionId;
  let endpoint = observeShowme(['Second room', '    yourself']);
  f.session.send = message => {
    if (message.type === 'iskein.continuation.accept') f.send('ended', endpoint);
    if (message.type === 'iskein.continuation.resume') f.send('ready', { start: endpoint,
      output: { type: 'update', gen: 8, windows: [{ id: 7, type: 'buffer' }], content: [] } });
  };
  f.turn('north'); f.send('boundary', endpoint); await f.session.queue;
  const first = await f.session.accept('First'); await f.session.queue;
  assert.notEqual(f.session.guid, first.guid);
  assert.equal(f.session.sessionId, originalSession);
  assert.deepEqual((await readWorking(f.project)).start, first.end);
  assert.deepEqual((await readWorking(f.project)).turns, []);
  assert.equal((await workingState(f.project)).canAccept, false);
  endpoint = observeShowme(['Third room', '    yourself']);
  f.turn('east'); f.send('boundary', endpoint); await f.session.queue;
  const second = await f.session.accept('Second'); await f.session.queue;
  assert.deepEqual(second.start, first.end);
  assert.notEqual(second.guid, first.guid);
  assert.deepEqual(second.turns.map(turn => turn.command), ['east']);
  assert.deepEqual(parseVector(await fs.readFile(first.file, 'utf8')).turns.map(turn => turn.command), ['north']);
  await f.session.finalize();
  assert.equal((await workingState(f.project)).exists, false, 'closing an empty next segment leaves no discard requirement');
});

test('persisted qualified recording can be accepted after extension session context is lost', async t => {
  const f = await host(t); f.turn('look'); f.send('boundary', start); await f.session.finalize();
  const before = await readWorking(f.project);
  const file = require.resolve('../working-iskein');
  const scope = { module: { exports: {} }, TextDecoder, setTimeout, clearTimeout,
    require: require('node:module').createRequire(file) };
  vm.runInNewContext(await fs.readFile(file, 'utf8'), scope, { filename: file });
  const recovered = scope.module.exports;
  assert.equal((await recovered.workingState(f.project)).canAccept, true);
  const accepted = await recovered.acceptContinuation(f.project, 'Recovered');
  assert.equal(accepted.guid, before.guid);
  assert.equal(accepted.end.observation, start.observation);
  assert.deepEqual(accepted.turns.map(turn => turn.command), ['look']);
});

for (const fault of ['dirty', 'error']) test(`new ${fault} invalidates a previously qualified endpoint before close`, async t => {
  const f = await host(t); f.turn('look'); f.send('boundary', start); await f.session.queue;
  assert.deepEqual((await readWorking(f.project)).end, start);
  f.send(fault, fault === 'error' ? 'Fatal VM error' : undefined);
  await f.session.finalize();
  assert.equal((await readWorking(f.project)).end, undefined);
  assert.equal((await workingState(f.project)).canAccept, false);
  await assert.rejects(f.session.accept(''), /healthy live/);
});

test('runtime checkpoints each settled turn and resumes new segments without replay or duplicate probes', () => {
  const f = runtime(); f.ready();
  for (let i = 0; i < 3; i++) {
    f.manual('wait'); f.update('Result'); f.boundary();
    assert.equal(f.messages.at(-1).kind, 'boundary');
    const eventCount = f.events.length;
    f.accept();
    assert.equal(f.messages.at(-1).kind, 'ended');
    assert.equal(f.events.length, eventCount, 'cached endpoint needs no extra probe');
    f.resume();
    assert.equal(f.messages.at(-1).kind, 'ready');
    assert.deepEqual(f.messages.at(-1).payload.start, observeShowme(['End room', '    peach']));
  }
  assert.deepEqual(f.events.map(event => event.value), ['wait', 'north', 'showme', 'wait', 'showme', 'wait', 'showme', 'wait', 'showme']);
  assert.deepEqual(f.messages.filter(message => message.kind === 'update').map(message => message.payload.input.value), ['wait', 'wait', 'wait']);
});

test('runtime queues input during a checkpoint and records it after the diagnostic', () => {
  const f = runtime(); f.ready();
  f.manual('north'); f.update('North result');
  f.manual('east');
  assert.equal(f.events.at(-1).value, 'north');
  f.boundary();
  assert.equal(f.events.at(-1).value, 'east');
  f.update('East result'); f.boundary();
  assert.deepEqual(f.messages.filter(message => message.kind === 'update').map(message => message.payload.input.value), ['north', 'east']);
  assert.equal(f.messages.at(-1).kind, 'boundary');
});

test('runtime queues commands entered during acceptance for the next segment', () => {
  const f = runtime(); f.ready(); f.manual('north'); f.update('North result'); f.boundary();
  f.accept(); f.manual('east');
  assert.equal(f.events.at(-1).value, 'showme');
  f.resume();
  assert.equal(f.events.at(-1).value, 'east');
  f.update('East result'); f.boundary();
  const ready = f.messages.findLastIndex(message => message.kind === 'ready');
  assert.deepEqual(f.messages.slice(ready).filter(message => message.kind === 'update').map(message => message.payload.input.value), ['east']);
});


test('normal page closure preserves the qualified boundary without reporting a recording error', () => {
  const f = runtime(); f.ready(); f.manual('look'); f.update('Result'); f.boundary();
  const count = f.messages.length;
  f.adapter.close(); f.tick();
  assert.equal(f.messages.length, count);
  assert.equal(f.messages.at(-1).kind, 'boundary');
});

test('timer events cannot advance the VM while an accepted segment is being published', () => {
  const f = runtime(); f.ready(); f.manual('look'); f.update('Result'); f.boundary(); f.accept();
  const count = f.events.length;
  f.timer();
  assert.equal(f.events.length, count);
});

for (const playable of ['composition', 'iskein']) test(`${playable} live END hands off without replay and accepts ordinary v4 continuations`, async t => {
  const f = runtime(playable);
  f.update('Startup'); f.tick(); f.update('Wait result'); f.tick(); f.update('North result'); f.tick();
  assert.equal(f.messages.at(-1).eligible, true);
  assert.deepEqual(f.events.map(e => e.value), ['wait', 'north']);
  assert.ok(!f.messages.some(m => m.type === 'iskein.continuation'));
  f.begin(); f.tick(); f.update('Original room 🍑\n    yourself'); f.tick();
  assert.deepEqual(f.events.map(e => e.value), ['wait', 'north', 'showme']);
  assert.deepEqual(f.messages.find(m => m.kind === 'ready').payload.start, start);
  assert.ok(!f.displayed.some(output => output.includes('Original room') || output.includes('showme')));
  f.manual('look'); f.update('Manual result'); f.boundary();
  f.accept();
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'playable-continuation-'));
  t.after(async () => { await discardContinuation(project); await fs.rm(project, { recursive: true, force: true }); });
  const session = new WorkingISkein(project, 'Nested route');
  let consumed = 0;
  const drain = () => {
    for (const message of f.messages.slice(consumed)) if (message.type === 'iskein.continuation') session.receive({ ...message, sessionId: session.sessionId });
    consumed = f.messages.length;
  };
  drain(); await session.queue;
  session.send = message => { f.adapter.receive({ ...message, sessionId: 'continuation' }); drain(); return true; };
  const accepted = await session.accept('After playback');
  const xml = await fs.readFile(accepted.file, 'utf8');
  assert.match(xml, /<iskein version="4">/);
  assert.equal(parseVector(xml).entry, 'continuation');
  assert.deepEqual(accepted.turns.map(turn => turn.command), ['look']);
  assert.doesNotMatch(xml, /showme|Wait result|North result/);
  assert.match(accepted.turns[0].result, /Manual result/);
  await session.queue;
  assert.deepEqual((await readWorking(project)).start, accepted.end);
  f.manual('wait'); f.update('Second segment'); f.boundary(); drain(); await session.queue;
  const second = await session.accept('Again');
  assert.notEqual(second.guid, accepted.guid);
  assert.deepEqual(second.turns.map(turn => turn.command), ['wait']);
});

for (const failure of ['partial', 'termination', 'error', 'human', 'late error']) test(`composition ${failure} cannot provide a continuation origin`, () => {
  const f = runtime('composition', failure === 'termination' ? 'termination' : 'location');
  f.update('Startup'); f.tick();
  if (failure !== 'partial') {
    f.update('Wait result'); f.tick();
    if (failure === 'termination') f.update('Bye', { exit: true, disable: true, input: [] });
    else if (failure === 'error') f.error('VM failure');
    else { f.update('North result'); f.tick(); if (failure === 'human') f.manual('look'); else f.error('Late failure'); }
  }
  f.begin(); f.tick();
  assert.ok(!f.messages.some(m => m.kind === 'ready'));
  assert.equal(f.messages.at(-1).kind, 'error');
});

test('display-only refresh preserves the composition origin and a stale start cannot hijack it', () => {
  const f = runtime('composition');
  f.update('Startup'); f.tick(); f.update('Wait result'); f.tick(); f.update('North result'); f.tick();
  f.update(undefined); f.tick();
  assert.equal(f.messages.at(-1).eligible, true);
  f.adapter.receive({ type: 'playable.continuation.start', replayId: 'stale', sessionId: 'stale' });
  assert.ok(!f.messages.some(m => m.type === 'iskein.continuation'));
  f.begin(); f.tick(); f.update('Original room 🍑\n    yourself'); f.tick();
  assert.equal(f.messages.at(-1).kind, 'ready');
});

test('continuation records character pauses and qualifies only after line input returns', () => {
  const f = runtime(); f.ready();
  f.manual('jump'); f.update('Press Space', { input: [{ type: 'char', id: 7, gen: 10 }] });
  f.tick();
  assert.ok(!f.messages.some(message => message.kind === 'error'));
  f.accept();
  assert.equal(f.messages.at(-1).kind, 'unavailable');
  f.manual(' ', 'char'); f.update('Continued'); f.boundary();
  const updates = f.messages.filter(message => message.kind === 'update');
  assert.deepEqual(updates.map(message => [message.payload.input.type, message.payload.input.value]), [['line', 'jump'], ['char', ' ']]);
  assert.equal(f.messages.at(-1).kind, 'boundary');
});

test('working and accepted continuation XML retain the character input type', async t => {
  const f = await host(t);
  f.send('update', { input: { type: 'char', value: 'return', gen: 8, window: 7 }, output: {
    type: 'update', gen: 9, input: [{ type: 'line', id: 7, gen: 9 }],
    content: [{ id: 7, text: [{ append: true, content: ['normal', 'Continued>'] }] }]
  } });
  f.send('boundary', start); await f.session.queue;
  const expected = [{ command: 'return', result: 'Continued>', inputType: 'char' }];
  assert.deepEqual((await readWorking(f.project)).turns, expected);
  await f.session.finalize();
  const accepted = await acceptContinuation(f.project, 'Character continuation');
  assert.deepEqual(parseVector(await fs.readFile(accepted.file, 'utf8')).turns, expected);
});
