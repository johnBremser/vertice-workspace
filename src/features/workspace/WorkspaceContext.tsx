import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type {
  ConnectionAdapterConfig,
  ConversationProjection,
  ConversationToolApprovalPolicy,
  CoreRuntimeSettings,
  DemoModelTier,
  ExecutionMode,
  ModelPolicy,
  ModelRef,
  ParticipantProfile,
  ParticipantRole,
  Project,
  StorageStatus,
  TaskReview,
  TeamPreset,
  TeamPresetMember,
  VerticeAssistantState,
  WorkspaceStoreState,
} from '../../domain/types';
import { AionCoreAdapter } from '../../services/aionCoreAdapter';
import {
  GatewayCapabilityError,
  type AgentWorkspaceGateway,
  type CoreDiagnosticEntry,
  type CoreTeamSummary,
} from '../../services/gateway';
import {
  IndexedDbStorageDriver,
  loadUiPreferences,
  saveUiPreferences,
  WorkspacePersistenceManager,
  type ThemePreference,
} from '../../services/storage';

export interface ActionBanner {
  tone: 'info' | 'success' | 'warning' | 'danger';
  message: string;
}

export interface HighlightTarget {
  eventId: string;
  nonce: number;
}

export type GatewayFactory = (
  persistence: WorkspacePersistenceManager,
) => AgentWorkspaceGateway;

function defaultGatewayFactory(
  persistence: WorkspacePersistenceManager,
): AgentWorkspaceGateway {
  return new AionCoreAdapter(persistence);
}

export async function probeCoreSessionOnStartup(
  gateway: AgentWorkspaceGateway,
  shouldContinue: () => boolean,
): Promise<void> {
  if (!gateway.core || !shouldContinue()) return;
  try {
    await gateway.core.checkHealth();
    if (!shouldContinue()) return;
    const auth = await gateway.core.checkAuthStatus();
    if (!shouldContinue()) return;
    if (auth.authenticated) {
      await gateway.core.refreshCoreCatalog();
      if (!shouldContinue()) return;
      try {
        if (gateway.core.ensureWebSocketConnected) {
          await gateway.core.ensureWebSocketConnected();
        } else {
          await gateway.core.connectWebSocket();
        }
      } catch {
        // Conexão WebSocket inicial em melhor esforço durante abertura silenciosa.
      }
    }
  } catch {
    // Revalidação silenciosa inicial: falhas de rede/502 já atualizam coreRuntimeStatus
    // sem bloquear o carregamento nem exibir alertas ruidosos na abertura.
  }
}

interface WorkspaceContextValue {
  loading: boolean;
  store: WorkspaceStoreState | null;
  activeProject: Project | undefined;
  activeConversation: ConversationProjection | undefined;
  activeTabId: string;
  storageStatus: StorageStatus;
  storageErrorMessage?: string;
  themePreference: ThemePreference;
  resolvedTheme: 'dark' | 'light';
  sidebarCollapsed: boolean;
  mobileSidebarOpen: boolean;
  drawerOpen: boolean;
  drawerTab: 'tasks' | 'context' | 'files';
  mainSurface: 'conversation' | 'settings';
  selectedTaskId: string | null;
  highlightedEvent: HighlightTarget | null;
  actionBanner: ActionBanner | null;
  hasCoreOperations: boolean;
  getDraft: (conversationId: string, tabId: string) => string;
  setDraft: (conversationId: string, tabId: string, value: string) => void;
  getSavedScrollTop: (conversationId: string, tabId: string) => number | undefined;
  saveScrollTop: (conversationId: string, tabId: string, scrollTop: number) => void;
  setThemePreference: (theme: ThemePreference) => void;
  toggleSidebar: () => void;
  closeMobileSidebar: () => void;
  openDrawer: (tab: 'tasks' | 'context' | 'files', taskId?: string) => void;
  closeDrawer: () => void;
  setMainSurface: (surface: 'conversation' | 'settings') => void;
  selectConversation: (projectId: string, conversationId: string) => void;
  selectTab: (tabId: string) => void;
  navigateToOrigin: (params: {
    tabId?: string;
    eventId?: string;
    taskId?: string;
    contextVersion?: number;
  }) => void;
  dismissBanner: () => void;
  setBanner: (banner: ActionBanner) => void;

  setExecutionMode: (mode: ExecutionMode) => Promise<void>;
  updateCoreSettings: (settings: CoreRuntimeSettings) => Promise<void>;

