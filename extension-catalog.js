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

const fsp = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const { readArtifactXml } = require('./artifact-xml');

const identity = item => [item.title, item.author].map(value => String(value).normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase()).join('\0');
function version(value) {
  if (!/^\d+(?:\.\d+){0,2}(?:\/\d+)?$/.test(value || '')) return undefined;
  const [main, build] = value.split('/');
  const parts = main.split('.').map(Number);
  while (parts.length < 3) parts.push(0);
  if (build) parts[2] = Number(build);
  return parts.every(Number.isSafeInteger) ? parts : undefined;
}
function compare(a, b) {
  const left = version(a) || [-1, 0, 0], right = version(b) || [-1, 0, 0];
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] - right[i];
  return 0;
}
function satisfies(item, ref) {
  return identity(item) === identity(ref) &&
    (!(ref['min-version'] || ref['max-version-exclusive']) || !!version(item.version)) &&
    (!ref['min-version'] || compare(item.version, ref['min-version']) >= 0) &&
    (!ref['max-version-exclusive'] || compare(item.version, ref['max-version-exclusive']) < 0);
}
function safeRelative(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || /[\x00-\x1f:]/.test(value) ||
      value.split('/').some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part))) {
    throw new Error(`Unsafe extension path: ${value}`);
  }
  return value;
}
function parseCatalog(source) {
  // The existing closed-vocabulary XML reader rejects DTDs and external entities.
  const { root } = readArtifactXml(source.replace(/encoding=(['"])utf-8\1/i, 'encoding="UTF-8"'), 'extension catalog');
  if (root.name !== 'catalog' || root.attrs.xmlns !== 'urn:inform7:extension-catalog:1' ||
      root.attrs['schema-version'] !== '1' || root.attrs['language-version'] !== '10.1' ||
      root.attrs['version-policy'] !== 'inform-10-compatible') throw new Error('Unsupported extension catalog format or version.');
  const ids = new Set();
  const entries = root.children.map(node => {
    const a = node.attrs;
    if (node.name !== 'extension' || !a.id || !a.title || !a.author || ids.has(a.id)) throw new Error('Invalid or duplicate catalog extension.');
    ids.add(a.id);
    safeRelative(a.path);
    if (!/\.i7x$/i.test(a.path)) throw new Error('Catalog path must name an .i7x file.');
    const downloads = node.children.filter(child => child.name === 'download');
    const groups = node.children.filter(child => child.name === 'dependencies');
    if (downloads.length !== 1 || groups.length !== 1) throw new Error(`Invalid download/dependencies for ${a.title}.`);
    const download = downloads[0].attrs;
    if (new URL(download.url).protocol !== 'https:' || !/^\d+$/.test(download.bytes) ||
        !Number.isSafeInteger(Number(download.bytes)) || !/^[a-f0-9]{64}$/.test(download.sha256)) throw new Error(`Invalid download integrity metadata for ${a.title}.`);
    const dependencies = groups[0].children.map(child => {
      const ref = child.attrs;
      if (child.name !== 'dependency' || !ref.title || !ref.author || !['include', 'integration'].includes(ref.kind) ||
          !['internal', 'external', 'version-mismatch'].includes(ref.status)) throw new Error('Invalid catalog dependency.');
      for (const bound of ['min-version', 'max-version-exclusive']) if (ref[bound] && !version(ref[bound])) throw new Error('Invalid dependency version bound.');
      if (ref['requested-version'] && !ref['min-version']) throw new Error('Missing dependency version bounds.');
      if (child.children.some(condition => condition.name !== 'condition')) throw new Error('Invalid dependency condition.');
      return { ...ref, conditions: child.children.map(condition => condition.attrs) };
    });
    return { ...a, download, dependencies, warnings: node.children.filter(child => child.name === 'warning').map(child => `Line ${child.attrs.line}: ${child.text}`) };
  });
  for (const entry of entries) for (const ref of entry.dependencies) {
    if (ref.status === 'internal' && (!ref.targets || ref.targets.split(/\s+/).some(id => !ids.has(id)))) throw new Error('Unknown catalog dependency target.');
  }
  return entries;
}
function decodeSource(bytes) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { return new TextDecoder('windows-1252').decode(bytes); }
}
function parseHeader(bytes) {
  const text = decodeSource(bytes).replace(/^\uFEFF/, '');
  const match = /^\s*(?:Version\s+(\S+)\s+of\s+)?(.+?)\s+by\s+(.+?)\s+begins?\s+here\s*\./im.exec(text);
  if (!match) throw new Error('No Inform extension header found.');
  const title = match[2].replace(/\s*\([^)]*\)\s*$/, '').trim();
  const author = match[3].replace(/\s*\([^)]*\)\s*$/, '').trim();
  return { title, author, version: match[1] || '', dependencies: [], warnings: [] };
}
async function scanInstalled(roots, catalog = []) {
  const installed = [], warnings = [], seen = new Set();
  async function walk(dir) {
    let children;
    try { children = await fsp.readdir(dir, { withFileTypes: true }); }
    catch (error) { if (error.code !== 'ENOENT') warnings.push(`${dir}: ${error.message}`); return; }
    for (const child of children) {
      const file = path.join(dir, child.name);
      if (child.isDirectory()) await walk(file);
      else if (child.isFile() && /\.i7x$/i.test(child.name)) {
        try {
          const real = await fsp.realpath(file);
          if (seen.has(real)) continue;
          seen.add(real);
          const bytes = await fsp.readFile(file), header = parseHeader(bytes);
          const hash = crypto.createHash('sha256').update(bytes).digest('hex');
          const known = catalog.find(entry => entry.download.sha256 === hash && identity(entry) === identity(header));
          installed.push({ ...(known || header), id: `local:${real}`, path: file, local: true,
            warnings: known ? known.warnings : ['Locally provided extension; dependencies are not indexed in this catalog.'] });
        } catch (error) { warnings.push(`${file}: ${error.message}`); }
      }
    }
  }
  for (const root of new Set(roots.filter(Boolean))) await walk(root);
  return { installed, warnings };
}

// Backtracking keeps one version per identity and intersects all incoming Includes.
// A selected candidate contributes its own edges, so abandoning it retracts those edges.
function resolveDependencies(root, catalog, installed) {
  const candidates = new Map();
  for (const item of [...installed, ...catalog]) {
    const key = identity(item);
    if (!candidates.has(key)) candidates.set(key, []);
    candidates.get(key).push(item);
  }
  for (const items of candidates.values()) items.sort((a, b) => Number(!!b.local) - Number(!!a.local) || compare(b.version, a.version) || a.path.localeCompare(b.path));
  let attempts = 0, lastError = 'Unresolved dependency.';
  function search(selected) {
    if (++attempts > 10000) throw new Error('Dependency search exceeded its limit; select a smaller dependency set.');
    const requirements = new Map();
    for (const item of selected.values()) {
      for (const ref of item.dependencies) {
        if (ref.kind !== 'include') continue;
        if (ref.conditions?.length) { lastError = `${item.path}:${ref.line}: Conditional Includes are not yet supported.`; return; }
        const key = identity(ref);
        if (!requirements.has(key)) requirements.set(key, []);
        requirements.get(key).push({ ...ref, source: `${item.path}:${ref.line}` });
      }
    }
    for (const [key, refs] of requirements) {
      const chosen = selected.get(key);
      if (chosen && refs.some(ref => !satisfies(chosen, ref))) {
        lastError = `Version conflict for ${refs[0].title} by ${refs[0].author}: ${refs.map(ref => ref.source).join(', ')}`;
        return;
      }
    }
    const pending = [...requirements].find(([key]) => !selected.has(key));
    if (!pending) return [...selected.values()];
    const [key, refs] = pending;
    const options = (candidates.get(key) || []).filter(item => refs.every(ref => satisfies(item, ref)));
    if (!options.length) lastError = `Missing or incompatible ${refs[0].title} by ${refs[0].author}${refs[0]['requested-version'] ? ` (version ${refs[0]['requested-version']})` : ''}: ${refs.map(ref => ref.source).join(', ')}`;
    for (const item of options) {
      const result = search(new Map([...selected, [key, item]]));
      if (result) return result;
    }
  }
  const selected = search(new Map([[identity(root), root]]));
  if (!selected) throw new Error(lastError);
  return { downloads: selected.filter(item => !item.local), provided: selected.filter(item => item.local),
    warnings: selected.flatMap(item => (item.warnings || []).map(warning => `${item.title}: ${warning}`)) };
}
function verifyDownload(bytes, metadata) {
  if (bytes.length !== Number(metadata.bytes) || crypto.createHash('sha256').update(bytes).digest('hex') !== metadata.sha256) {
    throw new Error('Extension checksum or length mismatch. Refresh the catalog and try again.');
  }
}
module.exports = { identity, version, compare, satisfies, safeRelative, parseCatalog, parseHeader, scanInstalled, resolveDependencies, verifyDownload };
