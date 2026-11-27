import {
  Check,
  Copy,
  FileCode2,
  FolderGit2,
  Lock,
  RefreshCw,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EmptyState } from '../../components/EmptyState';
import {
  fetchWorkspaceChanges,
  fetchWorkspaceFileDiff,
  type WorkspaceChangedFile,
  type WorkspaceChangesPayload,
  type WorkspaceFileDiffPayload,
  type WorkspaceFileStatus,
} from '../../services/workspaceDiffClient';
import { useWorkspace } from '../workspace/WorkspaceContext';

interface FilesPanelProps {
  onCountChange?: (count: number | null) => void;
}

function statusBadgeMeta(status: WorkspaceFileStatus): {
  label: string;
  className: string;
} {
  switch (status) {
    case 'added':
    case 'untracked':
      return {
        label: 'Novo',
        className:
          'border-[var(--status-success)]/40 bg-[var(--status-success)]/10 text-[var(--status-success)]',
      };
    case 'deleted':
      return {
        label: 'Removido',
        className:
          'border-[var(--status-danger)]/40 bg-[var(--status-danger)]/10 text-[var(--status-danger)]',
      };
    case 'renamed':
      return {
        label: 'Renomeado',
        className:
          'border-[var(--accent)]/40 bg-[var(--accent-soft)] text-[var(--accent)]',
      };
    default:
      return {
        label: 'Modificado',
        className:
          'border-[var(--status-warning)]/40 bg-[var(--status-warning)]/10 text-[var(--status-warning)]',
      };
  }
}

function classifyDiffLine(line: string, isFullFilePreview: boolean): string {
  if (isFullFilePreview) {
    return 'text-[var(--text-primary)]';
  }
  if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff --git')) {
    return 'text-[var(--text-muted)] font-semibold';
  }
  if (line.startsWith('@@')) {
    return 'bg-[var(--accent-soft)] text-[var(--accent)] font-medium';
  }
  if (line.startsWith('+')) {
    return 'bg-[var(--status-success)]/12 text-[var(--status-success)]';
  }
  if (line.startsWith('-')) {
    return 'bg-[var(--status-danger)]/12 text-[var(--status-danger)]';
  }
  return 'text-[var(--text-primary)]';
}