  createProject: (input: {
    name: string;
    description: string;
    workspacePathInfo: string;
  }) => Promise<void>;
  renameProject: (projectId: string, name: string) => Promise<void>;
  updateProject: (input: {
    projectId: string;
    name: string;
    description?: string;
    workspacePathInfo?: string;
  }) => Promise<void>;
  setProjectArchived: (projectId: string, archived: boolean) => Promise<void>;
  createConversation: (
    projectId: string,
    title: string,
    presetId?: string,
  ) => Promise<void>;
  renameConversation: (conversationId: string, title: string) => Promise<void>;
  setConversationArchived: (
    conversationId: string,
    archived: boolean,
  ) => Promise<void>;

  saveParticipantProfile: (
    profile: Omit<ParticipantProfile, 'id'> & { id?: string },
  ) => Promise<void>;
  archiveParticipantProfile: (
    profileId: string,
    archived: boolean,
  ) => Promise<void>;
  saveTeamPreset: (
    preset: Omit<TeamPreset, 'id'> & { id?: string },
  ) => Promise<TeamPreset>;
  applyTeamPreset: (presetId: string) => Promise<void>;
  addParticipantToConversation: (member: TeamPresetMember) => Promise<void>;
  removeParticipantFromConversation: (
    participantId: string,
    reason?: string,
  ) => Promise<void>;
  reorderParticipantTabs: (orderedParticipantIds: string[]) => Promise<void>;
  configureParticipant: (input: {
    participantId: string;
    displayName?: string;
    role?: ParticipantRole;
    roles?: ParticipantRole[];
    modelTier?: DemoModelTier;
    modelRef?: ModelRef;
    instructions?: string;
    connectionId?: string;
    reason?: string;
  }) => Promise<void>;

  createTask: (input: {
    title: string;
    description: string;
    assigneeParticipantId: string;
    reviewerParticipantId?: string;
    dependencyTaskIds: string[];
    acceptanceCriteria: string[];
  }) => Promise<void>;
  updateTask: (input: {
    taskId: string;
    title: string;
    description: string;
    assigneeParticipantId: string;
    reviewerParticipantId?: string;
    dependencyTaskIds: string[];
    acceptanceCriteria: string[];
  }) => Promise<void>;
  publishPlanRevision: (summary: string) => Promise<void>;

  sendMessage: (
    bodyMarkdown: string,
    promoteToSharedContext?: boolean,
  ) => Promise<void>;
  updateModelPolicy: (policy: ModelPolicy) => Promise<void>;
  publishContextRevision: (input: {
    summaryOfChange: string;
    objective: string;
    permanentInstructions: string[];
    constraints: string[];
    acceptanceCriteria: string[];
    confirmedDecisions: string[];
  }) => Promise<void>;
  controlExecution: (
    action:
      | 'pause_queue'
      | 'resume_queue'
      | 'request_interrupt'
      | 'terminate_session',
    participantId?: string,
  ) => Promise<void>;
  dispatchTask: (taskId: string) => Promise<void>;
  setConversationToolApprovalPolicy: (
    policy: ConversationToolApprovalPolicy,
  ) => Promise<void>;
  respondPermission: (
    requestId: string,
    decision: 'approved' | 'denied',
    options?: { alwaysAllow?: boolean },
  ) => Promise<void>;
  resolveEscalation: (
    escalationId: string,
    resolution: 'approved' | 'dismissed',
  ) => Promise<void>;
  registerTaskReview: (
    review: Omit<TaskReview, 'id' | 'decidedAt' | 'sourceEventId'>,
  ) => Promise<void>;
  testAgentConnection: (connectionId: string) => Promise<void>;
  reconcileConversation: () => Promise<void>;
  importWorkspaceState: (nextState: WorkspaceStoreState) => Promise<void>;

  // Core local operations (when gateway.core is present)
  coreCheckHealth: () => Promise<void>;
  coreCheckAuthStatus: () => Promise<void>;
  coreLogin: (username: string, password: string) => Promise<void>;
  coreLogout: () => Promise<void>;
  coreRefreshCatalog: () => Promise<void>;
  coreSyncTeams: () => Promise<void>;
  coreDeleteTeam: (teamId: string) => Promise<void>;
  coreCleanupOrphanTeams: () => Promise<void>;
  coreTeamsList: CoreTeamSummary[];
  coreCreateTeamForActiveConversation: (teamName?: string) => Promise<void>;
  coreConnectWs: () => Promise<void>;
  coreDisconnectWs: () => void;
  coreGetDiagnostics: () => CoreDiagnosticEntry[];

