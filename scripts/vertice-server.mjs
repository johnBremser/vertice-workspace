import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import tls from 'node:tls';
import { fileURLToPath } from 'node:url';

let assistantSourceReader = null;
try {
  assistantSourceReader = await import('./vertice-source-reader.mjs');
} catch {
  // Optional in isolated test copies that only stage vertice-server.mjs + vertice-ctl.mjs
  assistantSourceReader = null;
}

let localFolderPicker = null;
try {
  localFolderPicker = await import('./vertice-folder-picker.mjs');
} catch {
  localFolderPicker = null;
}

let workspaceDiffReader = null;
try {
  workspaceDiffReader = await import('./vertice-workspace-diff.mjs');
} catch {
  workspaceDiffReader = null;
}

let nodeCompat = null;
try {
  nodeCompat = await import('./node-compat.mjs');
} catch {
  nodeCompat = null;
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

export function parseDotEnv(content) {
  const result = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eqIndex = line.indexOf('=');
    if (eqIndex <= 0) continue;
    const key = line.slice(0, eqIndex).trim();
    let value = line.slice(eqIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

export function loadEnvFiles(rootDir) {
  const merged = {};
  const configPath = path.join(rootDir, 'vertice.config.json');
  if (fs.existsSync(configPath)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (typeof cfg.host === 'string' && cfg.host.trim()) {
        merged.VERTICE_HOST = cfg.host.trim();
      }
      if (cfg.port !== undefined && cfg.port !== null && String(cfg.port).trim()) {
        merged.VERTICE_PORT = String(cfg.port).trim();
      }
      if (typeof cfg.aioncoreBaseUrl === 'string') {
        merged.VITE_AIONCORE_BASE_URL = cfg.aioncoreBaseUrl.trim();
      }
      if (typeof cfg.aioncoreProxyTarget === 'string' && cfg.aioncoreProxyTarget.trim()) {
        merged.VITE_AIONCORE_PROXY_TARGET = cfg.aioncoreProxyTarget.trim();
      }
    } catch {
      // Ignore malformed optional config here; doctor/startup validates separately
    }
  }
  for (const filename of ['.env', '.env.local']) {
    const filePath = path.join(rootDir, filename);
    if (fs.existsSync(filePath)) {
      Object.assign(merged, parseDotEnv(fs.readFileSync(filePath, 'utf8')));
    }
  }
  return merged;
}

export function isLoopbackHost(host) {
  const clean = String(host || '')
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  return (
    clean === '127.0.0.1' ||
    clean === 'localhost' ||
    clean === '::1' ||
    clean.startsWith('127.')
  );
}

export function shouldProxyHttpPath(urlPath) {
  const pathname = urlPath.split('?')[0];
  return (
    pathname === '/health' ||
    pathname === '/login' ||
    pathname === '/logout' ||
    pathname === '/api' ||
    pathname.startsWith('/api/')
  );
}

export function shouldProxyWsPath(urlPath) {
  const pathname = urlPath.split('?')[0];
  return pathname === '/ws' || pathname.startsWith('/ws/');
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendPlainText(res, statusCode, text) {
  res.writeHead(statusCode, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

export function safeDecodePathname(reqUrl) {
  const rawPathname = String(reqUrl || '/').split('?')[0];
  let pathname;
  try {
    pathname = decodeURIComponent(rawPathname);
  } catch {
    return { ok: false, reason: 'URI malformed' };
  }
  if (pathname.includes('\0')) {
    return { ok: false, reason: 'Invalid null byte in URL' };
  }
  return { ok: true, pathname, rawPathname };
}

function isAuthorizedControlRequest(req, expectedToken) {
  if (!expectedToken) return false;
  const raw = req.headers['x-vertice-control-token'];
  const provided = Array.isArray(raw) ? raw[0] : raw;
  if (typeof provided !== 'string' || !provided) return false;
  const expectedBuf = Buffer.from(expectedToken, 'utf8');
  const providedBuf = Buffer.from(provided, 'utf8');
  if (expectedBuf.length !== providedBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, providedBuf);
}

function resolveUpstreamTargetUrl(reqUrl, targetUrl) {
  const candidate = String(reqUrl || '/');
  if (!candidate.startsWith('/') || candidate.startsWith('//')) {
    return null;
  }
  try {
    const base = new URL(targetUrl);
    const resolved = new URL(candidate, base);
    if (resolved.origin !== base.origin) {
      return null;
    }
    return resolved;
  } catch {
    return null;
  }
}

function resolveDistFile(distDir, reqUrlPath) {
  const decoded = safeDecodePathname(reqUrlPath);
  if (!decoded.ok) {
    return { invalidUrl: true };
  }
  const pathname = decoded.pathname;
  const cleanRel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const resolvedDist = path.resolve(distDir);
  const candidate = path.resolve(resolvedDist, cleanRel);
  const distPrefix = resolvedDist.endsWith(path.sep)
    ? resolvedDist
    : resolvedDist + path.sep;

  if (candidate !== resolvedDist && !candidate.startsWith(distPrefix)) {
    return null;
  }

  let realDist = resolvedDist;
  try {
    realDist = fs.realpathSync(resolvedDist);
  } catch {
    return null;
  }
  const realDistPrefix = realDist.endsWith(path.sep)
    ? realDist
    : realDist + path.sep;

  if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
    try {
      const realCandidate = fs.realpathSync(candidate);
      if (realCandidate !== realDist && !realCandidate.startsWith(realDistPrefix)) {
        return null;
      }
    } catch {
      return null;
    }
    return { filePath: candidate, isSpaFallback: false };
  }

  // SPA fallback only for non-asset navigation paths
  const ext = path.extname(cleanRel);
  if (!ext) {
    const indexPath = path.join(resolvedDist, 'index.html');
    if (fs.existsSync(indexPath) && fs.statSync(indexPath).isFile()) {
      return { filePath: indexPath, isSpaFallback: true };
    }
  }

  return null;
}

function forwardHttpRequest(req, res, targetUrl) {
  const target = resolveUpstreamTargetUrl(req.url || '/', targetUrl);
  if (!target) {
    sendPlainText(res, 400, 'Bad Request');
    return;
  }
  const client = target.protocol === 'https:' ? https : http;
  const headers = { ...req.headers };
  delete headers['x-vertice-control-token'];
  // Preserve same-origin semantics (like Vite changeOrigin: false) while forwarding client info
  if (!headers['x-forwarded-host'] && req.headers.host) {
    headers['x-forwarded-host'] = req.headers.host;
  }
  headers['x-forwarded-proto'] = 'http';

  const proxyReq = client.request(
    {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      method: req.method,
      path: `${target.pathname}${target.search}`,
      headers,
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
      proxyRes.pipe(res);
    },
  );

  proxyReq.on('error', (err) => {
    if (!res.headersSent) {
      sendJson(res, 502, {
        success: false,
        message: `Falha ao encaminhar requisição para o AionCore (${err.message}).`,
      });
    } else {
      res.destroy(err);
    }
  });

  req.on('aborted', () => proxyReq.destroy());
  req.pipe(proxyReq);
}

function forwardWebSocketUpgrade(req, clientSocket, head, targetUrl) {
  const target = resolveUpstreamTargetUrl(req.url || '/ws', targetUrl);
  if (!target) {
    if (!clientSocket.destroyed) {
      clientSocket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    }
    clientSocket.destroy();
    return;
  }
  const isTls = target.protocol === 'https:' || target.protocol === 'wss:';
  const port = Number(target.port || (isTls ? 443 : 80));

  const upstreamSocket = isTls
    ? tls.connect({ host: target.hostname, port, servername: target.hostname })
    : net.connect({ host: target.hostname, port });

  clientSocket.setTimeout(0);
  clientSocket.setNoDelay(true);
  clientSocket.setKeepAlive(true, 15000);

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    if (!clientSocket.destroyed) clientSocket.destroy();
    if (!upstreamSocket.destroyed) upstreamSocket.destroy();
  };

  upstreamSocket.on('error', () => {
    if (!clientSocket.destroyed && clientSocket.writable) {
      clientSocket.write('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
    }
    cleanup();
  });

  clientSocket.on('error', cleanup);
  clientSocket.on('close', cleanup);
  upstreamSocket.on('close', cleanup);

  upstreamSocket.on('connect', () => {
    upstreamSocket.setTimeout(0);
    upstreamSocket.setNoDelay(true);
    upstreamSocket.setKeepAlive(true, 15000);
    const rawHeaders = [];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      if (String(req.rawHeaders[i]).toLowerCase() === 'x-vertice-control-token') {
        continue;
      }
      rawHeaders.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
    }
    const requestHead =
      `${req.method || 'GET'} ${target.pathname}${target.search} HTTP/${req.httpVersion || '1.1'}\r\n` +
      rawHeaders.join('\r\n') +
      '\r\n\r\n';
    upstreamSocket.write(requestHead);
    if (head && head.length > 0) {
      upstreamSocket.write(head);
    }
    upstreamSocket.pipe(clientSocket);
    clientSocket.pipe(upstreamSocket);
  });
}

export async function startVerticeServer(options = {}) {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const rootDir = options.rootDir ?? path.resolve(scriptDir, '..');
  const fileEnv = loadEnvFiles(rootDir);

  const host = String(
    options.host ??
    process.env.VERTICE_HOST ??
    process.env.HOST ??
    fileEnv.VERTICE_HOST ??
    fileEnv.HOST ??
    '127.0.0.1',
  ).trim();
  const port = Number(
    options.port ??
    process.env.VERTICE_PORT ??
    process.env.PORT ??
    fileEnv.VERTICE_PORT ??
    fileEnv.PORT ??
    4173,
  );
  const allowNonLoopback =
    options.allowNonLoopback ??
    (process.env.ALLOW_NON_LOOPBACK === 'true' ||
      fileEnv.ALLOW_NON_LOOPBACK === 'true');
  const distDir = options.distDir ?? path.join(rootDir, 'dist');
  const proxyTarget = String(
    options.proxyTarget ??
    process.env.VITE_AIONCORE_PROXY_TARGET ??
    fileEnv.VITE_AIONCORE_PROXY_TARGET ??
    '',
  ).trim();
  const allowedWorkspaces = Array.isArray(options.allowedWorkspaces)
    ? options.allowedWorkspaces
    : undefined;
  const allowedWorkspacesEnv = String(
    process.env.VERTICE_ALLOWED_WORKSPACES ??
    fileEnv.VERTICE_ALLOWED_WORKSPACES ??
    process.env.VERTICE_WORKSPACE_ROOT ??
    fileEnv.VERTICE_WORKSPACE_ROOT ??
    '',
  ).trim();
  const instanceId = String(
    options.instanceId ?? process.env.VERTICE_INSTANCE_ID ?? '',
  ).trim();
  const controlToken = String(
    options.controlToken ?? process.env.VERTICE_CONTROL_TOKEN ?? '',
  ).trim();
  const startedAt = String(
    options.startedAt ??
    process.env.VERTICE_STARTED_AT ??
    new Date().toISOString(),
  ).trim();
  const onControlShutdown =
    typeof options.onControlShutdown === 'function'
      ? options.onControlShutdown
      : null;
  const controlEnabled = Boolean(instanceId && controlToken);

  if (!allowNonLoopback && !isLoopbackHost(host)) {
    throw new Error(
      `Host "${host}" recusado: por segurança na v1, o servidor local do Vértice Workspace aceita apenas loopback (127.0.0.1, localhost ou ::1).`,
    );
  }

  if (!fs.existsSync(path.join(distDir, 'index.html'))) {
    throw new Error(
      `Build estático não encontrado em "${distDir}". Execute "npm run build" antes de iniciar o servidor local.`,
    );
  }

  if (proxyTarget) {
    // Validate URL syntax upfront
    new URL(proxyTarget);
  }

  let actualPort = port;
  let shuttingDown = false;
  const activeSockets = new Set();
  let server;

  const closeServer = () =>
    new Promise((resolve) => {
      for (const socket of activeSockets) {
        socket.destroy();
      }
      server?.closeAllConnections?.();
      if (!server) {
        resolve();
        return;
      }
      server.close(() => resolve());
    });

  server = http.createServer((req, res) => {
    try {
      const reqUrl = req.url || '/';
      const decodedPath = safeDecodePathname(reqUrl);
      if (!decodedPath.ok) {
        sendPlainText(res, 400, 'Bad Request');
        return;
      }

      if (
        decodedPath.pathname === '/__vertice_ctl/identity' ||
        decodedPath.pathname === '/__vertice_ctl/shutdown'
      ) {
        if (!controlEnabled) {
          sendPlainText(res, 404, 'Not Found');
          return;
        }
        if (!isAuthorizedControlRequest(req, controlToken)) {
          sendJson(res, 403, {
            ok: false,
            error: 'Token de controle inválido ou ausente.',
          });
          return;
        }
        if (decodedPath.pathname === '/__vertice_ctl/identity') {
          if (req.method !== 'GET') {
            sendPlainText(res, 405, 'Method Not Allowed');
            return;
          }
          sendJson(res, 200, {
            ok: true,
            service: 'vertice-server',
            instanceId,
            pid: process.pid,
            host,
            port: actualPort,
            startedAt,
          });
          return;
        }
        if (req.method !== 'POST') {
          sendPlainText(res, 405, 'Method Not Allowed');
          return;
        }
        res.setHeader('Connection', 'close');
        sendJson(res, 202, {
          ok: true,
          shuttingDown: true,
          instanceId,
          pid: process.pid,
        });
        if (!shuttingDown) {
          shuttingDown = true;
          const triggerClose = async () => {
            await closeServer();
            if (onControlShutdown) {
              await onControlShutdown();
            }
          };
          res.once('finish', () => {
            setImmediate(() => void triggerClose());
          });
        }
        return;
      }

      if (
        assistantSourceReader &&
        assistantSourceReader.shouldHandleAssistantSourcePath(reqUrl)
      ) {
        assistantSourceReader.handleAssistantSourceRequest(req, res, rootDir);
        return;
      }

      if (
        localFolderPicker &&
        localFolderPicker.shouldHandleLocalFolderRequest(reqUrl)
      ) {
        localFolderPicker.handleLocalFolderRequest(req, res);
        return;
      }

      if (
        workspaceDiffReader &&
        workspaceDiffReader.shouldHandleWorkspaceDiffRequest(reqUrl)
      ) {
        void workspaceDiffReader.handleWorkspaceDiffRequest(req, res, {
          rootDir,
          allowedWorkspaces,
          allowedWorkspacesEnv,
        });
        return;
      }

      if (shouldProxyHttpPath(reqUrl)) {
        if (!proxyTarget) {
          sendJson(res, 503, {
            success: false,
            message:
              'VITE_AIONCORE_PROXY_TARGET não configurado para o proxy local.',
          });
          return;
        }
        forwardHttpRequest(req, res, proxyTarget);
        return;
      }

      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendPlainText(res, 405, 'Method Not Allowed');
        return;
      }

      const match = resolveDistFile(distDir, reqUrl);
      if (match && 'invalidUrl' in match) {
        sendPlainText(res, 400, 'Bad Request');
        return;
      }
      if (!match) {
        sendPlainText(res, 404, 'Not Found');
        return;
      }

      const ext = path.extname(match.filePath).toLowerCase();
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';
      const isHtml = ext === '.html';
      const cacheControl = isHtml
        ? 'no-store'
        : match.filePath.includes(`${path.sep}assets${path.sep}`)
          ? 'public, max-age=31536000, immutable'
          : 'public, max-age=3600';

      const stat = fs.statSync(match.filePath);
      res.writeHead(200, {
        'Content-Type': contentType,
        'Content-Length': stat.size,
        'Cache-Control': cacheControl,
        'X-Content-Type-Options': 'nosniff',
      });

      if (req.method === 'HEAD') {
        res.end();
        return;
      }

      fs.createReadStream(match.filePath).pipe(res);
    } catch {
      if (!res.headersSent) {
        sendPlainText(res, 500, 'Internal Server Error');
      } else {
        res.destroy();
      }
    }
  });

  server.on('clientError', (_err, socket) => {
    if (socket.writable && !socket.destroyed) {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    } else if (!socket.destroyed) {
      socket.destroy();
    }
  });

  server.on('connection', (socket) => {
    activeSockets.add(socket);
    socket.once('close', () => activeSockets.delete(socket));
  });

  server.on('upgrade', (req, socket, head) => {
    activeSockets.add(socket);
    socket.once('close', () => activeSockets.delete(socket));
    const reqUrl = req.url || '/';
    const decodedPath = safeDecodePathname(reqUrl);
    if (!decodedPath.ok) {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    if (!shouldProxyWsPath(reqUrl)) {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    if (!proxyTarget) {
      socket.write(
        'HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n',
      );
      socket.destroy();
      return;
    }
    forwardWebSocketUpgrade(req, socket, head, proxyTarget);
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const addr = server.address();
  actualPort = typeof addr === 'object' && addr ? addr.port : port;
  const origin = `http://${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}:${actualPort}`;

  return {
    server,
    host,
    port: actualPort,
    origin,
    instanceId: instanceId || null,
    proxyTarget: proxyTarget || null,
    close: closeServer,
  };
}

const isEntrypoint =
  Boolean(process.argv[1]) &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntrypoint) {
  nodeCompat?.assertSupportedNodeVersion('start');
  try {
    let instance = null;
    instance = await startVerticeServer({
      onControlShutdown: () => {
        process.exit(0);
      },
    });
    console.log(
      `[Vértice Workspace] Servidor local ativo em ${instance.origin} (proxy Core: ${instance.proxyTarget ?? 'não configurado'})`,
    );
    const shutdown = async () => {
      await instance.close();
      process.exit(0);
    };
    process.on('SIGINT', () => void shutdown());
    process.on('SIGTERM', () => void shutdown());
  } catch (err) {
    console.error(
      `[Vértice Workspace] Erro ao iniciar servidor: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }
}
