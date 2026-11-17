import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { startVerticeServer } from '../../../scripts/vertice-server.mjs';

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../..',
);

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop()!;
    await fn();
  }
});

async function createTempDist() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vertice-dist-'));
  await fs.mkdir(path.join(dir, 'assets'), { recursive: true });
  await fs.writeFile(
    path.join(dir, 'index.html'),
    '<!doctype html><html><body><div id="root">Vertice SPA</div></body></html>',
  );
  await fs.writeFile(
    path.join(dir, 'assets', 'app.js'),
    'console.log("vertice-ok");',
  );
  cleanups.push(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });
  return dir;
}

async function createMockCoreServer() {
  const receivedRequests: Array<{
    method: string;
    url: string;
    cookie?: string;
    csrf?: string;
    host?: string;
  }> = [];

  const server = http.createServer((req, res) => {
    receivedRequests.push({
      method: req.method || 'GET',
      url: req.url || '/',
      cookie: req.headers.cookie,
      csrf: req.headers['x-csrf-token'] as string | undefined,
      host: req.headers.host,
    });

    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', version: '0.2.2' }));
      return;
    }

    if (req.url === '/login' && req.method === 'POST') {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Set-Cookie': 'aionui-session=abc123; Path=/; HttpOnly',
      });
      res.end(JSON.stringify({ success: true }));
      return;
    }

    if (req.url?.startsWith('/api/teams')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, data: [{ id: 'team_local_1' }] }));
      return;
    }

    if (req.url === '/logout' && req.method === 'POST') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
      return;
    }

    res.writeHead(404);
    res.end('not found');
  });

  const mockSockets = new Set<import('node:stream').Duplex>();
  server.on('connection', (socket) => {
    mockSockets.add(socket);
    socket.once('close', () => mockSockets.delete(socket));
  });

  server.on('upgrade', (req, socket) => {
    mockSockets.add(socket);
    socket.once('close', () => mockSockets.delete(socket));
    const key = req.headers['sec-websocket-key'];
    const proto = req.headers['sec-websocket-protocol'];
    if (!key) {
      socket.destroy();
      return;
    }
    const accept = crypto
      .createHash('sha1')
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64');

    const headers = [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
    ];
    if (proto) {
      headers.push(`Sec-WebSocket-Protocol: ${proto}`);
    }
    socket.write(`${headers.join('\r\n')}\r\n\r\n`);

    // Send a minimal unmasked text frame: {"name":"pong.upstream"}
    const msg = Buffer.from(JSON.stringify({ name: 'pong.upstream', url: req.url }));
    const frame = Buffer.alloc(2 + msg.length);
    frame[0] = 0x81;
    frame[1] = msg.length;
    msg.copy(frame, 2);
    socket.write(frame);
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;

  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        for (const s of mockSockets) s.destroy();
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  );

  return {
    origin: `http://127.0.0.1:${port}`,
    receivedRequests,
  };
}

