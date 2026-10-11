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

function xml(value) {
  if (typeof value !== 'string' || /[^\u0009\u000a\u000d\u0020-\ud7ff\ue000-\ufffd\u{10000}-\u{10ffff}]/u.test(value)) {
    throw new Error('Skein text contains a character XML 1.0 cannot represent.');
  }
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;').replace(/\r/g, '&#13;');
}

function runs(paragraph) {
  const result = [];
  const content = paragraph.content || [];
  if (!Array.isArray(content)) throw new Error('Invalid Skein text content.');
  for (let i = 0; i < content.length; i++) {
    const part = content[i];
    if (typeof part === 'string') {
      if (typeof content[i + 1] !== 'string') throw new Error('Invalid Skein style/text pair.');
      result.push({ style: part, text: content[++i] });
    } else if (part && typeof part === 'object') {
      if (part.text !== undefined) {
        if (typeof part.text !== 'string') throw new Error('Invalid Skein text run.');
        result.push({ style: part.style, text: part.text });
      }
      // Image records have no narrative text.
    } else throw new Error('Invalid Skein text run.');
  }
  return result;
}

class Skein {
  // GlkOte represents printable keys literally and special keys by name.
  static validChar(value) {
    return typeof value === 'string' && (/^[^\u0000-\u001f\u007f-\u009f\ud800-\udfff\ufffe\uffff]$/u.test(value) ||
      /^(?:left|right|up|down|return|delete|escape|tab|pageup|pagedown|home|end|func(?:[1-9]|1[0-2]))$/.test(value));
  }

  constructor({ id = () => `node-${randomUUID()}`, warn = () => {} } = {}) {
    this.id = id;
    this.warn = warn;
    this.items = [this.item('- start -')];
    this.windows = new Map();
    this.generation = 0;
    this.inputGeneration = -1;
    this.echo = null;
    this.ready = false;
    this.exited = false;
    this.warnedEmpty = false;
  }

  item(command) { return { id: this.id(), command, result: '', commentary: '', annotation: '', childId: null }; }

  consume({ input, output }) {
    if (!output || typeof output !== 'object') throw new Error('Invalid Skein output update.');
    if (input && !['line', 'char', 'init', 'refresh', 'arrange', 'redraw', 'timer'].includes(input.type)) {
      throw new Error(`Record Skein does not support ${input.type} input. Recording stopped; received progress is preserved.`);
    }
    if (output.type === 'error') throw new Error(String(output.message || 'Interpreter error.'));
    if (['line', 'char'].includes(input?.type) && input.gen !== this.inputGeneration) {
      if (typeof input.value !== 'string' || !Number.isInteger(input.gen) || input.gen < this.inputGeneration || !Number.isInteger(input.window)) {
        throw new Error('Invalid Skein keyboard input.');
      }
      if (input.type === 'char' && !Skein.validChar(input.value)) throw new Error('Invalid Skein character key.');
      if (input.terminator) throw new Error('Record Skein does not support special line terminators.');
      this.flushEcho();
      const item = this.item(input.value);
      if (input.type === 'char') item.inputType = 'char';
      this.items.at(-1).childId = item.id;
      this.items.push(item);
      this.inputGeneration = input.gen;
      this.echo = input.type === 'line' && input.value ? { window: input.window, value: input.value, text: '', matched: false } : null;
      if (input.type === 'line' && !input.value && !this.warnedEmpty) {
        this.warnedEmpty = true;
        this.warn('Empty command recorded: GlkOte does not identify its echo newline; the newline is preserved.');
      }
    }
    if (output.type !== 'update') return;
    if (!Number.isInteger(output.gen)) throw new Error('Invalid Skein output generation.');
    if (output.gen <= this.generation) return;
    this.generation = output.gen;
    if (output.windows != null) {
      if (!Array.isArray(output.windows)) throw new Error('Invalid Skein window list.');
      this.windows = new Map(output.windows.map(win => [win.id, win.type]));
    }
    if (output.content != null && !Array.isArray(output.content)) throw new Error('Invalid Skein content list.');
    for (const content of output.content || []) {
      if (this.windows.get(content.id) !== 'buffer') continue;
      if (!Array.isArray(content.text)) throw new Error('Invalid Skein buffer update.');
      for (const paragraph of content.text) {
        if (!paragraph.append) this.text(content.id, '\n', null, true);
        for (const run of runs(paragraph)) this.text(content.id, run.text, run.style, false);
      }
    }
    if (output.input != null && !Array.isArray(output.input)) throw new Error('Invalid Skein input requests.');
    if (!output.disable && output.input?.some(request => ['line', 'char'].includes(request.type))) this.ready = true;
    if (output.exit) { this.flushEcho(); this.exited = true; this.ready = true; }
  }

  text(window, text, style, newline) {
    const echo = this.echo;
    if (echo && echo.window === window) {
      if (echo.matched && newline) { this.echo = null; return; }
      if (!echo.matched && !newline && style === 'input' && echo.value.startsWith(echo.text + text)) {
        echo.text += text;
        echo.matched = echo.text === echo.value;
        return;
      }
      this.flushEcho();
    }
    this.items.at(-1).result += text;
  }

  flushEcho() {
    // Only discard an echo after seeing BOTH the exact input run and its newline.
    if (this.echo) this.items.at(-1).result += this.echo.text;
    this.echo = null;
  }

