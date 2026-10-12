import { createState, parseInput, currentBatch, summarize, appendEntry, undoLast, setMode, newBatch, selectBatch, validateState, formatSummary, activeEntries, MODE_NAMES } from './core.mjs';
import { TinyWebDB, synchronize, mergeCloudRecords, toCloudRecords } from './tinywebdb.mjs';

const KEY = 'qingji-statistics-demo-v1';
const $ = id => document.getElementById(id);
const formatter = new Intl.NumberFormat('zh-CN');
const number = value => formatter.format(value);
const clock = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
const client = new TinyWebDB(window.StatsHosting?.tinywebdb);
let state;
try { const saved = localStorage.getItem(KEY); state = saved ? validateState(JSON.parse(saved)) : createState(); }
catch { state = createState(); }
let showAll = false;
let rankOrder = false;
let currentTab = 'summary';
let syncBusy = false;
let needsSync = false;
let toastTimer;
const drafts = { quantity: '', frequency: '' };

function toast(message) {
  $('toast').textContent = message;
  $('toast').classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('toast').classList.remove('visible'), 2800);
}

function saveLocal() {
  try { localStorage.setItem(KEY, JSON.stringify(state)); return true; }
  catch { toast('本机空间不足，请先导出备份'); return false; }
}

function commit(next, message) {
  const previous = state;
  state = next;
  if (!saveLocal()) { state = previous; return false; }
  render();
  if (message) toast(message);
  scheduleSync();
  return true;
}

function syncStatus(label, status = '') {
  $('sync-text').textContent = label;
  $('sync-button').dataset.state = status;
}

async function scheduleSync() {
  if (!client.configured) { syncStatus('已保存到本机'); return; }
  needsSync = true;
  if (syncBusy) return;
  syncBusy = true;
  while (needsSync) {
    needsSync = false;
    const snapshot = structuredClone(state);
    syncStatus('正在同步', 'syncing');
    try {
      const merged = await synchronize(client, snapshot);
      if (state.clientId === snapshot.clientId) {
        state = mergeCloudRecords(state, toCloudRecords(merged, client.prefix));
        saveLocal();
        render();
        syncStatus('云端已同步', 'online');
      }
    } catch {
      syncStatus('本机已保存 · 点此重试', 'offline');
    }
  }
  syncBusy = false;
}

function updatePreview() {
  const text = $('data-input').value;
  drafts[state.mode] = text;
  const preview = $('input-preview');
  preview.classList.remove('error');
  $('data-input').removeAttribute('aria-invalid');
  if (!text.trim()) {
    preview.textContent = '';
    $('save-button').disabled = true;
    return;
  }
  try {
    const entries = parseInput(text, state.mode);
    const total = entries.reduce((sum, entry) => sum + entry.amount, 0);
    const covered = new Set(entries.map(entry => entry.number)).size;
    preview.textContent = `已识别 ${covered} 个编号 · 本次${state.mode === 'frequency' ? '出现' : '合计'} ${number(total)}${state.mode === 'frequency' ? ' 次' : ''}`;
    $('save-button').disabled = false;
  } catch (error) {
    preview.textContent = error.message;
    preview.classList.add('error');
    $('data-input').setAttribute('aria-invalid', 'true');
    $('save-button').disabled = true;
  }
}

