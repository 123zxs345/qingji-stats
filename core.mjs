export const MODES = ['quantity', 'frequency'];
export const MODE_NAMES = { quantity: '数量累加', frequency: '次数统计' };
const freshId = () => globalThis.crypto.randomUUID();
const isId = value => typeof value === 'string' && /^[\w-]{1,64}$/.test(value);

export function parseInput(text, mode) {
  if (!MODES.includes(mode)) throw new Error('请选择统计方式');
  const input = String(text).normalize('NFKC').replace(/[，、；;]/g, ',').trim();
  if (!input) throw new Error('先输入一些数据吧');
  if (input.length > 5000) throw new Error('这条数据太长了，请分几次录入');
  const entries = [];
  if (mode === 'frequency') {
    const parts = input.split(/[\s,]+/).filter(Boolean);
    for (const part of parts) {
      if (!/^\d{1,2}$/.test(part)) throw new Error('次数统计只需输入编号，例如 1 2 1 50');
      entries.push({ number: Number(part), amount: 1 });
    }
  } else {
    let offset = 0;
    const pattern = /(\d{1,2})\s*(?:\(\s*(\d{1,9})\s*\)|:\s*(\d{1,9}))/y;
    while (offset < input.length) {
      const separator = input.slice(offset).match(/^[\s,]+/);
      if (separator) offset += separator[0].length;
      if (offset === input.length) break;
      pattern.lastIndex = offset;
      const match = pattern.exec(input);
      if (!match) throw new Error('请用 编号(数量) 的格式，例如 1(100) 2(50)');
      entries.push({ number: Number(match[1]), amount: Number(match[2] ?? match[3]) });
      offset = pattern.lastIndex;
      if (offset < input.length && !/[\s,]/.test(input[offset])) {
        throw new Error('每组数据之间请用空格、逗号或换行分隔');
      }
    }
  }
  if (!entries.length || entries.length > 200) throw new Error('每次请输入 1 到 200 组数据');
  for (const entry of entries) {
    if (entry.number < 1 || entry.number > 50) throw new Error('编号只能是 1 到 50，本次还没有保存');
    if (!Number.isSafeInteger(entry.amount) || entry.amount < 1) throw new Error('数量需要是大于 0 的整数');
  }
  return entries;
}

export function createState({ id = freshId(), now = Date.now() } = {}) {
  const batches = MODES.map(mode => ({ id: `${mode[0]}_${id}`, mode, name: '我的第一批', createdAt: now, events: [] }));
  return { version: 1, clientId: id, mode: 'quantity', active: Object.fromEntries(batches.map(batch => [batch.mode, batch.id])), batches };
}

export function currentBatch(state) {
  return state.batches.find(batch => batch.id === state.active[state.mode]);
}

export function activeEntries(batch) {
  const undone = new Set(batch.events.filter(event => event.kind === 'undo').map(event => event.targetId));
  return batch.events.filter(event => event.kind === 'entry' && !undone.has(event.id));
}

export function summarize(batch) {
  const totals = Array(50).fill(0);
  const records = activeEntries(batch);
  let itemCount = 0;
  for (const record of records) {
    for (const { number, amount } of record.entries) {
      totals[number - 1] += amount;
      itemCount++;
      if (!Number.isSafeInteger(totals[number - 1])) throw new Error('累计数量太大，请新建一批继续统计');
    }
  }
  const total = totals.reduce((sum, value) => sum + value, 0);
  if (!Number.isSafeInteger(total)) throw new Error('累计数量太大，请新建一批继续统计');
  return { totals, total, covered: totals.filter(value => value > 0).length, recordCount: records.length, itemCount };
}

function appendEvent(state, event) {
  const batch = currentBatch(state);
  const latest = batch.events.reduce((value, item) => Math.max(value, item.createdAt), batch.createdAt);
  const next = { ...event, createdAt: Math.max(event.createdAt, latest + 1) };
  const updated = { ...batch, events: [...batch.events, next] };
  summarize(updated);
  return { ...state, batches: state.batches.map(item => item.id === batch.id ? updated : item) };
}

