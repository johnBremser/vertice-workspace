export type WorkspaceFileStatus =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'untracked';

export interface WorkspaceChangedFile {
  path: string;
  previousPath?: string;
  status: WorkspaceFileStatus;
  additions: number | null;
  deletions: number | null;
  isSensitive: boolean;
  isBinary: boolean;
  updatedAt?: string;
  sizeBytes?: number;
}

export interface WorkspaceChangesPayload {
  mode: 'git' | 'filesystem_recent';
  workspace: string;
  branch?: string;
  files: WorkspaceChangedFile[];
  totalCount: number;
  truncated: boolean;
}

export interface WorkspaceFileDiffPayload {
  mode: 'git' | 'filesystem_recent';
  path: string;
  fileStatus?: WorkspaceFileStatus;
  isBinary: boolean;
  isFullFilePreview: boolean;
  diff: string;
  lineCount: number;
  truncated: boolean;
}

export type WorkspaceChangesResult =
  | { status: 'ok'; data: WorkspaceChangesPayload }
  | { status: 'unavailable' | 'error'; message: string };

export type WorkspaceFileDiffResult =
  | { status: 'ok'; data: WorkspaceFileDiffPayload }
  | { status: 'blocked' | 'unavailable' | 'error'; message: string };

export async function fetchWorkspaceChanges(
  workspacePath: string,
): Promise<WorkspaceChangesResult> {
  const trimmed = workspacePath.trim();
  if (!trimmed) {
    return {
      status: 'error',
      message: 'Nenhum diretório de workspace configurado para este projeto.',
    };
  }

  try {
    const response = await fetch(
      `/__vertice_workspace/changes?workspace=${encodeURIComponent(trimmed)}`,
      { method: 'GET', cache: 'no-store' },
    );
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('application/json')) {
      return {
        status: 'unavailable',
        message:
          'Inspeção de arquivos indisponível neste servidor estático. Inicie via Iniciar Vertice.cmd, npm start ou npm run dev.',
      };
    }

    const payload = (await response.json().catch(() => null)) as
      | ({ ok?: boolean; error?: string } & Partial<WorkspaceChangesPayload>)
      | null;

    if (!response.ok || !payload || payload.ok === false) {
      return {
        status: response.status === 404 ? 'error' : 'error',
        message: payload?.error ?? `Falha ao listar arquivos (HTTP ${response.status}).`,
      };
    }

    return {
      status: 'ok',
      data: {
        mode: payload.mode === 'filesystem_recent' ? 'filesystem_recent' : 'git',
        workspace: payload.workspace ?? trimmed,
        branch: payload.branch,
        files: Array.isArray(payload.files) ? payload.files : [],
        totalCount: Number(payload.totalCount ?? 0),
        truncated: Boolean(payload.truncated),
      },
    };
  } catch {
    return {
      status: 'unavailable',
      message:
        'Não foi possível conectar ao servidor local do Vértice para inspecionar arquivos.',
    };
  }
}

export async function fetchWorkspaceFileDiff(
  workspacePath: string,
  filePath: string,
): Promise<WorkspaceFileDiffResult> {
  const trimmedWorkspace = workspacePath.trim();
  const trimmedFile = filePath.trim();
  if (!trimmedWorkspace || !trimmedFile) {
    return { status: 'error', message: 'Workspace ou arquivo não informado.' };
  }

  try {
    const response = await fetch(
      `/__vertice_workspace/diff?workspace=${encodeURIComponent(trimmedWorkspace)}&file=${encodeURIComponent(trimmedFile)}`,
      { method: 'GET', cache: 'no-store' },
    );
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('application/json')) {
      return {
        status: 'unavailable',
        message: 'Endpoint de diff indisponível neste servidor.',
      };
    }

    const payload = (await response.json().catch(() => null)) as
      | ({ ok?: boolean; error?: string } & Partial<WorkspaceFileDiffPayload>)
      | null;

    if (!response.ok || !payload || payload.ok === false) {
      return {
        status: response.status === 403 ? 'blocked' : 'error',
        message: payload?.error ?? `Falha ao carregar diff (HTTP ${response.status}).`,
      };
    }

    return {
      status: 'ok',
      data: {
        mode: payload.mode === 'filesystem_recent' ? 'filesystem_recent' : 'git',
        path: payload.path ?? trimmedFile,
        fileStatus: payload.fileStatus,
        isBinary: Boolean(payload.isBinary),
        isFullFilePreview: Boolean(payload.isFullFilePreview),
        diff: payload.diff ?? '',
        lineCount: Number(payload.lineCount ?? 0),
        truncated: Boolean(payload.truncated),
      },
    };
  } catch {
    return {
      status: 'unavailable',
      message: 'Não foi possível carregar o diff do arquivo.',
    };
  }
}
