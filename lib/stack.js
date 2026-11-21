'use strict';

// The user's stack, in ~/.spadework/stack.md: a "## Common" section plus
// one "## <project>/<repo>" section per repo, e.g. "## Shop/api".
//
// - detect(): looks at a repo's files so init can pre-fill the answers
// - forFolder() / forRepo(): the notes an agent needs (Common, the repo's
//   section, and the plugin's generic defaults)
// - save(): checks the draft init wrote and makes it stack.md

const fs = require('fs');
const path = require('path');

const paths = require('./paths');
const config = require('./config');
const { git, outputLines, samePath, topLevel } = require('./git');
const { writeFileAtomic } = require('./fs-atomic');

const GENERIC_FILE = path.join(__dirname, '..', 'stacks', 'generic.md');
const SKIP_DIRS = new Set(['.git', 'node_modules', 'bin', 'obj', 'dist', 'build', 'out', 'target', 'vendor',
  '.venv', 'venv', '__pycache__', '.idea', '.vs', '.vscode', 'coverage', '.next', '.gradle']);
const MAX_DEPTH = 3;
const MAX_ENTRIES = 5000;

// --- detection ----------------------------------------------------------------

// Relative paths (with /) of the files and folders near the top of the repo.
function listFiles(root) {
  const files = [];
  const dirs = [];
  // Old .NET repos keep restored packages in packages/; JavaScript monorepos
  // keep their code there. Skip it only for .NET.
  let rootNames = [];
  try {
    rootNames = fs.readdirSync(root);
  } catch { /* empty result */ }
  const skipPackages = rootNames.some((name) => /\.sln$/i.test(name));

  const walk = (dir, depth) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length + dirs.length >= MAX_ENTRIES) return;
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full).split(path.sep).join('/');
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || (skipPackages && entry.name === 'packages')) continue;
        dirs.push(rel);
        if (depth < MAX_DEPTH) walk(full, depth + 1);
      } else if (entry.isFile()) {
        files.push(rel);
      }
    }
  };
  walk(root, 1);
  return { files, dirs };
}

function readText(root, rel) {
  try {
    return fs.readFileSync(path.join(root, rel), 'utf8');
  } catch {
    return '';
  }
}

function readJson(root, rel) {
  try {
    return JSON.parse(readText(root, rel));
  } catch {
    return null;
  }
}

const add = (list, value) => {
  if (value && !list.includes(value)) list.push(value);
};

// "npm test", or "npm test (in frontend/)" when the project is in a subfolder.
const inFolder = (command, dir) => (dir ? `${command} (in ${dir}/)` : command);
const folderOf = (rel) => (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '');
const baseName = (rel) => rel.slice(rel.lastIndexOf('/') + 1);

// Library names → labels, per ecosystem.
const NPM_FRAMEWORKS = {
  react: 'React', vue: 'Vue', '@angular/core': 'Angular', svelte: 'Svelte', next: 'Next.js', nuxt: 'Nuxt',
  express: 'Express', fastify: 'Fastify', '@nestjs/core': 'NestJS', koa: 'Koa', vite: 'Vite',
  prisma: 'Prisma', typeorm: 'TypeORM', sequelize: 'Sequelize', mongoose: 'Mongoose', 'drizzle-orm': 'Drizzle',
};
const NPM_TESTS = { jest: 'Jest', vitest: 'Vitest', mocha: 'Mocha', '@playwright/test': 'Playwright', cypress: 'Cypress' };
const NPM_LINT = { eslint: 'ESLint', prettier: 'Prettier', '@biomejs/biome': 'Biome' };
const PY_FRAMEWORKS = { django: 'Django', flask: 'Flask', fastapi: 'FastAPI', sqlalchemy: 'SQLAlchemy', celery: 'Celery', alembic: 'Alembic' };
const PY_TESTS = { pytest: 'pytest' };
const PY_LINT = { ruff: 'Ruff', black: 'Black', mypy: 'mypy' };
const DOTNET_FRAMEWORKS = [
  [/^Microsoft\.AspNetCore/i, 'ASP.NET Core'], [/^Microsoft\.EntityFrameworkCore/i, 'EF Core'],
  [/^Dapper$/i, 'Dapper'], [/^MediatR$/i, 'MediatR'], [/^FluentValidation/i, 'FluentValidation'],
  [/^Serilog/i, 'Serilog'], [/^MassTransit/i, 'MassTransit'],
];
const DOTNET_TESTS = [
  [/^xunit/i, 'xUnit'], [/^NUnit/i, 'NUnit'], [/^MSTest/i, 'MSTest'], [/^NSubstitute$/i, 'NSubstitute'], [/^Moq$/i, 'Moq'],
];

