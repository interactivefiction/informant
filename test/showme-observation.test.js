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
const { observeShowme } = require('../showme-observation');

// Fixed expected values independently computed using Python zlib.crc32.
test('CRC-32/ISO-HDLC check vector and zero-padded unsigned uppercase representation', () => {
  assert.equal(observeShowme(['123456789']).observation, 'CBF43926');
  assert.equal(observeShowme(['33']).observation, '0A6216D9');
  const embedded = vm.runInNewContext(`(${observeShowme.toString()})`, { TextEncoder });
  assert.equal(embedded(['123456789']).observation, 'CBF43926');
});

test('UTF-8 without BOM; exact first line, indentation, trailing spaces and internal empty lines', () => {
  const lines = ['  Sala de maduración — habitación 🍑  ', '    pêche\t  ', '', '    箱'];
  const result = observeShowme(lines);
  assert.equal(result.location, lines[0]);
  assert.equal(result.observation, '0981D37A');
  for (const eol of ['\n', '\r\n', '\r']) {
    assert.deepEqual(observeShowme([lines.join(eol)]), result);
  }
});

test('no synthetic terminal newline or Unicode normalization; spaces and ordering are significant', () => {
  assert.equal(observeShowme(['Room', '    peach']).observation, 'EAE98AAB');
  assert.equal(observeShowme(['Room', '    peach', '']).observation, '73399579');
  assert.equal(observeShowme(['Room', '    peach  ']).observation, 'AFADF360');
  assert.equal(observeShowme(['é']).observation, '0E048D3E');
  assert.equal(observeShowme(['e\u0301']).observation, '4CADFB2D');
  assert.notEqual(observeShowme(['Room', 'A', 'B']).observation, observeShowme(['Room', 'B', 'A']).observation);
});

test('same opaque location with changed contents yields a different observation', () => {
  const a = observeShowme(['Room', '    peach']), b = observeShowme(['Room', '    pear']);
  assert.equal(a.location, b.location);
  assert.equal(b.observation, '5917C238');
  assert.notEqual(a.observation, b.observation);
});

test('unusable blocks and invalid Unicode fail without substituting data', () => {
  for (const lines of [[], [''], ['   ', 'Room'], ['\nRoom'], ['Room', '\ud800'], ['Room', '\udc00']]) assert.throws(() => observeShowme(lines));
});
