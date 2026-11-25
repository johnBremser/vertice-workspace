import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  browseLocalDirectories,
  createLocalDirectory,
  handleLocalFolderRequest,
  isLoopbackRemoteAddress,
  shouldHandleLocalFolderRequest,
} from '../../../scripts/vertice-folder-picker.mjs';
import {
  browseLocalDirectories as browseClient,
  createLocalWorkspaceDirectory,
  pickLocalWorkspaceDirectory,
} from '../localFolderPickerClient';

function createMockRes() {
  let statusCode = 0;
  let headers: Record<string, unknown> = {};
  let body = '';
  return {
    writeHead(code: number, hdrs: Record<string, unknown>) {
      statusCode = code;
      headers = hdrs;
    },
    end(chunk?: string) {
      if (chunk) body += chunk;
    },
    snapshot() {
      return {
        statusCode,
        headers,
        json: body ? (JSON.parse(body) as Record<string, unknown>) : null,
      };
    },
  };
}

function createMockReq(input: {
  url: string;
  method: string;
  remoteAddress?: string;
  body?: unknown;
}) {
  const emitter = new EventEmitter() as EventEmitter & {
    url: string;
    method: string;
    socket: { remoteAddress?: string };
    destroy: () => void;
  };
  emitter.url = input.url;
  emitter.method = input.method;
  emitter.socket = { remoteAddress: input.remoteAddress ?? '127.0.0.1' };
  emitter.destroy = () => {};
  queueMicrotask(() => {
    if (input.body !== undefined) {
      emitter.emit('data', Buffer.from(JSON.stringify(input.body), 'utf8'));
    }
    emitter.emit('end');
  });
  return emitter;
}

