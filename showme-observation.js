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

// Self-contained so the identical implementation can run in the player webview.
// Input is already isolated logical diagnostic lines, with no echo or prompt.
function observeShowme(lines) {
  if (!Array.isArray(lines) || !lines.length || lines.some(line => typeof line !== 'string')) {
    throw new Error('Missing SHOWME diagnostic block.');
  }
  const canonical = lines.join('\n').replace(/\r\n?/g, '\n');
  const location = canonical.split('\n')[0];
  if (!location.trim()) throw new Error('Missing SHOWME first diagnostic line.');
  // TextEncoder replaces isolated surrogates. Reject those instead of silently
  // changing the observed Unicode before computing its fingerprint.
  if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(canonical)) {
    throw new Error('Invalid Unicode in SHOWME diagnostic.');
  }
  let crc = 0xFFFFFFFF;
  for (const byte of new TextEncoder().encode(canonical)) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xEDB88320 : 0);
  }
  return { location, observation: ((crc ^ 0xFFFFFFFF) >>> 0).toString(16).toUpperCase().padStart(8, '0') };
}

module.exports = { observeShowme };
