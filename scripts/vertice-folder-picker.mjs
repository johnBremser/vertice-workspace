import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const LOCAL_PICKER_PREFIX = '/__vertice_local/picker/';
const MAX_BODY_BYTES = 16 * 1024;
const DIALOG_TIMEOUT_MS = 60_000;
const IGNORED_WIN_SYSTEM_DIRS = new Set([
  '$recycle.bin',
  'system volume information',
  'recovery',
  'config.msi',
]);

let activePickPromise = null;

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

export function isLoopbackRemoteAddress(remoteAddress) {
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

export function shouldHandleLocalFolderRequest(reqUrl) {
  const rawPath = String(reqUrl || '').split('?')[0];
  return rawPath.startsWith(LOCAL_PICKER_PREFIX);
}

function sanitizeInitialPath(rawPath) {
  if (typeof rawPath !== 'string') return '';
  const trimmed = rawPath.trim();
  if (!trimmed || trimmed.includes('\0')) return '';
  try {
    const resolved = path.resolve(trimmed);
    if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
      return resolved;
    }
  } catch {
    return '';
  }
  return '';
}

function listAvailableRoots() {
  if (process.platform === 'win32') {
    const drives = [];
    for (let code = 67; code <= 90; code += 1) {
      const drive = `${String.fromCharCode(code)}:\\`;
      try {
        if (fs.existsSync(drive)) {
          drives.push({ name: drive.slice(0, 2), path: drive });
        }
      } catch {
        // Ignore unavailable drives
      }
    }
    if (drives.length === 0) {
      try {
        if (fs.existsSync('C:\\')) drives.push({ name: 'C:', path: 'C:\\' });
      } catch {
        // Ignore
      }
    }
    return drives;
  }
  return [{ name: '/', path: '/' }];
}

function buildDirectoryShortcuts(workspaceRoot) {
  const candidates = [];
  const homeDir = os.homedir();
  if (homeDir) {
    candidates.push({ label: 'Usuário', path: homeDir });
    candidates.push({ label: 'Área de trabalho', path: path.join(homeDir, 'Desktop') });
    candidates.push({ label: 'Documentos', path: path.join(homeDir, 'Documents') });
  }
  if (workspaceRoot) {
    candidates.push({ label: 'Pasta pai do Vértice', path: path.dirname(workspaceRoot) });
  }
  const seen = new Set();
  const out = [];
  for (const item of candidates) {
    try {
      const resolved = path.resolve(item.path);
      if (seen.has(resolved)) continue;
      if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
        seen.add(resolved);
        out.push({ label: item.label, path: resolved });
      }
    } catch {
      // Skip inaccessible candidate
    }
  }
  return out;
}

/**
 * Lists subdirectories on the local loopback host cleanly without spawning external GUI
 * windows. Read-only: inspects directory entries only, never file contents.
 */
