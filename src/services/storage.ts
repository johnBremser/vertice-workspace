import { APP_BRAND } from '../config/brand';
import { IncompatibleSchemaError, migrateWorkspaceState } from '../domain/migration';
import type { StorageStatus, WorkspaceStoreState } from '../domain/types';

export interface StorageDriver {
  load(): Promise<WorkspaceStoreState | null>;
  save(state: WorkspaceStoreState): Promise<void>;
  clear(): Promise<void>;
}

const DB_NAME = 'aion_desk_storage';
const DB_VERSION = APP_BRAND.storageSchemaVersion;
const STORE_NAME = 'workspace';
const ROOT_KEY = 'root_state';
const PREFS_KEY = 'aion_desk_ui_prefs_v1';

export type ThemePreference = 'system' | 'dark' | 'light';

export interface UiPreferences {
  theme: ThemePreference;
  sidebarCollapsed: boolean;
  drawerOpen: boolean;
  drawerTab: 'tasks' | 'context';
}

const DEFAULT_PREFS: UiPreferences = {
  theme: 'system',
  sidebarCollapsed: false,
  drawerOpen: false,
  drawerTab: 'tasks',
};

export function loadUiPreferences(): UiPreferences {
  try {
    if (typeof window === 'undefined' || !window.localStorage) {
      return DEFAULT_PREFS;
    }
    const raw = window.localStorage.getItem(PREFS_KEY);
    if (!raw) return DEFAULT_PREFS;
    const parsed = JSON.parse(raw) as Partial<UiPreferences>;
    return {
      theme:
        parsed.theme === 'dark' || parsed.theme === 'light' || parsed.theme === 'system'
          ? parsed.theme
          : 'system',
      sidebarCollapsed: Boolean(parsed.sidebarCollapsed),
      drawerOpen: Boolean(parsed.drawerOpen),
      drawerTab: parsed.drawerTab === 'context' ? 'context' : 'tasks',
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

export function saveUiPreferences(prefs: UiPreferences): void {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return;
    window.localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // Non-critical preference write failure does not interrupt workspace flow.
  }
}

export class IndexedDbStorageDriver implements StorageDriver {
  private openDb(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') {
        reject(new Error('IndexedDB indisponível neste ambiente.'));
        return;
      }
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () =>
        reject(req.error ?? new Error('Falha ao abrir IndexedDB.'));
      req.onblocked = () =>
        reject(new Error('Abertura do IndexedDB bloqueada pelo navegador.'));
    });
  }

  async load(): Promise<WorkspaceStoreState | null> {
    const db = await this.openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(ROOT_KEY);
      req.onsuccess = () => {
        const val = req.result as WorkspaceStoreState | undefined;
        resolve(val ?? null);
      };
      req.onerror = () =>
        reject(req.error ?? new Error('Falha ao ler dados do IndexedDB.'));
      tx.oncomplete = () => db.close();
      tx.onabort = () => {
        db.close();
        reject(tx.error ?? new Error('Transação de leitura abortada.'));
      };
    });
  }

  async save(state: WorkspaceStoreState): Promise<void> {
    const db = await this.openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      store.put(state, ROOT_KEY);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error ?? new Error('Falha ao gravar dados no IndexedDB.'));
      };
      tx.onabort = () => {
        db.close();
        reject(
          tx.error ??
          new Error('Transação de gravação abortada (possível cota excedida).'),
        );
      };
    });
  }

  async clear(): Promise<void> {
    const db = await this.openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      store.delete(ROOT_KEY);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error ?? new Error('Falha ao limpar IndexedDB.'));
      };
    });
  }
}

export class MemoryOnlyStorageDriver implements StorageDriver {
  private snapshot: WorkspaceStoreState | null = null;
  private readonly shouldFailOnWrite: boolean;

  constructor(options?: { failOnWrite?: boolean }) {
    this.shouldFailOnWrite = Boolean(options?.failOnWrite);
  }

  async load(): Promise<WorkspaceStoreState | null> {
    return this.snapshot;
  }

  async save(state: WorkspaceStoreState): Promise<void> {
    if (this.shouldFailOnWrite) {
      const err = new Error('QuotaExceededError: armazenamento local sem espaço.');
      err.name = 'QuotaExceededError';
      throw err;
    }
    this.snapshot = structuredClone(state);
  }

  async clear(): Promise<void> {
    this.snapshot = null;
  }
}

