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

const { randomUUID } = require('node:crypto');
const { xml, Skein } = require('./skein');

function createVector({ entry, name, start, end, turns, guid = randomUUID() }) {
  const vector = { entry, guid, name: typeof name === 'string' && name.trim() ? name : `${start?.location} ${guid.slice(-4).toUpperCase()}`,
    start: copyEndpoint(start), end: copyEndpoint(end, true), turns: turns.map(({ command, result, inputType }) => ({ command, result, ...(inputType !== undefined ? { inputType } : {}) })) };
  serializeVector(vector); // Validate the entire candidate before persistence.
  return vector;
}

function serializeVector(vector, working = false) {
  const { entry, guid, name, start, end, turns } = vector;
  if (typeof guid !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(guid)) throw new Error('Invalid test vector GUID.');
  for (const [field, value] of Object.entries({ name })) {
    if (typeof value !== 'string' || !value.trim()) throw new Error(`Test vector ${field} is required.`);
    xml(value);
  }
  if (!['initial', 'continuation'].includes(entry)) throw new Error('Test vector entry must be initial or continuation.');
  validateEndpoint(start); if (!working || end !== undefined) validateEndpoint(end, true);
  if (working && entry !== 'continuation') throw new Error('Working ISkein must be continuation.');
  if (!Array.isArray(turns)) throw new Error('Test vector transcript is required.');
  return ['<?xml version="1.0" encoding="UTF-8"?>', working ? '<working-iskein version="4">' : '<iskein version="4">',
    '  <identity>', `    <guid>${xml(guid)}</guid>`, `    <name>${xml(name)}</name>`, '  </identity>', `  <entry>${entry}</entry>`,
    '  <endpoints>', ...(working && end === undefined ? ['start'] : ['start', 'end']).flatMap(key => key === 'end' && end.type === 'termination' ? ['    <end type="termination"/>'] : [
      `    <${key}${key === 'end' ? ' type="location"' : ''}>`, `      <location>${xml(vector[key].location)}</location>`,
      `      <observation algorithm="crc32">${vector[key].observation}</observation>`, `    </${key}>`
    ]), '  </endpoints>',
    '  <provenance>', '    <generator>Informant</generator>', '    <source-format>Inform7-Skein</source-format>', '  </provenance>',
    '  <transcript>', ...turns.map(({ command, result, inputType }, index) => {
      if (typeof command !== 'string' || /[\r\n]/.test(command)) throw new Error('Invalid test vector command.');
      if (inputType !== undefined && inputType !== 'char') throw new Error('Invalid test vector input type.');
      if (inputType === 'char' && !Skein.validChar(command)) throw new Error('Invalid test vector character key.');
      return `    <turn sequence="${index + 1}">\n      <command${inputType === 'char' ? ' input="char"' : ''}>${xml(command)}</command>\n      <result xml:space="preserve">${xml(result)}</result>\n    </turn>`;
    }), '  </transcript>', working ? '</working-iskein>' : '</iskein>', ''].join('\n');
}

function validateEndpoint(endpoint, allowTermination = false) {
  if (allowTermination && endpoint?.type === 'termination') {
    if (endpoint.location !== undefined || endpoint.observation !== undefined) throw new Error('Termination endpoint cannot contain a location or observation.');
    return;
  }
  if (endpoint?.type !== undefined && endpoint.type !== 'location') throw new Error('Invalid endpoint type.');
  if (!endpoint || typeof endpoint.location !== 'string' || !endpoint.location.trim() || /[\r\n]/.test(endpoint.location)) {
    throw new Error('Test vector endpoint location must be a nonempty diagnostic line.');
  }
  xml(endpoint.location);
  if (typeof endpoint.observation !== 'string' || !/^[0-9A-F]{8}$/.test(endpoint.observation)) {
    throw new Error('Test vector endpoint observation must be eight uppercase CRC-32 hex digits.');
  }
}

function copyEndpoint(endpoint, allowTermination = false) {
  validateEndpoint(endpoint, allowTermination);
  if (endpoint.type === 'termination') return { type: 'termination' };
  return { location: endpoint.location, observation: endpoint.observation };
}

module.exports = { createVector, serializeVector, copyEndpoint };
