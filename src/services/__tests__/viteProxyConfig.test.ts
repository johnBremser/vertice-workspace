import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

function createWsAccept(key: string): string {
  return crypto
    .createHash('sha1')
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest('base64');
}

function buildTextFrame(text: string): Buffer {
  const payload = Buffer.from(text, 'utf8');
  if (payload.length > 125) {
    throw new Error('Test frame helper supports <= 125 bytes');
  }
  return Buffer.from([0x81, payload.length, ...payload]);
}

describe('Vite .env.local proxy configuration (Fix 6)', () => {
  it('loads VITE_AIONCORE_PROXY_TARGET from .env.local in a fresh process and forwards /health, /api, /login, /logout and /ws upgrade', async () => {
    const receivedRequests: { method: string; url: string }[] = [];
    let wsUpgrades = 0;

    // 1. Upstream local Core HTTP + WS fixture server
    const upstreamServer = http.createServer((req, res) => {
      receivedRequests.push({
        method: req.method ?? 'GET',
        url: req.url ?? '/',
      });
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/health') {
        res.end(JSON.stringify({ status: 'ok', version: '0.2.2', build_time: 'test' }));
        return;
      }
      if (req.url === '/api/teams') {
        res.end(JSON.stringify({ success: true, data: [{ id: 'team_proxy_1' }] }));
        return;
      }
      if (req.url === '/login') {
        res.end(JSON.stringify({ success: true, user: { id: 'u1', username: 'proxy_user' } }));
        return;
      }
      if (req.url === '/logout') {
        res.end(JSON.stringify({ success: true }));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ success: false }));
    });

    const upstreamSockets = new Set<import('node:stream').Duplex>();
    upstreamServer.on('connection', (socket) => {
      upstreamSockets.add(socket);
      socket.on('error', () => { });
      socket.once('close', () => upstreamSockets.delete(socket));
    });

    upstreamServer.on('upgrade', (req, socket) => {
      upstreamSockets.add(socket);
      socket.on('error', () => { });
      socket.once('close', () => upstreamSockets.delete(socket));
      if (!req.url?.startsWith('/ws')) {
        socket.destroy();
        return;
      }
      wsUpgrades += 1;
      const key = String(req.headers['sec-websocket-key'] ?? '');
      const proto = req.headers['sec-websocket-protocol'];
      const accept = createWsAccept(key);
      const headers = [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${accept}`,
        ...(proto
          ? [`Sec-WebSocket-Protocol: ${String(proto).split(',')[0].trim()}`]
          : []),
        '',
        '',
      ];
      socket.write(headers.join('\r\n'));
      socket.write(buildTextFrame(JSON.stringify({ name: 'proxy.ws.ok', data: { ok: true } })));
    });

    await new Promise<void>((resolve) => {
      upstreamServer.listen(0, '127.0.0.1', () => resolve());
    });
    const upstreamAddr = upstreamServer.address();
    if (!upstreamAddr || typeof upstreamAddr === 'string') {
      throw new Error('Failed to bind upstream fixture server');
    }
    const upstreamPort = upstreamAddr.port;

    // 2. Temporary directory containing ONLY .env.local
    const tempEnvDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aion-envlocal-'));
    let childProc: ChildProcess | null = null;

    try {
      await fs.writeFile(
        path.join(tempEnvDir, '.env.local'),
        [
          'VITE_AIONCORE_BASE_URL=""',
          `VITE_AIONCORE_PROXY_TARGET="http://127.0.0.1:${upstreamPort}"`,
        ].join('\n'),
        'utf8',
      );

      const repoRoot = process.cwd();
      const childScript = `
        import { createServer, resolveConfig } from ${JSON.stringify(pathToFileURL(path.join(repoRoot, 'node_modules/vite/dist/node/index.js')).href)};
        const configFile = ${JSON.stringify(path.join(repoRoot, 'vite.config.ts'))};
        const resolved = await resolveConfig({ configFile, root: ${JSON.stringify(repoRoot)}, mode: 'development' }, 'serve');
        const hasProxy = Boolean(resolved.server?.proxy?.['/api'] && resolved.server?.proxy?.['/ws']);
        const server = await createServer({
          configFile,
          root: ${JSON.stringify(repoRoot)},
          logLevel: 'silent',
          server: { port: 0, host: '127.0.0.1', strictPort: false },
        });
        await server.listen();
        const addr = server.httpServer?.address();
        const port = typeof addr === 'object' && addr ? addr.port : 0;
        process.stdout.write(JSON.stringify({ ready: true, port, hasProxy }) + '\\n');
        setInterval(() => {}, 10000);
      `;

      const childEnv: Record<string, string | undefined> = {
        ...process.env,
        NODE_ENV: 'development',
        DISABLE_HMR: 'true',
      };
      delete childEnv.VITE_AIONCORE_PROXY_TARGET;
      delete childEnv.VITE_AIONCORE_BASE_URL;
      delete childEnv.VITEST;
      delete childEnv.VITEST_WORKER_ID;
      delete childEnv.VITEST_POOL_ID;

      childProc = spawn(
        process.execPath,
        ['--input-type=module', '-e', childScript],
        {
          cwd: tempEnvDir,
          env: childEnv,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );

      const bootInfo = await new Promise<{
        ready: boolean;
        port: number;
        hasProxy: boolean;
      }>((resolve, reject) => {
        let stderr = '';
        let stdout = '';
        const timer = setTimeout(() => {
          reject(new Error(`Vite proxy child timeout. stdout=${stdout} stderr=${stderr}`));
        }, 12000);

        childProc!.stdout?.on('data', (chunk) => {
          stdout += chunk.toString();
          const lines = stdout.trim().split('\n');
          for (const line of lines) {
            try {
              const parsed = JSON.parse(line) as {
                ready?: boolean;
                port?: number;
                hasProxy?: boolean;
              };
              if (parsed.ready && parsed.port) {
                clearTimeout(timer);
                resolve({
                  ready: true,
                  port: parsed.port,
                  hasProxy: Boolean(parsed.hasProxy),
                });
              }
            } catch {
              // ignore non-JSON Vite noise
            }
          }
        });
        childProc!.stderr?.on('data', (chunk) => {
          stderr += chunk.toString();
        });
        childProc!.on('exit', (code) => {
          clearTimeout(timer);
          reject(new Error(`Vite child exited early (${code}). stdout=${stdout} stderr=${stderr}`));
        });
      });

      expect(bootInfo.hasProxy).toBe(true);
      const viteBase = `http://127.0.0.1:${bootInfo.port}`;

      // 3. Verify HTTP proxy routes (/health, /api/teams, /login, /logout)
      const rHealth = await fetch(`${viteBase}/health`, {
        headers: { Connection: 'close' },
        signal: AbortSignal.timeout(4000),
      });
      expect(rHealth.status).toBe(200);
      expect(await rHealth.json()).toMatchObject({ status: 'ok', version: '0.2.2' });

      const rTeams = await fetch(`${viteBase}/api/teams`, {
        headers: { Connection: 'close' },
        signal: AbortSignal.timeout(4000),
      });
      expect(rTeams.status).toBe(200);
      expect(await rTeams.json()).toMatchObject({
        success: true,
        data: [{ id: 'team_proxy_1' }],
      });

      const rLogin = await fetch(`${viteBase}/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Connection: 'close' },
        body: JSON.stringify({ username: 'a', password: 'b' }),
        signal: AbortSignal.timeout(4000),
      });
      expect(rLogin.status).toBe(200);
      expect(await rLogin.json()).toMatchObject({ success: true });

      const rLogout = await fetch(`${viteBase}/logout`, {
        method: 'POST',
        headers: { Connection: 'close' },
        signal: AbortSignal.timeout(4000),
      });
      expect(rLogout.status).toBe(200);

      expect(receivedRequests.map((r) => `${r.method} ${r.url}`)).toEqual([
        'GET /health',
        'GET /api/teams',
        'POST /login',
        'POST /logout',
      ]);

      // 4. Verify WebSocket /ws upgrade reaches upstream fixture via Vite proxy
      const wsKey = crypto.randomBytes(16).toString('base64');
      const wsResult = await new Promise<string>((resolve, reject) => {
        const client = net.createConnection(
          { host: '127.0.0.1', port: bootInfo.port },
          () => {
            client.write(
              [
                `GET /ws HTTP/1.1`,
                `Host: 127.0.0.1:${bootInfo.port}`,
                'Upgrade: websocket',
                'Connection: Upgrade',
                `Sec-WebSocket-Key: ${wsKey}`,
                'Sec-WebSocket-Version: 13',
                'Sec-WebSocket-Protocol: ws_jwt_proxy',
                '',
                '',
              ].join('\r\n'),
            );
          },
        );
        const chunks: Buffer[] = [];
        const timer = setTimeout(() => {
          client.destroy();
          reject(new Error(`WS upgrade via proxy timed out. partial=${Buffer.concat(chunks).toString('utf8')}`));
        }, 5000);
        client.on('data', (chunk) => {
          chunks.push(chunk);
          const joined = Buffer.concat(chunks).toString('utf8');
          if (joined.includes('proxy.ws.ok')) {
            clearTimeout(timer);
            client.destroy();
            resolve(joined);
          }
        });
        client.on('error', (err) => {
          clearTimeout(timer);
          reject(err);
        });
      });

      expect(wsResult).toContain('101 Switching Protocols');
      expect(wsResult).toContain('proxy.ws.ok');
      expect(wsUpgrades).toBe(1);
    } finally {
      for (const sock of upstreamSockets) {
        sock.destroy();
      }
      upstreamServer.closeAllConnections?.();
      if (childProc && childProc.exitCode === null) {
        const exited = new Promise<void>((resolve) => {
          childProc!.once('exit', () => resolve());
        });
        childProc.kill('SIGKILL');
        await Promise.race([
          exited,
          new Promise<void>((resolve) => setTimeout(resolve, 1500)),
        ]);
      }
      await Promise.race([
        new Promise<void>((resolve) => upstreamServer.close(() => resolve())),
        new Promise<void>((resolve) => setTimeout(resolve, 500)),
      ]);
      await fs
        .rm(tempEnvDir, {
          recursive: true,
          force: true,
          maxRetries: 5,
          retryDelay: 50,
        })
        .catch(() => { });
    }
  }, 20_000);
});