export function appendEntry(state, text, { id = freshId(), now = Date.now() } = {}) {
  return appendEvent(state, { id, kind: 'entry', createdAt: now, text: String(text).trim(), entries: parseInput(text, state.mode) });
}

export function undoLast(state, { id = freshId(), now = Date.now() } = {}) {
  const last = activeEntries(currentBatch(state)).at(-1);
  if (!last) throw new Error('没有可撤销的记录');
  return appendEvent(state, { id, kind: 'undo', targetId: last.id, createdAt: now });
}

export function setMode(state, mode) {
  if (!MODES.includes(mode)) throw new Error('统计方式不正确');
  return { ...state, mode };
}

export function newBatch(state, name, { id = freshId(), now = Date.now() } = {}) {
  const batch = { id, mode: state.mode, name: String(name).trim().slice(0, 30) || '新的一批', createdAt: now, events: [] };
  return { ...state, batches: [...state.batches, batch], active: { ...state.active, [state.mode]: id } };
}

export function selectBatch(state, id) {
  const batch = state.batches.find(item => item.id === id && item.mode === state.mode);
  if (!batch) throw new Error('这批记录不存在');
  return { ...state, active: { ...state.active, [state.mode]: id } };
}

export function formatSummary(batch, showAll = false) {
  const summary = summarize(batch);
  const lines = [`${batch.name} · ${MODE_NAMES[batch.mode]}`];
  summary.totals.forEach((value, index) => { if (showAll || value) lines.push(`${index + 1}（${value}）`); });
  if (!summary.covered) lines.push('暂无录入数据');
  lines.push(`合计：${summary.total}${batch.mode === 'frequency' ? '次' : ''}`, `有效录入：${summary.recordCount}笔`);
  return lines.join('\n');
}

export function validateState(value) {
  const fail = () => { throw new Error('备份格式不正确，当前数据没有改动'); };
  if (!value || value.version !== 1 || !isId(value.clientId) || !MODES.includes(value.mode) || !Array.isArray(value.batches) || value.batches.length > 1000) fail();
  const seen = new Set();
  const batches = value.batches.map(batch => {
    if (!batch || !isId(batch.id) || seen.has(batch.id) || !MODES.includes(batch.mode) || typeof batch.name !== 'string' || batch.name.length > 30 || !Number.isFinite(batch.createdAt) || !Array.isArray(batch.events) || batch.events.length > 20000) fail();
    seen.add(batch.id);
    const entries = new Set();
    const events = batch.events.map(event => {
      if (!event || !isId(event.id) || seen.has(event.id) || !Number.isFinite(event.createdAt)) fail();
      seen.add(event.id);
      if (event.kind === 'entry') {
        if (typeof event.text !== 'string' || event.text.length > 5000 || !Array.isArray(event.entries) || !event.entries.length || event.entries.length > 200) fail();
        const parsed = parseInput(event.text, batch.mode);
        if (JSON.stringify(parsed) !== JSON.stringify(event.entries)) fail();
        entries.add(event.id);
        return { id: event.id, kind: 'entry', createdAt: event.createdAt, text: event.text, entries: parsed };
      }
      if (event.kind !== 'undo' || !isId(event.targetId)) fail();
      return { id: event.id, kind: 'undo', targetId: event.targetId, createdAt: event.createdAt };
    });
    if (events.some(event => event.kind === 'undo' && !entries.has(event.targetId))) fail();
    const result = { id: batch.id, mode: batch.mode, name: batch.name, createdAt: batch.createdAt, events };
    summarize(result);
    return result;
  });
  for (const mode of MODES) if (!batches.some(batch => batch.mode === mode && batch.id === value.active?.[mode])) fail();
  return { version: 1, clientId: value.clientId, mode: value.mode, active: { quantity: value.active.quantity, frequency: value.active.frequency }, batches };
}
