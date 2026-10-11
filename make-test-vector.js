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
const { TextDecoder } = require('node:util');
const { parseLinearSkeinTurns, replayInput } = require('./skein');
const { createVector, serializeVector } = require('./iskein');

async function makeTestVector(project, { name, qualify, signal, io = fs }) {
  signal?.throwIfAborted();
  const skeinFile = path.join(project, 'Skein.skein');
  const bytes = await io.readFile(skeinFile).catch(error => {
    throw new Error(`Cannot read Working Skein: ${error.message}`);
  });
  const turns = parseLinearSkeinTurns(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (!turns.length) throw new Error('Working Skein has no recorded commands.');
  const endpoints = await qualify(turns.map(replayInput), signal);
  signal?.throwIfAborted();
  const vector = createVector({ entry: 'initial', name, start: endpoints?.start, end: endpoints?.end, turns });
  const source = serializeVector(vector);
  const directory = path.join(project, '.informant', 'test-vectors');
  const file = path.join(directory, `${vector.guid}.iskein`);
  await io.mkdir(directory, { recursive: true });
  const temporary = path.join(directory, `.${vector.guid}.${randomUUID()}.tmp`);
  let handle, created = false;
  try {
    handle = await io.open(temporary, 'wx');
    created = true;
    await handle.writeFile(source, 'utf8');
    await handle.sync();
    await handle.close(); handle = undefined;
    signal?.throwIfAborted();
    // A same-directory hard link publishes the complete file atomically and
    // fails if the GUID already exists. rename() could overwrite that file.
    await io.link(temporary, file);
  } finally {
    await handle?.close().catch(() => {});
    if (created) await io.unlink(temporary).catch(() => {});
  }
  // Consume the starter recording only after the complete vector is published.
  await io.unlink(skeinFile).catch(error => {
    if (error.code !== 'ENOENT') {
      throw new Error(`Vector saved at ${file}, but cannot remove Starter Recording: ${error.message}`);
    }
  });
  return { ...vector, file };
}

module.exports = { makeTestVector };