  // Vertice Floating Assistant & Knowledge Base
  assistantState: VerticeAssistantState;
  assistantEligibleConnections: ConnectionAdapterConfig[];
  assistantOpen: boolean;
  assistantTab: 'chat' | 'kb' | 'source';
  assistantSourcePreviewPath: string | null;
  setAssistantOpen: (open: boolean) => void;
  setAssistantTab: (tab: 'chat' | 'kb' | 'source') => void;
  openAssistantSourceFile: (relPath: string) => void;
  configureVerticeAssistant: (input: {
    connectionId: string;
    modelExternalId: string;
    modelDisplayName: string;
    includeLiveDiagnostics?: boolean;
    includeSourceContext?: boolean;
  }) => Promise<void>;
  updateVerticeAssistantPreferences: (input: {
    includeLiveDiagnostics?: boolean;
    includeSourceContext?: boolean;
  }) => void;
  sendVerticeAssistantMessage: (input: {
    prompt: string;
    sourceQuery?: string;
    attachments?: Array<{
      id: string;
      name: string;
      kind: 'image' | 'text';
      mimeType: string;
      sizeBytes: number;
      textContent?: string;
      truncated?: boolean;
      file?: File;
    }>;
  }) => Promise<void>;
  respondVerticeAssistantPermission: (
    requestId: string,
    decision: 'approved' | 'denied',
  ) => Promise<void>;
  clearVerticeAssistantHistory: () => Promise<void>;
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

function resolveSystemTheme(): 'dark' | 'light' {
  if (typeof window === 'undefined' || !window.matchMedia) return 'dark';
  return window.matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';
}

export function WorkspaceProvider({
  children,
  gatewayFactory = defaultGatewayFactory,
}: {
  children: ReactNode;
  gatewayFactory?: GatewayFactory;
}) {
  const persistenceRef = useRef<WorkspacePersistenceManager | null>(null);
  const gatewayRef = useRef<AgentWorkspaceGateway | null>(null);
  const unsubGatewayRef = useRef<(() => void)[]>([]);

  if (!persistenceRef.current) {
    persistenceRef.current = new WorkspacePersistenceManager(
      new IndexedDbStorageDriver(),
    );
  }
  if (!gatewayRef.current) {
    gatewayRef.current = gatewayFactory(persistenceRef.current);
  }

  const initialPrefs = useMemo(() => loadUiPreferences(), []);
  const [loading, setLoading] = useState(true);
  const [store, setStore] = useState<WorkspaceStoreState | null>(null);
  const [storageStatus, setStorageStatus] = useState<StorageStatus>('loading');
  const [storageErrorMessage, setStorageErrorMessage] = useState<
    string | undefined
  >();
  const [themePreference, setThemePrefState] = useState<ThemePreference>(
    initialPrefs.theme,
  );
  const [systemTheme, setSystemTheme] = useState<'dark' | 'light'>(
    resolveSystemTheme,
  );
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    initialPrefs.sidebarCollapsed,
  );
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(() => {
    try {
      const hasSaved =
        typeof window !== 'undefined' &&
        Boolean(window.localStorage?.getItem('aion_desk_ui_prefs_v1'));
      if (!hasSaved && typeof window !== 'undefined') {
        return window.innerWidth >= 1200;
      }
    } catch {
      // ignore storage access issues
    }
    return initialPrefs.drawerOpen;
  });
  const [drawerTab, setDrawerTab] = useState<'tasks' | 'context' | 'files'>(
    initialPrefs.drawerTab,
  );
  const [mainSurface, setMainSurface] = useState<'conversation' | 'settings'>(
    'conversation',
  );
  const [activeTabByConv, setActiveTabByConv] = useState<
    Record<string, string>
  >({});
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [highlightedEvent, setHighlightedEvent] =
    useState<HighlightTarget | null>(null);
  const [actionBanner, setActionBanner] = useState<ActionBanner | null>(null);
  const [gatewayGeneration, setGatewayGeneration] = useState(0);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [assistantTab, setAssistantTab] = useState<'chat' | 'kb' | 'source'>('chat');
  const [assistantSourcePreviewPath, setAssistantSourcePreviewPath] = useState<string | null>(null);
  const [coreTeamsList, setCoreTeamsList] = useState<CoreTeamSummary[]>([]);

  const draftsRef = useRef<Record<string, string>>({});
  const [draftVersion, setDraftVersion] = useState(0);
  const scrollTopRef = useRef<Record<string, number>>({});

  const resolvedTheme: 'dark' | 'light' =
    themePreference === 'system' ? systemTheme : themePreference;

