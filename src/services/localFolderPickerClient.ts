export interface LocalDirectoryEntry {
  name: string;
  path: string;
}

export interface LocalDirectoryShortcut {
  label: string;
  path: string;
}

export interface LocalDirectoryListing {
  currentPath: string;
  parentPath: string | null;
  roots: LocalDirectoryEntry[];
  shortcuts: LocalDirectoryShortcut[];
  directories: LocalDirectoryEntry[];
  warning?: string;
}

export type BrowseDirectoriesResult =
  | { status: 'ok'; data: LocalDirectoryListing }
  | { status: 'unavailable'; message: string };

export type CreateDirectoryResult =
  | { status: 'ok'; createdPath: string; data: LocalDirectoryListing }
  | { status: 'error'; message: string };

export type PickDirectoryResult =
  | { status: 'selected'; path: string }
  | { status: 'cancelled' }
  | { status: 'busy'; message: string }
  | { status: 'unavailable'; message: string };

/**
 * Lists subdirectories directly from the local loopback server so the user can navigate and pick
 * any workspace folder inside the browser without waiting on detached OS dialogs.
 */
export async function browseLocalDirectories(
  targetPath?: string,
): Promise<BrowseDirectoriesResult> {
  try {
    const query = targetPath?.trim()
      ? `?path=${encodeURIComponent(targetPath.trim())}`
      : '';
    const response = await fetch(`/__vertice_local/picker/browse${query}`, {
      method: 'GET',
      cache: 'no-store',
    });
    const payload = (await response.json().catch(() => null)) as
      | ({ ok?: boolean; error?: string } & Partial<LocalDirectoryListing>)
      | null;

    if (!response.ok || !payload || payload.ok === false || !payload.currentPath) {
      return {
        status: 'unavailable',
        message:
          payload?.error ||
          'Navegador local de pastas indisponível neste servidor estático. Digite ou cole o caminho, ou inicie via Iniciar Vertice.cmd / npm run dev.',
      };
    }

    return {
      status: 'ok',
      data: {
        currentPath: payload.currentPath,
        parentPath: payload.parentPath ?? null,
        roots: Array.isArray(payload.roots) ? payload.roots : [],
        shortcuts: Array.isArray(payload.shortcuts) ? payload.shortcuts : [],
        directories: Array.isArray(payload.directories) ? payload.directories : [],
        warning: payload.warning,
      },
    };
  } catch {
    return {
      status: 'unavailable',
      message:
        'Não foi possível acessar o navegador local de pastas. Digite/cole o caminho ou inicie via Iniciar Vertice.cmd.',
    };
  }
}

/**
 * Creates a new subfolder inside `parentPath` on the local loopback server and returns the
 * refreshed directory listing focused inside the newly created folder.
 */
export async function createLocalWorkspaceDirectory(
  parentPath: string,
  folderName: string,
): Promise<CreateDirectoryResult> {
  try {
    const response = await fetch('/__vertice_local/picker/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      cache: 'no-store',
      body: JSON.stringify({ parentPath, folderName }),
    });
    const payload = (await response.json().catch(() => null)) as {
      ok?: boolean;
      createdPath?: string;
      listing?: Partial<LocalDirectoryListing>;
      error?: string;
    } | null;

    if (!response.ok || !payload || payload.ok === false || !payload.createdPath) {
      return {
        status: 'error',
        message:
          payload?.error || 'Não foi possível criar a pasta no servidor local.',
      };
    }

    return {
      status: 'ok',
      createdPath: payload.createdPath,
      data: {
        currentPath: payload.listing?.currentPath ?? payload.createdPath,
        parentPath: payload.listing?.parentPath ?? parentPath,
        roots: Array.isArray(payload.listing?.roots) ? payload.listing.roots : [],
        shortcuts: Array.isArray(payload.listing?.shortcuts)
          ? payload.listing.shortcuts
          : [],
        directories: Array.isArray(payload.listing?.directories)
          ? payload.listing.directories
          : [],
        warning: payload.listing?.warning,
      },
    };
  } catch {
    return {
      status: 'error',
      message: 'Falha de comunicação com o servidor local ao criar pasta.',
    };
  }
}

/**
 * Calls the local loopback OS directory picker endpoint exposed by vertice-server.mjs and Vite dev
 * when explicitly requested as a fallback.
 */
export async function pickLocalWorkspaceDirectory(
  initialPath?: string,
): Promise<PickDirectoryResult> {
  try {
    const response = await fetch('/__vertice_local/picker/directory', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      cache: 'no-store',
      body: JSON.stringify({ initialPath: initialPath?.trim() || undefined }),
    });

    const payload = (await response.json().catch(() => null)) as {
      ok?: boolean;
      available?: boolean;
      busy?: boolean;
      cancelled?: boolean;
      path?: string | null;
      error?: string;
    } | null;

    if (response.status === 409 || payload?.busy) {
      return {
        status: 'busy',
        message:
          payload?.error ||
          'Já existe uma janela de seleção de pasta aberta no sistema.',
      };
    }

    if (!response.ok || payload?.ok === false || payload?.available === false) {
      return {
        status: 'unavailable',
        message:
          payload?.error ||
          'Seletor nativo de pastas indisponível neste servidor estático. Digite ou cole o caminho, ou inicie via Iniciar Vertice.cmd / npm run dev.',
      };
    }

    if (payload?.cancelled || !payload?.path) {
      return { status: 'cancelled' };
    }

    return { status: 'selected', path: payload.path };
  } catch {
    return {
      status: 'unavailable',
      message:
        'Não foi possível abrir o seletor nativo de pastas no navegador. Digite/cole o caminho ou inicie via Iniciar Vertice.cmd.',
    };
  }
}
