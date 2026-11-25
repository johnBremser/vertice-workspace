import fs from 'node:fs';
import path from 'node:path';

export const ASSISTANT_ENDPOINT_PREFIX = '/__vertice_assistant/';

export const ALLOWED_SOURCE_DIRS = ['src', 'docs', 'scripts'];
export const ALLOWED_ROOT_FILES = [
  'README.md',
  'package.json',
  'vertice.config.json',
  'CHANGELOG.md',
  'LICENSE',
];

const ALLOWED_TEXT_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.mjs',
  '.cjs',
  '.json',
  '.md',
  '.css',
  '.html',
  '.ps1',
  '.cmd',
  '.yml',
  '.yaml',
  '.txt',
]);

const MAX_READ_BYTES = 24 * 1024;
const MAX_LINES_PER_READ = 250;
const MAX_FILE_SCAN_BYTES = 512 * 1024;

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

function normalizeRelPath(rawPath) {
  const trimmed = String(rawPath || '')
    .trim()
    .replaceAll('\\', '/')
    .replace(/^\/+/, '');
  return trimmed;
}

export function isAllowlistedRelativePath(relPath) {
  if (!relPath || relPath.includes('\0')) return false;
  const parts = relPath.split('/').filter(Boolean);
  if (parts.length === 0) return false;

  for (const part of parts) {
    if (part === '.' || part === '..' || part.startsWith('.')) {
      return false;
    }
    if (
      part === 'node_modules' ||
      part === 'dist' ||
      part === 'test-results' ||
      part === 'playwright-report' ||
      part === 'data'
    ) {
      return false;
    }
  }

  if (parts.length === 1) {
    return ALLOWED_ROOT_FILES.includes(parts[0]);
  }

  if (!ALLOWED_SOURCE_DIRS.includes(parts[0])) {
    return false;
  }

  const ext = path.extname(parts[parts.length - 1]).toLowerCase();
  return ALLOWED_TEXT_EXTENSIONS.has(ext);
}

export function resolveAllowlistedFile(rootDir, rawRelPath) {
  const relPath = normalizeRelPath(rawRelPath);
  if (!isAllowlistedRelativePath(relPath)) {
    return { ok: false, status: 403, error: 'Caminho não permitido para leitura.' };
  }

  let realRoot;
  try {
    realRoot = fs.realpathSync(path.resolve(rootDir));
  } catch {
    return { ok: false, status: 404, error: 'Diretório raiz indisponível.' };
  }

  const candidate = path.resolve(realRoot, relPath);
  const rootPrefix = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep;
  if (!candidate.startsWith(rootPrefix)) {
    return { ok: false, status: 403, error: 'Acesso fora do workspace recusado.' };
  }

  if (!fs.existsSync(candidate)) {
    return { ok: false, status: 404, error: 'Arquivo não encontrado.' };
  }

  let realTarget;
  let stat;
  try {
    realTarget = fs.realpathSync(candidate);
    stat = fs.statSync(realTarget);
  } catch {
    return { ok: false, status: 404, error: 'Falha ao acessar arquivo.' };
  }

  if (!realTarget.startsWith(rootPrefix)) {
    return { ok: false, status: 403, error: 'Symlink externo recusado.' };
  }
  if (!stat.isFile()) {
    return { ok: false, status: 404, error: 'Alvo não é um arquivo regular.' };
  }

  return { ok: true, relPath, fullPath: realTarget, sizeBytes: stat.size };
}