  useEffect(() => {
    const root = document.documentElement;
    if (resolvedTheme === 'dark') {
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
    }
  }, [resolvedTheme]);

  useEffect(() => {
    if (!window.matchMedia) return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => setSystemTheme(mq.matches ? 'dark' : 'light');
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  useEffect(() => {
    if (!window.matchMedia) return;
    const wideQuery = window.matchMedia('(min-width: 1280px)');
    const onBreakpointChange = (ev: MediaQueryListEvent) => {
      if (!ev.matches) {
        setDrawerOpen(false);
      }
    };
    wideQuery.addEventListener('change', onBreakpointChange);
    return () => wideQuery.removeEventListener('change', onBreakpointChange);
  }, []);

  useEffect(() => {
    saveUiPreferences({
      theme: themePreference,
      sidebarCollapsed,
      drawerOpen,
      drawerTab,
    });
  }, [themePreference, sidebarCollapsed, drawerOpen, drawerTab]);

  const bindGateway = useCallback((gateway: AgentWorkspaceGateway) => {
    for (const unsub of unsubGatewayRef.current) {
      unsub();
    }
    unsubGatewayRef.current = [];

    const unsubState = gateway.subscribeState((nextState) => {
      setStore(nextState);
    });
    unsubGatewayRef.current.push(unsubState);

    gatewayRef.current = gateway;
    setGatewayGeneration((g) => g + 1);
  }, []);

  useEffect(() => {
    const persistence = persistenceRef.current!;
    const initialGateway = gatewayRef.current!;

    const unsubStorage = persistence.subscribe((info) => {
      setStorageStatus(info.status);
      setStorageErrorMessage(info.errorMessage);
    });

    bindGateway(initialGateway);

    let cancelled = false;

    void initialGateway
      .loadWorkspace()
      .then(() => {
        if (cancelled) return;
        void probeCoreSessionOnStartup(
          initialGateway,
          () => !cancelled && gatewayRef.current === initialGateway,
        );
      })
      .finally(() => {
        setLoading(false);
      });

    return () => {
      cancelled = true;
      unsubStorage();
      for (const unsub of unsubGatewayRef.current) {
        unsub();
      }
      unsubGatewayRef.current = [];
      gatewayRef.current?.dispose();
    };
  }, [bindGateway, gatewayFactory]);

  const activeConversationId = store?.activeConversationId ?? '';
  const activeTabId =
    (activeConversationId && activeTabByConv[activeConversationId]) || 'general';

  const activeProject = useMemo(
    () => store?.projects.find((p) => p.id === store.activeProjectId),
    [store],
  );

  const activeConversation = useMemo(
    () =>
      store && store.activeConversationId
        ? store.conversations[store.activeConversationId]
        : undefined,
    [store],
  );

  const runAction = useCallback(async (fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (err) {
      if (err instanceof GatewayCapabilityError) {
        setActionBanner({ tone: 'warning', message: err.message });
      } else {
        setActionBanner({
          tone: 'danger',
          message:
            err instanceof Error ? err.message : 'Erro inesperado na operação.',
        });
      }
    }
  }, []);

  const selectConversation = useCallback(
    (projectId: string, conversationId: string) => {
      setMainSurface('conversation');
      setMobileSidebarOpen(false);
      setSelectedTaskId(null);
      setHighlightedEvent(null);
      const savedTab = activeTabByConv[conversationId] ?? 'general';
      gatewayRef.current!.setActiveView({
        projectId,
        conversationId,
        tabId: savedTab,
      });
    },
    [activeTabByConv],
  );

  const selectTab = useCallback(
    (tabId: string) => {
      if (!activeConversationId) return;
      setMainSurface('conversation');
      setActiveTabByConv((prev) => ({ ...prev, [activeConversationId]: tabId }));
      gatewayRef.current!.setActiveView({
        conversationId: activeConversationId,
        tabId,
      });
    },
    [activeConversationId],
  );

  const openDrawer = useCallback(
    (tab: 'tasks' | 'context' | 'files', taskId?: string) => {
      setDrawerTab(tab);
      setDrawerOpen(true);
      if (taskId) {
        setSelectedTaskId(taskId);
      }
    },
    [],
  );

  const closeDrawer = useCallback(() => {
    setDrawerOpen(false);
  }, []);

  const navigateToOrigin = useCallback(
    (params: {
      tabId?: string;
      eventId?: string;
      taskId?: string;
      contextVersion?: number;
    }) => {
      if (params.contextVersion !== undefined) {
        openDrawer('context');
      } else if (params.taskId && !params.tabId) {
        openDrawer('tasks', params.taskId);
        return;
      }

      if (params.taskId) {
        setSelectedTaskId(params.taskId);
        if (!params.tabId) {
          openDrawer('tasks', params.taskId);
        }
      }

      if (params.tabId) {
        selectTab(params.tabId);
      }

      if (params.eventId) {
        setHighlightedEvent({ eventId: params.eventId, nonce: Date.now() });
      }
    },
    [openDrawer, selectTab],
  );

  const getDraft = useCallback(
    (conversationId: string, tabId: string) => {
      void draftVersion;
      return draftsRef.current[`${conversationId}:${tabId}`] ?? '';
    },
    [draftVersion],
  );

  const setDraft = useCallback(
    (conversationId: string, tabId: string, value: string) => {
      draftsRef.current[`${conversationId}:${tabId}`] = value;
      setDraftVersion((v) => v + 1);
    },
    [],
  );

  const getSavedScrollTop = useCallback(
    (conversationId: string, tabId: string) => {
      return scrollTopRef.current[`${conversationId}:${tabId}`];
    },
    [],
  );

  const saveScrollTop = useCallback(
    (conversationId: string, tabId: string, scrollTop: number) => {
      scrollTopRef.current[`${conversationId}:${tabId}`] = scrollTop;
    },
    [],
  );

  const requireCoreOps = useCallback(() => {
    const core = gatewayRef.current?.core;
    if (!core) {
      throw new GatewayCapabilityError(
        'CAPABILITY_UNSUPPORTED',
        'Conexão AionCore local indisponível.',
      );
    }
    return core;
  }, []);

  void gatewayGeneration;

  const assistantState: VerticeAssistantState = store?.assistantState ?? {
    status: 'idle',
    messages: [],
  };

  const assistantEligibleConnections = useMemo(() => {
    if (!store || store.executionMode !== 'aion_core' || !store.coreSessionAuthenticated) {
      return [];
    }
    const candidates = store.connections.filter(
      (c) =>
        c.mode === 'aion_core' &&
        Boolean(c.coreAssistantId) &&
        c.catalogLoaded &&
        c.availableModels.some((m) => m.confirmed),
    );
    const executable = candidates.filter((c) => c.executableStatus !== 'missing');
    const pool = executable.length > 0 ? executable : candidates;
    return [...pool].sort((a, b) => {
      const score = (c: ConnectionAdapterConfig) =>
        (c.executableStatus === 'verified' ? 2 : 0) +
        (c.coreAgentStatus === 'online' ? 1 : 0);
      return score(b) - score(a);
    });
  }, [store]);

  const openAssistantSourceFile = useCallback((relPath: string) => {
    setAssistantSourcePreviewPath(relPath);
    setAssistantTab('source');
    setAssistantOpen(true);
  }, []);

  const value: WorkspaceContextValue = {
    loading,
    store,
    activeProject,
    activeConversation,
    activeTabId,
    storageStatus,
    storageErrorMessage,
    themePreference,
    resolvedTheme,
    sidebarCollapsed,
    mobileSidebarOpen,
    drawerOpen,
    drawerTab,
    mainSurface,
    selectedTaskId,
    highlightedEvent,
    actionBanner,
    hasCoreOperations: Boolean(gatewayRef.current?.core),
    getDraft,
    setDraft,
    getSavedScrollTop,
    saveScrollTop,
    setThemePreference: setThemePrefState,
    toggleSidebar: () => {
      if (typeof window !== 'undefined' && window.innerWidth < 1024) {
        setMobileSidebarOpen((o) => !o);
      } else {
        setSidebarCollapsed((c) => !c);
      }
    },
    closeMobileSidebar: () => setMobileSidebarOpen(false),
    openDrawer,
    closeDrawer,
    setMainSurface: (surface) => {
      setMainSurface(surface);
      if (surface === 'settings') {
        setMobileSidebarOpen(false);
      }
    },
    selectConversation,
    selectTab,
    navigateToOrigin,
    dismissBanner: () => setActionBanner(null),
    setBanner: setActionBanner,

    setExecutionMode: async () =>
      runAction(async () => {
        await gatewayRef.current!.setExecutionMode('aion_core');
      }),

    updateCoreSettings: async (settings) =>
      runAction(async () => {
        await gatewayRef.current!.updateCoreSettings(settings);
        setActionBanner({
          tone: 'success',
          message: 'Configurações de endereço e workspace do AionCore salvas.',
        });
      }),

    createProject: async (input) =>
      runAction(async () => {
        await gatewayRef.current!.createProject(input);
        setMainSurface('conversation');
      }),
    renameProject: async (projectId, name) =>
      runAction(async () => {
        await gatewayRef.current!.renameProject(projectId, name);
      }),
    updateProject: async (input) =>
      runAction(async () => {
        await gatewayRef.current!.updateProject(input);
      }),
    setProjectArchived: async (projectId, archived) =>
      runAction(async () => {
        await gatewayRef.current!.setProjectArchived(projectId, archived);
      }),
    createConversation: async (projectId, title, presetId) =>
      runAction(async () => {
        await gatewayRef.current!.createConversation({
          projectId,
          title,
          presetId,
        });
        setMainSurface('conversation');
      }),
    renameConversation: async (conversationId, title) =>
      runAction(async () => {
        await gatewayRef.current!.renameConversation(conversationId, title);
      }),
    setConversationArchived: async (conversationId, archived) =>
      runAction(async () => {
        await gatewayRef.current!.setConversationArchived(
          conversationId,
          archived,
        );
      }),

    saveParticipantProfile: async (profile) =>
      runAction(async () => {
        await gatewayRef.current!.saveParticipantProfile(profile);
        setActionBanner({
          tone: 'success',
          message: 'Perfil de participante salvo no catálogo local.',
        });
      }),
    archiveParticipantProfile: async (profileId, archived) =>
      runAction(async () => {
        await gatewayRef.current!.archiveParticipantProfile(
          profileId,
          archived,
        );
      }),
    saveTeamPreset: async (preset) => {
      const saved = await gatewayRef.current!.saveTeamPreset(preset);
      setActionBanner({
        tone: 'success',
        message: 'Preset de equipe salvo para novas conversas.',
      });
      return saved;
    },
    applyTeamPreset: async (presetId) =>
      runAction(async () => {
        if (!activeConversationId) return;
        await gatewayRef.current!.applyTeamPreset(
          activeConversationId,
          presetId,
        );
        setActiveTabByConv((prev) => ({
          ...prev,
          [activeConversationId]: 'general',
        }));
        setActionBanner({
          tone: 'success',
          message:
            'Preset aplicado com novas instâncias e sessões independentes na conversa.',
        });
      }),
    addParticipantToConversation: async (member) =>
      runAction(async () => {
        if (!activeConversationId) return;
        await gatewayRef.current!.addParticipantToConversation(
          activeConversationId,
          member,
        );
      }),
    removeParticipantFromConversation: async (participantId, reason) =>
      runAction(async () => {
        if (!activeConversationId) return;
        await gatewayRef.current!.removeParticipantFromConversation(
          activeConversationId,
          participantId,
          reason,
        );
        if (activeTabId === participantId) {
          selectTab('general');
        }
      }),
    reorderParticipantTabs: async (orderedParticipantIds) =>
      runAction(async () => {
        if (!activeConversationId) return;
        await gatewayRef.current!.reorderParticipantTabs(
          activeConversationId,
          orderedParticipantIds,
        );
      }),
    configureParticipant: async (input) =>
      runAction(async () => {
        if (!activeConversationId) return;
        await gatewayRef.current!.configureParticipant({
          conversationId: activeConversationId,
          ...input,
        });
      }),

    createTask: async (input) =>
      runAction(async () => {
        if (!activeConversationId) return;
        await gatewayRef.current!.createTask({
          conversationId: activeConversationId,
          ...input,
        });
        setActionBanner({
          tone: 'success',
          message: `Tarefa "${input.title}" criada.`,
        });
      }),
    updateTask: async (input) =>
      runAction(async () => {
        if (!activeConversationId) return;
        await gatewayRef.current!.updateTask({
          conversationId: activeConversationId,
          ...input,
        });
        setActionBanner({
          tone: 'success',
          message: 'Tarefa atualizada.',
        });
      }),
    publishPlanRevision: async (summary) =>
      runAction(async () => {
        if (!activeConversationId) return;
        const plan = await gatewayRef.current!.publishPlanRevision({
          conversationId: activeConversationId,
          summary,
        });
        setActionBanner({
          tone: 'success',
          message: `Revisão de plano #${plan.versionNumber} publicada.`,
        });
      }),

    sendMessage: async (bodyMarkdown, promoteToSharedContext) =>
      runAction(async () => {
        if (!activeConversationId) return;
        const core = gatewayRef.current?.core;
        if (core?.ensureWebSocketConnected) {
          try {
            await core.ensureWebSocketConnected(activeConversationId);
          } catch {
            // Melhor esforço: fallback HTTP / reconciliação continua tratando o envio.
          }
        }
        await gatewayRef.current!.sendMessage({
          conversationId: activeConversationId,
          targetTab: activeTabId,
          bodyMarkdown,
          promoteToSharedContext,
        });
        setDraft(activeConversationId, activeTabId, '');
      }),
    updateModelPolicy: async (policy) =>
      runAction(async () => {
        await gatewayRef.current!.updateModelPolicy(policy);
        setActionBanner({
          tone: 'success',
          message: 'Política de modelos e escalonamento atualizada.',
        });
      }),
    publishContextRevision: async (input) =>
      runAction(async () => {
        if (!activeConversationId) return;
        const rev = await gatewayRef.current!.publishContextRevision({
          conversationId: activeConversationId,
          authorLabel: 'Você',
          ...input,
        });
        setActionBanner({
          tone: 'success',
          message: `Contexto compartilhado v${rev.versionNumber} publicado com recibos por participante.`,
        });
      }),
    controlExecution: async (action, participantId) =>
      runAction(async () => {
        if (!activeConversationId) return;
        await gatewayRef.current!.controlExecution({
          conversationId: activeConversationId,
          action,
          participantId,
        });
      }),
    dispatchTask: async (taskId) =>
      runAction(async () => {
        if (!activeConversationId) return;
        const gw = gatewayRef.current!;
        if (gw.dispatchTask) {
          await gw.dispatchTask({
            conversationId: activeConversationId,
            taskId,
          });
          setActionBanner({
            tone: 'success',
            message: 'Tarefa reconciliada e despachada para execução no AionCore.',
          });
        }
      }),
    setConversationToolApprovalPolicy: async (policy) =>
      runAction(async () => {
        if (!activeConversationId) return;
        const gw = gatewayRef.current!;
        if (gw.setConversationToolApprovalPolicy) {
          await gw.setConversationToolApprovalPolicy(activeConversationId, policy);
        }
      }),
    respondPermission: async (requestId, decision, options) =>
      runAction(async () => {
        if (!activeConversationId) return;
        await gatewayRef.current!.respondPermission({
          conversationId: activeConversationId,
          requestId,
          decision,
          alwaysAllow: options?.alwaysAllow,
        });
      }),
    resolveEscalation: async (escalationId, resolution) =>
      runAction(async () => {
        if (!activeConversationId) return;
        await gatewayRef.current!.resolveEscalation({
          conversationId: activeConversationId,
          escalationId,
          resolution,
        });
      }),
    registerTaskReview: async (review) =>
      runAction(async () => {
        if (!activeConversationId) return;
        await gatewayRef.current!.registerTaskReview({
          conversationId: activeConversationId,
          review,
        });
      }),
    testAgentConnection: async (connectionId) =>
      runAction(async () => {
        const res = await gatewayRef.current!.testAgentConnection(connectionId);
        setActionBanner({ tone: 'info', message: res.message });
      }),
    reconcileConversation: async () =>
      runAction(async () => {
        if (!activeConversationId) return;
        const res = await gatewayRef.current!.reconcileConversation(
          activeConversationId,
        );
        const updatedProj =
          gatewayRef.current!.getStateSnapshot().conversations[activeConversationId];
        if (res.synced === false) {
          setActionBanner({
            tone: 'warning',
            message:
              res.remainingGapSeq !== undefined
                ? `Reconciliação incompleta: ainda falta o evento seq ${res.remainingGapSeq} para retomar a sequência.`
                : updatedProj?.syncErrorNote ??
                  'Reconciliação incompleta no Core: uma ou mais rotas de histórico falharam.',
          });
          return;
        }
        setActionBanner({
          tone: 'success',
          message: `Reconciliação concluída (${res.events?.length ?? 0} evento(s) faltante(s) mesclado(s) sem perder eventos posteriores).`,
        });
      }),
    importWorkspaceState: async (nextState) =>
      runAction(async () => {
        await gatewayRef.current!.importWorkspaceState({
          ...nextState,
          executionMode: 'aion_core',
        });
        setActiveTabByConv({});
        draftsRef.current = {};
        setDraftVersion((v) => v + 1);
        setActionBanner({
          tone: 'success',
          message:
            'Backup importado e persistido com sucesso (nenhuma execução foi iniciada; vínculos Core externos foram desconectados).',
        });
      }),

    coreCheckHealth: async () =>
      runAction(async () => {
        const res = await requireCoreOps().checkHealth();
        setActionBanner({
          tone: res.reachable ? 'success' : 'warning',
          message: res.message,
        });
      }),
    coreCheckAuthStatus: async () =>
      runAction(async () => {
        const res = await requireCoreOps().checkAuthStatus();
        setActionBanner({
          tone: res.authenticated ? 'success' : 'warning',
          message: res.message,
        });
      }),
    coreLogin: async (username, password) =>
      runAction(async () => {
        const core = requireCoreOps();
        const res = await core.login(username, password);
        if (res.authenticated) {
          try {
            const cat = await core.refreshCoreCatalog();
            try {
              if (core.ensureWebSocketConnected) {
                await core.ensureWebSocketConnected(activeConversationId || undefined);
              } else {
                await core.connectWebSocket(activeConversationId || undefined);
              }
            } catch {
              // Conexão WebSocket automática em melhor esforço após login.
            }
            setActionBanner({
              tone: 'success',
              message: `${res.message} ${cat.message}`,
            });
            return;
          } catch {
            // Login succeeded; catalog can still be retried explicitly
          }
        }
        setActionBanner({ tone: 'success', message: res.message });
      }),
    coreLogout: async () =>
      runAction(async () => {
        await requireCoreOps().logout();
        setActionBanner({
          tone: 'info',
          message: 'Sessão encerrada no AionCore.',
        });
      }),
    coreRefreshCatalog: async () =>
      runAction(async () => {
        const res = await requireCoreOps().refreshCoreCatalog();
        setActionBanner({ tone: 'success', message: res.message });
      }),
    coreSyncTeams: async () =>
      runAction(async () => {
        const res = await requireCoreOps().syncCoreTeams();
        setCoreTeamsList(res.teams);
        setActionBanner({ tone: 'info', message: res.message });
      }),
    coreDeleteTeam: async (teamId: string) =>
      runAction(async () => {
        const res = await requireCoreOps().deleteCoreTeam(teamId);
        setCoreTeamsList(res.teams);
        setActionBanner({ tone: 'success', message: res.message });
      }),
    coreCleanupOrphanTeams: async () =>
      runAction(async () => {
        const res = await requireCoreOps().cleanupOrphanCoreTeams();
        setCoreTeamsList(res.teams);
        setActionBanner({
          tone: res.failedCount > 0 ? 'warning' : 'success',
          message: res.message,
        });
      }),
    coreTeamsList,
    coreCreateTeamForActiveConversation: async (teamName?: string) =>
      runAction(async () => {
        if (!activeConversationId) return;
        const res = await requireCoreOps().createCoreTeamForConversation(
          activeConversationId,
          teamName,
        );
        setActionBanner({ tone: 'success', message: res.message });
      }),
    coreConnectWs: async () =>
      runAction(async () => {
        await requireCoreOps().connectWebSocket(activeConversationId || undefined);
        setActionBanner({
          tone: 'success',
          message: 'Conexão WebSocket com o AionCore iniciada.',
        });
      }),
    coreDisconnectWs: () => {
      gatewayRef.current?.core?.disconnectWebSocket();
    },
    coreGetDiagnostics: () => {
      return gatewayRef.current?.core?.getDiagnostics() ?? [];
    },
    assistantState,
    assistantEligibleConnections,
    assistantOpen,
    assistantTab,
    assistantSourcePreviewPath,
    setAssistantOpen,
    setAssistantTab,
    openAssistantSourceFile,
    configureVerticeAssistant: async (input) =>
      runAction(async () => {
        const res = await requireCoreOps().configureVerticeAssistant(input);
        setActionBanner({ tone: 'success', message: res.message });
      }),
    updateVerticeAssistantPreferences: (input) => {
      gatewayRef.current?.core?.updateVerticeAssistantPreferences(input);
    },
    sendVerticeAssistantMessage: async (input) =>
      runAction(async () => {
        await requireCoreOps().sendVerticeAssistantMessage(input);
      }),
    respondVerticeAssistantPermission: async (requestId, decision) =>
      runAction(async () => {
        await requireCoreOps().respondVerticeAssistantPermission({
          requestId,
          decision,
        });
      }),
    clearVerticeAssistantHistory: async () =>
      runAction(async () => {
        await requireCoreOps().clearVerticeAssistantHistory();
      }),
  };

  return (
    <WorkspaceContext.Provider value={value}>
      {children}
    </WorkspaceContext.Provider>
  );
}

export function useWorkspace(): WorkspaceContextValue {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) {
    throw new Error('useWorkspace deve ser usado dentro de WorkspaceProvider.');
  }
  return ctx;
}
