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
// Optional real Inform/Quixe regression. Set SKEIN_INTERNAL to a packaged
// toolchain root. Only the display is replaced; no downloads or dependencies.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const { Skein, runs, parseLinearSkein, parseLinearSkeinTurns } = require('../skein');
const { SkeinRecorder } = require('../skein-recorder');
const { installSkeinRecording } = require('../skein-recording-adapter');
const { installSkeinPlayback } = require('../skein-playback-adapter');
const { installRoomQualification } = require('../room-qualification');
const { installCompositionPlayback } = require('../composition-playback');
const { installTestPlayback, qualifiedTests } = require('../test-runner');
const { observeShowme } = require('../showme-observation');
const { extractSkein, qualifySkein, saveSkeinImport } = require('../skein-import');
const { discoverTestVectors } = require('../test-vector-library');
const internal = process.env.SKEIN_INTERNAL;

const source = `"VerifyScreenCommands" by "Author"

Include Basic Screen Effects by Emily Short.

The Starting Room is a room.

When play begins:
    say "[line break]This is a test for skein import... [paragraph break]";
    pause the game;
    clear the screen.

Instead of jumping:
    say "First pause.";
    pause the game;
    say "Second pause.";
    pause the game;
    say "Choose a key.";
    let key be the chosen letter;
    say "You chose key [key].[paragraph break]".
`;

