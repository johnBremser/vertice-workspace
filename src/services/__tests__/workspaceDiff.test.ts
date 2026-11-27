import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startVerticeServer } from '../../../scripts/vertice-server.mjs';
import {
  getWorkspaceChanges,
  getWorkspaceFileDiff,
  isSensitiveWorkspaceFile,
} from '../../../scripts/vertice-workspace-diff.mjs';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop()!;
    await fn();
  }
});

function gitExec(cwd: string, args: string[]): void {
  execFileSync('git', ['-C', cwd, ...args], {
    stdio: 'pipe',
    windowsHide: true,
  });
}

describe('Workspace changes & diff reader (BL-02: vertice-workspace-diff.mjs)', () => {
  it('detects modified, untracked, and deleted files with unified diffs in a real Git repository', async () => {
    const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vertice-diff-git-'));
    cleanups.push(() => fs.rm(repoDir, { recursive: true, force: true }));

    gitExec(repoDir, ['init']);
    gitExec(repoDir, ['config', 'user.email', 'test@vertice.local']);
    gitExec(repoDir, ['config', 'user.name', 'Vertice Test']);

    await fs.mkdir(path.join(repoDir, 'src'), { recursive: true });
    await fs.writeFile(path.join(repoDir, 'src', 'app.ts'), 'export const v = 1;\n', 'utf8');
    await fs.writeFile(path.join(repoDir, 'src', 'old.ts'), 'export const old = true;\n', 'utf8');
    gitExec(repoDir, ['add', '.']);
    gitExec(repoDir, ['commit', '-m', 'init']);

    // Modify, add untracked, and delete
    await fs.writeFile(
      path.join(repoDir, 'src', 'app.ts'),
      'export const v = 2;\nexport const extra = true;\n',
      'utf8',
    );
    await fs.writeFile(path.join(repoDir, 'src', 'new.ts'), 'line1\nline2\n', 'utf8');
    await fs.unlink(path.join(repoDir, 'src', 'old.ts'));

    const changes = (await getWorkspaceChanges(repoDir)) as {
      ok: boolean;
      status: number;
      mode?: string;
      files?: Array<{ path: string; status: string; additions: number | null; deletions: number | null }>;
    };
    expect(changes.ok).toBe(true);
    expect(changes.mode).toBe('git');
    expect(changes.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: 'src/app.ts',
          status: 'modified',
          additions: 2,
          deletions: 1,
        }),
        expect.objectContaining({
          path: 'src/new.ts',
          status: 'untracked',
          additions: 2,
          deletions: 0,
        }),
        expect.objectContaining({
          path: 'src/old.ts',
          status: 'deleted',
          additions: 0,
          deletions: 1,
        }),
      ]),
    );

    const modDiff = (await getWorkspaceFileDiff(repoDir, 'src/app.ts')) as {
      ok: boolean;
      diff?: string;
      fileStatus?: string;
    };
    expect(modDiff.ok).toBe(true);
    expect(modDiff.diff).toContain('-export const v = 1;');
    expect(modDiff.diff).toContain('+export const v = 2;');

    const newDiff = (await getWorkspaceFileDiff(repoDir, 'src/new.ts')) as {
      ok: boolean;
      diff?: string;
      fileStatus?: string;
    };
    expect(newDiff.ok).toBe(true);
    expect(newDiff.fileStatus).toBe('untracked');
    expect(newDiff.diff).toContain('+++ b/src/new.ts');
    expect(newDiff.diff).toContain('+line1');

    const delDiff = (await getWorkspaceFileDiff(repoDir, 'src/old.ts')) as {
      ok: boolean;
      diff?: string;
      fileStatus?: string;
    };
    expect(delDiff.ok).toBe(true);
    expect(delDiff.fileStatus).toBe('deleted');
    expect(delDiff.diff).toContain('-export const old = true;');
  });

  it('falls back honestly to filesystem_recent when directory is not a Git repository', async () => {
    const plainDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vertice-diff-nogit-'));
    cleanups.push(() => fs.rm(plainDir, { recursive: true, force: true }));

    await fs.writeFile(path.join(plainDir, 'notes.md'), '# Notes\nHello\n', 'utf8');
    const changes = (await getWorkspaceChanges(plainDir)) as {
      ok: boolean;
      mode?: string;
      files?: Array<{ path: string }>;
    };
    expect(changes.ok).toBe(true);
    expect(changes.mode).toBe('filesystem_recent');
    expect(changes.files?.[0]?.path).toBe('notes.md');

    const preview = (await getWorkspaceFileDiff(plainDir, 'notes.md')) as {
      ok: boolean;
      isFullFilePreview?: boolean;
      diff?: string;
    };
    expect(preview.ok).toBe(true);
    expect(preview.isFullFilePreview).toBe(true);
    expect(preview.diff).toContain('# Notes');
  });

  it('blocks path traversal, external symlinks, and sensitive files with 403/400, and handles binary/large diffs safely', async () => {
    const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vertice-diff-sec-'));
    const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vertice-diff-out-'));
    cleanups.push(() => fs.rm(repoDir, { recursive: true, force: true }));
    cleanups.push(() => fs.rm(outDir, { recursive: true, force: true }));

    gitExec(repoDir, ['init']);
    await fs.writeFile(path.join(repoDir, '.env'), 'SECRET=123\n', 'utf8');
    await fs.writeFile(path.join(repoDir, '.env.local'), 'TOKEN=abc\n', 'utf8');
    await fs.writeFile(path.join(repoDir, 'cert.pem'), 'PRIVATE\n', 'utf8');
    await fs.writeFile(path.join(repoDir, 'app.key'), 'KEY\n', 'utf8');
    await fs.writeFile(path.join(repoDir, '.env.example'), 'PORT=4173\n', 'utf8');
    await fs.writeFile(path.join(repoDir, 'image.bin'), Buffer.from([0, 1, 2, 3, 0, 255]));
    await fs.writeFile(
      path.join(repoDir, 'huge.txt'),
      Array.from({ length: 1700 }, (_, i) => `line-${i}`).join('\n') + '\n',
      'utf8',
    );
    await fs.writeFile(path.join(outDir, 'outside.txt'), 'outside\n', 'utf8');

    expect(isSensitiveWorkspaceFile('.env')).toBe(true);
    expect(isSensitiveWorkspaceFile('.env.local')).toBe(true);
    expect(isSensitiveWorkspaceFile('cert.pem')).toBe(true);
    expect(isSensitiveWorkspaceFile('app.key')).toBe(true);
    expect(isSensitiveWorkspaceFile('.env.example')).toBe(false);

    const trav = await getWorkspaceFileDiff(repoDir, '../outside.txt');
    expect(trav.ok).toBe(false);
    if (!trav.ok) expect(trav.status).toBe(403);

    for (const secretFile of ['.env', '.env.local', 'cert.pem', 'app.key']) {
      const res = await getWorkspaceFileDiff(repoDir, secretFile);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.status).toBe(403);
    }

    const exampleRes = await getWorkspaceFileDiff(repoDir, '.env.example');
    expect(exampleRes.ok).toBe(true);

    const binRes = (await getWorkspaceFileDiff(repoDir, 'image.bin')) as {
      ok: boolean;
      isBinary?: boolean;
    };
    expect(binRes.ok).toBe(true);
    expect(binRes.isBinary).toBe(true);

    const hugeRes = (await getWorkspaceFileDiff(repoDir, 'huge.txt')) as {
      ok: boolean;
      truncated?: boolean;
    };
    expect(hugeRes.ok).toBe(true);
    expect(hugeRes.truncated).toBe(true);

    let symlinkCreated = false;
    try {
      await fs.symlink(path.join(outDir, 'outside.txt'), path.join(repoDir, 'escape.txt'));
      symlinkCreated = true;
    } catch {
      symlinkCreated = false;
    }
    if (symlinkCreated) {
      const symRes = await getWorkspaceFileDiff(repoDir, 'escape.txt');
      expect(symRes.ok).toBe(false);
      if (!symRes.ok) expect(symRes.status).toBe(403);
    }
  });

  it('serves /__vertice_workspace/* endpoints through vertice-server.mjs and rejects POST/traversal', async () => {
    const distDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vertice-diff-dist-'));
    const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vertice-diff-srv-'));
    cleanups.push(() => fs.rm(distDir, { recursive: true, force: true }));
    cleanups.push(() => fs.rm(repoDir, { recursive: true, force: true }));

    await fs.writeFile(path.join(distDir, 'index.html'), '<!doctype html><html></html>', 'utf8');
    gitExec(repoDir, ['init']);
    await fs.writeFile(path.join(repoDir, 'hello.ts'), 'export const x = 1;\n', 'utf8');
    await fs.writeFile(path.join(repoDir, '.env'), 'SECRET=1\n', 'utf8');

    const server = await startVerticeServer({
      distDir,
      host: '127.0.0.1',
      port: 0,
      proxyTarget: '',
    });
    cleanups.push(() => server.close());

    const changesRes = await fetch(
      `${server.origin}/__vertice_workspace/changes?workspace=${encodeURIComponent(repoDir)}`,
    );
    expect(changesRes.status).toBe(200);
    const changesJson = (await changesRes.json()) as {
      ok: boolean;
      mode: string;
      files: Array<{ path: string; isSensitive: boolean }>;
    };
    expect(changesJson.ok).toBe(true);
    expect(changesJson.mode).toBe('git');
    expect(changesJson.files.some((f) => f.path === 'hello.ts')).toBe(true);

    const diffRes = await fetch(
      `${server.origin}/__vertice_workspace/diff?workspace=${encodeURIComponent(repoDir)}&file=hello.ts`,
    );
    expect(diffRes.status).toBe(200);
    const diffJson = (await diffRes.json()) as { ok: boolean; diff: string };
    expect(diffJson.ok).toBe(true);
    expect(diffJson.diff).toContain('+export const x = 1;');

    const envRes = await fetch(
      `${server.origin}/__vertice_workspace/diff?workspace=${encodeURIComponent(repoDir)}&file=.env`,
    );
    expect(envRes.status).toBe(403);

    const travRes = await fetch(
      `${server.origin}/__vertice_workspace/diff?workspace=${encodeURIComponent(repoDir)}&file=../x`,
    );
    expect(travRes.status).toBe(403);

    const postRes = await fetch(
      `${server.origin}/__vertice_workspace/changes?workspace=${encodeURIComponent(repoDir)}`,
      { method: 'POST' },
    );
    expect(postRes.status).toBe(405);
  });
});
