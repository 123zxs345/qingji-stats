import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { createState, appendEntry, undoLast, setMode, newBatch, summarize, currentBatch, validateState } from '../core.mjs';
import { TinyWebDB, synchronize } from '../tinywebdb.mjs';

// 对真实 TinyWebDB 做一次完整验证：写入、换浏览器后从云端恢复、幂等、撤销、新建批次，最后清理干净。
// 用一次性的独立前缀，绝不写进别的项目（hajimi_…）的命名空间。
const user = process.env.TINYWEBDB_USER;
const secret = process.env.TINYWEBDB_KEY;
if (!user || !secret) {
  console.log('跳过真实数据库验证：没有提供 TINYWEBDB_USER / TINYWEBDB_KEY');
  process.exit(0);
}
const prefix = process.env.TINYWEBDB_PREFIX || `wxstat_probe_${randomUUID().slice(0, 8)}_`;
const client = new TinyWebDB({ user, secret, prefix });
const report = { prefix, steps: [], tags: 0 };
const step = (name, detail = {}) => { report.steps.push({ name, ...detail }); console.log(`✔ ${name}`, JSON.stringify(detail)); };

// 这台机器直连这个域名偶尔会被重置 TLS，真实数据库验证按网络抖动重试，避免误报成功能故障。
const attempts = Number(process.env.LIVE_ATTEMPTS || 6);
async function withRetry(label, run) {
  let last;
  for (let i = 1; i <= attempts; i++) {
    try { return await run(); }
    catch (error) {
      last = error;
      if (i < attempts) await new Promise(resolve => setTimeout(resolve, 600 * i));
    }
  }
  throw new Error(`${label} 连续 ${attempts} 次失败：${last?.message}`);
}
const allTags = () => withRetry('读取云端记录', async () => (await client.all(prefix)).map(record => record.tag));
const sync = state => withRetry('同步到云端', () => synchronize(client, state));

