import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const source = fileURLToPath(new URL('../', import.meta.url));
const DEFAULT_PREFIX = 'wxstat_demo_v1_';
const DEFAULT_SITE_URL = 'https://123zxs345.github.io/qingji-stats/';
const SITE_FILES = ['index.html', 'styles.css', 'icon.svg', 'app.mjs', 'core.mjs', 'tinywebdb.mjs'];

export async function exportSite(options = {}) {
  const site = new URL(options.siteUrl || process.env.SITE_URL || DEFAULT_SITE_URL);
  if (!['http:', 'https:'].includes(site.protocol) || site.search || site.hash) throw new Error('站点地址必须是 HTTP(S) 地址，可以带仓库子路径');
  if (!site.pathname.endsWith('/')) site.pathname += '/';
  const siteUrl = site.href;
  const outDir = resolve(options.outDir || join(source, 'dist'));
  if (outDir === resolve(source) || resolve(source).startsWith(outDir + sep)) throw new Error('导出目录必须独立于源码目录');
  const cloud = {
    endpoint: options.endpoint || process.env.TINYWEBDB_ENDPOINT || 'https://tinywebdb.appinventor.space/api',
    user: options.user ?? process.env.TINYWEBDB_USER ?? '',
    secret: options.secret ?? process.env.TINYWEBDB_KEY ?? '',
    prefix: options.prefix || process.env.TINYWEBDB_PREFIX || DEFAULT_PREFIX
  };
  if (!cloud.prefix.startsWith('wxstat_')) throw new Error('这个 Demo 只能使用 wxstat_ 开头的独立记录前缀，避免污染其它项目的数据');
  if (cloud.user && !cloud.secret) throw new Error('提供了数据库用户名却没有提供 API 密钥');

  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  for (const file of SITE_FILES) await cp(join(source, file), join(outDir, file));
  const config = { endpoint: cloud.endpoint, user: cloud.user, secret: cloud.secret, prefix: cloud.prefix };
  await writeFile(join(outDir, 'config.js'), 'window.StatsHosting=' + JSON.stringify({ siteUrl, tinywebdb: config }).replaceAll('<', '\\u003c') + ';\n', 'utf8');
  await writeFile(join(outDir, '.nojekyll'), '', 'utf8');
  return { outDir, siteUrl, prefix: cloud.prefix, cloudConfigured: Boolean(cloud.user && cloud.secret) };
}

// 防止把密钥写进源码目录：源码里的 config.js 只能是不含账号的本地开发配置。
export async function assertSourceConfigIsLocal() {
  const text = await readFile(join(source, 'config.js'), 'utf8');
  const match = text.match(/window\.StatsHosting\s*=\s*(\{[\s\S]*?\})\s*;?\s*$/);
  if (!match) throw new Error('源码 config.js 不是预期的 window.StatsHosting 配置');
  let parsed;
  try {
    // 源码里写的是 JavaScript 对象字面量，键没有引号，不能直接用 JSON.parse。
    parsed = new Function(`return (${match[1]});`)();
  } catch { throw new Error('源码 config.js 不是合法的配置对象'); }
  const account = parsed?.tinywebdb || {};
  if (account.user || account.secret) throw new Error('源码 config.js 里不允许出现数据库账号或密钥');
  return parsed;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const options = {};
  const names = { '--site-url': 'siteUrl', '--out-dir': 'outDir', '--prefix': 'prefix' };
  for (let i = 2; i < process.argv.length; i += 2) {
    const key = names[process.argv[i]];
    if (!key || !process.argv[i + 1]) throw new Error('用法：node scripts/build.mjs [--site-url URL] [--out-dir PATH] [--prefix TAG_PREFIX]');
    options[key] = process.argv[i + 1];
  }
  await assertSourceConfigIsLocal();
  console.log(JSON.stringify(await exportSite(options)));
}