  serialize() {
    const root = this.items[0].id;
    const lines = ['<?xml version="1.0" encoding="UTF-8"?>',
      `<Skein rootNode="${xml(root)}" xmlns="http://www.logicalshift.org.uk/IF/Skein">`,
      '  <generator>Inform 7</generator>', `  <activeNode nodeId="${xml(root)}"/>`];
    for (const [index, item] of this.items.entries()) {
      lines.push(`  <item nodeId="${xml(item.id)}">`);
      for (const field of ['command', 'result', 'commentary']) lines.push(`    <${field} xml:space="preserve"${field === 'command' && item.inputType === 'char' ? ' input="char"' : ''}>${xml(item[field])}</${field}>`);
      lines.push(`    <played>${index ? 'NO' : 'YES'}</played>`, `    <changed>${index ? 'YES' : 'NO'}</changed>`,
        '    <temporary score="0">YES</temporary>', `    <annotation xml:space="preserve">${xml(item.annotation)}</annotation>`);
      if (item.childId) lines.push('    <children>', `      <child nodeId="${xml(item.childId)}"/>`, '    </children>');
      lines.push('  </item>');
    }
    lines.push('</Skein>', '');
    return lines.join('\n');
  }
}

// Deliberately parse only the XML vocabulary/order emitted by our linear recorder.
// This is not a general XML or traditional-IDE Skein importer. No DTDs/entities
// are loaded, and every byte must belong to the supported grammar.
function parseLinearSkeinTurns(source) {
  const invalid = detail => { throw new Error(`Cannot play Skein: ${detail}. Expected a linear Skein produced by Informant Record Skein.`); };
  if (typeof source !== 'string') invalid('XML must be text');
  source = source.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  let offset = 0;
  function take(pattern) {
    const match = pattern.exec(source.slice(offset));
    if (!match || match.index !== 0) invalid(`unsupported or malformed XML near character ${offset}`);
    offset += match[0].length;
    return match;
  }
  function decode(text) {
    if (/&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[0-9a-fA-F]+;)/.test(text) || text.includes(']]>')) invalid('invalid XML text');
    const value = text.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (_, entity) => {
      const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
      if (named[entity]) return named[entity];
      const code = entity.startsWith('#x') ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
      if (!Number.isInteger(code) || code > 0x10ffff) invalid('invalid XML character reference');
      return String.fromCodePoint(code);
    });
    try { xml(value); } catch { invalid('invalid XML character'); }
    return value;
  }
  function textField(name) {
    return decode(take(new RegExp(`^[ \\t\\n]*<${name} xml:space="preserve">([^<]*)</${name}>`))[1]);
  }
  const opening = take(/^[ \t\n]*(?:<\?xml version="1\.0" encoding="UTF-8"\?>[ \t\n]*)?<Skein rootNode="([^"<]*)" xmlns="http:\/\/www\.logicalshift\.org\.uk\/IF\/Skein">/);
  const root = decode(opening[1]);
  take(/^[ \t\n]*<generator>Inform 7<\/generator>/);
  const active = decode(take(/^[ \t\n]*<activeNode nodeId="([^"<]*)"[ \t\n]*\/>/)[1]);
  const items = new Map();
  while (/^[ \t\n]*<item\b/.test(source.slice(offset))) {
    const id = decode(take(/^[ \t\n]*<item nodeId="([^"<]*)">/)[1]);
    if (!id || items.has(id)) invalid('empty or duplicate node ID');
    const commandField = take(/^[ \t\n]*<command xml:space="preserve"( input="char")?>([^<]*)<\/command>/);
    const command = decode(commandField[2]);
    const inputType = commandField[1] ? 'char' : undefined;
    if (inputType && !Skein.validChar(command)) invalid('invalid character key');
    const result = textField('result'); textField('commentary');
    take(/^[ \t\n]*<played>(?:YES|NO)<\/played>[ \t\n]*<changed>(?:YES|NO)<\/changed>[ \t\n]*<temporary score="[0-9]+">(?:YES|NO)<\/temporary>/);
    textField('annotation');
    let child;
    if (/^[ \t\n]*<children>/.test(source.slice(offset))) {
      take(/^[ \t\n]*<children>/);
      child = decode(take(/^[ \t\n]*<child nodeId="([^"<]*)"[ \t\n]*\/>/)[1]);
      take(/^[ \t\n]*<\/children>/); // A second child is explicitly unsupported.
    }
    take(/^[ \t\n]*<\/item>/);
    items.set(id, { command, result, child, ...(inputType ? { inputType } : {}) });
  }
  take(/^[ \t\n]*<\/Skein>[ \t\n]*$/);
  if (!items.has(root) || !items.has(active) || (items.get(root).command !== '- start -' || items.get(root).inputType)) invalid('missing root/start node or invalid activeNode');
  const visited = new Set(), commands = [];
  for (let id = root; id !== undefined;) {
    if (visited.has(id) || !items.has(id)) invalid('cycle or dangling child reference');
    visited.add(id);
    const item = items.get(id);
    if (id !== root) {
      if (/[\r\n]/.test(item.command)) invalid('command contains a line break');
      commands.push({ command: item.command, result: item.result, ...(item.inputType ? { inputType: item.inputType } : {}) });
    }
    id = item.child;
  }
  if (visited.size !== items.size) invalid('disconnected or non-linear nodes');
  return commands;
}

function parseLinearSkein(source) {
  return parseLinearSkeinTurns(source).map(replayInput);
}

function replayInput(turn) {
  return turn.inputType === 'char' ? { type: 'char', value: turn.command } : turn.command;
}

module.exports = { runs, Skein, parseLinearSkein, parseLinearSkeinTurns, replayInput, xml };
