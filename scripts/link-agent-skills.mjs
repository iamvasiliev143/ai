// Связывает навыки агентов: канон лежит в .agents/skills, Claude Code читает .claude/skills.
// Для каждой папки .agents/skills/<имя> создаёт .claude/skills/<имя> — junction на Windows, symlink в остальных ОС.
// Существующую копию заменяет ссылкой только если содержимое совпадает с каноном; иначе предупреждает и пропускает.
// Запуск: npm run skills:link
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, readlinkSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const source = join(root, '.agents', 'skills');
const target = join(root, '.claude', 'skills');
const linkType = process.platform === 'win32' ? 'junction' : 'dir';

function listFiles(dir, base = dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full, base));
    else out.push(relative(base, full));
  }
  return out.sort();
}

function sameContent(a, b) {
  const fa = listFiles(a);
  const fb = listFiles(b);
  if (fa.length !== fb.length || fa.some((f, i) => f !== fb[i])) return false;
  return fa.every((f) => readFileSync(join(a, f)).equals(readFileSync(join(b, f))));
}

function isLink(path) {
  try {
    return lstatSync(path).isSymbolicLink() || Boolean(readlinkSync(path));
  } catch {
    return false;
  }
}

if (!existsSync(source)) {
  console.error(`Нет каталога ${source}`);
  process.exit(1);
}
mkdirSync(target, { recursive: true });

let linked = 0;
let skipped = 0;
for (const entry of readdirSync(source, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const from = join(source, entry.name);
  const to = join(target, entry.name);

  if (existsSync(to) || isLink(to)) {
    if (isLink(to)) {
      rmSync(to, { recursive: false, force: true });
    } else if (statSync(to).isDirectory() && sameContent(from, to)) {
      rmSync(to, { recursive: true, force: true });
    } else {
      console.warn(`Пропуск ${entry.name}: в .claude/skills лежит копия, отличная от канона. Перенесите правки в .agents/skills и запустите снова.`);
      skipped++;
      continue;
    }
  }
  symlinkSync(from, to, linkType);
  linked++;
}

console.log(`skills:link — связано: ${linked}, пропущено: ${skipped}`);
process.exit(skipped > 0 ? 1 : 0);
