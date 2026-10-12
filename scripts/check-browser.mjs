import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

// 本机预览服务和需求里的 375 / 390 手机宽度都只在本机回环地址上跑，不对外网开放。
const source = fileURLToPath(new URL('../', import.meta.url));
const root = resolve(process.env.CHECK_ROOT || source);
// 截图固定写到源码树下的 docs/screenshots，即使正在检查 dist/ 产物也放同一个位置。
const shots = resolve(source, '..', '..', 'docs', 'screenshots');
const PREFIX = 'wxstat_demo_v1_';
const types = { '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml' };

function staticServer() {
  return createServer(async (request, response) => {
    try {
      const path = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
      const relative = path === '/' ? 'index.html' : path.replace(/^\/+/, '');
      if (!relative || relative.split('/').some(part => !part || part.startsWith('.'))) { response.writeHead(404); response.end(); return; }
      const file = resolve(root, relative);
      if (!file.startsWith(root + sep) || !(await stat(file)).isFile()) { response.writeHead(404); response.end(); return; }
      response.writeHead(200, { 'content-type': types[extname(file).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store' });
      response.end(await readFile(file));
    } catch { response.writeHead(404); response.end(); }
  });
}

// 假的 TinyWebDB，语义与线上一致：update 返回空，search 返回按 tag 模糊匹配的分页对象。
// 线上服务对任意来源开放（Access-Control-Allow-Origin: *），这里必须照做，否则浏览器会直接拦掉跨端口请求。
function cloudStub() {
  const records = new Map();
  const server = createServer(async (request, response) => {
    const cors = {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': '*',
      'access-control-allow-methods': 'POST, GET, OPTIONS'
    };
    if (request.method === 'OPTIONS') { response.writeHead(204, cors); response.end(); return; }
    let body = '';
    for await (const part of request) body += part;
    const form = new URLSearchParams(body);
    if (form.get('action') === 'update') { records.set(form.get('tag'), form.get('value')); response.writeHead(200, cors); response.end(''); return; }
    const matched = [...records].filter(([tag]) => tag.includes(form.get('tag')));
    const start = Number(form.get('no') || 1) - 1;
    const page = matched.slice(start, start + Number(form.get('count') || 100));
    response.writeHead(200, { ...cors, 'content-type': 'application/json' });
    response.end(JSON.stringify(Object.fromEntries(page)));
  });
  return { server, records };
}

const listen = server => new Promise(done => server.listen(0, '127.0.0.1', () => done(`http://127.0.0.1:${server.address().port}`)));
const close = server => new Promise(done => { if (!server || typeof server.close !== 'function') { done(); return; } server.close(() => done()); });
const settle = async (fn, message) => { try { await fn(); } catch { throw new Error(message); } };

// 优先用本机已装的 Chrome，没有再退回 Playwright 自带 Chromium。
async function launchBrowser() {
  let last;
  for (const options of [{ channel: 'chrome' }, {}]) {
    try { return { browser: await chromium.launch({ headless: true, ...options }), label: options.channel ? '系统 Chrome' : 'Playwright Chromium' }; }
    catch (error) { last = error; }
  }
  throw last;
}

// 不用 node --test：它的子进程管道在受限环境里会卡住浏览器启动，这里自己收结果。
const scenarios = [];
const scenario = (name, run) => scenarios.push({ name, run });
let browser;
let site;

async function open(width, height, { cloud, before } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, locale: 'zh-CN' });
  const hosting = cloud
    ? { siteUrl: site, tinywebdb: { endpoint: cloud.endpoint, user: 'check-user', secret: 'check-secret', prefix: PREFIX } }
    : { siteUrl: site, tinywebdb: { prefix: PREFIX } };
  // 站点自己的 config.js 会在注入之后执行并覆盖 window.StatsHosting，所以这里直接换掉它的响应。
  await context.route('**/config.js', route => route.fulfill({ contentType: 'text/javascript; charset=utf-8', body: `window.StatsHosting=${JSON.stringify(hosting)};\n` }));
  if (before) await before(context);
  const page = await context.newPage();
  const problems = [];
  page.on('pageerror', error => problems.push(`pageerror: ${error.message}`));
  page.on('console', message => { if (message.type() === 'error') problems.push(`console: ${message.text()}`); });
  await page.goto(`${site}/index.html`, { waitUntil: 'load' });
  const clientId = await page.evaluate(() => JSON.parse(localStorage.getItem('qingji-statistics-demo-v1')).clientId);
  return { context, page, problems, clientId };
}

const total = page => page.locator('#grand-total').textContent();
const rows = page => page.locator('.summary-row').evaluateAll(list => list.map(row => [row.querySelector('.number-tag').textContent, row.querySelector('.summary-value').textContent]));
async function enter(page, text) {
  await page.fill('#data-input', text);
  await page.locator('#save-button').click();
}

// 把浏览器里发起的云端请求记下来，同步失败时能看清卡在哪一步。
const syncLog = [];
function syncWatcher(context) {
  context.addInitScript(() => {
    const original = globalThis.fetch;
    globalThis.fetch = async (...args) => {
      let detail = '';
      try {
        const target = typeof args[0] === 'string' ? args[0] : args[0]?.url;
        const body = String(args[1]?.body || '');
        const action = new URLSearchParams(body).get('action') || '?';
        const response = await original(...args);
        detail = `HTTP ${response.status}`;
        return response;
      } catch (error) {
        detail = `FAILED ${error.name}`;
        throw error;
      } finally {
        try { globalThis.__syncLog?.(`${action} ${detail} ${String(args[0]).slice(0, 60)}`); } catch {}
      }
    };
  });
}
const attachSyncLog = page => page.exposeFunction('__syncLog', entry => syncLog.push(entry));

// 点同步并等到「云端已同步」；失败时把状态和发出去的请求一起报出来。
async function syncNow(page, cloud) {
  await page.locator('#sync-button').click();
  try {
    await page.locator('#sync-text').filter({ hasText: '云端已同步' }).waitFor({ state: 'visible', timeout: 10000 });
  } catch {
    throw new Error(`同步没有到达「云端已同步」，当前显示「${await page.locator('#sync-text').textContent()}」；假数据库 ${cloud.records.size} 条；请求记录 ${JSON.stringify(syncLog.slice(-6))}`);
  }
}

scenario('375 和 390 像素的手机布局不横向溢出，关键区域都在首屏', async () => {
  for (const [width, height] of [[375, 812], [390, 844]]) {
    const { context, page, problems } = await open(width, height);
    const metrics = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      overflow: [...document.querySelectorAll('body *')].filter(node => node.getBoundingClientRect().right > window.innerWidth + 1).map(node => node.id || node.className || node.tagName).slice(0, 5)
    }));
    assert.equal(metrics.scrollWidth, width, `${width} 像素下页面出现横向滚动`);
    assert.deepEqual(metrics.overflow, [], `${width} 像素下有元素超出右边界`);
    // 空汇总时 #summary-list 里没有可见子元素，所以按占位盒子是否在页面内来判断。
    const layout = await page.evaluate(() => Object.fromEntries(['#grand-total', '#data-input', '#save-button', '#summary-list', '#summary-panel', 'button[data-mode="quantity"]', 'button[data-mode="frequency"]'].map(selector => {
      const box = document.querySelector(selector)?.getBoundingClientRect();
      return [selector, box ? { w: Math.round(box.width), h: Math.round(box.height), inViewport: box.left >= -1 && box.right <= window.innerWidth + 1 && box.width > 0 } : null];
    })));
    for (const [selector, box] of Object.entries(layout)) {
      assert.ok(box, `${selector} 在 ${width} 像素下不存在`);
      assert.ok(box.w > 0 && box.inViewport, `${selector} 在 ${width} 像素下被挤出屏幕或宽度为 0：${JSON.stringify(box)}`);
    }
    assert.deepEqual(problems, [], `${width} 像素下页面有脚本错误`);
    await page.screenshot({ path: resolve(shots, `stats-demo-${width}.png`), fullPage: true });
    await context.close();
  }
});