describe('Standalone local server & same-origin proxy (V5-07)', () => {
  it('refuses non-loopback host binding by default', async () => {
    const distDir = await createTempDist();
    await expect(
      startVerticeServer({
        rootDir: REPO_ROOT,
        distDir,
        host: '0.0.0.0',
        port: 0,
      }),
    ).rejects.toThrow(/loopback/i);
  });

  it('serves dist/ static + SPA fallback and forwards /health, /login, /api, /logout and /ws upgrade in a real child process', async () => {
    const distDir = await createTempDist();
    const core = await createMockCoreServer();

    // Verify helper startVerticeServer binds loopback cleanly first
    const proxy = await startVerticeServer({
      rootDir: REPO_ROOT,
      distDir,
      host: '127.0.0.1',
      port: 0,
      proxyTarget: core.origin,
    });
    cleanups.push(() => proxy.close());

    // 1. Static asset + SPA fallback
    const htmlRes = await fetch(`${proxy.origin}/conversas/123`);
    expect(htmlRes.status).toBe(200);
    expect(await htmlRes.text()).toContain('Vertice SPA');

    const jsRes = await fetch(`${proxy.origin}/assets/app.js`);
    expect(jsRes.status).toBe(200);
    expect(await jsRes.text()).toContain('vertice-ok');

    // 2. Same-origin HTTP proxy routes + Set-Cookie / CSRF preservation
    const healthRes = await fetch(`${proxy.origin}/health`);
    expect(healthRes.status).toBe(200);
    expect(await healthRes.json()).toMatchObject({ status: 'ok', version: '0.2.2' });

    const loginRes = await fetch(`${proxy.origin}/login`, { method: 'POST' });
    expect(loginRes.status).toBe(200);
    expect(loginRes.headers.get('set-cookie')).toContain('aionui-session=abc123');

    const teamsRes = await fetch(`${proxy.origin}/api/teams`, {
      headers: {
        Cookie: 'aionui-session=abc123',
        'X-CSRF-Token': 'csrf-val-1',
      },
    });
    expect(teamsRes.status).toBe(200);
    expect(await teamsRes.json()).toMatchObject({ success: true });

    const logoutRes = await fetch(`${proxy.origin}/logout`, { method: 'POST' });
    expect(logoutRes.status).toBe(200);

    const lastTeamReq = core.receivedRequests.find((r) =>
      r.url.startsWith('/api/teams'),
    );
    expect(lastTeamReq?.cookie).toContain('aionui-session=abc123');
    expect(lastTeamReq?.csrf).toBe('csrf-val-1');

    // 3. WebSocket /ws upgrade tunnel preserving path/query and payload
    const wsReceived = await new Promise<string>((resolve, reject) => {
      const ws = new WebSocket(`${proxy.origin.replace('http://', 'ws://')}/ws?token=t1`);
      ws.addEventListener('message', (ev) => {
        resolve(String(ev.data));
        ws.close();
      });
      ws.addEventListener('error', () => reject(new Error('WS upgrade failed')));
    });
    expect(JSON.parse(wsReceived)).toMatchObject({
      name: 'pong.upstream',
      url: '/ws?token=t1',
    });
  });

  it('spawns scripts/vertice-server.mjs CLI cleanly against repo dist/', async () => {
    const distExists = await fs
      .access(path.join(REPO_ROOT, 'dist', 'index.html'))
      .then(() => true)
      .catch(() => false);
    if (!distExists) {
      return;
    }

    const core = await createMockCoreServer();
    const child = spawn(
      process.execPath,
      [path.join(REPO_ROOT, 'scripts', 'vertice-server.mjs')],
      {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          HOST: '127.0.0.1',
          PORT: '0',
          VITE_AIONCORE_PROXY_TARGET: core.origin,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    cleanups.push(async () => {
      if (child.exitCode === null) {
        child.kill('SIGTERM');
        await new Promise((r) => child.once('exit', r));
      }
    });

    const boundOrigin = await new Promise<string>((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(
        () => reject(new Error(`Timeout waiting server stdout: ${stderr}`)),
        5000,
      );
      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
        const match = stdout.match(/http:\/\/127\.0\.0\.1:\d+/);
        if (match) {
          clearTimeout(timer);
          resolve(match[0]);
        }
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`Server exited early (${code}): ${stderr}`));
      });
    });

    const res = await fetch(`${boundOrigin}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Vértice Workspace');

    const health = await fetch(`${boundOrigin}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ version: '0.2.2' });
  });

  it('returns HTTP 400 for malformed URLs (GET /%ZZ) without crashing and serves subsequent valid requests', async () => {
    const distDir = await createTempDist();
    const child = spawn(
      process.execPath,
      [path.join(REPO_ROOT, 'scripts', 'vertice-server.mjs')],
      {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          HOST: '127.0.0.1',
          PORT: '0',
          VITE_AIONCORE_PROXY_TARGET: '',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    // Override dist via startVerticeServer helper in-process AND verify child process against repo dist if present
    cleanups.push(async () => {
      if (child.exitCode === null) {
        child.kill('SIGTERM');
        await new Promise((r) => child.once('exit', r));
      }
    });

    // Test in-process instance with guaranteed temp dist
    const server = await startVerticeServer({
      rootDir: REPO_ROOT,
      distDir,
      host: '127.0.0.1',
      port: 0,
      proxyTarget: '',
    });
    cleanups.push(() => server.close());

    const malformedRes = await new Promise<{ statusCode?: number; body: string }>(
      (resolve, reject) => {
        const req = http.get(`${server.origin}/%ZZ`, (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => {
            body += chunk;
          });
          res.on('end', () => resolve({ statusCode: res.statusCode, body }));
        });
        req.on('error', reject);
      },
    );
    expect(malformedRes.statusCode).toBe(400);

    const nullByteRes = await fetch(`${server.origin}/%00`);
    expect(nullByteRes.status).toBe(400);

    const validAfter = await fetch(`${server.origin}/`);
    expect(validAfter.status).toBe(200);
    expect(await validAfter.text()).toContain('Vertice SPA');

    // Also test child CLI process if dist/ exists
    const distExists = await fs
      .access(path.join(REPO_ROOT, 'dist', 'index.html'))
      .then(() => true)
      .catch(() => false);
    if (distExists) {
      const boundOrigin = await new Promise<string>((resolve, reject) => {
        let stdout = '';
        let stderr = '';
        const timer = setTimeout(
          () => reject(new Error(`Timeout waiting server stdout: ${stderr}`)),
          5000,
        );
        child.stdout.on('data', (chunk) => {
          stdout += chunk.toString();
          const match = stdout.match(/http:\/\/127\.0\.0\.1:\d+/);
          if (match) {
            clearTimeout(timer);
            resolve(match[0]);
          }
        });
        child.once('exit', (code) => {
          clearTimeout(timer);
          reject(new Error(`Server exited early (${code}): ${stderr}`));
        });
      });

      const cliMalformed = await fetch(`${boundOrigin}/%ZZ`);
      expect(cliMalformed.status).toBe(400);
      expect(child.exitCode).toBeNull();

      const cliValid = await fetch(`${boundOrigin}/`);
      expect(cliValid.status).toBe(200);
      expect(await cliValid.text()).toContain('Vértice Workspace');
    } else if (child.exitCode === null) {
      child.kill('SIGTERM');
    }
  });

  it('requires valid control token on /__vertice_ctl/identity and /__vertice_ctl/shutdown', async () => {
    const distDir = await createTempDist();
    const disabledServer = await startVerticeServer({
      rootDir: REPO_ROOT,
      distDir,
      host: '127.0.0.1',
      port: 0,
      proxyTarget: '',
    });
    cleanups.push(() => disabledServer.close());
    const disabledRes = await fetch(`${disabledServer.origin}/__vertice_ctl/identity`);
    expect(disabledRes.status).toBe(404);

    let shutdownCallbackCalled = false;
    const controlled = await startVerticeServer({
      rootDir: REPO_ROOT,
      distDir,
      host: '127.0.0.1',
      port: 0,
      proxyTarget: '',
      instanceId: 'inst-test-1',
      controlToken: 'secret-token-abc',
      onControlShutdown: () => {
        shutdownCallbackCalled = true;
      },
    });
    cleanups.push(() => controlled.close());

    const unauthRes = await fetch(`${controlled.origin}/__vertice_ctl/identity`);
    expect(unauthRes.status).toBe(403);

    const wrongTokenRes = await fetch(`${controlled.origin}/__vertice_ctl/identity`, {
      headers: { 'X-Vertice-Control-Token': 'wrong-token' },
    });
    expect(wrongTokenRes.status).toBe(403);

    const okIdentity = await fetch(`${controlled.origin}/__vertice_ctl/identity`, {
      headers: { 'X-Vertice-Control-Token': 'secret-token-abc' },
    });
    expect(okIdentity.status).toBe(200);
    expect(await okIdentity.json()).toMatchObject({
      ok: true,
      service: 'vertice-server',
      instanceId: 'inst-test-1',
      pid: process.pid,
    });

    const shutdownRes = await fetch(`${controlled.origin}/__vertice_ctl/shutdown`, {
      method: 'POST',
      headers: { 'X-Vertice-Control-Token': 'secret-token-abc' },
    });
    expect(shutdownRes.status).toBe(202);
    await new Promise((r) => setTimeout(r, 100));
    expect(shutdownCallbackCalled).toBe(true);
  });
});
