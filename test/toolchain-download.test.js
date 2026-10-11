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
const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');

async function downloader(platform, run, remove = async () => {}) {
  const sandbox = {
    module: { exports: {} }, process: { platform }, URL,
    require(name) {
      if (name === 'vscode' || name.startsWith('./')) return {};
      if (name === 'child_process') return { execFile: run, exec() {} };
      if (name === 'fs') return { promises: { rm: remove } };
      return require(name);
    }
  };
  vm.createContext(sandbox);
  vm.runInContext(await fs.readFile(path.join(__dirname, '..', 'extension.js'), 'utf8'), sandbox);
  return sandbox;
}

test('macOS downloads with system curl and then extracts with tar', async () => {
  const calls = [];
  const sandbox = await downloader('darwin', (command, args, options, callback) => {
    calls.push({ command, args: Array.from(args) });
    callback(null, '', '');
  });
  await vm.runInContext(`downloadToolchainArchive('https://example.org/package.tar.gz', '/tmp/package with spaces.tar.gz')`, sandbox);
  await vm.runInContext(`extractArchive('/tmp/package with spaces.tar.gz', '/tmp/toolchain with spaces')`, sandbox);
  assert.deepEqual(calls, [
    { command: '/usr/bin/curl', args: [
      '--fail', '--location', '--silent', '--show-error',
      '--proto', '=https', '--proto-redir', '=https', '--max-redirs', '10',
      '--output', '/tmp/package with spaces.tar.gz', '--url', 'https://example.org/package.tar.gz'
    ] },
    { command: 'tar', args: ['-xf', '/tmp/package with spaces.tar.gz', '-C', '/tmp/toolchain with spaces'] }
  ]);
});

test('macOS rejects insecure downloads before running curl', async () => {
  const sandbox = await downloader('darwin', () => assert.fail('Unexpected curl execution'));
  await assert.rejects(vm.runInContext(`downloadToolchainArchive('http://example.org/package.tar.gz', '/tmp/package.tar.gz')`, sandbox), /require HTTPS/);
});

test('failed macOS downloads remove partial archives and report the error', async () => {
  const failure = new Error('curl: HTTP 404');
  const removed = [];
  const sandbox = await downloader('darwin', (_command, _args, _options, callback) => callback(failure), async file => removed.push(file));
  await assert.rejects(vm.runInContext(`downloadToolchainArchive('https://example.org/missing.tar.gz', '/tmp/partial.tar.gz')`, sandbox), /HTTP 404/);
  assert.deepEqual(removed, ['/tmp/partial.tar.gz']);
});

for (const platform of ['linux', 'win32']) {
  test(`${platform} retains the existing downloader`, async () => {
    const sandbox = await downloader(platform, () => assert.fail('Unexpected curl execution'));
    vm.runInContext('downloadFile = async (url, dest) => ({ url, dest })', sandbox);
    const result = await vm.runInContext(`downloadToolchainArchive('https://example.org/package.tar.gz', '/tmp/package.tar.gz')`, sandbox);
    assert.equal(result.url, 'https://example.org/package.tar.gz');
    assert.equal(result.dest, '/tmp/package.tar.gz');
  });
}