scenario('数量累加：需求里的两笔输入得到 1（188）、2（946）', async () => {
  const { context, page, problems } = await open(390, 844);
  await enter(page, '1(100) 2(50)');
  await enter(page, '1(88) 2(896)');
  assert.equal(await total(page), '1,134');
  assert.deepEqual(await rows(page), [['01', '188'], ['02', '946']]);
  assert.equal(await page.locator('#record-count').textContent(), '2');
  assert.deepEqual(problems, []);
  await context.close();
});

scenario('次数统计：1 2 1 50 得到 1（2）、2（1）、50（1）', async () => {
  const { context, page, problems } = await open(375, 812);
  await page.locator('button[data-mode="frequency"]').click();
  await enter(page, '1 2 1 50');
  assert.equal(await total(page), '4');
  assert.deepEqual(await rows(page), [['01', '2'], ['02', '1'], ['50', '1']]);
  assert.deepEqual(problems, []);
  await context.close();
});

scenario('非法数据整条拒收，也不写进本机存档', async () => {
  const { context, page, problems } = await open(390, 844);
  await page.locator('button[data-mode="frequency"]').click();
  await page.fill('#data-input', '1 2 51');
  await settle(() => page.locator('#input-preview.error').waitFor({ state: 'visible', timeout: 3000 }), '非法输入没有给出错误提示');
  assert.equal(await page.locator('#save-button').isDisabled(), true, '非法输入时保存按钮仍可点击');
  assert.equal(await page.locator('#data-input').getAttribute('aria-invalid'), 'true');
  assert.equal(await total(page), '0');
  assert.equal(await page.locator('.summary-row').count(), 0);
  assert.deepEqual(problems, []);
  await context.close();
});

