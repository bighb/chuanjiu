#!/usr/bin/env node
// 本地补图后台：表格列出全站所有图片位（9 种食材 × 4 处 + 首页主图共 37 项），
// 浏览器里选图上传 → 自动压缩到长边 2000px → 存进本地磁盘对应目录
// → 食材图自动把 photo/photoAlt 写进对应食材 md 的 frontmatter，首页主图走约定路径无需改文件。
// 只在本机跑（node scripts/photo-admin.mjs），不随网站部署，不碰任何对象存储/云端。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'src/data/bbq');
const ASSETS_DIR = path.join(ROOT, 'src/assets/bbq');
const SITE_DIR = path.join(ROOT, 'src/assets/site');

const INGREDIENT_SLOTS = {
  top: { label: '成品特写', file: 'product.jpg' },
  sourcing: { label: '选材参考图', file: 'sourcing.jpg' },
  skewering: { label: '穿串手法图', file: 'skewering.jpg' },
  fire: { label: '熟度判断参考图', file: 'fire.jpg' },
};

function listSlugs() {
  return fs
    .readdirSync(DATA_DIR)
    .filter((f) => f.endsWith('.md') && !f.startsWith('_'))
    .map((f) => f.replace(/\.md$/, ''));
}

function readField(content, key) {
  const m = content.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
  return m ? m[1].trim() : null;
}

// ── frontmatter 行级操作：只做定点插入/替换，不用 YAML 库整体重排——
// 避免把手写内容文件里的注释、空行、标点风格重新格式化掉 ──

function frontmatterEnd(lines) {
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') return i;
  }
  throw new Error('frontmatter 未正确闭合（缺第二个 ---）');
}

/** 顶层 `key:` 块的 [起始行, 结束行)，结束行是下一个顶层键或 frontmatter 末尾 */
function blockRange(lines, end, key) {
  let start = -1;
  for (let i = 1; i < end; i++) {
    if (lines[i] === `${key}:`) {
      start = i;
      break;
    }
  }
  if (start === -1) return null;
  let stop = end;
  for (let i = start + 1; i < end; i++) {
    if (/^\S/.test(lines[i])) {
      stop = i;
      break;
    }
  }
  return [start, stop];
}

function findScalar(lines, [start, stop], key, indent) {
  const re = new RegExp(`^${' '.repeat(indent)}${key}:\\s*(.*)$`);
  for (let i = start; i < stop; i++) {
    const m = lines[i].match(re);
    if (m) return { index: i, value: m[1] };
  }
  return null;
}