describe('Local workspace folder picker endpoint & client', () => {
  it('detects picker routes and restricts access strictly to loopback', () => {
    expect(shouldHandleLocalFolderRequest('/__vertice_local/picker/browse')).toBe(true);
    expect(shouldHandleLocalFolderRequest('/__vertice_local/picker/directory')).toBe(true);
    expect(shouldHandleLocalFolderRequest('/api/teams')).toBe(false);
    expect(isLoopbackRemoteAddress('127.0.0.1')).toBe(true);
    expect(isLoopbackRemoteAddress('::1')).toBe(true);
    expect(isLoopbackRemoteAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopbackRemoteAddress('192.168.1.25')).toBe(false);
    expect(isLoopbackRemoteAddress(undefined)).toBe(false);

    const res = createMockRes();
    const handled = handleLocalFolderRequest(
      createMockReq({
        url: '/__vertice_local/picker/browse',
        method: 'GET',
        remoteAddress: '10.0.0.42',
      }),
      res,
    );
    expect(handled).toBe(true);
    expect(res.snapshot().statusCode).toBe(403);
  });

  it('lists subdirectories cleanly from a temporary folder and falls back safely on nonexistent target', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vertice-browse-'));
    try {
      fs.mkdirSync(path.join(tmpRoot, 'zeta'));
      fs.mkdirSync(path.join(tmpRoot, 'alpha'));
      fs.writeFileSync(path.join(tmpRoot, 'ignored-file.txt'), 'hello', 'utf8');

      const listing = browseLocalDirectories({ targetPath: tmpRoot });
      expect(listing.ok).toBe(true);
      expect(listing.currentPath).toBe(tmpRoot);
      expect(listing.directories.map((d) => d.name)).toEqual(['alpha', 'zeta']);
      expect(listing.roots.length).toBeGreaterThan(0);

      const fallbackListing = browseLocalDirectories({
        targetPath: path.join(tmpRoot, 'nao-existe', 'sub'),
      });
      expect(fallbackListing.currentPath).toBe(tmpRoot);
      expect(fallbackListing.warning).toContain('não encontrado');

      const resBrowse = createMockRes();
      handleLocalFolderRequest(
        createMockReq({
          url: `/__vertice_local/picker/browse?path=${encodeURIComponent(tmpRoot)}`,
          method: 'GET',
        }),
        resBrowse,
      );
      expect(resBrowse.snapshot().statusCode).toBe(200);
      expect(
        (resBrowse.snapshot().json?.directories as Array<{ name: string }>).map(
          (d) => d.name,
        ),
      ).toEqual(['alpha', 'zeta']);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('invokes injected picker and returns selected or cancelled directory cleanly', async () => {
    const resSelected = createMockRes();
    handleLocalFolderRequest(
      createMockReq({
        url: '/__vertice_local/picker/directory',
        method: 'POST',
        body: { initialPath: 'C:/projetos' },
      }),
      resSelected,
      {
        pickDirectoryImpl: async () => ({
          available: true,
          cancelled: false,
          path: 'C:\\fontes\\inet\\iNET',
        }),
      },
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(resSelected.snapshot().statusCode).toBe(200);
    expect(resSelected.snapshot().json).toEqual({
      ok: true,
      available: true,
      cancelled: false,
      path: 'C:\\fontes\\inet\\iNET',
    });

    const resCancelled = createMockRes();
    handleLocalFolderRequest(
      createMockReq({
        url: '/__vertice_local/picker/directory',
        method: 'POST',
      }),
      resCancelled,
      {
        pickDirectoryImpl: async () => ({
          available: true,
          cancelled: true,
          path: null,
        }),
      },
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(resCancelled.snapshot().statusCode).toBe(200);
    expect(resCancelled.snapshot().json).toEqual({
      ok: true,
      available: true,
      cancelled: true,
      path: null,
    });
  });

  it('handles browse and picker responses cleanly in client', async () => {
    const origFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async (url) => {
        if (String(url).includes('/browse')) {
          return new Response(
            JSON.stringify({
              ok: true,
              currentPath: 'C:\\fontes',
              parentPath: 'C:\\',
              roots: [{ name: 'C:', path: 'C:\\' }],
              shortcuts: [],
              directories: [{ name: 'iNET', path: 'C:\\fontes\\iNET' }],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        return new Response(
          JSON.stringify({
            ok: true,
            available: true,
            cancelled: false,
            path: 'D:\\MeuProjeto',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }) as typeof fetch;

      const browseRes = await browseClient('C:\\fontes');
      expect(browseRes.status).toBe('ok');
      if (browseRes.status === 'ok') {
        expect(browseRes.data.directories[0]?.name).toBe('iNET');
      }

      expect(await pickLocalWorkspaceDirectory()).toEqual({
        status: 'selected',
        path: 'D:\\MeuProjeto',
      });

      globalThis.fetch = (async () =>
        new Response('Not Found', { status: 404 })) as typeof fetch;

      const unavailableBrowse = await browseClient();
      expect(unavailableBrowse.status).toBe('unavailable');
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('creates a new subfolder safely and rejects traversal, invalid chars, or duplicates', async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vertice-mkdir-'));
    try {
      const invalidTraversal = createLocalDirectory({
        parentPath: tmpRoot,
        folderName: '../fora',
      });
      expect(invalidTraversal.ok).toBe(false);
      expect(invalidTraversal.status).toBe(400);

      const invalidChars = createLocalDirectory({
        parentPath: tmpRoot,
        folderName: 'bad:name',
      });
      expect(invalidChars.ok).toBe(false);
      expect(invalidChars.status).toBe(400);

      const resCreate = createMockRes();
      handleLocalFolderRequest(
        createMockReq({
          url: '/__vertice_local/picker/create',
          method: 'POST',
          body: { parentPath: tmpRoot, folderName: 'nova-poc' },
        }),
        resCreate,
      );
      await new Promise((r) => setTimeout(r, 20));
      const snap = resCreate.snapshot();
      expect(snap.statusCode).toBe(201);
      expect(snap.json?.createdPath).toBe(path.join(tmpRoot, 'nova-poc'));
      expect(fs.existsSync(path.join(tmpRoot, 'nova-poc'))).toBe(true);

      const duplicate = createLocalDirectory({
        parentPath: tmpRoot,
        folderName: 'nova-poc',
      });
      expect(duplicate.ok).toBe(false);
      expect(duplicate.status).toBe(409);

      const origFetch = globalThis.fetch;
      try {
        globalThis.fetch = (async () =>
          new Response(
            JSON.stringify({
              ok: true,
              createdPath: 'C:\\fontes\\minha-pasta',
              listing: {
                currentPath: 'C:\\fontes\\minha-pasta',
                parentPath: 'C:\\fontes',
                roots: [{ name: 'C:', path: 'C:\\' }],
                shortcuts: [],
                directories: [],
              },
            }),
            { status: 201, headers: { 'Content-Type': 'application/json' } },
          )) as typeof fetch;

        const clientRes = await createLocalWorkspaceDirectory(
          'C:\\fontes',
          'minha-pasta',
        );
        expect(clientRes.status).toBe('ok');
        if (clientRes.status === 'ok') {
          expect(clientRes.createdPath).toBe('C:\\fontes\\minha-pasta');
        }
      } finally {
        globalThis.fetch = origFetch;
      }
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});