export interface StorageHealthInfo {
  status: StorageStatus;
  errorMessage?: string;
}

export class WorkspacePersistenceManager {
  private driver: StorageDriver;
  private status: StorageStatus = 'loading';
  private errorMessage: string | undefined;
  private listeners = new Set<(info: StorageHealthInfo) => void>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private writeGeneration = 0;
  private queuedWrite: { state: WorkspaceStoreState; generation: number } | null =
    null;
  private activeWritePromise: Promise<void> | null = null;
  private memoryFallbackState: WorkspaceStoreState | null = null;

  constructor(driver: StorageDriver = new IndexedDbStorageDriver()) {
    this.driver = driver;
  }

  subscribe(listener: (info: StorageHealthInfo) => void): () => void {
    this.listeners.add(listener);
    listener({ status: this.status, errorMessage: this.errorMessage });
    return () => {
      this.listeners.delete(listener);
    };
  }

  getInfo(): StorageHealthInfo {
    return { status: this.status, errorMessage: this.errorMessage };
  }

  private emit(status: StorageStatus, errorMessage?: string): void {
    this.status = status;
    this.errorMessage = errorMessage;
    const payload = { status, errorMessage };
    for (const listener of this.listeners) {
      listener(payload);
    }
  }

  async loadInitial(
    createDefaultState: () => WorkspaceStoreState,
  ): Promise<WorkspaceStoreState> {
    this.emit('loading');
    try {
      const loaded = await this.driver.load();
      if (loaded) {
        const previousSchema = Number((loaded as { schemaVersion?: number }).schemaVersion ?? 1);
        const migrated = migrateWorkspaceState(loaded);
        const sanitized = sanitizeLoadedStateAfterReload(migrated);
        this.memoryFallbackState = sanitized;
        const reloadPausedAny = Object.keys(sanitized.conversations).some(
          (cid) =>
            sanitized.conversations[cid]?.conversation.executionStatus !==
            migrated.conversations[cid]?.conversation.executionStatus,
        );
        if (previousSchema < APP_BRAND.storageSchemaVersion || reloadPausedAny) {
          await this.driver.save(sanitized);
        }
        this.emit('saved');
        return sanitized;
      }
      const initial = createDefaultState();
      this.memoryFallbackState = initial;
      await this.driver.save(initial);
      this.emit('saved');
      return initial;
    } catch (err) {
      if (err instanceof IncompatibleSchemaError) {
        const fallback = this.memoryFallbackState ?? createDefaultState();
        this.memoryFallbackState = fallback;
        this.emit(
          'session_only',
          `${err.message} Dados locais preservados sem sobrescrita; exporte um backup se desejar.`,
        );
        return fallback;
      }
      const initial = this.memoryFallbackState ?? createDefaultState();
      this.memoryFallbackState = initial;
      const reason =
        err instanceof Error ? err.message : 'Armazenamento indisponível.';
      this.emit(
        'session_only',
        `Armazenamento local indisponível (${reason}). Dados mantidos apenas nesta sessão.`,
      );
      return initial;
    }
  }

  scheduleSave(state: WorkspaceStoreState, debounceMs = 180): void {
    this.memoryFallbackState = state;
    if (this.status === 'session_only') {
      return;
    }
    this.writeGeneration += 1;
    this.queuedWrite = {
      state: structuredClone(state),
      generation: this.writeGeneration,
    };
    this.emit('saving');

    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer);
    }
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.flushSave();
    }, debounceMs);
  }

  async flushSave(): Promise<void> {
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (this.activeWritePromise) {
      await this.activeWritePromise;
      if (this.queuedWrite && this.status !== 'session_only') {
        await this.flushSave();
      }
      return;
    }
    if (!this.queuedWrite || this.status === 'session_only') {
      if (
        !this.queuedWrite &&
        this.saveTimer === null &&
        this.status === 'saving'
      ) {
        this.emit('saved');
      }
      return;
    }

    const runLoop = async () => {
      while (this.queuedWrite && this.status !== 'session_only') {
        const target = this.queuedWrite;
        this.queuedWrite = null;
        if (
          target.generation === this.writeGeneration &&
          this.saveTimer !== null
        ) {
          clearTimeout(this.saveTimer);
          this.saveTimer = null;
        }
        try {
          await this.driver.save(target.state);
          if (
            !this.queuedWrite &&
            this.saveTimer === null &&
            target.generation === this.writeGeneration
          ) {
            this.emit('saved');
          }
        } catch (err) {
          this.queuedWrite = null;
          if (this.saveTimer !== null) {
            clearTimeout(this.saveTimer);
            this.saveTimer = null;
          }
          const reason =
            err instanceof Error
              ? err.message
              : 'Falha ao persistir no navegador.';
          this.emit(
            'session_only',
            `Falha ao salvar no armazenamento local (${reason}). Alterações permanecem apenas nesta sessão; utilize Exportar.`,
          );
          break;
        }
      }
    };

    this.activeWritePromise = runLoop().finally(() => {
      this.activeWritePromise = null;
    });
    await this.activeWritePromise;
  }

  async resetAndSave(state: WorkspaceStoreState): Promise<void> {
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.memoryFallbackState = state;
    if (this.status === 'session_only') {
      this.emit('session_only', this.errorMessage);
      return;
    }
    this.writeGeneration += 1;
    this.queuedWrite = {
      state: structuredClone(state),
      generation: this.writeGeneration,
    };
    this.emit('saving');
    await this.flushSave();
  }

  dispose(): void {
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
  }
}

