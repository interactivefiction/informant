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

const vscode = require('vscode');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const { TextDecoder } = require('util');
const { parseLinearSkein, replayInput } = require('./skein');
const { makeTestVector } = require('./make-test-vector');
const { extractSkein, qualifySkein, saveSkeinImport } = require('./skein-import');
const { discoverTestVectors } = require('./test-vector-library');
const { discoverCompositions, playablesFrom, discoverPlayables, saveComposition } = require('./composition-library');
const { createWorkingComposition, editMembers, resolver, compositionView } = require('./icomposition');

const { loadCompositionPlayback } = require('./composition-playback');
const { workingState, ensureNoWorking, acceptContinuation, discardContinuation } = require('./working-iskein');

const { discoverCollections, saveNewCollection, addCollectionMember, setCollectionBehavior } = require('./collection-library');
const { memberKey } = require('./icollection');

const { qualifiedTests, runTests } = require('./test-runner');
const { exportResults } = require('./test-results');

const panels = new Map();

async function workingSkein(project) {
  let bytes;
  try { bytes = await fs.readFile(path.join(project, 'Skein.skein')); }
  catch (error) {
    if (error.code === 'ENOENT') return { status: 'missing', message: 'No working Skein. Record Skein to create Skein.skein.' };
    return { status: 'unreadable', message: 'Skein.skein could not be read. Check the file and its permissions.' };
  }
  try {
    const commands = parseLinearSkein(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    return { status: 'available', count: commands.length, message: `${commands.length} recorded ${commands.length === 1 ? 'command' : 'commands'}` };
  } catch {
    return { status: 'unsupported', message: 'Skein.skein exists. Command count unavailable: the file is not a supported Informant linear Skein or contains invalid data.' };
  }
}

// All dynamic text, including persisted vector content, is rendered with textContent.
function browserMain() {
  const vscode = acquireVsCodeApi();
  function add(parent, tag, value) {
    const node = document.createElement(tag);
    node.textContent = value;
    parent.appendChild(node);
    return node;
  }
  function entryLabel(entry) { return entry === 'initial' ? 'Starter Vector' : 'Continuation Vector'; }
  function turnsLabel(count) { return count + (count === 1 ? ' turn' : ' turns'); }
  function endpoint(parent, label, value) {
    parent = add(parent, 'div', '');
    parent.className = 'endpoint';
    add(parent, 'h3', label);
    if (value.type === 'termination') {
      add(parent, 'p', 'Termination — normal story termination (leaf endpoint).');
    } else {
      add(parent, 'p', value.location);
      add(parent, 'p', 'Observation (CRC-32): ' + value.observation);
    }
  }
  let lastSelectedGuid, currentState;
  let creatingSuite = false;
  const suiteSelect = document.getElementById('test-suite');
  document.getElementById('import-skein').addEventListener('click', () => vscode.postMessage({ type: 'testManager.importSkein' }));
  const suiteDialog = document.getElementById('create-suite-dialog');
  function openSuiteDialog() {
    const inherit = document.getElementById('suite-inherit');
    inherit.replaceChildren();
    add(inherit, 'option', 'None').value = '';
    add(inherit, 'option', 'All Playables').value = 'all';
    for (const collection of currentState?.collections || []) add(inherit, 'option', collection.name).value = collection.guid;
    document.getElementById('suite-name').value = '';
    document.getElementById('suite-error').textContent = '';
    suiteDialog.showModal();
    document.getElementById('suite-name').focus();
  }
  suiteSelect.addEventListener('change', () => {
    const guid = suiteSelect.value;
    suiteSelect.value = currentState?.activeCollectionGuid || '';
    if (guid === 'create') openSuiteDialog();
    else vscode.postMessage({ type: 'testManager.selectSuite', guid });
  });
  document.getElementById('cancel-suite').addEventListener('click', () => suiteDialog.close());
  suiteDialog.addEventListener('cancel', event => { if (creatingSuite) event.preventDefault(); });
  document.getElementById('create-suite-form').addEventListener('submit', event => {
    event.preventDefault();
    const name = document.getElementById('suite-name').value.trim();
    if (!name || creatingSuite || currentState?.busy) return;
    creatingSuite = true;
    document.getElementById('create-suite').disabled = true;
    document.getElementById('cancel-suite').disabled = true;
    vscode.postMessage({ type: 'testManager.createSuite', name, sourceGuid: document.getElementById('suite-inherit').value || null });
  });
  function renderSuites(data) {
    suiteSelect.replaceChildren();
    if (!data.activeCollectionGuid) {
      const placeholder = add(suiteSelect, 'option', 'Test Suite');
      placeholder.value = ''; placeholder.disabled = true;
    }
    for (const collection of data.collections || []) add(suiteSelect, 'option', collection.name).value = collection.guid;
    add(suiteSelect, 'option', '<create new suite>').value = 'create';
    suiteSelect.value = data.activeCollectionGuid || '';
    suiteSelect.disabled = !!data.busy;
    document.getElementById('import-skein').disabled = !!data.busy;
    const issues = document.getElementById('suite-issues');
    issues.replaceChildren();
    for (const issue of data.collectionIssues || []) add(issues, 'li', issue.file + ': ' + issue.message);
    if (creatingSuite && data.collectionResult && !data.busy) {
      creatingSuite = false;
      document.getElementById('create-suite').disabled = false;
      document.getElementById('cancel-suite').disabled = false;
      if (data.collectionResult.guid) suiteDialog.close();
      else document.getElementById('suite-error').textContent = data.collectionResult.error;
    }
    document.getElementById('create-suite').disabled = creatingSuite || !!data.busy;
  }

  const saved = vscode.getState?.() || {};
  const filters = saved.filters || {};
  const paneWidths = saved.paneWidths || {};
  function presented(vectors, prefix) {
    const filter = filters[prefix] || {};
    return vectors.filter(vector => vector.name.toLocaleLowerCase().includes((filter.search || '').toLocaleLowerCase())
      && (!filter.type || filter.type === 'all' || (vector.type === 'icomposition' ? filter.type === 'composition' : vector.entry === filter.type)))
      .sort((a, b) => {
        const names = a.name.localeCompare(b.name) || a.guid.localeCompare(b.guid);
        if (filter.sort === 'za') return -names;
        if (filter.sort === 'type') return playableLabel(a).localeCompare(playableLabel(b)) || names;
        return names;
      });
  }
  function remember() { vscode.setState?.({ filters, paneWidths }); }
  function setupDivider(view) {
    const workspace = document.getElementById(view + '-view');
    const divider = document.getElementById(view + '-divider');
    const defaultWidth = view === 'compositions' ? 100 / 2.2 : 35;
    let width = Number.isFinite(paneWidths[view]) ? paneWidths[view] : defaultWidth;
    let pointerId = null;
    let grabOffset = 0;
    function resize(value) {
      width = Math.max(15, Math.min(85, value));
      workspace.style.gridTemplateColumns = 'minmax(0, ' + width + 'fr) 6px minmax(0, ' + (100 - width) + 'fr)';
      divider.setAttribute('aria-valuenow', String(Math.round(width)));
      paneWidths[view] = width;
    }
    if (Number.isFinite(paneWidths[view])) resize(width);
    divider.addEventListener('pointerdown', event => {
      if (event.button !== 0 || pointerId !== null) return;
      event.preventDefault();
      pointerId = event.pointerId;
      grabOffset = event.clientX - divider.getBoundingClientRect().left;
      divider.setPointerCapture(pointerId);
      divider.focus();
      divider.classList.add('dragging');
    });
    divider.addEventListener('pointermove', event => {
      if (event.pointerId !== pointerId) return;
      const bounds = workspace.getBoundingClientRect();
      const available = workspace.clientWidth - divider.offsetWidth;
      if (available > 0) resize(100 * (event.clientX - bounds.left - workspace.clientLeft - grabOffset) / available);
    });
    function finish(event) {
      if (event.pointerId !== pointerId) return;
      pointerId = null;
      divider.classList.remove('dragging');
      if (divider.hasPointerCapture(event.pointerId)) divider.releasePointerCapture(event.pointerId);
      remember();
    }
    divider.addEventListener('pointerup', finish);
    divider.addEventListener('pointercancel', finish);
    divider.addEventListener('lostpointercapture', finish);
    divider.addEventListener('keydown', event => {
      const step = event.shiftKey ? 10 : 2;
      const values = { ArrowLeft: width - step, ArrowRight: width + step, Home: 15, End: 85 };
      if (!Object.hasOwn(values, event.key)) return;
      event.preventDefault();
      resize(values[event.key]);
      remember();
    });
    divider.addEventListener('dblclick', () => { resize(defaultWidth); remember(); });
  }
  function setupFilters(prefix, render) {
    for (const key of ['search', 'type', 'sort']) {
      const control = document.getElementById(prefix + '-' + key);
      control.value = filters[prefix]?.[key] || (key === 'search' ? '' : key === 'type' ? 'all' : 'az');
      control.addEventListener(key === 'search' ? 'input' : 'change', () => {
        filters[prefix] = { ...filters[prefix], [key]: control.value };
        remember();
        render();
      });
    }
  }
  function renderLibrary(library, selectedGuid, busy) {
    const list = document.getElementById('vectors');
    const listScroll = list.scrollTop;
    const focusedGuid = document.activeElement?.dataset?.guid;
    list.replaceChildren();
    document.getElementById('library-status').textContent = library.status === 'unreadable'
      ? 'The test vector library could not be read.'
      : library.vectors.length ? library.vectors.length + ' test vectors'
        : currentState?.activeCollectionGuid ? 'No test vectors in this Test Suite.' : 'No saved test vectors. Use Accept Starter Vector to create one.';
    const issues = document.getElementById('library-issues');
    issues.replaceChildren();
    for (const issue of library.issues) add(issues, 'li', issue.file + ': ' + issue.message);
    const visible = presented(library.vectors, 'library');
    if (!visible.length && library.vectors.length) add(list, 'li', 'No vectors match these filters.');
    for (const vector of visible) {
      const item = add(list, 'li', '');
      const button = add(item, 'button', vector.name);
      button.type = 'button';
      button.dataset.guid = vector.guid;
      button.setAttribute('aria-pressed', String(vector.guid === selectedGuid));
      button.addEventListener('click', () => vscode.postMessage({ type: 'testManager.selectVector', guid: vector.guid }));
      add(item, 'small', entryLabel(vector.entry) + ' · ' + turnsLabel(vector.turnCount));
      if (vector.guid === focusedGuid) button.focus({ preventScroll: true });
    }
    list.scrollTop = listScroll;
    const details = document.getElementById('vector-details');
    const scroll = details.scrollTop;
    const focusAction = document.activeElement?.textContent;
    details.replaceChildren();
    const selected = library.vectors.find(vector => vector.guid === selectedGuid);
    const summary = add(details, 'div', '');
    summary.className = 'vector-summary';
    const controls = add(summary, 'div', '');
    controls.className = 'vector-controls';
    add(controls, 'h3', selected ? selected.name : 'No vector selected');
    const actions = add(controls, 'div', '');
    actions.className = 'actions';
    const play = add(actions, 'button', 'Play');
    play.type = 'button';
    play.disabled = !!busy || !selected || selected.entry !== 'initial';
    play.addEventListener('click', () => vscode.postMessage({ type: 'testManager.playVector' }));
    const record = add(actions, 'button', 'Record Continuation');
    record.type = 'button';
    record.disabled = !!busy || !!currentState?.continuation?.exists || (!currentState?.continuationOrigin && (!selected || selected.entry !== 'initial' || selected.end.type === 'termination'));
    record.title = currentState?.continuationOrigin ? 'Record from live END: ' + currentState.continuationOrigin.name : 'Replay the selected Starter Vector, then record';
    record.addEventListener('click', () => vscode.postMessage({ type: 'testManager.recordContinuation' }));
    if (focusAction === 'Play') play.focus({ preventScroll: true });
    if (focusAction === 'Record Continuation') record.focus({ preventScroll: true });
    const nextScroll = lastSelectedGuid !== selectedGuid ? 0 : scroll;
    lastSelectedGuid = selectedGuid;
    if (!selected) { add(details, 'p', 'Select a vector to inspect its saved endpoints and transcript.'); return; }
    const metadata = add(summary, 'div', '');
    metadata.className = 'vector-metadata';
    add(metadata, 'p', entryLabel(selected.entry));
    if (selected.entry === 'continuation') add(controls, 'p', 'Requires prior state/composition. Standalone playback is unavailable.');
    if (selected.end.type === 'termination') add(controls, 'p', 'A terminated story cannot be continued.');
    add(metadata, 'p', 'GUID: ' + selected.guid);
    endpoint(metadata, 'Start Endpoint', selected.start);
    endpoint(metadata, 'End Endpoint', selected.end);
    add(details, 'h3', 'Recorded Transcript — ' + turnsLabel(selected.turnCount));
    const transcript = add(details, 'ol', '');
    for (const turn of selected.turns) {
      const item = add(transcript, 'li', '');
      add(item, 'pre', turn.inputType === 'char' ? '[key: ' + (turn.command === ' ' ? 'Space' : turn.command) + ']' : '> ' + turn.command);
      add(item, 'pre', turn.result);
    }
    details.scrollTop = nextScroll;
  }
  let availableKey = null, memberIndex = -1, loadedCompositionGuid;
  function playableKey(value) { return value.type + ':' + value.guid; }
  function playableLabel(value) { return value.type === 'icomposition' ? 'Composition' : entryLabel(value.entry); }
  function renderComposition() {
    const view = currentState?.composition;
    if (!view) return;
    if (view.committed?.guid !== loadedCompositionGuid) {
      memberIndex = view.members.length - 1;
      loadedCompositionGuid = view.committed?.guid;
    }
    const busy = currentState.busy;
    const focused = document.activeElement?.dataset || {};
    const visible = presented(view.candidates, 'playables');
    if (!visible.some(value => playableKey(value) === availableKey)) availableKey = null;
    const available = document.getElementById('playables'), scroll = available.scrollTop;
    available.replaceChildren();
    document.getElementById('playables-count').textContent = 'Available Playables (' + view.candidates.length + ')';
    for (const playable of visible) {
      const row = add(available, 'li', ''), id = playableKey(playable);
      if (playable.strength) row.className = 'candidate-' + playable.strength;
      const button = add(row, 'button', playable.name);
      button.dataset.playable = id;
      button.setAttribute('aria-pressed', String(id === availableKey));
      button.addEventListener('click', () => { availableKey = id; renderComposition(); });
      add(row, 'small', playableLabel(playable) + ' · ' + playable.guid);
      const guidance = add(row, 'small', playable.reason || playable.guidance);
      if (id === availableKey) {
        const append = add(row, 'button', 'Add →');
        append.id = 'add-member';
        append.className = 'row-action';
        append.dataset.append = id;
        append.disabled = busy || !!playable.reason;
        append.title = playable.reason || playable.guidance || 'Append selected Playable';
        guidance.id = 'append-guidance';
        append.setAttribute('aria-describedby', guidance.id);
        append.addEventListener('click', () => {
          memberIndex = view.members.length;
          sendComposition('add', { reference: { type: playable.type, guid: playable.guid } });
        });
        if (focused.append === id) {
          (append.disabled ? button : append).focus({ preventScroll: true });
        }
      }
      if (focused.playable === id) button.focus({ preventScroll: true });
    }
    if (!visible.length) add(available, 'li', 'No playables match these filters.');
    available.scrollTop = scroll;
    const selected = view.candidates.find(value => playableKey(value) === availableKey);
    document.getElementById('load-composition').disabled = busy || selected?.type !== 'icomposition';
    const ordered = document.getElementById('members'), orderedScroll = ordered.scrollTop;
    ordered.replaceChildren();
    memberIndex = Math.min(memberIndex, view.members.length - 1);
    document.getElementById('member-count').textContent = 'Current Composition (' + view.members.length + ')';
    view.members.forEach((member, index) => {
      const row = add(ordered, 'li', '');
      const button = add(row, 'button', (index + 1) + '. ' + (member.playable?.name || 'Missing ' + member.type + ': ' + member.guid));
      button.dataset.member = String(index);
      button.setAttribute('aria-pressed', String(index === memberIndex));
      button.addEventListener('click', () => { memberIndex = index; renderComposition(); });
      add(row, 'small', (member.playable ? playableLabel(member.playable) : 'Unresolved reference') + ' · ' + member.guid);
      if (index === view.members.length - 1) {
        const remove = add(row, 'button', 'Remove');
        remove.id = 'remove-member';
        remove.className = 'row-action';
        remove.dataset.remove = 'last';
        remove.disabled = !!busy;
        remove.addEventListener('click', () => sendComposition('remove', { index }));
        if (focused.remove) (remove.disabled ? button : remove).focus({ preventScroll: true });
      }
      if (focused.member === String(index)) button.focus({ preventScroll: true });
    });
    ordered.scrollTop = orderedScroll;
    const name = document.getElementById('composition-name');
    if (document.activeElement !== name) name.value = view.name;
    name.disabled = !!busy;
    document.getElementById('save-composition').disabled = busy || !!view.error;
    document.getElementById('new-composition').disabled = !!busy;
    const dirty = view.committed && (view.name !== view.committed.name || JSON.stringify(view.members.map(({ type, guid }) => ({ type, guid }))) !== JSON.stringify(view.committed.members));
    document.getElementById('play-composition').disabled = busy || !view.committed || !!dirty;
    document.getElementById('play-composition').title = dirty ? 'Save or reload edits before playing the accepted composition.' : 'Play the loaded accepted composition';
    document.getElementById('record-composition-continuation').disabled = !!busy || !view.committed || !!dirty || !!view.error || view.end?.type === 'termination' || !!currentState.continuation?.exists;
    document.getElementById('record-composition-continuation').title = 'Replay the loaded accepted composition, then record a continuation';
    document.getElementById('composition-status').textContent = view.error || 'Ready to commit. Structural matches do not prove behavioral compatibility.';
    const details = document.getElementById('composition-endpoints');
    details.replaceChildren();
    add(details, 'p', view.committed ? 'Editing GUID: ' + view.committed.guid : 'New working composition');
    for (const label of ['start', 'end']) {
      if (view[label]) endpoint(details, 'Working ' + label.toUpperCase(), view[label]);
      else add(details, 'p', 'Working ' + label.toUpperCase() + ': unavailable');
      if (view.committed) endpoint(details, 'Committed ' + label.toUpperCase(), view.committed[label]);
    }
    const issues = document.getElementById('composition-issues');
    issues.replaceChildren();
    for (const issue of currentState.compositionIssues || []) add(issues, 'li', issue.file + ': ' + issue.message);
  }
  setupFilters('playables', renderComposition);
  const sendComposition = (action, extra = {}) => vscode.postMessage({ type: 'testManager.composition', action, ...extra });
  document.getElementById('composition-name').addEventListener('input', event => sendComposition('name', { name: event.target.value }));
  for (const [id, action] of [['play-composition', 'play'], ['record-composition-continuation', 'record'], ['save-composition', 'save'], ['load-composition', 'load'], ['new-composition', 'new']]) {
    document.getElementById(id).addEventListener('click', () => {
      const selected = currentState?.composition?.candidates.find(value => playableKey(value) === availableKey);
      const index = memberIndex;
      if (action === 'new' || action === 'load') memberIndex = -1;
      sendComposition(action, { index, reference: selected ? { type: selected.type, guid: selected.guid } : null });
    });
  }
  let appliedBehavior = null;
  let activeTab = 'vectors', selectedTests = new Set(), selectedFailure = -1, testFrame, frameURL, frameToken;
  function clearFrame() {
    document.getElementById('test-frame-host').replaceChildren();
    if (frameURL) URL.revokeObjectURL(frameURL);
    testFrame = undefined; frameURL = undefined; frameToken = undefined;
  }
  function renderTests() {
    const tests = currentState?.tests || [], run = currentState?.testRun;
    const running = run?.state === 'Running', busy = !!currentState?.busy;
    const keys = new Set(tests.map(playableKey));
    if ([...selectedTests].some(key => !keys.has(key))) appliedBehavior = null;
    selectedTests = new Set([...selectedTests].filter(key => keys.has(key)));
    const list = document.getElementById('test-list'), scroll = list.scrollTop;
    list.replaceChildren();
    const query = (document.getElementById('test-search').value || '').toLocaleLowerCase();
    for (const test of tests.filter(value => value.name.toLocaleLowerCase().includes(query))) {
      const row = add(list, 'li', ''), label = add(row, 'label', '');
      const checkbox = add(label, 'input', ''); checkbox.type = 'checkbox'; checkbox.checked = selectedTests.has(playableKey(test)); checkbox.disabled = busy;
      const text = add(label, 'span', test.name);
      const behavior = test.behavior || 'stepwise';
      const badge = add(row, 'span', { stepwise: 'S', endpoint: 'E', none: 'N' }[behavior]);
      badge.className = 'test-behavior test-behavior-' + behavior;
      badge.title = { stepwise: 'Step: verify every response', endpoint: 'End: verify final response', none: 'None: execution only' }[behavior];
      badge.setAttribute('aria-label', badge.title);
      add(text, 'small', (test.type === 'icomposition' ? 'Composition' : 'Starter Vector') + ' · ' + turnsLabel(test.turnCount));
      checkbox.addEventListener('change', () => {
        appliedBehavior = null;
        if (checkbox.checked) selectedTests.add(playableKey(test)); else selectedTests.delete(playableKey(test));
        renderTests();
      });
    }
    list.scrollTop = scroll;
    if (!tests.length) add(list, 'li', 'No independently testable Playables in this Test Suite.');
    document.getElementById('run-tests').disabled = busy || !selectedTests.size;
    document.getElementById('run-tests').textContent = 'Run Selected Tests (' + selectedTests.size + ')';
    for (const behavior of ['stepwise', 'endpoint', 'none']) {
      const button = document.getElementById('behavior-' + behavior);
      button.disabled = busy || !selectedTests.size || !currentState?.activeCollectionGuid;
      button.setAttribute('aria-pressed', String(appliedBehavior === behavior));
    }
    document.getElementById('test-all').disabled = busy;
    document.getElementById('test-none').disabled = busy;
    document.getElementById('cancel-tests').disabled = !running;
    document.getElementById('save-results').disabled = running || !run?.results.length;
    const results = document.getElementById('test-results'), resultScroll = results.scrollTop;
    results.replaceChildren();
    const rows = run?.results || [];
    rows.forEach((row, index) => {
      const item = add(results, 'li', '');
      const button = add(item, 'button', (index + 1) + '. ' + row.name + ' — ' + row.status + (row.status === 'RUNNING' && row.currentStep ? ' · ' + row.currentStep : '') + (row.durationMs !== undefined ? ' · ' + (row.durationMs / 1000).toFixed(2) + ' s' : ''));
      button.className = row.status === 'PASS' ? 'pass' : row.status === 'FAIL' ? 'fail' : '';
      button.setAttribute('aria-pressed', String(index === selectedFailure));
      button.addEventListener('click', () => { selectedFailure = index; renderTests(); });
    });
    results.scrollTop = resultScroll;
    document.getElementById('test-progress').textContent = run ? run.state + ' · ' + rows.filter(row => row.status === 'PASS').length + ' passed · ' + rows.filter(row => row.status === 'FAIL').length + ' failed' : 'Select tests to begin.';
    const details = document.getElementById('test-failure'); details.replaceChildren();
    const failure = rows[selectedFailure]?.failure;
    if (failure) {
      add(details, 'h3', 'Failure Details — ' + failure.playableName);
      add(details, 'p', failure.playableGuid);
      add(details, 'p', failure.reason);
      if (failure.position !== undefined) add(details, 'p', 'Command ' + failure.position + ' of ' + rows[selectedFailure].turnCount);
      if (failure.context) add(details, 'p', failure.context + ' · vector turn ' + failure.vectorTurn);
      for (const [title, text] of [['Command', failure.command], ['Expected Response', failure.expected], ['Received Response', failure.received]]) {
        if (text !== undefined) { add(details, 'h3', title); add(details, 'pre', text); }
      }
    }
  }
  document.getElementById('test-search').addEventListener('input', renderTests);
  document.getElementById('test-all').addEventListener('click', () => { appliedBehavior = null; selectedTests = new Set((currentState?.tests || []).map(playableKey)); renderTests(); });
  document.getElementById('test-none').addEventListener('click', () => { appliedBehavior = null; selectedTests.clear(); renderTests(); });
  for (const behavior of ['stepwise', 'endpoint', 'none']) {
    document.getElementById('behavior-' + behavior).addEventListener('click', () => {
      appliedBehavior = behavior;
      vscode.postMessage({ type: 'testManager.setBehavior', collectionGuid: currentState.activeCollectionGuid, behavior,
        references: (currentState.tests || []).filter(value => selectedTests.has(playableKey(value))).map(({ type, guid }) => ({ type, guid })) });
      renderTests();
    });
  }
  document.getElementById('run-tests').addEventListener('click', () => {
    selectedFailure = -1;
    vscode.postMessage({ type: 'testManager.runTests', references: (currentState?.tests || []).filter(value => selectedTests.has(playableKey(value))).map(({ type, guid }) => ({ type, guid })) });
  });
  document.getElementById('cancel-tests').addEventListener('click', () => vscode.postMessage({ type: 'testManager.cancelTests' }));
  document.getElementById('save-results').addEventListener('click', () => vscode.postMessage({ type: 'testManager.saveResults' }));
  window.addEventListener('message', event => {
    const data = event.data;
    if (data?.type === 'test.frame' && event.source === testFrame?.contentWindow && data.token === frameToken) {
      vscode.postMessage(data); return;
    }
    if (event.source === testFrame?.contentWindow && testFrame) return;
    if (data?.type === 'test.frame.load' && activeTab === 'test') {
      clearFrame(); frameToken = data.token;
      testFrame = document.createElement('iframe');
      testFrame.setAttribute('tabindex', '-1'); testFrame.setAttribute('title', 'Background test interpreter');
      frameURL = URL.createObjectURL(new Blob([data.html], { type: 'text/html' }));
      testFrame.src = frameURL;
      document.getElementById('test-frame-host').appendChild(testFrame); return;
    }
    if (data?.type === 'test.frame.remove' && data.token === frameToken) { clearFrame(); return; }
    if (data?.type !== 'testManager.state') return;
    if (currentState?.activeCollectionGuid !== data.activeCollectionGuid) { selectedTests.clear(); appliedBehavior = null; }
    if (data.behaviorError) appliedBehavior = null;
    currentState = data;
    if (activeTab === 'test') renderTests();
    if (data.collections) renderSuites(data);
    document.getElementById('project').textContent = data.project;
    document.getElementById('status').textContent = data.skein.message;
    document.getElementById('status').hidden = data.skein.status === 'missing' || (data.skein.status === 'available' && !data.skein.count);
    document.getElementById('make-vector').disabled = data.busy || data.skein.status !== 'available' || !data.skein.count;
    document.getElementById('operation').textContent = data.operation || '';
    if (data.continuation) {
      document.getElementById('continuation-status').textContent = data.continuation.message;
      document.getElementById('continuation-status').hidden = !data.continuation.exists;
      document.getElementById('continuation-source').textContent = data.continuation.source ? 'Source: ' + data.continuation.source : '';
      document.getElementById('accept-continuation').disabled = data.busy || !data.continuation.canAccept;
      document.getElementById('discard-continuation').disabled = data.busy || !data.continuation.exists;
    }
    if (data.library) { renderLibrary(data.library, data.selectedGuid, data.busy); renderComposition(); }
  });
  document.getElementById('refresh').addEventListener('click', () => vscode.postMessage({ type: 'testManager.refresh' }));
  document.getElementById('make-vector').addEventListener('click', () => vscode.postMessage({ type: 'testManager.makeVector' }));
  document.getElementById('accept-continuation').addEventListener('click', () => vscode.postMessage({ type: 'testManager.acceptContinuation' }));
  document.getElementById('discard-continuation').addEventListener('click', () => vscode.postMessage({ type: 'testManager.discardContinuation' }));
  setupFilters('library', () => { if (currentState?.library) renderLibrary(currentState.library, currentState.selectedGuid, currentState.busy); });
  for (const view of ['vectors', 'compositions', 'test']) {
    setupDivider(view);
    document.getElementById(view + '-tab').addEventListener('click', () => {
      if (activeTab === 'test' && view !== 'test') {
        clearFrame(); appliedBehavior = null; selectedTests.clear(); selectedFailure = -1;
        document.getElementById('test-search').value = '';
        if (currentState) currentState.testRun = null;
        renderTests();
      }
      activeTab = view;
      vscode.postMessage({ type: 'testManager.tab', view });
      if (view === 'test') renderTests();
      for (const name of ['vectors', 'compositions', 'test']) {
        document.getElementById(name + '-view').hidden = name !== view;
        document.getElementById(name + '-tab').setAttribute('aria-selected', String(name === view));
      }
    });
  }
  vscode.postMessage({ type: 'testManager.ready' });
}

async function openTestManager(project, context, qualify, playVector, recordContinuation, livePlayback = {}, executeTest, testResourceRoots = []) {
  const existing = panels.get(project);
  if (existing) {
    existing.panel.reveal();
    await existing.refresh();
    return;
  }
  const panel = vscode.window.createWebviewPanel('informant.testManager', 'Informant Test Manager', vscode.ViewColumn.Active,
    { enableScripts: true, localResourceRoots: testResourceRoots.map(root => vscode.Uri.file(root)) });
  let disposed = false, revision = 0, busy = false, operation = '', controller;
  const nonce = crypto.randomBytes(16).toString('hex');
  let testActive = false, testEpoch = 0, testController, testPlans = [], testRun = null;
  async function resetTests() {
    ++testEpoch; testController?.abort(); testController = undefined; testRun = null;
    if (!disposed) await refresh();
  }
  async function startTests(references) {
    if (disposed || busy || !testActive || testController) return;
    const epoch = ++testEpoch, abort = new AbortController();
    testController = abort;
    try {
      await refresh();
      if (disposed || epoch !== testEpoch) return;
      if (!Array.isArray(references) || !references.length) throw new Error('Select at least one test.');
      const keys = new Set(references.map(memberKey));
      const plans = testPlans.filter(plan => keys.has(memberKey(plan)));
      if (plans.length !== keys.size) throw new Error('A selected test is no longer available in this Test Suite.');
      if (!executeTest) throw new Error('Test execution is unavailable.');
      testRun = { project, suite: collections.find(value => value.guid === activeCollectionGuid)?.name,
        started: new Date().toISOString(), state: 'Running', results: [] };
      await runTests(plans, (plan, signal, onStep) => executeTest(plan, signal, panel, nonce, onStep), abort.signal, results => {
        if (epoch !== testEpoch || disposed) return;
        testRun.results = results.map(row => ({ ...row }));
        void refresh().catch(() => {});
      });
      if (epoch === testEpoch) testRun.state = abort.signal.aborted ? 'Cancelled' : 'Complete';
    } catch (error) {
      if (epoch === testEpoch) operation = `Test run failed: ${error.message}`;
    } finally {
      if (epoch === testEpoch) { testController = undefined; if (!disposed) await refresh(); }
    }
  }
  async function saveTestResults() {
    if (!testActive || !testRun?.results.length || testController) return;
    const epoch = testEpoch, bytes = exportResults(testRun);
    const uri = await vscode.window.showSaveDialog({ title: 'Save Test Results', filters: { 'ZIP archive': ['zip'] },
      defaultUri: vscode.Uri.file(path.join(project, 'test-results.zip')) });
    if (!uri || disposed || epoch !== testEpoch || !testActive) return;
    await vscode.workspace.fs.writeFile(uri, bytes);
  }
  const selectionKey = 'informant.testManager.selection:' + project;
  const selection = context.globalState?.get(selectionKey) || {};
  function rememberSelection(values) {
    Object.assign(selection, values);
    return context.globalState?.update(selectionKey, { ...selection });
  }
  let restoreComposition = true;
  let behaviorError = false;
  let collections = [], activeCollectionGuid = selection.collectionGuid || null, collectionResult = null;
  let library = { status: 'missing', vectors: [], issues: [] }, selectedGuid = selection.vectorGuid || null;
  let workingComposition = createWorkingComposition();
  let compositionQueue = Promise.resolve();
  let compositionPlayback = 0;
  async function refresh() {
    const request = ++revision;
    const [skein, discovered, continuation, compositions, suites] = await Promise.all([workingSkein(project), discoverTestVectors(project), workingState(project), discoverCompositions(project), discoverCollections(project)]);
    if (!disposed && request === revision) {
      collections = suites.collections;
      const active = collections.find(value => value.guid === activeCollectionGuid) || collections[0];
      activeCollectionGuid = active?.guid || null;
      const membership = active && new Set(active.members.map(memberKey));
      const includes = playable => !membership || membership.has(memberKey(playable));
      const allPlayables = playablesFrom(discovered.vectors, compositions.compositions);
      const resolve = resolver(allPlayables);
      const missing = (active?.members || []).filter(member => !resolve(member)).map(member => ({
        file: active.name, message: `Missing ${member.type}: ${member.guid}`
      }));
      library = { ...discovered, vectors: discovered.vectors.filter(vector => includes({ ...vector, type: 'iskein' })) };
      if (restoreComposition) {
        restoreComposition = false;
        const saved = compositions.compositions.find(value => value.guid === selection.compositionGuid);
        if (saved) workingComposition = createWorkingComposition(saved);
      }
      // Resolve the working composition against the full library; only candidates are filtered.
      const behaviors = new Map((active?.members || []).map(member => [memberKey(member), member.behavior]));
      testPlans = qualifiedTests(allPlayables, includes).map(plan => ({ ...plan, behavior: behaviors.get(memberKey(plan)) || 'stepwise' }));
      const view = compositionView(workingComposition, allPlayables);
      view.candidates = view.candidates.filter(includes);
      if (!library.vectors.some(vector => vector.guid === selectedGuid)) selectedGuid = null;
      await panel.webview.postMessage({ type: 'testManager.state', project, skein, busy: busy || !!testController, operation, library, selectedGuid, continuation, continuationOrigin: livePlayback.continuationOrigin?.(project),
        composition: view, compositionIssues: compositions.issues,
        collections: collections.map(({ guid, name }) => ({ guid, name })), activeCollectionGuid,
        collectionIssues: [...suites.issues, ...missing], collectionResult, behaviorError,
        tests: testPlans.map(({ guid, name, type, turnCount, behavior }) => ({ guid, name, type, turnCount, behavior })), testRun });
    }
  }
  panels.set(project, { panel, refresh });
  const subscriptions = [];
  panel.onDidDispose(() => {
    disposed = true;
    ++testEpoch; testController?.abort(); testRun = null;
    controller?.abort();
    ++revision;
    panels.delete(project);
    for (const subscription of subscriptions) subscription.dispose();
  });
  context.subscriptions.push(panel);
  async function convert() {
    if (disposed || busy) return;
    busy = true;
    controller = new AbortController();
    operation = 'Preparing test vector…';
    try {
      await refresh();
      const state = await workingSkein(project);
      if (state.status !== 'available' || !state.count) throw new Error('A supported Working Skein with recorded commands is required.');
      const name = await vscode.window.showInputBox({ title: 'Accept Starter Vector', prompt: 'Vector name (blank uses the starting location label and GUID suffix)', placeHolder: 'Optional name', ignoreFocusOut: true });
      if (name === undefined || disposed) { operation = 'Conversion cancelled.'; return; }
      operation = 'Qualifying endpoints by replay, with SHOWME diagnostics…';
      await refresh();
      const vector = await makeTestVector(project, { name, qualify, signal: controller.signal });
      await addToActiveCollection('iskein', vector);
      operation = `Created “${vector.name}” — ${path.basename(vector.file)} (${vector.turns.length} turns).`;
    } catch (error) {
      operation = `Accept Starter Vector failed: ${error.message || error}`;
    } finally {
      busy = false;
      controller = undefined;
      if (!disposed) { await refresh(); panel.reveal(); }
    }
  }
  async function play() {
    if (disposed || busy) return;
    const guid = selectedGuid;
    busy = true;
    controller = new AbortController();
    operation = 'Preparing Play ISkein…';
    try {
      // Re-read through the same containment and v4 validation as the library.
      const discovered = await discoverTestVectors(project);
      const vector = discovered.vectors.find(item => item.guid === guid);
      if (!vector) throw new Error('Select a valid library ISkein vector to play.');
      if (vector.entry !== 'initial') throw new Error('Continuation Vector requires prior state/composition. Standalone playback is unavailable.');
      if (disposed) return;
      await refresh();
      if (disposed) return;
      await playVector(vector.turns.map(replayInput), vector.end.type || 'location', controller.signal);
      operation = `Playing “${vector.name}” in the player.`;
    } catch (error) {
      operation = `Play ISkein failed: ${error.message || error}`;
    } finally {
      busy = false;
      controller = undefined;
      if (!disposed) await refresh();
    }
  }
  async function continuationAction(action) {
    if (disposed || busy) return;
    busy = true; controller = new AbortController();
    try {
      await refresh();
      if (action === 'record') {
        await ensureNoWorking(project);
        const origin = livePlayback.continuationOrigin?.(project);
        if (origin) {
          await livePlayback.recordLiveContinuation(project, refreshFromEvent, controller.signal);
          operation = `Recording continuation from “${origin.name}” at its live END.`;
          return;
        }
        const discovered = await discoverTestVectors(project);
        const vector = discovered.vectors.find(item => item.guid === selectedGuid);
        if (!vector) throw new Error('Select a valid library vector.');
        if (vector.entry !== 'initial') throw new Error('Continuation Vector requires prior state/composition. Standalone recording is unavailable.');
        if (vector.end.type === 'termination') throw new Error('A terminated story cannot be continued.');
        controller.signal.throwIfAborted();
        await recordContinuation(vector, refreshFromEvent, controller.signal);
        operation = `Replaying “${vector.name}”; continue manually when recording begins.`;
      } else if (action === 'accept') {
        const name = await vscode.window.showInputBox({ title: 'Accept Continuation Vector', prompt: 'Vector name (blank uses the starting location label and GUID suffix)', ignoreFocusOut: true });
        if (name === undefined || disposed) return;
        const vector = await acceptContinuation(project, name);
        await addToActiveCollection('iskein', vector);
        selectedGuid = vector.guid;
        await rememberSelection({ vectorGuid: selectedGuid });
        operation = `Accepted “${vector.name}” — ${path.basename(vector.file)} (${vector.turns.length} turns).`;
        if ((await workingState(project)).exists) operation += ' Continue entering commands in the player to record the next continuation.';
      } else {
        await discardContinuation(project);
        operation = 'Continuation Recording discarded.';
      }
    } catch (error) { operation = `Continuation ${action} failed: ${error.message || error}`; }
    finally { busy = false; controller = undefined; if (!disposed) await refresh(); }
  }
  async function addToActiveCollection(type, playable) {
    if (!activeCollectionGuid) return;
    try {
      await addCollectionMember(project, activeCollectionGuid, { type, guid: playable.guid });
    } catch (error) {
      throw new Error(`“${playable.name}” was saved, but could not be added to the active Test Suite: ${error.message}`);
    }
  }
  async function saveWorkingComposition() {
    const discovered = await discoverPlayables(project);
    const { error } = compositionView(workingComposition, discovered.playables);
    if (error) throw new Error(error);
    const name = await vscode.window.showInputBox({
      title: 'Save Composition',
      prompt: 'Name this composition',
      value: workingComposition.name,
      ignoreFocusOut: true,
      validateInput: value => value.trim() ? undefined : 'Composition name is required.'
    });
    if (disposed || name === undefined) return false;
    if (!name.trim()) throw new Error('Composition name is required.');
    const saved = await saveComposition(project, { ...workingComposition, name: name.trim() });
    await addToActiveCollection('icomposition', saved);
    const oldGuid = workingComposition.committed?.guid;
    workingComposition = createWorkingComposition(saved);
    await rememberSelection({ compositionGuid: saved.guid });
    operation = `Saved “${saved.name}” — ${saved.guid}.` + (oldGuid && oldGuid !== saved.guid ? ' New envelope identity; the old composition and parent references are retained.' : '');
    return true;
  }
  async function compositionAction(message) {
    if (disposed || busy) return;
    const action = message.action;
    // Name messages are serialized with edits, so a Save click includes prior input.
    if (action === 'name') {
      if (typeof message.name === 'string') workingComposition.name = message.name;
      await refresh(); return;
    }
    busy = true;
    try {
      if (action === 'play' || action === 'record') {
        const prior = workingComposition.committed;
        if (!prior || workingComposition.name !== prior.name || JSON.stringify(workingComposition.members) !== JSON.stringify(prior.members)) throw new Error('Load or save an accepted composition before playing.');
        const plan = await loadCompositionPlayback(project, prior.guid);
        if (disposed) return;
        controller = new AbortController();
        if (action === 'record') {
          await ensureNoWorking(project);
          if (plan.endpoint === 'termination') throw new Error('A terminated story cannot be continued.');
          operation = `Replaying “${plan.name}”; continue manually when recording begins.`;
          await refresh();
          controller.signal.throwIfAborted();
          await recordContinuation({ name: plan.name, turns: plan.commands.map(command => ({ command })) }, refreshFromEvent, controller.signal);
          return;
        }
        const playback = ++compositionPlayback;
        operation = `Playing composition “${plan.name}”…`;
        await refresh();
        await playVector(plan.commands, plan.endpoint, controller.signal, plan, message => {
          if (playback !== compositionPlayback) return;
          operation = message.message;
          refreshFromEvent();
        });
        controller = undefined;
      } else if (action === 'new') {
        const prior = workingComposition.committed;
        const dirty = prior
          ? workingComposition.name !== prior.name || JSON.stringify(workingComposition.members) !== JSON.stringify(prior.members)
          : workingComposition.members.length > 0;
        if (dirty) {
          const choice = await vscode.window.showWarningMessage(
            'Save changes to the current composition before creating a new one?',
            { modal: true }, 'Save', 'Discard');
          if (disposed || !choice) return;
          if (choice === 'Save') {
            if (!await saveWorkingComposition()) return;
          } else if (choice !== 'Discard') return;
        }
        const name = await vscode.window.showInputBox({
          title: 'New Composition',
          prompt: 'Name the new composition',
          value: workingComposition.members.length ? '' : workingComposition.name,
          ignoreFocusOut: true,
          validateInput: value => value.trim() ? undefined : 'Composition name is required.'
        });
        if (disposed || name === undefined) return;
        if (!name.trim()) throw new Error('Composition name is required.');
        workingComposition = { ...createWorkingComposition(), name: name.trim() };
        operation = '';
      }
      else if (action === 'save') {
        await saveWorkingComposition();
      } else {
        const discovered = await discoverPlayables(project), resolve = resolver(discovered.playables);
        if (disposed) return;
        if (action === 'load') {
          const selected = message.reference?.type === 'icomposition' && resolve(message.reference);
          if (!selected) throw new Error('Select an available composition to load.');
          workingComposition = createWorkingComposition(selected);
          await rememberSelection({ compositionGuid: selected.guid });
          operation = `Loaded “${selected.name}”.`;
        } else {
          if (action === 'add' && (!message.reference || !resolve(message.reference))) throw new Error('Select an available Playable.');
          workingComposition = editMembers(workingComposition, action, message.index, message.reference, resolve);
          operation = '';
        }
      }
    } catch (error) { operation = `Composition ${action} failed: ${error.message}`; }
    finally { busy = false; controller = undefined; if (!disposed) await refresh(); }
  }
  async function importSkein() {
    if (disposed || busy) return;
    busy = true;
    controller = new AbortController();
    const signal = controller.signal;
    try {
      await refresh();
      const files = await vscode.window.showOpenDialog({ title: 'Import Inform Skein', canSelectMany: false,
        defaultUri: vscode.Uri.file(path.join(project, 'Skein.skein')), filters: { 'Inform Skein': ['skein'] } });
      if (!files?.length || disposed) return;
      const extracted = extractSkein(new TextDecoder('utf-8', { fatal: true }).decode(await fs.readFile(files[0].fsPath)));
      const suiteName = await vscode.window.showInputBox({ title: 'Import Skein — New Test Suite',
        prompt: 'Name the Test Suite for the imported vectors and compositions', ignoreFocusOut: true,
        validateInput: value => value.trim() ? undefined : 'Test Suite name is required.' });
      if (suiteName === undefined || disposed) return;
      if (!suiteName.trim()) throw new Error('Test Suite name is required.');
      const imported = await qualifySkein(extracted, { qualify, suiteName, signal, progress: async (index, total) => {
        operation = `Importing Skein: qualifying vector ${index} of ${total} against the current project…`;
        await refresh();
      } });
      signal.throwIfAborted();
      const suite = await saveSkeinImport(project, imported, { suiteName, signal });
      activeCollectionGuid = suite.guid;
      selectedGuid = imported.vectors[0].guid;
      await rememberSelection({ collectionGuid: suite.guid, vectorGuid: selectedGuid });
      const starters = imported.vectors.filter(vector => vector.entry === 'initial').length;
      operation = `Imported ${starters} starter vectors, ${imported.vectors.length - starters} continuation vectors, and ${imported.compositions.length} compositions into “${suite.name}” (${suite.guid}). Source Skein preserved.`;
      if (extracted.omittedQuits) operation += ` Omitted ${extracted.omittedQuits} unanswered trailing quit command(s).`;
    } catch (error) {
      operation = `Skein import failed: ${error.message}`;
      if (!disposed) void vscode.window.showErrorMessage(operation);
    }
    finally {
      busy = false; controller = undefined;
      if (!disposed) { panel.reveal(); await refresh(); }
    }
  }
  async function changeBehavior(message) {
    if (disposed || busy || testController || message.collectionGuid !== activeCollectionGuid) return;
    busy = true; behaviorError = false;
    try {
      await refresh();
      if (message.collectionGuid !== activeCollectionGuid) throw new Error('The active Test Suite changed.');
      if (!Array.isArray(message.references) || message.references.some(ref => !testPlans.some(plan => memberKey(plan) === memberKey(ref)))) throw new Error('A selected test is no longer available.');
      await setCollectionBehavior(project, activeCollectionGuid, message.references, message.behavior);
      operation = 'Test verification behavior saved.';
    } catch (error) { behaviorError = true; operation = `Behavior update failed: ${error.message}`; }
    finally { busy = false; if (!disposed) await refresh(); }
  }
  async function createSuite(message) {
    if (disposed || busy) return;
    busy = true; collectionResult = null;
    try {
      await refresh();
      if (disposed) return;
      if (message.sourceGuid != null && typeof message.sourceGuid !== 'string') throw new Error('Invalid source Test Suite.');
      const saved = await saveNewCollection(project, message.name, message.sourceGuid);
      activeCollectionGuid = saved.guid;
      await rememberSelection({ collectionGuid: saved.guid });
      collectionResult = { guid: saved.guid };
      operation = `Created Test Suite “${saved.name}”.`;
    } catch (error) { collectionResult = { error: error.message }; }
    finally { busy = false; if (!disposed) await refresh(); }
  }
  // The project binding is fixed; selection only accepts a GUID already in this library.
  const refreshFromEvent = () => { if (!disposed) void refresh().catch(() => {}); };
  if (livePlayback.onPlaybackSessionChange) subscriptions.push(livePlayback.onPlaybackSessionChange(refreshFromEvent));
  subscriptions.push(panel.webview.onDidReceiveMessage(message => {
    if (message?.type === 'testManager.tab') {
      testActive = message.view === 'test';
      if (!testActive) void resetTests();
    }
    if (message?.type === 'testManager.runTests') void startTests(message.references);
    if (message?.type === 'testManager.cancelTests') testController?.abort();
    if (message?.type === 'testManager.saveResults') void saveTestResults().catch(error => {
      operation = `Save Results failed: ${error.message}`; refreshFromEvent();
    });
    if (message?.type === 'testManager.ready') { testActive = false; void resetTests(); }
    // Artifact mutation and normal playback cannot interleave with a test run.
    if (testController && !['testManager.ready', 'testManager.refresh'].includes(message?.type)) return;
    if (message?.type === 'testManager.setBehavior') void changeBehavior(message);
    if (message?.type === 'testManager.importSkein') void importSkein();
    if (message?.type === 'testManager.createSuite') void createSuite(message);
    if (message?.type === 'testManager.selectSuite' && !busy && collections.some(value => value.guid === message.guid)) {
      void resetTests();
      activeCollectionGuid = message.guid;
      void Promise.resolve(rememberSelection({ collectionGuid: activeCollectionGuid })).catch(() => {});
      refreshFromEvent();
    }
    if (message?.type === 'testManager.composition') compositionQueue = compositionQueue.then(() => compositionAction(message)).catch(() => {});
    if (message?.type === 'testManager.selectVector' && library.vectors.some(vector => vector.guid === message.guid)) {
      selectedGuid = message.guid;
      void Promise.resolve(rememberSelection({ vectorGuid: selectedGuid })).catch(() => {});
      refreshFromEvent();
    }
    if (message?.type === 'testManager.recordContinuation') void continuationAction('record');
    if (message?.type === 'testManager.acceptContinuation') void continuationAction('accept');
    if (message?.type === 'testManager.discardContinuation') void continuationAction('discard');
    if (message?.type === 'testManager.playVector') void play().catch(() => {});
    if (message?.type === 'testManager.makeVector') void convert().catch(() => {});
    if (message?.type === 'testManager.ready' || message?.type === 'testManager.refresh') refreshFromEvent();
  }));
  subscriptions.push(panel.onDidChangeViewState(event => { if (event.webviewPanel.visible) refreshFromEvent(); }));
  const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(project), 'Skein.skein'));
  subscriptions.push(watcher, watcher.onDidCreate(refreshFromEvent), watcher.onDidChange(refreshFromEvent), watcher.onDidDelete(refreshFromEvent));
  const libraryWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(project), '.informant/test-vectors/**'));
  subscriptions.push(libraryWatcher, libraryWatcher.onDidCreate(refreshFromEvent), libraryWatcher.onDidChange(refreshFromEvent), libraryWatcher.onDidDelete(refreshFromEvent));
  const workingWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(project), '.informant/working/iskein.iskein'));
  subscriptions.push(workingWatcher, workingWatcher.onDidCreate(refreshFromEvent), workingWatcher.onDidChange(refreshFromEvent), workingWatcher.onDidDelete(refreshFromEvent));
  const compositionWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(project), '.informant/compositions/**'));
  subscriptions.push(compositionWatcher, compositionWatcher.onDidCreate(refreshFromEvent), compositionWatcher.onDidChange(refreshFromEvent), compositionWatcher.onDidDelete(refreshFromEvent));
  const collectionWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(project), '.informant/collections/**'));
  subscriptions.push(collectionWatcher, collectionWatcher.onDidCreate(refreshFromEvent), collectionWatcher.onDidChange(refreshFromEvent), collectionWatcher.onDidDelete(refreshFromEvent));
  panel.webview.html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}' 'unsafe-eval'; style-src ${panel.webview.cspSource} 'unsafe-inline'; img-src ${panel.webview.cspSource} data: blob:; font-src ${panel.webview.cspSource}; frame-src blob:; base-uri 'none'; form-action 'none';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Informant Test Manager</title>
