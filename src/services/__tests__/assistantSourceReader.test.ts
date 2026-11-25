import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  handleAssistantSourceRequest,
  isAllowlistedRelativePath,
  listAllowlistedFiles,
  readAllowlistedFileSlice,
  searchAllowlistedFiles,
} from '../../../scripts/vertice-source-reader.mjs';
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

describe('Read-only Vertice source reader (vertice-source-reader.mjs)', () => {
  it('allows src/, docs/, scripts/ and selected root files while denying secrets, dotfiles and node_modules', () => {
    expect(isAllowlistedRelativePath('src/App.tsx')).toBe(true);
    expect(isAllowlistedRelativePath('docs/architecture.md')).toBe(true);
    expect(isAllowlistedRelativePath('scripts/vertice-server.mjs')).toBe(true);
    expect(isAllowlistedRelativePath('package.json')).toBe(true);
    expect(isAllowlistedRelativePath('vertice.config.json')).toBe(true);

    expect(isAllowlistedRelativePath('.env.local')).toBe(false);
    expect(isAllowlistedRelativePath('.env')).toBe(false);
    expect(isAllowlistedRelativePath('.vertice/server.json')).toBe(false);
    expect(isAllowlistedRelativePath('.git/config')).toBe(false);
    expect(isAllowlistedRelativePath('node_modules/react/index.js')).toBe(false);
    expect(isAllowlistedRelativePath('dist/index.html')).toBe(false);
    expect(isAllowlistedRelativePath('../secret.txt')).toBe(false);
    expect(isAllowlistedRelativePath('src/assets/icon.png')).toBe(false);
  });

  it('lists, reads bounded line slices, and searches real source files', () => {
    const files = listAllowlistedFiles(REPO_ROOT);
    expect(files.some((f) => f.path === 'src/App.tsx')).toBe(true);
    expect(files.some((f) => f.path === '.env.local')).toBe(false);

    const slice = readAllowlistedFileSlice(REPO_ROOT, 'src/config/brand.ts', 1, 20);
    expect(slice.ok).toBe(true);
    if (slice.ok && 'content' in slice) {
      expect(slice.content).toContain('Vértice Workspace');
      expect(slice.startLine).toBe(1);
    }

    const search = searchAllowlistedFiles(REPO_ROOT, 'AgentWorkspaceGateway', 5);
    expect(search.matches.length).toBeGreaterThan(0);
    expect(search.matches.some((m) => m.path === 'src/services/gateway.ts')).toBe(
      true,
    );
  });

  it('rejects symlink escapes outside rootDir', async () => {
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'vertice-reader-root-'));
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vertice-reader-out-'));
    cleanups.push(() => fs.rm(tmpRoot, { recursive: true, force: true }));
    cleanups.push(() => fs.rm(outsideDir, { recursive: true, force: true }));

    await fs.mkdir(path.join(tmpRoot, 'src'), { recursive: true });
    await fs.writeFile(path.join(tmpRoot, 'src', 'ok.ts'), 'export const ok = 1;\n');
    const outsideFile = path.join(outsideDir, 'secret.ts');
    await fs.writeFile(outsideFile, 'export const secret = "nope";\n');

    let symlinkCreated = false;
    try {
      await fs.symlink(outsideFile, path.join(tmpRoot, 'src', 'leak.ts'));
      symlinkCreated = true;
    } catch {
      symlinkCreated = false;
    }

    const okRes = readAllowlistedFileSlice(tmpRoot, 'src/ok.ts', 1, 10);
    expect(okRes.ok).toBe(true);

    if (symlinkCreated) {
      const leakRes = readAllowlistedFileSlice(tmpRoot, 'src/leak.ts', 1, 10);
      expect(leakRes.ok).toBe(false);
      if (!leakRes.ok && 'status' in leakRes) {
        expect(leakRes.status).toBe(403);
      }
    }
  });

  it('serves /__vertice_assistant/* read-only endpoints through vertice-server.mjs and rejects POST/secrets', async () => {
    const distDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vertice-ast-dist-'));
    cleanups.push(() => fs.rm(distDir, { recursive: true, force: true }));
    await fs.writeFile(
      path.join(distDir, 'index.html'),
      '<!doctype html><html><body>Vertice</body></html>',
    );

    const server = await startVerticeServer({
      rootDir: REPO_ROOT,
      distDir,
      host: '127.0.0.1',
      port: 0,
      proxyTarget: '',
    });
    cleanups.push(() => server.close());

    const metaRes = await fetch(`${server.origin}/__vertice_assistant/meta`);
    expect(metaRes.status).toBe(200);
    const metaJson = (await metaRes.json()) as {
      ok: boolean;
      accessMode: string;
      allowedDirs: string[];
    };
    expect(metaJson).toMatchObject({
      ok: true,
      accessMode: 'read_only',
    });
    expect(metaJson.allowedDirs).toContain('src');

    const fileRes = await fetch(
      `${server.origin}/__vertice_assistant/file?path=${encodeURIComponent('src/config/brand.ts')}&startLine=1&endLine=20`,
    );
    expect(fileRes.status).toBe(200);
    const fileJson = (await fileRes.json()) as { ok: boolean; content: string };
    expect(fileJson.ok).toBe(true);
    expect(fileJson.content).toContain('Vértice Workspace');

    const deniedSecret = await fetch(
      `${server.origin}/__vertice_assistant/file?path=${encodeURIComponent('.env.local')}`,
    );
    expect(deniedSecret.status).toBe(403);

    const deniedTraversal = await fetch(
      `${server.origin}/__vertice_assistant/file?path=${encodeURIComponent('../../Windows/win.ini')}`,
    );
    expect(deniedTraversal.status).toBe(403);

    const postDenied = await fetch(`${server.origin}/__vertice_assistant/meta`, {
      method: 'POST',
    });
    expect(postDenied.status).toBe(405);

    // Direct handler sanity check for unknown assistant route
    const directServer = http.createServer((req, res) => {
      handleAssistantSourceRequest(req, res, REPO_ROOT);
    });
    await new Promise<void>((r) => directServer.listen(0, '127.0.0.1', r));
    cleanups.push(
      () => new Promise<void>((r) => directServer.close(() => r())),
    );
    const addr = directServer.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    const notFound = await fetch(`http://127.0.0.1:${port}/__vertice_assistant/unknown`);
    expect(notFound.status).toBe(404);
  });
});
