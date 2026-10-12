import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

const Cloud = await import('../tinywebdb.mjs').catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return {};
  throw error;
});
const Core = await import('../core.mjs').catch(() => ({}));

test('cloud tags remain under the previously verified 100-character limit', () => {
  assert.equal(typeof Cloud.toCloudRecords, 'function', 'toCloudRecords is required');
  const state = Core.createState({ id: 'd2d38423-26a0-49e4-b1fc-5b67f61f5555', now: 1 });
  for (const record of Cloud.toCloudRecords(state, 'wxstat_demo_v1_')) {
    assert.ok(record.tag.length <= 100);
    assert.ok(record.tag.startsWith('wxstat_demo_v1_'));
  }
});

test('synchronization verifies writes, is repeatable, and restores undo from cloud events', async () => {
  assert.equal(typeof Cloud.synchronize, 'function', 'synchronize is required');
  const records = new Map();
  const server = http.createServer(async (request, response) => {
    let body = '';
    for await (const part of request) body += part;
    const form = new URLSearchParams(body);
    if (form.get('action') === 'update') {
      records.set(form.get('tag'), form.get('value'));
      response.end('');
      return;
    }
    const matched = [...records].filter(([tag]) => tag.includes(form.get('tag')));
    const start = Number(form.get('no')) - 1;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(Object.fromEntries(matched.slice(start, start + Number(form.get('count'))))));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const client = new Cloud.TinyWebDB({ endpoint: `http://127.0.0.1:${server.address().port}`, user: 'test', secret: 'test', prefix: 'test_stat_' });
    let state = Core.createState({ id: 'client-a', now: 1 });
    state = Core.appendEntry(state, '1(100)', { id: 'entry-a', now: 2 });
    state = Core.appendEntry(state, '1(88)', { id: 'entry-b', now: 3 });
    state = Core.undoLast(state, { id: 'undo-a', now: 4 });
    await Cloud.synchronize(client, state);
    const size = records.size;
    await Cloud.synchronize(client, state);
    assert.equal(records.size, size);
    const empty = Core.createState({ id: 'client-a', now: 1 });
    const restored = await Cloud.synchronize(client, empty);
    assert.equal(Core.summarize(Core.currentBatch(restored)).total, 100);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('a falsely acknowledged cloud write is detected instead of reported as saved', async () => {
  assert.equal(typeof Cloud.synchronize, 'function', 'synchronize is required');
  const client = {
    prefix: 'test_',
    all: async () => [],
    write: async () => {}
  };
  const state = Core.createState({ id: 'client-a', now: 1 });
  await assert.rejects(() => Cloud.synchronize(client, state), /保存|核对|写入/);
});

test('a refreshed browser still syncs: cloud batch metadata wins over the fresh empty batch', async () => {
  assert.equal(typeof Cloud.mergeCloudRecords, 'function', 'mergeCloudRecords is required');
  const records = new Map();
  const client = {
    prefix: 'test_stat_',
    all: async tag => [...records].filter(([key]) => key.includes(tag)).map(([key, value]) => ({ tag: key, value: JSON.parse(value) })),
    write: async (tag, value) => { records.set(tag, JSON.stringify(value)); }
  };
  // 第一次同步发生在 createdAt 为 1 的那个批次上。
  let state = Core.createState({ id: 'client-a', now: 1 });
  state = Core.appendEntry(state, '1(100) 2(50)', { id: 'entry-a', now: 2 });
  await Cloud.synchronize(client, state);
  const written = records.size;

  // 换浏览器或刷新后，本机会用 Date.now() 重新建一个空白批次，接着从云端恢复。
  const fresh = Core.createState({ id: 'client-a', now: 999999 });
  const restored = await Cloud.synchronize(client, fresh);
  assert.equal(Core.summarize(Core.currentBatch(restored)).total, 150, '刷新后没有从云端恢复');
  await assert.doesNotReject(() => Cloud.synchronize(client, restored), '刷新后的同步因为批次元数据不一致而失败');
  assert.equal(records.size, written, '刷新后的同步重复写入了记录');
  assert.ok([...records.keys()].every(tag => tag.startsWith('test_stat_client-a_')), '同步写到了别的命名空间：' + [...records.keys()].join(','));
});

test('a browser that was working in a later batch resumes that batch after sync', async () => {
  assert.equal(typeof Cloud.toCloudRecords, 'function', 'toCloudRecords is required');
  const records = new Map();
  const client = {
    prefix: 'test_stat_',
    all: async tag => [...records].filter(([key]) => key.includes(tag)).map(([key, value]) => ({ tag: key, value: JSON.parse(value) })),
    write: async (tag, value) => { records.set(tag, JSON.stringify(value)); }
  };
  // 第一批记一笔，然后新建第二批并在第二批里继续记。
  let state = Core.createState({ id: 'client-b', now: 1 });
  state = Core.appendEntry(state, '2(50)', { id: 'entry-a', now: 2 });
  state = Core.newBatch(state, '第二批', { id: 'batch-two', now: 3 });
  state = Core.appendEntry(state, '2(30)', { id: 'entry-b', now: 4 });
  assert.equal(Core.summarize(Core.currentBatch(state)).totals[1], 30);
  await Cloud.synchronize(client, state);

  // 换一个浏览器：第一批和第二批的数据都要在，而且当前批次应当回到第二批。
  const restored = await Cloud.synchronize(client, Core.createState({ id: 'client-b', now: 999999 }));
  assert.equal(Core.currentBatch(restored).name, '第二批', '换浏览器后没有回到之前正在记的那一批');
  assert.equal(Core.summarize(Core.currentBatch(restored)).totals[1], 30, '第二批的数据没有恢复');
  const first = restored.batches.find(batch => batch.id !== 'batch-two' && batch.mode === 'quantity');
  assert.equal(Core.summarize(first).totals[1], 50, '第一批的数据没有同步到云端');
  await assert.doesNotReject(() => Cloud.synchronize(client, restored), '恢复后的再次同步失败');
});
