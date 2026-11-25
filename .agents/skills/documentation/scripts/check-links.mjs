#!/usr/bin/env node
// Проверка Markdown-документации репозитория без внешних зависимостей.
//
// Что проверяет:
//   1. Относительные ссылки ведут на существующий файл или каталог.
//   2. Якорь (#...) существует в целевом .md (слаги в стиле GitHub, кириллица сохраняется).
//   3. Ссылка не выходит за пределы репозитория и не является абсолютным путём.
//   4. Каждый docs/**/*.md (кроме docs/README.md) связан ссылкой хотя бы из одного другого документа.
//   5. Номера ADR в docs/adr/ уникальны и идут подряд с 0001.
// Ссылки внутри блоков кода (``` и ~~~) и внутри `inline code` не проверяются.
// Внешние ссылки (http:, https:, mailto: и т. п.) не проверяются.
//
// Запуск: npm run check:docs (из корня репозитория). Код выхода 1 — найдены проблемы.

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative, resolve, dirname, sep, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
// Скрипт лежит в <repo>/.agents/skills/documentation/scripts/
const ROOT = resolve(SCRIPT_DIR, '..', '..', '..', '..');
const EXCLUDED_DIRS = new Set([
  'node_modules',
  '.agents',
  '.claude',
  '.codex',
  'dist',
  'build',
  '.git',
  'coverage',
  '.idea',
  '.vscode',
]);

const problems = [];
const report = (file, line, message) => problems.push({ file, line, message });

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!EXCLUDED_DIRS.has(entry.name)) walk(join(dir, entry.name), out);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

const toRepoPath = (abs) => relative(ROOT, abs).split(sep).join('/');

// Строки файла с пометкой «внутри блока кода» и без inline code.
function contentLines(text) {
  const lines = text.split(/\r?\n/);
  const result = [];
  let fence = null;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const m = raw.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (m) {
      const marker = m[1];
      if (fence === null) {
        fence = marker;
        continue;
      }
      if (marker[0] === fence[0] && marker.length >= fence.length && raw.trim() === marker) {
        fence = null;
        continue;
      }
    }
    if (fence !== null) continue;
    result.push({ n: i + 1, text: stripInlineCode(raw) });
  }
  return result;
}

function stripInlineCode(line) {
  return line.replace(/(`+)(?:(?!\1).)+?\1/g, (s) => ' '.repeat(s.length));
}

// Слаг заголовка как у GitHub: нижний регистр, удаляем всё, кроме букв, цифр, знаков
// соединения, пробелов и дефисов, пробелы заменяем на дефисы. Повторы получают -1, -2...
function slugify(heading) {
  const text = heading
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/`/g, '')
    .trim()
    .toLowerCase();
  return text.replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '').replace(/ /g, '-');
}

const anchorCache = new Map();
function anchorsOf(absFile) {
  if (anchorCache.has(absFile)) return anchorCache.get(absFile);
  const anchors = new Set();
  const counts = new Map();
  const text = readFileSync(absFile, 'utf8');
  const lines = text.split(/\r?\n/);
  let fence = null;
  for (const line of lines) {
    const m = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (m) {
      if (fence === null) fence = m[1];
      else if (m[1][0] === fence[0] && line.trim() === m[1]) fence = null;
      continue;
    }
    if (fence !== null) continue;
    const h = line.match(/^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/);
    if (h) {
      const base = slugify(h[1]);
      const n = counts.get(base) ?? 0;
      counts.set(base, n + 1);
      anchors.add(n === 0 ? base : `${base}-${n}`);
    }
    for (const a of line.matchAll(/<a\s+[^>]*(?:id|name)\s*=\s*["']([^"']+)["']/gi)) anchors.add(a[1]);
  }
  anchorCache.set(absFile, anchors);
  return anchors;
}

// Извлекает цели ссылок: [text](target "title"), ![alt](target), [id]: target.
function linkTargets(line) {
  const targets = [];
  const inline = /!?\[(?:[^\]\\]|\\.)*\]\(\s*(<[^>]*>|[^\s)]+(?:\([^\s)]*\)[^\s)]*)*)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g;
  for (const m of line.matchAll(inline)) targets.push(m[1]);
  const ref = line.match(/^\s{0,3}\[[^\]]+\]:\s*(<[^>]*>|\S+)/);
  if (ref) targets.push(ref[1]);
  return targets.map((t) => (t.startsWith('<') && t.endsWith('>') ? t.slice(1, -1) : t));
}