function renderSummary(batch, summary) {
  const list = $('summary-list');
  list.replaceChildren();
  let rows = summary.totals.map((amount, index) => ({ number: index + 1, amount })).filter(row => showAll || row.amount);
  if (rankOrder) rows.sort((a, b) => b.amount - a.amount || a.number - b.number);
  const maximum = Math.max(...summary.totals, 1);
  for (const item of rows) {
    const row = document.createElement('div');
    row.className = 'summary-row';
    const badge = document.createElement('span');
    badge.className = 'number-tag';
    badge.textContent = String(item.number).padStart(2, '0');
    const track = document.createElement('div');
    track.className = 'bar-track';
    track.setAttribute('aria-hidden', 'true');
    const fill = document.createElement('div');
    fill.className = 'bar-fill';
    fill.style.width = `${item.amount / maximum * 100}%`;
    track.append(fill);
    const value = document.createElement('span');
    value.className = 'summary-value';
    value.textContent = number(item.amount);
    row.setAttribute('aria-label', `${item.number}号，${item.amount}${state.mode === 'frequency' ? '次' : ''}`);
    row.append(badge, track, value);
    list.append(row);
  }
  $('summary-empty').hidden = Boolean(rows.length);
  $('show-all-button').textContent = showAll ? '只看有数据的编号 ⌃' : '查看全部 50 个编号 ⌄';
  $('sort-button').textContent = `${state.mode === 'frequency' ? '出现次数' : '累计数量'} ${rankOrder ? '↓' : '↕'}`;
  const ranked = summary.totals.map((amount, index) => ({ number: index + 1, amount })).sort((a, b) => b.amount - a.amount || a.number - b.number);
  $('insight').hidden = !summary.total;
  $('insight').textContent = `当前最多：${ranked[0].number} 号 · ${number(ranked[0].amount)}${state.mode === 'frequency' ? ' 次' : ''}，占总量 ${Math.round(ranked[0].amount / summary.total * 100)}%`;
}

function renderHistory(batch) {
  const list = $('history-list');
  list.replaceChildren();
  const active = new Set(activeEntries(batch).map(event => event.id));
  const events = [...batch.events].reverse();
  for (const event of events) {
    const row = document.createElement('div');
    row.className = `history-row${event.kind === 'entry' && !active.has(event.id) ? ' is-undone' : ''}`;
    const top = document.createElement('div');
    top.className = 'history-top';
    const title = document.createElement('strong');
    title.textContent = event.kind === 'undo' ? '撤销了一笔' : `录入 ${event.entries.length} 组数据`;
    const time = document.createElement('span');
    time.textContent = clock.format(new Date(event.createdAt));
    top.append(title, time);
    const text = document.createElement('p');
    text.textContent = event.kind === 'undo' ? '这笔数据已从汇总中扣除。' : event.text;
    row.append(top, text);
    list.append(row);
  }
  $('history-empty').hidden = Boolean(events.length);
}

