import test from 'node:test';
import assert from 'node:assert/strict';

const Core = await import('../core.mjs').catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return {};
  throw error;
});

const options = id => ({ id, now: 1791763200000 });

test('frequency input counts repeated values and accepts Chinese separators', () => {
  assert.equal(typeof Core.parseInput, 'function', 'parseInput is required');
  assert.deepEqual(Core.parseInput('１，2 1\n50', 'frequency'), [
    { number: 1, amount: 1 }, { number: 2, amount: 1 },
    { number: 1, amount: 1 }, { number: 50, amount: 1 }
  ]);
});

test('quantity inputs accumulate the exact example from the requirement', () => {
  assert.equal(typeof Core.createState, 'function', 'createState is required');
  let state = Core.createState(options('client-a'));
  state = Core.appendEntry(state, '1（100） 2(50)', options('entry-a'));
  state = Core.appendEntry(state, '1(88) 2:896', options('entry-b'));
  const summary = Core.summarize(Core.currentBatch(state));
  assert.equal(summary.totals[0], 188);
  assert.equal(summary.totals[1], 946);
  assert.equal(summary.total, 1134);
  assert.equal(summary.recordCount, 2);
});

test('invalid or ambiguous input is rejected as a whole', () => {
  assert.equal(typeof Core.parseInput, 'function', 'parseInput is required');
  for (const [text, mode] of [
    ['1 51', 'frequency'], ['1(20) hello 2(30)', 'quantity'],
    ['1 100', 'quantity'], ['0(10)', 'quantity'],
    ['1(-2)', 'quantity'], ['1(1.5)', 'quantity'], ['1(0)', 'quantity']
  ]) assert.throws(() => Core.parseInput(text, mode));
});

test('switching modes preserves independent totals', () => {
  assert.equal(typeof Core.setMode, 'function', 'setMode is required');
  let state = Core.createState(options('client-a'));
  state = Core.appendEntry(state, '1(100)', options('entry-a'));
  state = Core.setMode(state, 'frequency');
  state = Core.appendEntry(state, '1 1 2', options('entry-b'));
  assert.equal(Core.summarize(Core.currentBatch(state)).total, 3);
  state = Core.setMode(state, 'quantity');
  assert.equal(Core.summarize(Core.currentBatch(state)).total, 100);
});

test('undo removes the last input from totals while retaining its event', () => {
  assert.equal(typeof Core.undoLast, 'function', 'undoLast is required');
  let state = Core.createState(options('client-a'));
  state = Core.appendEntry(state, '1(100)', options('entry-a'));
  state = Core.appendEntry(state, '1(88) 2(50)', options('entry-b'));
  state = Core.undoLast(state, options('undo-a'));
  const batch = Core.currentBatch(state);
  assert.equal(Core.summarize(batch).total, 100);
  assert.equal(batch.events.length, 3);
  assert.equal(batch.events[2].targetId, 'entry-b');
  state = Core.undoLast(state, options('undo-b'));
  assert.equal(Core.summarize(Core.currentBatch(state)).total, 0);
  assert.throws(() => Core.undoLast(state, options('undo-c')));
});

test('new batches preserve history and exported data restores without credentials', () => {
  assert.equal(typeof Core.validateState, 'function', 'validateState is required');
  let state = Core.createState(options('client-a'));
  state = Core.appendEntry(state, '1(188)', options('entry-a'));
  state = Core.newBatch(state, '第二批', options('batch-new'));
  assert.equal(Core.summarize(Core.currentBatch(state)).total, 0);
  assert.equal(state.batches.length, 3);
  const restored = Core.validateState(JSON.parse(JSON.stringify(state)));
  assert.deepEqual(restored, state);
  const broken = structuredClone(state);
  broken.batches[0].events[0].entries[0].number = 51;
  assert.throws(() => Core.validateState(broken));
});
