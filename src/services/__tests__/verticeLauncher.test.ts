import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { isSupportedNodeVersion } from '../../../scripts/vertice-ctl.mjs';

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

async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

async function createIsolatedWorkspace() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vertice-ctl-test-'));
  await fs.mkdir(path.join(dir, 'scripts'), { recursive: true });
  await fs.mkdir(path.join(dir, 'dist'), { recursive: true });
  await fs.mkdir(path.join(dir, '.vertice'), { recursive: true });
  await fs.copyFile(
    path.join(REPO_ROOT, 'scripts', 'vertice-ctl.mjs'),
    path.join(dir, 'scripts', 'vertice-ctl.mjs'),
  );
  await fs.copyFile(
    path.join(REPO_ROOT, 'scripts', 'vertice-server.mjs'),
    path.join(dir, 'scripts', 'vertice-server.mjs'),
  );
  await fs.writeFile(
    path.join(dir, 'dist', 'index.html'),
    '<!doctype html><html><body>Vértice Test Dist</body></html>',
  );
  cleanups.push(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });
  return dir;
}

async function runCtl(
  workDir: string,
  command: 'doctor' | 'start' | 'status' | 'stop',
  port: number,
  options?: { useDotEnv?: boolean },
) {
  return await new Promise<{
    code: number | null;
    stdout: string;
    stderr: string;
  }>((resolve, reject) => {
    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      VERTICE_HOST: '127.0.0.1',
      VERTICE_PORT: String(port),
    };
    if (options?.useDotEnv) {
      delete childEnv.VITE_AIONCORE_PROXY_TARGET;
      delete childEnv.VITE_AIONCORE_BASE_URL;
    } else {
      childEnv.VITE_AIONCORE_PROXY_TARGET = '';
    }
    const child = spawn(
      process.execPath,
      [path.join(workDir, 'scripts', 'vertice-ctl.mjs'), command],
      {
        cwd: workDir,
        windowsHide: true,
        env: childEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => {
      stdout += c.toString();
    });
    child.stderr.on('data', (c) => {
      stderr += c.toString();
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

function spawnDisposableChild(script: string): ChildProcess {
  const child = spawn(process.execPath, ['-e', script], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  cleanups.push(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await new Promise((r) => child.once('exit', r));
    }
  });
  return child;
}

function isPidRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('Launcher identity & lifecycle safety (V6-00)', () => {
  it('validates the exact engines.node range (^22.12.0 || ^24.0.0 || >=26.0.0)', () => {
    expect(isSupportedNodeVersion('20.18.1')).toBe(false);
    expect(isSupportedNodeVersion('22.11.9')).toBe(false);
    expect(isSupportedNodeVersion('22.12.0')).toBe(true);
    expect(isSupportedNodeVersion('23.1.0')).toBe(false);
    expect(isSupportedNodeVersion('24.11.0')).toBe(true);
    expect(isSupportedNodeVersion('25.5.0')).toBe(false);
    expect(isSupportedNodeVersion('26.0.0')).toBe(true);
  });

  it('handles missing, dead, and corrupt/legacy server.json safely without terminating unrelated PIDs', async () => {
    const workDir = await createIsolatedWorkspace();
    const port = await getFreePort();

    // 1. Missing server.json
    const statusMissing = await runCtl(workDir, 'status', port);
    expect(statusMissing.code).toBe(0);
    expect(statusMissing.stdout).toMatch(/parado/i);

    const stopMissing = await runCtl(workDir, 'stop', port);
    expect(stopMissing.code).toBe(0);
    expect(stopMissing.stdout).toMatch(/Nenhum servidor rastreado/i);

    // 2. Corrupt JSON
    await fs.writeFile(path.join(workDir, '.vertice', 'server.json'), '{bad json');
    const statusInvalid = await runCtl(workDir, 'status', port);
    expect(statusInvalid.code).toBe(0);
    expect(statusInvalid.stdout).toMatch(/não verificado|inválido/i);

    const stopInvalid = await runCtl(workDir, 'stop', port);
    expect(stopInvalid.code).toBe(1);
    expect(stopInvalid.stderr).toMatch(/Recusado/i);

    // 3. Legacy v1 metadata pointing to a live disposable process (no instanceId/controlToken)
    const dummy = spawnDisposableChild(
      'console.log("ready"); setInterval(() => {}, 1000);',
    );
    await new Promise<void>((resolve) => {
      dummy.stdout!.once('data', () => resolve());
    });
    expect(dummy.pid).toBeDefined();

    await fs.writeFile(
      path.join(workDir, '.vertice', 'server.json'),
      JSON.stringify({
        pid: dummy.pid,
        host: '127.0.0.1',
        port,
        origin: `http://127.0.0.1:${port}`,
        startedAt: '2026-01-01T00:00:00.000Z',
        script: 'scripts/vertice-server.mjs',
      }),
    );

    const stopLegacy = await runCtl(workDir, 'stop', port);
    expect(stopLegacy.code).toBe(1);
    expect(stopLegacy.stderr).toMatch(/Recusado/i);
    expect(dummy.exitCode).toBeNull();
    expect(isPidRunning(dummy.pid!)).toBe(true);

    // 4. Dead PID cleanup
    const deadChild = spawnDisposableChild('process.exit(0);');
    await new Promise((r) => deadChild.once('exit', r));
    await fs.writeFile(
      path.join(workDir, '.vertice', 'server.json'),
      JSON.stringify({
        schemaVersion: 2,
        pid: deadChild.pid,
        host: '127.0.0.1',
        port,
        origin: `http://127.0.0.1:${port}`,
        instanceId: 'dead-inst',
        controlToken: 'dead-token',
        startedAt: '2026-01-01T00:00:00.000Z',
        script: 'scripts/vertice-server.mjs',
      }),
    );
    const stopDead = await runCtl(workDir, 'stop', port);
    expect(stopDead.code).toBe(0);
    expect(stopDead.stdout).toMatch(/já estava encerrado/i);
    await expect(
      fs.access(path.join(workDir, '.vertice', 'server.json')),
    ).rejects.toThrow();
  });

  it('refuses to stop an unrelated live process or foreign HTTP server when PID is reused (stale PID)', async () => {
    const workDir = await createIsolatedWorkspace();
    const port = await getFreePort();

    // Case A: unrelated non-HTTP process holding the stale PID
    const dummy = spawnDisposableChild(
      'console.log("dummy-ready"); setInterval(() => {}, 1000);',
    );
    await new Promise<void>((resolve) => {
      dummy.stdout!.once('data', () => resolve());
    });

    await fs.writeFile(
      path.join(workDir, '.vertice', 'server.json'),
      JSON.stringify({
        schemaVersion: 2,
        pid: dummy.pid,
        host: '127.0.0.1',
        port,
        origin: `http://127.0.0.1:${port}`,
        instanceId: 'stale-inst-1',
        controlToken: 'stale-token-1',
        startedAt: '2026-01-01T00:00:00.000Z',
        script: 'scripts/vertice-server.mjs',
      }),
    );

    const doctor = await runCtl(workDir, 'doctor', port, { useDotEnv: true });
    expect(doctor.code).toBe(0);
    expect(doctor.stdout).toMatch(/NÃO comprovado/i);

    const status = await runCtl(workDir, 'status', port);
    expect(status.code).toBe(0);
    expect(status.stdout).toMatch(/não verificado/i);

    const stop = await runCtl(workDir, 'stop', port);
    expect(stop.code).toBe(1);
    expect(stop.stderr).toMatch(/Recusado/i);
    expect(dummy.exitCode).toBeNull();
    expect(isPidRunning(dummy.pid!)).toBe(true);

    // Case B: unrelated HTTP server listening on that port and returning 200 JSON without matching instanceId
    const foreignServer = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: true,
          service: 'vertice-server',
          instanceId: 'other-instance',
          pid: dummy.pid,
        }),
      );
    });
    await new Promise<void>((resolve) => {
      foreignServer.listen(port, '127.0.0.1', () => resolve());
    });
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          foreignServer.closeAllConnections?.();
          foreignServer.close(() => resolve());
        }),
    );

    const stopForeign = await runCtl(workDir, 'stop', port);
    expect(stopForeign.code).toBe(1);
    expect(stopForeign.stderr).toMatch(/Recusado/i);
    expect(isPidRunning(dummy.pid!)).toBe(true);
  });

  it('refuses start when port is occupied by another process, handles duplicate start, and completes full verified lifecycle', async () => {
    const workDir = await createIsolatedWorkspace();
    const occupiedPort = await getFreePort();

    // 1. Occupied port prevents start without touching foreign server
    const foreignServer = http.createServer((_req, res) => {
      res.writeHead(200);
      res.end('foreign');
    });
    await new Promise<void>((resolve) => {
      foreignServer.listen(occupiedPort, '127.0.0.1', () => resolve());
    });
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          foreignServer.closeAllConnections?.();
          foreignServer.close(() => resolve());
        }),
    );

    const startOccupied = await runCtl(workDir, 'start', occupiedPort);
    expect(startOccupied.code).toBe(1);
    expect(startOccupied.stderr).toMatch(/ocupada/i);

    // 2. Full lifecycle on a free port
    const port = await getFreePort();
    const start1 = await runCtl(workDir, 'start', port);
    expect(start1.code).toBe(0);
    expect(start1.stdout).toMatch(/iniciado e verificado/i);

    const metaRaw = await fs.readFile(
      path.join(workDir, '.vertice', 'server.json'),
      'utf8',
    );
    if (process.platform === 'win32') {
      const aclOut = execFileSync('icacls', [path.join(workDir, '.vertice', 'server.json')], {
        encoding: 'utf8',
        windowsHide: true,
      });
      // Inheritance removed (/inheritance:r) so inherited Users/Everyone ACEs do not remain (V6-09 P3 fix)
      expect(aclOut).not.toMatch(/\(I\)/);
      expect(aclOut).not.toMatch(/Everyone|BUILTIN\\Users/i);
    }
    const meta1 = JSON.parse(metaRaw) as {
      pid: number;
      instanceId: string;
      controlToken: string;
      origin: string;
    };
    cleanups.push(async () => {
      if (isPidRunning(meta1.pid)) {
        await runCtl(workDir, 'stop', port);
      }
    });

    // Duplicate start keeps the exact same verified instance
    const start2 = await runCtl(workDir, 'start', port);
    expect(start2.code).toBe(0);
    expect(start2.stdout).toMatch(/já está em execução e verificado/i);
    const meta2 = JSON.parse(
      await fs.readFile(path.join(workDir, '.vertice', 'server.json'), 'utf8'),
    ) as { pid: number; instanceId: string };
    expect(meta2.pid).toBe(meta1.pid);
    expect(meta2.instanceId).toBe(meta1.instanceId);

    const doctor = await runCtl(workDir, 'doctor', port, { useDotEnv: true });
    expect(doctor.code).toBe(0);
    expect(doctor.stdout).toMatch(/em uso pela instância verificada/i);

    const statusUp = await runCtl(workDir, 'status', port);
    expect(statusUp.code).toBe(0);
    expect(statusUp.stdout).toMatch(/ativo e verificado/i);

    // Malformed URL resilience against live launcher-managed server
    const malformed = await fetch(`${meta1.origin}/%ZZ`);
    expect(malformed.status).toBe(400);
    const healthy = await fetch(`${meta1.origin}/`);
    expect(healthy.status).toBe(200);
    expect(await healthy.text()).toContain('Vértice Test Dist');

    // Graceful verified stop
    const stop = await runCtl(workDir, 'stop', port);
    expect(stop.code).toBe(0);
    expect(stop.stdout).toMatch(/encerrado com segurança/i);
    expect(isPidRunning(meta1.pid)).toBe(false);

    const statusAfter = await runCtl(workDir, 'status', port);
    expect(statusAfter.code).toBe(0);
    expect(statusAfter.stdout).toMatch(/parado/i);
  }, 25_000);

  it('doctor detects missing dist/, malformed .env.local, unverified live PID, and prints concrete recovery steps without leaking controlToken (V6-08)', async () => {
    const workDir = await createIsolatedWorkspace();
    const port = await getFreePort();
    await fs.rm(path.join(workDir, 'dist', 'index.html'));
    await fs.writeFile(
      path.join(workDir, '.env.local'),
      'VITE_AIONCORE_PROXY_TARGET="not-a-valid-url"\nVITE_AIONCORE_BASE_URL="http://127.0.0.1:25828"\n',
    );

    const dummy = spawnDisposableChild(
      'console.log("ready"); setInterval(() => {}, 1000);',
    );
    await new Promise<void>((resolve) => {
      dummy.stdout!.once('data', () => resolve());
    });
    const secretControlToken = 'super-secret-control-token-v608';
    await fs.writeFile(
      path.join(workDir, '.vertice', 'server.json'),
      JSON.stringify({
        schemaVersion: 2,
        pid: dummy.pid,
        host: '127.0.0.1',
        port,
        origin: `http://127.0.0.1:${port}`,
        instanceId: 'unverified-inst-v608',
        controlToken: secretControlToken,
        startedAt: '2026-11-18T00:00:00.000Z',
        script: 'scripts/vertice-server.mjs',
      }),
    );

    const doctor = await runCtl(workDir, 'doctor', port, { useDotEnv: true });
    expect(doctor.code).toBe(0);
    expect(doctor.stdout).toContain('ausente (execute npm run build)');
    expect(doctor.stdout).toContain('URL inválida em VITE_AIONCORE_PROXY_TARGET');
    expect(doctor.stdout).toMatch(/NÃO comprovado/i);
    expect(doctor.stdout).toContain('Ações e recuperação');
    expect(doctor.stdout).toContain('npm run build');
    expect(doctor.stdout).toContain('VITE_AIONCORE_BASE_URL');
    expect(doctor.stdout).toMatch(/não encerrará esse PID alheio/i);
    expect(doctor.stdout).not.toContain(secretControlToken);

    // Valid URL pointing to a closed loopback port MUST report "inacessível", NOT "URL inválida"
    const closedCorePort = await getFreePort();
    await fs.writeFile(
      path.join(workDir, '.env.local'),
      `VITE_AIONCORE_PROXY_TARGET="http://127.0.0.1:${closedCorePort}"\nVITE_AIONCORE_BASE_URL=""\n`,
    );
    const doctorUnreachable = await runCtl(workDir, 'doctor', port, { useDotEnv: true });
    expect(doctorUnreachable.code).toBe(0);
    expect(doctorUnreachable.stdout).toContain('inacessível');
    expect(doctorUnreachable.stdout).toContain('inicie o binário externo AionCore');
    expect(doctorUnreachable.stdout).not.toContain('URL inválida');
  });
});