scenario('关闭页面再打开记录还在；撤销扣回汇总并保留事件', async () => {
  const { context, page, problems } = await open(375, 812);
  await enter(page, '1(100) 2(50)');
  await page.locator('button[data-mode="frequency"]').click();
  await enter(page, '1 1 2');
  await page.reload({ waitUntil: 'load' });
  assert.equal(await page.locator('button[data-mode="frequency"]').getAttribute('aria-pressed'), 'true', '刷新后没有回到次数统计');
  assert.equal(await total(page), '3');
  await page.locator('#undo-button').click();
  assert.equal(await total(page), '0');
  await page.locator('#history-tab').click();
  const history = await page.locator('.history-row').allTextContents();
  assert.equal(history.length, 2, '撤销应当留下一条记录');
  assert.ok(history.some(text => text.includes('撤销了一笔')), '记录里没有撤销条目');
  await page.reload({ waitUntil: 'load' });
  assert.equal(await total(page), '0', '刷新后撤销没有生效');
  await page.locator('button[data-mode="quantity"]').click();
  assert.equal(await total(page), '150', '切换模式后数量累加的数据被改动');
  assert.deepEqual(problems, []);
  await context.close();
});

scenario('云端同步只用 wxstat_demo_v1_ 前缀，同一浏览器重复同步幂等', async () => {
  const cloud = cloudStub();
  const endpoint = await listen(cloud.server);
  try {
    const first = await open(390, 844, { cloud: { endpoint }, before: async context => { syncWatcher(context); } });
    await attachSyncLog(first.page);
    await enter(first.page, '1(100) 2(50)');
    await syncNow(first.page, cloud);
    const written = [...cloud.records.keys()];
    assert.ok(written.length >= 3, '同步没有写入批次和事件记录');
    assert.deepEqual(written.filter(tag => !tag.startsWith(PREFIX)), [], '写入了不带独立前缀的记录');
    const size = cloud.records.size;

    // 同一个浏览器（同一 clientId）刷新后再同步，不应新增任何记录。
    await first.page.reload({ waitUntil: 'load' });
    assert.equal(await total(first.page), '150', '刷新后本机记录不对');
    await syncNow(first.page, cloud);
    assert.equal(cloud.records.size, size, `同一浏览器重复同步新增了 ${cloud.records.size - size} 条记录，应当幂等`);
    assert.deepEqual(first.problems, []);
    await first.context.close();
  } finally { await close(cloud.server); }
});