test('real Basic Screen Effects: startup pause, key-dependent input, import and exact test replay',
  { skip: !internal, timeout: 60000 }, async t => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'informant-char-runtime-'));
    t.after(() => fs.rm(temp, { recursive: true, force: true }));
    const project = path.join(temp, 'VerifyScreenCommands.inform');
    await fs.mkdir(path.join(project, 'Source'), { recursive: true });
    await fs.mkdir(path.join(project, 'Build'));
    await fs.writeFile(path.join(project, 'Source', 'story.ni'), source);
    execFileSync(path.join(internal, 'Compilers', 'inform7'), ['-internal', internal, '-format=Inform6/32d', '-project', project], { stdio: 'pipe', cwd: project });
    const story = path.join(project, 'Build', 'output-test.ulx');
    execFileSync(path.join(internal, 'Compilers', 'inform6'), ['-wxE2kSDG', '$huge', path.join(project, 'Build', 'auto.inf'), story], { stdio: 'pipe', cwd: project });
    const bytes = await fs.readFile(story);
    const scripts = await Promise.all(['quixe.min.js', 'glkote.min.js'].map(name => fs.readFile(path.join(internal, 'Player', 'Quixe', 'lib', name), 'utf8')));
    function launch(install) {
      const timers = new Map(), events = [];
      let serial = 0, display;
      const browser = { console, Uint8Array, TextEncoder, atob: text => Buffer.from(text, 'base64').toString('binary'),
        setTimeout(fn, delay) { timers.set(++serial, { fn, delay }); return serial; }, clearTimeout(id) { timers.delete(id); },
        document: { createElement: () => ({}), getElementById: () => ({ textContent: '', style: {} }) },
        $: () => ({ on() {}, ready(fn) { fn(); } }), game_options: { use_query_story: false, set_page_title: false, inspacing: 0, outspacing: 0 } };
      browser.window = browser; vm.createContext(browser);
      for (const script of scripts) vm.runInContext(script, browser);
      browser.GlkOteClass = class {
        init(iface) {
          display = this; this.iface = iface;
          const accept = iface.accept;
          iface.accept = event => { this.input = event; events.push({ ...event }); return accept(event); };
          iface.accept({ type: 'init', gen: 0, metrics: { width: 800, height: 600, charwidth: 8, charheight: 16 } });
        }
        getinterface() { return this.iface; }
        update(output) {
          this.output = output;
          this.iface.recording_handler?.({ input: this.input || null, output });
          this.input = undefined;
        }
        getlibrary() { return null; }
        log() {}
        error(message) { throw new Error(message); }
        warning() {}
      };
      const embed = fn => vm.runInContext(`(${fn})`, browser);
      const adapter = install(browser.game_options, browser.GlkOteClass, embed, browser);
      browser.GiLoad.load_run(null, bytes.toString('base64'), 'base64');
      assert.ok(browser.GiLoad.inited()); adapter.started();
      return { events, adapter,
        get output() { return display.output; },
        enter(type, value) {
          const output = display.output, request = output.input[0];
          assert.equal(request.type, type, `request before ${type} ${JSON.stringify(value)}`);
          display.iface.accept({ type, value, window: request.id, gen: output.gen });
        },
        async finish(messages, field = 'kind') {
          for (let n = 0; n < 100; n++) {
            await Promise.resolve();
            if (messages.some(message => ['complete', 'stopped', 'PASS', 'FAIL'].includes(message[field]))) return;
            for (const [id, timer] of [...timers]) if (timer.delay === 180) { timers.delete(id); timer.fn(); }
          }
          assert.fail(`Playback did not finish: ${JSON.stringify(messages)}`);
        }
      };
    }
    const errors = [], recorder = new SkeinRecorder(project, { onError: error => errors.push(error.message) });
    const recording = launch((options, GlkOte, embed) => embed(installSkeinRecording)(options, GlkOte,
      message => recorder.receive(message), recorder.sessionId, message => errors.push(message)));
    await Promise.resolve(); await recorder.queue;
    assert.ok(recorder.started, 'startup character prompt is a usable recording state');
    assert.match(recorder.model.items[0].result, /test for skein import/);
    // SPACEPause ignores x and special keys: those repeated requests must
    // remain recorded too. A return key is represented by its GlkOte name.
    const inputs = [['char', 'x'], ['char', 'left'], ['char', ' '], ['line', 'look'],
      ['line', 'jump'], ['char', ' '], ['char', 'return'], ['char', ' '], ['char', 'q'], ['line', 'look']];
    for (const [type, value] of inputs) recording.enter(type, value);
    await recorder.finalize();
    assert.deepEqual(errors, []);
    const saved = await fs.readFile(path.join(project, 'Skein.skein'), 'utf8');
    const commands = parseLinearSkein(saved), turns = parseLinearSkeinTurns(saved);
    assert.deepEqual(commands, inputs.map(([type, value]) => type === 'line' ? value : { type, value }));
    assert.match(turns.find(turn => turn.inputType === 'char' && turn.command === 'q').result, /You chose key 113/);
    assert.match(saved, /test for skein import/, 'clear-screen preserves startup history');
    const replayMessages = [];
    const replay = launch((options, GlkOte, embed) => embed(installSkeinPlayback)(options, GlkOte, commands, 'replay', message => replayMessages.push(message)));
    await replay.finish(replayMessages);
    assert.equal(replayMessages.at(-1).kind, 'complete', JSON.stringify(replayMessages));
    assert.deepEqual(replay.events.filter(e => ['char', 'line'].includes(e.type)).map(e => [e.type, e.value]), inputs);
    const imported = await qualifySkein(extractSkein(saved), { qualify: async sequence => {
      const messages = [];
      const runtime = launch((options, GlkOte, embed) => embed(installRoomQualification)(options, GlkOte, sequence, 'qualify', message => messages.push(message), embed(installSkeinPlayback), observeShowme));
      await runtime.finish(messages);
      assert.equal(messages.at(-1).kind, 'complete', JSON.stringify(messages));
      return messages.at(-1).endpoints;
    } });
    await saveSkeinImport(project, imported, { suiteName: 'Screen effects' });
    const library = await discoverTestVectors(project);
    assert.deepEqual(library.issues, []);
    assert.deepEqual(library.vectors[0].turns, turns);
    const [plan] = qualifiedTests(library.vectors.map(vector => ({ ...vector, type: 'iskein' })));
    const messages = [];
    const tested = launch((options, GlkOte, embed, browser) => {
      const Capture = vm.runInContext(`const runs = ${runs}; (${Skein})`, browser);
      return embed(installTestPlayback)(options, GlkOte, plan, 'test', message => messages.push(message), embed(installCompositionPlayback), embed(installSkeinPlayback), Capture);
    });
    await tested.finish(messages, 'status');
    assert.equal(messages.at(-1).status, 'PASS', JSON.stringify(messages));
    assert.equal(messages.at(-1).compared, inputs.length);
  });
