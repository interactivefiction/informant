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

const { xml } = require('./skein');

// Closed XML vocabulary: no DTD, external entities or processing instructions.
function readArtifactXml(source, kind) {
  const invalid = detail => { throw new Error(`Malformed ${kind}: ${detail}`); };
  if (typeof source !== 'string') invalid('expected XML text');
  xml(source);
  source = source.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  let offset = 0;
  function take(pattern) {
    const match = pattern.exec(source.slice(offset));
    if (!match) invalid(`unexpected XML at character ${offset}`);
    offset += match[0].length;
    return match;
  }
  function decode(value) {
    if (/&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[\da-fA-F]+;)/.test(value) || value.includes(']]>')) invalid('invalid XML text');
    const decoded = value.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[\da-fA-F]+);/g, (_, entity) => {
      const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
      if (Object.hasOwn(named, entity)) return named[entity];
      const code = entity.startsWith('#x') ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
      if (!Number.isInteger(code) || code > 0x10ffff) invalid('invalid character reference');
      return String.fromCodePoint(code);
    });
    xml(decoded);
    return decoded;
  }
  take(/^[ \t\n]*(?:<\?xml\s+version=['"]1\.0['"]\s+encoding=['"]UTF-8['"]\s*\?>[ \t\n]*)?/);
  function element() {
    const name = take(/^<([A-Za-z][\w:-]*)/)[1], attrs = {};
    while (/^[ \t\n]+[\w:]/.test(source.slice(offset))) {
      const attr = take(/^[ \t\n]+([\w:-]+)[ \t\n]*=[ \t\n]*(?:"([^"<]*)"|'([^'<]*)')/);
      if (Object.hasOwn(attrs, attr[1])) invalid('duplicate attribute');
      attrs[attr[1]] = decode(attr[2] ?? attr[3]);
    }
    const close = take(/^[ \t\n]*(\/?)>/)[1];
    const node = { name, attrs, children: [], text: '' };
    if (close) return node;
    while (!source.startsWith('</', offset)) {
      if (source.startsWith('<', offset)) node.children.push(element());
      else node.text += decode(take(/^[^<]+/)[0]);
    }
    if (take(/^<\/([\w:-]+)[ \t\n]*>/)[1] !== name) invalid('mismatched closing tag');
    return node;
  }
  const root = element();
  take(/^[ \t\n]*$/);
  function attributes(node, expected = {}) {
    if (JSON.stringify(Object.keys(node.attrs).sort()) !== JSON.stringify(Object.keys(expected).sort()) ||
      Object.keys(expected).some(key => node.attrs[key] !== expected[key])) invalid(`invalid ${node.name} attributes`);
  }
  function children(node, names) {
    if (node.text.trim() || node.children.length !== names.length || names.some(name => node.children.filter(child => child.name === name).length !== 1)) invalid(`invalid ${node.name} children`);
    return names.map(name => node.children.find(child => child.name === name));
  }
  function text(node, attrs = {}) {
    attributes(node, attrs);
    if (node.children.length) invalid(`unexpected children in ${node.name}`);
    return node.text;
  }
  return { root, invalid, attributes, children, text };
}

module.exports = { readArtifactXml };