scenario('换一个浏览器不会看到别人的记录，只写自己那份', async () => {
  const cloud = cloudStub();
  const endpoint = await listen(cloud.server);
  try {
    const first = await open(390, 844, { cloud: { endpoint } });
    await enter(first.page, '1(100) 2(50)');
    await syncNow(first.page, cloud);
    const size = cloud.records.size;
    await first.context.close();

    const second = await open(375, 812, { cloud: { endpoint } });
    await syncNow(second.page, cloud);
    assert.equal(await total(second.page), '0', '新浏览器看到了别的浏览器的记录');
    assert.notEqual(second.clientId, first.clientId, '两个浏览器应当是各自独立的身份');
    // 空状态同步只会拉取，不会写出记录；这里录一笔再看它是否写到自己名下。
    await enter(second.page, '1(7)');
    await syncNow(second.page, cloud);
    const mine = [...cloud.records.keys()].filter(tag => tag.includes(second.clientId));
    assert.ok(mine.length >= 3, `第二个浏览器的记录没有使用自己的身份，标签：${JSON.stringify([...cloud.records.keys()].slice(0, 4))}`);
    assert.deepEqual(second.problems, []);
    await second.context.close();
  } finally { await close(cloud.server); }
});

scenario('云端不可达时只提示本机已保存，页面和汇总照常可用', async () => {
  const dead = createServer((request, response) => response.destroy());
  const endpoint = await listen(dead);
  const { context, page, problems } = await open(390, 844, { cloud: { endpoint } });
  try {
    await enter(page, '1(20)');
    await page.locator('#sync-button').click();
    await settle(() => page.locator('#sync-text').filter({ hasText: '本机已保存' }).waitFor({ state: 'visible', timeout: 15000 }), '云端不可达时没有回退提示');
    assert.equal(await total(page), '20');
    await page.reload({ waitUntil: 'load' });
    assert.equal(await total(page), '20', '云端不可达时本机记录没有保住');
    // 这里故意让数据库断开，浏览器必然报网络资源加载失败，只要求没有脚本异常。
    assert.deepEqual(problems.filter(text => text.startsWith('pageerror')), [], '云端不可达时出现了脚本异常');
    assert.deepEqual(problems.filter(text => text.startsWith('console') && !text.includes('ERR_EMPTY_RESPONSE') && !text.includes('ERR_CONNECTION')), [], '云端不可达时出现了意料之外的脚本报错');
  } finally { await context.close(); await close(dead); }
});
let failed = 0;
try {
  const launched = await launchBrowser();
  browser = launched.browser;
  console.log(`浏览器：${launched.label}`);
  site = await listen(staticServer());
  for (const item of scenarios) {
    const started = Date.now();
    try {
      await item.run();
      console.log(`✔ ${item.name} (${Date.now() - started}ms)`);
    } catch (error) {
      failed++;
      console.log(`✖ ${item.name} (${Date.now() - started}ms)`);
      console.log(`  ${String(error.message).split('\n').slice(0, 6).join('\n  ')}`);
    }
  }
  console.log(`\n用例 ${scenarios.length}，通过 ${scenarios.length - failed}，失败 ${failed}`);
} finally {
  if (site) await close(site);
  if (browser) await browser.close();
}
process.exit(failed ? 1 : 0);