/**
 * Ensures reloading the page never leaves active runs pretending to execute in
 * the background, invalidates live runtime/auth flags until re-verified, and
 * removes legacy seeded demonstration artifacts from previous builds.
 */
export function sanitizeLoadedStateAfterReload(
  state: WorkspaceStoreState,
): WorkspaceStoreState {
  const nextConversations: WorkspaceStoreState['conversations'] = {};
  for (const [convId, projection] of Object.entries(state.conversations)) {
    if (convId === 'conv_demo_busca_nome') {
      continue;
    }
    const wasRunning =
      projection.conversation.executionStatus === 'running' ||
      Boolean(projection.conversation.autoPlayWasRunning);
    const originalMode = projection.conversation.executionMode;

    nextConversations[convId] = {
      ...projection,
      conversation: {
        ...projection.conversation,
        executionMode: originalMode,
        executionStatus: wasRunning
          ? originalMode === 'aion_core'
            ? 'paused_queue'
            : 'paused_demo'
          : projection.conversation.executionStatus,
        autoPlayWasRunning: false,
      },
    };
  }

  const referencedProjectIds = new Set(
    Object.values(nextConversations).map((p) => p.conversation.projectId),
  );
  const nextProjects = state.projects.filter(
    (p) => p.id !== 'proj_demo_portal' || referencedProjectIds.has(p.id),
  );

  const nextConnections = state.connections
    .filter((conn) => conn.mode === 'aion_core')
    .map((conn) => ({
      ...conn,
      coreReachability: 'unknown' as const,
      catalogLoaded: false,
      coreAgentStatus: undefined,
      authStatus: 'unknown' as const,
      sessionStatus: 'inactive' as const,
    }));

  const activeConversationId =
    state.activeConversationId && nextConversations[state.activeConversationId]
      ? state.activeConversationId
      : Object.keys(nextConversations)[0] ?? '';
  const activeProjectId =
    state.activeProjectId && nextProjects.some((p) => p.id === state.activeProjectId)
      ? state.activeProjectId
      : activeConversationId
        ? nextConversations[activeConversationId].conversation.projectId
        : nextProjects[0]?.id ?? '';

  const sanitizedAssistantState = state.assistantState
    ? {
        ...state.assistantState,
        status:
          state.assistantState.status === 'streaming' ||
          state.assistantState.status === 'configuring'
            ? ('idle' as const)
            : state.assistantState.status,
        messages: state.assistantState.messages.map((m) =>
          m.status === 'streaming'
            ? {
                ...m,
                status: 'error' as const,
                contentMarkdown: m.contentMarkdown
                  ? `${m.contentMarkdown}\n\n_(Resposta interrompida ao recarregar a página.)_`
                  : 'Resposta interrompida ao recarregar a página.',
              }
            : m.permissionRequest && m.permissionRequest.status === 'pending'
              ? {
                  ...m,
                  permissionRequest: {
                    ...m.permissionRequest,
                    status: 'denied' as const,
                  },
                }
              : m,
        ),
      }
    : undefined;

  return {
    ...state,
    executionMode: 'aion_core',
    coreRuntimeStatus: 'unknown',
    coreSessionAuthenticated: false,
    projects: nextProjects,
    connections: nextConnections,
    conversations: nextConversations,
    activeProjectId,
    activeConversationId,
    assistantState: sanitizedAssistantState,
  };
}
