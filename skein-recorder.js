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

class SkeinRecorder {
  constructor(project, { io = fs, onError = () => {}, onWarning = () => {} } = {}) {
    this.sessionId = randomUUID();
    this.destination = path.join(project, 'Skein.skein');
    this.io = io;
    this.onError = onError;
    this.model = new Skein({ warn: onWarning });
    this.sequence = 0;
    this.started = false;
    this.closed = false;
    this.failed = false;
    this.queue = Promise.resolve();
  }

  receive(message) {
    if (this.closed || message?.type !== 'skein.recording' || message.sessionId !== this.sessionId) return;
    try {
      if (message.sequence !== this.sequence + 1) throw new Error('Skein recording message order was lost.');
      this.sequence = message.sequence;
      if (message.kind === 'error') throw new Error(String(message.payload));
      if (message.kind === 'update') {
        this.model.consume(message.payload);
        if (this.started) this.checkpoint();
        if (this.started && this.model.exited) this.finalize();
      } else if (message.kind === 'ready') {
        if (!this.model.ready) throw new Error('Skein recording has not reached a usable interpreter state.');
        this.started = true;
        this.checkpoint();
        if (this.model.exited) this.finalize();
      } else throw new Error('Unknown Skein recording message.');
    } catch (error) { this.fail(error); }
  }

  fail(error) {
    if (this.failed) return;
    this.failed = true;
    this.closed = true;
    this.onError(error instanceof Error ? error : new Error(String(error)));
  }

  checkpoint() {
    const document = this.model.serialize();
    this.queue = this.queue.then(async () => {
      // A prior write failure stops later checkpoints; valid earlier writes remain.
      if (this.writeFailed) return;
      const temporary = `${this.destination}.${this.sessionId}.${randomUUID()}.tmp`;
      try {
        await this.io.writeFile(temporary, document, { encoding: 'utf8', flag: 'wx' });
        await this.io.rename(temporary, this.destination);
      } catch (error) {
        this.writeFailed = true;
        this.fail(new Error(`Cannot save Skein: ${error.message}`));
      } finally {
        await this.io.unlink(temporary).catch(() => {});
      }
    });
  }

  finalize() {
    if (!this.closed) {
      this.closed = true;
      if (this.started) {
        try { this.model.flushEcho(); this.checkpoint(); }
        catch (error) { this.fail(error); }
      }
    }
    return this.queue;
  }
}

module.exports = { SkeinRecorder };
