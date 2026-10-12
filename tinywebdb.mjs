import { validateState, MODES } from './core.mjs';

export class TinyWebDB {
  constructor({ endpoint = 'https://tinywebdb.appinventor.space/api', user = '', secret = '', prefix = 'wxstat_demo_v1_' } = {}) {
    this.endpoint = endpoint;
    this.user = user;
    this.secret = secret;
    this.prefix = prefix;
    this.configured = Boolean(user && secret);
  }

  async call(fields) {
    if (!this.configured) throw new Error('暂未连接云端，数据已保存在本机');
    const response = await fetch(this.endpoint, { method: 'POST', body: new URLSearchParams({ user: this.user, secret: this.secret, ...fields }), signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error('云端暂时连不上，数据已保存在本机');
    const text = await response.text();
    if (!text.trim() && fields.action === 'update') return null;
    let result;
    try { result = JSON.parse(text); } catch { throw new Error('云端返回格式不正确'); }
    if (result?.error || result?.status === 'error') throw new Error('云端暂时无法保存，数据已保存在本机');
    return result;
  }

  async write(tag, value) {
    if (!tag.startsWith(this.prefix) || tag.length > 100) throw new Error('云端记录名超出范围');
    await this.call({ action: 'update', tag, value: JSON.stringify(value) });
  }

  async all(tag) {
    if (!tag.startsWith(this.prefix)) throw new Error('云端记录范围不正确');
    const records = new Map();
    for (let offset = 1; offset <= 20001; offset += 100) {
      const result = await this.call({ action: 'search', no: String(offset), count: '100', tag, type: 'both' });
      if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('云端记录格式不正确');
      const page = Object.entries(result);
      for (const [key, raw] of page) {
        if (!key.startsWith(tag)) continue;
        let value;
        try { value = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { continue; }
        if (value && typeof value === 'object') records.set(key, { tag: key, value });
      }
      if (page.length < 100) return [...records.values()];
    }
    throw new Error('记录太多，请先导出备份');
  }
}

const STATE_TAG = 'state';

export function toCloudRecords(state, prefix) {
  const records = [];
  const add = (id, value) => {
    const tag = `${prefix}${state.clientId}_${id}`;
    if (tag.length > 100) throw new Error('云端记录名超出范围');
    records.push({ tag, value: { schema: 1, clientId: state.clientId, ...value } });
  };
  for (const batch of state.batches) {
    add(batch.id, { kind: 'batch', batchId: batch.id, mode: batch.mode, name: batch.name, createdAt: batch.createdAt });
    for (const event of batch.events) add(event.id, { ...event, batchId: batch.id, mode: batch.mode });
  }
  // 记住当前正在用哪一批：只上传事件的话，换浏览器后只能回到第一批，
  // 之前正在记的那些数据虽然同步到了云端，却不显示出来，看起来就像丢了。
  const active = {};
  for (const mode of MODES) {
    const used = state.batches.filter(batch => batch.mode === mode);
    const latest = used.reduce((newest, batch) => !newest || latestEventTime(batch) > latestEventTime(newest) ? batch : newest, null);
    const current = state.active[mode];
    // 还没有录入过任何数据、也没新建过批次时，不必占用一条云端记录。
    if (!latest || (!latest.events.length && latest.id === current && used.length === 1)) continue;
    active[mode] = latest.id;
  }
  if (Object.keys(active).length) add(STATE_TAG, { kind: 'state', active });
  return records;
}

const latestEventTime = batch => batch.events.reduce((newest, event) => Math.max(newest, event.createdAt), batch.createdAt);

export function mergeCloudRecords(state, remote) {
  const batches = new Map(state.batches.map(batch => [batch.id, { ...batch, events: [...batch.events] }]));
  const values = remote.map(record => record.value).filter(value => value?.schema === 1 && value.clientId === state.clientId);
  for (const value of values.filter(item => item.kind === 'batch')) {
    const known = batches.get(value.batchId);
    // 批次元数据以云端已存的那份为准：本机新建的空白批次用 Date.now() 当 createdAt，
    // 如果留着它，同一个标签就会在云端和本机得到不同的值，之后的每一次同步都会核对失败。
    if (known) known.createdAt = value.createdAt;
    else batches.set(value.batchId, { id: value.batchId, mode: value.mode, name: value.name, createdAt: value.createdAt, events: [] });
  }
  for (const value of values.filter(item => item.kind === 'entry' || item.kind === 'undo')) {
    const batch = batches.get(value.batchId);
    if (!batch || batch.mode !== value.mode || batch.events.some(event => event.id === value.id)) continue;
    const { schema, clientId, batchId, mode, ...event } = value;
    batch.events.push(event);
  }
  for (const batch of batches.values()) batch.events.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  const saved = values.find(value => value.kind === 'state');
  const active = { ...state.active };
  for (const mode of MODES) {
    const wanted = saved?.active?.[mode];
    if (batches.get(wanted)?.mode === mode) active[mode] = wanted;
  }
  return validateState({ ...state, active, batches: [...batches.values()] });
}

export async function synchronize(client, state) {
  const remote = await client.all(`${client.prefix}${state.clientId}_`);
  const merged = mergeCloudRecords(state, remote);
  const known = new Map(remote.map(record => [record.tag, record.value]));
  for (const record of toCloudRecords(merged, client.prefix)) {
    if (known.has(record.tag)) {
      if (JSON.stringify(known.get(record.tag)) !== JSON.stringify(record.value)) throw new Error('云端记录核对失败，本机数据已保留');
      continue;
    }
    await client.write(record.tag, record.value);
    const saved = (await client.all(record.tag)).find(item => item.tag === record.tag);
    if (!saved || JSON.stringify(saved.value) !== JSON.stringify(record.value)) throw new Error('云端写入后核对失败，本机数据已保留');
  }
  return merged;
}
