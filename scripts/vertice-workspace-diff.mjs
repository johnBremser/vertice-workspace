import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const WORKSPACE_DIFF_PREFIX = '/__vertice_workspace/';
const GIT_TIMEOUT_MS = 8000;
const GIT_MAX_BUFFER_BYTES = 4 * 1024 * 1024;
const MAX_DIFF_LINES = 1500;
const MAX_DIFF_BYTES = 200 * 1024;
const MAX_UNTRACKED_COUNT_BYTES = 512 * 1024;
const MAX_FILES_LISTED = 200;
const MAX_FS_RECENT_FILES = 50;
const MAX_FS_WALK_DEPTH = 5;
const MAX_FS_WALK_ENTRIES = 2000;

const IGNORED_DIRS = new Set([
  'node_modules',
  'dist',
  '.git',
  '.vertice',
  'test-results',
  'playwright-report',
  '.vitest',
]);

const ALLOWED_DOT_EXAMPLES = new Set(['.env.example', '.env.sample', '.env.template']);
const SENSITIVE_EXACT_NAMES = new Set([
  '.env',
  '.npmrc',
  '.netrc',
  '.pypirc',
  '.htpasswd',
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
]);
const SENSITIVE_EXTENSIONS = new Set(['.pem', '.key', '.p12', '.pfx', '.jks', '.keystore']);
const SENSITIVE_BASENAME_RE = /(^|[._-])(secret|secrets|credential|credentials)([._-]|$)/i;

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

function isLoopbackRemoteAddress(remoteAddress) {
  if (!remoteAddress || typeof remoteAddress !== 'string') {
    return false;
  }
  const normalized = remoteAddress.trim().toLowerCase();
  return (
    normalized === '127.0.0.1' ||
    normalized === '::1' ||
    normalized === '::ffff:127.0.0.1' ||
    normalized.startsWith('127.') ||
    normalized.startsWith('::ffff:127.')
  );
}

function isWithinRoot(targetPath, rootPrefix, exactRoot) {
  if (process.platform === 'win32') {
    const t = targetPath.toLowerCase();
    const p = rootPrefix.toLowerCase();
    const r = exactRoot.toLowerCase();
    return t === r || t.startsWith(p);
  }
  return targetPath === exactRoot || targetPath.startsWith(pOrPrefix(rootPrefix));
}

function pOrPrefix(prefix) {
  return prefix;
}

function normalizeRelPath(rawPath) {
  return String(rawPath || '')
    .trim()
    .replaceAll('\\', '/')
    .replace(/^\/+/, '');
}

export function isSensitiveWorkspaceFile(rawRelPath) {
  const rel = normalizeRelPath(rawRelPath);
  if (!rel) return true;
  const parts = rel.split('/').filter(Boolean);
  if (parts.length === 0) return true;
  if (parts.some((part) => part === '.git')) {
    return true;
  }
  const base = parts[parts.length - 1].toLowerCase();
  if (ALLOWED_DOT_EXAMPLES.has(base)) {
    return false;
  }
  if (SENSITIVE_EXACT_NAMES.has(base) || base.startsWith('.env.')) {
    return true;
  }
  if (base.startsWith('id_rsa') || base.startsWith('id_ed25519')) {
    return true;
  }
  const ext = path.extname(base);
  if (SENSITIVE_EXTENSIONS.has(ext)) {
    return true;
  }
  if (SENSITIVE_BASENAME_RE.test(base)) {
    return true;
  }
  return false;
}

export function resolveAllowedWorkspaces(options = {}) {
  const rawList = [];
  if (Array.isArray(options.allowedWorkspaces)) {
    rawList.push(...options.allowedWorkspaces);
  } else {
    const envRaw =
      options.allowedWorkspacesEnv ??
      process.env.VERTICE_ALLOWED_WORKSPACES ??
      process.env.VERTICE_WORKSPACE_ROOT ??
      '';
    if (typeof envRaw === 'string' && envRaw.trim()) {
      for (const part of envRaw.split(path.delimiter)) {
        if (part.trim()) rawList.push(part.trim());
      }
    } else if (options.rootDir) {
      rawList.push(options.rootDir);
    } else {
      return null;
    }
  }

  const resolved = [];
  for (const candidate of rawList) {
    if (typeof candidate !== 'string' || !candidate.trim() || candidate.includes('\0')) {
      continue;
    }
    try {
      const real = fs.realpathSync(path.resolve(candidate.trim()));
      if (fs.statSync(real).isDirectory()) {
        resolved.push(real);
      }
    } catch {
      // Ignore unavailable candidate directories
    }
  }
  return Array.from(new Set(resolved));
}

