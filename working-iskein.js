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
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Skein } = require('./skein');
const { createVector, serializeVector, copyEndpoint } = require('./iskein');
const { parseVector } = require('./test-vector-library');
const sessions = new Map();
const workingPath = project => path.join(project, '.informant', 'working', 'iskein.iskein');

// Reject symlinks in managed state paths before reading, creating or removing.
async function stateDirectory(project, folder, create = false, io = fs) {
  let directory = project;
  for (const part of ['.informant', folder]) {
    directory = path.join(directory, part);
    if (create) await io.mkdir(directory).catch(error => { if (error.code !== 'EEXIST') throw error; });
    const stat = await io.lstat(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Informant state directory must be a project-contained directory.');
  }
  return directory;
}
async function readWorking(project) {
  await stateDirectory(project, 'working');
  const file = workingPath(project), stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Working ISkein must be a regular project file.');
  return parseVector(new TextDecoder('utf-8', { fatal: true }).decode(await fs.readFile(file)), true);
}
async function workingState(project) {
  const session = sessions.get(project);
  try {
    const vector = await readWorking(project);
    return { exists: true, count: vector.turns.length, start: vector.start, source: session?.source,
      canAccept: !!vector.turns.length && (session ? !session.failed && (!session.closed || !!session.end) : !!vector.end),
      message: `${vector.turns.length} continuation commands · ${vector.start.location} · ${session?.status || (vector.end ? 'Player closed; ready to accept.' : 'Player closed before endpoint qualification; recording preserved. Discard to start again.')}` };
  } catch (error) {
    if (error.code === 'ENOENT') return { exists: !!session, count: 0, message: session?.status || 'No continuation recording in progress. Select an eligible test vector below and choose Record Continuation.' };
    return { exists: true, canAccept: false, message: `Cannot read continuation recording: ${error.message}` };
  }
}
async function ensureNoWorking(project) {
  if ((await workingState(project)).exists) throw new Error('Accept or discard the existing Continuation Recording first.');
}
class WorkingISkein {
  constructor(project, source, { io = fs, onChange = () => {}, onError = () => {} } = {}) {
    if (sessions.has(project)) throw new Error('A continuation session already exists.');
    this.project = project; this.source = source; this.io = io; this.onChange = onChange; this.onError = onError;
    this.sessionId = randomUUID(); this.guid = randomUUID(); this.sequence = 0;
    this.model = new Skein(); this.queue = Promise.resolve(); this.status = 'Replaying source vector…';
    sessions.set(project, this);
  }
  receive(message) {
    if (this.closed || this.failed || message?.sessionId !== this.sessionId || message.type !== 'iskein.continuation') return;
    try {
      if (message.sequence !== ++this.sequence) throw new Error('Continuation recording message order was lost.');
      if (message.kind === 'error') throw new Error(String(message.payload));
      if (message.kind === 'ready') {
        if (this.start) throw new Error('Continuation already initialized.');
        this.start = copyEndpoint(message.payload.start);
        this.model.consume({ output: message.payload.output });
        this.status = 'Recording'; this.checkpoint();
      } else if (message.kind === 'dirty') {
        this.end = undefined; this.sealed = false;
        this.status = 'Recording; qualifying latest endpoint…'; this.checkpoint();
      } else if (message.kind === 'update') {
        if (!this.start || this.sealed) throw new Error('Continuation update outside recording.');
        this.end = undefined;
        this.model.consume(message.payload); this.checkpoint();
      } else if (message.kind === 'ended' || message.kind === 'boundary') {
        this.end = copyEndpoint(message.payload, true);
        if (this.end.type === 'termination' && !this.model.exited) throw new Error('Normal termination was not observed.');
        this.sealed = message.kind === 'ended';
        this.model.flushEcho(); this.checkpoint(); this.status = 'Recording; ready to accept or close player.';
        if (this.sealed) { this.pending?.resolve(this.end); this.pending = undefined; }
      } else if (message.kind === 'unavailable') {
        this.pending?.reject(new Error(message.payload)); this.pending = undefined;
      } else if (message.kind !== 'progress') throw new Error('Unknown continuation message.');
      this.onChange();
    } catch (error) { this.fail(error); }
  }
  vector() {
    return { guid: this.guid, name: `${this.start.location} ${this.guid.slice(-4).toUpperCase()}`, entry: 'continuation', start: this.start, end: this.end,
      turns: this.model.items.slice(1).map(({ command, result, inputType }) => ({ command, result, ...(inputType ? { inputType } : {}) })) };
  }
  checkpoint() {
    const document = serializeVector(this.vector(), true);
    this.queue = this.queue.then(async () => {
      if (this.writeFailed) return;
      let temporary;
      try {
        await stateDirectory(this.project, 'working', true, this.io);
        temporary = `${workingPath(this.project)}.${randomUUID()}.tmp`;
        await this.io.writeFile(temporary, document, { encoding: 'utf8', flag: 'wx' });
        await this.io.rename(temporary, workingPath(this.project));
        this.onChange();
      } catch (error) { this.writeFailed = true; this.fail(error); }
      finally { if (temporary) await this.io.unlink(temporary).catch(() => {}); }
    });
  }
  fail(error) {
    if (this.failed) return;
    this.failed = true; this.end = undefined;
    if (this.start && !this.writeFailed) this.checkpoint();
    Promise.resolve(this.send?.({ type: 'iskein.continuation.discard', sessionId: this.sessionId })).catch(() => {});
    this.status = `Recording stopped: ${error.message}`;
    this.pending?.reject(error); this.pending = undefined; this.onError(error); this.onChange();
  }
  async finalize() {
    this.closed = true;
    if (this.end && !this.failed) this.pending?.resolve(this.end);
    else this.pending?.reject(new Error('Player closed before endpoint qualification completed.'));
    this.pending = undefined;
    this.status = this.end && !this.failed ? 'Player closed; ready to accept.' : 'Player closed before endpoint qualification; recording preserved. Discard to start again.';
    await this.queue;
    if (!this.failed && !this.model.items.slice(1).length) {
      try {
        await stateDirectory(this.project, 'working', false, this.io);
        await this.io.unlink(workingPath(this.project));
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (sessions.get(this.project) === this) sessions.delete(this.project);
    }
    this.onChange();
  }
  async accept(name) {
    if (this.accepting) throw new Error('Acceptance already in progress.');
    this.accepting = true;
    let timer;
    try {
      if (this.failed || (this.closed && !this.end) || !this.start) throw new Error('A healthy live continuation session is required.');
      if (!this.vector().turns.length) throw new Error('Record at least one continuation command before accepting.');
      if (!this.closed && !this.sealed) {
        await new Promise((resolve, reject) => {
          this.pending = { resolve, reject };
          timer = setTimeout(() => { this.pending = undefined; reject(new Error('Continuation END qualification timed out.')); }, 30000);
          Promise.resolve(this.send({ type: 'iskein.continuation.accept', sessionId: this.sessionId })).catch(reject);
        });
      }
      clearTimeout(timer);
      await this.queue;
      if (this.failed || !this.end) throw new Error('Continuation recording could not be finalized.');
      const vector = createVector({ ...this.vector(), name, end: this.end });
      const directory = await stateDirectory(this.project, 'test-vectors', true, this.io);
      const file = path.join(directory, `${this.guid}.iskein`), temporary = path.join(directory, `.${randomUUID()}.tmp`);
      let handle, published = false;
      try {
        handle = await this.io.open(temporary, 'wx');
        await handle.writeFile(serializeVector(vector), 'utf8'); await handle.sync(); await handle.close(); handle = undefined;
        if (this.failed || !this.end) throw new Error('Continuation session closed during acceptance.');
        await this.io.link(temporary, file); published = true;
        await this.io.unlink(workingPath(this.project));
      } catch (error) {
        if (published) await this.io.unlink(file);
        throw error;
      } finally { await handle?.close().catch(() => {}); await this.io.unlink(temporary).catch(() => {}); }
      if (!this.closed && this.end.type !== 'termination') {
        this.guid = randomUUID(); this.source = vector.name;
        this.start = undefined; this.end = undefined; this.sealed = false; this.model = new Skein();
        this.status = 'Preparing next continuation…';
        try {
          const sent = await this.send({ type: 'iskein.continuation.resume', sessionId: this.sessionId });
          if (sent === false) throw new Error('Player closed before the next continuation could start.');
        } catch (error) { this.fail(error); }
      } else { this.closed = true; sessions.delete(this.project); }
      this.onChange();
      return { ...vector, file };
    } finally { clearTimeout(timer); this.pending = undefined; this.accepting = false; }
  }
}
async function acceptContinuation(project, name) {
  let session = sessions.get(project);
  if (!session) {
    const vector = await readWorking(project);
    if (!vector.end) throw new Error('The preserved recording has no qualified END endpoint.');
    session = new WorkingISkein(project, undefined);
    session.guid = vector.guid; session.start = vector.start; session.end = vector.end;
    session.model.items.push(...vector.turns); session.closed = true;
  }
  return session.accept(name);
}
async function discardContinuation(project) {
  const session = sessions.get(project);
  if (session?.accepting) throw new Error('Wait for acceptance to finish.');
  if (session) {
    await session.send?.({ type: 'iskein.continuation.discard', sessionId: session.sessionId });
    await session.finalize();
  }
  try { await stateDirectory(project, 'working'); await fs.unlink(workingPath(project)); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  sessions.delete(project);
}
module.exports = { WorkingISkein, workingPath, workingState, readWorking, ensureNoWorking, acceptContinuation, discardContinuation };
