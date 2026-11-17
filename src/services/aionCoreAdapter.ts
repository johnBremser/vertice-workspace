import {
  buildRoleInstructionPrompt,
  parseStructuredAgentOutput,
  type PlanProposalPayload,
  type StructuredEnvelopeKind,
} from '../domain/internalProtocol';
import {
  connectionsToAgentProfiles,
  DEFAULT_PARTICIPANT_PROFILES,
  DEFAULT_TEAM_PRESETS,
  instantiateParticipantsFromPreset,
  makeDemoModelRef,
} from '../domain/presets';
import {
  createEmptyProjection,
  ingestEvent,
  markTabAsRead,
} from '../domain/reducer';
import { getLatestContextRevision } from '../domain/selectors';
import {
  areTaskDependenciesSatisfied,
  validateTaskInput,
} from '../domain/taskRules';
import {
  checkAuditIndependence,
  getParticipantRoles,
  getPrimaryRole,
  hasRole,
  resolveTeamRoles,
  validateTeamConfiguration,
} from '../domain/teamValidation';
import type {
  ConfigChangeRecord,
  ConnectionAdapterConfig,
  ContextReceipt,
  ConversationProjection,
  CoreRuntimeSettings,
  DemoModelTier,
  ExecutionEvent,
  ExecutionMode,
  ModelPolicy,
  ModelRef,
  Participant,
  ParticipantProfile,
  ParticipantRole,
  PlanRevision,
  Project,
  SharedContextRevision,
  Task,
  TaskAttempt,
  TaskReview,
  TeamPreset,
  TeamPresetMember,
  WorkspaceStoreState,
} from '../domain/types';
import { PT_BR } from '../i18n/ptBR';
import {
  assertHealthResponse,
  CORE_WS_EVENTS,
  extractAvailableModelOptions,
  unwrapApiResponse,
  type AgentManagementRow,
  type AssistantResponse,
  type AuthStatusResponse,
  type CreateTeamRequest,
  type LoginResponse,
  type SendAgentMessageRequest,
  type SendTeamMessageRequest,
  type TeamActivityCursor,
  type TeamActivityItemResponse,
  type TeamActivityPageResponse,
  type TeamChildTurnPayload,
  type TeamMailboxChangedPayload,
  type TeamMailboxMessageResponse,
  type TeamResponse,
  type TeamRunAckResponse,
  type TeamRunStateResponse,
  type TeamSlotWorkPayload,
  type TeamTaskChangedPayload,
  type TeamTaskResponse,
  type WebSocketMessage,
} from './aionCoreDtos';
import {
  AionCoreHttpClient,
  AionCoreWsClient,
  normalizeBaseUrl,
  type AionCoreTransportOptions,
} from './aionCoreTransport';
import { CoreDiagnosticsLog } from './coreDiagnostics';
import { createInitialWorkspaceState } from './demoScenario';
import {
  GatewayCapabilityError,
  type AgentWorkspaceGateway,
  type ConfigureParticipantInput,
  type CoreDiagnosticEntry,
  type CoreGatewayOperations,
  type GatewayEventListener,
  type PublishContextInput,
  type ReconcileResult,
  type SendMessageInput,
} from './gateway';
import { WorkspacePersistenceManager } from './storage';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function unwrapFlexibleData(raw: unknown): unknown {
  if (isRecord(raw) && typeof raw.success === 'boolean') {
    if (!raw.success) {
      throw new GatewayCapabilityError(
        'OPERATION_FAILED',
        typeof raw.message === 'string' && raw.message
          ? raw.message
          : 'Core retornou success=false.',
        true,
      );
    }
    return raw.data;
  }
  return raw;
}

function toIsoTimestamp(raw: unknown): string {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return new Date(raw).toISOString();
  }
  if (typeof raw === 'string' && raw.trim().length > 0) {
    const parsed = Date.parse(raw.trim());
    if (Number.isFinite(parsed)) {
      return new Date(parsed).toISOString();
    }
    return raw.trim();
  }
  return new Date().toISOString();
}