export function resolveWorkspaceRoot(rawWorkspacePath, allowedWorkspaces = null) {
  const trimmed = String(rawWorkspacePath || '').trim();
  if (!trimmed || trimmed.includes('\0')) {
    return { ok: false, status: 400, error: 'Caminho do workspace ausente ou inválido.' };
  }
  const resolved = path.resolve(trimmed);
  if (!fs.existsSync(resolved)) {
    return { ok: false, status: 404, error: 'Diretório do workspace não encontrado.' };
  }
  let realRoot;
  let stat;
  try {
    realRoot = fs.realpathSync(resolved);
    stat = fs.statSync(realRoot);
  } catch {
    return { ok: false, status: 404, error: 'Falha ao acessar diretório do workspace.' };
  }
  if (!stat.isDirectory()) {
    return { ok: false, status: 400, error: 'O caminho informado não é um diretório.' };
  }
  if (Array.isArray(allowedWorkspaces)) {
    const allowed = allowedWorkspaces.some((allowedRoot) => {
      const prefix = allowedRoot.endsWith(path.sep) ? allowedRoot : allowedRoot + path.sep;
      return isWithinRoot(realRoot, prefix, allowedRoot);
    });
    if (!allowed) {
      return {
        ok: false,
        status: 403,
        error:
          'Diretório fora do projeto/workspace configurado no servidor. Defina VERTICE_ALLOWED_WORKSPACES no .env.local para autorizar esta pasta.',
      };
    }
  }
  return { ok: true, realRoot };
}

function inspectPathSensitivityAndEscape(realRoot, relPath) {
  const rootPrefix = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep;
  if (isSensitiveWorkspaceFile(relPath)) {
    return { escapesRoot: false, isSensitive: true };
  }
  const candidate = path.resolve(realRoot, relPath);
  if (!isWithinRoot(candidate, rootPrefix, realRoot)) {
    return { escapesRoot: true, isSensitive: true };
  }
  if (fs.existsSync(candidate)) {
    try {
      const realTarget = fs.realpathSync(candidate);
      if (!isWithinRoot(realTarget, rootPrefix, realRoot)) {
        return { escapesRoot: true, isSensitive: true };
      }
      const realRel = normalizeRelPath(path.relative(realRoot, realTarget));
      if (isSensitiveWorkspaceFile(realRel)) {
        return { escapesRoot: false, isSensitive: true };
      }
    } catch {
      return { escapesRoot: false, isSensitive: false };
    }
  }
  return { escapesRoot: false, isSensitive: false };
}

export function resolveWorkspaceFile(realRoot, rawRelPath) {
  const relPath = normalizeRelPath(rawRelPath);
  if (!relPath || relPath.includes('\0')) {
    return { ok: false, status: 400, error: 'Caminho de arquivo inválido.' };
  }
  if (relPath.endsWith('/')) {
    return {
      ok: false,
      status: 400,
      error: 'O alvo informado é um diretório; informe um único arquivo.',
    };
  }
  if (path.isAbsolute(rawRelPath) || /^[a-zA-Z]:/.test(relPath)) {
    return { ok: false, status: 403, error: 'Caminho absoluto fora do workspace recusado.' };
  }
  const parts = relPath.split('/').filter(Boolean);
  if (parts.length === 0 || parts.some((part) => part === '.' || part === '..')) {
    return { ok: false, status: 403, error: 'Navegação fora do workspace (..) recusada.' };
  }

  const rootPrefix = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep;
  const candidate = path.resolve(realRoot, relPath);
  if (!isWithinRoot(candidate, rootPrefix, realRoot) || candidate === realRoot) {
    return { ok: false, status: 403, error: 'Acesso fora do workspace recusado.' };
  }

  let realRelPath = '';
  if (fs.existsSync(candidate)) {
    let realTarget;
    let stat;
    try {
      realTarget = fs.realpathSync(candidate);
      stat = fs.statSync(realTarget);
    } catch {
      return { ok: false, status: 404, error: 'Falha ao resolver arquivo.' };
    }
    if (!isWithinRoot(realTarget, rootPrefix, realRoot)) {
      return { ok: false, status: 403, error: 'Symlink externo ao workspace recusado.' };
    }
    if (!stat.isFile()) {
      return {
        ok: false,
        status: 400,
        error: 'O alvo informado é um diretório; informe um único arquivo.',
      };
    }
    realRelPath = normalizeRelPath(path.relative(realRoot, realTarget));
  } else {
    // For deleted files, verify the nearest existing ancestor stays inside realRoot
    let parent = path.dirname(candidate);
    while (parent && parent.length >= realRoot.length && !fs.existsSync(parent)) {
      const next = path.dirname(parent);
      if (next === parent) break;
      parent = next;
    }
    if (fs.existsSync(parent)) {
      try {
        const realParent = fs.realpathSync(parent);
        if (!isWithinRoot(realParent, rootPrefix, realRoot)) {
          return { ok: false, status: 403, error: 'Symlink externo ao workspace recusado.' };
        }
      } catch {
        return { ok: false, status: 403, error: 'Caminho pai inválido.' };
      }
    }
  }

  if (
    isSensitiveWorkspaceFile(relPath) ||
    (realRelPath && isSensitiveWorkspaceFile(realRelPath))
  ) {
    return {
      ok: false,
      status: 403,
      error: 'Acesso ao conteúdo/diff de arquivo sensível bloqueado por segurança.',
    };
  }

  return { ok: true, relPath, fullPath: candidate };
}

