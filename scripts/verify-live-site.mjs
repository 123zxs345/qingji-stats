import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';

// 对已发布的公开地址做端到端验证：真实浏览器 + 真实 TinyWebDB。
// 用一次性前缀 qingji_e2e_<随机>_，验证完逐条删除直到命名空间确认清空。
const site = process.env.LIVE_SITE || 'https://123zxs345.github.io/qingji-stats/';
const user = process.env.TINYWEBDB_USER;
const secret = process.env.TINYWEBDB_KEY;
const api = 'https://tinywebdb.appinventor.space/api';
const prefix = process.env.E2E_PREFIX || `qingji_e2e_${randomUUID().slice(0, 8)}_`;
const report = { site, prefix, steps: [] };
const step = (name, detail = {}) => { report.steps.push({ name, ...detail }); console.log(`✔ ${name}`, JSON.stringify(detail)); };

async function apiCall(fields, tries = 8) {
  let last;
  for (let i = 1; i <= tries; i++) {
    try {
      const r = await fetch(api, { method: 'POST', body: new URLSearchParams({ user, secret, ...fields }), signal: AbortSignal.timeout(20000) });
      return await r.text();
    } catch (e) { last = e; await new Promise(r => setTimeout(r, 700 * i)); }
  }
  throw new Error(`云端请求失败：${last?.message}`);
}
async function records(tag) {
  const text = await apiCall({ action: 'search', no: '1', count: '100', tag, type: 'both' });
  if (!text.trim()) return [];
  let parsed; try { parsed = JSON.parse(text); } catch { return []; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
  return Object.entries(parsed)
    .filter(([key]) => key.startsWith(tag))
    .map(([key, raw]) => {
      // search 返回的 value 是当初写入的 JSON 字符串，必须解析后才能看 kind。
      let value = raw;
      if (typeof raw === 'string') { try { value = JSON.parse(raw); } catch { value = null; } }
      return { tag: key, value };
    })
    .filter(record => record.value && typeof record.value === 'object');
}
async function wipe(tag) {
  for (let round = 1; round <= 6; round++) {
    const found = await records(tag);
    if (!found.length) return round - 1 === 0 ? 0 : found.length;
    for (const record of found) await apiCall({ action: 'delete', tag: record.tag });
    await new Promise(r => setTimeout(r, 1200));
    if (!(await records(tag)).length) return found.length;
  }
  return -1;
}

let browser;
const problems = [];
try {
  if (!user || !secret) throw new Error('缺少 TINYWEBDB_USER / TINYWEBDB_KEY');
  if (!(await records(prefix)).length) step('线上验证命名空间为空', { prefix });
  else throw new Error('临时命名空间不是空的');

  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'zh-CN' });
  // 必须在页面脚本执行前换掉前缀，否则页面开屏的自动同步会先往正式命名空间写一条。
  await context.addInitScript(p => {
    Object.defineProperty(window, 'StatsHosting', {
      configurable: true,
      set(value) { window.__hosting = { ...value, tinywebdb: { ...value.tinywebdb, prefix: p } }; },
      get() { return window.__hosting; }
    });
  }, prefix);
  const page = await context.newPage();
  page.on('pageerror', e => problems.push(`pageerror: ${e.message}`));
  page.on('console', m => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });
  page.on('requestfailed', r => problems.push(`requestfailed: ${r.url()} ${r.failure()?.errorText}`));

  const response = await (async () => {
    let last;
    for (let i = 1; i <= 4; i++) {
      try { return await page.goto(site, { waitUntil: 'load', timeout: 60000 }); }
      catch (e) { last = e; console.log(`  打开公开地址第 ${i} 次失败：${e.message.split('\n')[0]}`); await new Promise(r => setTimeout(r, 5000)); }
    }
    throw last;
  })();
  step('公开地址可访问', { status: response?.status(), title: await page.title() });
  if (response?.status() !== 200) throw new Error(`公开地址返回 ${response?.status()}`);
  const usingPrefix = await page.evaluate(() => window.StatsHosting?.tinywebdb?.prefix);
  if (usingPrefix !== prefix) throw new Error(`前缀注入失败：${usingPrefix}`);
  if (!(await page.evaluate(() => window.StatsHosting?.tinywebdb?.user))) throw new Error('线上没有注入数据库账号');
  const clientId = await page.evaluate(() => JSON.parse(localStorage.getItem('qingji-statistics-demo-v1')).clientId);
  report.clientId = clientId;
  step('线上配置与一次性前缀就绪', { prefix, user: 'zqhscut', clientId });

  // 数量累加：需求里的两笔
  await page.fill('#data-input', '1(100) 2(50)');
  await page.locator('#save-button').click();
  await page.fill('#data-input', '1(88) 2(896)');
  await page.locator('#save-button').click();
  const total = await page.locator('#grand-total').textContent();
  const rows = await page.locator('.summary-row').evaluateAll(list => list.map(row => [row.querySelector('.number-tag').textContent, row.querySelector('.summary-value').textContent]));
  if (total !== '1,134') throw new Error(`合计应为 1,134，实际 ${total}`);
  if (JSON.stringify(rows) !== JSON.stringify([['01', '188'], ['02', '946']])) throw new Error(`汇总不对：${JSON.stringify(rows)}`);
  step('线上数量累加结果正确', { total, rows });

  // 次数统计
  await page.locator('button[data-mode="frequency"]').click();
  await page.fill('#data-input', '1 2 1 50');
  await page.locator('#save-button').click();
  const freqTotal = await page.locator('#grand-total').textContent();
  if (freqTotal !== '4') throw new Error(`次数统计合计应为 4，实际 ${freqTotal}`);
  step('线上次数统计结果正确', { total: freqTotal });

  // 云端同步（真数据库）；界面的"云端已同步"可能早于最后一条记录落库，所以轮询确认。
  await page.locator('#sync-button').click();
  await page.locator('#sync-text').filter({ hasText: '云端已同步' }).waitFor({ state: 'visible', timeout: 30000 });
  let cloud = [];
  for (let i = 1; i <= 10; i++) {
    cloud = await records(`${prefix}${clientId}_`);
    if (cloud.some(r => r.value?.kind === 'state')) break;
    await new Promise(r => setTimeout(r, 1500));
  }
  if (!cloud.length) throw new Error('云端没有写入任何记录');
  if (cloud.some(r => !r.tag.startsWith(prefix))) throw new Error('写到了别的命名空间');
  const kinds = cloud.map(r => r.value.kind);
  if (!kinds.includes('state')) throw new Error(`云端缺少当前批次记录，实际记录：${JSON.stringify(kinds)}`);
  step('线上同步到真实数据库成功', { records: cloud.length, kinds: [...new Set(kinds)].join(',') });

  // 刷新后仍在，且同步依然幂等
  await page.reload({ waitUntil: 'load' });
  const afterReload = await page.locator('#grand-total').textContent();
  if (afterReload !== '4') throw new Error(`刷新后合计应为 4，实际 ${afterReload}`);
  await page.locator('#sync-button').click();
  await page.locator('#sync-text').filter({ hasText: '云端已同步' }).waitFor({ state: 'visible', timeout: 30000 });
  const again = await records(`${prefix}${clientId}_`);
  if (again.length !== cloud.length) throw new Error(`重复同步新增了记录：${cloud.length} -> ${again.length}`);
  step('线上刷新后数据仍在且同步幂等', { total: afterReload, records: again.length });

  await page.screenshot({ path: 'E:/微信小程序/docs/screenshots/stats-demo-live-390.png', fullPage: true });
  report.consoleErrors = problems.filter(text => !/ERR_|Failed to load resource/.test(text));
  if (report.consoleErrors.length) throw new Error(`页面有脚本错误：${JSON.stringify(report.consoleErrors.slice(0, 3))}`);
  report.ok = true;
} catch (error) {
  report.ok = false;
  report.error = error.message;
  console.error('✖ 线上验证失败：', error.message);
} finally {
  if (browser) await browser.close();
  let removed = -1;
  try { removed = await wipe(prefix); } catch (e) { report.cleanupError = e.message; }
  const left = removed === 0 ? 0 : (await records(prefix)).length;
  report.removed = Math.max(removed, 0);
  report.remaining = left;
  console.log(`清理：删除 ${Math.max(removed, 0)} 条，剩余 ${left} 条`);
  console.log('RESULT ' + JSON.stringify(report));
  process.exit(report.ok && left === 0 ? 0 : 1);
}
