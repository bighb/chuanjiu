#!/usr/bin/env node
// 本地补图工具：浏览器拖图片 → 自动压缩到长边 2000px → 存进 src/assets/bbq/<slug>/
// → 自动把 photo/photoAlt 写进对应食材 md 的 frontmatter。
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

const SLOTS = {
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
  // 顶层 photoHint 一定存在（04 文档要求四处都填），插在它前面；找不到就插在 frontmatter 末尾前
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

function hasPhoto(content, slot) {
  const lines = content.split('\n');
  const end = frontmatterEnd(lines);
  if (slot === 'top') {
    return lines.slice(1, end).some((l) => /^\S/.test(l) && /^photo:/.test(l));
  }
  const range = blockRange(lines, end, slot);
  if (!range) return false;
  return !!findScalar(lines, range, 'photo', 2);
}

// ── 页面 ──

const HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>串究 · 补图工具（本机）</title>
<style>
  :root { --accent: #c94420; --bg: #faf9f7; --surface: #fff; --border: #e5e3de; --text: #1a1816; --text-2: #6b6560; --text-3: #a09890; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: -apple-system, 'PingFang SC', sans-serif; background: var(--bg); color: var(--text); }
  header { padding: 20px clamp(16px, 4vw, 48px); border-bottom: 1px solid var(--border); }
  h1 { font-size: 18px; margin: 0 0 4px; }
  header p { margin: 0; font-size: 13px; color: var(--text-3); }
  main { padding: 24px clamp(16px, 4vw, 48px); max-width: 960px; margin: 0 auto; }
  .entry { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; margin-bottom: 16px; overflow: hidden; }
  .entry-head { display: flex; align-items: center; justify-content: space-between; padding: 14px 18px; cursor: pointer; }
  .entry-head:hover { background: #f6f5f2; }
  .entry-name { font-weight: 700; }
  .entry-progress { font-size: 12px; color: var(--text-3); font-family: ui-monospace, monospace; }
  .entry-body { display: none; grid-template-columns: repeat(2, 1fr); gap: 14px; padding: 0 18px 18px; }
  .entry-body.open { display: grid; }
  .slot { border: 1px solid var(--border); border-radius: 8px; padding: 12px; }
  .slot-label { font-size: 13px; font-weight: 600; margin-bottom: 8px; display: flex; justify-content: space-between; }
  .slot-status { font-size: 11px; padding: 1px 6px; border-radius: 4px; }
  .slot-status.yes { background: rgba(21,128,61,.1); color: #15803d; }
  .slot-status.no { background: #f0efec; color: var(--text-3); }
  .drop { border: 2px dashed var(--border); border-radius: 6px; aspect-ratio: 16/9; display: flex; align-items: center; justify-content: center; color: var(--text-3); font-size: 12px; cursor: pointer; overflow: hidden; position: relative; background: #f6f5f2; }
  .drop.drag { border-color: var(--accent); background: rgba(201,68,32,.06); }
  .drop img { width: 100%; height: 100%; object-fit: cover; }
  .drop input { display: none; }
  .alt-row { display: flex; gap: 6px; margin-top: 8px; }
  .alt-row input { flex: 1; font-size: 12px; padding: 6px 8px; border: 1px solid var(--border); border-radius: 6px; }
  .alt-row button { font-size: 12px; padding: 6px 12px; border-radius: 6px; border: none; background: var(--accent); color: #fff; cursor: pointer; }
  .alt-row button:disabled { opacity: .4; cursor: not-allowed; }
  .msg { font-size: 11px; margin-top: 4px; min-height: 14px; }
  .msg.err { color: #b91c1c; }
  .msg.ok { color: #15803d; }
  footer { padding: 16px clamp(16px, 4vw, 48px); color: var(--text-3); font-size: 12px; }
</style>
</head>
<body>
<header>
  <h1>🍢 串究 · 补图工具</h1>
  <p>只在本机跑，图片直接存进仓库磁盘，不经过任何对象存储。上传自动压缩到长边 2000px。</p>
</header>
<main id="app">加载中…</main>
<footer>改完记得自己 <code>git add -A && git commit -m "补图" && git push</code>——这个工具不会帮你提交。</footer>
<script>
const SLOTS = ${JSON.stringify(SLOTS)};
const app = document.getElementById('app');

async function load() {
  const entries = await fetch('/api/entries').then((r) => r.json());
  app.innerHTML = '';
  for (const entry of entries) {
    app.appendChild(renderEntry(entry));
  }
}

function renderEntry(entry) {
  const wrap = document.createElement('div');
  wrap.className = 'entry';
  const done = Object.keys(SLOTS).filter((k) => entry.slots[k]).length;
  wrap.innerHTML = \`
    <div class="entry-head">
      <span class="entry-name">\${entry.name}<span style="color:var(--text-3);font-weight:400;margin-left:8px">\${entry.slug}</span></span>
      <span class="entry-progress">\${done}/4 图片位</span>
    </div>
    <div class="entry-body"></div>
  \`;
  const head = wrap.querySelector('.entry-head');
  const body = wrap.querySelector('.entry-body');
  head.addEventListener('click', () => {
    const willOpen = !body.classList.contains('open');
    body.classList.toggle('open', willOpen);
    if (willOpen && !body.dataset.rendered) {
      body.dataset.rendered = '1';
      for (const [slot, def] of Object.entries(SLOTS)) {
        body.appendChild(renderSlot(entry, slot, def));
      }
    }
  });
  return wrap;
}

function renderSlot(entry, slot, def) {
  const box = document.createElement('div');
  box.className = 'slot';
  const has = entry.slots[slot];
  box.innerHTML = \`
    <div class="slot-label">\${def.label}<span class="slot-status \${has ? 'yes' : 'no'}">\${has ? '已有' : '待补'}</span></div>
    <div class="drop">
      \${has ? \`<img src="/asset-preview/\${entry.slug}/\${def.file}?t=\${Date.now()}" />\` : '拖图片到这里，或点击选择'}
      <input type="file" accept="image/*" />
    </div>
    <div class="alt-row">
      <input type="text" placeholder="替代文字（必填）" />
      <button disabled>上传</button>
    </div>
    <div class="msg"></div>
  \`;
  const drop = box.querySelector('.drop');
  const fileInput = box.querySelector('input[type=file]');
  const altInput = box.querySelector('.alt-row input');
  const btn = box.querySelector('.alt-row button');
  const msg = box.querySelector('.msg');
  let file = null;

  const pick = (f) => {
    if (!f) return;
    file = f;
    const url = URL.createObjectURL(f);
    drop.innerHTML = \`<img src="\${url}" /><input type="file" accept="image/*" style="display:none" />\`;
    checkReady();
  };
  const checkReady = () => { btn.disabled = !(file && altInput.value.trim()); };

  drop.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', (e) => pick(e.target.files[0]));
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('drag'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('drag'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('drag');
    pick(e.dataTransfer.files[0]);
  });
  altInput.addEventListener('input', checkReady);

  btn.addEventListener('click', async () => {
    btn.disabled = true;
    msg.textContent = '上传中…';
    msg.className = 'msg';
    try {
      const qs = new URLSearchParams({ slug: entry.slug, slot, alt: altInput.value.trim() });
      const res = await fetch('/api/upload?' + qs, { method: 'POST', body: file });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error);
      msg.textContent = '已保存';
      msg.className = 'msg ok';
      load(); // 刷新整页状态（简单直接，这工具不追求局部刷新）
    } catch (err) {
      msg.textContent = err.message;
      msg.className = 'msg err';
      btn.disabled = false;
    }
  });

  return box;
}

load();
</script>
</body>
</html>`;

// ── HTTP server ──

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');

    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(HTML);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/entries') {
      const entries = listSlugs()
        .map((slug) => {
          const content = fs.readFileSync(path.join(DATA_DIR, `${slug}.md`), 'utf-8');
          const slots = {};
          for (const key of Object.keys(SLOTS)) slots[key] = hasPhoto(content, key);
          return {
            slug,
            name: readField(content, 'name') || slug,
            order: Number(readField(content, 'order') || 100),
            slots,
          };
        })
        .sort((a, b) => a.order - b.order);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(entries));
      return;
    }

    if (req.method === 'GET' && url.pathname.startsWith('/asset-preview/')) {
      const [, , slug, file] = url.pathname.split('/');
      const filePath = path.join(ASSETS_DIR, slug ?? '', file ?? '');
      if (!filePath.startsWith(ASSETS_DIR) || !fs.existsSync(filePath)) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' });
      fs.createReadStream(filePath).pipe(res);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/upload') {
      const slug = url.searchParams.get('slug') ?? '';
      const slot = url.searchParams.get('slot') ?? '';
      const alt = (url.searchParams.get('alt') ?? '').trim();

      if (!listSlugs().includes(slug)) throw new Error('未知食材 slug');
      if (!SLOTS[slot]) throw new Error('未知图片位');
      if (!alt) throw new Error('替代文字不能为空');

      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const buffer = Buffer.concat(chunks);
      if (buffer.length === 0) throw new Error('没收到图片数据');

      const destDir = path.join(ASSETS_DIR, slug);
      fs.mkdirSync(destDir, { recursive: true });
      const destFile = SLOTS[slot].file;
      const destPath = path.join(destDir, destFile);

      await sharp(buffer)
        .rotate() // 按 EXIF 自动摆正，再丢掉 EXIF
        .resize(2000, 2000, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 85 })
        .toFile(destPath);

      const mdPath = path.join(DATA_DIR, `${slug}.md`);
      const content = fs.readFileSync(mdPath, 'utf-8');
      const relPath = `../../assets/bbq/${slug}/${destFile}`;
      fs.writeFileSync(mdPath, patchPhoto(content, slot, relPath, alt));

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
  console.log(`\n🍢 补图工具已启动：http://localhost:${PORT}`);
  console.log('（只在本机跑，不随网站部署，Ctrl+C 关闭）\n');
});