try {
  // 0. 命名空间必须是空的，保证只动自己的记录。
  assert.deepEqual(await allTags(), [], '临时命名空间不是空的，先不要写入');
  step('临时命名空间为空', { prefix });

  // 1. 写入需求里的两笔数据并同步。
  // 同步会上传全部批次的记录：2 条批次 + 2 条次数事件 + 1 条数量事件 + 1 条当前批次指针 = 6 条。
  let state = createState({ id: randomUUID(), now: Date.now() });
  state = setMode(state, 'frequency');
  state = appendEntry(state, '1 2 1 50', { now: Date.now() });
  state = setMode(state, 'quantity');
  state = appendEntry(state, '1(100) 2(50)', { now: Date.now() });
  state = appendEntry(state, '1(88) 2(896)', { now: Date.now() });
  const synced = await sync(state);
  const tags = await allTags();
  report.tags = tags.length;
  assert.equal(tags.length, 6, `云端记录数应为 6，实际 ${tags.length}`);
  assert.deepEqual(tags.filter(tag => !tag.startsWith(prefix)), [], '写到了别的命名空间');
  assert.equal(summarize(currentBatch(synced)).totals[0], 188);
  assert.equal(summarize(currentBatch(synced)).totals[1], 946);
  step('写入并回读一致', { tags: tags.length, total: summarize(currentBatch(synced)).total });

  // 2. 同一状态再同步一次：必须幂等，不新增记录。
  await sync(state);
  assert.equal((await allTags()).length, tags.length, '重复同步新增了记录');
  step('重复同步幂等', { tags: tags.length });

  // 3. 模拟换浏览器（本机什么都没了），只靠云端记录恢复。
  const recovered = await sync(createState({ id: state.clientId, now: Date.now() }));
  const recoveredQuantity = summarize(currentBatch(recovered));
  assert.equal(recoveredQuantity.totals[0], 188, '恢复后 1 号数量不对');
  assert.equal(recoveredQuantity.totals[1], 946, '恢复后 2 号数量不对');
  const frequencyBatch = recovered.batches.find(batch => batch.mode === 'frequency');
  assert.equal(summarize(frequencyBatch).total, 4, '恢复后次数统计不对');
  step('空浏览器从云端完整恢复', { quantity: recoveredQuantity.total, frequency: summarize(frequencyBatch).total });

  // 4. 撤销：追加一条撤销事件，而不是删除云端记录。
  // 云端回读后事件顺序可能与本地不同，所以不假设撤销的是哪一笔，只核对结果与云端记录一致。
  const withUndo = undoLast(recovered, { now: Date.now() });
  const undone = withUndo.batches.flatMap(batch => batch.events).find(event => event.kind === 'undo');
  assert.ok(undone, '本机没有产生撤销事件');
  const expectedAfterUndo = summarize(currentBatch(withUndo));
  const before = (await allTags()).length;
  await sync(withUndo);
  const after = (await allTags()).length;
  assert.equal(after, before + 1, '撤销应当只新增一条事件记录');
  const all = await client.all(prefix);
  const undoRecords = all.filter(record => record.value.kind === 'undo');
  assert.equal(undoRecords.length, 1, '云端没有撤销事件');
  assert.equal(undoRecords[0].value.targetId, undone.targetId, '云端撤销事件指向的录入与本机不一致');
  assert.ok(all.some(record => record.value.id === undone.targetId), '云端找不到被撤销的那笔录入');

  const restored = await sync(createState({ id: state.clientId, now: Date.now() }));
  const restoredBatch = currentBatch(restored);
  const restoredSummary = summarize(restoredBatch);
  assert.equal(restoredBatch.events.filter(event => event.kind === 'undo').length, 1, '恢复后的状态里没有撤销事件');
  assert.deepEqual(restoredSummary.totals, expectedAfterUndo.totals, '恢复后撤销没有生效：汇总与本机撤销后不一致');
  assert.equal(restoredSummary.total, expectedAfterUndo.total, `恢复后合计应为 ${expectedAfterUndo.total}，实际 ${restoredSummary.total}`);
  step('撤销以新事件写入并在恢复后生效', { before, after, targetId: undone.targetId, total: restoredSummary.total });

  // 4b. 撤销后的状态再同步一次，必须幂等。
  try {
    await sync(restored);
    const idempotentTags = (await allTags()).length;
    assert.equal(idempotentTags, after, `撤销后重复同步新增了 ${idempotentTags - after} 条记录`);
    step('撤销后的状态再同步仍然幂等', { tags: idempotentTags });
  } catch (error) {
    const cloud = await client.all(prefix);
    const known = new Map(cloud.map(record => [record.tag, record.value]));
    const diffs = [];
    for (const record of toCloudRecords(restored, prefix)) {
      const remote = known.get(record.tag);
      if (!remote) diffs.push({ tag: record.tag.slice(prefix.length), issue: '云端缺少' });
      else if (JSON.stringify(remote) !== JSON.stringify(record.value)) diffs.push({ tag: record.tag.slice(prefix.length), cloud: JSON.stringify(remote), local: JSON.stringify(record.value) });
    }
    report.idempotenceDiagnostics = { error: error.message, active: restored.active, diffs: diffs.slice(0, 6) };
    throw error;
  }

  // 5. 新建第二批：它成为当前批次后，事件同样要能同步并被恢复。
  const second = newBatch(restored, '第二批', { now: Date.now() });
  const withSecond = appendEntry(second, '2(30)', { now: Date.now() });
  await sync(withSecond);
  const afterSecond = await allTags();
  assert.equal(afterSecond.length, after + 2, `新建批次后云端记录数应为 ${after + 2}，实际 ${afterSecond.length}`);
  const restoredSecond = await sync(createState({ id: state.clientId, now: Date.now() }));
  const restoredSecondSummary = summarize(currentBatch(restoredSecond));
  if (restoredSecondSummary.totals[1] !== 30) {
    const cloud = await client.all(prefix);
    const stateRecords = cloud.filter(record => record.value.kind === 'state');
    report.secondBatchDiagnostics = {
      localSecondBatch: { id: currentBatch(withSecond).id, active: withSecond.active, events: currentBatch(withSecond).events.map(event => ({ id: event.id, kind: event.kind, entries: event.entries })) },
      cloudStateRecords: stateRecords.map(record => ({ tag: record.tag.slice(prefix.length), active: record.value.active })),
      cloudAllKinds: cloud.map(record => `${record.tag.slice(prefix.length + 37)}:${record.value.kind}`),
      recoveredBatches: restoredSecond.batches.map(batch => ({ id: batch.id, mode: batch.mode, events: batch.events.length })),
      recoveredActive: restoredSecond.active,
      recoveredCurrent: { id: currentBatch(restoredSecond).id, totals: restoredSecondSummary.totals.filter(Boolean) }
    };
  }
  assert.equal(restoredSecondSummary.totals[1], 30, '第二批的数据没有恢复');
  step('第二批的事件同样能写入并恢复', { tags: afterSecond.length, secondBatchTotal: restoredSecondSummary.total });

  // 6. 备份校验：从云端记录重建的状态必须能通过 validateState。
  assert.doesNotThrow(() => validateState(restoredSecond));
  step('云端重建的状态通过备份校验', { batches: restoredSecond.batches.length });

  report.ok = true;
} catch (error) {
  report.ok = false;
  report.error = error.message;
  console.error('✖ 真实数据库验证失败：', error.message);
} finally {
  // 7. 清理：删掉本次写入的每一条记录，并确认命名空间已清空。
  let removed = 0;
  let remaining = [];
  try {
    for (const record of await client.all(prefix)) {
      await client.call({ action: 'delete', tag: record.tag });
      removed++;
    }
    remaining = await allTags();
  } catch (error) {
    report.cleanupError = error.message;
  }
  report.removed = removed;
  report.remaining = remaining.length;
  console.log(`清理：删除 ${removed} 条，剩余 ${remaining.length} 条`);
  console.log('RESULT ' + JSON.stringify(report));
  process.exit(report.ok && remaining.length === 0 ? 0 : 1);
}