function toFiniteMs(raw: unknown): number | undefined {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return raw;
  }
  if (typeof raw === 'string' && raw.trim().length > 0) {
    const parsed = Date.parse(raw.trim());
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function mapCoreTaskStatus(rawStatus: string): Task['status'] | null {
  switch (rawStatus.trim().toLowerCase()) {
    case 'pending':
      return 'queued';
    case 'in_progress':
      return 'running';
    case 'completed':
      return 'completed';
    case 'deleted':
      return 'cancelled';
    case 'failed':
      return 'failed';
    case 'blocked':
      return 'blocked';
    default:
      return null;
  }
}

interface StreamBufferEntry {
  key: string;
  conversationId: string;
  participantId: string;
  extConvId: string;
  msgId: string;
  turnId?: string;
  text: string;
  finished: boolean;
  seenChunkTokens: Set<string>;
}

/**
 * Unconnected AionCore adapter skeleton kept for explicit non-connected fallback checks.
 */
export class AionCoreAdapterSkeleton implements AgentWorkspaceGateway {
  readonly kind = 'aion_core' as const;
  private readonly baseUrl: string;

  constructor(baseUrl = 'http://127.0.0.1:0') {
    this.baseUrl = baseUrl;
  }

  private notConnected(operation: string): never {
    throw new GatewayCapabilityError(
      'NOT_CONNECTED_LOCAL_CORE',
      `Operação "${operation}" indisponível: o AionCore local (${this.baseUrl}) ainda não está conectado. Configure e autentique o servidor local.`,
      true,
    );
  }

  async loadWorkspace(): Promise<WorkspaceStoreState> {
    return this.notConnected('loadWorkspace');
  }
  getStateSnapshot(): WorkspaceStoreState {
    return this.notConnected('getStateSnapshot');
  }
  subscribeState(): () => void {
    return () => {};
  }
  subscribeEvents(): () => void {
    return () => {};
  }
  dispose(): void {
    // No-op
  }
  async setExecutionMode(): Promise<void> {
    return this.notConnected('setExecutionMode');
  }
  async updateCoreSettings(): Promise<void> {
    return this.notConnected('updateCoreSettings');
  }
  setActiveView(): void {
    // Local selection has no side effects until connected.
  }
  async createProject(): Promise<Project> {
    return this.notConnected('createProject');
  }
  async renameProject(): Promise<void> {
    return this.notConnected('renameProject');
  }
  async setProjectArchived(): Promise<void> {
    return this.notConnected('setProjectArchived');
  }
  async createConversation(): Promise<ConversationProjection> {
    return this.notConnected('createConversation');
  }
  async renameConversation(): Promise<void> {
    return this.notConnected('renameConversation');
  }
  async setConversationArchived(): Promise<void> {
    return this.notConnected('setConversationArchived');
  }
  async saveParticipantProfile(): Promise<ParticipantProfile> {
    return this.notConnected('saveParticipantProfile');
  }
  async archiveParticipantProfile(): Promise<void> {
    return this.notConnected('archiveParticipantProfile');
  }
  async saveTeamPreset(): Promise<TeamPreset> {
    return this.notConnected('saveTeamPreset');
  }
  async applyTeamPreset(): Promise<void> {
    return this.notConnected('applyTeamPreset');
  }
  async addParticipantToConversation(): Promise<Participant> {
    return this.notConnected('addParticipantToConversation');
  }
  async removeParticipantFromConversation(): Promise<void> {
    return this.notConnected('removeParticipantFromConversation');
  }
  async reorderParticipantTabs(): Promise<void> {
    return this.notConnected('reorderParticipantTabs');
  }
  async configureParticipant(): Promise<void> {
    return this.notConnected('configureParticipant');
  }
  async createTask(): Promise<Task> {
    return this.notConnected('createTask');
  }
  async updateTask(): Promise<void> {
    return this.notConnected('updateTask');
  }
  async publishPlanRevision(): Promise<PlanRevision> {
    return this.notConnected('publishPlanRevision');
  }
  async updateModelPolicy(): Promise<void> {
    return this.notConnected('updateModelPolicy');
  }
  async sendMessage(): Promise<void> {
    return this.notConnected('sendMessage');
  }
  async getPaginatedEvents(): Promise<{ total: number; hasMore: boolean }> {
    return this.notConnected('getPaginatedEvents');
  }
  async controlExecution(): Promise<void> {
    return this.notConnected('controlExecution');
  }
  async respondPermission(): Promise<void> {
    return this.notConnected('respondPermission');
  }
  async resolveEscalation(): Promise<void> {
    return this.notConnected('resolveEscalation');
  }
  async registerTaskReview(): Promise<void> {
    return this.notConnected('registerTaskReview');
  }
  async publishContextRevision(): Promise<SharedContextRevision> {
    return this.notConnected('publishContextRevision');
  }
  async testAgentConnection(): Promise<{
    ok: boolean;
    testedAt: string;
    message: string;
    isSimulated: boolean;
  }> {
    return this.notConnected('testAgentConnection');
  }
  async reconcileConversation(): Promise<ReconcileResult> {
    return this.notConnected('reconcileConversation');
  }
  async importWorkspaceState(): Promise<void> {
    return this.notConnected('importWorkspaceState');
  }
}

export class AionCoreAdapter
  implements AgentWorkspaceGateway, CoreGatewayOperations
{
  readonly kind = 'aion_core' as const;
  readonly core: CoreGatewayOperations = this;

  private state: WorkspaceStoreState | null = null;
  private readonly persistence: WorkspacePersistenceManager;
  private readonly diagnostics = new CoreDiagnosticsLog();
  private readonly httpClient: AionCoreHttpClient;
  private readonly wsClient: AionCoreWsClient;
  private listeners = new Set<GatewayEventListener>();
  private stateListeners = new Set<(state: WorkspaceStoreState) => void>();
  private activeTabByConversation: Record<string, string> = {};
  private idCounter = 200;
  private streamBuffers = new Map<string, StreamBufferEntry>();
  private lastSlotWorkSignature = new Map<string, string>();
  private turnParticipantMap = new Map<string, string>();
  private expectedKindByParticipant = new Map<string, StructuredEnvelopeKind>();
  private wsTaskMutationSeq = new Map<string, number>();
  private wsSlotMutationSeq = new Map<string, number>();
  private wsWasConnectedBefore = false;
  private wsDisconnectedSinceLastConnect = false;
  private backgroundDispatchChain: Promise<void> = Promise.resolve();

  constructor(
    persistence: WorkspacePersistenceManager,
    transportOptions: AionCoreTransportOptions = {},
  ) {
    this.persistence = persistence;
    this.httpClient = new AionCoreHttpClient({
      ...transportOptions,
      diagnostics: this.diagnostics,
    });
    this.wsClient = new AionCoreWsClient(this.httpClient, {
      wsFactory: transportOptions.wsFactory,
      diagnostics: this.diagnostics,
    });
  }

  private nextId(prefix: string): string {
    this.idCounter += 1;
    return `${prefix}_core_${Date.now().toString(36)}_${this.idCounter}`;
  }

  private nextLocalSeq(projection: ConversationProjection): number {
    const maxPending = Object.keys(projection.pendingOutOfOrder).reduce(
      (acc, k) => Math.max(acc, Number(k) || 0),
      0,
    );
    return Math.max(projection.conversation.lastAppliedSeq, maxPending) + 1;
  }

  private notifyState(): void {
    if (!this.state) return;
    for (const listener of this.stateListeners) {
      listener(this.state);
    }
    this.persistence.scheduleSave(this.state);
  }

  private emitAndIngest(conversationId: string, event: ExecutionEvent): void {
    if (!this.state) return;
    const currentProj = this.state.conversations[conversationId];
    if (!currentProj) return;
    const activeTab =
      this.state.activeConversationId === conversationId
        ? (this.activeTabByConversation[conversationId] ?? 'general')
        : undefined;
    const result = ingestEvent(currentProj, event, activeTab);
    this.state = {
      ...this.state,
      conversations: {
        ...this.state.conversations,
        [conversationId]: result.projection,
      },
    };
    this.notifyState();
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  getStateSnapshot(): WorkspaceStoreState {
    if (!this.state) {
      throw new GatewayCapabilityError(
        'OPERATION_FAILED',
        'Workspace Core ainda não inicializado.',
      );
    }
    return this.state;
  }

  subscribeState(listener: (state: WorkspaceStoreState) => void): () => void {
    this.stateListeners.add(listener);
    if (this.state) listener(this.state);
    return () => {
      this.stateListeners.delete(listener);
    };
  }

  subscribeEvents(listener: GatewayEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  dispose(): void {
    this.wsClient.disconnect();
  }

  async loadWorkspace(): Promise<WorkspaceStoreState> {
    const loaded = await this.persistence.loadInitial(() => {
      const base = createInitialWorkspaceState();
      return {
        ...base,
        executionMode: 'aion_core',
      };
    });
    this.httpClient.setBaseUrl(
      normalizeBaseUrl(loaded.coreSettings?.baseUrl ?? ''),
    );
    this.state = {
      ...loaded,
      executionMode: 'aion_core',
    };
    for (const listener of this.stateListeners) {
      listener(this.state);
    }
    return this.state;
  }

  async setExecutionMode(mode: ExecutionMode): Promise<void> {
    const state = this.getStateSnapshot();
    if (mode !== 'aion_core') {
      this.wsClient.disconnect();
    }
    this.state = {
      ...state,
      executionMode: mode,
    };
    this.notifyState();
  }

  async updateCoreSettings(settings: CoreRuntimeSettings): Promise<void> {
    const state = this.getStateSnapshot();
    this.httpClient.setBaseUrl(normalizeBaseUrl(settings.baseUrl));
    this.state = {
      ...state,
      coreSettings: { ...settings },
    };
    this.notifyState();
  }

  setActiveView(input: {
    projectId?: string;
    conversationId: string;
    tabId?: string;
  }): void {
    if (!this.state) return;
    const convProj = this.state.conversations[input.conversationId];
    if (!convProj) return;
    const targetTab =
      input.tabId ??
      this.activeTabByConversation[input.conversationId] ??
      'general';
    this.activeTabByConversation[input.conversationId] = targetTab;
    const nextProjectId = input.projectId ?? convProj.conversation.projectId;
    const markedProj = markTabAsRead(convProj, targetTab);
    const selectionChanged =
      this.state.activeProjectId !== nextProjectId ||
      this.state.activeConversationId !== input.conversationId;
    if (selectionChanged || markedProj !== convProj) {
      this.state = {
        ...this.state,
        activeProjectId: nextProjectId,
        activeConversationId: input.conversationId,
        conversations:
          markedProj !== convProj
            ? { ...this.state.conversations, [input.conversationId]: markedProj }
            : this.state.conversations,
      };
      this.notifyState();
    }
  }

  // ---------------------------------------------------------------------------
  // Core HTTP & WS operations (verified against AionCore v0.2.2)
  // ---------------------------------------------------------------------------

  async checkHealth(): Promise<{
    reachable: boolean;
    version?: string;
    buildTime?: string;
    message: string;
  }> {
    try {
      const raw = await this.httpClient.requestJson<unknown>({
        method: 'GET',
        path: '/health',
        idempotent: true,
        operationName: 'core.health',
      });
      const health = assertHealthResponse(raw);
      const state = this.state;
      if (state) {
        const nextConnections = state.connections.map((c) =>
          c.mode === 'aion_core'
            ? {
                ...c,
                coreReachability: 'reachable' as const,
                lastConnectionTestAt: new Date().toISOString(),
                lastConnectionTestResult: `Core alcançável (v${health.version}) — autenticação e CLIs requerem verificação separada.`,
              }
            : c,
        );
        this.state = {
          ...state,
          connections: nextConnections,
          agentProfiles: connectionsToAgentProfiles(nextConnections),
        };
        this.notifyState();
      }
      return {
        reachable: health.status === 'ok',
        version: health.version,
        buildTime: health.build_time,
        message: `AionCore alcançável (status=${health.status}, versão=${health.version}). Health check não comprova sessão autenticada nem CLIs.`,
      };
    } catch (err) {
      const state = this.state;
      if (state) {
        const nextConnections = state.connections.map((c) =>
          c.mode === 'aion_core'
            ? {
                ...c,
                coreReachability: 'unreachable' as const,
                lastConnectionTestAt: new Date().toISOString(),
                lastConnectionTestResult:
                  err instanceof Error ? err.message : 'Core inacessível.',
              }
            : c,
        );
        this.state = {
          ...state,
          connections: nextConnections,
          agentProfiles: connectionsToAgentProfiles(nextConnections),
        };
        this.notifyState();
      }
      throw err;
    }
  }

  async checkAuthStatus(): Promise<{
    authenticated: boolean;
    user?: string;
    message: string;
  }> {
    const status = await this.httpClient.requestJson<AuthStatusResponse>({
      method: 'GET',
      path: '/api/auth/status',
      idempotent: true,
      operationName: 'core.authStatus',
    });
    if (!status || typeof status.is_authenticated !== 'boolean') {
      throw new GatewayCapabilityError(
        'INVALID_PAYLOAD',
        'Resposta inválida de /api/auth/status.',
        true,
      );
    }
    const state = this.state;
    if (state) {
      const nextConnections = state.connections.map((c) =>
        c.mode === 'aion_core'
          ? {
              ...c,
              coreReachability: 'reachable' as const,
              authStatus: status.is_authenticated
                ? ('authenticated' as const)
                : ('unauthenticated' as const),
            }
          : c,
      );
      this.state = {
        ...state,
        connections: nextConnections,
        agentProfiles: connectionsToAgentProfiles(nextConnections),
      };
      this.notifyState();
    }
    return {
      authenticated: status.is_authenticated,
      message: status.is_authenticated
        ? 'Sessão autenticada no AionCore.'
        : status.needs_setup
          ? 'Core exige configuração inicial de usuário antes do login.'
          : 'Core alcançável, porém usuário ainda não está autenticado.',
    };
  }

  async login(
    username: string,
    password: string,
  ): Promise<{ authenticated: boolean; message: string }> {
    const resp = await this.httpClient.requestJson<LoginResponse>({
      method: 'POST',
      path: '/login',
      body: { username, password },
      idempotent: false,
      operationName: 'core.login',
    });
    if (!resp || !resp.success || !resp.user) {
      throw new GatewayCapabilityError(
        'AUTH_REQUIRED',
        resp?.message || 'Falha no login no AionCore.',
        true,
      );
    }
    if (typeof resp.token === 'string' && resp.token) {
      this.httpClient.setBearerToken(resp.token);
    }
    const state = this.state;
    if (state) {
      const nextConnections = state.connections.map((c) =>
        c.mode === 'aion_core'
          ? {
              ...c,
              coreReachability: 'reachable' as const,
              authStatus: 'authenticated' as const,
            }
          : c,
      );
      this.state = {
        ...state,
        connections: nextConnections,
        agentProfiles: connectionsToAgentProfiles(nextConnections),
      };
      this.notifyState();
    }
    return {
      authenticated: true,
      message: `Autenticado no AionCore como "${resp.user.username}".`,
    };
  }

  async logout(): Promise<void> {
    this.wsClient.disconnect();
    try {
      await this.httpClient.requestJson({
        method: 'POST',
        path: '/logout',
        idempotent: false,
        operationName: 'core.logout',
      });
    } finally {
      this.httpClient.setBearerToken(undefined);
      if (this.state) {
        const nextConnections = this.state.connections.map((c) =>
          c.mode === 'aion_core'
            ? {
                ...c,
                authStatus: 'unauthenticated' as const,
                sessionStatus: 'inactive' as const,
              }
            : c,
        );
        this.state = {
          ...this.state,
          connections: nextConnections,
          agentProfiles: connectionsToAgentProfiles(nextConnections),
        };
        this.notifyState();
      }
    }
  }

  async refreshCoreCatalog(): Promise<{
    connectionsUpdated: number;
    assistantsCount: number;
    agentsCount: number;
    message: string;
  }> {
    const state = this.getStateSnapshot();
    const rawAgents = await this.httpClient.requestJson<unknown>({
      method: 'GET',
      path: '/api/agents/management',
      idempotent: true,
      operationName: 'core.listAgents',
    });
    const agents = unwrapApiResponse<AgentManagementRow[]>(
      rawAgents,
      'GET /api/agents/management',
      Array.isArray,
    );

    const rawAssistants = await this.httpClient.requestJson<unknown>({
      method: 'GET',
      path: '/api/assistants',
      idempotent: true,
      operationName: 'core.listAssistants',
    });
    const assistants = unwrapApiResponse<AssistantResponse[]>(
      rawAssistants,
      'GET /api/assistants',
      Array.isArray,
    );

    const agentsById = new Map(agents.map((a) => [a.id, a]));
    const keptDemoConnections = state.connections.filter(
      (c) => c.mode !== 'aion_core',
    );
    const derivedCoreConnections: ConnectionAdapterConfig[] = [];

    if (assistants.length > 0) {
      for (const assistant of assistants) {
        const linkedAgent = agentsById.get(assistant.agent_id);
        const backend = linkedAgent?.backend ?? assistant.agent_id;
        const agentModels = extractAvailableModelOptions(
          linkedAgent?.available_models,
        );
        const assistantModels = (assistant.models ?? []).map((m) => ({
          externalId: m,
          displayName: m,
        }));
        const mergedMap = new Map<string, string>();
        for (const m of [...agentModels, ...assistantModels]) {
          mergedMap.set(m.externalId, m.displayName);
        }
        const availableModels = Array.from(mergedMap.entries()).map(
          ([externalId, displayName]) => ({
            externalId,
            displayName,
            source: 'core_catalog' as const,
            confirmed: true,
          }),
        );

        const executableStatus = linkedAgent
          ? linkedAgent.installed
            ? 'verified'
            : 'missing'
          : 'unknown';

        const authStatus =
          assistant.agent_status === 'ready' || linkedAgent?.status === 'ready'
            ? 'authenticated'
            : assistant.agent_status === 'unauthenticated' ||
                linkedAgent?.status === 'unauthenticated'
              ? 'unauthenticated'
              : 'unknown';

        derivedCoreConnections.push({
          id: `conn_core_${assistant.id}`,
          displayName: `${assistant.name} (AionCore)`,
          vendorLabel: `Assistente ${assistant.name} · backend ${backend}`,
          mode: 'aion_core',
          backendId: backend,
          coreAgentId: assistant.agent_id,
          coreAssistantId: assistant.id,
          coreBaseUrl: state.coreSettings.baseUrl,
          configured: assistant.enabled,
          coreReachability: 'reachable',
          catalogLoaded: true,
          executableStatus,
          authStatus,
          sessionStatus: 'inactive',
          availableModels,
          lastConnectionTestAt: new Date().toISOString(),
          lastConnectionTestResult: assistant.team_selectable
            ? `Catálogo carregado (${availableModels.length} modelo(s) exposto(s)).`
            : `Indisponível para equipe: ${assistant.team_block_reason ?? assistant.agent_status}.`,
          capabilities: {
            supportsInterrupt: 'unknown',
            supportsMidRunContextInjection: 'unknown',
            supportsModelSwitchInSession: 'unknown',
            supportsPauseQueue: 'unknown',
            supportsSessionTerminate: 'unknown',
          },
          isSimulated: false,
        });
      }
    } else {
      for (const agent of agents) {
        const availableModels = extractAvailableModelOptions(
          agent.available_models,
        ).map((m) => ({
          externalId: m.externalId,
          displayName: m.displayName,
          source: 'core_catalog' as const,
          confirmed: true,
        }));
        derivedCoreConnections.push({
          id: `conn_core_agent_${agent.id}`,
          displayName: `${agent.name} (Core sem assistant_id)`,
          vendorLabel: `Agente ${agent.name}`,
          mode: 'aion_core',
          backendId: agent.backend ?? agent.id,
          coreAgentId: agent.id,
          coreBaseUrl: state.coreSettings.baseUrl,
          configured: agent.enabled,
          coreReachability: 'reachable',
          catalogLoaded: true,
          executableStatus: agent.installed ? 'verified' : 'missing',
          authStatus:
            agent.status === 'ready'
              ? 'authenticated'
              : agent.status === 'unauthenticated'
                ? 'unauthenticated'
                : 'unknown',
          sessionStatus: 'inactive',
          availableModels,
          lastConnectionTestAt: new Date().toISOString(),
          lastConnectionTestResult:
            'Agente listado sem assistant_id associado no catálogo /api/assistants.',
          capabilities: {
            supportsInterrupt: 'unknown',
            supportsMidRunContextInjection: 'unknown',
            supportsModelSwitchInSession: 'unknown',
            supportsPauseQueue: 'unknown',
            supportsSessionTerminate: 'unknown',
          },
          isSimulated: false,
        });
      }
    }

    const nextConnections = [...keptDemoConnections, ...derivedCoreConnections];
    this.state = {
      ...state,
      connections: nextConnections,
      agentProfiles: connectionsToAgentProfiles(nextConnections),
    };
    this.notifyState();

    return {
      connectionsUpdated: derivedCoreConnections.length,
      assistantsCount: assistants.length,
      agentsCount: agents.length,
      message: `Catálogo sincronizado: ${assistants.length} assistente(s) e ${agents.length} agente(s).`,
    };
  }

  async syncCoreTeams(): Promise<{ teamsCount: number; message: string }> {
    const state = this.getStateSnapshot();
    const raw = await this.httpClient.requestJson<unknown>({
      method: 'GET',
      path: '/api/teams',
      idempotent: true,
      operationName: 'core.listTeams',
    });
    const teams = unwrapApiResponse<TeamResponse[]>(
      raw,
      'GET /api/teams',
      Array.isArray,
    );

    const nextConversations = { ...state.conversations };
    let updated = 0;

    for (const team of teams) {
      const existingEntry = Object.entries(nextConversations).find(
        ([, proj]) =>
          proj.conversation.executionMode === 'aion_core' &&
          proj.conversation.externalTeamId === team.id,
      );
      if (existingEntry) {
        const [convId, convProj] = existingEntry;
        const mappedParticipants = convProj.participants.map((p) => {
          const matchedAgent =
            team.assistants.find(
              (a) => a.slot_id === p.sessionRef.externalSlotId,
            ) ??
            team.assistants.find(
              (a) =>
                a.name.toLowerCase() === p.displayName.toLowerCase(),
            );
          if (!matchedAgent) return p;
          return {
            ...p,
            sessionRef: {
              ...p.sessionRef,
              externalTeamId: team.id,
              externalSlotId: matchedAgent.slot_id,
              externalConversationId: matchedAgent.conversation_id,
              status: 'active' as const,
            },
          };
        });
        nextConversations[convId] = {
          ...convProj,
          participants: mappedParticipants,
          conversation: {
            ...convProj.conversation,
            externalTeamId: team.id,
          },
        };
        updated += 1;
      }
    }

    if (updated > 0) {
      this.state = {
        ...state,
        conversations: nextConversations,
      };
      this.notifyState();
    }

    return {
      teamsCount: teams.length,
      message: `${teams.length} equipe(s) obtida(s) do Core (${updated} vinculada(s) a conversas abertas).`,
    };
  }

  async createCoreTeamForConversation(conversationId: string): Promise<{
    externalTeamId: string;
    message: string;
  }> {
    const state = this.getStateSnapshot();
    const proj = state.conversations[conversationId];
    if (!proj) {
      throw new GatewayCapabilityError(
        'CONVERSATION_NOT_FOUND',
        `Conversa "${conversationId}" não encontrada.`,
      );
    }

    const validation = validateTeamConfiguration(
      proj.participants,
      state.connections,
    );
    if (!validation.valid) {
      throw new GatewayCapabilityError(
        'VALIDATION_ERROR',
        validation.errors.join(' '),
      );
    }

    const activeParticipants = proj.participants.filter((p) => !p.archived);
    const agents: CreateTeamRequest['agents'] = activeParticipants.map((p) => {
      const conn = state.connections.find((c) => c.id === p.connectionId);
      const assistantId = conn?.coreAssistantId?.trim();
      if (!assistantId) {
        throw new GatewayCapabilityError(
          'VALIDATION_ERROR',
          `Participante "${p.displayName}" usa a conexão "${conn?.displayName ?? p.connectionId}" sem assistant_id confirmado do catálogo Core (/api/assistants).`,
        );
      }
      const modelId = p.modelRef.externalId?.trim() || p.modelRef.displayName.trim();
      if (!modelId) {
        throw new GatewayCapabilityError(
          'VALIDATION_ERROR',
          `Participante "${p.displayName}" não possui modelo selecionado.`,
        );
      }
      return {
        assistant_id: assistantId,
        name: p.displayName,
        role: hasRole(p, 'coordinator') ? 'lead' : 'teammate',
        model: modelId,
      };
    });

    const project = state.projects.find(
      (pr) => pr.id === proj.conversation.projectId,
    );
    const body: CreateTeamRequest = {
      name: proj.conversation.title,
      workspace:
        state.coreSettings.workspacePath.trim() ||
        project?.workspacePathInfo ||
        undefined,
      agents,
    };

    const raw = await this.httpClient.requestJson<unknown>({
      method: 'POST',
      path: '/api/teams',
      body,
      idempotent: false,
      operationName: 'core.createTeam',
    });
    const team = unwrapApiResponse<TeamResponse>(
      raw,
      'POST /api/teams',
      (d): d is TeamResponse =>
        typeof d === 'object' &&
        d !== null &&
        typeof (d as TeamResponse).id === 'string' &&
        Array.isArray((d as TeamResponse).assistants),
    );

    const mappedParticipants = proj.participants.map((p) => {
      const matched =
        team.assistants.find(
          (a) => a.name.toLowerCase() === p.displayName.toLowerCase(),
        ) ??
        (hasRole(p, 'coordinator')
          ? team.assistants.find(
              (a) => a.role === 'lead' || a.role === 'leader',
            )
          : undefined);
      if (!matched) return p;
      return {
        ...p,
        sessionRef: {
          ...p.sessionRef,
          externalTeamId: team.id,
          externalSlotId: matched.slot_id,
          externalConversationId: matched.conversation_id,
          status: 'active' as const,
        },
      };
    });

    this.state = {
      ...state,
      conversations: {
        ...state.conversations,
        [conversationId]: {
          ...proj,
          participants: mappedParticipants,
          conversation: {
            ...proj.conversation,
            externalTeamId: team.id,
          },
        },
      },
    };
    this.notifyState();

    return {
      externalTeamId: team.id,
      message: `Equipe "${team.name}" criada no AionCore (${team.id}) com ${team.assistants.length} participante(s).`,
    };
  }

  async connectWebSocket(conversationId?: string): Promise<void> {
    await this.wsClient.connect({
      onMessage: (wsMsg) =>
        this.handleIncomingWebSocketEvent(wsMsg, conversationId),
      onStatusChange: (status, detail) => {
        this.diagnostics.record({
          operation: `ws.state.${status}`,
          status: status === 'error' ? 'error' : 'ok',
          detail: detail ?? `WebSocket em estado ${status}.`,
        });
        if (status === 'disconnected' || status === 'error') {
          if (this.wsWasConnectedBefore) {
            this.wsDisconnectedSinceLastConnect = true;
          }
        } else if (status === 'connected') {
          const isReconnect =
            this.wsWasConnectedBefore && this.wsDisconnectedSinceLastConnect;
          this.wsWasConnectedBefore = true;
          this.wsDisconnectedSinceLastConnect = false;
          if (isReconnect) {
            this.enqueueBackgroundWork(async () => {
              await this.catchUpBoundConversationsAfterReconnect(conversationId);
            });
          }
        }
      },
    });
  }

  disconnectWebSocket(): void {
    this.wsDisconnectedSinceLastConnect = false;
    this.wsWasConnectedBefore = false;
    this.wsClient.disconnect();
  }

  getDiagnostics(): CoreDiagnosticEntry[] {
    return this.diagnostics.list();
  }

  private enqueueBackgroundWork(task: () => Promise<void>): void {
    this.backgroundDispatchChain = this.backgroundDispatchChain
      .then(() => task())
      .catch((err) => {
        this.diagnostics.record({
          operation: 'core.orchestration',
          status: 'error',
          code:
            err instanceof GatewayCapabilityError
              ? err.code
              : 'OPERATION_FAILED',
          detail:
            err instanceof Error
              ? err.message
              : 'Falha ao executar orquestração Core em segundo plano.',
        });
      });
  }

  private async catchUpBoundConversationsAfterReconnect(
    preferredConversationId?: string,
  ): Promise<void> {
    if (!this.state) return;
    const boundIds = Object.values(this.state.conversations)
      .filter(
        (proj) =>
          proj.conversation.executionMode === 'aion_core' &&
          Boolean(proj.conversation.externalTeamId),
      )
      .map((proj) => proj.conversation.id);

    const ordered =
      preferredConversationId && boundIds.includes(preferredConversationId)
        ? [
            preferredConversationId,
            ...boundIds.filter((id) => id !== preferredConversationId),
          ]
        : boundIds;

    for (const cid of ordered) {
      try {
        await this.reconcileConversation(cid);
      } catch (err) {
        this.diagnostics.record({
          operation: 'core.reconnectCatchUp',
          status: 'error',
          detail:
            err instanceof Error
              ? err.message
              : `Falha no catch-up automático após reconexão (${cid}).`,
        });
      }
    }
  }

  private composeCoreOutgoingContent(input: {
    proj: ConversationProjection;
    targetParticipant: Participant;
    userMarkdown: string;
    expectedKind?: StructuredEnvelopeKind;
    task?: Task;
    attempt?: TaskAttempt;
  }): string {
    const { proj, targetParticipant, userMarkdown, expectedKind, task, attempt } =
      input;
    const roles = getParticipantRoles(targetParticipant);
    const roleLabel = roles.map((r) => PT_BR.roleLabels[r]).join(' + ');

    const blocks: string[] = [
      buildRoleInstructionPrompt({
        roleLabel,
        participantName: targetParticipant.displayName,
        customInstructions: targetParticipant.instructions,
        expectedKind,
        conversationId: proj.conversation.id,
        taskId: task?.id,
        attemptId: attempt?.id,
      }),
    ];

    if (
      hasRole(targetParticipant, 'coordinator') ||
      hasRole(targetParticipant, 'planner')
    ) {
      const teamRoles = resolveTeamRoles(
        proj.participants,
        proj.conversation.coordinatorParticipantId,
      );
      const rosterLines = proj.participants
        .filter((p) => !p.archived)
        .map((p) => {
          const pRoles = getParticipantRoles(p)
            .map((r) => PT_BR.roleLabels[r])
            .join('+');
          return `- ${p.displayName} (papéis: ${pRoles}; modelo: ${p.modelRef.displayName}${p.sessionRef.externalSlotId ? `; slot=${p.sessionRef.externalSlotId}` : ''})`;
        });
      blocks.push(
        `[Equipe configurada no Aion Desk]\nPapéis resolvidos: Coordenador=${teamRoles.coordinator?.displayName ?? '—'}, Planejador=${teamRoles.planner?.displayName ?? '—'}, Executor=${teamRoles.executor?.displayName ?? '—'}, Auditor=${teamRoles.reviewer?.displayName ?? '—'}\n${rosterLines.join('\n')}`,
      );
    }

    const latestCtx = getLatestContextRevision(proj);
    if (latestCtx) {
      const ctxParts = [
        `[Contexto Compartilhado v${latestCtx.versionNumber} — Aion Desk]`,
        `Objetivo: ${latestCtx.objective}`,
      ];
      if (latestCtx.permanentInstructions.length > 0) {
        ctxParts.push(
          `Instruções permanentes:\n${latestCtx.permanentInstructions.map((i) => `- ${i}`).join('\n')}`,
        );
      }
      if (latestCtx.constraints.length > 0) {
        ctxParts.push(
          `Restrições:\n${latestCtx.constraints.map((c) => `- ${c}`).join('\n')}`,
        );
      }
      if (latestCtx.acceptanceCriteria.length > 0) {
        ctxParts.push(
          `Critérios de aceitação:\n${latestCtx.acceptanceCriteria.map((c) => `- ${c}`).join('\n')}`,
        );
      }
      if (latestCtx.confirmedDecisions.length > 0) {
        ctxParts.push(
          `Decisões confirmadas:\n${latestCtx.confirmedDecisions.map((d) => `- ${d}`).join('\n')}`,
        );
      }
      blocks.push(ctxParts.join('\n'));
    }

    if (task) {
      const taskLines = [
        `[Tarefa correlacionada — id=${task.id}${attempt ? ` · attemptId=${attempt.id} (Tentativa #${attempt.attemptNumber})` : ''}]`,
        `Título: ${task.title}`,
        `Descrição: ${task.description}`,
        `Critérios da tarefa:\n${task.acceptanceCriteria.map((c) => `- ${c}`).join('\n')}`,
      ];
      if (task.reviews.length > 0) {
        const lastReview = task.reviews[task.reviews.length - 1];
        if (lastReview.decision === 'rejected') {
          taskLines.push(
            `Último parecer de auditoria (Correção necessária): ${lastReview.rationale}`,
          );
          if (lastReview.unmetCriteria.length > 0) {
            taskLines.push(
              `Critérios não atendidos:\n${lastReview.unmetCriteria.map((u) => `- ${u}`).join('\n')}`,
            );
          }
        }
      }
      blocks.push(taskLines.join('\n'));
    }

    blocks.push(`[Pedido / Orientação]\n${userMarkdown}`);
    return blocks.join('\n\n');
  }

  private markWsTaskMutation(convId: string, taskId: string): void {
    const key = `${convId}:${taskId}`;
    this.wsTaskMutationSeq.set(key, (this.wsTaskMutationSeq.get(key) ?? 0) + 1);
  }

  private markWsSlotMutation(convId: string, slotId?: string): void {
    if (!slotId) return;
    const key = `${convId}:${slotId}`;
    this.wsSlotMutationSeq.set(key, (this.wsSlotMutationSeq.get(key) ?? 0) + 1);
  }

  private resolveParticipantByCoreAgentRef(
    proj: ConversationProjection,
    rawRef: string | null | undefined,
  ): {
    participant?: Participant;
    isUser?: boolean;
    isBroadcast?: boolean;
    unresolvedRef?: string;
  } {
    const normalized = asNonEmptyString(rawRef);
    if (!normalized) return {};
    const lower = normalized.toLowerCase();

    if (
      lower === 'user' ||
      lower === 'human' ||
      lower === 'usuario' ||
      lower === 'usuário'
    ) {
      return { isUser: true };
    }
    if (lower === 'all' || lower === 'team' || lower === 'broadcast') {
      return { isBroadcast: true };
    }

    const bySlot = proj.participants.find(
      (p) => p.sessionRef.externalSlotId === normalized,
    );
    if (bySlot) return { participant: bySlot };

    const byId = proj.participants.find((p) => p.id === normalized);
    if (byId) return { participant: byId };

    const byExtConv = proj.participants.find(
      (p) => p.sessionRef.externalConversationId === normalized,
    );
    if (byExtConv) return { participant: byExtConv };

    if (lower === 'lead' || lower === 'leader') {
      const coord = proj.participants.find(
        (p) => p.id === proj.conversation.coordinatorParticipantId,
      );
      if (coord) return { participant: coord };
    }

    const nameMatches = proj.participants.filter(
      (p) => p.displayName.trim().toLowerCase() === lower,
    );
    if (nameMatches.length === 1) {
      return { participant: nameMatches[0] };
    }

    return { unresolvedRef: normalized };
  }

  private isValidMailboxMessageDto(
    raw: unknown,
  ): raw is TeamMailboxMessageResponse {
    return (
      isRecord(raw) &&
      typeof raw.id === 'string' &&
      raw.id.trim().length > 0 &&
      typeof raw.from_agent_id === 'string' &&
      raw.from_agent_id.trim().length > 0 &&
      typeof raw.content === 'string'
    );
  }

  private isValidTaskDto(raw: unknown): raw is TeamTaskResponse {
    return (
      isRecord(raw) &&
      typeof raw.id === 'string' &&
      raw.id.trim().length > 0 &&
      typeof raw.subject === 'string' &&
      raw.subject.trim().length > 0 &&
      typeof raw.status === 'string' &&
      raw.status.trim().length > 0
    );
  }

  private isExternalMessageAlreadyStored(
    proj: ConversationProjection,
    extMsgId: string,
  ): boolean {
    if (proj.seenEventIds.includes(`evt_core_msg_final_${proj.conversation.id}_${extMsgId}`)) {
      return true;
    }
    if (proj.seenEventIds.includes(`evt_core_mb_user_${proj.conversation.id}_${extMsgId}`)) {
      return true;
    }
    return Object.values(proj.messagesByTab).some((tabMsgs) =>
      tabMsgs.some((m) => m.externalMessageId === extMsgId),
    );
  }

  private ingestCoreMailboxMessage(
    convId: string,
    msg: TeamMailboxMessageResponse,
    options: {
      externalEventName: string;
      trackRecovered?: ExecutionEvent[];
      unresolvedIdentities?: Set<string>;
    },
  ): void {
    const state = this.state;
    if (!state) return;
    const proj = state.conversations[convId];
    if (!proj) return;

    const extMsgId = msg.id.trim();
    const content =
      asNonEmptyString(msg.content) ?? asNonEmptyString(msg.summary);
    if (!extMsgId || !content) return;

    if (this.isExternalMessageAlreadyStored(proj, extMsgId)) {
      return;
    }

    const senderRes = this.resolveParticipantByCoreAgentRef(
      proj,
      msg.from_agent_id,
    );
    if (senderRes.unresolvedRef) {
      options.unresolvedIdentities?.add(
        `mailbox[${extMsgId}].from_agent_id=${senderRes.unresolvedRef}`,
      );
      return;
    }

    const timestamp = toIsoTimestamp(msg.created_at);

    if (senderRes.isUser) {
      const recipientRes = this.resolveParticipantByCoreAgentRef(
        proj,
        msg.to_agent_id,
      );
      if (recipientRes.unresolvedRef) {
        options.unresolvedIdentities?.add(
          `mailbox[${extMsgId}].to_agent_id=${recipientRes.unresolvedRef}`,
        );
        return;
      }
      const coordinator = proj.participants.find(
        (p) => p.id === proj.conversation.coordinatorParticipantId,
      );
      const targetTab =
        recipientRes.participant && !recipientRes.isBroadcast
          ? recipientRes.participant.id
          : 'general';
      const targetParticipant = recipientRes.participant ?? coordinator;
      if (!targetParticipant) return;

      const userEvt: ExecutionEvent = {
        id: `evt_core_mb_user_${convId}_${extMsgId}`,
        seq: this.nextLocalSeq(proj),
        conversationId: convId,
        timestamp,
        origin: 'user',
        originSource: 'aion_core',
        externalEventName: options.externalEventName,
        participantId: targetParticipant.id,
        type: 'user_message_sent',
        payload: {
          messageId: `msg_core_${extMsgId}`,
          externalMessageId: extMsgId,
          targetTab,
          targetParticipantId: targetParticipant.id,
          bodyMarkdown: content,
          deliveryStatus: 'enqueued_core',
          generalSummary:
            targetTab === 'general'
              ? `Mensagem recuperada para ${targetParticipant.displayName}.`
              : `Mensagem direta recuperada para ${targetParticipant.displayName}.`,
        },
      };
      this.emitAndIngest(convId, userEvt);
      options.trackRecovered?.push(userEvt);
      return;
    }

    const participant = senderRes.participant;
    if (!participant) return;

    const mbBufKey = `${convId}:${participant.id}:${extMsgId}`;
    const existingBuf = this.streamBuffers.get(mbBufKey);
    if (existingBuf) {
      existingBuf.finished = true;
    }

    const beforeLogLen = proj.eventLog.length;
    this.finalizeCoreAgentMessage({
      convId,
      participant,
      fullText: content,
      extMsgId,
      externalEventName: options.externalEventName,
      timestamp,
    });
    const afterProj = this.state?.conversations[convId];
    if (afterProj && afterProj.eventLog.length > beforeLogLen) {
      options.trackRecovered?.push(...afterProj.eventLog.slice(beforeLogLen));
    }
  }

  private upsertCoreTask(
    convId: string,
    rawTask: TeamTaskResponse,
    options: {
      source: 'ws' | 'catchup';
      externalEventName: string;
      trackRecovered?: ExecutionEvent[];
      unresolvedIdentities?: Set<string>;
      malformedItems?: { count: number };
      wsMutationSeqBeforeCatchup?: number;
    },
  ): void {
    const state = this.state;
    if (!state) return;
    const proj = state.conversations[convId];
    if (!proj) return;

    const extTaskId = rawTask.id.trim();
    const title = rawTask.subject.trim();
    const mappedStatus = mapCoreTaskStatus(rawTask.status);
    if (!mappedStatus) {
      if (options.malformedItems) options.malformedItems.count += 1;
      return;
    }

    const incomingUpdatedAtMs = toFiniteMs(rawTask.updated_at);
    const incomingCreatedAtMs = toFiniteMs(rawTask.created_at);
    const createdAtIso =
      incomingCreatedAtMs !== undefined
        ? new Date(incomingCreatedAtMs).toISOString()
        : undefined;
    const updatedAtIso =
      incomingUpdatedAtMs !== undefined
        ? new Date(incomingUpdatedAtMs).toISOString()
        : undefined;
    const incomingDeps = Array.isArray(rawTask.blocked_by)
      ? rawTask.blocked_by.filter(
          (d): d is string => typeof d === 'string' && d.trim().length > 0,
        )
      : [];

    const hasExplicitOwner = asNonEmptyString(rawTask.owner) !== undefined;
    const ownerRes = hasExplicitOwner
      ? this.resolveParticipantByCoreAgentRef(proj, rawTask.owner)
      : {};
    if (ownerRes.unresolvedRef) {
      options.unresolvedIdentities?.add(
        `task[${extTaskId}].owner=${ownerRes.unresolvedRef}`,
      );
      return;
    }

    const existing = proj.tasks.find((t) => t.id === extTaskId);
    if (existing) {
      if (
        options.source === 'catchup' &&
        options.wsMutationSeqBeforeCatchup !== undefined
      ) {
        const liveSeq = this.wsTaskMutationSeq.get(`${convId}:${extTaskId}`) ?? 0;
        if (liveSeq > options.wsMutationSeqBeforeCatchup) {
          return;
        }
      }

      if (
        existing.externalUpdatedAtMs !== undefined &&
        incomingUpdatedAtMs !== undefined &&
        incomingUpdatedAtMs < existing.externalUpdatedAtMs
      ) {
        return;
      }

      const nextDescription =
        asNonEmptyString(rawTask.description) ?? existing.description;
      const nextAssigneeId =
        ownerRes.participant?.id ?? existing.assigneeParticipantId;
      const depsChanged =
        existing.dependencyTaskIds.length !== incomingDeps.length ||
        existing.dependencyTaskIds.some((dep, idx) => dep !== incomingDeps[idx]);
      const timestampAdvanced =
        incomingUpdatedAtMs !== undefined &&
        incomingUpdatedAtMs !== existing.externalUpdatedAtMs;
      const changed =
        existing.title !== title ||
        existing.description !== nextDescription ||
        existing.assigneeParticipantId !== nextAssigneeId ||
        existing.status !== mappedStatus ||
        depsChanged ||
        timestampAdvanced;

      if (!changed) {
        return;
      }

      const evt: ExecutionEvent = {
        id: this.nextId('evt_core_task_upd'),
        seq: this.nextLocalSeq(proj),
        conversationId: convId,
        timestamp: updatedAtIso ?? new Date().toISOString(),
        origin: 'gateway',
        originSource: 'aion_core',
        externalEventName: options.externalEventName,
        taskId: extTaskId,
        type: 'task_updated',
        payload: {
          taskId: extTaskId,
          patch: {
            title,
            description: nextDescription,
            assigneeParticipantId: nextAssigneeId,
            dependencyTaskIds: incomingDeps,
            status: mappedStatus,
            createdAt: createdAtIso ?? existing.createdAt,
            updatedAt: updatedAtIso ?? existing.updatedAt,
            externalUpdatedAtMs: incomingUpdatedAtMs ?? existing.externalUpdatedAtMs,
          },
          generalSummary: `Tarefa "${title}" atualizada pelo Core (estado: ${PT_BR.taskStatusLabels[mappedStatus]}).`,
        },
      };
      if (options.source === 'ws') {
        this.markWsTaskMutation(convId, extTaskId);
      }
      this.emitAndIngest(convId, evt);
      options.trackRecovered?.push(evt);
      return;
    }

    const roles = resolveTeamRoles(
      proj.participants,
      proj.conversation.coordinatorParticipantId,
    );
    const assignee =
      ownerRes.participant ??
      roles.executor ??
      roles.coordinator ??
      proj.participants[0];
    if (!assignee) return;
    const reviewer = roles.reviewer ?? roles.coordinator;

    const createEvtId = `evt_core_task_create_${convId}_${extTaskId}`;
    if (proj.seenEventIds.includes(createEvtId)) {
      return;
    }

    const createEvt: ExecutionEvent = {
      id: createEvtId,
      seq: this.nextLocalSeq(proj),
      conversationId: convId,
      timestamp: createdAtIso ?? updatedAtIso ?? new Date().toISOString(),
      origin: 'gateway',
      originSource: 'aion_core',
      externalEventName: options.externalEventName,
      taskId: extTaskId,
      type: 'task_created',
      payload: {
        task: {
          id: extTaskId,
          conversationId: convId,
          sourceRequestEventId: `core_${extTaskId}`,
          title,
          description:
            asNonEmptyString(rawTask.description) ??
            'Tarefa sincronizada do AionCore.',
          assigneeParticipantId: assignee.id,
          reviewerParticipantId: reviewer?.id,
          dependencyTaskIds: incomingDeps,
          acceptanceCriteria: ['Critério acompanhado no AionCore.'],
          status: mappedStatus,
          attempts: [],
          reviews: [],
          operationalFailureCount: 0,
          qualityRejectionCount: 0,
          originSource: 'aion_core',
          createdAt: createdAtIso,
          updatedAt: updatedAtIso,
          externalUpdatedAtMs: incomingUpdatedAtMs,
        },
        generalSummary: `Tarefa "${title}" sincronizada do Core (responsável: ${assignee.displayName}).`,
      },
    };
    if (options.source === 'ws') {
      this.markWsTaskMutation(convId, extTaskId);
    }
    this.emitAndIngest(convId, createEvt);
    options.trackRecovered?.push(createEvt);
  }

  private applySlotWorkSnapshots(
    convId: string,
    slotWorkList: TeamSlotWorkPayload[],
    externalEventName: string,
    wsSlotSeqBefore?: Map<string, number>,
  ): void {
    if (!this.state || slotWorkList.length === 0) return;
    for (const slotWork of slotWorkList) {
      const proj = this.state.conversations[convId];
      if (!proj) return;
      const slotId = asNonEmptyString(slotWork.slot_id);
      if (!slotId) continue;

      if (wsSlotSeqBefore) {
        const slotKey = `${convId}:${slotId}`;
        const currentSeq = this.wsSlotMutationSeq.get(slotKey) ?? 0;
        if (currentSeq > (wsSlotSeqBefore.get(slotKey) ?? 0)) {
          continue;
        }
      }

      const participant = proj.participants.find(
        (p) => p.sessionRef.externalSlotId === slotId,
      );
      if (!participant) continue;

      const stateStr = asNonEmptyString(slotWork.state) ?? 'idle';
      const activeTurnId = asNonEmptyString(slotWork.active_turn_id);
      const blockedReason = asNonEmptyString(slotWork.blocked_reason) ?? '';
      const teamRunId = asNonEmptyString(slotWork.team_run_id) ?? '';

      if (activeTurnId) {
        this.turnParticipantMap.set(`${convId}:${activeTurnId}`, participant.id);
      }

      const slotSigKey = `${convId}:${slotId}`;
      const slotSig = `${stateStr}|${activeTurnId ?? ''}|${blockedReason}|${teamRunId}`;
      if (wsSlotSeqBefore === undefined) {
        this.markWsSlotMutation(convId, slotId);
      }
      if (this.lastSlotWorkSignature.get(slotSigKey) === slotSig) {
        continue;
      }
      this.lastSlotWorkSignature.set(slotSigKey, slotSig);

      const mappedStatus: Participant['status'] =
        stateStr === 'running' || stateStr === 'starting' || stateStr === 'queued'
          ? 'running'
          : stateStr === 'blocked'
            ? 'blocked'
            : 'idle';

      if (
        participant.status === mappedStatus &&
        stateStr !== 'blocked' &&
        !activeTurnId
      ) {
        continue;
      }

      const detEventId = activeTurnId
        ? `evt_ws_slot_${convId}_${slotId}_${stateStr}_${activeTurnId}`
        : this.nextId('evt_slot_state');
      if (proj.seenEventIds.includes(detEventId)) {
        continue;
      }

      this.emitAndIngest(convId, {
        id: detEventId,
        seq: this.nextLocalSeq(proj),
        conversationId: convId,
        timestamp: new Date().toISOString(),
        origin: 'gateway',
        originSource: 'aion_core',
        externalEventName,
        correlationId: activeTurnId ?? (teamRunId || undefined),
        participantId: participant.id,
        type: 'connection_state_changed',
        payload: {
          participantId: participant.id,
          participantStatus: mappedStatus,
          sessionStatus: mappedStatus === 'blocked' ? 'disconnected' : 'active',
          generalSummary: `${participant.displayName} (${externalEventName}): estado ${stateStr}${blockedReason ? ` — ${blockedReason}` : ''}.`,
          projectToGeneral: stateStr === 'blocked',
        },
      });
    }
  }

  private resolveTargetConversationAndParticipant(
    wsMsg: WebSocketMessage,
    preferredConversationId?: string,
  ): {
    convId: string;
    proj: ConversationProjection;
    participant?: Participant;
  } | null {
    if (!this.state) return null;
    const data = wsMsg.data;
    const slotWorkObj = isRecord(data.slot_work) ? data.slot_work : undefined;
    const nestedTask = isRecord(data.task) ? data.task : undefined;
    const nestedMsg = isRecord(data.message) ? data.message : undefined;
    const rawExtConvId = asNonEmptyString(data.conversation_id);
    const rawTeamId =
      asNonEmptyString(data.team_id) ??
      asNonEmptyString(slotWorkObj?.team_id) ??
      asNonEmptyString(nestedTask?.team_id) ??
      asNonEmptyString(nestedMsg?.team_id);
    const rawSlotId =
      asNonEmptyString(data.slot_id) ??
      asNonEmptyString(data.target_slot_id) ??
      asNonEmptyString(data.sender_slot_id) ??
      asNonEmptyString(slotWorkObj?.slot_id);
    const rawTurnId =
      asNonEmptyString(data.turn_id) ??
      asNonEmptyString(slotWorkObj?.active_turn_id);

    const coreConversations = Object.entries(this.state.conversations).filter(
      ([, proj]) => proj.conversation.executionMode === 'aion_core',
    );

    // 1. Strict routing by externalConversationId (exact match across all Core conversations)
    if (rawExtConvId) {
      for (const [cid, proj] of coreConversations) {
        const matched = proj.participants.find(
          (p) => p.sessionRef.externalConversationId === rawExtConvId,
        );
        if (matched) {
          if (
            rawTeamId &&
            proj.conversation.externalTeamId &&
            proj.conversation.externalTeamId !== rawTeamId
          ) {
            return null;
          }
          return { convId: cid, proj, participant: matched };
        }
      }
      // Explicit externalConversationId does not match any participant; only continue if team_id explicitly routes
      if (!rawTeamId) {
        return null;
      }
    }

    // 2. Strict routing by externalTeamId + slot_id / target_slot_id / turn_id
    if (rawTeamId) {
      const teamEntry = coreConversations.find(
        ([, proj]) => proj.conversation.externalTeamId === rawTeamId,
      );
      if (!teamEntry) {
        // Explicit team_id belongs to another/unknown team — never leak into another conversation
        return null;
      }
      const [cid, proj] = teamEntry;
      const participant =
        (rawSlotId
          ? proj.participants.find(
              (p) => p.sessionRef.externalSlotId === rawSlotId,
            )
          : undefined) ??
        (rawTurnId
          ? proj.participants.find(
              (p) =>
                p.id === this.turnParticipantMap.get(`${cid}:${rawTurnId}`),
            )
          : undefined);
      return { convId: cid, proj, participant };
    }

    // 3. Routing by externalSlotId across Core conversations ONLY when neither conversation_id nor team_id was provided
    if (rawSlotId) {
      for (const [cid, proj] of coreConversations) {
        const matched = proj.participants.find(
          (p) => p.sessionRef.externalSlotId === rawSlotId,
        );
        if (matched) {
          return { convId: cid, proj, participant: matched };
        }
      }
      return null;
    }

    // 4. Fallback to preferredConversationId ONLY when no external identifier was supplied
    if (
      preferredConversationId &&
      this.state.conversations[preferredConversationId]
    ) {
      const proj = this.state.conversations[preferredConversationId];
      const participant =
        (rawTurnId
          ? proj.participants.find(
              (p) =>
                p.id ===
                this.turnParticipantMap.get(
                  `${preferredConversationId}:${rawTurnId}`,
                ),
            )
          : undefined) ??
        proj.participants.find(
          (p) => p.id === proj.conversation.coordinatorParticipantId,
        );
      return { convId: preferredConversationId, proj, participant };
    }

    return null;
  }

  private closeUnfinishedStreamBuffersForTurn(
    convId: string,
    participantId: string,
    turnId?: string,
    msgId?: string,
  ): void {
    for (const buf of this.streamBuffers.values()) {
      if (
        buf.conversationId === convId &&
        buf.participantId === participantId &&
        !buf.finished &&
        (!turnId || buf.turnId === turnId || (msgId && buf.msgId === msgId))
      ) {
        buf.finished = true;
      }
    }
  }

  private handleCoreChildTurnCancelled(
    convId: string,
    participant: Participant,
    payload: Partial<TeamChildTurnPayload>,
    externalEventName: string,
  ): void {
    if (!this.state) return;
    let proj = this.state.conversations[convId];
    if (!proj) return;

    const turnId = asNonEmptyString(payload.turn_id);
    const teamRunId = asNonEmptyString(payload.team_run_id);
    const reason = asNonEmptyString(payload.reason);
    const replacementMsgId = asNonEmptyString(payload.replacement_message_id);

    const dedupeKey = turnId ?? teamRunId ?? replacementMsgId;
    const cancelEvtId = dedupeKey
      ? `evt_ws_child_cancelled_${convId}_${participant.id}_${dedupeKey}`
      : this.nextId('evt_ws_child_cancelled');

    if (proj.seenEventIds.includes(cancelEvtId)) {
      return;
    }

    // Close any open stream buffer WITHOUT finalizing/publishing it as a completed delivery
    this.closeUnfinishedStreamBuffersForTurn(convId, participant.id, turnId);
    this.expectedKindByParticipant.delete(`${convId}:${participant.id}`);
    this.markWsSlotMutation(convId, participant.sessionRef.externalSlotId);

    const now = new Date().toISOString();
    const runningTask = proj.tasks.find((t) =>
      t.attempts.some(
        (a) =>
          a.executorParticipantId === participant.id && a.status === 'running',
      ),
    );
    if (runningTask) {
      this.markWsTaskMutation(convId, runningTask.id);
      const taskCancelEvtId = `${cancelEvtId}_task_${runningTask.id}`;
      if (!proj.seenEventIds.includes(taskCancelEvtId)) {
        this.emitAndIngest(convId, {
          id: taskCancelEvtId,
          seq: this.nextLocalSeq(proj),
          conversationId: convId,
          timestamp: now,
          origin: 'gateway',
          originSource: 'aion_core',
          externalEventName,
          correlationId: turnId ?? teamRunId,
          participantId: participant.id,
          taskId: runningTask.id,
          type: 'task_status_changed',
          payload: {
            taskId: runningTask.id,
            nextStatus: 'cancelled',
            participantStatus: 'idle',
            projectToGeneral: false,
          },
        });
        proj = this.state.conversations[convId]!;
      }
    }

    const summaryParts = [
      `Turno de ${participant.displayName} cancelado no Core (${externalEventName})`,
    ];
    if (reason) summaryParts.push(`motivo: ${reason}`);
    if (replacementMsgId) {
      summaryParts.push(`substituído por mensagem ${replacementMsgId}`);
    }

    this.emitAndIngest(convId, {
      id: cancelEvtId,
      seq: this.nextLocalSeq(proj),
      conversationId: convId,
      timestamp: now,
      origin: 'gateway',
      originSource: 'aion_core',
      externalEventName,
      correlationId: turnId ?? teamRunId,
      participantId: participant.id,
      taskId: runningTask?.id,
      type: 'execution_control_applied',
      payload: {
        control: 'request_interrupt',
        participantId: participant.id,
        participantStatus: 'idle',
        generalSummary: `${summaryParts.join(' · ')}. Entrega não finalizada.`,
      },
    });
  }

  private handleIncomingWebSocketEvent(
    wsMsg: WebSocketMessage,
    preferredConversationId?: string,
  ): void {
    if (!this.state) return;
    const resolved = this.resolveTargetConversationAndParticipant(
      wsMsg,
      preferredConversationId,
    );
    if (!resolved) return;

    const { convId, proj } = resolved;
    const data = wsMsg.data;
    const now = new Date().toISOString();

    // 1. Core `team.slotWorkChanged` (crates/aionui-team/src/events.rs)
    if (wsMsg.name === CORE_WS_EVENTS.TEAM_SLOT_WORK_CHANGED) {
      const slotWork = isRecord(data.slot_work)
        ? (data.slot_work as unknown as TeamSlotWorkPayload)
        : undefined;
      if (!slotWork) return;
      this.applySlotWorkSnapshots(convId, [slotWork], wsMsg.name);
      return;
    }

    // 2. Core `message.stream` (forward_to_websocket_with_msg_id)
    if (wsMsg.name === CORE_WS_EVENTS.MESSAGE_STREAM) {
      const participant =
        resolved.participant ??
        proj.participants.find(
          (p) => p.id === proj.conversation.coordinatorParticipantId,
        );
      if (!participant) return;

      const extConvId =
        asNonEmptyString(data.conversation_id) ??
        participant.sessionRef.externalConversationId ??
        '';
      const msgId =
        asNonEmptyString(data.msg_id) ?? asNonEmptyString(data.message_id);
      const turnId = asNonEmptyString(data.turn_id);
      const msgType = asNonEmptyString(data.type) ?? '';
      const inner = isRecord(data.data) ? data.data : undefined;
      const chunkContent =
        typeof inner?.content === 'string'
          ? inner.content
          : typeof data.data === 'string'
            ? data.data
            : typeof data.content === 'string'
              ? data.content
              : '';
      const errorText =
        asNonEmptyString(inner?.error) ??
        asNonEmptyString(inner?.message) ??
        asNonEmptyString(data.error) ??
        chunkContent;

      if (turnId) {
        this.turnParticipantMap.set(`${convId}:${turnId}`, participant.id);
      }

      const effectiveMsgKey = msgId ?? turnId;
      if (!effectiveMsgKey) return;

      const bufferKey = `${convId}:${participant.id}:${effectiveMsgKey}`;
      let buffer = this.streamBuffers.get(bufferKey);

      if (
        !buffer &&
        msgId &&
        this.isExternalMessageAlreadyStored(proj, msgId)
      ) {
        return;
      }
      if (buffer?.finished) {
        return;
      }

      if (!buffer) {
        buffer = {
          key: bufferKey,
          conversationId: convId,
          participantId: participant.id,
          extConvId,
          msgId: msgId ?? effectiveMsgKey,
          turnId,
          text: '',
          finished: false,
          seenChunkTokens: new Set(),
        };
        this.streamBuffers.set(bufferKey, buffer);
      }

      const explicitFrameId =
        asNonEmptyString(data.event_id) ??
        (typeof data.chunk_index === 'number'
          ? `idx_${data.chunk_index}`
          : undefined) ??
        (typeof data.seq === 'number' ? `seq_${data.seq}` : undefined);
      if (explicitFrameId) {
        const frameToken = `${msgType}:${explicitFrameId}`;
        if (buffer.seenChunkTokens.has(frameToken)) return;
        buffer.seenChunkTokens.add(frameToken);
      }

      if (msgType === 'error' || msgType === 'failed') {
        buffer.finished = true;
        this.handleCoreParticipantFailure(
          convId,
          participant,
          errorText || 'Erro retornado no stream do Core.',
          wsMsg.name,
          {
            deterministicEventId: msgId
              ? `evt_ws_stream_err_${convId}_${msgId}`
              : undefined,
          },
        );
        return;
      }

      const isFinishType =
        msgType === 'finish' ||
        msgType === 'end' ||
        msgType === 'done' ||
        msgType === 'completed';

      if (
        msgType === 'content' ||
        msgType === 'text' ||
        msgType === 'delta' ||
        (!isFinishType && chunkContent)
      ) {
        if (!chunkContent) return;
        buffer.text += chunkContent;
        const latestProj = this.state.conversations[convId];
        if (!latestProj) return;
        this.emitAndIngest(convId, {
          id: this.nextId('evt_stream_delta'),
          seq: this.nextLocalSeq(latestProj),
          conversationId: convId,
          timestamp: now,
          origin: hasRole(participant, 'reviewer')
            ? 'reviewer'
            : hasRole(participant, 'coordinator')
              ? 'coordinator'
              : 'executor',
          originSource: 'aion_core',
          externalEventName: wsMsg.name,
          correlationId: turnId,
          participantId: participant.id,
          type: 'agent_message_posted',
          payload: {
            messageId: `msg_core_${buffer.msgId}`,
            externalMessageId: buffer.msgId,
            targetTab: participant.id,
            authorLabel: participant.displayName,
            authorRoleLabel: getParticipantRoles(participant)
              .map((r) => PT_BR.roleLabels[r])
              .join(' + '),
            bodyMarkdown: buffer.text,
            upsertByMessageId: true,
            isStreamingDelta: true,
            projectToGeneral: false,
          },
        });
        return;
      }

      if (isFinishType) {
        if (!buffer.text && chunkContent) {
          buffer.text = chunkContent;
        }
        buffer.finished = true;
        this.finalizeCoreAgentMessage({
          convId,
          participant,
          fullText: buffer.text,
          extMsgId: buffer.msgId,
          turnId: buffer.turnId,
          externalEventName: wsMsg.name,
        });
      }
      return;
    }

    // 3. Core `team.childTurnStarted`
    if (wsMsg.name === CORE_WS_EVENTS.TEAM_CHILD_TURN_STARTED) {
      const turnId = asNonEmptyString(data.turn_id);
      const slotId = asNonEmptyString(data.slot_id);
      const participant =
        resolved.participant ??
        (slotId
          ? proj.participants.find((p) => p.sessionRef.externalSlotId === slotId)
          : undefined);
      if (!participant) return;

      if (turnId) {
        this.turnParticipantMap.set(`${convId}:${turnId}`, participant.id);
      }
      this.markWsSlotMutation(convId, participant.sessionRef.externalSlotId);

      const startEvtId = turnId
        ? `evt_ws_child_started_${convId}_${turnId}`
        : this.nextId('evt_ws_child_started');
      if (proj.seenEventIds.includes(startEvtId)) return;

      this.emitAndIngest(convId, {
        id: startEvtId,
        seq: this.nextLocalSeq(proj),
        conversationId: convId,
        timestamp: now,
        origin: 'gateway',
        originSource: 'aion_core',
        externalEventName: wsMsg.name,
        correlationId: turnId ?? asNonEmptyString(data.team_run_id),
        participantId: participant.id,
        type: 'connection_state_changed',
        payload: {
          participantId: participant.id,
          participantStatus: 'running',
          sessionStatus: 'active',
          generalSummary: `${participant.displayName} iniciou turno (${turnId ?? 'Core'}).`,
          projectToGeneral: false,
        },
      });
      return;
    }

    // 4. Core `team.childTurnCompleted` (carries status: 'completed' | 'failed' | 'cancelled')
    if (wsMsg.name === CORE_WS_EVENTS.TEAM_CHILD_TURN_COMPLETED) {
      const explicitSlotId = asNonEmptyString(data.slot_id);
      const participant =
        resolved.participant ??
        (explicitSlotId
          ? proj.participants.find(
              (p) => p.sessionRef.externalSlotId === explicitSlotId,
            )
          : proj.participants.find(
              (p) => p.id === proj.conversation.coordinatorParticipantId,
            ));
      if (!participant) return;

      const turnId = asNonEmptyString(data.turn_id);
      const teamRunId = asNonEmptyString(data.team_run_id);
      const statusStr = (asNonEmptyString(data.status) ?? 'completed').toLowerCase();
      if (turnId) {
        this.turnParticipantMap.set(`${convId}:${turnId}`, participant.id);
      }

      if (statusStr === 'cancelled') {
        this.handleCoreChildTurnCancelled(
          convId,
          participant,
          data as Partial<TeamChildTurnPayload>,
          wsMsg.name,
        );
        return;
      }

      if (statusStr === 'failed') {
        const reason =
          asNonEmptyString(data.reason) ??
          asNonEmptyString(data.error) ??
          asNonEmptyString(data.message) ??
          `Turno do participante ${participant.displayName} falhou em team.childTurnCompleted (turn ${turnId ?? 'desconhecido'}).`;
        this.closeUnfinishedStreamBuffersForTurn(convId, participant.id, turnId);
        this.expectedKindByParticipant.delete(`${convId}:${participant.id}`);
        this.markWsSlotMutation(convId, participant.sessionRef.externalSlotId);
        this.handleCoreParticipantFailure(
          convId,
          participant,
          reason,
          wsMsg.name,
          {
            deterministicEventId: turnId
              ? `evt_ws_child_failed_${convId}_${participant.id}_${turnId}`
              : teamRunId
                ? `evt_ws_child_failed_${convId}_${participant.id}_${teamRunId}`
                : undefined,
          },
        );
        return;
      }

      // status === 'completed': finalize matching stream buffer or turn message
      const msgId =
        asNonEmptyString(data.msg_id) ??
        asNonEmptyString(data.message_id) ??
        asNonEmptyString(data.replacement_message_id) ??
        turnId;
      const bodyFromTurn =
        asNonEmptyString(data.content) ??
        asNonEmptyString(data.summary) ??
        asNonEmptyString(data.message);

      for (const buf of this.streamBuffers.values()) {
        if (
          buf.conversationId === convId &&
          buf.participantId === participant.id &&
          !buf.finished &&
          (!turnId || buf.turnId === turnId || buf.msgId === msgId)
        ) {
          buf.finished = true;
          const finalBody = buf.text || bodyFromTurn || '';
          if (finalBody) {
            this.finalizeCoreAgentMessage({
              convId,
              participant,
              fullText: finalBody,
              extMsgId: buf.msgId,
              turnId: buf.turnId ?? turnId,
              externalEventName: wsMsg.name,
            });
          }
          return;
        }
      }

      if (bodyFromTurn && msgId && !this.isExternalMessageAlreadyStored(proj, msgId)) {
        this.finalizeCoreAgentMessage({
          convId,
          participant,
          fullText: bodyFromTurn,
          extMsgId: msgId,
          turnId,
          externalEventName: wsMsg.name,
        });
      }
      return;
    }

    // 5. Core `team.childTurnCancelled`
    if (wsMsg.name === CORE_WS_EVENTS.TEAM_CHILD_TURN_CANCELLED) {
      const explicitSlotId = asNonEmptyString(data.slot_id);
      const participant =
        resolved.participant ??
        (explicitSlotId
          ? proj.participants.find(
              (p) => p.sessionRef.externalSlotId === explicitSlotId,
            )
          : proj.participants.find(
              (p) => p.id === proj.conversation.coordinatorParticipantId,
            ));
      if (!participant) return;

      this.handleCoreChildTurnCancelled(
        convId,
        participant,
        data as Partial<TeamChildTurnPayload>,
        wsMsg.name,
      );
      return;
    }

    // 6. Core `team.runFailed` (`TeamRunPayload`: `team_id` + `target_slot_id` + `slot_work[]`)
    if (wsMsg.name === CORE_WS_EVENTS.TEAM_RUN_FAILED) {
      const teamRunId = asNonEmptyString(data.team_run_id) ?? 'run_unknown';
      const runFailEvtId = `evt_ws_run_failed_${convId}_${teamRunId}`;
      if (proj.seenEventIds.includes(runFailEvtId)) {
        return;
      }

      const targetSlotId = asNonEmptyString(data.target_slot_id);
      const participant =
        resolved.participant ??
        (targetSlotId
          ? proj.participants.find(
              (p) => p.sessionRef.externalSlotId === targetSlotId,
            )
          : undefined) ??
        proj.participants.find(
          (p) => p.id === proj.conversation.coordinatorParticipantId,
        );

      const slotWorkList = Array.isArray(data.slot_work)
        ? (data.slot_work as unknown[]).filter(isRecord).map((s) => s as unknown as TeamSlotWorkPayload)
        : [];
      if (slotWorkList.length > 0) {
        this.applySlotWorkSnapshots(convId, slotWorkList, wsMsg.name);
      }

      if (participant) {
        this.closeUnfinishedStreamBuffersForTurn(convId, participant.id);
        this.expectedKindByParticipant.delete(`${convId}:${participant.id}`);
        this.markWsSlotMutation(convId, participant.sessionRef.externalSlotId);
      }

      const latestProj = this.state.conversations[convId]!;
      const reason =
        asNonEmptyString(data.reason) ??
        asNonEmptyString(data.error) ??
        asNonEmptyString(data.message) ??
        `Execução ${teamRunId} falhou no AionCore (${wsMsg.name}).`;

      const runningTask = participant
        ? latestProj.tasks.find((t) =>
            t.attempts.some(
              (a) =>
                a.executorParticipantId === participant.id &&
                a.status === 'running',
            ),
          )
        : undefined;
      if (participant && runningTask) {
        this.handleCoreParticipantFailure(
          convId,
          participant,
          reason,
          wsMsg.name,
          {
            deterministicEventId: `evt_ws_run_opfail_${convId}_${teamRunId}_${runningTask.id}`,
          },
        );
      }

      const postOpProj = this.state.conversations[convId]!;
      this.emitAndIngest(convId, {
        id: runFailEvtId,
        seq: this.nextLocalSeq(postOpProj),
        conversationId: convId,
        timestamp: now,
        origin: 'gateway',
        originSource: 'aion_core',
        externalEventName: wsMsg.name,
        correlationId: teamRunId,
        participantId: participant?.id,
        taskId: runningTask?.id,
        type: 'execution_control_applied',
        payload: {
          control: 'request_interrupt',
          nextExecutionStatus: 'failed',
          participantId: participant?.id,
          participantStatus: participant ? 'failed' : undefined,
          generalSummary: `Execução da equipe falhou no AionCore (run ${teamRunId}${participant ? ` · alvo: ${participant.displayName}` : ''}): ${reason}`,
        },
      });
      return;
    }

    // 7. Core `team.runCancelled`, `team.runAccepted`, `team.runStarted`, `team.runUpdated`, `team.runCompleted`
    if (
      wsMsg.name === CORE_WS_EVENTS.TEAM_RUN_CANCELLED ||
      wsMsg.name === CORE_WS_EVENTS.TEAM_RUN_ACCEPTED ||
      wsMsg.name === CORE_WS_EVENTS.TEAM_RUN_STARTED ||
      wsMsg.name === CORE_WS_EVENTS.TEAM_RUN_UPDATED ||
      wsMsg.name === CORE_WS_EVENTS.TEAM_RUN_COMPLETED
    ) {
      const slotWorkList = Array.isArray(data.slot_work)
        ? (data.slot_work as unknown[]).filter(isRecord).map((s) => s as unknown as TeamSlotWorkPayload)
        : [];
      if (slotWorkList.length > 0) {
        this.applySlotWorkSnapshots(convId, slotWorkList, wsMsg.name);
      }

      if (wsMsg.name === CORE_WS_EVENTS.TEAM_RUN_CANCELLED) {
        const teamRunId = asNonEmptyString(data.team_run_id) ?? 'run_unknown';
        const cancelRunEvtId = `evt_ws_run_cancelled_${convId}_${teamRunId}`;
        const latestProj = this.state.conversations[convId]!;
        if (latestProj.seenEventIds.includes(cancelRunEvtId)) return;

        const targetSlotId = asNonEmptyString(data.target_slot_id);
        const participant =
          resolved.participant ??
          (targetSlotId
            ? latestProj.participants.find(
                (p) => p.sessionRef.externalSlotId === targetSlotId,
              )
            : undefined);
        if (participant) {
          this.closeUnfinishedStreamBuffersForTurn(convId, participant.id);
          this.expectedKindByParticipant.delete(`${convId}:${participant.id}`);
          this.markWsSlotMutation(convId, participant.sessionRef.externalSlotId);
        }
        this.emitAndIngest(convId, {
          id: cancelRunEvtId,
          seq: this.nextLocalSeq(latestProj),
          conversationId: convId,
          timestamp: now,
          origin: 'gateway',
          originSource: 'aion_core',
          externalEventName: wsMsg.name,
          correlationId: teamRunId,
          participantId: participant?.id,
          type: 'execution_control_applied',
          payload: {
            control: 'request_interrupt',
            nextExecutionStatus: 'idle',
            participantId: participant?.id,
            participantStatus: participant ? 'idle' : undefined,
            generalSummary: `Execução ${teamRunId} cancelada no AionCore.`,
          },
        });
      }
      return;
    }

    // 8. Core `team.taskChanged` (`TeamTaskChangedPayload`)
    if (wsMsg.name === CORE_WS_EVENTS.TEAM_TASK_CHANGED) {
      const payload = data as unknown as Partial<TeamTaskChangedPayload>;
      if (!this.isValidTaskDto(payload.task)) return;
      this.upsertCoreTask(convId, payload.task, {
        source: 'ws',
        externalEventName: wsMsg.name,
      });
      return;
    }

    // 9. Core `team.mailboxChanged` (`TeamMailboxChangedPayload`)
    if (wsMsg.name === CORE_WS_EVENTS.TEAM_MAILBOX_CHANGED) {
      const payload = data as unknown as Partial<TeamMailboxChangedPayload>;
      if (!this.isValidMailboxMessageDto(payload.message)) return;
      this.ingestCoreMailboxMessage(convId, payload.message, {
        externalEventName: wsMsg.name,
      });
      return;
    }

    // 10. Core `team.teammateMessage` or generic direct notification with explicit message_id & text
    const fallbackParticipant =
      resolved.participant ??
      proj.participants.find(
        (p) => p.id === proj.conversation.coordinatorParticipantId,
      );
    const fallbackContent =
      asNonEmptyString(data.content) ??
      asNonEmptyString(data.message) ??
      asNonEmptyString(data.summary);
    const fallbackMsgId =
      asNonEmptyString(data.message_id) ?? asNonEmptyString(data.msg_id);
    if (fallbackParticipant && fallbackContent) {
      if (
        fallbackMsgId &&
        this.isExternalMessageAlreadyStored(proj, fallbackMsgId)
      ) {
        return;
      }
      this.finalizeCoreAgentMessage({
        convId,
        participant: fallbackParticipant,
        fullText: fallbackContent,
        extMsgId: fallbackMsgId ?? this.nextId('ws_msg'),
        turnId: asNonEmptyString(data.turn_id),
        externalEventName: wsMsg.name,
      });
    }
  }

  private handleCoreParticipantFailure(
    convId: string,
    participant: Participant,
    reason: string,
    externalEventName: string,
    options?: {
      deterministicEventId?: string;
      nextExecutionStatus?: ConversationProjection['conversation']['executionStatus'];
    },
  ): void {
    if (!this.state) return;
    const proj = this.state.conversations[convId];
    if (!proj) return;
    const eventId = options?.deterministicEventId;
    if (eventId && proj.seenEventIds.includes(eventId)) {
      return;
    }

    const runningTask = proj.tasks.find((t) =>
      t.attempts.some(
        (a) =>
          a.executorParticipantId === participant.id && a.status === 'running',
      ),
    );
    const runningAttempt = runningTask?.attempts.find(
      (a) =>
        a.executorParticipantId === participant.id && a.status === 'running',
    );
    const seq = this.nextLocalSeq(proj);
    if (runningTask && runningAttempt) {
      this.markWsTaskMutation(convId, runningTask.id);
      this.emitAndIngest(convId, {
        id: eventId ?? this.nextId('evt_core_opfail'),
        seq,
        conversationId: convId,
        timestamp: new Date().toISOString(),
        origin: 'gateway',
        originSource: 'aion_core',
        externalEventName,
        participantId: participant.id,
        taskId: runningTask.id,
        attemptId: runningAttempt.id,
        type: 'operational_failure_recorded',
        payload: {
          taskId: runningTask.id,
          attemptId: runningAttempt.id,
          reason,
          participantStatus: 'failed',
          generalSummary: `Falha operacional registrada para ${participant.displayName} (${reason}). Não contabilizada como reprovação de qualidade.`,
        },
      });
      return;
    }

    this.emitAndIngest(convId, {
      id: eventId ?? this.nextId('evt_core_err'),
      seq,
      conversationId: convId,
      timestamp: new Date().toISOString(),
      origin: 'gateway',
      originSource: 'aion_core',
      externalEventName,
      participantId: participant.id,
      type: 'execution_control_applied',
      payload: {
        control: 'request_interrupt',
        nextExecutionStatus: options?.nextExecutionStatus,
        participantId: participant.id,
        participantStatus: 'failed',
        generalSummary: `Falha operacional relatada por ${participant.displayName} (${externalEventName}): ${reason}`,
      },
    });
  }

  private finalizeCoreAgentMessage(input: {
    convId: string;
    participant: Participant;
    fullText: string;
    extMsgId: string;
    turnId?: string;
    externalEventName: string;
    timestamp?: string;
  }): void {
    if (!this.state) return;
    const proj = this.state.conversations[input.convId];
    if (!proj) return;
    const now = input.timestamp ?? new Date().toISOString();
    const trimmed = input.fullText.trim();
    if (!trimmed) return;

    const expectedKey = `${input.convId}:${input.participant.id}`;
    const expectedKind = this.expectedKindByParticipant.get(expectedKey);
    const containsStructuredBlock = /```aion-desk-json/i.test(trimmed);
    const shouldValidateStructured =
      expectedKind !== undefined || containsStructuredBlock;

    const parsedOutput = shouldValidateStructured
      ? parseStructuredAgentOutput(trimmed, undefined)
      : undefined;

    // Validate expectedKind mismatch OR conversationId mismatch cleanly
    let finalParseStatus = parsedOutput?.parseStatus;
    let finalParseReason = parsedOutput?.errorReason;
    let validEnvelope = parsedOutput?.valid ? parsedOutput.parsed : undefined;

    if (
      validEnvelope &&
      validEnvelope.conversationId !== input.convId &&
      validEnvelope.conversationId !==
        input.participant.sessionRef.externalConversationId
    ) {
      validEnvelope = undefined;
      finalParseStatus = 'invalid';
      finalParseReason = `Envelope aion-desk/v1 referencia conversa divergente (${parsedOutput?.parsed?.conversationId}).`;
    } else if (
      validEnvelope &&
      expectedKind &&
      validEnvelope.kind !== expectedKind &&
      !(expectedKind === 'plan_proposal' && validEnvelope.kind === 'plan_proposal')
    ) {
      // Allow valid structured kinds matching role authority, otherwise flag mismatch
      if (
        (validEnvelope.kind === 'delivery_report' &&
          !hasRole(input.participant, 'executor')) ||
        (validEnvelope.kind === 'review_decision' &&
          !hasRole(input.participant, 'reviewer'))
      ) {
        validEnvelope = undefined;
        finalParseStatus = 'invalid';
        finalParseReason = `Tipo de resposta "${parsedOutput?.parsed?.kind}" incompatível com o esperado ("${expectedKind}").`;
      }
    }

    const finalEventId = `evt_core_msg_final_${input.convId}_${input.extMsgId}`;
    if (proj.seenEventIds.includes(finalEventId)) {
      return;
    }

    this.emitAndIngest(input.convId, {
      id: finalEventId,
      seq: this.nextLocalSeq(proj),
      conversationId: input.convId,
      timestamp: now,
      origin: hasRole(input.participant, 'reviewer')
        ? 'reviewer'
        : hasRole(input.participant, 'coordinator')
          ? 'coordinator'
          : 'executor',
      originSource: 'aion_core',
      externalEventName: input.externalEventName,
      correlationId: input.turnId,
      participantId: input.participant.id,
      type: 'agent_message_posted',
      payload: {
        messageId: `msg_core_${input.extMsgId}`,
        externalMessageId: input.extMsgId,
        targetTab: input.participant.id,
        authorLabel: input.participant.displayName,
        authorRoleLabel: getParticipantRoles(input.participant)
          .map((r) => PT_BR.roleLabels[r])
          .join(' + '),
        bodyMarkdown: trimmed,
        upsertByMessageId: true,
        isStreamingDelta: false,
        parseStatus: finalParseStatus,
        parseReason: finalParseReason,
        projectToGeneral: !validEnvelope,
        generalKind: 'delivery_summary',
        generalSummary: !validEnvelope
          ? `${input.participant.displayName} (${input.externalEventName}): ${trimmed.slice(0, 120)}`
          : undefined,
        detailLinkLabel: 'Ver execução',
      },
    });

    // Receipt update: response received from participant -> mark `'received'` if previously `'pending_send'` or `'sent'`
    const postMsgProj = this.state.conversations[input.convId];
    const latestCtx = postMsgProj ? getLatestContextRevision(postMsgProj) : undefined;
    if (latestCtx) {
      const existingReceipt = latestCtx.receipts[input.participant.id];
      if (
        !existingReceipt ||
        existingReceipt.status === 'pending_send' ||
        existingReceipt.status === 'sent'
      ) {
        this.emitAndIngest(input.convId, {
          id: `evt_core_rcpt_recv_${latestCtx.id}_${input.participant.id}_${input.extMsgId}`,
          seq: this.nextLocalSeq(postMsgProj),
          conversationId: input.convId,
          timestamp: now,
          origin: 'gateway',
          originSource: 'aion_core',
          participantId: input.participant.id,
          type: 'context_receipt_updated',
          payload: {
            revisionId: latestCtx.id,
            versionNumber: latestCtx.versionNumber,
            participantId: input.participant.id,
            receipt: {
              participantId: input.participant.id,
              revisionId: latestCtx.id,
              status: 'received',
              policyApplied: 'next_turn',
              updatedAt: now,
              mechanismNote: `Resposta recebida de ${input.participant.displayName} (msg ${input.extMsgId}); aplicação comprovada somente mediante entrega correlacionada.`,
            },
            projectToGeneral: false,
          },
        });
      }
    }

    if (!validEnvelope) {
      return;
    }

    this.expectedKindByParticipant.delete(expectedKey);

    if (validEnvelope.kind === 'plan_proposal') {
      this.applyStructuredPlanProposal(
        input.convId,
        input.participant,
        validEnvelope,
        finalEventId,
      );
      return;
    }

    if (validEnvelope.kind === 'delivery_report') {
      this.applyStructuredDeliveryReport(
        input.convId,
        input.participant,
        validEnvelope,
      );
      return;
    }

    if (validEnvelope.kind === 'review_decision') {
      this.applyStructuredReviewDecision(
        input.convId,
        input.participant,
        validEnvelope,
      );
    }
  }

  private applyStructuredPlanProposal(
    convId: string,
    author: Participant,
    plan: PlanProposalPayload,
    sourceEventId: string,
  ): void {
    if (!this.state) return;
    let proj = this.state.conversations[convId];
    if (!proj) return;
    const now = new Date().toISOString();
    const roles = resolveTeamRoles(
      proj.participants,
      proj.conversation.coordinatorParticipantId,
    );
    const planRevId = `plan_core_${convId}_${proj.planRevisions.length + 1}`;

    const createdTasks: Task[] = [];
    const titleOrAliasToId = new Map<string, string>();

    plan.tasks.forEach((rawTask, index) => {
      const generatedId = `task_core_${convId}_${proj.tasks.length + index + 1}`;
      const depIds: string[] = [];
      for (const depRef of rawTask.dependencies ?? []) {
        const normalizedRef = depRef.trim();
        const mapped =
          titleOrAliasToId.get(normalizedRef) ??
          (proj.tasks.some((t) => t.id === normalizedRef)
            ? normalizedRef
            : undefined);
        if (mapped && !depIds.includes(mapped)) {
          depIds.push(mapped);
        }
      }

      const assignee =
        (rawTask.assigneeRole
          ? proj.participants.find(
              (p) => !p.archived && hasRole(p, rawTask.assigneeRole!),
            )
          : undefined) ??
        roles.executor ??
        roles.coordinator ??
        author;
      const reviewer = roles.reviewer ?? roles.coordinator ?? author;

      const latestCtx = getLatestContextRevision(proj);
      const taskObj: Task = {
        id: generatedId,
        conversationId: convId,
        sourceRequestEventId: sourceEventId,
        planRevisionId: planRevId,
        title: rawTask.title.trim(),
        description: rawTask.description.trim(),
        assigneeParticipantId: assignee.id,
        reviewerParticipantId: reviewer.id,
        dependencyTaskIds: depIds,
        acceptanceCriteria:
          rawTask.acceptanceCriteria.length > 0
            ? [...rawTask.acceptanceCriteria]
            : ['Atender ao objetivo combinado no Contexto Compartilhado.'],
        status: depIds.length === 0 ? 'queued' : 'planned',
        attempts: [],
        reviews: [],
        operationalFailureCount: 0,
        qualityRejectionCount: 0,
        activeContextRevisionId: latestCtx?.id,
        originSource: 'aion_core',
      };

      titleOrAliasToId.set(rawTask.title.trim(), generatedId);
      titleOrAliasToId.set(`task_${index + 1}`, generatedId);
      titleOrAliasToId.set(String(index + 1), generatedId);
      createdTasks.push(taskObj);
    });

    for (const task of createdTasks) {
      proj = this.state.conversations[convId];
      if (!proj) return;
      const assignee = proj.participants.find(
        (p) => p.id === task.assigneeParticipantId,
      );
      this.emitAndIngest(convId, {
        id: `evt_core_t_${task.id}`,
        seq: this.nextLocalSeq(proj),
        conversationId: convId,
        timestamp: now,
        origin: 'coordinator',
        originSource: 'aion_core',
        participantId: author.id,
        taskId: task.id,
        type: 'task_created',
        payload: {
          task,
          generalSummary: `Tarefa "${task.title}" criada a partir do plano de ${author.displayName} (executor: ${assignee?.displayName ?? '—'}).`,
        },
      });
    }

    proj = this.state.conversations[convId];
    if (!proj) return;
    const planRevEvtId = `evt_core_plan_${planRevId}`;
    this.emitAndIngest(convId, {
      id: planRevEvtId,
      seq: this.nextLocalSeq(proj),
      conversationId: convId,
      timestamp: now,
      origin: 'coordinator',
      originSource: 'aion_core',
      participantId: author.id,
      type: 'plan_revision_published',
      payload: {
        planRevision: {
          id: planRevId,
          conversationId: convId,
          versionNumber: proj.planRevisions.length + 1,
          authorLabel: author.displayName,
          createdAt: now,
          summary: plan.summary,
          taskIds: createdTasks.map((t) => t.id),
          sourceEventId: planRevEvtId,
          originSource: 'aion_core',
        },
        generalSummary: `Plano v${proj.planRevisions.length + 1} publicado por ${author.displayName} (${createdTasks.length} tarefa(s)).`,
      },
    });

    this.enqueueBackgroundWork(async () => {
      await this.dispatchNextRunnableTaskInCore(convId);
    });
  }

  private applyStructuredDeliveryReport(
    convId: string,
    executor: Participant,
    report: {
      taskId: string;
      attemptId?: string;
      deliverySummary: string;
      evidenceNotes: string[];
    },
  ): void {
    if (!this.state) return;
    let proj = this.state.conversations[convId];
    if (!proj) return;
    const now = new Date().toISOString();

    const task =
      proj.tasks.find((t) => t.id === report.taskId) ??
      proj.tasks.find(
        (t) =>
          t.assigneeParticipantId === executor.id &&
          (t.status === 'running' || t.status === 'queued'),
      );
    if (!task) return;

    let attempt: TaskAttempt | undefined =
      (report.attemptId
        ? task.attempts.find((a) => a.id === report.attemptId)
        : undefined) ??
      task.attempts.find((a) => a.status === 'running') ??
      task.attempts[task.attempts.length - 1];

    if (!attempt) {
      const latestCtx = getLatestContextRevision(proj);
      const attId = `att_core_${task.id}_1`;
      const sStartEvt = `evt_core_att_impl_${task.id}_${this.nextId('s')}`;
      this.emitAndIngest(convId, {
        id: sStartEvt,
        seq: this.nextLocalSeq(proj),
        conversationId: convId,
        timestamp: now,
        origin: 'executor',
        originSource: 'aion_core',
        participantId: executor.id,
        taskId: task.id,
        attemptId: attId,
        type: 'attempt_started',
        payload: {
          taskId: task.id,
          attempt: {
            id: attId,
            taskId: task.id,
            attemptNumber: task.attempts.length + 1,
            executorParticipantId: executor.id,
            modelTierUsed: executor.modelTier,
            modelRefUsed: { ...executor.modelRef },
            rolesSnapshot: [...executor.roles],
            instructionsSnapshot: executor.instructions,
            contextRevisionId: latestCtx?.id ?? 'ctx_none',
            contextRevisionNumber: latestCtx?.versionNumber ?? 0,
            status: 'running',
            evidenceNotes: [],
            startedAt: now,
            sourceEventIds: [sStartEvt],
            originSource: 'aion_core',
          },
          participantStatus: 'running',
          projectToGeneral: false,
        },
      });
      proj = this.state.conversations[convId];
      if (!proj) return;
      const updatedTask = proj.tasks.find((t) => t.id === task.id);
      attempt = updatedTask?.attempts[updatedTask.attempts.length - 1];
    }

    if (!attempt) return;

    this.markWsTaskMutation(convId, task.id);
    this.emitAndIngest(convId, {
      id: `evt_core_del_${task.id}_${attempt.id}`,
      seq: this.nextLocalSeq(proj),
      conversationId: convId,
      timestamp: now,
      origin: 'executor',
      originSource: 'aion_core',
      participantId: executor.id,
      taskId: task.id,
      attemptId: attempt.id,
      type: 'attempt_delivered',
      payload: {
        taskId: task.id,
        attemptId: attempt.id,
        deliverySummary: report.deliverySummary,
        evidenceNotes: report.evidenceNotes,
        generalSummary: `${executor.displayName} entregou Tentativa #${attempt.attemptNumber} de "${task.title}" para auditoria.`,
      },
    });

    proj = this.state.conversations[convId];
    if (!proj) return;
    const latestCtx = getLatestContextRevision(proj);
    if (latestCtx && attempt.contextRevisionId === latestCtx.id) {
      this.emitAndIngest(convId, {
        id: `evt_core_rcpt_app_${latestCtx.id}_${executor.id}_${attempt.id}`,
        seq: this.nextLocalSeq(proj),
        conversationId: convId,
        timestamp: now,
        origin: 'executor',
        originSource: 'aion_core',
        participantId: executor.id,
        taskId: task.id,
        attemptId: attempt.id,
        type: 'context_receipt_updated',
        payload: {
          revisionId: latestCtx.id,
          versionNumber: latestCtx.versionNumber,
          participantId: executor.id,
          receipt: {
            participantId: executor.id,
            revisionId: latestCtx.id,
            status: 'applied',
            policyApplied: 'next_turn',
            updatedAt: now,
            mechanismNote: `Contexto v${latestCtx.versionNumber} correlacionado à entrega da Tentativa #${attempt.attemptNumber} (${executor.displayName}).`,
          },
          projectToGeneral: false,
        },
      });
    }

    const deliveredTaskId = task.id;
    const deliveredAttemptId = attempt.id;
    const summaryText = report.deliverySummary;
    const evidenceList = [...report.evidenceNotes];
    this.enqueueBackgroundWork(async () => {
      await this.dispatchReviewInCore(
        convId,
        deliveredTaskId,
        deliveredAttemptId,
        summaryText,
        evidenceList,
      );
    });
  }

  private applyStructuredReviewDecision(
    convId: string,
    reviewer: Participant,
    decisionPayload: {
      taskId: string;
      attemptId?: string;
      decision: 'approved' | 'rejected';
      rationale: string;
      unmetCriteria: string[];
    },
  ): void {
    if (!this.state) return;
    let proj = this.state.conversations[convId];
    if (!proj) return;
    const now = new Date().toISOString();

    const task =
      proj.tasks.find((t) => t.id === decisionPayload.taskId) ??
      proj.tasks.find((t) => t.status === 'awaiting_review');
    if (!task) return;

    const attempt =
      (decisionPayload.attemptId
        ? task.attempts.find((a) => a.id === decisionPayload.attemptId)
        : undefined) ?? task.attempts[task.attempts.length - 1];
    if (!attempt) return;

    const independence = checkAuditIndependence(
      proj.participants,
      task,
      reviewer.id,
    );
    const revEvtId = `evt_core_rev_${task.id}_${attempt.id}`;
    if (proj.seenEventIds.includes(revEvtId)) return;

    this.markWsTaskMutation(convId, task.id);
    this.emitAndIngest(convId, {
      id: revEvtId,
      seq: this.nextLocalSeq(proj),
      conversationId: convId,
      timestamp: now,
      origin: 'reviewer',
      originSource: 'aion_core',
      participantId: reviewer.id,
      taskId: task.id,
      attemptId: attempt.id,
      type: 'task_reviewed',
      payload: {
        review: {
          id: `rev_core_${task.id}_${attempt.id}`,
          taskId: task.id,
          attemptId: attempt.id,
          reviewerParticipantId: reviewer.id,
          decision: decisionPayload.decision,
          rationale: decisionPayload.rationale,
          unmetCriteria: decisionPayload.unmetCriteria,
          decidedAt: now,
          sourceEventId: revEvtId,
          independentReview: independence.independent,
        },
        nextTaskStatus:
          decisionPayload.decision === 'approved'
            ? 'completed'
            : 'changes_requested',
        generalSummary: `${reviewer.displayName} ${decisionPayload.decision === 'approved' ? 'aprovou' : 'solicitou correção em'} "${task.title}" (${independence.independent ? 'auditoria independente' : 'parecer combinado'}).`,
      },
    });

    proj = this.state.conversations[convId];
    if (!proj) return;
    const updatedTask = proj.tasks.find((t) => t.id === task.id);
    if (!updatedTask) return;

    if (decisionPayload.decision === 'rejected') {
      const policy = this.state.modelPolicy;
      const executor = proj.participants.find(
        (p) => p.id === updatedTask.assigneeParticipantId && !p.archived,
      );
      const alreadyEscalated = proj.escalations.some(
        (e) => e.taskId === updatedTask.id,
      );
      const currentTier: DemoModelTier =
        executor?.modelTier ?? policy.defaultExecutorTier;
      const targetTier = policy.escalationTargetTier;

      if (
        executor &&
        !alreadyEscalated &&
        updatedTask.qualityRejectionCount >=
          policy.qualityRejectionsBeforeSuggest &&
        currentTier !== targetTier
      ) {
        const escId = `esc_core_${updatedTask.id}_${updatedTask.qualityRejectionCount}`;
        const escEvtId = `evt_core_esc_${escId}`;
        const promotedRef: ModelRef =
          executor.modelRef.source === 'user_preference'
            ? {
                ...executor.modelRef,
                displayName: `${executor.modelRef.displayName} → ${PT_BR.modelTierLabels[targetTier]}`,
                tier: targetTier,
              }
            : makeDemoModelRef(targetTier);

        this.emitAndIngest(convId, {
          id: escEvtId,
          seq: this.nextLocalSeq(proj),
          conversationId: convId,
          timestamp: now,
          origin: 'system',
          originSource: 'aion_core',
          participantId: executor.id,
          taskId: updatedTask.id,
          attemptId: attempt.id,
          type: 'escalation_suggested',
          payload: {
            escalation: {
              id: escId,
              conversationId: convId,
              taskId: updatedTask.id,
              attemptId: attempt.id,
              participantId: executor.id,
              fromTier: currentTier,
              toTier: targetTier,
              fromModelRef: { ...executor.modelRef },
              toModelRef: promotedRef,
              reason: `Atingido o limite de ${policy.qualityRejectionsBeforeSuggest} reprovação(ões) de qualidade na tarefa "${updatedTask.title}".`,
              expectedEffect: `Promover ${executor.displayName} para ${PT_BR.modelTierLabels[targetTier]} na próxima tentativa.`,
              status: 'suggested',
              createdAt: now,
              sourceEventId: escEvtId,
            },
            generalSummary: `Escalonamento sugerido para ${executor.displayName} após ${updatedTask.qualityRejectionCount} reprovação(ões).`,
          },
        });

        proj = this.state.conversations[convId];
        if (policy.approvalMode === 'manual') {
          return;
        }
        if (proj) {
          this.emitAndIngest(convId, {
            id: `evt_core_esc_auto_${escId}`,
            seq: this.nextLocalSeq(proj),
            conversationId: convId,
            timestamp: now,
            origin: 'system',
            originSource: 'aion_core',
            participantId: executor.id,
            taskId: updatedTask.id,
            type: 'escalation_resolved',
            payload: {
              escalationId: escId,
              resolution: 'approved',
              participantId: executor.id,
              appliedTier: targetTier,
              appliedModelRef: promotedRef,
              generalSummary: `Escalonamento aplicado automaticamente pela política para ${executor.displayName}.`,
            },
          });
        }
      }

      this.enqueueBackgroundWork(async () => {
        await this.dispatchTaskAttemptInCore(convId, updatedTask.id);
      });
      return;
    }

    // Approved! Advance next runnable task or record coordinator completion
    this.enqueueBackgroundWork(async () => {
      await this.dispatchNextRunnableTaskInCore(convId);
    });
  }

  private async dispatchNextRunnableTaskInCore(convId: string): Promise<void> {
    if (!this.state) return;
    const proj = this.state.conversations[convId];
    if (!proj) return;
    if (proj.conversation.executionStatus === 'paused_queue') return;

    const unfinished = proj.tasks.filter(
      (t) => t.status !== 'completed' && t.status !== 'cancelled',
    );
    if (unfinished.length === 0) {
      if (proj.tasks.length > 0 && proj.conversation.executionStatus === 'completed') {
        const roles = resolveTeamRoles(
          proj.participants,
          proj.conversation.coordinatorParticipantId,
        );
        const coord = roles.coordinator;
        if (coord && !proj.generalFeed.some((g) => g.kind === 'completion')) {
          this.emitAndIngest(convId, {
            id: `evt_core_done_${convId}_${proj.tasks.length}`,
            seq: this.nextLocalSeq(proj),
            conversationId: convId,
            timestamp: new Date().toISOString(),
            origin: 'coordinator',
            originSource: 'aion_core',
            participantId: coord.id,
            type: 'agent_message_posted',
            payload: {
              messageId: `msg_core_done_${convId}_${proj.tasks.length}`,
              targetTab: 'general',
              authorLabel: coord.displayName,
              authorRoleLabel: PT_BR.roleLabels.coordinator,
              bodyMarkdown: `Fluxo concluído no AionCore sob coordenação de **${coord.displayName}**: todas as ${proj.tasks.length} tarefa(s) foram auditadas e aprovadas.`,
              projectToGeneral: true,
              generalKind: 'completion',
              generalSummary: `Coordenação encerrada: todas as ${proj.tasks.length} tarefa(s) aprovadas.`,
            },
          });
        }
      }
      return;
    }

    const nextTask = unfinished.find(
      (t) =>
        t.status !== 'running' &&
        t.status !== 'awaiting_review' &&
        t.status !== 'failed' &&
        t.status !== 'blocked' &&
        !t.attempts.some((a) => a.status === 'running') &&
        areTaskDependenciesSatisfied(t, proj.tasks).satisfied &&
        !proj.escalations.some(
          (e) => e.taskId === t.id && e.status === 'suggested',
        ),
    );
    if (!nextTask) return;

    await this.dispatchTaskAttemptInCore(convId, nextTask.id);
  }

  private async dispatchTaskAttemptInCore(
    convId: string,
    taskId: string,
  ): Promise<void> {
    if (!this.state) return;
    let proj = this.state.conversations[convId];
    if (!proj) return;
    const teamId = proj.conversation.externalTeamId;
    if (!teamId) return;
    const task = proj.tasks.find((t) => t.id === taskId);
    if (!task) return;
    if (task.attempts.some((a) => a.status === 'running')) return;

    const executor =
      proj.participants.find(
        (p) => p.id === task.assigneeParticipantId && !p.archived,
      ) ?? resolveTeamRoles(proj.participants).executor;
    if (!executor?.sessionRef.externalSlotId) return;

    const now = new Date().toISOString();
    if (task.status === 'planned') {
      this.emitAndIngest(convId, {
        id: `evt_core_q_${task.id}_${task.attempts.length + 1}`,
        seq: this.nextLocalSeq(proj),
        conversationId: convId,
        timestamp: now,
        origin: 'coordinator',
        originSource: 'aion_core',
        taskId: task.id,
        type: 'task_status_changed',
        payload: {
          taskId: task.id,
          nextStatus: 'queued',
          projectToGeneral: false,
        },
      });
      proj = this.state.conversations[convId];
      if (!proj) return;
    }

    const latestCtx = getLatestContextRevision(proj);
    const attemptNumber = task.attempts.length + 1;
    const attemptId = `att_core_${task.id}_${attemptNumber}`;
    const startEvtId = `evt_core_att_${task.id}_${attemptNumber}`;

    const attempt: TaskAttempt = {
      id: attemptId,
      taskId: task.id,
      attemptNumber,
      executorParticipantId: executor.id,
      modelTierUsed: executor.modelTier,
      modelRefUsed: { ...executor.modelRef },
      rolesSnapshot: [...executor.roles],
      instructionsSnapshot: executor.instructions,
      contextRevisionId: latestCtx?.id ?? 'ctx_none',
      contextRevisionNumber: latestCtx?.versionNumber ?? 0,
      status: 'running',
      evidenceNotes: [],
      startedAt: now,
      sourceEventIds: [startEvtId],
      originSource: 'aion_core',
    };

    this.emitAndIngest(convId, {
      id: startEvtId,
      seq: this.nextLocalSeq(proj),
      conversationId: convId,
      timestamp: now,
      origin: 'executor',
      originSource: 'aion_core',
      participantId: executor.id,
      taskId: task.id,
      attemptId,
      type: 'attempt_started',
      payload: {
        taskId: task.id,
        attempt,
        participantStatus: 'running',
        projectToGeneral: true,
        generalSummary: `${executor.displayName} iniciou Tentativa #${attemptNumber} de "${task.title}" no Core.`,
      },
    });

    proj = this.state.conversations[convId];
    if (!proj) return;
    const latestTask = proj.tasks.find((t) => t.id === task.id) ?? task;
    const content = this.composeCoreOutgoingContent({
      proj,
      targetParticipant: executor,
      userMarkdown: `Execute a tarefa "${latestTask.title}" (Tentativa #${attemptNumber}) e responda com \`\`\`aion-desk-json\`\`\` de delivery_report quando concluir.`,
      expectedKind: 'delivery_report',
      task: latestTask,
      attempt,
    });

    this.expectedKindByParticipant.set(
      `${convId}:${executor.id}`,
      'delivery_report',
    );
    const path = `/api/teams/${encodeURIComponent(teamId)}/agents/${encodeURIComponent(executor.sessionRef.externalSlotId)}/messages`;
    const body: SendAgentMessageRequest = { content };
    const rawAck = await this.httpClient.requestJson<unknown>({
      method: 'POST',
      path,
      body,
      idempotent: false,
      operationName: 'core.dispatchTaskAttempt',
      teamId,
      slotId: executor.sessionRef.externalSlotId,
    });
    const ack = unwrapApiResponse<TeamRunAckResponse>(
      rawAck,
      `POST ${path}`,
      (d): d is TeamRunAckResponse =>
        isRecord(d) &&
        typeof d.message_id === 'string' &&
        typeof d.enqueue_status === 'string',
    );

    if (latestCtx) {
      const latestProj = this.state.conversations[convId];
      if (latestProj) {
        this.emitAndIngest(convId, {
          id: `evt_core_rcpt_sent_${latestCtx.id}_${executor.id}_${ack.message_id}`,
          seq: this.nextLocalSeq(latestProj),
          conversationId: convId,
          timestamp: new Date().toISOString(),
          origin: 'gateway',
          originSource: 'aion_core',
          participantId: executor.id,
          taskId: latestTask.id,
          attemptId,
          type: 'context_receipt_updated',
          payload: {
            revisionId: latestCtx.id,
            versionNumber: latestCtx.versionNumber,
            participantId: executor.id,
            receipt: {
              participantId: executor.id,
              revisionId: latestCtx.id,
              status: 'sent',
              policyApplied: 'next_turn',
              updatedAt: new Date().toISOString(),
              mechanismNote: `Contexto v${latestCtx.versionNumber} enviado na Tentativa #${attemptNumber} (msg ${ack.message_id}); aguardando confirmação.`,
            },
            projectToGeneral: false,
          },
        });
      }
    }
  }

  private async dispatchReviewInCore(
    convId: string,
    taskId: string,
    attemptId: string,
    deliverySummary: string,
    evidenceNotes: string[],
  ): Promise<void> {
    if (!this.state) return;
    const proj = this.state.conversations[convId];
    if (!proj) return;
    const teamId = proj.conversation.externalTeamId;
    if (!teamId) return;
    const task = proj.tasks.find((t) => t.id === taskId);
    if (!task) return;
    const attempt = task.attempts.find((a) => a.id === attemptId);
    const roles = resolveTeamRoles(
      proj.participants,
      proj.conversation.coordinatorParticipantId,
    );
    const reviewer =
      (task.reviewerParticipantId
        ? proj.participants.find(
            (p) => p.id === task.reviewerParticipantId && !p.archived,
          )
        : undefined) ??
      roles.reviewer ??
      roles.coordinator;
    if (!reviewer?.sessionRef.externalSlotId) return;

    const content = this.composeCoreOutgoingContent({
      proj,
      targetParticipant: reviewer,
      userMarkdown: `Audite a entrega da tarefa "${task.title}" (${attempt ? `Tentativa #${attempt.attemptNumber}` : attemptId}).\nResumo da entrega: ${deliverySummary}\nEvidências:\n${evidenceNotes.map((n) => `- ${n}`).join('\n')}\n\nResponda com \`\`\`aion-desk-json\`\`\` de review_decision.`,
      expectedKind: 'review_decision',
      task,
      attempt,
    });

    this.expectedKindByParticipant.set(
      `${convId}:${reviewer.id}`,
      'review_decision',
    );
    const path = `/api/teams/${encodeURIComponent(teamId)}/agents/${encodeURIComponent(reviewer.sessionRef.externalSlotId)}/messages`;
    const body: SendAgentMessageRequest = { content };
    const rawAck = await this.httpClient.requestJson<unknown>({
      method: 'POST',
      path,
      body,
      idempotent: false,
      operationName: 'core.dispatchReview',
      teamId,
      slotId: reviewer.sessionRef.externalSlotId,
    });
    unwrapApiResponse<TeamRunAckResponse>(
      rawAck,
      `POST ${path}`,
      (d): d is TeamRunAckResponse =>
        isRecord(d) &&
        typeof d.message_id === 'string' &&
        typeof d.enqueue_status === 'string',
    );

    const latestProj = this.state.conversations[convId];
    const latestCtx = latestProj ? getLatestContextRevision(latestProj) : undefined;
    if (latestProj && latestCtx) {
      this.emitAndIngest(convId, {
        id: `evt_core_rcpt_rev_sent_${latestCtx.id}_${reviewer.id}_${attemptId}`,
        seq: this.nextLocalSeq(latestProj),
        conversationId: convId,
        timestamp: new Date().toISOString(),
        origin: 'gateway',
        originSource: 'aion_core',
        participantId: reviewer.id,
        taskId: task.id,
        attemptId,
        type: 'context_receipt_updated',
        payload: {
          revisionId: latestCtx.id,
          versionNumber: latestCtx.versionNumber,
          participantId: reviewer.id,
          receipt: {
            participantId: reviewer.id,
            revisionId: latestCtx.id,
            status: 'sent',
            policyApplied: 'next_turn',
            updatedAt: new Date().toISOString(),
            mechanismNote: `Contexto v${latestCtx.versionNumber} enviado ao auditor ${reviewer.displayName} para revisão.`,
          },
          projectToGeneral: false,
        },
      });
    }
  }

  // ---------------------------------------------------------------------------
  // WorkspaceGateway operations (Core mode: real HTTP/WS + Desk metadata)
  // ---------------------------------------------------------------------------

  async createProject(input: {
    name: string;
    description: string;
    workspacePathInfo: string;
  }): Promise<Project> {
    const state = this.getStateSnapshot();
    const trimmed = input.name.trim();
    if (!trimmed) {
      throw new GatewayCapabilityError(
        'VALIDATION_ERROR',
        'Informe um nome para o projeto.',
      );
    }
    const now = new Date().toISOString();
    const project: Project = {
      id: this.nextId('proj'),
      name: trimmed,
      description: input.description.trim(),
      workspacePathInfo: input.workspacePathInfo.trim(),
      executionMode: 'aion_core',
      status: 'active',
      createdAt: now,
      updatedAt: now,
    };
    this.state = {
      ...state,
      projects: [...state.projects, project],
      activeProjectId: project.id,
    };
    this.notifyState();
    return project;
  }

  async renameProject(projectId: string, name: string): Promise<void> {
    const state = this.getStateSnapshot();
    const trimmed = name.trim();
    if (!trimmed) {
      throw new GatewayCapabilityError(
        'VALIDATION_ERROR',
        'Nome do projeto não pode ser vazio.',
      );
    }
    this.state = {
      ...state,
      projects: state.projects.map((p) =>
        p.id === projectId
          ? { ...p, name: trimmed, updatedAt: new Date().toISOString() }
          : p,
      ),
    };
    this.notifyState();
  }

  async setProjectArchived(projectId: string, archived: boolean): Promise<void> {
    const state = this.getStateSnapshot();
    const nextProjects = state.projects.map((p) =>
      p.id === projectId
        ? {
            ...p,
            status: archived ? ('archived' as const) : ('active' as const),
            updatedAt: new Date().toISOString(),
          }
        : p,
    );
    this.state = {
      ...state,
      projects: nextProjects,
    };
    this.notifyState();
  }

  async createConversation(input: {
    projectId: string;
    title: string;
    presetId?: string;
    customMembers?: TeamPresetMember[];
  }): Promise<ConversationProjection> {
    const state = this.getStateSnapshot();
    const trimmed = input.title.trim();
    if (!trimmed) {
      throw new GatewayCapabilityError(
        'VALIDATION_ERROR',
        'Informe um título para a conversa.',
      );
    }
    const preset =
      state.teamPresets.find((pr) => pr.id === input.presetId) ??
      state.teamPresets.find((pr) => pr.id === 'preset_terra_sol_gemini') ??
      DEFAULT_TEAM_PRESETS[0];
    const effectivePreset: TeamPreset = input.customMembers?.length
      ? { ...preset, members: input.customMembers }
      : preset;

    const convId = this.nextId('conv');
    const now = new Date().toISOString();
    const participants = instantiateParticipantsFromPreset({
      preset: effectivePreset,
      conversationId: convId,
      idGenerator: (prefix) => this.nextId(prefix),
      isSimulated: false,
      createdAt: now,
    });
    const resolved = resolveTeamRoles(participants);
    const coordinatorId =
      resolved.coordinator?.id ?? participants[0]?.id ?? '';

    const projection = createEmptyProjection(
      {
        id: convId,
        projectId: input.projectId,
        title: trimmed,
        executionMode: 'aion_core',
        teamPresetId: effectivePreset.id,
        status: 'active',
        executionStatus: 'idle',
        coordinatorParticipantId: coordinatorId,
        syncState: 'synced',
        lastAppliedSeq: 0,
        scenarioStepIndex: 0,
        createdAt: now,
        updatedAt: now,
      },
      participants,
    );

    this.state = {
      ...state,
      conversations: { ...state.conversations, [convId]: projection },
      activeProjectId: input.projectId,
      activeConversationId: convId,
    };
    this.activeTabByConversation[convId] = 'general';
    this.notifyState();
    return projection;
  }

  async renameConversation(conversationId: string, title: string): Promise<void> {
    const state = this.getStateSnapshot();
    const proj = state.conversations[conversationId];
    if (!proj) return;
    const trimmed = title.trim();
    if (!trimmed) {
      throw new GatewayCapabilityError(
        'VALIDATION_ERROR',
        'Título da conversa não pode ser vazio.',
      );
    }
    this.state = {
      ...state,
      conversations: {
        ...state.conversations,
        [conversationId]: {
          ...proj,
          conversation: {
            ...proj.conversation,
            title: trimmed,
            updatedAt: new Date().toISOString(),
          },
        },
      },
    };
    this.notifyState();
  }

  async setConversationArchived(
    conversationId: string,
    archived: boolean,
  ): Promise<void> {
    const state = this.getStateSnapshot();
    const proj = state.conversations[conversationId];
    if (!proj) return;
    this.state = {
      ...state,
      conversations: {
        ...state.conversations,
        [conversationId]: {
          ...proj,
          conversation: {
            ...proj.conversation,
            status: archived ? 'archived' : 'active',
            updatedAt: new Date().toISOString(),
          },
        },
      },
    };
    this.notifyState();
  }

  async saveParticipantProfile(
    profile: Omit<ParticipantProfile, 'id'> & { id?: string },
  ): Promise<ParticipantProfile> {
    const state = this.getStateSnapshot();
    const saved: ParticipantProfile = {
      ...profile,
      id: profile.id ?? this.nextId('prof'),
      defaultRoles:
        profile.defaultRoles.length > 0 ? profile.defaultRoles : ['executor'],
    };
    const exists = state.participantProfiles.some((p) => p.id === saved.id);
    this.state = {
      ...state,
      participantProfiles: exists
        ? state.participantProfiles.map((p) => (p.id === saved.id ? saved : p))
        : [...state.participantProfiles, saved],
    };
    this.notifyState();
    return saved;
  }

  async archiveParticipantProfile(
    profileId: string,
    archived: boolean,
  ): Promise<void> {
    const state = this.getStateSnapshot();
    this.state = {
      ...state,
      participantProfiles: state.participantProfiles.map((p) =>
        p.id === profileId ? { ...p, archived } : p,
      ),
    };
    this.notifyState();
  }

  async saveTeamPreset(
    preset: Omit<TeamPreset, 'id'> & { id?: string },
  ): Promise<TeamPreset> {
    const state = this.getStateSnapshot();
    const saved: TeamPreset = {
      ...preset,
      id: preset.id ?? this.nextId('preset'),
    };
    const exists = state.teamPresets.some((p) => p.id === saved.id);
    this.state = {
      ...state,
      teamPresets: exists
        ? state.teamPresets.map((p) => (p.id === saved.id ? saved : p))
        : [...state.teamPresets, saved],
    };
    this.notifyState();
    return saved;
  }

  async applyTeamPreset(conversationId: string, presetId: string): Promise<void> {
    const state = this.getStateSnapshot();
    const proj = state.conversations[conversationId];
    const preset = state.teamPresets.find((p) => p.id === presetId);
    if (!proj || !preset) {
      throw new GatewayCapabilityError(
        'VALIDATION_ERROR',
        'Conversa ou preset inválido.',
      );
    }
    if (proj.conversation.externalTeamId) {
      throw new GatewayCapabilityError(
        'CAPABILITY_UNSUPPORTED',
        'Esta conversa já possui equipe criada no Core. Crie uma nova conversa para aplicar outro preset.',
      );
    }
    const nextParticipants = instantiateParticipantsFromPreset({
      preset,
      conversationId,
      idGenerator: (prefix) => this.nextId(prefix),
      isSimulated: false,
    });
    const resolved = resolveTeamRoles(nextParticipants);
    const messagesByTab = { ...proj.messagesByTab };
    for (const p of nextParticipants) {
      if (!messagesByTab[p.id]) messagesByTab[p.id] = [];
    }
    this.state = {
      ...state,
      conversations: {
        ...state.conversations,
        [conversationId]: {
          ...proj,
          participants: nextParticipants,
          messagesByTab,
          conversation: {
            ...proj.conversation,
            teamPresetId: preset.id,
            coordinatorParticipantId:
              resolved.coordinator?.id ?? nextParticipants[0]?.id ?? '',
            updatedAt: new Date().toISOString(),
          },
        },
      },
    };
    this.notifyState();
  }

  async addParticipantToConversation(
    conversationId: string,
    member: TeamPresetMember,
  ): Promise<Participant> {
    const state = this.getStateSnapshot();
    const proj = state.conversations[conversationId];
    if (!proj) {
      throw new GatewayCapabilityError(
        'CONVERSATION_NOT_FOUND',
        'Conversa não encontrada.',
      );
    }
    const now = new Date().toISOString();
    const participantId = this.nextId('part');
    const roles: ParticipantRole[] =
      member.roles.length > 0 ? [...member.roles] : ['executor'];
    const participant: Participant = {
      id: participantId,
      conversationId,
      profileId: member.profileId,
      connectionId: member.connectionId,
      agentProfileId: member.connectionId,
      displayName: member.displayName,
      role: getPrimaryRole(roles),
      roles,
      modelRef: { ...member.modelRef },
      modelTier: member.modelRef.tier ?? 'fast',
      instructions: member.instructions,
      sessionRef: {
        id: this.nextId('sess'),
        conversationId,
        participantId,
        connectionId: member.connectionId,
        status: 'inactive',
        createdAt: now,
      },
      status: 'idle',
      unreadCount: 0,
      tabOrder: proj.participants.length,
      isSimulated: false,
    };
    this.emitAndIngest(conversationId, {
      id: this.nextId('evt'),
      seq: this.nextLocalSeq(proj),
      conversationId,
      timestamp: now,
      origin: 'user',
      originSource: 'aion_desk_local',
      participantId: participant.id,
      type: 'participant_added',
      payload: { participant },
    });
    return participant;
  }

  async removeParticipantFromConversation(
    conversationId: string,
    participantId: string,
    reason?: string,
  ): Promise<void> {
    const state = this.getStateSnapshot();
    const proj = state.conversations[conversationId];
    if (!proj) return;
    if (proj.conversation.coordinatorParticipantId === participantId) {
      throw new GatewayCapabilityError(
        'VALIDATION_ERROR',
        'Defina outro coordenador antes de arquivar o coordenador atual.',
      );
    }
    this.emitAndIngest(conversationId, {
      id: this.nextId('evt'),
      seq: this.nextLocalSeq(proj),
      conversationId,
      timestamp: new Date().toISOString(),
      origin: 'user',
      originSource: 'aion_desk_local',
      participantId,
      type: 'participant_removed',
      payload: {
        participantId,
        reason: reason ?? 'Participante arquivado na configuração local.',
      },
    });
  }

  async reorderParticipantTabs(
    conversationId: string,
    orderedParticipantIds: string[],
  ): Promise<void> {
    const state = this.getStateSnapshot();
    const proj = state.conversations[conversationId];
    if (!proj) return;
    this.emitAndIngest(conversationId, {
      id: this.nextId('evt'),
      seq: this.nextLocalSeq(proj),
      conversationId,
      timestamp: new Date().toISOString(),
      origin: 'user',
      originSource: 'aion_desk_local',
      type: 'participant_tabs_reordered',
      payload: { orderedParticipantIds },
    });
  }

  async configureParticipant(input: ConfigureParticipantInput): Promise<void> {
    const state = this.getStateSnapshot();
    const proj = state.conversations[input.conversationId];
    if (!proj) return;
    const target = proj.participants.find((p) => p.id === input.participantId);
    if (!target) return;
    const now = new Date().toISOString();
    let nextProj = proj;

    if (
      (input.roles?.includes('coordinator') || input.role === 'coordinator') &&
      proj.conversation.coordinatorParticipantId !== target.id
    ) {
      const evtCoord: ExecutionEvent = {
        id: this.nextId('evt'),
        seq: this.nextLocalSeq(nextProj),
        conversationId: input.conversationId,
        timestamp: now,
        origin: 'user',
        originSource: 'aion_desk_local',
        participantId: target.id,
        type: 'coordinator_changed',
        payload: {
          assignmentId: this.nextId('coord'),
          previousParticipantId: proj.conversation.coordinatorParticipantId,
          nextParticipantId: target.id,
          reason: input.reason ?? 'Alterado manualmente no Aion Desk.',
        },
      };
      this.emitAndIngest(input.conversationId, evtCoord);
      nextProj = this.getStateSnapshot().conversations[input.conversationId];
    }

    const changeRecord: ConfigChangeRecord = {
      id: this.nextId('cfg'),
      conversationId: input.conversationId,
      participantId: target.id,
      changeKind: input.modelRef
        ? 'model'
        : input.roles
          ? 'roles'
          : input.connectionId
            ? 'connection'
            : 'instructions',
      previousSummary: `${target.displayName} (${target.modelRef.displayName})`,
      nextSummary: `${input.displayName ?? target.displayName} (${input.modelRef?.displayName ?? target.modelRef.displayName})`,
      reason: input.reason ?? 'Configuração local do participante atualizada.',
      appliesToNextAttemptOnly: true,
      decidedAt: now,
      sourceEventId: this.nextId('evt_ref'),
    };

    this.emitAndIngest(input.conversationId, {
      id: this.nextId('evt'),
      seq: this.nextLocalSeq(nextProj),
      conversationId: input.conversationId,
      timestamp: now,
      origin: 'user',
      originSource: 'aion_desk_local',
      participantId: target.id,
      type: 'participant_configured',
      payload: {
        changeRecord,
        displayName: input.displayName,
        roles: input.roles,
        modelRef: input.modelRef,
        modelTier: input.modelTier,
        instructions: input.instructions,
        connectionId: input.connectionId,
      },
    });
  }

  async createTask(input: {
    conversationId: string;
    title: string;
    description: string;
    assigneeParticipantId: string;
    reviewerParticipantId?: string;
    dependencyTaskIds: string[];
    acceptanceCriteria: string[];
  }): Promise<Task> {
    const state = this.getStateSnapshot();
    const proj = state.conversations[input.conversationId];
    if (!proj) {
      throw new GatewayCapabilityError(
        'CONVERSATION_NOT_FOUND',
        'Conversa não encontrada.',
      );
    }
    const taskId = this.nextId('task');
    const validation = validateTaskInput({
      taskId,
      title: input.title,
      assigneeParticipantId: input.assigneeParticipantId,
      reviewerParticipantId: input.reviewerParticipantId,
      dependencyTaskIds: input.dependencyTaskIds,
      acceptanceCriteria: input.acceptanceCriteria,
      existingTasks: proj.tasks,
      participants: proj.participants,
    });
    if (!validation.valid) {
      throw new GatewayCapabilityError(
        'VALIDATION_ERROR',
        validation.errors.join(' '),
      );
    }
    const latestCtx = getLatestContextRevision(proj);
    const task: Task = {
      id: taskId,
      conversationId: input.conversationId,
      sourceRequestEventId: this.nextId('req'),
      title: input.title.trim(),
      description: input.description.trim(),
      assigneeParticipantId: input.assigneeParticipantId,
      reviewerParticipantId: input.reviewerParticipantId,
      dependencyTaskIds: [...input.dependencyTaskIds],
      acceptanceCriteria: [...input.acceptanceCriteria],
      status: 'planned',
      attempts: [],
      reviews: [],
      operationalFailureCount: 0,
      qualityRejectionCount: 0,
      activeContextRevisionId: latestCtx?.id,
      originSource: 'aion_desk_local',
    };
    this.emitAndIngest(input.conversationId, {
      id: this.nextId('evt'),
      seq: this.nextLocalSeq(proj),
      conversationId: input.conversationId,
      timestamp: new Date().toISOString(),
      origin: 'user',
      originSource: 'aion_desk_local',
      taskId: task.id,
      type: 'task_created',
      payload: {
        task,
        generalSummary: `Tarefa "${task.title}" criada localmente no Aion Desk.`,
      },
    });
    return task;
  }

  async updateTask(input: {
    conversationId: string;
    taskId: string;
    title: string;
    description: string;
    assigneeParticipantId: string;
    reviewerParticipantId?: string;
    dependencyTaskIds: string[];
    acceptanceCriteria: string[];
  }): Promise<void> {
    const state = this.getStateSnapshot();
    const proj = state.conversations[input.conversationId];
    if (!proj) return;
    const validation = validateTaskInput({
      taskId: input.taskId,
      title: input.title,
      assigneeParticipantId: input.assigneeParticipantId,
      reviewerParticipantId: input.reviewerParticipantId,
      dependencyTaskIds: input.dependencyTaskIds,
      acceptanceCriteria: input.acceptanceCriteria,
      existingTasks: proj.tasks,
      participants: proj.participants,
    });
    if (!validation.valid) {
      throw new GatewayCapabilityError(
        'VALIDATION_ERROR',
        validation.errors.join(' '),
      );
    }
    this.emitAndIngest(input.conversationId, {
      id: this.nextId('evt'),
      seq: this.nextLocalSeq(proj),
      conversationId: input.conversationId,
      timestamp: new Date().toISOString(),
      origin: 'user',
      originSource: 'aion_desk_local',
      taskId: input.taskId,
      type: 'task_updated',
      payload: {
        taskId: input.taskId,
        patch: {
          title: input.title.trim(),
          description: input.description.trim(),
          assigneeParticipantId: input.assigneeParticipantId,
          reviewerParticipantId: input.reviewerParticipantId,
          dependencyTaskIds: [...input.dependencyTaskIds],
          acceptanceCriteria: [...input.acceptanceCriteria],
        },
        generalSummary: `Tarefa "${input.title.trim()}" atualizada localmente.`,
      },
    });
  }

  async publishPlanRevision(input: {
    conversationId: string;
    summary: string;
    authorLabel?: string;
  }): Promise<PlanRevision> {
    const state = this.getStateSnapshot();
    const proj = state.conversations[input.conversationId];
    if (!proj) {
      throw new GatewayCapabilityError(
        'CONVERSATION_NOT_FOUND',
        'Conversa não encontrada.',
      );
    }
    const versionNumber = proj.planRevisions.length + 1;
    const evtId = this.nextId('evt');
    const planRevision: PlanRevision = {
      id: this.nextId('plan'),
      conversationId: input.conversationId,
      versionNumber,
      authorLabel: input.authorLabel ?? 'Usuário',
      createdAt: new Date().toISOString(),
      summary: input.summary.trim(),
      taskIds: proj.tasks.map((t) => t.id),
      sourceEventId: evtId,
      originSource: 'aion_desk_local',
    };
    this.emitAndIngest(input.conversationId, {
      id: evtId,
      seq: this.nextLocalSeq(proj),
      conversationId: input.conversationId,
      timestamp: planRevision.createdAt,
      origin: 'user',
      originSource: 'aion_desk_local',
      type: 'plan_revision_published',
      payload: {
        planRevision,
        generalSummary: `Revisão de plano #${versionNumber} registrada localmente: ${planRevision.summary}`,
      },
    });
    return planRevision;
  }

  async updateModelPolicy(policy: ModelPolicy): Promise<void> {
    const state = this.getStateSnapshot();
    this.state = {
      ...state,
      modelPolicy: { ...policy },
    };
    this.notifyState();
  }

  async sendMessage(input: SendMessageInput): Promise<void> {
    let state = this.getStateSnapshot();
    let proj = state.conversations[input.conversationId];
    if (!proj) {
      throw new GatewayCapabilityError(
        'CONVERSATION_NOT_FOUND',
        'Conversa não encontrada.',
      );
    }
    const teamId = proj.conversation.externalTeamId;
    if (!teamId) {
      throw new GatewayCapabilityError(
        'NOT_CONNECTED_LOCAL_CORE',
        'Esta conversa ainda não tem equipe criada no AionCore. Crie ou sincronize a equipe em Configurações antes de enviar.',
        true,
      );
    }

    const isGeneral = input.targetTab === 'general';
    const targetParticipant = isGeneral
      ? proj.participants.find(
          (p) => p.id === proj.conversation.coordinatorParticipantId,
        ) ?? proj.participants[0]
      : proj.participants.find((p) => p.id === input.targetTab);

    if (!targetParticipant) {
      throw new GatewayCapabilityError(
        'VALIDATION_ERROR',
        'Participante destinatário não encontrado.',
      );
    }

    // If user asked to promote this orientation to SharedContext, publish BEFORE building Core message
    if (isGeneral && input.promoteToSharedContext) {
      const latestRev = getLatestContextRevision(proj);
      await this.publishContextRevision({
        conversationId: input.conversationId,
        authorLabel: 'Você',
        summaryOfChange: 'Nova orientação promovida ao Contexto Compartilhado.',
        objective: latestRev?.objective ?? proj.conversation.title,
        permanentInstructions: latestRev?.permanentInstructions ?? [],
        constraints: latestRev
          ? [...latestRev.constraints, input.bodyMarkdown.trim()]
          : [input.bodyMarkdown.trim()],
        acceptanceCriteria: latestRev?.acceptanceCriteria ?? [],
        confirmedDecisions: latestRev?.confirmedDecisions ?? [],
      });
      state = this.getStateSnapshot();
      proj = state.conversations[input.conversationId]!;
    }

    let path = `/api/teams/${encodeURIComponent(teamId)}/messages`;
    if (!isGeneral) {
      const slotId = targetParticipant.sessionRef.externalSlotId;
      if (!slotId) {
        throw new GatewayCapabilityError(
          'VALIDATION_ERROR',
          `Participante "${targetParticipant.displayName}" ainda não está mapeado a um slot_id no Core.`,
        );
      }
      path = `/api/teams/${encodeURIComponent(teamId)}/agents/${encodeURIComponent(slotId)}/messages`;
    }

    const runningTask = proj.tasks.find((t) =>
      t.attempts.some(
        (a) =>
          a.executorParticipantId === targetParticipant.id &&
          a.status === 'running',
      ),
    );
    const awaitingReviewTask = hasRole(targetParticipant, 'reviewer')
      ? proj.tasks.find((t) => t.status === 'awaiting_review')
      : undefined;

    let expectedKind: StructuredEnvelopeKind | undefined;
    if (
      proj.tasks.length === 0 &&
      (hasRole(targetParticipant, 'planner') ||
        hasRole(targetParticipant, 'coordinator'))
    ) {
      expectedKind = 'plan_proposal';
    } else if (runningTask) {
      expectedKind = 'delivery_report';
    } else if (awaitingReviewTask) {
      expectedKind = 'review_decision';
    }

    const activeTask = runningTask ?? awaitingReviewTask;
    const activeAttempt = activeTask
      ? activeTask.attempts.find((a) => a.status === 'running') ??
        activeTask.attempts[activeTask.attempts.length - 1]
      : undefined;

    const composedContent = this.composeCoreOutgoingContent({
      proj,
      targetParticipant,
      userMarkdown: input.bodyMarkdown,
      expectedKind,
      task: activeTask,
      attempt: activeAttempt,
    });

    if (expectedKind) {
      this.expectedKindByParticipant.set(
        `${input.conversationId}:${targetParticipant.id}`,
        expectedKind,
      );
    }

    const body: SendTeamMessageRequest | SendAgentMessageRequest = {
      content: composedContent,
    };

    const rawAck = await this.httpClient.requestJson<unknown>({
      method: 'POST',
      path,
      body,
      idempotent: false,
      operationName: isGeneral ? 'core.sendTeamMessage' : 'core.sendAgentMessage',
      teamId,
      slotId: targetParticipant.sessionRef.externalSlotId,
    });

    const ack = unwrapApiResponse<TeamRunAckResponse>(
      rawAck,
      `POST ${path}`,
      (d): d is TeamRunAckResponse =>
        typeof d === 'object' &&
        d !== null &&
        typeof (d as TeamRunAckResponse).message_id === 'string' &&
        typeof (d as TeamRunAckResponse).enqueue_status === 'string',
    );

    const now = new Date().toISOString();
    const latestProj = this.getStateSnapshot().conversations[input.conversationId] ?? proj;
    const seq = this.nextLocalSeq(latestProj);
    // ACK proves enqueue/acceptance only — never completion! Original user text preserved.
    this.emitAndIngest(input.conversationId, {
      id: this.nextId('evt'),
      seq,
      conversationId: input.conversationId,
      timestamp: now,
      origin: 'user',
      originSource: 'user',
      externalEventName: 'http.team_message.ack',
      correlationId: ack.run?.team_run_id,
      participantId: targetParticipant.id,
      type: 'user_message_sent',
      payload: {
        messageId: ack.message_id,
        targetTab: input.targetTab,
        targetParticipantId: targetParticipant.id,
        bodyMarkdown: input.bodyMarkdown,
        deliveryStatus: 'enqueued_core',
        externalMessageId: ack.message_id,
        deliveryNote: `Enfileirado no AionCore (${ack.enqueue_status}, run ${ack.run?.team_run_id ?? 'pendente'}). Aguardando resposta via WebSocket.`,
        generalSummary: isGeneral
          ? `Mensagem enviada ao líder (${targetParticipant.displayName}) — enfileirada no Core.`
          : `Mensagem direta enviada para ${targetParticipant.displayName} — enfileirada no Core.`,
      },
    });

    const postSendProj = this.getStateSnapshot().conversations[input.conversationId];
    const latestCtx = postSendProj ? getLatestContextRevision(postSendProj) : undefined;
    if (postSendProj && latestCtx) {
      const currentRcpt = latestCtx.receipts[targetParticipant.id];
      if (!currentRcpt || currentRcpt.status === 'pending_send') {
        this.emitAndIngest(input.conversationId, {
          id: `evt_core_rcpt_send_${latestCtx.id}_${targetParticipant.id}_${ack.message_id}`,
          seq: this.nextLocalSeq(postSendProj),
          conversationId: input.conversationId,
          timestamp: now,
          origin: 'gateway',
          originSource: 'aion_core',
          participantId: targetParticipant.id,
          type: 'context_receipt_updated',
          payload: {
            revisionId: latestCtx.id,
            versionNumber: latestCtx.versionNumber,
            participantId: targetParticipant.id,
            receipt: {
              participantId: targetParticipant.id,
              revisionId: latestCtx.id,
              status: 'sent',
              policyApplied: 'next_turn',
              updatedAt: now,
              mechanismNote: `Contexto v${latestCtx.versionNumber} incluído e enfileirado na mensagem ${ack.message_id} para ${targetParticipant.displayName} (não comprova aplicação imediata).`,
            },
            projectToGeneral: false,
          },
        });
      }
    }
  }

  async getPaginatedEvents(
    conversationId: string,
    tabId: string,
    limit: number,
    beforeIndex?: number,
  ): Promise<{ total: number; hasMore: boolean }> {
    const state = this.getStateSnapshot();
    const proj = state.conversations[conversationId];
    if (!proj) return { total: 0, hasMore: false };
    const total =
      tabId === 'general'
        ? proj.generalFeed.length
        : (proj.messagesByTab[tabId]?.length ?? 0);
    const end = beforeIndex ?? total;
    return {
      total,
      hasMore: Math.max(0, end - limit) > 0,
    };
  }

  async controlExecution(input: {
    conversationId: string;
    action:
      | 'pause_queue'
      | 'resume_queue'
      | 'request_interrupt'
      | 'terminate_session';
    participantId?: string;
  }): Promise<void> {
    const state = this.getStateSnapshot();
    const proj = state.conversations[input.conversationId];
    if (!proj) return;
    const teamId = proj.conversation.externalTeamId;

    if (input.action === 'request_interrupt' && teamId) {
      const target = proj.participants.find((p) => p.id === input.participantId);
      const runStateRaw = await this.httpClient.requestJson<unknown>({
        method: 'GET',
        path: `/api/teams/${encodeURIComponent(teamId)}/run-state`,
        idempotent: true,
        operationName: 'core.runState',
        teamId,
      });
      const runState = unwrapApiResponse<TeamRunStateResponse>(
        runStateRaw,
        'GET /api/teams/{id}/run-state',
        (d): d is TeamRunStateResponse =>
          typeof d === 'object' && d !== null && Array.isArray((d as TeamRunStateResponse).slot_work),
      );
      const activeRunId = runState.active_run?.team_run_id;
      const slotId = target?.sessionRef.externalSlotId;
      if (activeRunId && slotId) {
        await this.httpClient.requestJson({
          method: 'POST',
          path: `/api/teams/${encodeURIComponent(teamId)}/runs/${encodeURIComponent(activeRunId)}/agents/${encodeURIComponent(slotId)}/cancel`,
          body: { reason: 'Interrupção solicitada pelo usuário no Aion Desk' },
          idempotent: false,
          operationName: 'core.cancelChildTurn',
          teamId,
          slotId,
        });
        this.emitAndIngest(input.conversationId, {
          id: this.nextId('evt'),
          seq: this.nextLocalSeq(proj),
          conversationId: input.conversationId,
          timestamp: new Date().toISOString(),
          origin: 'user',
          originSource: 'aion_core',
          participantId: target?.id,
          type: 'execution_control_applied',
          payload: {
            control: 'request_interrupt',
            participantId: target?.id,
            generalSummary: `Cancelamento do turno solicitado ao AionCore para ${target?.displayName ?? slotId}.`,
          },
        });
        return;
      }
    }

    throw new GatewayCapabilityError(
      'CAPABILITY_UNSUPPORTED',
      `Ação "${input.action}" ainda requer validação local contra o estado ativo no AionCore v0.2.2.`,
      true,
    );
  }

  async respondPermission(): Promise<void> {
    throw new GatewayCapabilityError(
      'NOT_IMPLEMENTED_IN_PREVIEW',
      'Decisões remotas de permissão no modo AionCore dependem da validação local dos eventos de permissão MCP/hook.',
      true,
    );
  }

  async resolveEscalation(input: {
    conversationId: string;
    escalationId: string;
    resolution: 'approved' | 'dismissed';
  }): Promise<void> {
    const state = this.getStateSnapshot();
    const proj = state.conversations[input.conversationId];
    if (!proj) return;
    const esc = proj.escalations.find((e) => e.id === input.escalationId);
    if (!esc) return;
    this.emitAndIngest(input.conversationId, {
      id: this.nextId('evt'),
      seq: this.nextLocalSeq(proj),
      conversationId: input.conversationId,
      timestamp: new Date().toISOString(),
      origin: 'user',
      originSource: 'aion_desk_local',
      participantId: esc.participantId,
      taskId: esc.taskId,
      type: 'escalation_resolved',
      payload: {
        escalationId: esc.id,
        resolution: input.resolution,
        participantId: esc.participantId,
        appliedTier: input.resolution === 'approved' ? esc.toTier : esc.fromTier,
        appliedModelRef:
          input.resolution === 'approved' ? esc.toModelRef : esc.fromModelRef,
        generalSummary:
          input.resolution === 'approved'
            ? 'Escalonamento aprovado localmente no Aion Desk.'
            : 'Escalonamento dispensado pelo usuário.',
      },
    });

    const latestProj = this.getStateSnapshot().conversations[input.conversationId];
    const pendingCorrectionTask = latestProj?.tasks.find(
      (t) => t.id === esc.taskId && t.status === 'changes_requested',
    );
    if (latestProj?.conversation.externalTeamId && pendingCorrectionTask) {
      await this.dispatchTaskAttemptInCore(
        input.conversationId,
        pendingCorrectionTask.id,
      );
    }
  }

  async registerTaskReview(input: {
    conversationId: string;
    review: Omit<TaskReview, 'id' | 'decidedAt' | 'sourceEventId'>;
  }): Promise<void> {
    const state = this.getStateSnapshot();
    const proj = state.conversations[input.conversationId];
    if (!proj) return;
    const now = new Date().toISOString();
    const evtId = this.nextId('evt');
    this.emitAndIngest(input.conversationId, {
      id: evtId,
      seq: this.nextLocalSeq(proj),
      conversationId: input.conversationId,
      timestamp: now,
      origin: 'reviewer',
      originSource: 'aion_desk_local',
      participantId: input.review.reviewerParticipantId,
      taskId: input.review.taskId,
      attemptId: input.review.attemptId,
      type: 'task_reviewed',
      payload: {
        review: {
          ...input.review,
          id: this.nextId('rev'),
          decidedAt: now,
          sourceEventId: evtId,
        },
        nextTaskStatus:
          input.review.decision === 'approved' ? 'completed' : 'changes_requested',
        generalSummary: `Parecer registrado localmente (${input.review.decision}).`,
      },
    });
  }

  async publishContextRevision(
    input: PublishContextInput,
  ): Promise<SharedContextRevision> {
    const state = this.getStateSnapshot();
    const proj = state.conversations[input.conversationId];
    if (!proj) {
      throw new GatewayCapabilityError(
        'CONVERSATION_NOT_FOUND',
        'Conversa não encontrada.',
      );
    }
    const now = new Date().toISOString();
    const revisionId = this.nextId('ctx');
    const versionNumber = proj.contextRevisions.length + 1;
    const receipts: Record<string, ContextReceipt> = {};
    for (const p of proj.participants) {
      receipts[p.id] = {
        participantId: p.id,
        revisionId,
        status: 'pending_send',
        policyApplied: 'next_turn',
        updatedAt: now,
        mechanismNote:
          'Contexto versionado local do Aion Desk aguardando envio explícito ou próxima mensagem ao Core.',
      };
    }
    const revision: SharedContextRevision = {
      id: revisionId,
      conversationId: input.conversationId,
      versionNumber,
      authorLabel: input.authorLabel,
      createdAt: now,
      summaryOfChange: input.summaryOfChange,
      objective: input.objective,
      permanentInstructions: input.permanentInstructions,
      constraints: input.constraints,
      acceptanceCriteria: input.acceptanceCriteria,
      confirmedDecisions: input.confirmedDecisions,
      receipts,
    };
    this.emitAndIngest(input.conversationId, {
      id: this.nextId('evt'),
      seq: this.nextLocalSeq(proj),
      conversationId: input.conversationId,
      timestamp: now,
      origin: 'user',
      originSource: 'aion_desk_local',
      type: 'context_revision_published',
      payload: {
        revision,
        generalSummary: `Contexto v${versionNumber} publicado localmente: ${revision.summaryOfChange}.`,
      },
    });
    return revision;
  }

  async testAgentConnection(connectionId: string): Promise<{
    ok: boolean;
    testedAt: string;
    message: string;
    isSimulated: boolean;
  }> {
    const state = this.getStateSnapshot();
    const conn = state.connections.find((c) => c.id === connectionId);
    const testedAt = new Date().toISOString();
    if (!conn || !conn.coreAgentId) {
      const health = await this.checkHealth();
      return {
        ok: health.reachable,
        testedAt,
        message: health.message,
        isSimulated: false,
      };
    }
    const raw = await this.httpClient.requestJson<unknown>({
      method: 'POST',
      path: `/api/agents/${encodeURIComponent(conn.coreAgentId)}/health-check`,
      idempotent: true,
      operationName: 'core.agentHealthCheck',
    });
    const row = unwrapApiResponse<AgentManagementRow>(
      raw,
      `POST /api/agents/${conn.coreAgentId}/health-check`,
    );
    const ok = row.status === 'ready';
    const message = ok
      ? `Agente "${row.name}" pronto no AionCore (${row.last_check_latency_ms ?? 0}ms).`
      : `Agente "${row.name}" em estado "${row.status}": ${row.last_check_error_message ?? row.last_check_guidance ?? 'requer verificação local'}.`;
    const nextConnections = state.connections.map((c) =>
      c.id === connectionId
        ? {
            ...c,
            coreReachability: 'reachable' as const,
            executableStatus: row.installed
              ? ('verified' as const)
              : ('missing' as const),
            authStatus:
              row.status === 'ready'
                ? ('authenticated' as const)
                : row.status === 'unauthenticated'
                  ? ('unauthenticated' as const)
                  : ('unknown' as const),
            lastConnectionTestAt: testedAt,
            lastConnectionTestResult: message,
          }
        : c,
    );
    this.state = {
      ...state,
      connections: nextConnections,
      agentProfiles: connectionsToAgentProfiles(nextConnections),
    };
    this.notifyState();
    return {
      ok,
      testedAt,
      message,
      isSimulated: false,
    };
  }

  private async fetchAllActivityPages(
    teamId: string,
    encodedTeamId: string,
  ): Promise<{
    items: TeamActivityItemResponse[];
    failed: boolean;
    failureReason?: string;
  }> {
    const allItems: TeamActivityItemResponse[] = [];
    const seenCursors = new Set<string>();
    let cursor: TeamActivityCursor | null = null;
    let page = 0;

    while (page < 100) {
      page += 1;
      const query = cursor
        ? `?cursor_ts=${encodeURIComponent(String(cursor.ts))}&cursor_id=${encodeURIComponent(cursor.id)}`
        : '';
      try {
        const raw = await this.httpClient.requestJson<unknown>({
          method: 'GET',
          path: `/api/teams/${encodedTeamId}/activity${query}`,
          idempotent: true,
          operationName: 'core.reconcileActivity',
          teamId,
        });
        const pageData = unwrapFlexibleData(raw) as TeamActivityPageResponse;
        if (!isRecord(pageData) || !Array.isArray(pageData.items)) {
          return {
            items: allItems,
            failed: true,
            failureReason: `/activity (página ${page} com formato inválido)`,
          };
        }

        for (const item of pageData.items) {
          if (isRecord(item)) {
            allItems.push(item as unknown as TeamActivityItemResponse);
          }
        }

        if (!pageData.has_more) {
          return { items: allItems, failed: false };
        }

        const nextCursor = pageData.next_cursor;
        if (
          !isRecord(nextCursor) ||
          typeof nextCursor.ts !== 'number' ||
          !Number.isFinite(nextCursor.ts) ||
          typeof nextCursor.id !== 'string' ||
          nextCursor.id.trim().length === 0
        ) {
          return {
            items: allItems,
            failed: true,
            failureReason: `/activity (has_more=true sem next_cursor válido na página ${page})`,
          };
        }

        const cursorKey = `${nextCursor.ts}:${nextCursor.id.trim()}`;
        if (seenCursors.has(cursorKey)) {
          return {
            items: allItems,
            failed: true,
            failureReason: `/activity (cursor repetido ${cursorKey})`,
          };
        }
        seenCursors.add(cursorKey);
        cursor = { ts: nextCursor.ts, id: nextCursor.id.trim() };
      } catch (err) {
        const detail =
          err instanceof Error ? err.message : 'erro ao consultar /activity';
        return {
          items: allItems,
          failed: true,
          failureReason:
            page === 1
              ? '/activity'
              : `/activity (página ${page}: ${detail})`,
        };
      }
    }

    return {
      items: allItems,
      failed: true,
      failureReason: '/activity (limite de páginas excedido)',
    };
  }

  async reconcileConversation(conversationId: string): Promise<ReconcileResult> {
    const state = this.getStateSnapshot();
    const initialProj = state.conversations[conversationId];
    if (!initialProj) {
      throw new GatewayCapabilityError(
        'CONVERSATION_NOT_FOUND',
        'Conversa não encontrada.',
      );
    }
    const teamId = initialProj.conversation.externalTeamId;
    if (!teamId) {
      throw new GatewayCapabilityError(
        'NOT_CONNECTED_LOCAL_CORE',
        'Sem equipe vinculada no Core para reconciliar estado.',
      );
    }

    // Snapshot live WS mutation counters BEFORE parallel HTTP requests so stale snapshots
    // cannot overwrite concurrent WS events received while requests are in flight.
    const wsSlotSeqSnapshot = new Map<string, number>();
    for (const [k, v] of this.wsSlotMutationSeq.entries()) {
      if (k.startsWith(`${conversationId}:`)) {
        wsSlotSeqSnapshot.set(k, v);
      }
    }
    const wsTaskSeqSnapshot = new Map<string, number>();
    for (const [k, v] of this.wsTaskMutationSeq.entries()) {
      if (k.startsWith(`${conversationId}:`)) {
        wsTaskSeqSnapshot.set(k, v);
      }
    }

    const encodedTeamId = encodeURIComponent(teamId);
    const [runStateRes, mailboxRes, tasksRes, activityResult] =
      await Promise.all([
        this.httpClient
          .requestJson<unknown>({
            method: 'GET',
            path: `/api/teams/${encodedTeamId}/run-state`,
            idempotent: true,
            operationName: 'core.reconcileRunState',
            teamId,
          })
          .then(
            (value) => ({ status: 'fulfilled' as const, value }),
            (reason) => ({ status: 'rejected' as const, reason }),
          ),
        this.httpClient
          .requestJson<unknown>({
            method: 'GET',
            path: `/api/teams/${encodedTeamId}/mailbox`,
            idempotent: true,
            operationName: 'core.reconcileMailbox',
            teamId,
          })
          .then(
            (value) => ({ status: 'fulfilled' as const, value }),
            (reason) => ({ status: 'rejected' as const, reason }),
          ),
        this.httpClient
          .requestJson<unknown>({
            method: 'GET',
            path: `/api/teams/${encodedTeamId}/tasks`,
            idempotent: true,
            operationName: 'core.reconcileTasks',
            teamId,
          })
          .then(
            (value) => ({ status: 'fulfilled' as const, value }),
            (reason) => ({ status: 'rejected' as const, reason }),
          ),
        this.fetchAllActivityPages(teamId, encodedTeamId),
      ]);

    const failedEndpoints: string[] = [];
    const unresolvedIdentities = new Set<string>();
    const malformedItems = { count: 0 };
    const recoveredEvents: ExecutionEvent[] = [];

    // Re-read current state AFTER awaits so WS events received during catch-up are preserved
    let currentState = this.getStateSnapshot();
    let proj = currentState.conversations[conversationId];
    if (!proj) {
      throw new GatewayCapabilityError(
        'CONVERSATION_NOT_FOUND',
        'Conversa não encontrada após consulta.',
      );
    }

    // 1. Run-state slot statuses (TeamRunStateResponse)
    if (runStateRes.status === 'fulfilled') {
      try {
        const runState = unwrapFlexibleData(
          runStateRes.value,
        ) as TeamRunStateResponse;
        if (!isRecord(runState) || !Array.isArray(runState.slot_work)) {
          throw new Error('Formato inválido de /run-state');
        }
        const updatedParticipants = proj.participants.map((p) => {
          const slotId = p.sessionRef.externalSlotId;
          if (slotId) {
            const slotKey = `${conversationId}:${slotId}`;
            const currentSlotSeq = this.wsSlotMutationSeq.get(slotKey) ?? 0;
            if (currentSlotSeq > (wsSlotSeqSnapshot.get(slotKey) ?? 0)) {
              return p;
            }
          }
          const slotWork = runState.slot_work.find(
            (s) => s.slot_id === slotId,
          );
          if (!slotWork) return p;
          const mappedStatus =
            slotWork.state === 'running' ||
            slotWork.state === 'starting' ||
            slotWork.state === 'queued'
              ? 'running'
              : slotWork.state === 'blocked'
                ? 'blocked'
                : 'idle';
          return {
            ...p,
            status: mappedStatus as Participant['status'],
          };
        });
        this.state = {
          ...currentState,
          conversations: {
            ...currentState.conversations,
            [conversationId]: {
              ...proj,
              participants: updatedParticipants,
            },
          },
        };
        currentState = this.state;
        proj = currentState.conversations[conversationId]!;
      } catch {
        failedEndpoints.push('/run-state');
      }
    } else {
      failedEndpoints.push('/run-state');
    }

    // 2. Mailbox catch-up (`TeamMailboxMessageResponse[]`)
    if (mailboxRes.status === 'fulfilled') {
      try {
        const mbData = unwrapFlexibleData(mailboxRes.value);
        if (!Array.isArray(mbData)) {
          throw new Error('Esperado array TeamMailboxMessageResponse[] em /mailbox');
        }
        const validMailboxMsgs: TeamMailboxMessageResponse[] = [];
        for (const item of mbData) {
          if (this.isValidMailboxMessageDto(item)) {
            validMailboxMsgs.push(item);
          } else {
            malformedItems.count += 1;
          }
        }
        validMailboxMsgs.sort(
          (a, b) =>
            (toFiniteMs(a.created_at) ?? 0) - (toFiniteMs(b.created_at) ?? 0) ||
            a.id.localeCompare(b.id),
        );
        for (const msg of validMailboxMsgs) {
          this.ingestCoreMailboxMessage(conversationId, msg, {
            externalEventName: 'catchup.mailbox',
            trackRecovered: recoveredEvents,
            unresolvedIdentities,
          });
        }
      } catch {
        failedEndpoints.push('/mailbox');
      }
    } else {
      failedEndpoints.push('/mailbox');
    }

    // 3. Tasks catch-up (`TeamTaskResponse[]`)
    if (tasksRes.status === 'fulfilled') {
      try {
        const tData = unwrapFlexibleData(tasksRes.value);
        if (!Array.isArray(tData)) {
          throw new Error('Esperado array TeamTaskResponse[] em /tasks');
        }
        const validTasks: TeamTaskResponse[] = [];
        for (const item of tData) {
          if (this.isValidTaskDto(item)) {
            validTasks.push(item);
          } else {
            malformedItems.count += 1;
          }
        }
        for (const taskDto of validTasks) {
          this.upsertCoreTask(conversationId, taskDto, {
            source: 'catchup',
            externalEventName: 'catchup.tasks',
            trackRecovered: recoveredEvents,
            unresolvedIdentities,
            malformedItems,
            wsMutationSeqBeforeCatchup: wsTaskSeqSnapshot.get(
              `${conversationId}:${taskDto.id.trim()}`,
            ) ?? 0,
          });
        }
      } catch {
        failedEndpoints.push('/tasks');
      }
    } else {
      failedEndpoints.push('/tasks');
    }

    // 4. Activity catch-up (`TeamActivityPageResponse` -> `TeamActivityItemResponse[]`)
    if (activityResult.failed) {
      failedEndpoints.push(activityResult.failureReason ?? '/activity');
    }
    const sortedActivity = [...activityResult.items].sort(
      (a, b) =>
        (toFiniteMs(a.created_at) ?? 0) - (toFiniteMs(b.created_at) ?? 0) ||
        String(a.id ?? '').localeCompare(String(b.id ?? '')),
    );
    for (const actItem of sortedActivity) {
      if (actItem.kind === 'message') {
        if (!this.isValidMailboxMessageDto(actItem.message)) {
          malformedItems.count += 1;
          continue;
        }
        this.ingestCoreMailboxMessage(conversationId, actItem.message, {
          externalEventName: 'catchup.activity',
          trackRecovered: recoveredEvents,
          unresolvedIdentities,
        });
      } else if (actItem.kind === 'task') {
        if (!this.isValidTaskDto(actItem.task)) {
          malformedItems.count += 1;
          continue;
        }
        this.upsertCoreTask(conversationId, actItem.task, {
          source: 'catchup',
          externalEventName: 'catchup.activity',
          trackRecovered: recoveredEvents,
          unresolvedIdentities,
          malformedItems,
          wsMutationSeqBeforeCatchup: wsTaskSeqSnapshot.get(
            `${conversationId}:${actItem.task.id.trim()}`,
          ) ?? 0,
        });
      } else {
        malformedItems.count += 1;
      }
    }

    const synced =
      failedEndpoints.length === 0 &&
      unresolvedIdentities.size === 0 &&
      malformedItems.count === 0;
    const issueParts: string[] = [];
    if (failedEndpoints.length > 0) {
      issueParts.push(`falha ao consultar ${failedEndpoints.join(', ')}`);
    }
    if (unresolvedIdentities.size > 0) {
      issueParts.push(
        `identidade não resolvida (${Array.from(unresolvedIdentities).join(', ')})`,
      );
    }
    if (malformedItems.count > 0) {
      issueParts.push(`${malformedItems.count} registro(s) com formato incompatível`);
    }

    const finalState = this.getStateSnapshot();
    const finalProj = finalState.conversations[conversationId]!;
    const syncErrorNote = synced
      ? undefined
      : `Reconciliação incompleta no Core: ${issueParts.join('; ')}.`;

    this.state = {
      ...finalState,
      conversations: {
        ...finalState.conversations,
        [conversationId]: {
          ...finalProj,
          conversation: {
            ...finalProj.conversation,
            syncState: synced ? 'synced' : 'incomplete',
          },
          syncErrorNote,
        },
      },
    };
    this.notifyState();

    this.diagnostics.record({
      operation: 'core.reconcile',
      status: synced ? 'ok' : 'error',
      teamId,
      detail: synced
        ? `Catch-up completo (${recoveredEvents.length} evento(s) recuperado(s) via /run-state, /mailbox, /tasks, /activity).`
        : syncErrorNote!,
    });

    return {
      mode: 'missing_events',
      events: recoveredEvents,
      synced,
    };
  }

  async importWorkspaceState(nextState: WorkspaceStoreState): Promise<void> {
    this.wsClient.disconnect();
    this.state = nextState;
    await this.persistence.resetAndSave(nextState);
    for (const listener of this.stateListeners) {
      listener(nextState);
    }
  }
}

export { DEFAULT_PARTICIPANT_PROFILES };