function isBinaryBuffer(buf) {
  const sampleLen = Math.min(buf.length, 8192);
  for (let i = 0; i < sampleLen; i += 1) {
    if (buf[i] === 0) return true;
  }
  return false;
}

function inspectFileMetrics(fullPath) {
  try {
    const stat = fs.statSync(fullPath);
    if (!stat.isFile()) {
      return { isBinary: false, lineCount: null };
    }
    const fd = fs.openSync(fullPath, 'r');
    try {
      const sample = Buffer.alloc(Math.min(8192, stat.size));
      if (sample.length > 0) {
        fs.readSync(fd, sample, 0, sample.length, 0);
        if (isBinaryBuffer(sample)) {
          return { isBinary: true, lineCount: null };
        }
      }
    } finally {
      fs.closeSync(fd);
    }
    if (stat.size > MAX_UNTRACKED_COUNT_BYTES) {
      return { isBinary: false, lineCount: null };
    }
    const text = fs.readFileSync(fullPath, 'utf8');
    if (text.length === 0) {
      return { isBinary: false, lineCount: 0 };
    }
    const lines = text.split(/\r?\n/);
    const count = lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
    return { isBinary: false, lineCount: count };
  } catch {
    return { isBinary: false, lineCount: null };
  }
}

async function runGit(realRoot, args) {
  const { stdout } = await execFileAsync(
    'git',
    ['-C', realRoot, '--literal-pathspecs', '-c', 'core.quotepath=false', ...args],
    {
      shell: false,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER_BYTES,
      encoding: 'utf8',
      windowsHide: true,
    },
  );
  return stdout;
}

async function isGitWorkTree(realRoot) {
  try {
    const out = await runGit(realRoot, ['rev-parse', '--is-inside-work-tree']);
    return out.trim() === 'true';
  } catch {
    return false;
  }
}

async function hasGitHead(realRoot) {
  try {
    await runGit(realRoot, ['rev-parse', '--verify', 'HEAD']);
    return true;
  } catch {
    return false;
  }
}

async function getGitHeadObjectType(realRoot, repoRelPath) {
  try {
    const out = await runGit(realRoot, ['cat-file', '-t', `HEAD:${repoRelPath}`]);
    return out.trim();
  } catch {
    return null;
  }
}

