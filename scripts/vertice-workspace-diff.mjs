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

export function resolveWorkspaceRoot(rawWorkspacePath) {
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
  return { ok: true, realRoot };
}

export function resolveWorkspaceFile(realRoot, rawRelPath) {
  const relPath = normalizeRelPath(rawRelPath);
  if (!relPath || relPath.includes('\0')) {
    return { ok: false, status: 400, error: 'Caminho de arquivo inválido.' };
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

  if (fs.existsSync(candidate)) {
    let realTarget;
    try {
      realTarget = fs.realpathSync(candidate);
    } catch {
      return { ok: false, status: 404, error: 'Falha ao resolver arquivo.' };
    }
    if (!isWithinRoot(realTarget, rootPrefix, realRoot)) {
      return { ok: false, status: 403, error: 'Symlink externo ao workspace recusado.' };
    }
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

  if (isSensitiveWorkspaceFile(relPath)) {
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
    ['-C', realRoot, '-c', 'core.quotepath=false', ...args],
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

async function getGitBranch(realRoot) {
  try {
    const branch = (await runGit(realRoot, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    return branch || 'HEAD';
  } catch {
    return 'sem-commit';
  }
}

function parseGitNumstatZ(rawOutput, map) {
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

    const normalized = normalizeRelPath(filePath);
    const prev = map.get(normalized) ?? { additions: 0, deletions: 0, isBinary: false };
    if (addStr === '-' || delStr === '-') {
      prev.isBinary = true;
    } else {
      prev.additions += Number.parseInt(addStr, 10) || 0;
      prev.deletions += Number.parseInt(delStr, 10) || 0;
    }
    map.set(normalized, prev);
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

function parseGitPorcelainZ(rawOutput) {
  if (!rawOutput) return [];
  const tokens = rawOutput.split('\0');
  const entries = [];
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i];
    i += 1;
    if (!token || token.length < 4 || token[2] !== ' ') continue;
    const xy = token.slice(0, 2);
    const filePath = normalizeRelPath(token.slice(3));
    const x = xy[0];
    const y = xy[1];
    let previousPath;
    if ((x === 'R' || x === 'C' || y === 'R' || y === 'C') && i < tokens.length) {
      previousPath = normalizeRelPath(tokens[i]);
      i += 1;
    }
    entries.push({
      path: filePath,
      previousPath,
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
          results.push({
            path: nextRel,
            status: 'modified',
            additions: null,
            deletions: null,
            isSensitive: isSensitiveWorkspaceFile(nextRel),
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

export async function getWorkspaceChanges(workspaceDir) {
  const rootCheck = resolveWorkspaceRoot(workspaceDir);
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

  const [branch, porcelainRaw, unstagedNumstatRaw, stagedNumstatRaw] =
    await Promise.all([
      getGitBranch(realRoot),
      runGit(realRoot, ['status', '--porcelain=v1', '-uall', '-z']),
      runGit(realRoot, ['diff', '--numstat', '-z']),
      runGit(realRoot, ['diff', '--cached', '--numstat', '-z']),
    ]);

  const numstatMap = new Map();
  parseGitNumstatZ(unstagedNumstatRaw, numstatMap);
  parseGitNumstatZ(stagedNumstatRaw, numstatMap);

  const parsedEntries = parseGitPorcelainZ(porcelainRaw);
  const files = parsedEntries.slice(0, MAX_FILES_LISTED).map((entry) => {
    const sensitive = isSensitiveWorkspaceFile(entry.path);
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
  });

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

export async function getWorkspaceFileDiff(workspaceDir, relFilePath) {
  const rootCheck = resolveWorkspaceRoot(workspaceDir);
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

  const porcelain = await runGit(realRoot, [
    'status',
    '--porcelain=v1',
    '-uall',
    '-z',
    '--',
    relPath,
  ]);
  const entries = parseGitPorcelainZ(porcelain);
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
  let diffOutput = '';
  if (hasHead) {
    diffOutput = await runGit(realRoot, ['diff', '--no-color', 'HEAD', '--', relPath]);
  } else {
    const [unstaged, staged] = await Promise.all([
      runGit(realRoot, ['diff', '--no-color', '--', relPath]),
      runGit(realRoot, ['diff', '--no-color', '--cached', '--', relPath]),
    ]);
    diffOutput = [staged, unstaged].filter(Boolean).join('\n');
  }

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

export function shouldHandleWorkspaceDiffRequest(reqUrl) {
  const rawPath = String(reqUrl || '').split('?')[0];
  return rawPath.startsWith(WORKSPACE_DIFF_PREFIX);
}

export async function handleWorkspaceDiffRequest(req, res) {
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

  try {
    if (url.pathname === `${WORKSPACE_DIFF_PREFIX}changes`) {
      const result = await getWorkspaceChanges(workspace);
      sendJson(res, result.status ?? (result.ok ? 200 : 400), result);
      return true;
    }

    if (url.pathname === `${WORKSPACE_DIFF_PREFIX}diff`) {
      const file = url.searchParams.get('file') ?? '';
      const result = await getWorkspaceFileDiff(workspace, file);
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