const files = walk(ROOT);
const docFiles = files.filter((f) => toRepoPath(f).startsWith('docs/'));
const linkedFrom = new Map(); // repo path -> set of source repo paths

for (const file of files) {
  const src = toRepoPath(file);
  const text = readFileSync(file, 'utf8');
  for (const { n, text: line } of contentLines(text)) {
    for (const target of linkTargets(line)) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(target) && !/^[a-z]:[\\/]/i.test(target)) continue; // внешняя схема
      if (target.startsWith('//')) {
        report(src, n, `ссылка без схемы на внешний ресурс: ${target}`);
        continue;
      }
      if (target.startsWith('/') || /^[a-z]:[\\/]/i.test(target) || target.startsWith('\\')) {
        report(src, n, `абсолютный путь вместо относительной ссылки: ${target}`);
        continue;
      }
      const hashIdx = target.indexOf('#');
      const rawPath = hashIdx === -1 ? target : target.slice(0, hashIdx);
      const rawAnchor = hashIdx === -1 ? null : target.slice(hashIdx + 1);
      let pathPart;
      let anchor;
      try {
        pathPart = decodeURIComponent(rawPath.split('?')[0]);
        anchor = rawAnchor === null ? null : decodeURIComponent(rawAnchor);
      } catch {
        report(src, n, `некорректное кодирование ссылки: ${target}`);
        continue;
      }
      const absTarget = pathPart === '' ? file : resolve(dirname(file), pathPart);
      const rel = relative(ROOT, absTarget);
      if (rel.startsWith('..') || resolve(ROOT, rel) !== absTarget) {
        report(src, n, `ссылка выходит за пределы репозитория: ${target}`);
        continue;
      }
      if (!existsSync(absTarget)) {
        report(src, n, `файл не найден: ${target}`);
        continue;
      }
      const isFile = statSync(absTarget).isFile();
      const targetRepo = toRepoPath(absTarget);
      if (isFile && absTarget !== file) {
        if (!linkedFrom.has(targetRepo)) linkedFrom.set(targetRepo, new Set());
        linkedFrom.get(targetRepo).add(src);
      }
      if (anchor !== null && anchor !== '' && isFile && extname(absTarget).toLowerCase() === '.md') {
        if (!anchorsOf(absTarget).has(anchor) && !anchorsOf(absTarget).has(anchor.toLowerCase())) {
          report(src, n, `якорь не найден: ${target}`);
        }
      }
    }
  }
}

// Документы вне оглавления: ни одной входящей ссылки из другого файла.
for (const doc of docFiles) {
  const p = toRepoPath(doc);
  if (p === 'docs/README.md') continue;
  if (!linkedFrom.has(p)) report(p, 0, 'нет входящих ссылок: добавьте документ в оглавление или в родительский документ');
}

// Номера ADR: уникальны и идут подряд.
const adrDir = join(ROOT, 'docs', 'adr');
if (existsSync(adrDir)) {
  const nums = readdirSync(adrDir)
    .map((name) => name.match(/^(\d{4})-.+\.md$/))
    .filter(Boolean)
    .map((m) => Number(m[1]))
    .sort((a, b) => a - b);
  const seen = new Set();
  nums.forEach((num, i) => {
    if (seen.has(num)) report('docs/adr', 0, `номер ADR ${String(num).padStart(4, '0')} повторяется`);
    seen.add(num);
    if (i === 0 && num !== 1) report('docs/adr', 0, `нумерация ADR начинается не с 0001`);
    if (i > 0 && num !== nums[i - 1] && num !== nums[i - 1] + 1) {
      report('docs/adr', 0, `пропуск в нумерации ADR между ${String(nums[i - 1]).padStart(4, '0')} и ${String(num).padStart(4, '0')}`);
    }
  });
}

const scanned = files.length;
if (problems.length === 0) {
  console.log(`check:docs — проверено файлов: ${scanned}, проблем: 0`);
  process.exit(0);
}
for (const p of problems) console.log(`${p.file}${p.line ? `:${p.line}` : ''} — ${p.message}`);
console.log(`\ncheck:docs — проверено файлов: ${scanned}, проблем: ${problems.length}`);
process.exit(1);
