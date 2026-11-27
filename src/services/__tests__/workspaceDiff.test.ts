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

    // Requesting a directory (existing or deleted) MUST be rejected with 400
    const dirDiff = (await getWorkspaceFileDiff(repoDir, 'src')) as {
      ok: boolean;
      status: number;
    };
    expect(dirDiff.ok).toBe(false);
    expect(dirDiff.status).toBe(400);

    await fs.mkdir(path.join(repoDir, 'removed-dir'), { recursive: true });
    await fs.writeFile(path.join(repoDir, 'removed-dir', 'a.ts'), 'export const z = 1;\n', 'utf8');
    gitExec(repoDir, ['add', 'removed-dir/a.ts']);
    gitExec(repoDir, ['commit', '-m', 'add removed-dir']);
    await fs.rm(path.join(repoDir, 'removed-dir'), { recursive: true, force: true });

    const deletedDirDiff = (await getWorkspaceFileDiff(repoDir, 'removed-dir')) as {
      ok: boolean;
      status: number;
    };
    expect(deletedDirDiff.ok).toBe(false);
    expect(deletedDirDiff.status).toBe(400);

    // Deleting a single file inside the deleted directory still returns its literal unified diff
    const deletedSingleFileDiff = (await getWorkspaceFileDiff(repoDir, 'removed-dir/a.ts')) as {
      ok: boolean;
      diff?: string;
    };
    expect(deletedSingleFileDiff.ok).toBe(true);
    expect(deletedSingleFileDiff.diff).toContain('-export const z = 1;');

    // Typechange: path was a directory in HEAD (containing sensitive/child files) and is now a regular file on disk
    await fs.mkdir(path.join(repoDir, 'replaced'), { recursive: true });
    await fs.writeFile(path.join(repoDir, 'replaced', '.env'), 'SUPER_SECRET_LEAK=999\n', 'utf8');
    await fs.writeFile(path.join(repoDir, 'replaced', 'old.ts'), 'export const OLD_CHILD = 1;\n', 'utf8');
    gitExec(repoDir, ['add', 'replaced']);
    gitExec(repoDir, ['commit', '-m', 'add replaced dir']);
    await fs.rm(path.join(repoDir, 'replaced'), { recursive: true, force: true });
    await fs.writeFile(path.join(repoDir, 'replaced'), 'NEW_FILE_ONLY=1\n', 'utf8');

    const typechangeDiff = (await getWorkspaceFileDiff(repoDir, 'replaced')) as {
      ok: boolean;
      diff?: string;
    };
    expect(typechangeDiff.ok).toBe(true);
    expect(typechangeDiff.diff).toContain('+NEW_FILE_ONLY=1');
    expect(typechangeDiff.diff).not.toContain('SUPER_SECRET_LEAK');
    expect(typechangeDiff.diff).not.toContain('OLD_CHILD');
    expect(typechangeDiff.diff).not.toContain('replaced/old.ts');
  }, 15_000);

  it('isolates single-file diffs even in an unborn Git repository without a first commit (BL-02)', async () => {
    const unbornDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vertice-diff-unborn-'));
    cleanups.push(() => fs.rm(unbornDir, { recursive: true, force: true }));

    gitExec(unbornDir, ['init']);
    // Stage a normal file and a directory containing sensitive + regular files (no commit yet)
    await fs.writeFile(path.join(unbornDir, 'solo.ts'), 'export const s = 1;\n', 'utf8');
    await fs.mkdir(path.join(unbornDir, 'staged-dir'), { recursive: true });
    await fs.writeFile(path.join(unbornDir, 'staged-dir', '.env'), 'UNBORN_SECRET=777\n', 'utf8');
    await fs.writeFile(path.join(unbornDir, 'staged-dir', 'child.ts'), 'export const ch = 1;\n', 'utf8');
    gitExec(unbornDir, ['add', 'solo.ts', 'staged-dir']);

    // Replace staged-dir/ on disk with a regular file named staged-dir
    await fs.rm(path.join(unbornDir, 'staged-dir'), { recursive: true, force: true });
    await fs.writeFile(path.join(unbornDir, 'staged-dir'), 'ONLY_THIS_FILE=1\n', 'utf8');

    const replacedUnborn = (await getWorkspaceFileDiff(unbornDir, 'staged-dir')) as {
      ok: boolean;
      diff?: string;
    };
    expect(replacedUnborn.ok).toBe(true);
    expect(replacedUnborn.diff).toContain('+ONLY_THIS_FILE=1');
    expect(replacedUnborn.diff).not.toContain('UNBORN_SECRET');
    expect(replacedUnborn.diff).not.toContain('child.ts');

    // Remove the replacement file so staged-dir is now a deleted indexed directory -> 400
    await fs.unlink(path.join(unbornDir, 'staged-dir'));
    const deletedUnbornDir = (await getWorkspaceFileDiff(unbornDir, 'staged-dir')) as {
      ok: boolean;
      status: number;
    };
    expect(deletedUnbornDir.ok).toBe(false);
    expect(deletedUnbornDir.status).toBe(400);

    // Regular staged single file in unborn repo still returns its exact diff
    const soloDiff = (await getWorkspaceFileDiff(unbornDir, 'solo.ts')) as {
      ok: boolean;
      diff?: string;
    };
    expect(soloDiff.ok).toBe(true);
    expect(soloDiff.diff).toContain('+export const s = 1;');
    expect(soloDiff.diff).not.toContain('UNBORN_SECRET');
  }, 15_000);

  it('scopes Git subdirectory workspaces strictly to the subfolder and returns non-empty diffs (BL-02)', async () => {
    const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vertice-diff-subdir-'));
    cleanups.push(() => fs.rm(repoDir, { recursive: true, force: true }));

    gitExec(repoDir, ['init']);
    gitExec(repoDir, ['config', 'user.email', 'test@vertice.local']);
    gitExec(repoDir, ['config', 'user.name', 'Vertice Test']);

    const appSubdir = path.join(repoDir, 'packages', 'app');
    const otherSubdir = path.join(repoDir, 'packages', 'other');
    await fs.mkdir(appSubdir, { recursive: true });
    await fs.mkdir(otherSubdir, { recursive: true });
    await fs.writeFile(path.join(appSubdir, 'index.ts'), 'export const a = 1;\n', 'utf8');
    await fs.writeFile(path.join(otherSubdir, 'outside.ts'), 'export const b = 1;\n', 'utf8');
    gitExec(repoDir, ['add', '.']);
    gitExec(repoDir, ['commit', '-m', 'init subdir']);

    await fs.writeFile(path.join(appSubdir, 'index.ts'), 'export const a = 2;\n', 'utf8');
    await fs.writeFile(path.join(appSubdir, 'extra.ts'), 'export const c = 3;\n', 'utf8');
    await fs.writeFile(path.join(otherSubdir, 'outside.ts'), 'export const b = 99;\n', 'utf8');

    const changes = (await getWorkspaceChanges(appSubdir)) as {
      ok: boolean;
      mode?: string;
      files?: Array<{ path: string; status: string; additions: number | null; deletions: number | null }>;
    };
    expect(changes.ok).toBe(true);
    expect(changes.mode).toBe('git');
    expect(changes.files?.map((f) => f.path).sort()).toEqual(['extra.ts', 'index.ts']);
    expect(changes.files?.some((f) => f.path.includes('other'))).toBe(false);

    const modDiff = (await getWorkspaceFileDiff(appSubdir, 'index.ts')) as {
      ok: boolean;
      diff?: string;
    };
    expect(modDiff.ok).toBe(true);
    expect(modDiff.diff).toContain('-export const a = 1;');
    expect(modDiff.diff).toContain('+export const a = 2;');

    const newDiff = (await getWorkspaceFileDiff(appSubdir, 'extra.ts')) as {
      ok: boolean;
      fileStatus?: string;
      diff?: string;
    };
    expect(newDiff.ok).toBe(true);
    expect(newDiff.fileStatus).toBe('untracked');
    expect(newDiff.diff).toContain('+export const c = 3;');
  }, 15_000);

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

    // Symlink inside workspace pointing to a sensitive file (.env) MUST also be blocked
    let sensitiveLinkCreated = false;
    try {
      await fs.symlink(path.join(repoDir, '.env'), path.join(repoDir, 'innocent.txt'));
      sensitiveLinkCreated = true;
    } catch {
      sensitiveLinkCreated = false;
    }
    if (sensitiveLinkCreated) {
      const sensLinkRes = await getWorkspaceFileDiff(repoDir, 'innocent.txt');
      expect(sensLinkRes.ok).toBe(false);
      if (!sensLinkRes.ok) expect(sensLinkRes.status).toBe(403);
    }
  }, 15_000);

  it('serves /__vertice_workspace/* endpoints through vertice-server.mjs, enforces allowedWorkspaces, and rejects POST/traversal', async () => {
    const distDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vertice-diff-dist-'));
    const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vertice-diff-srv-'));
    const unapprovedDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vertice-diff-other-'));
    cleanups.push(() => fs.rm(distDir, { recursive: true, force: true }));
    cleanups.push(() => fs.rm(repoDir, { recursive: true, force: true }));
    cleanups.push(() => fs.rm(unapprovedDir, { recursive: true, force: true }));

    await fs.writeFile(path.join(distDir, 'index.html'), '<!doctype html><html></html>', 'utf8');
    gitExec(repoDir, ['init']);
    await fs.writeFile(path.join(repoDir, 'hello.ts'), 'export const x = 1;\n', 'utf8');
    await fs.writeFile(path.join(repoDir, '.env'), 'SECRET=1\n', 'utf8');

    const server = await startVerticeServer({
      distDir,
      allowedWorkspaces: [repoDir],
      host: '127.0.0.1',
      port: 0,
      proxyTarget: '',
    });
    cleanups.push(() => server.close());

    const outsideWorkspaceRes = await fetch(
      `${server.origin}/__vertice_workspace/changes?workspace=${encodeURIComponent(unapprovedDir)}`,
    );
    expect(outsideWorkspaceRes.status).toBe(403);

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

    // Literal Git pathspec: glob patterns must NEVER expand to match other files
    const globRes = await fetch(
      `${server.origin}/__vertice_workspace/diff?workspace=${encodeURIComponent(repoDir)}&file=${encodeURIComponent('*.ts')}`,
    );
    expect(globRes.status).toBe(200);
    const globJson = (await globRes.json()) as { ok: boolean; diff: string };
    expect(globJson.ok).toBe(true);
    expect(globJson.diff).toBe('');

    const starRes = await fetch(
      `${server.origin}/__vertice_workspace/diff?workspace=${encodeURIComponent(repoDir)}&file=${encodeURIComponent('*')}`,
    );
    expect(starRes.status).toBe(200);
    const starJson = (await starRes.json()) as { ok: boolean; diff: string };
    expect(starJson.ok).toBe(true);
    expect(starJson.diff).toBe('');

    // Real filesystem path verification endpoint (/__vertice_workspace/verify-path)
    const verifyOkRes = await fetch(
      `${server.origin}/__vertice_workspace/verify-path?workspace=${encodeURIComponent(repoDir)}&target=${encodeURIComponent('hello.ts')}`,
    );
    expect(verifyOkRes.status).toBe(200);
    expect(await verifyOkRes.json()).toEqual(
      expect.objectContaining({ ok: true, verified: true }),
    );

    const verifyNewRes = await fetch(
      `${server.origin}/__vertice_workspace/verify-path?workspace=${encodeURIComponent(repoDir)}&target=${encodeURIComponent('src/new-file.ts')}`,
    );
    expect(verifyNewRes.status).toBe(200);
    expect(await verifyNewRes.json()).toEqual(
      expect.objectContaining({ ok: true, verified: true }),
    );

    const verifyEnvRes = await fetch(
      `${server.origin}/__vertice_workspace/verify-path?workspace=${encodeURIComponent(repoDir)}&target=${encodeURIComponent('.env')}`,
    );
    expect(verifyEnvRes.status).toBe(200);
    expect(await verifyEnvRes.json()).toEqual(
      expect.objectContaining({ ok: true, verified: false }),
    );

    const verifyOutsideRes = await fetch(
      `${server.origin}/__vertice_workspace/verify-path?workspace=${encodeURIComponent(repoDir)}&target=${encodeURIComponent('../outside.txt')}`,
    );
    expect(verifyOutsideRes.status).toBe(200);
    expect(await verifyOutsideRes.json()).toEqual(
      expect.objectContaining({ ok: true, verified: false }),
    );

    const verifyBlockedWsRes = await fetch(
      `${server.origin}/__vertice_workspace/verify-path?workspace=${encodeURIComponent(unapprovedDir)}&target=${encodeURIComponent('hello.ts')}`,
    );
    expect(verifyBlockedWsRes.status).toBe(403);
  }, 15_000);
});