export function FilesPanel({ onCountChange }: FilesPanelProps) {
  const { activeProject, activeConversation } = useWorkspace();
  const workspacePath = activeProject?.workspacePathInfo?.trim() ?? '';

  const [changes, setChanges] = useState<WorkspaceChangesPayload | null>(null);
  const [changesError, setChangesError] = useState<string | null>(null);
  const [loadingChanges, setLoadingChanges] = useState(false);

  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [diffPayload, setDiffPayload] = useState<WorkspaceFileDiffPayload | null>(
    null,
  );
  const [diffError, setDiffError] = useState<string | null>(null);
  const [loadingDiff, setLoadingDiff] = useState(false);
  const [copiedTarget, setCopiedTarget] = useState<'path' | 'diff' | null>(null);

  const selectedPathRef = useRef<string | null>(null);
  selectedPathRef.current = selectedPath;

  const loadDiff = useCallback(
    async (file: WorkspaceChangedFile) => {
      if (!workspacePath) return;
      setSelectedPath(file.path);
      setDiffError(null);
      if (file.isSensitive) {
        setDiffPayload(null);
        setDiffError(
          'Visualização de conteúdo/diff bloqueada por segurança para arquivo sensível.',
        );
        return;
      }
      setLoadingDiff(true);
      try {
        const res = await fetchWorkspaceFileDiff(workspacePath, file.path);
        if (res.status === 'ok') {
          setDiffPayload(res.data);
        } else {
          setDiffPayload(null);
          setDiffError(res.message);
        }
      } finally {
        setLoadingDiff(false);
      }
    },
    [workspacePath],
  );

  const refreshChanges = useCallback(async () => {
    if (!workspacePath) {
      setChanges(null);
      setChangesError(null);
      setSelectedPath(null);
      setDiffPayload(null);
      onCountChange?.(null);
      return;
    }
    setLoadingChanges(true);
    setChangesError(null);
    try {
      const res = await fetchWorkspaceChanges(workspacePath);
      if (res.status !== 'ok') {
        setChanges(null);
        setChangesError(res.message);
        onCountChange?.(null);
        return;
      }
      setChanges(res.data);
      onCountChange?.(res.data.totalCount);

      const currentSelected = selectedPathRef.current;
      const matching = currentSelected
        ? res.data.files.find((f) => f.path === currentSelected)
        : undefined;
      const target = matching ?? res.data.files[0];
      if (target) {
        await loadDiff(target);
      } else {
        setSelectedPath(null);
        setDiffPayload(null);
        setDiffError(null);
      }
    } finally {
      setLoadingChanges(false);
    }
  }, [workspacePath, loadDiff, onCountChange]);

  useEffect(() => {
    void refreshChanges();
  }, [refreshChanges]);

  // Auto-refresh when a delivery or review event arrives in the active conversation.
  const completionSignal = useMemo(() => {
    const feed = activeConversation?.generalFeed ?? [];
    let count = 0;
    let lastId = '';
    for (const item of feed) {
      if (
        item.kind === 'delivery_summary' ||
        item.kind === 'review_decision'
      ) {
        count += 1;
        lastId = item.id;
      }
    }
    return `${count}:${lastId}`;
  }, [activeConversation?.generalFeed]);

  const initialSignalRef = useRef(completionSignal);
  useEffect(() => {
    if (completionSignal === initialSignalRef.current) return;
    initialSignalRef.current = completionSignal;
    void refreshChanges();
  }, [completionSignal, refreshChanges]);

  const handleCopy = async (kind: 'path' | 'diff', text: string) => {
    if (!text || typeof navigator === 'undefined' || !navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopiedTarget(kind);
      window.setTimeout(() => {
        setCopiedTarget((prev) => (prev === kind ? null : prev));
      }, 1600);
    } catch {
      // Ignore clipboard rejection
    }
  };

  if (!workspacePath) {
    return (
      <EmptyState
        icon={<FolderGit2 className="h-6 w-6" />}
        title="Pasta do projeto não informada"
        description="Defina o caminho do diretório local nas configurações do projeto para acompanhar arquivos alterados e diffs."
      />
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-xs font-medium text-[var(--text-primary)]">
            <FolderGit2 className="h-3.5 w-3.5 shrink-0 text-[var(--accent)]" aria-hidden="true" />
            <span className="truncate">
              {changes
                ? changes.mode === 'git'
                  ? `Git · ${changes.branch ?? 'HEAD'}`
                  : 'Arquivos recentes (sem Git)'
                : 'Workspace local'}
            </span>
          </div>
          {changes && (
            <div className="mt-0.5 tabular-nums text-[11px] text-[var(--text-muted)]">
              {changes.totalCount} arquivo(s)
              {changes.truncated ? ' (exibindo amostra)' : ''}
            </div>
          )}
        </div>

        <button
          type="button"
          onClick={() => void refreshChanges()}
          disabled={loadingChanges}
          className="inline-flex h-8 items-center gap-1.5 rounded-md border border-[var(--border-strong)] bg-[var(--bg-surface)] px-2.5 text-xs font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-elevated)] disabled:opacity-50"
        >
          <RefreshCw
            className={`h-3.5 w-3.5 ${loadingChanges ? 'animate-spin' : ''}`}
            aria-hidden="true"
          />
          <span>Atualizar</span>
        </button>
      </div>

      {changes?.mode === 'filesystem_recent' && (
        <div className="rounded-md border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-3 py-2 text-[11px] leading-relaxed text-[var(--text-secondary)]">
          Este diretório não possui repositório Git (`.git`). Exibindo arquivos modificados recentemente em modo somente leitura, sem diff linha a linha.
        </div>
      )}

      {changesError && (
        <div className="rounded-md border border-[var(--status-danger)]/40 bg-[var(--bg-surface)] p-3 text-xs text-[var(--status-danger)]">
          {changesError}
        </div>
      )}

      {!changesError && changes && changes.files.length === 0 && (
        <EmptyState
          icon={<FileCode2 className="h-6 w-6" />}
          title="Nenhuma alteração detectada"
          description="O diretório de trabalho está limpo no momento."
        />
      )}

      {changes && changes.files.length > 0 && (
        <div className="space-y-3">
          <ul
            aria-label="Lista de arquivos alterados"
            className="max-h-56 space-y-1 overflow-y-auto rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-1.5"
          >
            {changes.files.map((file) => {
              const isSelected = file.path === selectedPath;
              const badge = statusBadgeMeta(file.status);
              return (
                <li key={file.path}>
                  <button
                    type="button"
                    onClick={() => void loadDiff(file)}
                    className={`flex w-full items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-left text-xs transition-colors ${
                      isSelected
                        ? 'bg-[var(--accent-soft)] text-[var(--text-primary)]'
                        : 'text-[var(--text-secondary)] hover:bg-[var(--bg-elevated)] hover:text-[var(--text-primary)]'
                    }`}
                  >
                    <div className="flex min-w-0 items-center gap-1.5">
                      {file.isSensitive && (
                        <Lock
                          className="h-3 w-3 shrink-0 text-[var(--status-warning)]"
                          aria-label="Arquivo sensível protegido"
                        />
                      )}
                      <span className="truncate font-mono text-[11px]">
                        {file.path}
                      </span>
                    </div>

                    <div className="flex shrink-0 items-center gap-1.5">
                      {changes.mode === 'git' && (
                        <span className="tabular-nums font-mono text-[10px] text-[var(--text-muted)]">
                          {file.additions !== null && (
                            <span className="text-[var(--status-success)]">
                              +{file.additions}
                            </span>
                          )}
                          {file.additions !== null && file.deletions !== null && ' '}
                          {file.deletions !== null && file.deletions > 0 && (
                            <span className="text-[var(--status-danger)]">
                              -{file.deletions}
                            </span>
                          )}
                        </span>
                      )}
                      <span
                        className={`rounded border px-1.5 py-0.5 text-[10px] font-medium ${badge.className}`}
                      >
                        {badge.label}
                      </span>
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>

          {selectedPath && (
            <section
              aria-label="Visualizador de diff"
              className="rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-surface)]"
            >
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border-hairline)] px-3 py-2">
                <span className="min-w-0 truncate font-mono text-[11px] font-medium text-[var(--text-primary)]">
                  {selectedPath}
                </span>
                <div className="flex shrink-0 items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => void handleCopy('path', selectedPath)}
                    className="inline-flex h-7 items-center gap-1 rounded border border-[var(--border-hairline)] bg-[var(--bg-canvas)] px-2 text-[11px] text-[var(--text-secondary)] hover:border-[var(--border-strong)] hover:text-[var(--text-primary)]"
                  >
                    {copiedTarget === 'path' ? (
                      <Check className="h-3 w-3 text-[var(--status-success)]" aria-hidden="true" />
                    ) : (
                      <Copy className="h-3 w-3" aria-hidden="true" />
                    )}
                    <span>Caminho</span>
                  </button>
                  {diffPayload?.diff && (
                    <button
                      type="button"
                      onClick={() => void handleCopy('diff', diffPayload.diff)}
                      className="inline-flex h-7 items-center gap-1 rounded border border-[var(--border-hairline)] bg-[var(--bg-canvas)] px-2 text-[11px] text-[var(--text-secondary)] hover:border-[var(--border-strong)] hover:text-[var(--text-primary)]"
                    >
                      {copiedTarget === 'diff' ? (
                        <Check className="h-3 w-3 text-[var(--status-success)]" aria-hidden="true" />
                      ) : (
                        <Copy className="h-3 w-3" aria-hidden="true" />
                      )}
                      <span>Diff</span>
                    </button>
                  )}
                </div>
              </div>

              <div className="p-2.5">
                {loadingDiff && (
                  <p className="py-4 text-center text-xs text-[var(--text-muted)]">
                    Carregando alterações do arquivo...
                  </p>
                )}

                {!loadingDiff && diffError && (
                  <p className="rounded bg-[var(--bg-canvas)] p-2.5 text-xs text-[var(--status-warning)]">
                    {diffError}
                  </p>
                )}

                {!loadingDiff && !diffError && diffPayload?.isBinary && (
                  <p className="rounded bg-[var(--bg-canvas)] p-2.5 text-xs text-[var(--text-secondary)]">
                    Arquivo binário detectado — visualização de diff textual indisponível.
                  </p>
                )}

                {!loadingDiff && !diffError && diffPayload && !diffPayload.isBinary && (
                  <>
                    {diffPayload.truncated && (
                      <div className="mb-2 rounded border border-[var(--status-warning)]/40 bg-[var(--bg-canvas)] px-2.5 py-1.5 text-[11px] text-[var(--status-warning)]">
                        Exibição truncada para manter a responsividade ({diffPayload.lineCount} linhas exibidas).
                      </div>
                    )}
                    {diffPayload.diff ? (
                      <div className="max-h-[420px] overflow-auto rounded-md border border-[var(--border-hairline)] bg-[var(--bg-canvas)] font-mono text-[11px] leading-relaxed">
                        <pre className="min-w-max p-2">
                          {diffPayload.diff.split('\n').map((line, idx) => (
                            <div
                              key={idx}
                              className={`px-1.5 whitespace-pre ${classifyDiffLine(
                                line,
                                diffPayload.isFullFilePreview,
                              )}`}
                            >
                              {line || ' '}
                            </div>
                          ))}
                        </pre>
                      </div>
                    ) : (
                      <p className="rounded bg-[var(--bg-canvas)] p-2.5 text-xs text-[var(--text-muted)]">
                        Sem alterações textuais para exibir.
                      </p>
                    )}
                  </>
                )}
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
