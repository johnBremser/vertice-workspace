import {
  ArrowUp,
  ChevronRight,
  Folder,
  FolderOpen,
  FolderPlus,
  HardDrive,
  Search,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import {
  browseLocalDirectories,
  createLocalWorkspaceDirectory,
  type LocalDirectoryListing,
} from '../services/localFolderPickerClient';

interface FolderBrowserModalProps {
  open: boolean;
  initialPath?: string;
  onClose: () => void;
  onSelect: (selectedPath: string) => void;
}

export function FolderBrowserModal({
  open,
  initialPath,
  onClose,
  onSelect,
}: FolderBrowserModalProps) {
  const [listing, setListing] = useState<LocalDirectoryListing | null>(null);
  const [pathDraft, setPathDraft] = useState('');
  const [filterText, setFilterText] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [creatingOpen, setCreatingOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const loadDirectory = async (targetPath?: string) => {
    setLoading(true);
    setError(null);
    setCreateError(null);
    try {
      const result = await browseLocalDirectories(targetPath);
      if (result.status === 'unavailable') {
        setError(result.message);
        return;
      }
      setListing(result.data);
      setPathDraft(result.data.currentPath);
      setFilterText('');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    setCreatingOpen(false);
    setNewFolderName('');
    setCreateError(null);
    void loadDirectory(initialPath);
  }, [open, initialPath]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown, { capture: true });
    return () =>
      window.removeEventListener('keydown', onKeyDown, { capture: true });
  }, [open, onClose]);

  const filteredDirectories = useMemo(() => {
    const dirs = listing?.directories ?? [];
    const q = filterText.trim().toLowerCase();
    if (!q) return dirs;
    return dirs.filter((d) => d.name.toLowerCase().includes(q));
  }, [listing?.directories, filterText]);

  if (!open) return null;

  const activePath = listing?.currentPath ?? pathDraft.trim();

  const handleGoPath = (e: FormEvent) => {
    e.preventDefault();
    e.stopPropagation();
    void loadDirectory(pathDraft);
  };

  const handleCreateFolder = async (e: FormEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const trimmed = newFolderName.trim();
    if (!activePath || !trimmed || creating) return;
    setCreating(true);
    setCreateError(null);
    try {
      const res = await createLocalWorkspaceDirectory(activePath, trimmed);
      if (res.status === 'error') {
        setCreateError(res.message);
        return;
      }
      setListing(res.data);
      setPathDraft(res.data.currentPath);
      setFilterText('');
      setNewFolderName('');
      setCreatingOpen(false);
    } finally {
      setCreating(false);
    }
  };

  const modalNode = (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4"
      role="presentation"
      onClick={(e) => {
        e.stopPropagation();
        if (e.target === e.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Selecionar pasta do workspace"
        className="flex max-h-[85vh] w-full max-w-xl flex-col overflow-hidden rounded-xl border border-[var(--border-strong)] bg-[var(--bg-surface)] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-[var(--border-hairline)] px-4 py-3">
          <div className="flex items-center gap-2">
            <FolderOpen className="h-4 w-4 text-[var(--accent)]" aria-hidden="true" />
            <h3 className="text-sm font-semibold text-[var(--text-primary)]">
              Selecionar pasta do workspace
            </h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Fechar seletor de pastas"
            className="rounded-md p-1 text-[var(--text-muted)] hover:bg-[var(--bg-elevated)] hover:text-[var(--text-primary)]"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        <div className="space-y-3 overflow-y-auto p-4 text-xs">
          {listing && (listing.roots.length > 0 || listing.shortcuts.length > 0) && (
            <div className="flex flex-wrap gap-1.5">
              {listing.roots.map((root) => (
                <button
                  key={root.path}
                  type="button"
                  onClick={() => void loadDirectory(root.path)}
                  className="inline-flex items-center gap-1 rounded-md border border-[var(--border-hairline)] bg-[var(--bg-elevated)] px-2 py-1 text-[11px] font-medium text-[var(--text-primary)] hover:border-[var(--accent)]"
                >
                  <HardDrive className="h-3 w-3 text-[var(--accent)]" aria-hidden="true" />
                  <span>{root.name}</span>
                </button>
              ))}
              {listing.shortcuts.map((shortcut) => (
                <button
                  key={shortcut.path}
                  type="button"
                  onClick={() => void loadDirectory(shortcut.path)}
                  className="rounded-md border border-[var(--border-hairline)] bg-[var(--bg-canvas)] px-2 py-1 text-[11px] text-[var(--text-secondary)] hover:border-[var(--accent)] hover:text-[var(--text-primary)]"
                >
                  {shortcut.label}
                </button>
              ))}
            </div>
          )}

          <form onSubmit={handleGoPath} className="flex items-center gap-2">
            <button
              type="button"
              disabled={!listing?.parentPath || loading}
              onClick={() => listing?.parentPath && void loadDirectory(listing.parentPath)}
              title="Subir para pasta pai"
              aria-label="Subir para pasta pai"
              className="inline-flex h-8 shrink-0 items-center gap-1 rounded-md border border-[var(--border-strong)] bg-[var(--bg-elevated)] px-2.5 text-xs text-[var(--text-primary)] hover:border-[var(--accent)] disabled:opacity-45"
            >
              <ArrowUp className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Acima</span>
            </button>
            <input
              type="text"
              value={pathDraft}
              onChange={(e) => setPathDraft(e.target.value)}
              aria-label="Caminho atual no navegador de pastas"
              className="min-w-0 flex-1 rounded-md border border-[var(--border-strong)] bg-[var(--bg-elevated)] px-2.5 py-1.5 font-mono text-xs text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none"
            />
            <button
              type="submit"
              disabled={loading || !pathDraft.trim()}
              className="h-8 shrink-0 rounded-md border border-[var(--border-strong)] bg-[var(--bg-elevated)] px-3 text-xs font-medium text-[var(--text-primary)] hover:border-[var(--accent)] disabled:opacity-45"
            >
              Abrir
            </button>
          </form>

          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-0 flex-1">
              <Search
                className="pointer-events-none absolute top-2.5 left-2.5 h-3.5 w-3.5 text-[var(--text-muted)]"
                aria-hidden="true"
              />
              <input
                type="search"
                value={filterText}
                onChange={(e) => setFilterText(e.target.value)}
                placeholder="Filtrar subpastas nesta pasta..."
                aria-label="Filtrar subpastas"
                className="w-full rounded-md border border-[var(--border-hairline)] bg-[var(--bg-canvas)] py-1.5 pr-3 pl-8 text-xs text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none"
              />
            </div>
            <button
              type="button"
              disabled={!activePath || Boolean(error) || loading}
              onClick={() => {
                setCreateError(null);
                setCreatingOpen((prev) => !prev);
              }}
              className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-[var(--border-strong)] bg-[var(--bg-elevated)] px-2.5 text-xs font-medium text-[var(--text-primary)] hover:border-[var(--accent)] disabled:opacity-45"
            >
              <FolderPlus className="h-3.5 w-3.5 text-[var(--accent)]" aria-hidden="true" />
              <span>Nova pasta</span>
            </button>
          </div>

          {creatingOpen && (
            <form
              onSubmit={(e) => void handleCreateFolder(e)}
              className="space-y-2 rounded-lg border border-[var(--border-strong)] bg-[var(--bg-elevated)] p-2.5"
            >
              <label
                htmlFor="vertice-new-folder-name"
                className="block text-[11px] font-medium text-[var(--text-primary)]"
              >
                Criar subpasta em <span className="font-mono">{activePath}</span>
              </label>
              <div className="flex items-center gap-2">
                <input
                  id="vertice-new-folder-name"
                  type="text"
                  autoFocus
                  value={newFolderName}
                  onChange={(e) => {
                    setCreateError(null);
                    setNewFolderName(e.target.value);
                  }}
                  placeholder="Ex.: meu-novo-projeto"
                  className="min-w-0 flex-1 rounded-md border border-[var(--border-strong)] bg-[var(--bg-surface)] px-2.5 py-1.5 text-xs text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none"
                />
                <button
                  type="button"
                  onClick={() => {
                    setCreatingOpen(false);
                    setNewFolderName('');
                    setCreateError(null);
                  }}
                  className="h-8 rounded-md border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2.5 text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={!newFolderName.trim() || creating}
                  className="h-8 rounded-md bg-[var(--accent)] px-3 text-xs font-semibold text-[var(--accent-contrast)] hover:bg-[var(--accent-hover)] disabled:opacity-50"
                >
                  {creating ? 'Criando...' : 'Criar'}
                </button>
              </div>
              {createError && (
                <p className="text-[11px] text-[var(--status-danger)]">{createError}</p>
              )}
            </form>
          )}

          {listing?.warning && (
            <p className="rounded-md border border-[var(--status-warning)]/40 bg-[var(--status-warning-soft)] px-2.5 py-1.5 text-[11px] text-[var(--status-warning)]">
              {listing.warning}
            </p>
          )}

          {error ? (
            <div className="rounded-md border border-[var(--status-danger)]/40 bg-[var(--status-danger-soft)] p-3 text-xs text-[var(--status-danger)]">
              {error}
            </div>
          ) : (
            <div
              role="list"
              aria-label="Subpastas disponíveis"
              className="max-h-60 divide-y divide-[var(--border-hairline)] overflow-y-auto rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-canvas)]"
            >
              {loading && !listing ? (
                <div className="px-3 py-6 text-center text-[var(--text-muted)]">
                  Carregando pastas locais...
                </div>
              ) : filteredDirectories.length === 0 ? (
                <div className="px-3 py-6 text-center text-[var(--text-muted)]">
                  {filterText.trim()
                    ? 'Nenhuma subpasta corresponde ao filtro.'
                    : 'Esta pasta não possui subpastas visíveis.'}
                </div>
              ) : (
                filteredDirectories.map((dir) => (
                  <button
                    key={dir.path}
                    type="button"
                    role="listitem"
                    onClick={() => void loadDirectory(dir.path)}
                    className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-xs text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-elevated)]"
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <Folder
                        className="h-3.5 w-3.5 shrink-0 text-[var(--accent)]"
                        aria-hidden="true"
                      />
                      <span className="truncate font-medium">{dir.name}</span>
                    </span>
                    <ChevronRight
                      className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]"
                      aria-hidden="true"
                    />
                  </button>
                ))
              )}
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--border-hairline)] bg-[var(--bg-canvas)] px-4 py-3">
          <div className="min-w-0 flex-1 text-[11px] text-[var(--text-secondary)]">
            <span className="text-[var(--text-muted)]">Selecionada: </span>
            <span className="break-all font-mono font-medium text-[var(--text-primary)]">
              {activePath || '—'}
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-[var(--border-hairline)] bg-[var(--bg-elevated)] px-3 py-1.5 text-xs font-medium text-[var(--text-primary)] hover:border-[var(--border-strong)]"
            >
              Cancelar
            </button>
            <button
              type="button"
              disabled={!activePath || Boolean(error)}
              onClick={() => {
                if (!activePath) return;
                onSelect(activePath);
                onClose();
              }}
              className="rounded-md bg-[var(--accent)] px-3 py-1.5 text-xs font-semibold text-[var(--accent-contrast)] hover:bg-[var(--accent-hover)] disabled:opacity-50"
            >
              Selecionar esta pasta
            </button>
          </div>
        </div>
      </div>
    </div>
  );

  return typeof document !== 'undefined'
    ? createPortal(modalNode, document.body)
    : modalNode;
}