export function browseLocalDirectories(options = {}) {
  const rawRequested =
    typeof options.targetPath === 'string' ? options.targetPath.trim() : '';
  const workspaceRoot =
    typeof options.workspaceRoot === 'string' && options.workspaceRoot.trim()
      ? path.resolve(options.workspaceRoot)
      : process.cwd();

  const roots = listAvailableRoots();
  const shortcuts = buildDirectoryShortcuts(workspaceRoot);

  let warning = null;
  let targetDir = sanitizeInitialPath(rawRequested);

  if (rawRequested && !targetDir) {
    // Walk up parent segments until an existing folder is found, or fall back cleanly
    let probe = path.resolve(rawRequested);
    while (probe && probe !== path.dirname(probe)) {
      probe = path.dirname(probe);
      if (sanitizeInitialPath(probe)) {
        targetDir = probe;
        break;
      }
    }
    warning = `Caminho "${rawRequested}" não encontrado; exibindo pasta existente mais próxima.`;
  }

  if (!targetDir) {
    targetDir =
      shortcuts.find((s) => s.label === 'Pasta pai do Vértice')?.path ||
      shortcuts[0]?.path ||
      roots[0]?.path ||
      workspaceRoot;
  }

  let directories = [];
  try {
    const entries = fs.readdirSync(targetDir, { withFileTypes: true });
    directories = entries
      .filter((entry) => {
        if (entry.name.includes('\0')) return false;
        if (
          process.platform === 'win32' &&
          IGNORED_WIN_SYSTEM_DIRS.has(entry.name.toLowerCase())
        ) {
          return false;
        }
        if (entry.isDirectory()) return true;
        if (entry.isSymbolicLink()) {
          try {
            return fs.statSync(path.join(targetDir, entry.name)).isDirectory();
          } catch {
            return false;
          }
        }
        return false;
      })
      .map((entry) => ({
        name: entry.name,
        path: path.join(targetDir, entry.name),
      }))
      .sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
      );
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err ? err.code : '';
    warning =
      code === 'EACCES' || code === 'EPERM'
        ? `Sem permissão para listar "${targetDir}".`
        : `Não foi possível ler "${targetDir}".`;
    console.error('[vertice-folder-picker] browse error:', targetDir, err);
  }

  const parsedParent = path.dirname(targetDir);
  const parentPath = parsedParent && parsedParent !== targetDir ? parsedParent : null;

  return {
    ok: true,
    currentPath: targetDir,
    parentPath,
    roots,
    shortcuts,
    directories,
    ...(warning ? { warning } : {}),
  };
}

