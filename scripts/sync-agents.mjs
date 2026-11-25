// Агенты проекта: канон лежит в .agents/agents/<имя>.md, Claude Code читает .claude/agents, Codex — .codex/agents.
// Скрипт проверяет канон и генерирует оба формата. Сгенерированные файлы не хранятся в git.
// Проверка: однострочные name/description агента, навыки агента существуют, агент есть в docs/agents.md;
// у каждого навыка name = папке и есть description, навык используется хотя бы одним агентом,
// относительные ссылки в его .md-файлах ведут на существующие файлы.
// Запуск: npm run agents:sync — проверка и генерация; npm run agents:check — только проверка (входит в check:docs).
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const source = join(root, '.agents', 'agents');
const skillsDir = join(root, '.agents', 'skills');
const roster = join(root, 'docs', 'agents.md');
const claudeDir = join(root, '.claude', 'agents');
const codexDir = join(root, '.codex', 'agents');
const checkOnly = process.argv.includes('--check');

const errors = [];

// Поддерживается только нужное подмножество YAML: строки `ключ: значение` и списки `- элемент`.
function parse(file) {
  const text = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  const match = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) {
    errors.push(`${basename(file)}: нет блока frontmatter`);
    return null;
  }
  const meta = {};
  let listKey = null;
  for (const line of match[1].split('\n')) {
    const item = line.match(/^\s+-\s+(.+)$/);
    if (item && listKey) {
      meta[listKey].push(item[1].trim());
      continue;
    }
    const pair = line.match(/^([a-z_]+):\s*(.*)$/);
    if (!pair) continue;
    const [, key, value] = pair;
    if (value === '') {
      meta[key] = [];
      listKey = key;
    } else {
      meta[key] = value === 'true' ? true : value === 'false' ? false : value.trim();
      listKey = null;
    }
  }
  return { meta, body: match[2].trim() };
}

if (!existsSync(source)) {
  console.error(`Нет каталога ${source}`);
  process.exit(1);
}

const rosterText = existsSync(roster) ? readFileSync(roster, 'utf8') : '';
if (!rosterText) errors.push('нет docs/agents.md');

const agents = [];
for (const file of readdirSync(source).filter((f) => f.endsWith('.md')).sort()) {
  const parsed = parse(join(source, file));
  if (!parsed) continue;
  const { meta, body } = parsed;
  const id = file.replace(/\.md$/, '');
  if (meta.name !== id) errors.push(`${file}: name «${meta.name}» не совпадает с именем файла`);
  if (!meta.description) errors.push(`${file}: нет description`);
  if (!Array.isArray(meta.skills) || meta.skills.length === 0) errors.push(`${file}: нет списка skills`);
  for (const skill of meta.skills ?? []) {
    if (!existsSync(join(skillsDir, skill, 'SKILL.md'))) errors.push(`${file}: навык ${skill} не найден в .agents/skills`);
  }
  if (!rosterText.includes(`\`${id}\``)) errors.push(`${file}: агент не упомянут в docs/agents.md`);
  if (body.includes("'''")) errors.push(`${file}: тело не должно содержать '''`);
  agents.push({ id, meta, body });
}

// Однострочные name и description: многострочные значения YAML парсер не поддерживает.
for (const { id, meta } of agents) {
  for (const key of ['name', 'description']) {
    if (typeof meta[key] === 'string' && /^[>|]/.test(meta[key])) errors.push(`${id}.md: ${key} должен быть одной строкой`);
  }
}

// Навыки: frontmatter, использование агентами, относительные ссылки.
const usedSkills = new Set(agents.flatMap(({ meta }) => meta.skills ?? []));
function listMd(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...listMd(full));
    else if (e.name.endsWith('.md')) out.push(full);
  }
  return out;
}
for (const skill of readdirSync(skillsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort()) {
  const skillFile = join(skillsDir, skill, 'SKILL.md');
  if (!existsSync(skillFile)) {
    errors.push(`навык ${skill}: нет SKILL.md`);
    continue;
  }
  const head = readFileSync(skillFile, 'utf8').replace(/\r\n/g, '\n').match(/^---\n([\s\S]*?)\n---\n/);
  const name = head?.[1].match(/^name:\s*['"]?([^'"\n]+?)['"]?\s*$/m)?.[1];
  if (name !== skill) errors.push(`навык ${skill}: name во frontmatter «${name ?? ''}» не совпадает с папкой`);
  if (!head || !/^description:\s*\S/m.test(head[1])) errors.push(`навык ${skill}: нет description`);
  if (!usedSkills.has(skill)) errors.push(`навык ${skill}: не используется ни одним агентом`);
  for (const file of listMd(join(skillsDir, skill))) {
    const text = readFileSync(file, 'utf8').replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
    for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) {
      const target = m[1].split('#')[0];
      if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
      if (!existsSync(resolve(dirname(file), decodeURI(target)))) {
        errors.push(`навык ${skill}: битая ссылка ${m[1]} в ${file.slice(skillsDir.length + 1)}`);
      }
    }
  }
}

if (errors.length) {
  for (const e of errors) console.error(`agents: ${e}`);
  process.exit(1);
}

if (checkOnly) {
  console.log(`agents:check — проблем нет (агентов: ${agents.length})`);
  process.exit(0);
}

for (const dir of [claudeDir, codexDir]) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
}

const readonlyNote = 'Режим: только чтение. Файлы репозитория не меняешь, результат — отчёт.';

for (const { id, meta, body } of agents) {
  const skillList = meta.skills.map((s) => `.agents/skills/${s}/SKILL.md`).join(', ');

  const claude = [
    '---',
    `name: ${id}`,
    `description: ${JSON.stringify(meta.description)}`,
    'skills:',
    ...meta.skills.map((s) => `  - ${s}`),
    ...(meta.readonly ? ['disallowedTools: Edit, Write, NotebookEdit'] : []),
    '---',
    '',
    '<!-- Сгенерировано из .agents/agents командой npm run agents:sync. Правки — в каноне. -->',
    '',
    ...(meta.readonly ? [readonlyNote, ''] : []),
    body,
    '',
  ].join('\n');
  writeFileSync(join(claudeDir, `${id}.md`), claude);

  const codex = [
    '# Сгенерировано из .agents/agents командой npm run agents:sync. Правки — в каноне.',
    `name = ${JSON.stringify(id)}`,
    `description = ${JSON.stringify(meta.description)}`,
    "developer_instructions = '''",
    `Перед работой прочитай навыки: ${skillList}.`,
    ...(meta.readonly ? [readonlyNote] : []),
    '',
    body,
    "'''",
    '',
  ].join('\n');
  writeFileSync(join(codexDir, `${id}.toml`), codex);
}

console.log(`agents:sync — сгенерировано агентов: ${agents.length} (.claude/agents, .codex/agents)`);