function detectDotnet(root, files, found) {
  const projects = files.filter((file) => /\.(csproj|fsproj|vbproj)$/i.test(file));
  if (!projects.length && !files.some((file) => /\.sln$/i.test(file))) return;
  for (const project of projects) {
    const text = readText(root, project);
    const target = text.match(/<TargetFrameworks?>([^<;]+)/i);
    const language = project.endsWith('.fsproj') ? 'F#' : project.endsWith('.vbproj') ? 'VB.NET' : 'C#';
    add(found.languages, target ? `${language} (${target[1].trim()})` : language);
    if (/Sdk="Microsoft\.NET\.Sdk\.Web"/i.test(text)) add(found.frameworks, 'ASP.NET Core');
    // Include can come before or after Version.
    for (const match of text.matchAll(/<PackageReference\b[^>]*?\bInclude="([^"]+)"/gi)) {
      for (const [pattern, label] of DOTNET_FRAMEWORKS) if (pattern.test(match[1])) add(found.frameworks, label);
      for (const [pattern, label] of DOTNET_TESTS) if (pattern.test(match[1])) add(found.test_frameworks, label);
    }
    if (/\.Tests?$/i.test(baseName(project).replace(/\.\w+$/, ''))) add(found.test_folders, folderOf(project));
  }
  if (!found.languages.some((language) => /^(C#|F#|VB\.NET)/.test(language))) add(found.languages, 'C#');
  add(found.package_managers, 'NuGet');
  add(found.commands.build, 'dotnet build');
  add(found.commands.test, 'dotnet test');
  add(found.commands.format, 'dotnet format');
  add(found.vulnerability_scan, 'dotnet list package --vulnerable --include-transitive');
}

// Every package.json near the top: the repo root, or a frontend/ folder, etc.
function detectNode(root, files, found) {
  for (const manifest of files.filter((file) => baseName(file) === 'package.json')) {
    const pkg = readJson(root, manifest);
    if (!pkg) continue;
    const dir = folderOf(manifest);
    const near = (name) => files.includes(dir ? `${dir}/${name}` : name);
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    add(found.languages, deps.typescript || near('tsconfig.json') ? 'TypeScript' : 'JavaScript');
    for (const [name, label] of Object.entries(NPM_FRAMEWORKS)) if (deps[name]) add(found.frameworks, label);
    for (const [name, label] of Object.entries(NPM_TESTS)) if (deps[name]) add(found.test_frameworks, label);
    for (const [name, label] of Object.entries(NPM_LINT)) if (deps[name]) add(found.lint_format, label);

    const manager = near('pnpm-lock.yaml') ? 'pnpm' : near('yarn.lock') ? 'yarn'
      : near('bun.lock') || near('bun.lockb') ? 'bun' : 'npm';
    add(found.package_managers, manager);
    const run = (script) => inFolder(manager === 'npm' && script !== 'test' ? `npm run ${script}` : `${manager} ${script}`, dir);
    const scripts = pkg.scripts || {};
    for (const script of ['build', 'test', 'lint', 'format']) {
      if (scripts[script]) add(found.commands[script], run(script));
    }
    add(found.vulnerability_scan, inFolder(manager === 'bun' ? 'npm audit' : `${manager} audit`, dir));
  }
}

function detectPython(root, files, found) {
  const manifests = files.filter((file) => /^(pyproject\.toml|setup\.py|requirements[\w.-]*\.txt)$/i.test(baseName(file)));
  const dirs = [...new Set(manifests.map(folderOf))];
  for (const dir of dirs) {
    const inDir = manifests.filter((file) => folderOf(file) === dir);
    const pyproject = inDir.find((file) => baseName(file) === 'pyproject.toml');
    const pyprojectText = pyproject ? readText(root, pyproject) : '';
    const text = inDir.map((file) => readText(root, file)).join('\n').toLowerCase();
    const near = (name) => files.includes(dir ? `${dir}/${name}` : name);

    const version = pyprojectText.match(/requires-python\s*=\s*"([^"]+)"/);
    add(found.languages, version ? `Python (${version[1]})` : 'Python');
    const mentions = (name) => new RegExp(`(^|[^\\w-])${name}([^\\w-]|$)`, 'm').test(text);
    for (const [name, label] of Object.entries(PY_FRAMEWORKS)) if (mentions(name)) add(found.frameworks, label);
    for (const [name, label] of Object.entries(PY_TESTS)) if (mentions(name)) add(found.test_frameworks, label);
    for (const [name, label] of Object.entries(PY_LINT)) if (mentions(name)) add(found.lint_format, label);
    add(found.package_managers, near('uv.lock') ? 'uv' : near('poetry.lock') ? 'Poetry' : 'pip');
    if (found.test_frameworks.includes('pytest')) add(found.commands.test, inFolder('pytest', dir));
    add(found.vulnerability_scan, inFolder('pip-audit', dir));
  }
}

function detectJvm(root, files, found) {
  const hasKotlin = files.some((file) => /\.kt$/.test(file));
  for (const pom of files.filter((file) => baseName(file) === 'pom.xml')) {
    const dir = folderOf(pom);
    add(found.languages, hasKotlin ? 'Kotlin' : 'Java');
    add(found.package_managers, 'Maven');
    add(found.commands.build, inFolder('mvn package', dir));
    add(found.commands.test, inFolder('mvn test', dir));
    if (/spring-boot/.test(readText(root, pom))) add(found.frameworks, 'Spring Boot');
  }
  for (const gradle of files.filter((file) => /^build\.gradle(\.kts)?$/.test(baseName(file)))) {
    const dir = folderOf(gradle);
    // build.gradle.kts is Gradle's Kotlin syntax, not a sign the code is Kotlin.
    add(found.languages, hasKotlin ? 'Kotlin' : 'Java');
    add(found.package_managers, 'Gradle');
    const gradlew = files.includes(dir ? `${dir}/gradlew` : 'gradlew') ? './gradlew' : 'gradle';
    add(found.commands.build, inFolder(`${gradlew} build`, dir));
    add(found.commands.test, inFolder(`${gradlew} test`, dir));
    if (/spring/.test(readText(root, gradle))) add(found.frameworks, 'Spring Boot');
  }
}

function detectOthers(root, files, found) {
  for (const manifest of files.filter((file) => baseName(file) === 'composer.json')) {
    const composer = readJson(root, manifest);
    if (!composer) continue;
    add(found.languages, 'PHP');
    add(found.package_managers, 'Composer');
    const deps = { ...(composer.require || {}), ...(composer['require-dev'] || {}) };
    if (deps['laravel/framework']) add(found.frameworks, 'Laravel');
    if (Object.keys(deps).some((name) => name.startsWith('symfony/'))) add(found.frameworks, 'Symfony');
    if (deps['phpunit/phpunit']) add(found.test_frameworks, 'PHPUnit');
    add(found.vulnerability_scan, inFolder('composer audit', folderOf(manifest)));
  }
  for (const manifest of files.filter((file) => baseName(file) === 'go.mod')) {
    const dir = folderOf(manifest);
    const version = readText(root, manifest).match(/^go\s+(\S+)/m);
    add(found.languages, version ? `Go (${version[1]})` : 'Go');
    add(found.commands.build, inFolder('go build ./...', dir));
    add(found.commands.test, inFolder('go test ./...', dir));
    add(found.vulnerability_scan, inFolder('govulncheck ./...', dir));
  }
  for (const manifest of files.filter((file) => baseName(file) === 'Cargo.toml')) {
    const dir = folderOf(manifest);
    add(found.languages, 'Rust');
    add(found.package_managers, 'Cargo');
    add(found.commands.build, inFolder('cargo build', dir));
    add(found.commands.test, inFolder('cargo test', dir));
    add(found.vulnerability_scan, inFolder('cargo audit', dir));
  }
  for (const manifest of files.filter((file) => baseName(file) === 'Gemfile')) {
    add(found.languages, 'Ruby');
    add(found.package_managers, 'Bundler');
    if (/['"]rails['"]/.test(readText(root, manifest))) add(found.frameworks, 'Rails');
    add(found.vulnerability_scan, inFolder('bundle audit', folderOf(manifest)));
  }
}

const LINT_FILES = [
  [/^\.editorconfig$/, 'EditorConfig'], [/^(\.eslintrc(\.\w+)?|eslint\.config\.\w+)$/, 'ESLint'],
  [/^(\.prettierrc(\.\w+)?|prettier\.config\.\w+)$/, 'Prettier'], [/^biome\.jsonc?$/, 'Biome'],
  [/^\.?ruff\.toml$/, 'Ruff'], [/^\.rubocop\.yml$/, 'RuboCop'],
  [/^\.golangci\.ya?ml$/, 'golangci-lint'], [/^stylecop\.json$/i, 'StyleCop'], [/^\.stylelintrc/, 'Stylelint'],
];

// Azure Pipelines files have no fixed name or folder, so recognise them by
// their content: pipeline keys at the top level, or task steps (Name@N).
function isAzurePipeline(text) {
  if (/^on:/m.test(text) && /runs-on:/.test(text)) return false; // GitHub Actions
  const keys = (text.match(/^(trigger|pr|pool|stages|jobs|steps|extends|schedules):/gm) || []).length;
  return keys >= 2 || /^\s*-?\s*task:\s*[\w.-]+@\d+/m.test(text);
}

function detectTooling(root, files, dirs, found) {
  for (const file of files) {
    const name = baseName(file);
    // Root config, or the config next to a project in a subfolder.
    for (const [pattern, label] of LINT_FILES) if (pattern.test(name)) add(found.lint_format, label);
  }
  for (const file of files.filter((candidate) => baseName(candidate) === 'pyproject.toml')) {
    if (/\[tool\.ruff\]/.test(readText(root, file))) add(found.lint_format, 'Ruff');
  }

  if (files.some((file) => file.startsWith('.github/workflows/'))) add(found.ci, 'GitHub Actions');
  if (files.includes('.gitlab-ci.yml')) add(found.ci, 'GitLab CI');
  if (files.includes('Jenkinsfile')) add(found.ci, 'Jenkins');
  const yamlFiles = files.filter((file) => /\.ya?ml$/i.test(file) && !file.startsWith('.github/')
    && !/(^|\/)(docker-)?compose[\w.-]*\.ya?ml$/i.test(file));
  if (yamlFiles.some((file) => /^azure-pipelines/i.test(baseName(file)) || isAzurePipeline(readText(root, file)))) {
    add(found.ci, 'Azure Pipelines');
  }

  if (files.some((file) => baseName(file) === 'Dockerfile' || /\.Dockerfile$/i.test(file))) add(found.containers, 'Docker');
  if (files.some((file) => /^(docker-)?compose(\.[\w-]+)?\.ya?ml$/.test(baseName(file)))) add(found.containers, 'Docker Compose');

  for (const dir of dirs) {
    if (/(^|\/)(tests?|__tests__|spec)$/i.test(dir)) add(found.test_folders, dir);
  }
  found.adr_folder = ['docs/adr', 'docs/adrs', 'doc/adr', 'adr', 'docs/decisions', 'docs/architecture/decisions']
    .find((dir) => dirs.includes(dir)) || null;
}

// What can be read from the repo's files. Init shows it and the user
// confirms or corrects it. Everything here is a suggestion.
function detect(repoPath) {
  const root = path.resolve(paths.expandTilde(repoPath));
  const { files, dirs } = listFiles(root);
  const found = {
    path: root,
    name: path.basename(root),
    languages: [],
    frameworks: [],
    test_frameworks: [],
    package_managers: [],
    commands: { build: [], test: [], lint: [], format: [] },
    vulnerability_scan: [],
    lint_format: [],
    ci: [],
    containers: [],
    test_folders: [],
    adr_folder: null,
    commit_convention: null,
  };
  detectDotnet(root, files, found);
  detectNode(root, files, found);
  detectPython(root, files, found);
  detectJvm(root, files, found);
  detectOthers(root, files, found);
  detectTooling(root, files, dirs, found);
  found.commit_convention = detectCommitConvention(root, files);
  return found;
}

// Conventional Commits if the repo says so, or most recent commits follow it.
function detectCommitConvention(root, files) {
  if (files.some((file) => /^(\.commitlintrc(\.\w+)?|commitlint\.config\.\w+)$/.test(file))) return 'Conventional Commits (commitlint)';
  const subjects = outputLines(git(root, ['log', '-30', '--format=%s']));
  const conventional = subjects.filter((subject) => /^(feat|fix|chore|docs|refactor|test|perf|build|ci|style|revert)(\([^)]*\))?!?: /.test(subject));
  return subjects.length >= 5 && conventional.length / subjects.length >= 0.6 ? 'Conventional Commits' : null;
}

// --- stack.md -----------------------------------------------------------------

// Splits stack.md into its "## " sections: { name → text }.
function parse(text) {
  const sections = {};
  let current = null;
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    const heading = line.match(/^##\s+(.+?)\s*$/);
    if (heading) {
      current = heading[1];
      sections[current] = [];
    } else if (current) {
      sections[current].push(line);
    }
  }
  return Object.fromEntries(Object.entries(sections).map(([name, lines]) => [name, lines.join('\n').trim()]));
}

// The section's text ('' when empty), or null when there's no such section.
const findSection = (sections, name) => {
  const key = Object.keys(sections).find((section) => config.sameName(section, name));
  return key === undefined ? null : sections[key];
};

function readStack() {
  try {
    return fs.readFileSync(paths.all().stack, 'utf8');
  } catch {
    return null;
  }
}

// The notes for one repo (its label, "Shop/api"): Common, that repo's
// section, then the generic defaults.
function forRepo(repoName) {
  const text = readStack();
  const sections = text ? parse(text) : {};
  const common = findSection(sections, 'Common');
  const repo = repoName ? findSection(sections, repoName) : null;
  const parts = ['# Stack'];
  if (common) parts.push(`## Common\n${common}`);
  if (repo) parts.push(`## ${repoName}\n${repo}`);
  if (!common && !repo) parts.push('(No notes in ~/.spadework/stack.md for this repo. Follow the repo\'s own patterns.)');
  // A broken install shouldn't stop a triage: the generic notes are a bonus.
  try {
    parts.push(fs.readFileSync(GENERIC_FILE, 'utf8').trim());
  } catch {
    parts.push('(Spadework\'s generic engineering notes are missing. Reinstall the plugin to get them back.)');
  }
  return { repo: repoName || null, has_common: Boolean(common), has_repo_section: Boolean(repo), text: parts.join('\n\n') + '\n' };
}

// The repo's ADR folder, relative to the repo: the "- ADRs: <folder>" line of
// the repo's section in stack.md (its label, "Shop/api"), then of the Common
// section, else DEFAULT_ADR_FOLDER. Returns { folder }, or { error } for a
// folder that isn't relative or leaves the repo.
const DEFAULT_ADR_FOLDER = 'docs/adr';
function adrFolder(label) {
  const text = readStack();
  const sections = text ? parse(text) : {};
  const lineOf = (name) => {
    const section = name ? findSection(sections, name) : null;
    const line = section ? section.split('\n').map((each) => each.match(/^\s*[-*]\s*ADRs:\s*(.+?)\s*$/i)).find(Boolean) : null;
    return line ? line[1].replace(/^[`'"]+|[`'"]+$/g, '') : null;
  };
  const value = lineOf(label) || lineOf('Common');
  if (!value) return { folder: DEFAULT_ADR_FOLDER };
  const folder = value.replace(/\\/g, '/').replace(/\/+$/, '');
  if (!folder || path.isAbsolute(folder) || /^[a-z]:/i.test(folder) || folder.startsWith('~') || folder.split('/').some((part) => part === '..')) {
    return { error: `The ADR folder in stack.md (${value}) must be a folder inside the repo, like docs/adr.` };
  }
  return { folder: folder.replace(/^\.\//, '') || '.' };
}

// The configured repo a folder belongs to (the folder itself, inside it, or one
// of its "<repo>--<ID>" worktrees), with `top`, the top folder of the checkout
// the folder is in: { repo, top }. Null when it isn't one.
function repoInFolder(folder, repos) {
  const where = topLevel(folder) || path.resolve(folder);
  const repo = repos.find((each) => {
    if (samePath(where, each.path)) return true;
    // Worktrees are named after the local folder, which can differ from the repo name.
    const folderName = path.basename(each.path).toLowerCase();
    const isWorktree = path.basename(where).toLowerCase().startsWith(`${folderName}--`);
    return isWorktree && samePath(path.dirname(where), path.dirname(each.path));
  });
  return repo ? { repo, top: where } : null;
}

// The label of the configured repo a folder belongs to, or null.
function repoForFolder(folder) {
  const loaded = config.load({ checkPaths: false });
  const found = loaded.ok ? repoInFolder(folder, loaded.config.repos) : null;
  return found ? config.repoLabel(found.repo) : null;
}

function forFolder(folder = process.cwd()) {
  return forRepo(repoForFolder(folder));
}

// What is wrong with stack notes for these repos (labels, "Shop/api"): a
// Common section and one per repo are needed. Each problem names its
// section: { section, message }.
function check(text, repoNames = []) {
  const sections = parse(String(text));
  const errors = [];
  const warnings = [];
  for (const name of ['Common', ...repoNames]) {
    const section = findSection(sections, name);
    if (section === null) errors.push({ section: name, message: `missing ${name === 'Common' ? 'the' : 'a'} "## ${name}" section` });
    else if (section === '') warnings.push({ section: name, message: `the "## ${name}" section is empty` });
  }
  return { errors, warnings };
}

// Makes the text stack.md. The previous file is kept as stack.md.bak.
function write(text) {
  const dataPaths = paths.all();
  fs.mkdirSync(dataPaths.root, { recursive: true });
  if (fs.existsSync(dataPaths.stack)) fs.copyFileSync(dataPaths.stack, `${dataPaths.stack}.bak`);
  writeFileAtomic(dataPaths.stack, String(text).replace(/\r\n/g, '\n').trimEnd() + '\n');
  return dataPaths.stack;
}

// Checks the draft init wrote by hand and, if it's fine, makes it stack.md.
function save({ repoNames = [] } = {}) {
  const dataPaths = paths.all();
  let text;
  try {
    text = fs.readFileSync(dataPaths.stackDraft, 'utf8');
  } catch {
    return { ok: false, errors: [`no draft at ${dataPaths.stackDraft}`], warnings: [] };
  }
  const checked = check(text, repoNames);
  const errors = checked.errors.map((problem) => problem.message);
  const warnings = checked.warnings.map((problem) => problem.message);
  if (errors.length) return { ok: false, errors, warnings };
  const file = write(text);
  fs.rmSync(dataPaths.stackDraft, { force: true });
  return { ok: true, file, errors, warnings };
}

// What detect() found, as the lines of a repo's section in stack.md, one per
// point init asks about. Only what was found: the rest is the user's to add.
function detectedLines(found) {
  const lines = [];
  const line = (label, values) => {
    const list = (Array.isArray(values) ? values : [values]).filter(Boolean);
    if (list.length) lines.push(`- ${label}: ${list.join(', ')}`);
  };
  line('Languages', found.languages);
  line('Frameworks', found.frameworks);
  line('ADRs', found.adr_folder && `${found.adr_folder}/`);
  for (const [name, commands] of Object.entries(found.commands || {})) {
    line(`${name[0].toUpperCase()}${name.slice(1)}`, (commands || []).map((command) => `\`${command}\``));
  }
  line('Tests', found.test_frameworks);
  line('Tests live in', (found.test_folders || []).map((folder) => `${folder}/`));
  line('Package manager', found.package_managers);
  line('Vulnerability scan', (found.vulnerability_scan || []).map((command) => `\`${command}\``));
  line('Code style', found.lint_format);
  line('Git', found.commit_convention);
  line('CI', found.ci);
  line('Containers', found.containers);
  return lines;
}

module.exports = { detect, detectedLines, parse, forRepo, forFolder, repoForFolder, repoInFolder, adrFolder, DEFAULT_ADR_FOLDER, check, write, save, isAzurePipeline };
