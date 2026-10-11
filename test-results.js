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

// Small, dependency-free ZIP writer: UTF-8 names, stored entries, ZIP32.
// CRC-32 is required by the ZIP container only; response comparison uses ===.
function zipFiles(files) {
  const local = [], central = [];
  let offset = 0;
  if (files.length > 65535) throw new Error('Too many result files for ZIP32.');
  for (const [filename, text] of files) {
    const name = Buffer.from(filename), data = Buffer.from(text, 'utf8');
    let crc = 0xffffffff;
    for (const byte of data) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    crc = (crc ^ 0xffffffff) >>> 0;
    if (offset + data.length + name.length + 30 > 0xffffffff) throw new Error('Results exceed ZIP32 size limit.');
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6);
    header.writeUInt16LE(33, 12); // 1980-01-01; no fabricated run timestamp.
    header.writeUInt32LE(crc, 14); header.writeUInt32LE(data.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(name.length, 26);
    local.push(header, name, data);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6); entry.writeUInt16LE(0x800, 8);
    entry.writeUInt16LE(33, 14); entry.writeUInt32LE(crc, 16); entry.writeUInt32LE(data.length, 20); entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(name.length, 28); entry.writeUInt32LE(offset, 42);
    central.push(entry, name); offset += header.length + name.length + data.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  if (offset + directory.length > 0xffffffff) throw new Error('Results exceed ZIP32 size limit.');
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

function exportResults(run) {
  const summary = ['Informant Test Run', `Project: ${run.project}`, `Test Suite: ${run.suite || 'All Playables'}`,
    `Started: ${run.started}`, `State: ${run.state}`, '', ...run.results.map((row, i) =>
      `${i + 1}. ${row.status} — ${row.name}\n   ${row.type}:${row.guid} · ${row.behavior || 'stepwise'} · ${row.turnCount} turns · ${row.durationMs ?? 0} ms`), '',
    'Failure reports are UTF-8 JSON. Escaped whitespace preserves exact expected and received responses.', ''].join('\n');
  const files = [['summary.txt', summary]];
  run.results.forEach((row, index) => {
    if (row.status === 'FAIL') files.push([`failures/${String(index + 1).padStart(4, '0')}-${row.guid}.json`, JSON.stringify(row.failure, null, 2) + '\n']);
  });
  return zipFiles(files);
}
module.exports = { exportResults };
