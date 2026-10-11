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
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { planComposition, loadCompositionPlayback, installCompositionPlayback } = require('../composition-playback');
const { installSkeinPlayback } = require('../skein-playback-adapter');
const { resolver, serializeComposition } = require('../icomposition');
const endpoint = { location: 'Room', observation: '12345678' };
function vector(command, entry = 'initial', end = endpoint) {
  return { type: 'iskein', guid: randomUUID(), name: command, entry, start: endpoint, end, turns: [{ command, result: '' }] };
}
function composition(...members) {
  return { type: 'icomposition', guid: randomUUID(), name: 'Composition', entry: 'initial', start: endpoint, end: members.at(-1)?.end || endpoint,
    members: members.map(({ type, guid }) => ({ type, guid })) };
}
function plan(root, ...values) { return planComposition(root, resolver([root, ...values])); }

test('single vector and recursive document order across multiple nesting levels; persistence unchanged', () => {
  const [a,b,c,d,e,f] = ['a','b','c','d','e','f'].map(x => vector(x));
  const grandchild = composition(c,d), child = composition(b,grandchild,e), root = composition(a,child,f);
  const before = serializeComposition(root);
  assert.deepEqual(plan(composition(a), a).commands, ['a']);
  const result = plan(root,a,b,c,d,e,f,child,grandchild);
  assert.deepEqual(result.commands, ['a','b','c','d','e','f']);
  assert.match(result.leaves[3].context, /member 2.*member 2.*member 2/);
  assert.equal(serializeComposition(root), before);
});
for (const type of ['iskein','icomposition']) test(`missing ${type} reports reference and member position`, () => {
  const missing = { type, guid: randomUUID() }, root = composition(vector('a'),missing);
  const a = vector('a'); root.members[0].guid = a.guid;
  assert.throws(() => plan(root,a), error => error.message.includes(missing.guid) && /member 2.*Missing/.test(error.message));
});
for (const transitive of [false,true]) test(`${transitive ? 'transitive' : 'direct'} cycle is rejected`, () => {
  const a = composition(), b = composition(a);
  a.members = [{ type: 'icomposition', guid: (transitive ? b : a).guid }];
  assert.throws(() => plan(a,b), /cycle/);
});
test('empty, unsupported, malformed vector, and noninitial first member are rejected', () => {
  assert.throws(() => plan(composition()), /at least one/);
  const a = vector('a');
  const root = composition(a); root.members[0].type = 'unsupported';
  assert.throws(() => plan(root,a), /type/);
  a.turns[0].command = 'bad\ncommand';
  assert.throws(() => plan(composition(a),a), /command/);
  const b = vector('b','continuation');
  assert.throws(() => plan(composition(b),b), /First member/);
});
test('termination can only be final even across nested boundaries and stale envelopes', () => {
  const a = vector('quit','initial',{ type: 'termination' }), b = vector('later');
  assert.equal(plan(composition(a),a).endpoint, 'termination');
  const child = composition(a); child.end = endpoint;
  assert.throws(() => plan(composition(child,b),child,a,b), /after termination/);
  assert.throws(() => plan(composition(a,b),a,b), /after termination/);
});
test('shared children are not cycles and are executed at each occurrence', () => {
  const a = vector('a'), b = vector('b'), child = composition(a);
  assert.deepEqual(plan(composition(child,b,child),child,a,b).commands, ['a','b','a']);
});
test('malformed disk reference preserves file and reports root, position, type and GUID', async t => {
  const project = await fs.mkdtemp(path.join(os.tmpdir(),'composition-play-'));
  t.after(() => fs.rm(project,{ recursive:true, force:true }));
  const a = vector('a'), root = composition(a);
  for (const directory of ['compositions','test-vectors']) await fs.mkdir(path.join(project,'.informant',directory),{ recursive:true });
  const source = serializeComposition(root);
  await fs.writeFile(path.join(project,'.informant','compositions',root.guid+'.icomposition'), source);
  await fs.writeFile(path.join(project,'.informant','test-vectors',a.guid+'.iskein'), '<broken>');
  await assert.rejects(loadCompositionPlayback(project,root.guid), error => error.message.includes(root.guid) && error.message.includes(a.guid) && /member 1.*Malformed/.test(error.message));
  assert.equal(await fs.readFile(path.join(project,'.informant','compositions',root.guid+'.icomposition'),'utf8'), source);
});

function runtime(plan) {
  const timers = new Map(), events = [], messages = [];
  let next = 0, instances = 0;
  const sandbox = { setTimeout(fn,delay) { timers.set(++next,{ fn,delay }); return next; }, clearTimeout(id) { timers.delete(id); } };
  const replay = vm.runInNewContext(`(${installSkeinPlayback})`,sandbox);
  const install = vm.runInNewContext(`(${installCompositionPlayback})`,sandbox);
  class GlkOte {
    constructor() { instances++; }
    init(iface) { this.iface = iface; }
    getinterface() { return this.iface; }
    update() {}
    error() {}
  }
  const options = {}, adapter = install(options,GlkOte,plan,'one-session',message => messages.push(message),replay);
  const glk = options.GlkOte;
  glk.init({ accept(event) { events.push(event); } }); adapter.started();
  return { glk,events,messages, instances: () => instances,
    update(gen,extra={}) { glk.update({ type:'update',gen,input:[{ type:'line',id:1,gen,maxlen:256 }],...extra }); },
    tick(delay=180) { for (const [id,timer] of [...timers]) if (timer.delay===delay) { timers.delete(id); timer.fn(); } },
    pending: () => timers.size };
}
test('one VM and replay session across nested/later initial leaves; completion permits human input', () => {
  const a = vector('a'), b = vector('b','continuation'), c = vector('c'), child = composition(c);
  const f = runtime(plan(composition(a,b,child),a,b,c,child));
  for (let i=1;i<=4;i++) { f.update(i); f.tick(); }
  assert.deepEqual(f.events.map(e => e.value),['a','b','c']);
  assert.equal(f.instances(),1);
  assert.equal(f.messages.at(-1).kind,'complete');
  assert.equal(f.messages.at(-1).sessionId,'one-session');
  assert.equal(f.pending(),0);
  f.glk.getinterface().accept({ type:'line',gen:4,window:1,value:'human' });
  assert.equal(f.events.at(-1).value,'human');
});
for (const failure of ['error','char','early exit','timeout']) test(`${failure} stops subsequent execution with member context`, () => {
  const a=vector('a'), b=vector('b'), f=runtime(plan(composition(a,b),a,b));
  f.update(1); f.tick();
  if (failure==='error') f.glk.error('VM error');
  if (failure==='char') f.update(2,{ input:[{ type:'char',id:1,gen:2 }] });
  if (failure==='early exit') f.update(2,{ exit:true,input:[] });
  if (failure==='timeout') f.tick(30000);
  f.update(3); f.tick();
  assert.equal(f.events.length,1);
  assert.equal(f.messages.at(-1).kind,'stopped');
  assert.match(f.messages.at(-1).message,/member 1/);
});
test('final normal termination completes, early termination fails', () => {
  const a=vector('a'), b=vector('quit','initial',{ type:'termination' }), p=plan(composition(a,b),a,b);
  for (const early of [false,true]) {
    const f=runtime(p); f.update(1); f.tick();
    if (!early) { f.update(2); f.tick(); }
    f.update(3,{ exit:true,disable:true,input:[] }); f.tick();
    assert.equal(f.messages.at(-1).kind,early?'stopped':'complete');
  }
});