const INVALID_FOLDER_NAME_RE = /[<>:"/\\|?*\x00-\x1f]/;

/**
 * Creates a single new subfolder inside an existing parent directory on the local loopback host.
 */
export function createLocalDirectory(options = {}) {
  const rawParent =
    typeof options.parentPath === 'string' ? options.parentPath.trim() : '';
  const rawName =
    typeof options.folderName === 'string' ? options.folderName.trim() : '';

  const resolvedParent = sanitizeInitialPath(rawParent);
  if (!resolvedParent) {
    return {
      ok: false,
      status: 400,
      error: 'Pasta pai inválida ou inexistente.',
    };
  }

  if (
    !rawName ||
    rawName === '.' ||
    rawName === '..' ||
    INVALID_FOLDER_NAME_RE.test(rawName)
  ) {
    return {
      ok: false,
      status: 400,
      error:
        'Nome de pasta inválido. Não use barras (/ \\), ".." ou caracteres reservados (< > : " | ? *).',
    };
  }

  const parentPrefix = resolvedParent.endsWith(path.sep)
    ? resolvedParent
    : resolvedParent + path.sep;
  const targetDir = path.resolve(resolvedParent, rawName);
  if (
    targetDir !== path.join(resolvedParent, rawName) ||
    !targetDir.startsWith(parentPrefix)
  ) {
    return {
      ok: false,
      status: 400,
      error: 'Caminho de destino inválido fora da pasta atual.',
    };
  }

  if (fs.existsSync(targetDir)) {
    return {
      ok: false,
      status: 409,
      error: `Já existe "${rawName}" nesta pasta.`,
    };
  }

  try {
    fs.mkdirSync(targetDir, { recursive: false });
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err ? err.code : '';
    console.error('[vertice-folder-picker] create error:', targetDir, err);
    return {
      ok: false,
      status: code === 'EACCES' || code === 'EPERM' ? 403 : 500,
      error:
        code === 'EACCES' || code === 'EPERM'
          ? `Sem permissão para criar "${rawName}" em "${resolvedParent}".`
          : `Não foi possível criar a pasta "${rawName}".`,
    };
  }

  return {
    ok: true,
    status: 201,
    createdPath: targetDir,
    listing: browseLocalDirectories({
      targetPath: targetDir,
      workspaceRoot: options.workspaceRoot,
    }),
  };
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;
    req.on('data', (chunk) => {
      totalBytes += chunk.length;
      if (totalBytes > MAX_BODY_BYTES) {
        reject(new Error('Payload muito grande.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(raw);
        resolve(
          parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? parsed
            : {},
        );
      } catch {
        reject(new Error('JSON inválido na requisição.'));
      }
    });
    req.on('error', (err) => reject(err));
  });
}

function execFilePromise(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, options, (err, stdout, stderr) => {
      if (err) {
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function pickDirectoryWindows(initialPath) {
  const psScript = [
    '$ProgressPreference = "SilentlyContinue"',
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    'Add-Type -AssemblyName System.Windows.Forms',
    'Add-Type -AssemblyName System.Drawing',
    '$area = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea',
    '$owner = New-Object System.Windows.Forms.Form',
    '$owner.TopMost = $true',
    '$owner.ShowInTaskbar = $true',
    '$owner.Text = "Vértice Workspace — Seletor de Pasta"',
    '$owner.Opacity = 0',
    '$owner.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None',
    '$owner.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual',
    '$owner.Location = New-Object System.Drawing.Point(($area.Left + [int]($area.Width / 2)), ($area.Top + [int]($area.Height / 2)))',
    '$owner.Size = New-Object System.Drawing.Size(1, 1)',
    '$dlg = New-Object System.Windows.Forms.FolderBrowserDialog',
    '$dlg.Description = "Selecione a pasta raiz do workspace do projeto"',
    '$dlg.ShowNewFolderButton = $true',
    '$init = $env:VERTICE_PICKER_INITIAL_PATH',
    'if ($init -and (Test-Path -LiteralPath $init -PathType Container)) {',
    '  $dlg.SelectedPath = $init',
    '}',
    '$owner.Show()',
    '$owner.Activate()',
    '$res = $dlg.ShowDialog($owner)',
    '$owner.Close()',
    '$owner.Dispose()',
    'if ($res -eq [System.Windows.Forms.DialogResult]::OK -and $dlg.SelectedPath) {',
    '  @{ cancelled = $false; path = $dlg.SelectedPath } | ConvertTo-Json -Compress',
    '} else {',
    '  @{ cancelled = $true; path = $null } | ConvertTo-Json -Compress',
    '}',
  ].join('\n');

  const encoded = Buffer.from(psScript, 'utf16le').toString('base64');
  const { stdout } = await execFilePromise(
    'powershell.exe',
    ['-NoProfile', '-STA', '-EncodedCommand', encoded],
    {
      timeout: DIALOG_TIMEOUT_MS,
      windowsHide: false,
      encoding: 'utf8',
      env: {
        ...process.env,
        VERTICE_PICKER_INITIAL_PATH: initialPath || '',
      },
    },
  );
  const lines = String(stdout || '')
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const jsonLine = [...lines].reverse().find((line) => line.startsWith('{')) || '{}';
  const parsed = JSON.parse(jsonLine);
  return {
    available: true,
    cancelled: Boolean(parsed.cancelled) || !parsed.path,
    path: typeof parsed.path === 'string' && parsed.path ? parsed.path : null,
  };
}

async function pickDirectoryMac(initialPath) {
  const args = [
    '-e',
    'on run argv',
    '-e',
    'set promptText to "Selecione a pasta do workspace do projeto"',
    '-e',
    'if (count of argv) > 0 and item 1 of argv is not "" then',
    '-e',
    '  try',
    '-e',
    '    set chosen to choose folder with prompt promptText default location (POSIX file (item 1 of argv))',
    '-e',
    '  on error',
    '-e',
    '    set chosen to choose folder with prompt promptText',
    '-e',
    '  end try',
    '-e',
    'else',
    '-e',
    '  set chosen to choose folder with prompt promptText',
    '-e',
    'end if',
    '-e',
    'return POSIX path of chosen',
    '-e',
    'end run',
    initialPath || '',
  ];
  try {
    const { stdout } = await execFilePromise('osascript', args, {
      timeout: DIALOG_TIMEOUT_MS,
      encoding: 'utf8',
    });
    const selected = String(stdout || '').trim().replace(/\/+$/, '') || '/';
    return { available: true, cancelled: false, path: selected };
  } catch (err) {
    if (String(err?.stderr || err?.message || '').includes('-128')) {
      return { available: true, cancelled: true, path: null };
    }
    throw err;
  }
}

async function pickDirectoryLinux(initialPath) {
  const title = 'Selecione a pasta do workspace do projeto';
  const startArg = initialPath ? [`--filename=${initialPath}${path.sep}`] : [];
  try {
    const { stdout } = await execFilePromise(
      'zenity',
      ['--file-selection', '--directory', `--title=${title}`, ...startArg],
      { timeout: DIALOG_TIMEOUT_MS, encoding: 'utf8' },
    );
    const selected = String(stdout || '').trim();
    return selected
      ? { available: true, cancelled: false, path: selected }
      : { available: true, cancelled: true, path: null };
  } catch (zenityErr) {
    if (zenityErr && zenityErr.code === 1) {
      return { available: true, cancelled: true, path: null };
    }
    try {
      const { stdout } = await execFilePromise(
        'kdialog',
        ['--getexistingdirectory', initialPath || process.cwd(), '--title', title],
        { timeout: DIALOG_TIMEOUT_MS, encoding: 'utf8' },
      );
      const selected = String(stdout || '').trim();
      return selected
        ? { available: true, cancelled: false, path: selected }
        : { available: true, cancelled: true, path: null };
    } catch (kErr) {
      if (kErr && kErr.code === 1) {
        return { available: true, cancelled: true, path: null };
      }
      return {
        available: false,
        cancelled: true,
        path: null,
        error: 'Nenhum seletor gráfico nativo (zenity/kdialog) disponível neste ambiente.',
      };
    }
  }
}

export async function pickDirectoryOnHost(options = {}) {
  const initialPath = sanitizeInitialPath(options.initialPath);
  if (process.platform === 'win32') {
    return pickDirectoryWindows(initialPath);
  }
  if (process.platform === 'darwin') {
    return pickDirectoryMac(initialPath);
  }
  if (process.platform === 'linux') {
    return pickDirectoryLinux(initialPath);
  }
  return {
    available: false,
    cancelled: true,
    path: null,
    error: `Seletor nativo não suportado na plataforma ${process.platform}.`,
  };
}

/**
 * Handles `/__vertice_local/picker/*` endpoints on loopback servers so browser users can browse or
 * select a local workspace directory when Vértice runs via vertice-server.mjs or Vite dev.
 */
export function handleLocalFolderRequest(req, res, options = {}) {
  const reqUrl = String(req.url || '');
  if (!shouldHandleLocalFolderRequest(reqUrl)) {
    return false;
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(reqUrl, 'http://127.0.0.1');
  } catch {
    sendJson(res, 400, { ok: false, error: 'URL inválida.' });
    return true;
  }

  const remoteAddress = req.socket?.remoteAddress;
  if (!isLoopbackRemoteAddress(remoteAddress)) {
    sendJson(res, 403, {
      ok: false,
      error: 'Seletor local de pastas permitido apenas em loopback (127.0.0.1 / ::1).',
    });
    return true;
  }

  const route = parsedUrl.pathname.slice(LOCAL_PICKER_PREFIX.length);
  if (route === 'meta') {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(res, 405, { ok: false, error: 'Método não permitido.' });
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
    sendJson(res, 200, {
      ok: true,
      available: true,
      platform: process.platform,
    });
    return true;
  }

  if (route === 'browse') {
    if (req.method !== 'GET') {
      sendJson(res, 405, { ok: false, error: 'Use GET para listar pastas locais.' });
      return true;
    }
    const browseImpl =
      typeof options.browseDirectoriesImpl === 'function'
        ? options.browseDirectoriesImpl
        : browseLocalDirectories;
    try {
      const targetPath = parsedUrl.searchParams.get('path') ?? '';
      const result = browseImpl({
        targetPath,
        workspaceRoot: options.workspaceRoot,
      });
      sendJson(res, 200, result);
    } catch (err) {
      console.error('[vertice-folder-picker] unexpected browse error:', err);
      sendJson(res, 500, {
        ok: false,
        error: 'Falha ao listar pastas no servidor local.',
      });
    }
    return true;
  }

  if (route === 'create') {
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, error: 'Use POST para criar uma nova pasta.' });
      return true;
    }
    const createImpl =
      typeof options.createDirectoryImpl === 'function'
        ? options.createDirectoryImpl
        : createLocalDirectory;
    void (async () => {
      let body = {};
      try {
        body = await readJsonBody(req);
      } catch (err) {
        sendJson(res, 400, {
          ok: false,
          error: err instanceof Error ? err.message : 'Requisição inválida.',
        });
        return;
      }
      const result = createImpl({
        parentPath: typeof body.parentPath === 'string' ? body.parentPath : '',
        folderName: typeof body.folderName === 'string' ? body.folderName : '',
        workspaceRoot: options.workspaceRoot,
      });
      if (!result.ok) {
        sendJson(res, result.status || 400, {
          ok: false,
          error: result.error || 'Não foi possível criar a pasta.',
        });
        return;
      }
      sendJson(res, 201, {
        ok: true,
        createdPath: result.createdPath,
        listing: result.listing,
      });
    })();
    return true;
  }

  if (route === 'directory') {
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, error: 'Use POST para abrir o seletor de pastas.' });
      return true;
    }

    if (activePickPromise) {
      sendJson(res, 409, {
        ok: false,
        busy: true,
        error: 'Já existe uma janela de seleção de pasta aberta no sistema.',
      });
      return true;
    }

    const pickImpl =
      typeof options.pickDirectoryImpl === 'function'
        ? options.pickDirectoryImpl
        : pickDirectoryOnHost;

    const work = (async () => {
      let body = {};
      try {
        body = await readJsonBody(req);
      } catch (err) {
        sendJson(res, 400, {
          ok: false,
          error: err instanceof Error ? err.message : 'Requisição inválida.',
        });
        return;
      }

      try {
        const result = await pickImpl({
          initialPath: typeof body.initialPath === 'string' ? body.initialPath : undefined,
        });
        if (result && result.available === false) {
          sendJson(res, 501, {
            ok: false,
            available: false,
            error:
              result.error ||
              'Seletor nativo de pastas indisponível neste servidor.',
          });
          return;
        }
        sendJson(res, 200, {
          ok: true,
          available: true,
          cancelled: Boolean(result?.cancelled) || !result?.path,
          path: result?.path ?? null,
        });
      } catch (err) {
        console.error('[vertice-folder-picker] native picker error:', err);
        const killed = Boolean(err && typeof err === 'object' && 'killed' in err && err.killed);
        const stderrDetail =
          err && typeof err === 'object' && 'stderr' in err && typeof err.stderr === 'string'
            ? err.stderr.trim()
            : '';
        const cleanDetail = killed
          ? 'Tempo esgotado aguardando confirmação na janela do sistema.'
          : stderrDetail || 'Não foi possível abrir o diálogo gráfico do sistema.';
        sendJson(res, 500, {
          ok: false,
          available: false,
          error: `Falha no seletor nativo: ${cleanDetail}`,
        });
      }
    })();

    activePickPromise = work.finally(() => {
      activePickPromise = null;
    });
    return true;
  }

  sendJson(res, 404, { ok: false, error: 'Rota de seleção de pasta não encontrada.' });
  return true;
}
