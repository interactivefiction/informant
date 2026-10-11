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

// Exercise only the real manifest-selection code with supplied host metadata.
// No download, extraction, or native compiler execution takes place.
async function offeredPackages(platform, arch) {
  let offered;
  const sandbox = {
    module: { exports: {} },
    __dirname: path.resolve(__dirname, '..'),
    process: { platform, arch },
    require(name) {
      if (name === 'vscode') return {
        workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback }) },
        window: { showQuickPick: async entries => { offered = entries; return undefined; } }
      };
      if (name.startsWith('./')) return {};
      if (name === 'https') return { get() { throw new Error('Unexpected network request'); } };
      return require(name);
    }
  };
  vm.createContext(sandbox);
  vm.runInContext(await fs.readFile(path.join(sandbox.__dirname, 'extension.js'), 'utf8'), sandbox);
  await vm.runInContext('output = { show() {}, appendLine() {} }; downloadToolchainFromManifest()', sandbox);
  return Array.from(offered, entry => JSON.parse(JSON.stringify(entry.toolchain)));
}

for (const [platform, target, checksum] of [
  ['linux', 'linux', 'd85f4b1010e305345d3d72957d272575a3c87ce113a57586562810bbf3f15928'],
  ['win32', 'windows', 'bbc76b38d3237e67757225a6f0b8552919fd951c48bb32451a9e1c9bf914c159']
]) {
  test(`official manifest selection offers only the ${platform}-x64 package`, async () => {
    assert.deepEqual(await offeredPackages(platform, 'x64'), [{
      id: `informant-toolchain-${target}-x64-10.1.2c`,
      version: '10.1.2c',
      platform: `${platform}-x64`,
      url: `https://github.com/interactivefiction/informant-toolchains/releases/download/inform-10.1.2c-${target}-x64/informant-toolchain-${target}-x64-10.1.2.tar.gz`,
      sha256: checksum
    }]);
  });
}

for (const arch of ['x64', 'arm64']) {
  test(`official manifest selection offers only the macOS universal package for darwin-${arch}`, async () => {
    assert.deepEqual(await offeredPackages('darwin', arch), [{
      id: 'informant-toolchain-macos-universal-10.1.2c',
      version: '10.1.2c',
      platform: `darwin-${arch}`,
      url: 'https://github.com/interactivefiction/informant-toolchains/releases/download/inform-10.1.2c-macosuniv-x64/informant-toolchain-macos-universal-10.1.2.tar.gz',
      sha256: '4a85ff05f351b7539f53c194a9bbff96211c9e35a0ad2a614a5a46fd19b4be87'
    }]);
  });
}

for (const [platform, arch] of [['win32', 'arm64'], ['linux', 'arm64'], ['darwin', 'ia32']]) {
  test(`official manifest rejects unsupported ${platform}-${arch}`, async () => {
    await assert.rejects(offeredPackages(platform, arch), {
      message: `Manifest has no toolchain for ${platform}-${arch}.`
    });
  });
}
