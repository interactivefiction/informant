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

function contains(parent, child) {
  const relative = path.relative(parent, child);
  return !relative || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function optionalStat(file) {
  try { return await fs.stat(file); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}

async function copyInformProject(source, destinationParent) {
  const sourceName = path.basename(source);
  if (!sourceName.endsWith('.inform')) throw new Error('Select a .inform project folder.');
  const name = sourceName.slice(0, -'.inform'.length);
  const materials = path.join(path.dirname(source), `${name}.materials`);
  const sourceRoot = await fs.realpath(source);
  if (!(await optionalStat(path.join(sourceRoot, 'Source', 'story.ni')))?.isFile()) {
    throw new Error('The original project must contain Source/story.ni.');
  }
  const parent = await fs.realpath(destinationParent);
  const materialsStat = await optionalStat(materials);
  if (materialsStat && !materialsStat.isDirectory()) throw new Error('The sibling .materials path is not a folder.');
  const materialsRoot = materialsStat ? await fs.realpath(materials) : undefined;
  if (contains(sourceRoot, parent) || (materialsRoot && contains(materialsRoot, parent))) {
    throw new Error('Choose a location outside the original .inform and .materials folders.');
  }
  const workspaceRoot = path.join(parent, `${name}.informant`);
  // Exclusive creation also rejects empty folders and dangling destination symlinks.
  try { await fs.mkdir(workspaceRoot); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error(`A destination already exists: ${workspaceRoot}. Choose another location.`);
    throw error;
  }
  const projectRoot = path.join(workspaceRoot, sourceName);
  try {
    await fs.cp(sourceRoot, projectRoot, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
    if (materialsRoot) {
      await fs.cp(materialsRoot, path.join(workspaceRoot, `${name}.materials`),
        { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
    }
  } catch (error) {
    // Only remove the new container owned by this conversion, never a pre-existing folder.
    await fs.rm(workspaceRoot, { recursive: true, force: true });
    throw error;
  }
  return { workspaceRoot, projectRoot };
}

module.exports = { copyInformProject };