export function listAllowlistedFiles(rootDir) {
  let realRoot;
  try {
    realRoot = fs.realpathSync(path.resolve(rootDir));
  } catch {
    return [];
  }
  const rootPrefix = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep;
  const results = [];

  for (const rootFile of ALLOWED_ROOT_FILES) {
    const resolved = resolveAllowlistedFile(realRoot, rootFile);
    if (resolved.ok) {
      results.push({ path: resolved.relPath, sizeBytes: resolved.sizeBytes });
    }
  }

  const walk = (dirPath, relPrefix) => {
    let entries;
    try {
      entries = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') {
        continue;
      }
      const nextRel = `${relPrefix}/${entry.name}`;
      const abs = path.join(dirPath, entry.name);
      let realAbs;
      try {
        realAbs = fs.realpathSync(abs);
      } catch {
        continue;
      }
      if (!realAbs.startsWith(rootPrefix)) {
        continue;
      }
      if (entry.isDirectory()) {
        walk(realAbs, nextRel);
      } else if (entry.isFile() && isAllowlistedRelativePath(nextRel)) {
        try {
          const stat = fs.statSync(realAbs);
          results.push({ path: nextRel, sizeBytes: stat.size });
        } catch {
          // Ignore unreadable transient entries
        }
      }
    }
  };

  for (const dir of ALLOWED_SOURCE_DIRS) {
    const dirAbs = path.join(realRoot, dir);
    if (fs.existsSync(dirAbs)) {
      try {
        const realDir = fs.realpathSync(dirAbs);
        if (realDir.startsWith(rootPrefix) && fs.statSync(realDir).isDirectory()) {
          walk(realDir, dir);
        }
      } catch {
        // Skip invalid directory
      }
    }
  }

  results.sort((a, b) => a.path.localeCompare(b.path));
  return results;
}

export function readAllowlistedFileSlice(rootDir, rawRelPath, startLineRaw, endLineRaw) {
  const resolved = resolveAllowlistedFile(rootDir, rawRelPath);
  if (!resolved.ok) {
    return resolved;
  }

  if (resolved.sizeBytes > MAX_FILE_SCAN_BYTES) {
    return {
      ok: false,
      status: 413,
      error: 'Arquivo excede o limite de inspeção somente leitura.',
    };
  }

  const rawText = fs.readFileSync(resolved.fullPath, 'utf8');
  const allLines = rawText.split(/\r?\n/);
  const totalLines = allLines.length;

  const parsedStart = Number.parseInt(String(startLineRaw ?? '1'), 10);
  const startLine = Number.isFinite(parsedStart) && parsedStart >= 1
    ? Math.min(parsedStart, Math.max(1, totalLines))
    : 1;

  const parsedEnd = Number.parseInt(
    String(endLineRaw ?? String(startLine + MAX_LINES_PER_READ - 1)),
    10,
  );
  const requestedEnd = Number.isFinite(parsedEnd) && parsedEnd >= startLine
    ? parsedEnd
    : startLine + MAX_LINES_PER_READ - 1;
  const clampedEnd = Math.min(
    totalLines,
    requestedEnd,
    startLine + MAX_LINES_PER_READ - 1,
  );

  const selectedLines = [];
  let bytesUsed = 0;
  let truncated = clampedEnd < totalLines;

  for (let lineNo = startLine; lineNo <= clampedEnd; lineNo += 1) {
    const text = allLines[lineNo - 1] ?? '';
    const lineBytes = Buffer.byteLength(text, 'utf8') + 1;
    if (selectedLines.length > 0 && bytesUsed + lineBytes > MAX_READ_BYTES) {
      truncated = true;
      break;
    }
    selectedLines.push({ lineNumber: lineNo, text });
    bytesUsed += lineBytes;
  }

  const actualEndLine =
    selectedLines.length > 0
      ? selectedLines[selectedLines.length - 1].lineNumber
      : startLine;

  return {
    ok: true,
    status: 200,
    path: resolved.relPath,
    totalLines,
    startLine,
    endLine: actualEndLine,
    truncated,
    lines: selectedLines,
    content: selectedLines.map((l) => `${l.lineNumber}: ${l.text}`).join('\n'),
  };
}