<style nonce="${nonce}">
* { box-sizing: border-box; }
html, body { height: 100%; margin: 0; }
body { color: var(--vscode-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); padding: 10px 12px; display: flex; flex-direction: column; gap: 6px; overflow: hidden; }
h1 { font-size: 22px; margin: 0; } h2 { font-size: 15px; margin: 0 0 8px; } h3 { font-size: 14px; margin: 10px 0; }
p { margin: 4px 0; }
.manager-header { display: flex; align-items: baseline; flex-wrap: wrap; gap: 2px 16px; flex: none; }
#suite-issues { flex: none; max-height: 5em; overflow: auto; margin: 0; color: var(--vscode-editorWarning-foreground); }
#suite-issues:empty { display: none; }
dialog { color: var(--vscode-foreground); background: var(--vscode-editor-background); border: 1px solid var(--vscode-panel-border); width: min(420px, 90vw); }
dialog::backdrop { background: rgba(0, 0, 0, .45); }
dialog label { display: grid; gap: 4px; margin: 12px 0; }
#suite-error { color: var(--vscode-errorForeground); }
#test-suite { max-width: 260px; }
#project { min-width: 0; flex: 1 1 240px; margin: 0; white-space: nowrap; overflow: auto; color: var(--vscode-descriptionForeground); }
button, input, select { font: inherit; padding: 6px 10px; border: 1px solid var(--vscode-button-border, var(--vscode-panel-border)); }
button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); cursor: pointer; }
button:hover:enabled { background: var(--vscode-button-hoverBackground); }
:focus-visible { outline: 2px solid var(--vscode-focusBorder); outline-offset: -2px; }
button:disabled { background: var(--vscode-button-secondaryBackground); color: var(--vscode-disabledForeground); border: 1px dashed var(--vscode-disabledForeground); cursor: default; }
input, select { min-width: 0; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border-color: var(--vscode-input-border, var(--vscode-panel-border)); }
.working-region { flex: 0 0 auto; max-height: 26vh; overflow: auto; border: 1px solid var(--vscode-panel-border); }
.working-layout { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }
.working-layout section { min-width: 0; padding: 6px 8px; display: grid; grid-row: span 4; grid-template-rows: subgrid; }
.working-layout section + section { border-left: 1px solid var(--vscode-panel-border); }
.working-layout .actions { align-self: start; }
.working-region > .tabs { padding: 6px 8px; border-top: 1px solid var(--vscode-panel-border); }
.actions { display: flex; flex-wrap: wrap; gap: 8px; }
.recording-heading { display: flex; align-items: baseline; gap: 8px; margin-bottom: 5px; }
.recording-heading h2 { margin: 0; }
.recording-heading span { color: var(--vscode-descriptionForeground); }
.working-layout p { max-height: 2.6em; overflow: auto; overflow-wrap: anywhere; font-size: 12px; }
.working-layout p:empty, #library-issues:empty { display: none; }
.working-layout button { padding: 4px 10px; }
.tabs { display: flex; gap: 4px; flex: none; }
.tabs button[aria-selected="false"] { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
.workspace { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(0, 35fr) 6px minmax(0, 65fr); border: 1px solid var(--vscode-panel-border); }
.workspace > section { min-width: 0; min-height: 0; padding: 8px 10px; overflow: auto; display: flex; flex-direction: column; }
.scroll-list { flex: 1; min-height: 0; overflow: auto; padding: 0; list-style: none; margin: 8px 0 0; }
.scroll-list li { border-bottom: 1px solid var(--vscode-panel-border); }
.scroll-list button { display: block; width: 100%; text-align: left; overflow-wrap: anywhere; background: transparent; color: var(--vscode-foreground); }
.scroll-list button:hover:enabled { background: var(--vscode-list-hoverBackground); }
.scroll-list button[aria-pressed="true"] { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
.scroll-list small { display: block; margin: 3px 10px; color: var(--vscode-descriptionForeground); }
#vector-details { flex: 1; min-height: 0; overflow: auto; overflow-wrap: anywhere; }
.vector-summary { display: grid; grid-template-columns: minmax(180px, 1fr) minmax(0, 1.6fr); gap: 8px 16px; }
.vector-summary h3 { margin: 0 0 5px; }
.vector-metadata { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 3px 12px; align-content: start; font-size: 12px; }
.vector-metadata p { margin: 0; }
.endpoint { grid-column: 1 / -1; display: grid; grid-template-columns: 94px minmax(0, 1fr); gap: 2px 8px; }
.endpoint h3 { grid-row: span 2; font-size: 13px; margin: 0; }
.endpoint p { grid-column: 2; }
#vector-details > ol { margin: 0; padding-left: 28px; }
#library-issues { max-height: 5em; overflow: auto; color: var(--vscode-editorWarning-foreground); }
pre { white-space: pre-wrap; overflow-wrap: anywhere; font-family: var(--vscode-editor-font-family); }
#vector-details p { white-space: pre-wrap; }
#vector-details li { border-top: 1px solid var(--vscode-panel-border); }
.filters > label, .filters input { display: block; width: 100%; } .filters > div { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
.composition-workspace { grid-template-columns: minmax(0, 1fr) 6px minmax(0, 1.2fr); }
.pane-divider { cursor: col-resize; touch-action: none; user-select: none; background: var(--vscode-panel-border); }
.pane-divider:hover, .pane-divider:focus-visible, .pane-divider.dragging { background: var(--vscode-focusBorder); outline: none; }
.composition-name-row { margin-top: 8px; }
#playables li, #members li { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-content: start; }
#playables li > button:first-child, #members li > button:first-child, #playables small, #members small { grid-column: 1; }
.scroll-list .row-action { grid-column: 2; grid-row: 1 / span 3; align-self: center; width: auto; margin: 4px 8px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
.scroll-list .row-action:disabled { background: var(--vscode-button-secondaryBackground); color: var(--vscode-disabledForeground); }
.composition-details { max-height: 45%; overflow: auto; border-top: 1px solid var(--vscode-panel-border); }
#composition-issues { max-height: 5em; overflow: auto; }
.scroll-list small::before { content: '▹ '; }
#playables .candidate-strong { border-left: 4px solid #39a852; background: rgba(57, 168, 82, 0.18); }
#playables .candidate-weak { border-left: 4px solid #d9b52c; background: rgba(217, 181, 44, 0.18); }
#playables .candidate-strong { --candidate-active: #39a852; --candidate-hover: #4cbd65; }
#playables .candidate-weak { --candidate-active: #d9b52c; --candidate-hover: #edca43; }
#playables :is(.candidate-strong, .candidate-weak) button[aria-pressed="true"],
#playables :is(.candidate-strong, .candidate-weak) .row-action:enabled { background: var(--candidate-active); color: #111; }
#playables :is(.candidate-strong, .candidate-weak) button[aria-pressed="true"]:hover:enabled,
#playables :is(.candidate-strong, .candidate-weak) .row-action:hover:enabled { background: var(--candidate-hover); }
#playables :is(.candidate-strong, .candidate-weak) button:focus-visible { outline-color: var(--candidate-active); }
#test-view > section:first-child { overflow: hidden; }
#test-view > section:first-child > :not(#test-list) { flex-shrink: 0; }
#test-list { overflow-y: auto; }
#test-list li { display: flex; align-items: center; gap: 8px; }
#test-list label { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.test-behavior { flex: none; padding: 5px 12px; color: #111; font-weight: bold; }
.test-behavior.test-behavior-stepwise { background: #39a852; }
.test-behavior.test-behavior-endpoint { background: #d99b32; }
.test-behavior.test-behavior-none { background: #39b5b5; }
.behavior-actions { display: flex; gap: 4px; margin-left: auto; }
.behavior-actions button { background: #555; color: #fff; }
.behavior-actions button[aria-pressed="true"] { background: #238636; color: #fff; }
#test-list label { display: flex; gap: 10px; padding: 8px; align-items: center; }
#test-list input { flex: none; }
#test-list small { margin: 0; }
#test-failure { max-height: 55%; overflow: auto; }
#test-failure pre { border: 1px solid var(--vscode-panel-border); padding: 10px; }
#test-results .pass { color: var(--vscode-testing-iconPassed, #73c991); }
#test-results .fail { color: var(--vscode-testing-iconFailed, #f14c4c); }
#test-frame-host { position: fixed; left: -10000px; top: 0; width: 800px; height: 600px; visibility: hidden; pointer-events: none; }
#test-frame-host iframe { width: 800px; height: 600px; border: 0; }
[hidden] { display: none !important; }
@media (max-width: 900px) { .vector-summary { grid-template-columns: 1fr; } }
@media (max-width: 680px) { body { padding: 6px; } .recording-heading { flex-wrap: wrap; gap: 2px 6px; } .workspace > section { padding: 6px; } }

</style></head><body>
<header class="manager-header"><h1>Test Manager</h1><p id="project"></p><label>Test Suite <select id="test-suite" aria-label="Test Suite"></select></label><button id="import-skein" type="button" title="Import an Inform Skein into a new Test Suite">Import</button><button id="suite-help" type="button">HELP</button></header>
<ul id="suite-issues" aria-label="Test Suite issues"></ul>
<dialog id="create-suite-dialog" aria-labelledby="create-suite-heading"><form id="create-suite-form">
<h2 id="create-suite-heading">Create Test Suite</h2>
<label>Collection name<input id="suite-name" required autocomplete="off"></label>
<label>Inherit from<select id="suite-inherit"><option value="">None</option></select></label>
<p id="suite-error" role="alert"></p>
<div class="actions"><button id="create-suite" type="submit">Create</button><button id="cancel-suite" type="button">Cancel</button></div>
</form></dialog>
<div class="working-region"><div class="working-layout"><section aria-labelledby="working"><div class="recording-heading"><h2 id="working">Starter Recording</h2><span>Skein.skein</span></div>
<div class="actions"><button id="refresh" type="button">Refresh</button>
<button id="make-vector" type="button" disabled>Accept Starter Vector</button></div><p id="status" role="status"></p><p id="operation" role="status" aria-live="polite"></p>
</section><section aria-labelledby="continuation-heading"><div class="recording-heading"><h2 id="continuation-heading">Continuation Recording</h2><span>iskein.iskein</span></div>
<div class="actions"><button id="discard-continuation" type="button" disabled>Discard</button>
<button id="accept-continuation" type="button" disabled>Accept Continuation Vector</button></div><p id="continuation-status" role="status"></p><p id="continuation-source"></p></section></div>
<div class="tabs" role="tablist" aria-label="Workspace"><button id="vectors-tab" role="tab" aria-selected="true" aria-controls="vectors-view">Test Vectors</button><button id="compositions-tab" role="tab" aria-selected="false" aria-controls="compositions-view">Compositions</button><button id="test-tab" role="tab" aria-selected="false" aria-controls="test-view">Test</button></div></div>
<div id="vectors-view" class="workspace" role="tabpanel" aria-labelledby="vectors-tab">
<section aria-labelledby="library-heading"><h2 id="library-heading" title=".informant/test-vectors/">Test Vector Library</h2>
<p id="library-status" role="status">Reading test vectors…</p>
<div class="filters"><label>Search by name<input id="library-search" type="search" placeholder="Filter by name…"></label><div><label>Type <select id="library-type"><option value="all">All</option><option value="initial">Starter Vectors</option><option value="continuation">Continuation Vectors</option></select></label><label>Sort <select id="library-sort"><option value="az">Name A–Z</option><option value="za">Name Z–A</option><option value="type">Type</option></select></label></div></div>
<ul id="library-issues" aria-label="Files not loaded"></ul><ul class="scroll-list" tabindex="0" id="vectors" aria-label="Test vectors"></ul></section>
<div id="vectors-divider" class="pane-divider" role="separator" tabindex="0" aria-label="Test Vector panes" aria-orientation="vertical" aria-valuemin="15" aria-valuemax="85" aria-valuenow="35" title="Drag or use arrow keys to resize. Double-click to reset."></div>
<section aria-labelledby="details-heading"><h2 id="details-heading">Selected Vector Details</h2>
<div tabindex="0" id="vector-details"></div></section></div>
<div id="compositions-view" class="workspace composition-workspace" role="tabpanel" aria-labelledby="compositions-tab" hidden>
<section><h2 id="playables-count">Available Playables</h2><div class="filters"><label>Search by name<input id="playables-search" type="search" placeholder="Filter by name…"></label><div><label>Type <select id="playables-type"><option value="all">All</option><option value="initial">Starter Vectors</option><option value="continuation">Continuation Vectors</option><option value="composition">Compositions</option></select></label><label>Sort <select id="playables-sort"><option value="az">Name A–Z</option><option value="za">Name Z–A</option><option value="type">Type</option></select></label></div></div>
<ul id="composition-issues" aria-label="Compositions not loaded"></ul><div class="actions"><button id="load-composition" disabled>Load Selected Composition</button></div>
<ul id="playables" class="scroll-list" tabindex="0" aria-label="Available playables"></ul>
</section><div id="compositions-divider" class="pane-divider" role="separator" tabindex="0" aria-label="Composition panes" aria-orientation="vertical" aria-valuemin="15" aria-valuemax="85" aria-valuenow="45" title="Drag or use arrow keys to resize. Double-click to reset."></div>
<section><h2 id="member-count">Current Composition (0)</h2>
<div class="actions"><button id="new-composition">New Composition</button><button id="save-composition" disabled>Save Composition</button><button id="play-composition" disabled>Play Composition</button><button id="record-composition-continuation" disabled>Record Continuation</button></div>
<label class="composition-name-row">Name <input id="composition-name" placeholder="Untitled composition"></label>
<ul id="members" class="scroll-list" tabindex="0" aria-label="Ordered composition members"></ul>
<div class="composition-details"><h3>Composition Details</h3><p id="composition-status" role="status"></p>
<p>Working edits remain in this Test Manager until saved or closed. New offers to save unsaved changes; Load replaces the working edit. Candidate guidance is structural, not behavioral proof.</p>
<div id="composition-endpoints"></div>
</div>
</section></div>
<div id="test-view" class="workspace" role="tabpanel" aria-labelledby="test-tab" hidden>
<section><h2>Available Tests</h2><p>Independent Playables with qualified start and end endpoints.</p>
<label>Search by name<input id="test-search" type="search" placeholder="Search by name…"></label>
<ul id="test-list" class="scroll-list" aria-label="Available tests"></ul>
<div class="actions"><button id="test-all">Select All</button><button id="test-none">Select None</button><button id="run-tests" disabled>Run Selected Tests</button><div class="behavior-actions" role="group" aria-label="Apply verification behavior to selected tests"><button id="behavior-stepwise" aria-pressed="false" disabled>Step</button><button id="behavior-endpoint" aria-pressed="false" disabled>End</button><button id="behavior-none" aria-pressed="false" disabled>None</button></div></div></section>
<div id="test-divider" class="pane-divider" role="separator" tabindex="0" aria-label="Test panes" aria-orientation="vertical" aria-valuemin="15" aria-valuemax="85" aria-valuenow="35" title="Drag or use arrow keys to resize. Double-click to reset."></div>
<section><h2>Test Run Results</h2><p>Tests run in the background. Each test starts a fresh story.</p>
<p id="test-progress" role="status" aria-live="polite"></p>
<div class="actions"><button id="cancel-tests" disabled>Cancel</button><button id="save-results" disabled>Save Results…</button></div>
<ul id="test-results" class="scroll-list" aria-label="Test run results"></ul>
<div id="test-failure" tabindex="0"></div></section></div>
<div id="test-frame-host" aria-hidden="true"></div>
<script nonce="${nonce}">(${browserMain.toString()})();</script>
</body></html>`;
  await refresh(); // The ready handshake also refreshes after initial load or document recreation.
}

module.exports = { openTestManager };