function render() {
  const batch = currentBatch(state);
  const summary = summarize(batch);
  document.querySelectorAll('[data-mode]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.mode === state.mode)));
  $('total-label').textContent = state.mode === 'frequency' ? '累计出现次数' : '累计数量';
  $('total-unit').textContent = state.mode === 'frequency' ? '次' : '个';
  $('grand-total').textContent = number(summary.total);
  $('record-count').textContent = number(summary.recordCount);
  $('covered-count').textContent = summary.covered;
  $('result-count').textContent = summary.covered;
  $('undo-button').disabled = !summary.recordCount;
  $('copy-button').disabled = !summary.recordCount;
  $('input-hint').textContent = state.mode === 'frequency' ? '直接输入编号，每出现一次就记一次。' : '输入编号和数量，支持空格、逗号或换行。';
  $('format-hint').textContent = state.mode === 'frequency' ? '格式：1 2 1 50' : '格式：编号(数量)';
  $('data-input').placeholder = state.mode === 'frequency' ? '1 2 1 3 50\n2 3 3' : '1(100) 2(50)\n1(88) 2(896)';
  const select = $('batch-select');
  select.replaceChildren();
  for (const item of [...state.batches].filter(item => item.mode === state.mode).reverse()) {
    const option = document.createElement('option');
    option.value = item.id;
    option.textContent = item.name;
    option.selected = item.id === batch.id;
    select.append(option);
  }
  renderSummary(batch, summary);
  renderHistory(batch);
  $('summary-panel').hidden = currentTab !== 'summary';
  $('history-panel').hidden = currentTab !== 'history';
  $('summary-tab').setAttribute('aria-selected', String(currentTab === 'summary'));
  $('history-tab').setAttribute('aria-selected', String(currentTab === 'history'));
  updatePreview();
}

function useExample() {
  $('data-input').value = state.mode === 'frequency' ? '1 2 1 3 50\n2 3 3' : '1(100) 2(50)\n1(88) 2(896)';
  updatePreview();
  $('data-input').focus({ preventScroll: true });
}

document.querySelectorAll('[data-mode]').forEach(button => button.addEventListener('click', () => {
  if (state.mode === button.dataset.mode) return;
  drafts[state.mode] = $('data-input').value;
  state = setMode(state, button.dataset.mode);
  $('data-input').value = drafts[state.mode];
  showAll = false;
  saveLocal();
  render();
}));
$('data-input').addEventListener('input', updatePreview);
$('data-input').addEventListener('keydown', event => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); if (!$('save-button').disabled) $('save-button').click(); } });
$('example-button').addEventListener('click', useExample);
$('empty-example').addEventListener('click', useExample);
$('save-button').addEventListener('click', () => {
  try {
    const next = appendEntry(state, $('data-input').value);
    if (commit(next, '记好了，汇总已更新')) { $('data-input').value = ''; drafts[state.mode] = ''; currentTab = 'summary'; render(); }
  } catch (error) { toast(error.message); }
});
$('undo-button').addEventListener('click', () => { try { commit(undoLast(state), '已撤销上一笔'); } catch (error) { toast(error.message); } });
$('batch-select').addEventListener('change', event => { commit(selectBatch(state, event.target.value)); showAll = false; render(); });
$('summary-tab').addEventListener('click', () => { currentTab = 'summary'; render(); });
$('history-tab').addEventListener('click', () => { currentTab = 'history'; render(); });
$('show-all-button').addEventListener('click', () => { showAll = !showAll; render(); });
$('sort-button').addEventListener('click', () => { rankOrder = !rankOrder; render(); });
$('new-batch').addEventListener('click', () => { $('batch-name').value = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: 'long', day: 'numeric' }).format(new Date()) + '的记录'; $('batch-dialog').showModal(); });
$('cancel-batch').addEventListener('click', () => $('batch-dialog').close());
$('batch-form').addEventListener('submit', event => { event.preventDefault(); if (commit(newBatch(state, $('batch-name').value), '新的一批，开始记吧')) { $('batch-dialog').close(); $('data-input').value = ''; drafts[state.mode] = ''; showAll = false; render(); } });
$('copy-button').addEventListener('click', async () => {
  const text = formatSummary(currentBatch(state), showAll);
  try { await navigator.clipboard.writeText(text); toast('汇总已复制，可以粘贴到微信'); }
  catch {
    const field = document.createElement('textarea');
    field.value = text;
    field.style.cssText = 'position:fixed;left:-9999px;top:0';
    document.body.append(field);
    field.select();
    const copied = document.execCommand('copy');
    field.remove();
    toast(copied ? '汇总已复制，可以粘贴到微信' : '当前浏览器无法自动复制，请换浏览器再试');
  }
});
$('export-button').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `轻记-备份-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  toast('备份已导出');
});
$('import-button').addEventListener('click', () => $('import-file').click());
$('import-file').addEventListener('change', async event => {
  const file = event.target.files[0];
  if (!file) return;
  try {
    if (file.size > 5 * 1024 * 1024) throw new Error('备份文件太大了');
    const imported = validateState(JSON.parse(await file.text()));
    if (state.batches.some(batch => batch.events.length) && !window.confirm('导入会切换到备份里的记录。建议先导出当前备份，确定继续吗？')) return;
    if (commit(imported, '备份已恢复')) { $('data-input').value = ''; drafts.quantity = ''; drafts.frequency = ''; render(); }
  } catch (error) { toast(error.message || '这份备份无法读取'); }
  finally { event.target.value = ''; }
});
$('sync-button').addEventListener('click', () => { if (client.configured) scheduleSync(); else toast('数据已保存在当前浏览器，可导出备份'); });
window.addEventListener('online', scheduleSync);
window.addEventListener('storage', event => {
  if (event.key !== KEY || !event.newValue) return;
  try {
    const incoming = validateState(JSON.parse(event.newValue));
    if (incoming.clientId !== state.clientId) return;
    state = mergeCloudRecords(state, toCloudRecords(incoming, 'local_'));
    render();
  } catch {}
});
saveLocal();
render();
scheduleSync();