export function searchAllowlistedFiles(rootDir, rawQuery, limitRaw = 12) {
  const query = String(rawQuery || '').trim();
  if (!query) {
    return { ok: true, query: '', matches: [] };
  }

  const limit = Math.max(
    1,
    Math.min(30, Number.parseInt(String(limitRaw ?? '12'), 10) || 12),
  );
  const lowerPhrase = query.toLowerCase();
  const tokens = lowerPhrase
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);
  const files = listAllowlistedFiles(rootDir);
  const scoredMatches = [];

  for (const file of files) {
    if (file.sizeBytes > MAX_FILE_SCAN_BYTES) continue;
    const resolved = resolveAllowlistedFile(rootDir, file.path);
    if (!resolved.ok) continue;

    let text;
    try {
      text = fs.readFileSync(resolved.fullPath, 'utf8');
    } catch {
      continue;
    }
    const lines = text.split(/\r?\n/);
    const lowerPath = file.path.toLowerCase();
    const pathBoost = lowerPath.includes(lowerPhrase) ? 5 : 0;
    const srcBoost = lowerPath.startsWith('src/') ? 3 : 0;

    let perFileCount = 0;
    for (let idx = 0; idx < lines.length; idx += 1) {
      const line = lines[idx];
      const lowerLine = line.toLowerCase();
      let score = 0;
      if (lowerLine.includes(lowerPhrase)) {
        const defBoost = /\bexport\s+(interface|type|class|function|const)\b/.test(
          lowerLine,
        )
          ? 6
          : 0;
        score += 10 + pathBoost + srcBoost + defBoost;
      } else if (tokens.length > 0) {
        let matchedTokens = 0;
        for (const tok of tokens) {
          if (lowerLine.includes(tok) || lowerPath.includes(tok)) {
            matchedTokens += 1;
          }
        }
        if (matchedTokens === tokens.length) {
          score += 4 + matchedTokens + pathBoost + srcBoost;
        }
      }
      if (score > 0) {
        scoredMatches.push({
          path: file.path,
          lineNumber: idx + 1,
          preview: line.trim().slice(0, 220),
          score,
        });
        perFileCount += 1;
        if (perFileCount >= 3) break;
      }
    }
  }

  scoredMatches.sort(
    (a, b) =>
      b.score - a.score ||
      a.path.localeCompare(b.path) ||
      a.lineNumber - b.lineNumber,
  );

  return {
    ok: true,
    query,
    matches: scoredMatches.slice(0, limit).map(({ path: p, lineNumber, preview }) => ({
      path: p,
      lineNumber,
      preview,
    })),
  };
}

export function shouldHandleAssistantSourcePath(reqUrl) {
  const pathname = String(reqUrl || '').split('?')[0];
  return pathname.startsWith(ASSISTANT_ENDPOINT_PREFIX);
}

export function handleAssistantSourceRequest(req, res, rootDir) {
  const reqUrl = String(req.url || '/');
  let parsedUrl;
  try {
    parsedUrl = new URL(reqUrl, 'http://127.0.0.1');
  } catch {
    sendJson(res, 400, { ok: false, error: 'URL inválida.' });
    return true;
  }

  if (!parsedUrl.pathname.startsWith(ASSISTANT_ENDPOINT_PREFIX)) {
    return false;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendJson(res, 405, {
      ok: false,
      error: 'Endpoint de leitura do código-fonte aceita apenas GET/HEAD.',
    });
    return true;
  }

  if (req.method === 'HEAD') {
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end();
    return true;
  }

  const route = parsedUrl.pathname.slice(ASSISTANT_ENDPOINT_PREFIX.length);
  if (route === 'meta') {
    let realRoot = path.resolve(rootDir);
    try {
      realRoot = fs.realpathSync(realRoot);
    } catch {
      // Fallback to resolved root
    }
    sendJson(res, 200, {
      ok: true,
      service: 'vertice-source-reader',
      accessMode: 'read_only',
      rootDir: realRoot,
      allowedDirs: ALLOWED_SOURCE_DIRS,
      allowedRootFiles: ALLOWED_ROOT_FILES,
    });
    return true;
  }

  if (route === 'files') {
    const files = listAllowlistedFiles(rootDir);
    sendJson(res, 200, {
      ok: true,
      accessMode: 'read_only',
      files,
    });
    return true;
  }

  if (route === 'file') {
    const filePath = parsedUrl.searchParams.get('path') ?? '';
    const startLine = parsedUrl.searchParams.get('startLine');
    const endLine = parsedUrl.searchParams.get('endLine');
    const result = readAllowlistedFileSlice(rootDir, filePath, startLine, endLine);
    if (!result.ok) {
      sendJson(res, result.status, { ok: false, error: result.error });
      return true;
    }
    sendJson(res, 200, result);
    return true;
  }

  if (route === 'search') {
    const q = parsedUrl.searchParams.get('q') ?? '';
    const limit = parsedUrl.searchParams.get('limit') ?? '12';
    const result = searchAllowlistedFiles(rootDir, q, limit);
    sendJson(res, 200, result);
    return true;
  }

  sendJson(res, 404, { ok: false, error: 'Rota de leitura do assistente não encontrada.' });
  return true;
}