/** 简单安全转义：开头是特殊字符、含 ": "、或为空就套双引号 */
function yamlScalar(value) {
  const needsQuote = value === '' || /^[\s"'\-[\]{}#&*!|>%@`]/.test(value) || value.includes(': ');
  if (!needsQuote) return value;
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function setTopScalar(lines, end, key, value) {
  const re = new RegExp(`^${key}:\\s*(.*)$`);
  for (let i = 1; i < end; i++) {
    if (/^\S/.test(lines[i]) && re.test(lines[i])) {
      lines[i] = `${key}: ${yamlScalar(value)}`;
      return;
    }
  }
  let insertAt = end;
  for (let i = 1; i < end; i++) {
    if (/^\S/.test(lines[i]) && /^photoHint:/.test(lines[i])) {
      insertAt = i;
      break;
    }
  }
  lines.splice(insertAt, 0, `${key}: ${yamlScalar(value)}`);
}

function setNestedScalar(lines, end, blockKey, key, value) {
  const range = blockRange(lines, end, blockKey);
  if (!range) throw new Error(`内容文件里找不到 ${blockKey}: 块`);
  const found = findScalar(lines, range, key, 2);
  if (found) {
    lines[found.index] = `  ${key}: ${yamlScalar(value)}`;
    return;
  }
  lines.splice(range[0] + 1, 0, `  ${key}: ${yamlScalar(value)}`);
}

function patchPhoto(content, slot, photoRelPath, altText) {
  const lines = content.split('\n');
  const end = frontmatterEnd(lines);
  if (slot === 'top') {
    setTopScalar(lines, end, 'photo', photoRelPath);
    setTopScalar(lines, end, 'photoAlt', altText);
  } else {
    setNestedScalar(lines, end, slot, 'photo', photoRelPath);
    setNestedScalar(lines, end, slot, 'photoAlt', altText);
  }
  return lines.join('\n');
}

function ingredientHasPhoto(content, slot) {
  const lines = content.split('\n');
  const end = frontmatterEnd(lines);
  if (slot === 'top') {
    return lines.slice(1, end).some((l) => /^\S/.test(l) && /^photo:/.test(l));
  }
  const range = blockRange(lines, end, slot);
  if (!range) return false;
  return !!findScalar(lines, range, 'photo', 2);
}

// ── 汇总全站图片位 ──

function listAllSlots() {
  const rows = [];
  rows.push({
    id: 'site:hero',
    group: '站点',
    groupOrder: -1,
    label: '首页主视觉',
    needsAlt: false,
    hasPhoto: fs.existsSync(path.join(SITE_DIR, 'hero.jpg')),
  });
  for (const slug of listSlugs()) {
    const content = fs.readFileSync(path.join(DATA_DIR, `${slug}.md`), 'utf-8');
    const name = readField(content, 'name') || slug;
    const order = Number(readField(content, 'order') || 100);
    for (const [key, def] of Object.entries(INGREDIENT_SLOTS)) {
      rows.push({
        id: `${slug}:${key}`,
        group: name,
        groupOrder: order,
        label: def.label,
        needsAlt: true,
        hasPhoto: ingredientHasPhoto(content, key),
      });
    }
  }
  rows.sort((a, b) => a.groupOrder - b.groupOrder);
  return rows;
}

// ── 页面 ──

const HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>串究 · 补图后台（本机）</title>
<style>
  :root { --accent: #c94420; --bg: #faf9f7; --surface: #fff; --border: #e5e3de; --text: #1a1816; --text-2: #6b6560; --text-3: #a09890; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: -apple-system, 'PingFang SC', sans-serif; background: var(--bg); color: var(--text); }
  header { padding: 18px clamp(16px, 4vw, 40px); border-bottom: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap; position: sticky; top: 0; background: var(--bg); z-index: 5; }
  h1 { font-size: 17px; margin: 0 0 2px; }
  header p { margin: 0; font-size: 12px; color: var(--text-3); }
  .toolbar { display: flex; gap: 10px; align-items: center; }
  .toolbar input[type=text] { font-size: 13px; padding: 6px 10px; border: 1px solid var(--border); border-radius: 6px; width: 160px; }
  .toolbar label { font-size: 12px; color: var(--text-2); display: flex; align-items: center; gap: 4px; white-space: nowrap; }
  main { padding: 0 clamp(16px, 4vw, 40px) 40px; max-width: 1100px; margin: 0 auto; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  thead th { text-align: left; font-size: 11px; color: var(--text-3); font-weight: 600; padding: 8px 6px; border-bottom: 1px solid var(--border); position: sticky; top: 62px; background: var(--bg); }
  tbody tr { border-bottom: 1px solid var(--border); }
  tbody tr.done .status { color: #15803d; }
  tbody tr.hide { display: none; }
  td { padding: 8px 6px; vertical-align: middle; }
  .col-group { font-weight: 700; white-space: nowrap; }
  .col-group .sub { display: block; font-weight: 400; color: var(--text-3); font-size: 11px; }
  .col-slot { color: var(--text-2); white-space: nowrap; }
  .thumb { width: 64px; height: 48px; border: 1px dashed var(--border); border-radius: 6px; cursor: pointer; display: flex; align-items: center; justify-content: center; overflow: hidden; background: #f6f5f2; color: var(--text-3); font-size: 10px; text-align: center; }
  .thumb.drag { border-color: var(--accent); background: rgba(201,68,32,.08); }
  .thumb img { width: 100%; height: 100%; object-fit: cover; }
  .col-alt input { width: 100%; min-width: 140px; font-size: 12px; padding: 5px 8px; border: 1px solid var(--border); border-radius: 6px; }
  .col-alt .disabled { color: var(--text-3); font-size: 11px; }
  .col-action { white-space: nowrap; }
  .col-action button { font-size: 12px; padding: 5px 12px; border-radius: 6px; border: none; background: var(--accent); color: #fff; cursor: pointer; }
  .col-action button:disabled { opacity: .35; cursor: not-allowed; }
  .status { font-size: 11px; color: var(--text-3); margin-left: 6px; }
  footer { padding: 16px clamp(16px, 4vw, 40px); color: var(--text-3); font-size: 12px; }
  code { background: #f0efec; padding: 1px 5px; border-radius: 4px; }
</style>
</head>
<body>
<header>
  <div>
    <h1>🍢 串究 · 补图后台</h1>
    <p>只在本机跑，图片直接落本地磁盘，不经过任何对象存储。上传自动摆正方向 + 压到长边 2000px。</p>
  </div>
  <div class="toolbar">
    <input type="text" id="filter" placeholder="搜食材名…" />
    <label><input type="checkbox" id="onlyMissing" /> 只看待补</label>
  </div>
</header>
<main>
  <table>
    <thead>
      <tr><th style="width:120px">位置</th><th style="width:110px">图片位</th><th style="width:80px">预览</th><th>替代文字</th><th style="width:100px">操作</th></tr>
    </thead>
    <tbody id="rows"><tr><td colspan="5">加载中…</td></tr></tbody>
  </table>
</main>
<footer>改完记得自己 <code>git add -A && git commit -m "补图" && git push</code>——这个工具不会帮你提交。</footer>
<script>
const tbody = document.getElementById('rows');
const filterInput = document.getElementById('filter');
const onlyMissing = document.getElementById('onlyMissing');
let allSlots = [];

async function load() {
  allSlots = await fetch('/api/slots').then((r) => r.json());
  render();
}

function render() {
  const q = filterInput.value.trim().toLowerCase();
  tbody.innerHTML = '';
  for (const slot of allSlots) {
    if (q && !slot.group.toLowerCase().includes(q)) continue;
    if (onlyMissing.checked && slot.hasPhoto) continue;
    tbody.appendChild(renderRow(slot));
  }
  if (!tbody.children.length) {
    tbody.innerHTML = '<tr><td colspan="5" style="color:var(--text-3)">没有匹配的图片位</td></tr>';
  }
}

function renderRow(slot) {
  const tr = document.createElement('tr');
  tr.className = slot.hasPhoto ? 'done' : '';
  const previewSrc = slot.hasPhoto ? \`/asset-preview/\${slot.id.replace(':', '/')}.jpg?t=\${Date.now()}\` : '';
  tr.innerHTML = \`
    <td class="col-group">\${slot.group}\${slot.groupOrder >= 0 ? '' : ''}</td>
    <td class="col-slot">\${slot.label}</td>
    <td>
      <div class="thumb" tabindex="0">\${slot.hasPhoto ? \`<img src="\${previewSrc}" />\` : '拖图/点击'}</div>
      <input type="file" accept="image/*" hidden />
    </td>
    <td class="col-alt">\${slot.needsAlt ? '<input type="text" placeholder="替代文字（必填）" />' : '<span class="disabled">站点图无需填写</span>'}</td>
    <td class="col-action"><button disabled>上传</button><span class="status"></span></td>
  \`;

  const thumb = tr.querySelector('.thumb');
  const fileInput = tr.querySelector('input[type=file]');
  const altInput = tr.querySelector('.col-alt input');
  const btn = tr.querySelector('button');
  const status = tr.querySelector('.status');
  let file = null;

  const pick = (f) => {
    if (!f) return;
    file = f;
    thumb.innerHTML = \`<img src="\${URL.createObjectURL(f)}" />\`;
    checkReady();
  };
  const checkReady = () => {
    btn.disabled = !(file && (!slot.needsAlt || altInput?.value.trim()));
  };

  thumb.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', (e) => pick(e.target.files[0]));
  thumb.addEventListener('dragover', (e) => { e.preventDefault(); thumb.classList.add('drag'); });
  thumb.addEventListener('dragleave', () => thumb.classList.remove('drag'));
  thumb.addEventListener('drop', (e) => {
    e.preventDefault();
    thumb.classList.remove('drag');
    pick(e.dataTransfer.files[0]);
  });
  altInput?.addEventListener('input', checkReady);

  btn.addEventListener('click', async () => {
    btn.disabled = true;
    status.textContent = '上传中…';
    status.style.color = 'var(--text-3)';
    try {
      const qs = new URLSearchParams({ id: slot.id, alt: altInput ? altInput.value.trim() : '' });
      const res = await fetch('/api/upload?' + qs, { method: 'POST', body: file });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error);
      status.textContent = '已保存';
      status.style.color = '#15803d';
      load();
    } catch (err) {
      status.textContent = err.message;
      status.style.color = '#b91c1c';
      btn.disabled = false;
    }
  });

  return tr;
}

filterInput.addEventListener('input', render);
onlyMissing.addEventListener('change', render);
load();
</script>
</body>
</html>`;

// ── HTTP server ──

function resolveSlot(id) {
  const [scope, key] = id.split(':');
  if (scope === 'site' && key === 'hero') {
    return { kind: 'site', dir: SITE_DIR, file: 'hero.jpg' };
  }
  if (!listSlugs().includes(scope)) throw new Error('未知食材 slug');
  const def = INGREDIENT_SLOTS[key];
  if (!def) throw new Error('未知图片位');
  return { kind: 'ingredient', slug: scope, slotKey: key, dir: path.join(ASSETS_DIR, scope), file: def.file };
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');

    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(HTML);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/slots') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(listAllSlots()));
      return;
    }

    if (req.method === 'GET' && url.pathname.startsWith('/asset-preview/')) {
      const rel = url.pathname.replace('/asset-preview/', '');
      const id = rel.replace(/\.jpg$/, '').replace('/', ':');
      const info = resolveSlot(id);
      const filePath = path.join(info.dir, info.file);
      if (!filePath.startsWith(ROOT) || !fs.existsSync(filePath)) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' });
      fs.createReadStream(filePath).pipe(res);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/upload') {
      const id = url.searchParams.get('id') ?? '';
      const alt = (url.searchParams.get('alt') ?? '').trim();
      const info = resolveSlot(id);
      if (info.kind === 'ingredient' && !alt) throw new Error('替代文字不能为空');

      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const buffer = Buffer.concat(chunks);
      if (buffer.length === 0) throw new Error('没收到图片数据');

      fs.mkdirSync(info.dir, { recursive: true });
      const destPath = path.join(info.dir, info.file);
      await sharp(buffer)
        .rotate() // 按 EXIF 自动摆正，再丢掉 EXIF
        .resize(2000, 2000, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 85 })
        .toFile(destPath);

      if (info.kind === 'ingredient') {
        const mdPath = path.join(DATA_DIR, `${info.slug}.md`);
        const content = fs.readFileSync(mdPath, 'utf-8');
        const relPath = `../../assets/bbq/${info.slug}/${info.file}`;
        fs.writeFileSync(mdPath, patchPhoto(content, info.slotKey, relPath, alt));
      }
      // site:hero 不需要碰任何文件——index.astro 用 import.meta.glob 按约定路径自动捡到它

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  } catch (err) {
    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, error: err.message }));
  }
});

const PORT = 4322;
server.listen(PORT, () => {
  console.log(`\n🍢 补图后台已启动：http://localhost:${PORT}`);
  console.log('（只在本机跑，不随网站部署，Ctrl+C 关闭）\n');
});