async function hasGitIndexDirectoryChildren(realRoot, relPath, gitPrefix) {
  try {
    const raw = await runGit(realRoot, ['ls-files', '-z', '--', relPath]);
    if (!raw) return false;
    const prefix = `${relPath}/`;
    const prefixLower = prefix.toLowerCase();
    for (const token of raw.split('\0')) {
      if (!token) continue;
      const localPath = stripGitPrefix(token, gitPrefix);
      if (!localPath) continue;
      if (
        localPath.startsWith(prefix) ||
        (process.platform === 'win32' && localPath.toLowerCase().startsWith(prefixLower))
      ) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

function filterUnifiedDiffToSinglePath(rawDiff, expectedRepoRelPath) {
  const text = String(rawDiff || '');
  if (!text.trim()) return '';
  const expectedA = `a/${expectedRepoRelPath}`;
  const expectedB = `b/${expectedRepoRelPath}`;
  const expectedUnquoted = `diff --git ${expectedA} ${expectedB}`;
  const expectedQuoted = `diff --git "${expectedA}" "${expectedB}"`;

  const lines = text.split(/\r?\n/);
  const kept = [];
  let includeSection = false;

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      const matches =
        line === expectedUnquoted ||
        line === expectedQuoted ||
        (process.platform === 'win32' &&
          (line.toLowerCase() === expectedUnquoted.toLowerCase() ||
            line.toLowerCase() === expectedQuoted.toLowerCase()));
      includeSection = matches;
    }
    if (includeSection) {
      kept.push(line);
    }
  }
  return kept.join('\n').trim();
}

async function getGitBranch(realRoot) {
  try {
    const branch = (await runGit(realRoot, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    return branch || 'HEAD';
  } catch {
    return 'sem-commit';
  }
}

async function getGitPrefix(realRoot) {
  try {
    const raw = await runGit(realRoot, ['rev-parse', '--show-prefix']);
    const normalized = normalizeRelPath(raw.replace(/[\r\n]+/g, ''));
    if (!normalized) return '';
    return normalized.endsWith('/') ? normalized : `${normalized}/`;
  } catch {
    return '';
  }
}

function stripGitPrefix(repoRelPath, gitPrefix) {
  const normalized = normalizeRelPath(repoRelPath);
  if (!normalized) return null;
  if (!gitPrefix) return normalized;
  if (normalized.startsWith(gitPrefix)) {
    return normalized.slice(gitPrefix.length);
  }
  if (
    process.platform === 'win32' &&
    normalized.toLowerCase().startsWith(gitPrefix.toLowerCase())
  ) {
    return normalized.slice(gitPrefix.length);
  }
  return null;
}

function parseGitNumstatZ(rawOutput, map, gitPrefix = '') {
  if (!rawOutput) return;
  const tokens = rawOutput.split('\0');
  let i = 0;
  while (i < tokens.length) {
    const tok = tokens[i];
    i += 1;
    if (!tok) continue;
    const firstTab = tok.indexOf('\t');
    const secondTab = firstTab >= 0 ? tok.indexOf('\t', firstTab + 1) : -1;
    if (firstTab < 0 || secondTab < 0) continue;

    const addStr = tok.slice(0, firstTab);
    const delStr = tok.slice(firstTab + 1, secondTab);
    let filePath = tok.slice(secondTab + 1);

    // Rename/copy with -z puts empty path after second tab, then oldPath\0newPath\0
    if (!filePath && i + 1 < tokens.length) {
      i += 1; // skip oldPath
      filePath = tokens[i] || '';
      i += 1;
    }
    if (!filePath) continue;

    const localPath = stripGitPrefix(filePath, gitPrefix);
    if (!localPath) continue;
    const prev = map.get(localPath) ?? { additions: 0, deletions: 0, isBinary: false };
    if (addStr === '-' || delStr === '-') {
      prev.isBinary = true;
    } else {
      prev.additions += Number.parseInt(addStr, 10) || 0;
      prev.deletions += Number.parseInt(delStr, 10) || 0;
    }
    map.set(localPath, prev);
  }
}

function mapPorcelainStatus(xy) {
  const x = xy[0] ?? ' ';
  const y = xy[1] ?? ' ';
  if (xy === '??') return 'untracked';
  if (x === 'R' || y === 'R') return 'renamed';
  if (x === 'D' || y === 'D') return 'deleted';
  if (x === 'A' || y === 'A' || x === 'C' || y === 'C') return 'added';
  return 'modified';
}

function parseGitPorcelainZ(rawOutput, gitPrefix = '') {
  if (!rawOutput) return [];
  const tokens = rawOutput.split('\0');
  const entries = [];
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i];
    i += 1;
    if (!token || token.length < 4 || token[2] !== ' ') continue;
    const xy = token.slice(0, 2);
    const rawFilePath = token.slice(3);
    const x = xy[0];
    const y = xy[1];
    let rawPrevPath;
    if ((x === 'R' || x === 'C' || y === 'R' || y === 'C') && i < tokens.length) {
      rawPrevPath = tokens[i];
      i += 1;
    }
    const localPath = stripGitPrefix(rawFilePath, gitPrefix);
    if (!localPath) continue;
    const localPrevPath = rawPrevPath ? stripGitPrefix(rawPrevPath, gitPrefix) ?? undefined : undefined;
    entries.push({
      path: localPath,
      previousPath: localPrevPath,
      status: mapPorcelainStatus(xy),
    });
  }
  return entries;
}

function listRecentFilesFallback(realRoot) {
  const rootPrefix = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep;
  const results = [];
  let visited = 0;

  const walk = (dirPath, relPrefix, depth) => {
    if (depth > MAX_FS_WALK_DEPTH || visited >= MAX_FS_WALK_ENTRIES) return;
    let entries;
    try {
      entries = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (visited >= MAX_FS_WALK_ENTRIES) break;
      visited += 1;
      if (IGNORED_DIRS.has(entry.name)) continue;

      const nextRel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      const abs = path.join(dirPath, entry.name);
      let realAbs;
      try {
        realAbs = fs.realpathSync(abs);
      } catch {
        continue;
      }
      if (!isWithinRoot(realAbs, rootPrefix, realRoot)) {
        continue;
      }
      if (entry.isDirectory()) {
        walk(realAbs, nextRel, depth + 1);
      } else if (entry.isFile()) {
        try {
          const stat = fs.statSync(realAbs);
          const realRel = normalizeRelPath(path.relative(realRoot, realAbs));
          results.push({
            path: nextRel,
            status: 'modified',
            additions: null,
            deletions: null,
            isSensitive:
              isSensitiveWorkspaceFile(nextRel) ||
              isSensitiveWorkspaceFile(realRel),
            isBinary: false,
            updatedAt: new Date(stat.mtimeMs).toISOString(),
            sizeBytes: stat.size,
            _mtimeMs: stat.mtimeMs,
          });
        } catch {
          // Ignore transient files
        }
      }
    }
  };

  walk(realRoot, '', 0);
  results.sort((a, b) => b._mtimeMs - a._mtimeMs);
  const sliced = results.slice(0, MAX_FS_RECENT_FILES).map(({ _mtimeMs, ...rest }) => rest);
  return {
    files: sliced,
    totalCount: results.length,
    truncated: results.length > MAX_FS_RECENT_FILES,
  };
}

function clampDiffOutput(rawText) {
  const normalized = String(rawText || '');
  if (!normalized) {
    return { diff: '', lineCount: 0, truncated: false };
  }
  const lines = normalized.split(/\r?\n/);
  const selected = [];
  let bytes = 0;
  let truncated = false;

  for (const line of lines) {
    if (selected.length >= MAX_DIFF_LINES) {
      truncated = true;
      break;
    }
    const lineBytes = Buffer.byteLength(line, 'utf8') + 1;
    if (selected.length > 0 && bytes + lineBytes > MAX_DIFF_BYTES) {
      truncated = true;
      break;
    }
    selected.push(line);
    bytes += lineBytes;
  }

  return {
    diff: selected.join('\n'),
    lineCount: selected.length,
    truncated,
  };
}

function buildUntrackedUnifiedDiff(relPath, fullPath) {
  if (!fs.existsSync(fullPath)) {
    return { isBinary: false, diff: '', lineCount: 0, truncated: false };
  }
  const stat = fs.statSync(fullPath);
  if (!stat.isFile()) {
    return { isBinary: false, diff: '', lineCount: 0, truncated: false };
  }
  const buf = fs.readFileSync(fullPath);
  if (isBinaryBuffer(buf)) {
    return { isBinary: true, diff: '', lineCount: 0, truncated: false };
  }
  const rawText = buf.toString('utf8');
  const rawLines = rawText.length === 0 ? [] : rawText.split(/\r?\n/);
  if (rawLines.length > 0 && rawLines[rawLines.length - 1] === '') {
    rawLines.pop();
  }
  const header = [
    `diff --git a/${relPath} b/${relPath}`,
    'new file mode 100644',
    '--- /dev/null',
    `+++ b/${relPath}`,
    `@@ -0,0 +1,${rawLines.length} @@`,
  ];
  const body = rawLines.map((line) => `+${line}`);
  const clamped = clampDiffOutput([...header, ...body].join('\n'));
  return { isBinary: false, ...clamped };
}

export async function getWorkspaceChanges(workspaceDir, options = {}) {
  const allowedWorkspaces = Array.isArray(options.allowedWorkspaces)
    ? options.allowedWorkspaces
    : null;
  const rootCheck = resolveWorkspaceRoot(workspaceDir, allowedWorkspaces);
  if (!rootCheck.ok) {
    return rootCheck;
  }
  const { realRoot } = rootCheck;
  const gitRepo = await isGitWorkTree(realRoot);

  if (!gitRepo) {
    const fallback = listRecentFilesFallback(realRoot);
    return {
      ok: true,
      status: 200,
      mode: 'filesystem_recent',
      workspace: realRoot,
      files: fallback.files,
      totalCount: fallback.totalCount,
      truncated: fallback.truncated,
    };
  }

  const [branch, gitPrefix, porcelainRaw, unstagedNumstatRaw, stagedNumstatRaw] =
    await Promise.all([
      getGitBranch(realRoot),
      getGitPrefix(realRoot),
      runGit(realRoot, ['status', '--porcelain=v1', '-uall', '-z', '--', '.']),
      runGit(realRoot, ['diff', '--numstat', '-z', '--', '.']),
      runGit(realRoot, ['diff', '--cached', '--numstat', '-z', '--', '.']),
    ]);

  const numstatMap = new Map();
  parseGitNumstatZ(unstagedNumstatRaw, numstatMap, gitPrefix);
  parseGitNumstatZ(stagedNumstatRaw, numstatMap, gitPrefix);

  const parsedEntries = parseGitPorcelainZ(porcelainRaw, gitPrefix);
  const files = parsedEntries
    .slice(0, MAX_FILES_LISTED)
    .map((entry) => {
      const check = inspectPathSensitivityAndEscape(realRoot, entry.path);
      if (check.escapesRoot) {
        return null;
      }
      const sensitive = check.isSensitive;
      if (entry.status === 'untracked') {
        if (sensitive) {
          return {
            path: entry.path,
            status: 'untracked',
            additions: null,
            deletions: null,
            isSensitive: true,
            isBinary: false,
          };
        }
        const metrics = inspectFileMetrics(path.join(realRoot, entry.path));
        return {
          path: entry.path,
          status: 'untracked',
          additions: metrics.isBinary ? null : metrics.lineCount,
          deletions: 0,
          isSensitive: false,
          isBinary: metrics.isBinary,
        };
      }

      const statInfo = numstatMap.get(entry.path);
      return {
        path: entry.path,
        previousPath: entry.previousPath,
        status: entry.status,
        additions: statInfo?.isBinary ? null : (statInfo?.additions ?? null),
        deletions: statInfo?.isBinary ? null : (statInfo?.deletions ?? null),
        isSensitive: sensitive,
        isBinary: Boolean(statInfo?.isBinary),
      };
    })
    .filter(Boolean);

  return {
    ok: true,
    status: 200,
    mode: 'git',
    workspace: realRoot,
    branch,
    files,
    totalCount: parsedEntries.length,
    truncated: parsedEntries.length > MAX_FILES_LISTED,
  };
}

export async function getWorkspaceFileDiff(workspaceDir, relFilePath, options = {}) {
  const allowedWorkspaces = Array.isArray(options.allowedWorkspaces)
    ? options.allowedWorkspaces
    : null;
  const rootCheck = resolveWorkspaceRoot(workspaceDir, allowedWorkspaces);
  if (!rootCheck.ok) {
    return rootCheck;
  }
  const { realRoot } = rootCheck;

  const fileCheck = resolveWorkspaceFile(realRoot, relFilePath);
  if (!fileCheck.ok) {
    return fileCheck;
  }
  const { relPath, fullPath } = fileCheck;
  const gitRepo = await isGitWorkTree(realRoot);

  if (!gitRepo) {
    if (!fs.existsSync(fullPath)) {
      return { ok: false, status: 404, error: 'Arquivo não encontrado no workspace.' };
    }
    const buf = fs.readFileSync(fullPath);
    if (isBinaryBuffer(buf)) {
      return {
        ok: true,
        status: 200,
        mode: 'filesystem_recent',
        path: relPath,
        isBinary: true,
        isFullFilePreview: true,
        diff: '',
        lineCount: 0,
        truncated: false,
      };
    }
    const clamped = clampDiffOutput(buf.toString('utf8'));
    return {
      ok: true,
      status: 200,
      mode: 'filesystem_recent',
      path: relPath,
      isBinary: false,
      isFullFilePreview: true,
      ...clamped,
    };
  }

  const [gitPrefix, porcelain] = await Promise.all([
    getGitPrefix(realRoot),
    runGit(realRoot, [
      'status',
      '--porcelain=v1',
      '-uall',
      '-z',
      '--',
      relPath,
    ]),
  ]);
  const entries = parseGitPorcelainZ(porcelain, gitPrefix);
  // If path does not exist on disk and Git matched child paths (deleted directory), reject as directory
  if (
    !fs.existsSync(fullPath) &&
    (entries.length > 1 || (entries.length === 1 && entries[0].path !== relPath))
  ) {
    return {
      ok: false,
      status: 400,
      error: 'O alvo informado corresponde a um diretório; informe um único arquivo.',
    };
  }
  const entry = entries[0];

  if (entry?.status === 'untracked') {
    const synthetic = buildUntrackedUnifiedDiff(relPath, fullPath);
    return {
      ok: true,
      status: 200,
      mode: 'git',
      path: relPath,
      fileStatus: 'untracked',
      isFullFilePreview: false,
      ...synthetic,
    };
  }

  if (fs.existsSync(fullPath) && entry?.status !== 'deleted') {
    try {
      const fd = fs.openSync(fullPath, 'r');
      try {
        const stat = fs.fstatSync(fd);
        const sample = Buffer.alloc(Math.min(8192, stat.size));
        if (sample.length > 0) {
          fs.readSync(fd, sample, 0, sample.length, 0);
          if (isBinaryBuffer(sample)) {
            return {
              ok: true,
              status: 200,
              mode: 'git',
              path: relPath,
              fileStatus: entry?.status ?? 'modified',
              isBinary: true,
              isFullFilePreview: false,
              diff: '',
              lineCount: 0,
              truncated: false,
            };
          }
        }
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      // Fall through to git diff
    }
  }

  const hasHead = await hasGitHead(realRoot);
  const repoRelPath = gitPrefix ? `${gitPrefix}${relPath}` : relPath;
  const [headObjectType, indexHasDirChildren] = await Promise.all([
    hasHead ? getGitHeadObjectType(realRoot, repoRelPath) : Promise.resolve(null),
    hasGitIndexDirectoryChildren(realRoot, relPath, gitPrefix),
  ]);

  if (headObjectType === 'tree' || indexHasDirChildren) {
    if (!fs.existsSync(fullPath)) {
      return {
        ok: false,
        status: 400,
        error: 'O alvo informado corresponde a um diretório; informe um único arquivo.',
      };
    }
    // Path was a directory in HEAD or in the Git index (including unborn repos without a first commit)
    // and is now a regular file on disk: never run `git diff` against the old directory tree;
    // return only the literal diff of the authorized file itself.
    const synthetic = buildUntrackedUnifiedDiff(relPath, fullPath);
    return {
      ok: true,
      status: 200,
      mode: 'git',
      path: relPath,
      fileStatus: 'added',
      isFullFilePreview: false,
      ...synthetic,
    };
  }

  let diffOutput = '';
  if (hasHead) {
    diffOutput = await runGit(realRoot, [
      'diff',
      '--no-color',
      '--no-renames',
      'HEAD',
      '--',
      relPath,
    ]);
  } else {
    const [unstaged, staged] = await Promise.all([
      runGit(realRoot, ['diff', '--no-color', '--no-renames', '--', relPath]),
      runGit(realRoot, ['diff', '--no-color', '--no-renames', '--cached', '--', relPath]),
    ]);
    diffOutput = [staged, unstaged].filter(Boolean).join('\n');
  }

  diffOutput = filterUnifiedDiffToSinglePath(diffOutput, repoRelPath);

  if (/^Binary files .* differ$/m.test(diffOutput)) {
    return {
      ok: true,
      status: 200,
      mode: 'git',
      path: relPath,
      fileStatus: entry?.status ?? 'modified',
      isBinary: true,
      isFullFilePreview: false,
      diff: '',
      lineCount: 0,
      truncated: false,
    };
  }

  const clamped = clampDiffOutput(diffOutput);
  return {
    ok: true,
    status: 200,
    mode: 'git',
    path: relPath,
    fileStatus: entry?.status ?? 'modified',
    isBinary: false,
    isFullFilePreview: false,
    ...clamped,
  };
}

export function verifyWorkspaceTargetPath(workspaceDir, rawTargetPath, options = {}) {
  const allowedWorkspaces = Array.isArray(options.allowedWorkspaces)
    ? options.allowedWorkspaces
    : null;
  const rootCheck = resolveWorkspaceRoot(workspaceDir, allowedWorkspaces);
  if (!rootCheck.ok) {
    return rootCheck;
  }
  const { realRoot } = rootCheck;
  const trimmedTarget = String(rawTargetPath || '').trim();
  if (
    !trimmedTarget ||
    trimmedTarget.includes('\0') ||
    trimmedTarget.startsWith('~') ||
    /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmedTarget)
  ) {
    return {
      ok: true,
      status: 200,
      verified: false,
      reason: 'Caminho de destino inválido ou não verificável.',
    };
  }

  const rootPrefix = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep;
  const isAbs = path.isAbsolute(trimmedTarget) || /^[a-zA-Z]:/.test(trimmedTarget);
  const candidate = isAbs
    ? path.resolve(trimmedTarget)
    : path.resolve(realRoot, trimmedTarget);

  if (!isWithinRoot(candidate, rootPrefix, realRoot)) {
    return {
      ok: true,
      status: 200,
      verified: false,
      reason: 'Destino fora do diretório efetivo da equipe.',
    };
  }

  const candidateRel = normalizeRelPath(path.relative(realRoot, candidate));
  if (candidateRel && isSensitiveWorkspaceFile(candidateRel)) {
    return {
      ok: true,
      status: 200,
      verified: false,
      reason: 'Destino aponta para arquivo sensível protegido.',
    };
  }

  if (fs.existsSync(candidate)) {
    let realTarget;
    try {
      realTarget = fs.realpathSync(candidate);
    } catch {
      return {
        ok: true,
        status: 200,
        verified: false,
        reason: 'Não foi possível resolver o destino real no sistema de arquivos.',
      };
    }
    if (!isWithinRoot(realTarget, rootPrefix, realRoot)) {
      return {
        ok: true,
        status: 200,
        verified: false,
        reason: 'Symlink resolve para fora do diretório efetivo da equipe.',
      };
    }
    const realRel = normalizeRelPath(path.relative(realRoot, realTarget));
    if (realRel && isSensitiveWorkspaceFile(realRel)) {
      return {
        ok: true,
        status: 200,
        verified: false,
        reason: 'Symlink resolve para arquivo sensível protegido.',
      };
    }
    return { ok: true, status: 200, verified: true, realRoot, realPath: realTarget };
  }

  // Non-existent target (e.g., creating a new file): verify nearest existing ancestor stays inside realRoot
  let parent = path.dirname(candidate);
  while (parent && parent.length >= realRoot.length && !fs.existsSync(parent)) {
    const next = path.dirname(parent);
    if (next === parent) break;
    parent = next;
  }
  if (!fs.existsSync(parent)) {
    return {
      ok: true,
      status: 200,
      verified: false,
      reason: 'Diretório pai inexistente ou não verificável.',
    };
  }
  let realParent;
  try {
    realParent = fs.realpathSync(parent);
  } catch {
    return {
      ok: true,
      status: 200,
      verified: false,
      reason: 'Falha ao resolver diretório pai real.',
    };
  }
  if (!isWithinRoot(realParent, rootPrefix, realRoot)) {
    return {
      ok: true,
      status: 200,
      verified: false,
      reason: 'Diretório pai resolve para fora do diretório efetivo da equipe.',
    };
  }
  return { ok: true, status: 200, verified: true, realRoot, realPath: candidate };
}

export function shouldHandleWorkspaceDiffRequest(reqUrl) {
  const rawPath = String(reqUrl || '').split('?')[0];
  return rawPath.startsWith(WORKSPACE_DIFF_PREFIX);
}

export async function handleWorkspaceDiffRequest(req, res, options = {}) {
  if (!shouldHandleWorkspaceDiffRequest(req.url)) {
    return false;
  }

  if (!isLoopbackRemoteAddress(req.socket?.remoteAddress)) {
    sendJson(res, 403, {
      ok: false,
      error: 'Inspeção de arquivos do workspace permitida apenas via loopback local.',
    });
    return true;
  }

  if (req.method !== 'GET') {
    sendJson(res, 405, { ok: false, error: 'Método não permitido.' });
    return true;
  }

  const url = new URL(req.url || '/', 'http://127.0.0.1');
  const workspace = url.searchParams.get('workspace') ?? '';
  const allowedWorkspaces = resolveAllowedWorkspaces({
    ...options,
    rootDir: options.rootDir ?? process.cwd(),
  });

  try {
    if (url.pathname === `${WORKSPACE_DIFF_PREFIX}changes`) {
      const result = await getWorkspaceChanges(workspace, { allowedWorkspaces });
      sendJson(res, result.status ?? (result.ok ? 200 : 400), result);
      return true;
    }

    if (url.pathname === `${WORKSPACE_DIFF_PREFIX}diff`) {
      const file = url.searchParams.get('file') ?? '';
      const result = await getWorkspaceFileDiff(workspace, file, { allowedWorkspaces });
      sendJson(res, result.status ?? (result.ok ? 200 : 400), result);
      return true;
    }

    if (url.pathname === `${WORKSPACE_DIFF_PREFIX}verify-path`) {
      const target = url.searchParams.get('target') ?? '';
      const result = verifyWorkspaceTargetPath(workspace, target, { allowedWorkspaces });
      sendJson(res, result.status ?? (result.ok ? 200 : 400), result);
      return true;
    }

    sendJson(res, 404, { ok: false, error: 'Rota de workspace desconhecida.' });
    return true;
  } catch (err) {
    sendJson(res, 500, {
      ok: false,
      error: err instanceof Error ? err.message : 'Falha ao inspecionar arquivos do workspace.',
    });
    return true;
  }
}
