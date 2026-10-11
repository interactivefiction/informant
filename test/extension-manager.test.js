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
const os = require('node:os');
const crypto = require('node:crypto');
const vm = require('node:vm');
const c = require('../extension-catalog');
const m = require('../extension-manager');
const manifest = require('../resources/extensions/official-manifest.json');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const item = (title, v = '1', dependencies = []) => ({ id: title + v, title, author: 'Author', version: v, path: `${title}${v}.i7x`, dependencies, warnings: [] });
const ref = (title, min, max, extra = {}) => ({ title, author: 'Author', kind: 'include', line: '12', ...(min ? { 'min-version': min } : {}), ...(max ? { 'max-version-exclusive': max } : {}), ...extra });
function downloadable(title, dependencies = []) {
  const entry = item(title, '1', dependencies);
  const bytes = Buffer.from(`Version 1 of ${title} by Author begins here.\r\n\r\n${title} ends here.\r\n`);
  entry.download = { url: 'https://example.org/' + title, bytes: String(bytes.length), sha256: hash(bytes) };
  return { entry, bytes };
}
async function temporary(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'informant-manager-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
function xml(entry) {
  return `<?xml version='1.0' encoding='utf-8'?>\n<catalog xmlns="urn:inform7:extension-catalog:1" schema-version="1" language-version="10.1" version-policy="inform-10-compatible"><extension id="x" title="A &amp; B" author="Author" path="Author/A.i7x"><download url="${entry.download.url}" bytes="${entry.download.bytes}" sha256="${entry.download.sha256}"/><dependencies/></extension></catalog>`;
}

test('catalog namespace, schema, entities, integrity metadata, and paths are validated', () => {
  const source = xml(downloadable('A').entry);
  assert.equal(c.parseCatalog(source)[0].title, 'A & B');
  for (const bad of [source.replace('schema-version="1"','schema-version="2"'), source.replace('urn:inform7:extension-catalog:1','wrong'), source.replace('Author/A.i7x','../A.i7x'), source.replace('https:', 'http:'), source.replace('<catalog', '<!DOCTYPE catalog><catalog')]) assert.throws(() => c.parseCatalog(bad));
});
test('version ranges compare numeric components, legacy versions, and missing versions', () => {
  assert.ok(c.compare('10', '9.9') > 0);
  assert.equal(c.compare('6/040426', '6.0.40426'), 0);
  assert.ok(c.satisfies(item('A', '2.10'), ref('A','2.4.0','3.0.0')));
  assert.ok(!c.satisfies(item('A', '3'), ref('A','2.4.0','3.0.0')));
  assert.ok(!c.satisfies(item('A', ''), ref('A','1')));
  assert.ok(c.satisfies(item('A', ''), ref('A')));
  assert.equal(c.identity({title:' CAFe\u0301  Test ',author:' AUTHOR '}),c.identity({title:'café test',author:'author'}));
});
test('transitive closure terminates cycles and ignores optional integrations', () => {
  const a=item('A','1',[ref('B'),ref('Missing',null,null,{kind:'integration',when:'without'})]);
  const b=item('B','1',[ref('C')]), d=item('C','1',[ref('A')]);
  assert.deepEqual(c.resolveDependencies(a,[a,b,d],[]).downloads.map(e=>e.title),['A','B','C']);
});
test('all incoming constraints force backtracking and abandoned edges are retracted', () => {
  const a=item('A','1',[ref('B'),ref('C')]);
  const high=item('B','3',[ref('Never')]), low=item('B','2');
  const sibling=item('C','1',[ref('B','2','3')]);
  const plan=c.resolveDependencies(a,[a,high,low,sibling],[]);
  assert.equal(plan.downloads.find(e=>e.title==='B').version,'2');
  assert.ok(!plan.downloads.some(e=>e.title==='Never'));
  assert.throws(()=>c.resolveDependencies(a,[a,high,sibling],[]),/conflict|Missing/);
});
test('installed dependencies satisfy external references by author and compatible version', () => {
  const a=item('A','1',[ref('B','2','3',{status:'external'})]);
  const provided={...item('B','2.5'),local:true};
  const plan=c.resolveDependencies(a,[a,item('B','2.9')],[provided]);
  assert.equal(plan.downloads.length,1);assert.equal(plan.provided[0],provided);
  assert.throws(()=>c.resolveDependencies(a,[a],[{...provided,author:'Other'}]),/Missing/);
  assert.throws(()=>c.resolveDependencies(a,[a],[{...provided,version:'1'}]),/Missing/);
});
test('conditional Includes are reported rather than claimed complete', () => {
  assert.throws(()=>c.resolveDependencies(item('A','1',[ref('B',null,null,{conditions:[{present:'true'}]})]),[],[]),/Conditional Includes/);
});
test('recursive scan uses headers, skips symlinks and reports invalid source', async t => {
  const root=await temporary(t), {entry,bytes}=downloadable('Actual title');
  await fs.mkdir(path.join(root,'nested','author'),{recursive:true});
  await fs.writeFile(path.join(root,'nested','author','misleading.I7X'),bytes);
  await fs.writeFile(path.join(root,'bad.i7x'),'invalid');
  if(process.platform!=='win32') await fs.symlink(root,path.join(root,'loop'));
  const result=await c.scanInstalled([root,root],[entry]);
  assert.equal(result.installed.length,1);assert.equal(result.installed[0].title,'Actual title');
  assert.equal(result.warnings.length,1);
  assert.equal(c.parseHeader(Buffer.from('Version 6 of Effects (for Glulx only) by Emily Short begins here.')).title,'Effects');
});
test('installer verifies entire set before writing and preserves exact bytes', async t => {
  const root=await temporary(t), a=downloadable('A'), b=downloadable('B');
  const plan={downloads:[a.entry,b.entry]};
  await assert.rejects(m.installPlan(plan,root,async(url,dest)=>fs.writeFile(dest,url.endsWith('/A')?a.bytes:Buffer.from('corrupt'))),/checksum/);
  await assert.rejects(fs.access(path.join(root,'Author','A.i7x')));
  assert.equal(await m.installPlan(plan,root,async(url,dest)=>fs.writeFile(dest,url.endsWith('/A')?a.bytes:b.bytes)),2);
  assert.deepEqual(await fs.readFile(path.join(root,'Author','A.i7x')),a.bytes);
  assert.equal(await m.installPlan(plan,root,async(url,dest)=>fs.writeFile(dest,url.endsWith('/A')?a.bytes:b.bytes)),0);
});
test('existing files and symbolic-link destinations are protected', async t => {
  const root=await temporary(t), a=downloadable('A');
  await fs.mkdir(path.join(root,'Author'));
  await fs.writeFile(path.join(root,'Author','A.i7x'),'user content');
  await assert.rejects(m.installPlan({downloads:[a.entry]},root,async(_,dest)=>fs.writeFile(dest,a.bytes)),/already exists/);
  assert.equal(await fs.readFile(path.join(root,'Author','A.i7x'),'utf8'),'user content');
  if(process.platform!=='win32') {
    await fs.mkdir(path.join(root,'other'));await fs.symlink(path.join(root,'other'),path.join(root,'Link'));
    const linked={...a.entry,author:'Link',bytes:Buffer.from('Version 1 of A by Link begins here.')};
    await assert.rejects(m.installPlan({downloads:[linked]},root,()=>{}),/Unsafe extension destination/);
  }
});
test('catalog cache uses pinned receipt and malformed archives fail without installation', async t => {
  const root=await temporary(t), source=xml(downloadable('A').entry);
  await fs.mkdir(path.join(root,'extension-catalogs'));
  const cache=path.join(root,'extension-catalogs',manifest.id+'.xml');
  await fs.writeFile(cache,source);
  await fs.writeFile(cache+'.json',JSON.stringify({archiveSha256:manifest.sha256,xmlSha256:hash(source)}));
  const entries=await m.loadCatalog(root,()=>{throw Error('offline');},()=>{});
  assert.equal(entries.length,1);
  await assert.rejects(m.loadCatalog(root,async(_,dest)=>fs.writeFile(dest,'bad zip'),()=>{},true),/SHA-256/);
  assert.equal((await m.loadCatalog(root,()=>{throw Error('offline');},()=>{})).length,1);
});
test('webview browser script parses and uses restrictive CSP and text content', () => {
  const html=m.managerHtml();
  const script=/<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(html)[1];
  new vm.Script(script);
  assert.match(html,/default-src 'none'/);assert.match(script,/textContent/);
  assert.ok(!script.includes('innerHTML'));
});

test('removal deletes only the selected catalog file and allows reinstalling', async t => {
  const root = await temporary(t), a = downloadable('A'), b = downloadable('B');
  const download = (_, dest) => fs.writeFile(dest, dest.endsWith('0.i7x') ? a.bytes : b.bytes);
  await m.installPlan({ downloads: [a.entry, b.entry] }, root, download);
  const installed = (await c.scanInstalled([root], [a.entry, b.entry])).installed;
  await m.removeExtension(installed.find(entry => entry.title === 'A'), root);
  await assert.rejects(fs.access(path.join(root, 'Author', 'A.i7x')), { code: 'ENOENT' });
  assert.deepEqual(await fs.readFile(path.join(root, 'Author', 'B.i7x')), b.bytes);
  assert.equal(await m.installPlan({ downloads: [a.entry] }, root, download), 1);
});

test('removal protects edited, external, unknown, and symlinked files', async t => {
  const root = await temporary(t), a = downloadable('A');
  const folder = path.join(root, 'extensions');
  await m.installPlan({ downloads: [a.entry] }, folder, (_, dest) => fs.writeFile(dest, a.bytes));
  const [installed] = (await c.scanInstalled([folder], [a.entry])).installed;
  await assert.rejects(m.removeExtension(installed, path.join(root, 'other')), /Only catalog/);
  await assert.rejects(m.removeExtension({ ...installed, download: undefined }, folder), /Only catalog/);
  await fs.writeFile(installed.path, 'user edits');
  await assert.rejects(m.removeExtension(installed, folder));
  assert.equal(await fs.readFile(installed.path, 'utf8'), 'user edits');
  if (process.platform !== 'win32') {
    const outside = path.join(root, 'outside.i7x');
    await fs.writeFile(outside, a.bytes);
    await fs.unlink(installed.path);
    await fs.symlink(outside, installed.path);
    await assert.rejects(m.removeExtension(installed, folder), /Unsafe/);
    await fs.unlink(installed.path);
    await fs.rmdir(path.dirname(installed.path));
    await fs.mkdir(path.join(root, 'outside'));
    await fs.writeFile(path.join(root, 'outside', 'A.i7x'), a.bytes);
    await fs.symlink(path.join(root, 'outside'), path.dirname(installed.path));
    await assert.rejects(m.removeExtension(installed, folder), /Unsafe/);
    assert.deepEqual(await fs.readFile(outside), a.bytes);
  }
});
