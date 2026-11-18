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
  WorkspaceConversation,
  WorkspaceStoreState,
} from '../domain/types';
import { PT_BR } from '../i18n/ptBR';
import {
  assertHealthResponse,
  CORE_WS_EVENTS,
  extractAvailableModelOptions,
  extractModelsFromConfigOptions,
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

function mapCoreAgentStatusToAuthStatus(
  status: string | undefined,
): ConnectionAdapterConfig['authStatus'] {
  if (status === 'ready') return 'authenticated';
  if (status === 'unauthenticated') return 'unauthenticated';
  return 'unknown';
}

const MAX_CORE_TASK_ATTEMPTS = 3;

function resolveCoreEscalationModelRef(
  conn: ConnectionAdapterConfig | undefined,
  currentRef: ModelRef,
  targetTier: DemoModelTier,
): ModelRef {
  const currentId = currentRef.externalId?.trim() || currentRef.displayName.trim();
  const confirmed = (conn?.availableModels ?? []).filter((m) => m.confirmed);
  const candidate =
    confirmed.find((m) => m.externalId !== currentId && /pro|terra|sol|high/i.test(m.externalId)) ??
    confirmed.find((m) => m.externalId !== currentId) ??
    confirmed.find((m) => m.externalId === currentId);
  if (candidate) {
    return {
      externalId: candidate.externalId,
      displayName: candidate.displayName,
      source: candidate.source === 'core_session' ? 'core_session' : 'core_catalog',
      tier: targetTier,
      confirmation: 'confirmed',
    };
  }
  return {
    ...currentRef,
    tier: targetTier,
  };
}

function extractUserMarkdownFromCoreMailbox(rawContent: string): string {
  if (!rawContent.startsWith('[Contrato interno ')) {
    return rawContent;
  }
  const marker = '\n\n[Pedido / Orientação]\n';
  const idx = rawContent.lastIndexOf(marker);
  if (idx >= 0) {
    return rawContent.slice(idx + marker.length).trim() || rawContent;
  }
  return rawContent;
}

const CORE_VERIFIED_CAPABILITIES: ConnectionAdapterConfig['capabilities'] = {
  supportsInterrupt: true,
  supportsMidRunContextInjection: false,
  supportsModelSwitchInSession: true,
  supportsPauseQueue: false,
  supportsSessionTerminate: false,
};

const CORE_PREFERENCE_MODEL_HINTS: Array<{
  pattern: RegExp;
  preferredIds: string[];
}> = [
    { pattern: /terra\s*6\.?1/i, preferredIds: ['gpt-6.1-terra'] },
    { pattern: /sol\s*6\.?1/i, preferredIds: ['gpt-6.1-sol'] },
    {
      pattern: /gemini\s*hydrogen/i,
      preferredIds: ['gemini-4-hydrogen-xhigh', 'gemini-4-hydrogen-high'],
    },
  ];

function resolvePresetMembersForCore(
  state: WorkspaceStoreState,
  members: TeamPresetMember[],
): TeamPresetMember[] {
  const coreConns = state.connections.filter(
    (c) => c.mode === 'aion_core' && Boolean(c.coreAssistantId),
  );
  if (coreConns.length === 0) {
    return members;
  }

  return members.map((member) => {
    const existingConn = state.connections.find(
      (c) => c.id === member.connectionId,
    );
    if (existingConn?.mode === 'aion_core' && existingConn.coreAssistantId) {
      return member;
    }

    const desiredBackend =
      existingConn?.backendId ??
      (member.connectionId.includes('antigravity')
        ? 'antigravity'
        : member.connectionId.includes('codex')
          ? 'codex'
          : '');
    const coreConn =
      coreConns.find((c) => c.backendId === desiredBackend) ??
      coreConns.find((c) => c.id === member.connectionId);
    if (!coreConn) {
      return member;
    }

    let resolvedModelRef = member.modelRef;
    const hint = CORE_PREFERENCE_MODEL_HINTS.find((h) =>
      h.pattern.test(member.modelRef.displayName),
    );
    const matchedModel =
      (hint
        ? coreConn.availableModels.find((m) =>
          hint.preferredIds.includes(m.externalId),
        )
        : undefined) ??
      coreConn.availableModels.find(
        (m) =>
          m.externalId === member.modelRef.externalId ||
          m.displayName === member.modelRef.displayName,
      );
    if (matchedModel) {
      resolvedModelRef = {
        externalId: matchedModel.externalId,
        displayName: matchedModel.displayName,
        source: matchedModel.source,
        tier: member.modelRef.tier,
        confirmation: matchedModel.confirmed ? 'confirmed' : 'simulated',
      };
    }

    return {
      ...member,
      connectionId: coreConn.id,
      modelRef: resolvedModelRef,
    };
  });
}

function mergeConfirmedModels(
  existing: ConnectionAdapterConfig['availableModels'],
  incoming: Array<{ externalId: string; displayName: string }>,
  source: 'core_catalog' | 'core_session' = 'core_catalog',
): ConnectionAdapterConfig['availableModels'] {
  const byId = new Map<
    string,
    ConnectionAdapterConfig['availableModels'][number]
  >();
  for (const m of existing) {
    byId.set(m.externalId, m);
  }
  for (const m of incoming) {
    const prev = byId.get(m.externalId);
    byId.set(m.externalId, {
      externalId: m.externalId,
      displayName: m.displayName || prev?.displayName || m.externalId,
      source: prev?.source === 'core_catalog' ? prev.source : source,
      confirmed: true,
    });
  }
  return Array.from(byId.values());
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
    return () => { };
  }
  subscribeEvents(): () => void {
    return () => { };
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
  implements AgentWorkspaceGateway, CoreGatewayOperations {
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
  private expectedDispatchByParticipant = new Map<
    string,
    {
      kind: 'delivery_report' | 'review_decision';
      taskId: string;
      attemptId: string;
      turnId?: string;
      contextRevisionId?: string;
    }
  >();
  private consumedTurnBindings = new Map<
    string,
    {
      kind: 'delivery_report' | 'review_decision';
      taskId: string;
      attemptId: string;
      decision?: 'approved' | 'rejected';
    }
  >();
  private lastSentContextByParticipant = new Map<
    string,
    {
      revisionId: string;
      sentAtMs: number;
      sendInitiatedEventIndex?: number;
      messageId?: string;
    }
  >();
  private lastReconciledSlotWorkByConv = new Map<string, Map<string, string>>();
  private wsTaskMutationSeq = new Map<string, number>();
  private wsSlotMutationSeq = new Map<string, number>();
  private wsWasConnectedBefore = false;
  private wsDisconnectedSinceLastConnect = false;
  private inFlightSlotDispatches = new Set<string>();
  private backgroundDispatchChain: Promise<void> = Promise.resolve();
  private pendingCoreConfirmations = new Map<
    string,
    {
      convId: string;
      participantId: string;
      extConvId: string;
      callId: string;
      msgId: string;
      allowData: unknown;
      denyData: unknown;
    }
  >();

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

  private clearRuntimeCaches(): void {
    this.streamBuffers.clear();
    this.lastSlotWorkSignature.clear();
    this.turnParticipantMap.clear();
    this.expectedKindByParticipant.clear();
    this.expectedDispatchByParticipant.clear();
    this.consumedTurnBindings.clear();
    this.lastSentContextByParticipant.clear();
    this.lastReconciledSlotWorkByConv.clear();
    this.wsTaskMutationSeq.clear();
    this.wsSlotMutationSeq.clear();
    this.inFlightSlotDispatches.clear();
    this.pendingCoreConfirmations.clear();
  }

  private recordConsumedTurnBinding(
    key: string,
    binding: {
      kind: 'delivery_report' | 'review_decision';
      taskId: string;
      attemptId: string;
      decision?: 'approved' | 'rejected';
    },
  ): void {
    this.consumedTurnBindings.set(key, binding);
    const MAX_CONSUMED_TURN_BINDINGS = 500;
    while (this.consumedTurnBindings.size > MAX_CONSUMED_TURN_BINDINGS) {
      const oldestKey = this.consumedTurnBindings.keys().next().value;
      if (oldestKey === undefined) break;
      this.consumedTurnBindings.delete(oldestKey);
    }
  }

  private markCoreSessionExpired(detail?: string): void {
    if (!this.state) return;
    const nextConnections = this.state.connections.map((c) =>
      c.mode === 'aion_core'
        ? {
          ...c,
          authStatus: 'expired' as const,
          sessionStatus: 'disconnected' as const,
          lastConnectionTestResult:
            detail ?? 'Sessão expirada no AionCore. Faça login novamente.',
        }
        : c,
    );
    this.state = {
      ...this.state,
      coreSessionAuthenticated: false,
      connections: nextConnections,
      agentProfiles: connectionsToAgentProfiles(nextConnections),
    };
    this.notifyState();
  }

  private emitContextReceiptSent(input: {
    convId: string;
    participant: Participant;
    revision: SharedContextRevision;
    messageId: string;
    mechanismNote: string;
    sendInitiatedEventIndex?: number;
    taskId?: string;
    attemptId?: string;
  }): void {
    if (!this.state) return;
    const proj = this.state.conversations[input.convId];
    if (!proj) return;
    const rev = proj.contextRevisions.find((r) => r.id === input.revision.id);
    if (!rev) return;
    const now = new Date().toISOString();
    const sentAtMs = Date.now();
    this.lastSentContextByParticipant.set(
      `${input.convId}:${input.participant.id}`,
      {
        revisionId: rev.id,
        sentAtMs,
        sendInitiatedEventIndex: input.sendInitiatedEventIndex,
        messageId: input.messageId,
      },
    );
    const currentRcpt = rev.receipts[input.participant.id];
    if (
      currentRcpt &&
      currentRcpt.status !== 'pending_send' &&
      currentRcpt.status !== 'failed_needs_action'
    ) {
      return;
    }
    this.emitAndIngest(input.convId, {
      id: `evt_core_rcpt_sent_${rev.id}_${input.participant.id}_${input.messageId}`,
      seq: this.nextLocalSeq(proj),
      conversationId: input.convId,
      timestamp: now,
      origin: 'gateway',
      originSource: 'aion_core',
      participantId: input.participant.id,
      taskId: input.taskId,
      attemptId: input.attemptId,
      type: 'context_receipt_updated',
      payload: {
        revisionId: rev.id,
        versionNumber: rev.versionNumber,
        participantId: input.participant.id,
        receipt: {
          participantId: input.participant.id,
          revisionId: rev.id,
          status: 'sent',
          policyApplied: 'next_turn',
          updatedAt: now,
          mechanismNote: input.mechanismNote,
        },
        projectToGeneral: false,
      },
    });
  }

  private emitContextReceiptFailed(input: {
    convId: string;
    participant: Participant;
    revision: SharedContextRevision;
    reason: string;
    taskId?: string;
    attemptId?: string;
  }): void {
    if (!this.state) return;
    const proj = this.state.conversations[input.convId];
    if (!proj) return;
    const rev = proj.contextRevisions.find((r) => r.id === input.revision.id);
    if (!rev) return;
    const currentRcpt = rev.receipts[input.participant.id];
    if (
      currentRcpt &&
      currentRcpt.status !== 'pending_send' &&
      currentRcpt.status !== 'sent' &&
      currentRcpt.status !== 'failed_needs_action'
    ) {
      return;
    }
    const now = new Date().toISOString();
    this.emitAndIngest(input.convId, {
      id: this.nextId(`evt_core_rcpt_fail_${rev.id}_${input.participant.id}`),
      seq: this.nextLocalSeq(proj),
      conversationId: input.convId,
      timestamp: now,
      origin: 'gateway',
      originSource: 'aion_core',
      participantId: input.participant.id,
      taskId: input.taskId,
      attemptId: input.attemptId,
      type: 'context_receipt_updated',
      payload: {
        revisionId: rev.id,
        versionNumber: rev.versionNumber,
        participantId: input.participant.id,
        receipt: {
          participantId: input.participant.id,
          revisionId: rev.id,
          status: 'failed_needs_action',
          policyApplied: 'next_turn',
          updatedAt: now,
          mechanismNote: `Falha ao enviar Contexto v${rev.versionNumber} para ${input.participant.displayName}: ${input.reason}`,
        },
        projectToGeneral: false,
      },
    });
  }

  private emitContextReceiptApplied(input: {
    convId: string;
    participant: Participant;
    revisionId: string;
    origin: 'coordinator' | 'executor' | 'reviewer';
    mechanismNote: string;
    taskId?: string;
    attemptId?: string;
    eventSuffix: string;
  }): void {
    if (!this.state) return;
    const proj = this.state.conversations[input.convId];
    if (!proj) return;
    const rev = proj.contextRevisions.find((r) => r.id === input.revisionId);
    if (!rev) return;
    const now = new Date().toISOString();
    this.emitAndIngest(input.convId, {
      id: `evt_core_rcpt_app_${rev.id}_${input.participant.id}_${input.eventSuffix}`,
      seq: this.nextLocalSeq(proj),
      conversationId: input.convId,
      timestamp: now,
      origin: input.origin,
      originSource: 'aion_core',
      participantId: input.participant.id,
      taskId: input.taskId,
      attemptId: input.attemptId,
      type: 'context_receipt_updated',
      payload: {
        revisionId: rev.id,
        versionNumber: rev.versionNumber,
        participantId: input.participant.id,
        receipt: {
          participantId: input.participant.id,
          revisionId: rev.id,
          status: 'applied',
          policyApplied: 'next_turn',
          updatedAt: now,
          mechanismNote: input.mechanismNote,
        },
        projectToGeneral: false,
      },
    });
  }

  dispose(): void {
    this.wsClient.disconnect();
    this.clearRuntimeCaches();
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
    const prevUrl = normalizeBaseUrl(state.coreSettings.baseUrl);
    const nextUrl = normalizeBaseUrl(settings.baseUrl);
    this.httpClient.setBaseUrl(nextUrl);
    const urlChanged = prevUrl !== nextUrl;
    const nextConnections = urlChanged
      ? state.connections.map((c) =>
        c.mode === 'aion_core'
          ? {
            ...c,
            coreReachability: 'unknown' as const,
            catalogLoaded: false,
            coreAgentStatus: undefined,
            authStatus: 'unknown' as const,
            sessionStatus: 'inactive' as const,
          }
          : c,
      )
      : state.connections;
    this.state = {
      ...state,
      coreRuntimeStatus: urlChanged ? 'unknown' : state.coreRuntimeStatus,
      coreSessionAuthenticated: urlChanged
        ? false
        : state.coreSessionAuthenticated,
      connections: nextConnections,
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
          coreRuntimeStatus: health.status === 'ok' ? 'reachable' : 'unreachable',
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
          coreRuntimeStatus: 'unreachable',
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
              ? c.authStatus === 'unauthenticated'
                ? ('unauthenticated' as const)
                : c.coreAgentStatus && c.coreAgentStatus !== 'ready'
                  ? c.authStatus
                  : ('authenticated' as const)
              : ('unauthenticated' as const),
          }
          : c,
      );
      this.state = {
        ...state,
        coreRuntimeStatus: 'reachable',
        coreSessionAuthenticated: Boolean(status.is_authenticated),
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
            authStatus:
              c.coreAgentStatus && c.coreAgentStatus !== 'ready'
                ? c.authStatus
                : ('authenticated' as const),
          }
          : c,
      );
      this.state = {
        ...state,
        coreRuntimeStatus: 'reachable',
        coreSessionAuthenticated: true,
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
          coreSessionAuthenticated: false,
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
    const derivedCoreConnections: ConnectionAdapterConfig[] = [];

    if (assistants.length > 0) {
      for (const assistant of assistants) {
        const linkedAgent = agentsById.get(assistant.agent_id);
        const backend = linkedAgent?.backend ?? assistant.agent_id;
        const agentModels = extractAvailableModelOptions(
          linkedAgent?.available_models,
        );
        const configModels = extractModelsFromConfigOptions(
          linkedAgent?.config_options,
        );
        const assistantModels = (assistant.models ?? []).map((m) => ({
          externalId: m,
          displayName: m,
        }));
        const availableModels = mergeConfirmedModels(
          [],
          [...agentModels, ...configModels, ...assistantModels],
          'core_catalog',
        );

        const executableStatus = linkedAgent
          ? linkedAgent.installed
            ? 'verified'
            : 'missing'
          : 'unknown';

        const coreAgentStatus = linkedAgent?.status ?? assistant.agent_status;
        const authStatus = mapCoreAgentStatusToAuthStatus(coreAgentStatus);
        const statusSummary =
          coreAgentStatus === 'online'
            ? `Catálogo carregado (${availableModels.length} modelo(s) exposto(s)); CLI online no Core.`
            : coreAgentStatus === 'unchecked'
              ? `Catálogo carregado (${availableModels.length} modelo(s) exposto(s)); CLI ainda não testada (unchecked).`
              : `Catálogo carregado (${availableModels.length} modelo(s) exposto(s)); estado CLI: ${coreAgentStatus}.`;

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
          coreAgentStatus,
          authStatus,
          sessionStatus: 'inactive',
          availableModels,
          lastConnectionTestAt: new Date().toISOString(),
          lastConnectionTestResult: assistant.team_selectable
            ? statusSummary
            : `Indisponível para equipe: ${assistant.team_block_reason ?? assistant.agent_status}.`,
          capabilities: { ...CORE_VERIFIED_CAPABILITIES },
          isSimulated: false,
        });
      }
    } else {
      for (const agent of agents) {
        const availableModels = mergeConfirmedModels(
          [],
          [
            ...extractAvailableModelOptions(agent.available_models),
            ...extractModelsFromConfigOptions(agent.config_options),
          ],
          'core_catalog',
        );
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
          coreAgentStatus: agent.status,
          authStatus: mapCoreAgentStatusToAuthStatus(agent.status),
          sessionStatus: 'inactive',
          availableModels,
          lastConnectionTestAt: new Date().toISOString(),
          lastConnectionTestResult:
            'Agente listado sem assistant_id associado no catálogo /api/assistants.',
          capabilities: { ...CORE_VERIFIED_CAPABILITIES },
          isSimulated: false,
        });
      }
    }

    const latestState = this.state ?? state;
    const keptDemoConnectionsNow = latestState.connections.filter(
      (c) => c.mode !== 'aion_core',
    );
    const nextConnections = [...keptDemoConnectionsNow, ...derivedCoreConnections];
    this.state = {
      ...latestState,
      coreRuntimeStatus: 'reachable',
      coreSessionAuthenticated: Boolean(latestState.coreSessionAuthenticated),
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

    const latestState = this.state ?? state;
    const nextConversations = { ...latestState.conversations };
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
        ...latestState,
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

    const latestState = this.state ?? state;
    const latestProj = latestState.conversations[conversationId] ?? proj;
    const mappedParticipants = latestProj.participants.map((p) => {
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
      ...latestState,
      conversations: {
        ...latestState.conversations,
        [conversationId]: {
          ...latestProj,
          participants: mappedParticipants,
          conversation: {
            ...latestProj.conversation,
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
          if (
            status === 'error' &&
            detail &&
            (detail.includes('1008') || detail.toLowerCase().includes('expirada'))
          ) {
            this.markCoreSessionExpired(detail);
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

    if (proj.participants.filter((p) => !p.archived).length > 1) {
      blocks.push(
        '[Regra estrita de orquestração do Aion Desk — NÃO usar ferramentas MCP de equipe]\nEste fluxo é orquestrado exclusivamente pelo Vértice Workspace (aion-desk/v1). NÃO chame team_send_message, team_task_create, team_task_update, team_spawn_agent nem team_interrupt_agent via MCP durante este fluxo. Nunca delegue diretamente por MCP; responda com seu parecer/trabalho e o bloco JSON aion-desk-json solicitado. Se posteriormente você receber idle_notification ou avisos internos do scheduler sem novo pedido explícito do usuário, NÃO reemita plan_proposal nem repita blocos aion-desk-json — responda apenas "OK".',
      );
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
      const cleanUserContent = extractUserMarkdownFromCoreMailbox(content);
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
      const isCoordRecipient =
        Boolean(recipientRes.participant) &&
        recipientRes.participant!.id === coordinator?.id;
      const targetTab =
        recipientRes.participant && !recipientRes.isBroadcast && !isCoordRecipient
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
          bodyMarkdown: cleanUserContent,
          deliveryStatus: 'enqueued_core',
          generalSummary:
            targetTab === 'general'
              ? cleanUserContent
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
    this.expectedDispatchByParticipant.delete(`${convId}:${participant.id}`);
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
      if (data.position === 'right' || data.hidden === true) {
        return;
      }

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
      const streamSessionId =
        asNonEmptyString(inner?.session_id) ?? asNonEmptyString(data.session_id);
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

      // Capture native CLI session_id from `start`/`finish` frames into SessionRef
      if (
        streamSessionId &&
        participant.sessionRef.nativeSessionId !== streamSessionId
      ) {
        const curProj = this.state.conversations[convId];
        if (curProj) {
          this.state = {
            ...this.state,
            conversations: {
              ...this.state.conversations,
              [convId]: {
                ...curProj,
                participants: curProj.participants.map((p) =>
                  p.id === participant.id
                    ? {
                      ...p,
                      sessionRef: {
                        ...p.sessionRef,
                        nativeSessionId: streamSessionId,
                        status: 'active',
                      },
                    }
                    : p,
                ),
              },
            },
          };
          this.notifyState();
        }
      }

      // Live ACP model/config options reported on session start
      if (msgType === 'acp_config_option') {
        const discovered = extractModelsFromConfigOptions(data.data);
        if (discovered.length > 0 && this.state) {
          const targetConn = this.state.connections.find(
            (c) => c.id === participant.connectionId,
          );
          if (targetConn) {
            const nextConnections = this.state.connections.map((c) =>
              c.id === targetConn.id
                ? {
                  ...c,
                  availableModels: mergeConfirmedModels(
                    c.availableModels,
                    discovered,
                    'core_session',
                  ),
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
        return;
      }

      if (msgType === 'acp_permission' || msgType === 'permission') {
        const permInner = inner ?? (isRecord(data.data) ? data.data : undefined);
        const toolCall = permInner && isRecord(permInner.tool_call) ? permInner.tool_call : undefined;
        const rawCallId =
          asNonEmptyString(toolCall?.tool_call_id) ??
          asNonEmptyString(permInner?.call_id) ??
          asNonEmptyString(permInner?.id) ??
          msgId;
        if (rawCallId) {
          const reqId = `perm_core_${convId}_${rawCallId}`;
          const latestProj = this.state.conversations[convId];
          if (latestProj && !latestProj.permissions.some((p) => p.id === reqId)) {
            const rawOptions = Array.isArray(permInner?.options)
              ? permInner.options.filter(isRecord)
              : [];
            let allowData: unknown = 'allow';
            let denyData: unknown = 'reject';
            for (const opt of rawOptions) {
              const kindStr = String(opt.kind ?? '').toLowerCase();
              const optVal = opt.option_id ?? opt.value ?? opt.label;
              if ((kindStr === 'allow_once' || kindStr === 'allow_always') && optVal !== undefined) {
                if (kindStr === 'allow_once' || allowData === 'allow') {
                  allowData = optVal;
                }
              }
              if ((kindStr === 'reject_once' || kindStr === 'reject_always') && optVal !== undefined) {
                if (kindStr === 'reject_once' || denyData === 'reject') {
                  denyData = optVal;
                }
              }
            }

            const title =
              asNonEmptyString(toolCall?.title) ??
              asNonEmptyString(permInner?.title) ??
              asNonEmptyString(permInner?.action) ??
              'Permissão solicitada pelo agente no Core';
            const kindLabel =
              asNonEmptyString(toolCall?.kind) ??
              asNonEmptyString(permInner?.command_type) ??
              'execute';
            const rawInput = toolCall?.raw_input;
            const rawCmd =
              isRecord(rawInput) && typeof rawInput.command === 'string'
                ? rawInput.command
                : typeof permInner?.description === 'string' && permInner.description
                  ? permInner.description
                  : rawInput !== undefined
                    ? JSON.stringify(rawInput).slice(0, 180)
                    : title;
            const activeTask = latestProj.tasks.find((t) =>
              t.attempts.some(
                (a) => a.executorParticipantId === participant.id && a.status === 'running',
              ),
            );
            const activeAttempt = activeTask?.attempts[activeTask.attempts.length - 1];
            const reqEvtId = `evt_ws_perm_req_${convId}_${rawCallId}`;

            this.pendingCoreConfirmations.set(reqId, {
              convId,
              participantId: participant.id,
              extConvId,
              callId: rawCallId,
              msgId: msgId ?? rawCallId,
              allowData,
              denyData,
            });

            if (!latestProj.seenEventIds.includes(reqEvtId)) {
              this.emitAndIngest(convId, {
                id: reqEvtId,
                seq: this.nextLocalSeq(latestProj),
                conversationId: convId,
                timestamp: now,
                origin: 'gateway',
                originSource: 'aion_core',
                externalEventName: wsMsg.name,
                correlationId: turnId,
                participantId: participant.id,
                taskId: activeTask?.id,
                attemptId: activeAttempt?.id,
                type: 'permission_requested',
                payload: {
                  request: {
                    id: reqId,
                    conversationId: convId,
                    participantId: participant.id,
                    taskId: activeTask?.id,
                    attemptId: activeAttempt?.id,
                    actionKey: kindLabel,
                    scopeKey: `${extConvId}:${rawCallId}`,
                    actionTitle: title,
                    commandSimulated: rawCmd,
                    scopeDescription: `Solicitação real do Core (${extConvId}, call=${rawCallId}).`,
                    status: 'pending',
                    createdAt: now,
                    sourceEventId: reqEvtId,
                    isSimulated: false,
                  },
                  generalSummary: `${participant.displayName} aguarda confirmação do usuário para "${title}".`,
                },
              });
            }
          }
        }
        return;
      }

      if (
        msgType === 'start' ||
        msgType === 'available_commands' ||
        msgType === 'acp_context_usage' ||
        msgType === 'acp_session_info' ||
        msgType === 'thought' ||
        msgType === 'thinking' ||
        msgType === 'tool_call' ||
        msgType === 'tool_group'
      ) {
        return;
      }

      if (msgType === 'tips') {
        const tipCode =
          asNonEmptyString(inner?.code) ?? asNonEmptyString(inner?.type) ?? '';
        const tipMessage =
          asNonEmptyString(inner?.content) ?? asNonEmptyString(chunkContent) ?? tipCode;
        const needsAuth = /ACP_EMPTY_TURN_NEEDS_AUTH|unauthenticated/i.test(
          `${tipCode} ${tipMessage}`,
        );
        this.diagnostics.record({
          operation: 'ws.message_stream.tips',
          status: needsAuth ? 'error' : 'ok',
          code: tipCode || undefined,
          detail: tipMessage || 'Dica recebida no stream do Core.',
        });
        if (needsAuth && this.state) {
          const nextConnections = this.state.connections.map((c) =>
            c.id === participant.connectionId
              ? {
                ...c,
                authStatus: 'unauthenticated' as const,
                lastConnectionTestResult:
                  tipMessage || 'CLI local requer login antes de responder.',
              }
              : c,
          );
          this.state = {
            ...this.state,
            connections: nextConnections,
            agentProfiles: connectionsToAgentProfiles(nextConnections),
          };
          this.notifyState();
          this.handleCoreParticipantFailure(
            convId,
            participant,
            tipMessage || 'CLI local sem autenticação válida no provedor.',
            wsMsg.name,
            {
              deterministicEventId: msgId
                ? `evt_ws_stream_tip_auth_${convId}_${msgId}`
                : undefined,
            },
          );
        }
        return;
      }

      if (turnId) {
        this.turnParticipantMap.set(`${convId}:${turnId}`, participant.id);
      }

      const effectiveMsgKey = turnId ?? msgId;
      if (!effectiveMsgKey) return;

      const bufferKey = `${convId}:${participant.id}:${effectiveMsgKey}`;
      let buffer = this.streamBuffers.get(bufferKey);
      if (!buffer) {
        // Frames of the same logical turn may arrive with turn_id only on some frames
        // (e.g. `finish` without turn_id): resolve by msg_id or turn_id before opening a new buffer.
        const candidates = Array.from(this.streamBuffers.values()).filter(
          (b) => b.conversationId === convId && b.participantId === participant.id,
        );
        buffer =
          candidates.find((b) => !b.finished && msgId !== undefined && b.msgId === msgId) ??
          candidates.find((b) => !b.finished && turnId !== undefined && b.turnId === turnId) ??
          (msgType === 'finish' ||
            msgType === 'end' ||
            msgType === 'done' ||
            msgType === 'completed'
            ? candidates.filter((b) => !b.finished && b.text.length > 0).slice(-1)[0]
            : undefined);
      }

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
        msgType === 'delta'
      ) {
        if (!chunkContent) return;
        if (
          buffer.text &&
          !buffer.text.endsWith('\n') &&
          chunkContent.startsWith('```')
        ) {
          buffer.text += '\n\n';
        }
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

    if (wsMsg.name === CORE_WS_EVENTS.CONFIRMATION_REMOVE) {
      const removedId = asNonEmptyString(data.id);
      const removedExtConvId = asNonEmptyString(data.conversation_id);
      if (removedId) {
        for (const [reqId, pending] of this.pendingCoreConfirmations.entries()) {
          if (
            pending.convId === convId &&
            (pending.callId === removedId ||
              (removedExtConvId && pending.extConvId === removedExtConvId && pending.callId === removedId))
          ) {
            this.pendingCoreConfirmations.delete(reqId);
            const curProj = this.state.conversations[convId];
            const existingPerm = curProj?.permissions.find((p) => p.id === reqId);
            const remEvtId = `evt_ws_perm_rem_${convId}_${removedId}`;
            if (
              curProj &&
              existingPerm &&
              existingPerm.status === 'pending' &&
              !curProj.seenEventIds.includes(remEvtId)
            ) {
              this.emitAndIngest(convId, {
                id: remEvtId,
                seq: this.nextLocalSeq(curProj),
                conversationId: convId,
                timestamp: now,
                origin: 'gateway',
                originSource: 'aion_core',
                externalEventName: wsMsg.name,
                participantId: pending.participantId,
                taskId: existingPerm.taskId,
                type: 'permission_decided',
                payload: {
                  decision: {
                    requestId: reqId,
                    decision: 'approved',
                    decidedBy: 'AionCore',
                    note: 'Confirmação encerrada/removida no AionCore.',
                    decidedAt: now,
                  },
                  generalSummary: `Confirmação "${existingPerm.actionTitle}" finalizada no AionCore.`,
                },
              });
            }
          }
        }
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
        const dispatchKey = `${convId}:${participant.id}`;
        const pendingDispatch = this.expectedDispatchByParticipant.get(dispatchKey);
        if (
          pendingDispatch &&
          !pendingDispatch.turnId &&
          !this.consumedTurnBindings.has(`${dispatchKey}:${turnId}`)
        ) {
          pendingDispatch.turnId = turnId;
        }
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
        this.expectedDispatchByParticipant.delete(`${convId}:${participant.id}`);
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
        this.expectedDispatchByParticipant.delete(`${convId}:${participant.id}`);
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
          this.expectedDispatchByParticipant.delete(`${convId}:${participant.id}`);
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

    // Validate expectedKind mismatch, conversationId mismatch, and strict task/attempt correlation
    let finalParseStatus = parsedOutput?.parseStatus;
    let finalParseReason = parsedOutput?.errorReason;
    let validEnvelope = parsedOutput?.valid ? parsedOutput.parsed : undefined;
    let correlatedDelivery: { task: Task; attempt: TaskAttempt } | undefined;
    let correlatedReview: { task: Task; attempt: TaskAttempt } | undefined;
    let duplicateStructuredReason: string | undefined;

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

    if (validEnvelope?.kind === 'delivery_report') {
      const corr = this.correlateDeliveryReport(
        proj,
        input.participant,
        validEnvelope,
        input.turnId,
      );
      if (corr.status === 'matched') {
        correlatedDelivery = { task: corr.task, attempt: corr.attempt };
      } else if (corr.status === 'duplicate') {
        duplicateStructuredReason = corr.reason;
      } else {
        validEnvelope = undefined;
        finalParseStatus = 'invalid';
        finalParseReason = corr.reason;
      }
    } else if (validEnvelope?.kind === 'review_decision') {
      const corr = this.correlateReviewDecision(
        proj,
        input.participant,
        validEnvelope,
        input.turnId,
      );
      if (corr.status === 'matched') {
        correlatedReview = { task: corr.task, attempt: corr.attempt };
      } else if (corr.status === 'duplicate') {
        duplicateStructuredReason = corr.reason;
      } else {
        validEnvelope = undefined;
        finalParseStatus = 'invalid';
        finalParseReason = corr.reason;
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
          ? finalParseStatus === 'invalid' && finalParseReason
            ? `${input.participant.displayName}: revisão manual necessária — ${finalParseReason}`
            : `${input.participant.displayName} (${input.externalEventName}): ${trimmed.slice(0, 120)}`
          : undefined,
        detailLinkLabel: 'Ver execução',
      },
    });

    // Receipt update: response received from participant -> mark `'received'` ONLY when
    // there is prior evidence that this revision was actually `'sent'` to the participant
    // (never infer `'received'` from `'pending_send'` or from a turn that started before send).
    const postMsgProj = this.state.conversations[input.convId];
    if (postMsgProj) {
      const sentMeta = this.lastSentContextByParticipant.get(expectedKey);
      const latestCtx = getLatestContextRevision(postMsgProj);
      const targetCtx =
        (sentMeta
          ? postMsgProj.contextRevisions.find((r) => r.id === sentMeta.revisionId)
          : undefined) ?? latestCtx;
      if (targetCtx) {
        const existingReceipt = targetCtx.receipts[input.participant.id];
        if (existingReceipt && existingReceipt.status === 'sent') {
          const normalizedTurnId = asNonEmptyString(input.turnId);
          let turnStartedBeforeSend = false;
          if (normalizedTurnId) {
            const turnStartIdx = postMsgProj.eventLog.findIndex(
              (ev) =>
                ev.externalEventName === 'team.childTurnStarted' &&
                ev.correlationId === normalizedTurnId &&
                ev.participantId === input.participant.id,
            );
            const ctxPublishedIdx = postMsgProj.eventLog.findIndex(
              (ev) =>
                ev.type === 'context_revision_published' &&
                ev.payload.revision.id === targetCtx.id,
            );
            const baselineIdx =
              sentMeta &&
                sentMeta.revisionId === targetCtx.id &&
                sentMeta.sendInitiatedEventIndex !== undefined
                ? Math.max(sentMeta.sendInitiatedEventIndex, ctxPublishedIdx)
                : ctxPublishedIdx;
            if (
              baselineIdx >= 0 &&
              turnStartIdx >= 0 &&
              turnStartIdx < baselineIdx
            ) {
              turnStartedBeforeSend = true;
            }
          }
          if (!turnStartedBeforeSend) {
            this.emitAndIngest(input.convId, {
              id: `evt_core_rcpt_recv_${targetCtx.id}_${input.participant.id}_${input.extMsgId}`,
              seq: this.nextLocalSeq(postMsgProj),
              conversationId: input.convId,
              timestamp: now,
              origin: 'gateway',
              originSource: 'aion_core',
              participantId: input.participant.id,
              type: 'context_receipt_updated',
              payload: {
                revisionId: targetCtx.id,
                versionNumber: targetCtx.versionNumber,
                participantId: input.participant.id,
                receipt: {
                  participantId: input.participant.id,
                  revisionId: targetCtx.id,
                  status: 'received',
                  policyApplied: 'next_turn',
                  updatedAt: now,
                  mechanismNote: `Resposta recebida de ${input.participant.displayName} após envio (msg ${input.extMsgId}); aplicação comprovada somente mediante entrega/parecer correlacionado.`,
                },
                projectToGeneral: false,
              },
            });
          }
        }
      }
    }

    if (!validEnvelope) {
      return;
    }

    if (duplicateStructuredReason) {
      this.diagnostics.record({
        operation: 'core.structured_envelope_duplicate_ignored',
        status: 'ok',
        detail: `${duplicateStructuredReason} (msg ${input.extMsgId}).`,
      });
      return;
    }

    if (
      validEnvelope.kind === 'plan_proposal' &&
      proj.tasks.length > 0 &&
      expectedKind !== 'plan_proposal'
    ) {
      this.diagnostics.record({
        operation: 'core.plan_proposal_ignored_unsolicited',
        status: 'ok',
        detail: `Plano duplicado ignorado para ${input.participant.displayName} (msg ${input.extMsgId}; plano ativo já existente).`,
      });
      return;
    }

    this.expectedKindByParticipant.delete(expectedKey);
    this.expectedDispatchByParticipant.delete(expectedKey);

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
      const normalizedTurnId = asNonEmptyString(input.turnId);
      if (normalizedTurnId && correlatedDelivery) {
        this.recordConsumedTurnBinding(`${expectedKey}:${normalizedTurnId}`, {
          kind: 'delivery_report',
          taskId: correlatedDelivery.task.id,
          attemptId: correlatedDelivery.attempt.id,
        });
      }
      this.applyStructuredDeliveryReport(
        input.convId,
        input.participant,
        validEnvelope,
        correlatedDelivery,
      );
      return;
    }

    if (validEnvelope.kind === 'review_decision') {
      const normalizedTurnId = asNonEmptyString(input.turnId);
      if (normalizedTurnId && correlatedReview) {
        this.recordConsumedTurnBinding(`${expectedKey}:${normalizedTurnId}`, {
          kind: 'review_decision',
          taskId: correlatedReview.task.id,
          attemptId: correlatedReview.attempt.id,
          decision: validEnvelope.decision,
        });
      }
      this.applyStructuredReviewDecision(
        input.convId,
        input.participant,
        validEnvelope,
        correlatedReview,
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
    if (proj.planRevisions.some((r) => r.sourceEventId === sourceEventId)) {
      return;
    }
    const incomingTitles = plan.tasks.map((t) => t.title.trim().toLowerCase());
    if (
      incomingTitles.length > 0 &&
      proj.tasks.some((t) => t.status !== 'completed' && t.status !== 'cancelled') &&
      incomingTitles.every((title) =>
        proj.tasks.some(
          (t) =>
            t.status !== 'cancelled' &&
            t.title.trim().toLowerCase() === title,
        ),
      )
    ) {
      this.diagnostics.record({
        operation: 'core.plan_proposal_deduplicated',
        status: 'ok',
        detail: `Plano idêntico ignorado em "${proj.conversation.title}" (${incomingTitles.length} tarefa(s) já cadastrada(s)).`,
      });
      return;
    }
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

    if (
      this.state.conversations[convId]?.conversation.executionStatus ===
      'paused_queue'
    ) {
      return;
    }

    this.enqueueBackgroundWork(async () => {
      await this.dispatchNextRunnableTaskInCore(convId);
    });
  }

  private parseOptionalAttemptId(
    raw: unknown,
  ):
    | { present: false }
    | { present: true; valid: true; value: string }
    | { present: true; valid: false; reason: string } {
    if (raw === undefined) {
      return { present: false };
    }
    if (typeof raw !== 'string' || !raw.trim()) {
      return {
        present: true,
        valid: false,
        reason:
          'Campo attemptId presente com tipo ou valor inválido (esperado string não vazia); mantido para revisão manual.',
      };
    }
    return { present: true, valid: true, value: raw.trim() };
  }

  private isTurnPrecedingAttemptStage(
    proj: ConversationProjection,
    participantId: string,
    turnId: string,
    anchorType: 'attempt_started' | 'attempt_delivered',
    taskId: string,
    attemptId: string,
  ): boolean {
    const anchorEvt = [...proj.eventLog]
      .reverse()
      .find(
        (e) =>
          e.type === anchorType &&
          e.taskId === taskId &&
          e.attemptId === attemptId,
      );
    if (!anchorEvt) return false;
    return proj.eventLog.some(
      (e) =>
        e.seq < anchorEvt.seq &&
        e.participantId === participantId &&
        e.correlationId === turnId &&
        (e.type === 'agent_message_posted' ||
          e.type === 'connection_state_changed'),
    );
  }

  private correlateDeliveryReport(
    proj: ConversationProjection,
    executor: Participant,
    report: {
      taskId: unknown;
      attemptId?: unknown;
    },
    turnId?: string,
  ):
    | { status: 'matched'; task: Task; attempt: TaskAttempt }
    | { status: 'duplicate'; task: Task; attempt: TaskAttempt; reason: string }
    | { status: 'incompatible'; reason: string } {
    if (!hasRole(executor, 'executor')) {
      return {
        status: 'incompatible',
        reason: `Participante "${executor.displayName}" não possui papel de executor para registrar entrega estruturada.`,
      };
    }

    const taskId = typeof report.taskId === 'string' ? report.taskId.trim() : '';
    const task = taskId ? proj.tasks.find((t) => t.id === taskId) : undefined;
    if (!task) {
      return {
        status: 'incompatible',
        reason: `Entrega referencia tarefa inexistente nesta conversa (${taskId || 'vazio'}); mantida para revisão manual sem alterar tarefas.`,
      };
    }

    if (task.assigneeParticipantId && task.assigneeParticipantId !== executor.id) {
      return {
        status: 'incompatible',
        reason: `Entrega enviada por "${executor.displayName}", mas a tarefa "${task.title}" está atribuída a outro participante; mantida para revisão manual.`,
      };
    }

    const latestAttempt = task.attempts[task.attempts.length - 1];
    const attemptIdCheck = this.parseOptionalAttemptId(report.attemptId);
    if (attemptIdCheck.present && !attemptIdCheck.valid) {
      return { status: 'incompatible', reason: attemptIdCheck.reason };
    }

    if (attemptIdCheck.present) {
      const explicitAttemptId = attemptIdCheck.value;
      const attempt = task.attempts.find((a) => a.id === explicitAttemptId);
      if (!attempt) {
        return {
          status: 'incompatible',
          reason: `Entrega referencia tentativa inexistente (${explicitAttemptId}) na tarefa "${task.title}"; mantida para revisão manual.`,
        };
      }
      if (attempt.executorParticipantId !== executor.id) {
        return {
          status: 'incompatible',
          reason: `Tentativa ${explicitAttemptId} não pertence ao executor "${executor.displayName}"; mantida para revisão manual.`,
        };
      }

      const delEvtId = `evt_core_del_${task.id}_${attempt.id}`;
      if (
        attempt.status === 'delivered' &&
        attempt.id === latestAttempt?.id &&
        task.status === 'awaiting_review' &&
        proj.seenEventIds.includes(delEvtId)
      ) {
        return {
          status: 'duplicate',
          task,
          attempt,
          reason: `Reentrega duplicada da Tentativa #${attempt.attemptNumber} (${attempt.id}) já processada em "${task.title}".`,
        };
      }

      if (task.status !== 'running') {
        return {
          status: 'incompatible',
          reason: `Tarefa "${task.title}" está em estado "${task.status}" (não elegível para entrega de ${explicitAttemptId}); mantida para revisão manual.`,
        };
      }
      if (attempt.id !== latestAttempt?.id) {
        return {
          status: 'incompatible',
          reason: `Entrega tardia para tentativa antiga (${explicitAttemptId}) enquanto existe tentativa mais recente (${latestAttempt?.id ?? 'indefinida'}) em "${task.title}"; mantida para revisão manual.`,
        };
      }
      if (attempt.status !== 'running') {
        return {
          status: 'incompatible',
          reason: `Tentativa ${explicitAttemptId} está em estado "${attempt.status}" (esperado "running"); mantida para revisão manual.`,
        };
      }
      return { status: 'matched', task, attempt };
    }

    // attemptId omitted: require turn/dispatch proof when retries exist, and never bind stale turns to newer attempts
    const convKey = `${proj.conversation.id}:${executor.id}`;
    const normalizedTurnId = asNonEmptyString(turnId);
    const consumedBinding = normalizedTurnId
      ? this.consumedTurnBindings.get(`${convKey}:${normalizedTurnId}`)
      : undefined;
    const expectedDispatch = this.expectedDispatchByParticipant.get(convKey);

    if (consumedBinding) {
      if (
        consumedBinding.kind === 'delivery_report' &&
        consumedBinding.taskId === task.id &&
        consumedBinding.attemptId === latestAttempt?.id &&
        task.status === 'awaiting_review' &&
        latestAttempt?.status === 'delivered' &&
        proj.seenEventIds.includes(`evt_core_del_${task.id}_${latestAttempt.id}`)
      ) {
        return {
          status: 'duplicate',
          task,
          attempt: latestAttempt,
          reason: `Reentrega duplicada sem attemptId do turno ${normalizedTurnId} já processado em "${task.title}" (${latestAttempt.id}).`,
        };
      }
      return {
        status: 'incompatible',
        reason: `Entrega sem attemptId reutiliza turno anterior (${normalizedTurnId} vinculado a ${consumedBinding.attemptId}) incompatível com o estado atual de "${task.title}"; mantida para revisão manual.`,
      };
    }

    const allRunningAttempts = task.attempts.filter((a) => a.status === 'running');
    const runningForExecutor = allRunningAttempts.filter(
      (a) => a.executorParticipantId === executor.id,
    );

    if (
      task.attempts.length === 1 &&
      allRunningAttempts.length === 0 &&
      task.status === 'awaiting_review' &&
      latestAttempt &&
      latestAttempt.status === 'delivered' &&
      latestAttempt.executorParticipantId === executor.id &&
      proj.seenEventIds.includes(`evt_core_del_${task.id}_${latestAttempt.id}`)
    ) {
      return {
        status: 'duplicate',
        task,
        attempt: latestAttempt,
        reason: `Reentrega duplicada sem attemptId para a única entrega ativa (${latestAttempt.id}) de "${task.title}".`,
      };
    }

    if (task.status !== 'running') {
      return {
        status: 'incompatible',
        reason: `Entrega sem attemptId recebida com a tarefa "${task.title}" em estado "${task.status}" (esperado "running"); mantida para revisão manual.`,
      };
    }

    if (
      allRunningAttempts.length !== 1 ||
      runningForExecutor.length !== 1 ||
      !latestAttempt ||
      runningForExecutor[0].id !== latestAttempt.id
    ) {
      return {
        status: 'incompatible',
        reason: `Entrega sem attemptId não possui correlação inequívoca com uma única tentativa ativa mais recente em "${task.title}"; mantida para revisão manual.`,
      };
    }

    if (
      normalizedTurnId &&
      this.isTurnPrecedingAttemptStage(
        proj,
        executor.id,
        normalizedTurnId,
        'attempt_started',
        task.id,
        latestAttempt.id,
      )
    ) {
      return {
        status: 'incompatible',
        reason: `Entrega sem attemptId associada a turno anterior (${normalizedTurnId}) ao início da tentativa atual (${latestAttempt.id}) em "${task.title}"; mantida para revisão manual.`,
      };
    }

    if (
      expectedDispatch &&
      expectedDispatch.kind === 'delivery_report' &&
      expectedDispatch.taskId === task.id &&
      expectedDispatch.attemptId === latestAttempt.id &&
      expectedDispatch.turnId &&
      normalizedTurnId &&
      normalizedTurnId !== expectedDispatch.turnId
    ) {
      return {
        status: 'incompatible',
        reason: `Entrega sem attemptId chegou em turno (${normalizedTurnId}) divergente do turno esperado (${expectedDispatch.turnId}) para ${latestAttempt.id}; mantida para revisão manual.`,
      };
    }

    if (task.attempts.length > 1) {
      const provenByDispatchTurn = Boolean(
        normalizedTurnId &&
        expectedDispatch &&
        expectedDispatch.kind === 'delivery_report' &&
        expectedDispatch.taskId === task.id &&
        expectedDispatch.attemptId === latestAttempt.id &&
        expectedDispatch.turnId === normalizedTurnId,
      );
      if (!provenByDispatchTurn) {
        return {
          status: 'incompatible',
          reason: `Entrega sem attemptId em tarefa com histórico de retentativas (${task.attempts.length} tentativas) sem vínculo comprovado ao turno/despacho atual (${latestAttempt.id}); mantida para revisão manual.`,
        };
      }
    }

    return { status: 'matched', task, attempt: runningForExecutor[0] };
  }

  private correlateReviewDecision(
    proj: ConversationProjection,
    reviewer: Participant,
    decisionPayload: {
      taskId: unknown;
      attemptId?: unknown;
      decision: 'approved' | 'rejected';
    },
    turnId?: string,
  ):
    | { status: 'matched'; task: Task; attempt: TaskAttempt }
    | { status: 'duplicate'; task: Task; attempt: TaskAttempt; reason: string }
    | { status: 'incompatible'; reason: string } {
    if (!hasRole(reviewer, 'reviewer')) {
      return {
        status: 'incompatible',
        reason: `Participante "${reviewer.displayName}" não possui papel de auditor para registrar parecer estruturado.`,
      };
    }

    const taskId =
      typeof decisionPayload.taskId === 'string'
        ? decisionPayload.taskId.trim()
        : '';
    const task = taskId ? proj.tasks.find((t) => t.id === taskId) : undefined;
    if (!task) {
      return {
        status: 'incompatible',
        reason: `Parecer de auditoria referencia tarefa inexistente nesta conversa (${taskId || 'vazio'}); mantido para revisão manual sem alterar tarefas.`,
      };
    }

    if (task.reviewerParticipantId && task.reviewerParticipantId !== reviewer.id) {
      return {
        status: 'incompatible',
        reason: `Parecer enviado por "${reviewer.displayName}", mas a auditoria de "${task.title}" está atribuída a outro participante; mantido para revisão manual.`,
      };
    }

    const latestAttempt = task.attempts[task.attempts.length - 1];
    const hasRunningAttempt = task.attempts.some((a) => a.status === 'running');
    const attemptIdCheck = this.parseOptionalAttemptId(decisionPayload.attemptId);
    if (attemptIdCheck.present && !attemptIdCheck.valid) {
      return { status: 'incompatible', reason: attemptIdCheck.reason };
    }

    if (attemptIdCheck.present) {
      const explicitAttemptId = attemptIdCheck.value;
      const attempt = task.attempts.find((a) => a.id === explicitAttemptId);
      if (!attempt) {
        return {
          status: 'incompatible',
          reason: `Parecer de auditoria referencia tentativa inexistente (${explicitAttemptId}) na tarefa "${task.title}"; mantido para revisão manual.`,
        };
      }

      const revEvtId = `evt_core_rev_${task.id}_${attempt.id}`;
      if (
        !hasRunningAttempt &&
        attempt.id === latestAttempt?.id &&
        proj.seenEventIds.includes(revEvtId) &&
        task.reviews.some(
          (r) =>
            r.attemptId === attempt.id &&
            r.decision === decisionPayload.decision,
        )
      ) {
        return {
          status: 'duplicate',
          task,
          attempt,
          reason: `Parecer duplicado da Tentativa #${attempt.attemptNumber} (${attempt.id}) já processado em "${task.title}".`,
        };
      }

      if (hasRunningAttempt) {
        return {
          status: 'incompatible',
          reason: `Parecer para tentativa ${explicitAttemptId} rejeitado porque a tarefa "${task.title}" possui tentativa em execução; mantido para revisão manual.`,
        };
      }
      if (attempt.id !== latestAttempt?.id) {
        return {
          status: 'incompatible',
          reason: `Parecer tardio para tentativa antiga (${explicitAttemptId}) enquanto a tentativa atual de "${task.title}" é ${latestAttempt?.id ?? 'indefinida'}; mantido para revisão manual.`,
        };
      }
      if (task.status !== 'awaiting_review') {
        return {
          status: 'incompatible',
          reason: `Tarefa "${task.title}" está em estado "${task.status}" (esperado "awaiting_review" para aplicar parecer); mantido para revisão manual.`,
        };
      }
      if (attempt.status !== 'delivered') {
        return {
          status: 'incompatible',
          reason: `Tentativa ${explicitAttemptId} está em estado "${attempt.status}" (esperado "delivered"); mantido para revisão manual.`,
        };
      }
      if (task.reviews.some((r) => r.attemptId === attempt.id)) {
        return {
          status: 'incompatible',
          reason: `Tentativa ${explicitAttemptId} já possui parecer registrado em "${task.title}"; mantido para revisão manual.`,
        };
      }
      return { status: 'matched', task, attempt };
    }

    // attemptId omitted: require turn/dispatch proof when retries exist, and never bind stale review turns to newer attempts
    const convKey = `${proj.conversation.id}:${reviewer.id}`;
    const normalizedTurnId = asNonEmptyString(turnId);
    const consumedBinding = normalizedTurnId
      ? this.consumedTurnBindings.get(`${convKey}:${normalizedTurnId}`)
      : undefined;
    const expectedDispatch = this.expectedDispatchByParticipant.get(convKey);

    if (consumedBinding) {
      if (
        consumedBinding.kind === 'review_decision' &&
        consumedBinding.taskId === task.id &&
        consumedBinding.attemptId === latestAttempt?.id &&
        consumedBinding.decision === decisionPayload.decision &&
        !hasRunningAttempt &&
        proj.seenEventIds.includes(`evt_core_rev_${task.id}_${latestAttempt.id}`) &&
        task.reviews.some(
          (r) =>
            r.attemptId === latestAttempt.id &&
            r.decision === decisionPayload.decision,
        )
      ) {
        return {
          status: 'duplicate',
          task,
          attempt: latestAttempt,
          reason: `Parecer duplicado sem attemptId do turno ${normalizedTurnId} já processado em "${task.title}" (${latestAttempt.id}).`,
        };
      }
      return {
        status: 'incompatible',
        reason: `Parecer sem attemptId reutiliza turno anterior (${normalizedTurnId} vinculado a ${consumedBinding.attemptId}) incompatível com o estado atual de "${task.title}"; mantido para revisão manual.`,
      };
    }

    const activeOrDelivered = task.attempts.filter(
      (a) => a.status === 'delivered' || a.status === 'running',
    );

    if (
      task.attempts.length === 1 &&
      !hasRunningAttempt &&
      latestAttempt &&
      activeOrDelivered.length === 0 &&
      proj.seenEventIds.includes(`evt_core_rev_${task.id}_${latestAttempt.id}`) &&
      task.reviews.some(
        (r) =>
          r.attemptId === latestAttempt.id &&
          r.decision === decisionPayload.decision,
      ) &&
      (task.status === 'completed' ||
        task.status === 'changes_requested' ||
        task.status === 'blocked')
    ) {
      return {
        status: 'duplicate',
        task,
        attempt: latestAttempt,
        reason: `Parecer duplicado sem attemptId para a tentativa já auditada (${latestAttempt.id}) em "${task.title}".`,
      };
    }

    if (task.status !== 'awaiting_review') {
      return {
        status: 'incompatible',
        reason: `Parecer sem attemptId recebido com a tarefa "${task.title}" em estado "${task.status}" (esperado "awaiting_review"); mantido para revisão manual.`,
      };
    }

    if (
      !latestAttempt ||
      latestAttempt.status !== 'delivered' ||
      activeOrDelivered.length !== 1 ||
      activeOrDelivered[0].id !== latestAttempt.id
    ) {
      return {
        status: 'incompatible',
        reason: `Parecer sem attemptId não possui correlação inequívoca com uma única tentativa entregue pendente de auditoria em "${task.title}"; mantido para revisão manual.`,
      };
    }

    if (task.reviews.some((r) => r.attemptId === latestAttempt.id)) {
      return {
        status: 'incompatible',
        reason: `Tentativa mais recente (${latestAttempt.id}) já possui parecer registrado em "${task.title}"; mantido para revisão manual.`,
      };
    }

    if (
      normalizedTurnId &&
      this.isTurnPrecedingAttemptStage(
        proj,
        reviewer.id,
        normalizedTurnId,
        'attempt_delivered',
        task.id,
        latestAttempt.id,
      )
    ) {
      return {
        status: 'incompatible',
        reason: `Parecer sem attemptId associado a turno anterior (${normalizedTurnId}) à entrega da tentativa atual (${latestAttempt.id}) em "${task.title}"; mantido para revisão manual.`,
      };
    }

    if (
      expectedDispatch &&
      expectedDispatch.kind === 'review_decision' &&
      expectedDispatch.taskId === task.id &&
      expectedDispatch.attemptId === latestAttempt.id &&
      expectedDispatch.turnId &&
      normalizedTurnId &&
      normalizedTurnId !== expectedDispatch.turnId
    ) {
      return {
        status: 'incompatible',
        reason: `Parecer sem attemptId chegou em turno (${normalizedTurnId}) divergente do turno esperado de auditoria (${expectedDispatch.turnId}) para ${latestAttempt.id}; mantido para revisão manual.`,
      };
    }

    if (task.attempts.length > 1) {
      const provenByDispatchTurn = Boolean(
        normalizedTurnId &&
        expectedDispatch &&
        expectedDispatch.kind === 'review_decision' &&
        expectedDispatch.taskId === task.id &&
        expectedDispatch.attemptId === latestAttempt.id &&
        expectedDispatch.turnId === normalizedTurnId,
      );
      if (!provenByDispatchTurn) {
        return {
          status: 'incompatible',
          reason: `Parecer sem attemptId em tarefa com histórico de retentativas (${task.attempts.length} tentativas) sem vínculo comprovado ao despacho/turno atual de auditoria (${latestAttempt.id}); mantido para revisão manual.`,
        };
      }
    }

    return { status: 'matched', task, attempt: latestAttempt };
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
    preCorrelated?: { task: Task; attempt: TaskAttempt },
  ): void {
    if (!this.state) return;
    let proj = this.state.conversations[convId];
    if (!proj) return;
    const now = new Date().toISOString();

    const matched =
      preCorrelated ??
      (() => {
        const corr = this.correlateDeliveryReport(proj, executor, report);
        return corr.status === 'matched' ? { task: corr.task, attempt: corr.attempt } : undefined;
      })();
    if (!matched) return;

    const { task, attempt } = matched;
    const delEvtId = `evt_core_del_${task.id}_${attempt.id}`;
    if (proj.seenEventIds.includes(delEvtId)) return;

    this.markWsTaskMutation(convId, task.id);
    this.emitAndIngest(convId, {
      id: delEvtId,
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
    const attemptCtx = proj.contextRevisions.find(
      (r) => r.id === attempt.contextRevisionId,
    );
    if (attemptCtx) {
      this.emitContextReceiptApplied({
        convId,
        participant: executor,
        revisionId: attemptCtx.id,
        origin: 'executor',
        taskId: task.id,
        attemptId: attempt.id,
        mechanismNote: `Contexto v${attemptCtx.versionNumber} correlacionado à entrega da Tentativa #${attempt.attemptNumber} (${executor.displayName}).`,
        eventSuffix: attempt.id,
      });
    }

    if (
      this.state.conversations[convId]?.conversation.executionStatus ===
      'paused_queue'
    ) {
      return;
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
    preCorrelated?: { task: Task; attempt: TaskAttempt },
  ): void {
    if (!this.state) return;
    let proj = this.state.conversations[convId];
    if (!proj) return;
    const now = new Date().toISOString();

    const matched =
      preCorrelated ??
      (() => {
        const corr = this.correlateReviewDecision(proj, reviewer, decisionPayload);
        return corr.status === 'matched' ? { task: corr.task, attempt: corr.attempt } : undefined;
      })();
    if (!matched) return;

    const { task, attempt } = matched;

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
      if (
        updatedTask.attempts.length >= MAX_CORE_TASK_ATTEMPTS ||
        updatedTask.qualityRejectionCount >= MAX_CORE_TASK_ATTEMPTS
      ) {
        this.emitAndIngest(convId, {
          id: `evt_core_limit_${updatedTask.id}_${updatedTask.attempts.length}`,
          seq: this.nextLocalSeq(proj),
          conversationId: convId,
          timestamp: now,
          origin: 'system',
          originSource: 'aion_core',
          participantId: reviewer.id,
          taskId: updatedTask.id,
          attemptId: attempt.id,
          type: 'task_status_changed',
          payload: {
            taskId: updatedTask.id,
            nextStatus: 'blocked',
            participantStatus: 'blocked',
            projectToGeneral: true,
            generalSummary: `Limite de ${MAX_CORE_TASK_ATTEMPTS} tentativas/reprovações atingido em "${updatedTask.title}". Retentativa automática interrompida; aguardando intervenção manual.`,
          },
        });
        return;
      }

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
      let autoEscalatedModelId: string | undefined;

      if (
        executor &&
        !alreadyEscalated &&
        updatedTask.qualityRejectionCount >=
        policy.qualityRejectionsBeforeSuggest &&
        currentTier !== targetTier
      ) {
        const escId = `esc_core_${updatedTask.id}_${updatedTask.qualityRejectionCount}`;
        const escEvtId = `evt_core_esc_${escId}`;
        const executorConn = this.state.connections.find(
          (c) => c.id === executor.connectionId,
        );
        const promotedRef: ModelRef = resolveCoreEscalationModelRef(
          executorConn,
          executor.modelRef,
          targetTier,
        );

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
              expectedEffect: `Promover ${executor.displayName} para ${promotedRef.displayName} na próxima tentativa.`,
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
        autoEscalatedModelId = promotedRef.externalId?.trim();
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

      if (proj.conversation.executionStatus === 'paused_queue') {
        return;
      }

      const nextSlotId = executor?.sessionRef.externalSlotId;
      const teamId = proj?.conversation.externalTeamId;
      this.enqueueBackgroundWork(async () => {
        if (autoEscalatedModelId && teamId && nextSlotId) {
          await this.syncCoreParticipantModel(teamId, nextSlotId, autoEscalatedModelId);
        }
        await this.dispatchTaskAttemptInCore(convId, updatedTask.id);
      });
      return;
    }

    if (proj.conversation.executionStatus === 'paused_queue') {
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
    if (proj.conversation.executionStatus === 'paused_queue') return;
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
    const slotDispatchKey = `${convId}:${executor.sessionRef.externalSlotId}`;
    if (this.inFlightSlotDispatches.has(slotDispatchKey)) return;
    this.inFlightSlotDispatches.add(slotDispatchKey);
    try {

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
      this.expectedDispatchByParticipant.set(`${convId}:${executor.id}`, {
        kind: 'delivery_report',
        taskId: latestTask.id,
        attemptId,
        contextRevisionId: latestCtx?.id,
      });
      const path = `/api/teams/${encodeURIComponent(teamId)}/agents/${encodeURIComponent(executor.sessionRef.externalSlotId)}/messages`;
      const body: SendAgentMessageRequest = { content };
      const sendInitiatedEventIndex =
        this.state.conversations[convId]?.eventLog.length ?? proj.eventLog.length;
      let rawAck: unknown;
      try {
        rawAck = await this.httpClient.requestJson<unknown>({
          method: 'POST',
          path,
          body,
          idempotent: false,
          operationName: 'core.dispatchTaskAttempt',
          teamId,
          slotId: executor.sessionRef.externalSlotId,
        });
      } catch (err) {
        if (latestCtx) {
          this.emitContextReceiptFailed({
            convId,
            participant: executor,
            revision: latestCtx,
            taskId: latestTask.id,
            attemptId,
            reason:
              err instanceof Error ? err.message : 'erro de comunicação com o Core',
          });
        }
        throw err;
      }
      const ack = unwrapApiResponse<TeamRunAckResponse>(
        rawAck,
        `POST ${path}`,
        (d): d is TeamRunAckResponse =>
          isRecord(d) &&
          typeof d.message_id === 'string' &&
          typeof d.enqueue_status === 'string',
      );

      if (latestCtx) {
        this.emitContextReceiptSent({
          convId,
          participant: executor,
          revision: latestCtx,
          messageId: ack.message_id,
          sendInitiatedEventIndex,
          taskId: latestTask.id,
          attemptId,
          mechanismNote: `Contexto v${latestCtx.versionNumber} enviado na Tentativa #${attemptNumber} (msg ${ack.message_id}); aguardando confirmação.`,
        });
      }
    } finally {
      this.inFlightSlotDispatches.delete(slotDispatchKey);
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
    if (proj.conversation.executionStatus === 'paused_queue') return;
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
    const reviewDispatchKey = `${convId}:review:${reviewer.sessionRef.externalSlotId}`;
    if (this.inFlightSlotDispatches.has(reviewDispatchKey)) return;
    this.inFlightSlotDispatches.add(reviewDispatchKey);
    try {

      const latestCtxBeforeReview = getLatestContextRevision(proj);
      const content = this.composeCoreOutgoingContent({
        proj,
        targetParticipant: reviewer,
        userMarkdown: `Audite os arquivos reais, diff e testes observados no workspace da tarefa "${task.title}" (${attempt ? `Tentativa #${attempt.attemptNumber}` : attemptId}). Não aprove apenas pela afirmação do executor — verifique os critérios contra o estado real do repositório.\nResumo declarado: ${deliverySummary}\nEvidências declaradas:\n${evidenceNotes.map((n) => `- ${n}`).join('\n')}\n\nResponda com \`\`\`aion-desk-json\`\`\` de review_decision.`,
        expectedKind: 'review_decision',
        task,
        attempt,
      });

      this.expectedKindByParticipant.set(
        `${convId}:${reviewer.id}`,
        'review_decision',
      );
      this.expectedDispatchByParticipant.set(`${convId}:${reviewer.id}`, {
        kind: 'review_decision',
        taskId: task.id,
        attemptId,
        contextRevisionId: latestCtxBeforeReview?.id,
      });
      const path = `/api/teams/${encodeURIComponent(teamId)}/agents/${encodeURIComponent(reviewer.sessionRef.externalSlotId)}/messages`;
      const body: SendAgentMessageRequest = { content };
      const sendInitiatedEventIndex =
        this.state.conversations[convId]?.eventLog.length ?? proj.eventLog.length;
      let rawAck: unknown;
      try {
        rawAck = await this.httpClient.requestJson<unknown>({
          method: 'POST',
          path,
          body,
          idempotent: false,
          operationName: 'core.dispatchReview',
          teamId,
          slotId: reviewer.sessionRef.externalSlotId,
        });
      } catch (err) {
        if (latestCtxBeforeReview) {
          this.emitContextReceiptFailed({
            convId,
            participant: reviewer,
            revision: latestCtxBeforeReview,
            taskId: task.id,
            attemptId,
            reason:
              err instanceof Error ? err.message : 'erro de comunicação com o Core',
          });
        }
        throw err;
      }
      const ack = unwrapApiResponse<TeamRunAckResponse>(
        rawAck,
        `POST ${path}`,
        (d): d is TeamRunAckResponse =>
          isRecord(d) &&
          typeof d.message_id === 'string' &&
          typeof d.enqueue_status === 'string',
      );

      if (latestCtxBeforeReview) {
        this.emitContextReceiptSent({
          convId,
          participant: reviewer,
          revision: latestCtxBeforeReview,
          messageId: ack.message_id,
          sendInitiatedEventIndex,
          taskId: task.id,
          attemptId,
          mechanismNote: `Contexto v${latestCtxBeforeReview.versionNumber} enviado ao auditor ${reviewer.displayName} para revisão (msg ${ack.message_id}).`,
        });
      }
    } finally {
      this.inFlightSlotDispatches.delete(reviewDispatchKey);
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
      : {
        ...preset,
        members: resolvePresetMembersForCore(state, preset.members),
      };

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
      preset: {
        ...preset,
        members: resolvePresetMembersForCore(state, preset.members),
      },
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

  private async syncCoreParticipantModel(
    teamId: string,
    slotId: string,
    modelId: string,
  ): Promise<void> {
    await this.httpClient.requestJson({
      method: 'PATCH',
      path: `/api/teams/${encodeURIComponent(teamId)}/agents/${encodeURIComponent(slotId)}/model`,
      body: { model_id: modelId },
      idempotent: true,
      operationName: 'core.updateAgentModel',
      teamId,
      slotId,
    });
  }

  async configureParticipant(input: ConfigureParticipantInput): Promise<void> {
    const state = this.getStateSnapshot();
    const proj = state.conversations[input.conversationId];
    if (!proj) return;
    const target = proj.participants.find((p) => p.id === input.participantId);
    if (!target) return;

    const teamId = proj.conversation.externalTeamId;
    const slotId = target.sessionRef.externalSlotId;
    if (
      proj.conversation.executionMode === 'aion_core' &&
      teamId &&
      slotId
    ) {
      if (input.modelRef) {
        const nextModelId =
          input.modelRef.externalId?.trim() || input.modelRef.displayName.trim();
        const prevModelId =
          target.modelRef.externalId?.trim() || target.modelRef.displayName.trim();
        if (nextModelId && nextModelId !== prevModelId) {
          await this.syncCoreParticipantModel(teamId, slotId, nextModelId);
        }
      }
      if (
        input.displayName &&
        input.displayName.trim() &&
        input.displayName.trim() !== target.displayName
      ) {
        await this.httpClient.requestJson({
          method: 'PATCH',
          path: `/api/teams/${encodeURIComponent(teamId)}/agents/${encodeURIComponent(slotId)}/name`,
          body: { name: input.displayName.trim() },
          idempotent: true,
          operationName: 'core.renameAgent',
          teamId,
          slotId,
        });
      }
    }
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

    const activeParticipantCount = proj.participants.filter(
      (p) => !p.archived,
    ).length;
    let expectedKind: StructuredEnvelopeKind | undefined;
    if (
      activeParticipantCount > 1 &&
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

    const ctxAtSend = getLatestContextRevision(proj);
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
    const sendInitiatedEventIndex =
      this.state?.conversations[input.conversationId]?.eventLog.length ??
      proj.eventLog.length;

    let rawAck: unknown;
    try {
      rawAck = await this.httpClient.requestJson<unknown>({
        method: 'POST',
        path,
        body,
        idempotent: false,
        operationName: isGeneral ? 'core.sendTeamMessage' : 'core.sendAgentMessage',
        teamId,
        slotId: targetParticipant.sessionRef.externalSlotId,
      });
    } catch (err) {
      if (ctxAtSend) {
        this.emitContextReceiptFailed({
          convId: input.conversationId,
          participant: targetParticipant,
          revision: ctxAtSend,
          reason:
            err instanceof Error ? err.message : 'erro de comunicação com o Core',
        });
      }
      throw err;
    }

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
    if (!this.isExternalMessageAlreadyStored(latestProj, ack.message_id)) {
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
    }

    if (ctxAtSend) {
      this.emitContextReceiptSent({
        convId: input.conversationId,
        participant: targetParticipant,
        revision: ctxAtSend,
        messageId: ack.message_id,
        sendInitiatedEventIndex,
        mechanismNote: `Contexto v${ctxAtSend.versionNumber} incluído e enfileirado na mensagem ${ack.message_id} para ${targetParticipant.displayName} (não comprova aplicação imediata).`,
      });
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

    if (
      input.action === 'resume_queue' &&
      teamId &&
      proj.conversation.executionStatus === 'paused_queue'
    ) {
      const reconcileResult = await this.reconcileConversation(
        input.conversationId,
      );
      if (!reconcileResult.synced) {
        throw new GatewayCapabilityError(
          'OPERATION_FAILED',
          'Não foi possível retomar o fluxo porque a reconciliação com o Core ficou incompleta. Verifique conexão/autenticação e reconcilie novamente.',
          true,
        );
      }

      const reconciledProj =
        this.getStateSnapshot().conversations[input.conversationId];
      if (!reconciledProj) return;

      const slotWorkMap =
        this.lastReconciledSlotWorkByConv.get(input.conversationId) ??
        new Map<string, string>();
      const isSlotBusyInCore = (slotId?: string): boolean => {
        if (!slotId) return false;
        const st = slotWorkMap.get(slotId);
        return st === 'running' || st === 'starting' || st === 'queued';
      };

      const anySlotBusy = Array.from(slotWorkMap.values()).some(
        (st) => st === 'running' || st === 'starting' || st === 'queued',
      );

      const pendingReviewTask = reconciledProj.tasks.find((t) => {
        if (t.status !== 'awaiting_review') return false;
        const lastAttempt = t.attempts[t.attempts.length - 1];
        if (!lastAttempt || lastAttempt.status !== 'delivered') return false;
        return !t.reviews.some((r) => r.attemptId === lastAttempt.id);
      });

      const pendingCorrectionTask = reconciledProj.tasks.find(
        (t) =>
          t.status === 'changes_requested' &&
          !t.attempts.some((a) => a.status === 'running') &&
          !reconciledProj.escalations.some(
            (e) => e.taskId === t.id && e.status === 'suggested',
          ) &&
          areTaskDependenciesSatisfied(t, reconciledProj.tasks).satisfied,
      );

      const pendingRunnableTask = reconciledProj.tasks.find(
        (t) =>
          (t.status === 'planned' || t.status === 'queued') &&
          !t.attempts.some((a) => a.status === 'running') &&
          !reconciledProj.escalations.some(
            (e) => e.taskId === t.id && e.status === 'suggested',
          ) &&
          areTaskDependenciesSatisfied(t, reconciledProj.tasks).satisfied,
      );

      const allTasksCompleted =
        reconciledProj.tasks.length > 0 &&
        reconciledProj.tasks.every((t) => t.status === 'completed');
      const hasFailedTask = reconciledProj.tasks.some(
        (t) => t.status === 'failed',
      );
      const hasBlockedOrStuck = reconciledProj.tasks.some(
        (t) =>
          t.status === 'blocked' ||
          ((t.status === 'queued' ||
            t.status === 'planned' ||
            t.status === 'changes_requested') &&
            (!areTaskDependenciesSatisfied(t, reconciledProj.tasks).satisfied ||
              reconciledProj.escalations.some(
                (e) => e.taskId === t.id && e.status === 'suggested',
              ))),
      );
      const hasRunningTask = reconciledProj.tasks.some(
        (t) => t.status === 'running',
      );

      const nextExecutionStatus: WorkspaceConversation['executionStatus'] =
        allTasksCompleted
          ? 'completed'
          : anySlotBusy ||
            hasRunningTask ||
            Boolean(pendingReviewTask) ||
            Boolean(pendingCorrectionTask) ||
            Boolean(pendingRunnableTask)
            ? 'running'
            : hasFailedTask
              ? 'failed'
              : hasBlockedOrStuck
                ? 'blocked'
                : 'idle';

      this.emitAndIngest(input.conversationId, {
        id: this.nextId('evt'),
        seq: this.nextLocalSeq(reconciledProj),
        conversationId: input.conversationId,
        timestamp: new Date().toISOString(),
        origin: 'user',
        originSource: 'aion_core',
        type: 'execution_control_applied',
        payload: {
          control: 'resume_queue',
          nextExecutionStatus,
          generalSummary: allTasksCompleted
            ? 'Fluxo reconciliado e retomado: todas as tarefas já haviam sido concluídas no Core (nenhum pedido repetido).'
            : anySlotBusy
              ? 'Fluxo local retomado após reconciliação: aguardando conclusão de turno já em andamento no Core (sem duplicar despacho).'
              : 'Fluxo local retomado após reconciliação com o Core (sem repetir o pedido original).',
        },
      });

      if (allTasksCompleted) {
        await this.dispatchNextRunnableTaskInCore(input.conversationId);
        return;
      }

      if (pendingReviewTask) {
        const lastAttempt =
          pendingReviewTask.attempts[pendingReviewTask.attempts.length - 1];
        const roles = resolveTeamRoles(
          reconciledProj.participants,
          reconciledProj.conversation.coordinatorParticipantId,
        );
        const reviewer =
          (pendingReviewTask.reviewerParticipantId
            ? reconciledProj.participants.find(
              (p) =>
                p.id === pendingReviewTask.reviewerParticipantId &&
                !p.archived,
            )
            : undefined) ??
          roles.reviewer ??
          roles.coordinator;
        if (lastAttempt && !isSlotBusyInCore(reviewer?.sessionRef.externalSlotId)) {
          await this.dispatchReviewInCore(
            input.conversationId,
            pendingReviewTask.id,
            lastAttempt.id,
            lastAttempt.deliverySummary ?? 'Entrega recuperada via catch-up do Core.',
            lastAttempt.evidenceNotes ?? [],
          );
        }
        return;
      }

      if (pendingCorrectionTask) {
        const executor = reconciledProj.participants.find(
          (p) =>
            p.id === pendingCorrectionTask.assigneeParticipantId && !p.archived,
        );
        if (!isSlotBusyInCore(executor?.sessionRef.externalSlotId)) {
          await this.dispatchTaskAttemptInCore(
            input.conversationId,
            pendingCorrectionTask.id,
          );
        }
        return;
      }

      if (!anySlotBusy && !hasRunningTask && pendingRunnableTask) {
        await this.dispatchNextRunnableTaskInCore(input.conversationId);
      }
      return;
    }

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
      const slotId = target?.sessionRef.externalSlotId;
      const slotWork = slotId
        ? runState.slot_work.find((s) => s.slot_id === slotId)
        : undefined;
      const activeRunId = slotWork?.team_run_id ?? runState.active_run?.team_run_id;
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
        const latestProj = this.state?.conversations[input.conversationId];
        if (latestProj) {
          this.emitAndIngest(input.conversationId, {
            id: this.nextId('evt'),
            seq: this.nextLocalSeq(latestProj),
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
        }
        return;
      }
      if (slotId) {
        throw new GatewayCapabilityError(
          'OPERATION_FAILED',
          `Nenhum turno ativo encontrado no AionCore para interromper (${target?.displayName ?? slotId}).`,
          true,
        );
      }
    }

    throw new GatewayCapabilityError(
      'CAPABILITY_UNSUPPORTED',
      `Ação "${input.action}" não é suportada pelo protocolo atual do AionCore v0.2.2.`,
      true,
    );
  }

  async respondPermission(input: {
    conversationId: string;
    requestId: string;
    decision: 'approved' | 'denied';
  }): Promise<void> {
    const state = this.getStateSnapshot();
    const proj = state.conversations[input.conversationId];
    if (!proj) {
      throw new GatewayCapabilityError(
        'CONVERSATION_NOT_FOUND',
        'Conversa não encontrada para responder permissão.',
      );
    }

    const perm = proj.permissions.find((p) => p.id === input.requestId);
    if (!perm || perm.status !== 'pending') {
      return;
    }

    const pendingMeta = this.pendingCoreConfirmations.get(input.requestId);
    const participant = proj.participants.find((p) => p.id === perm.participantId);
    const extConvId =
      pendingMeta?.extConvId ?? participant?.sessionRef.externalConversationId;
    if (!extConvId) {
      throw new GatewayCapabilityError(
        'NOT_CONNECTED_LOCAL_CORE',
        'Participante sem conversa externa ativa no Core para confirmar permissão.',
        true,
      );
    }

    const callId =
      pendingMeta?.callId ??
      (perm.scopeKey.includes(':') ? perm.scopeKey.split(':').slice(1).join(':') : perm.id);
    const msgId = pendingMeta?.msgId ?? callId;
    const confirmData =
      input.decision === 'approved'
        ? (pendingMeta?.allowData ?? 'allow')
        : (pendingMeta?.denyData ?? 'reject');

    await this.httpClient.requestJson<unknown>({
      method: 'POST',
      path: `/api/conversations/${encodeURIComponent(extConvId)}/confirmations/${encodeURIComponent(callId)}/confirm`,
      body: {
        msg_id: msgId,
        data: confirmData,
        always_allow: false,
      },
      idempotent: false,
      operationName: 'core.confirmPermission',
      teamId: proj.conversation.externalTeamId,
      slotId: participant?.sessionRef.externalSlotId,
    });

    this.pendingCoreConfirmations.delete(input.requestId);
    const latestProj = this.getStateSnapshot().conversations[input.conversationId] ?? proj;
    const now = new Date().toISOString();
    const evtId = `evt_core_perm_dec_${input.conversationId}_${callId}_${input.decision}`;
    if (!latestProj.seenEventIds.includes(evtId)) {
      this.emitAndIngest(input.conversationId, {
        id: evtId,
        seq: this.nextLocalSeq(latestProj),
        conversationId: input.conversationId,
        timestamp: now,
        origin: 'user',
        originSource: 'aion_core',
        participantId: perm.participantId,
        taskId: perm.taskId,
        type: 'permission_decided',
        payload: {
          decision: {
            requestId: perm.id,
            decision: input.decision,
            decidedBy: 'Você',
            note:
              input.decision === 'approved'
                ? 'Permitido via POST /confirmations/.../confirm no AionCore.'
                : 'Recusado via POST /confirmations/.../confirm no AionCore.',
            decidedAt: now,
          },
          generalSummary: `Permissão "${perm.actionTitle}" ${input.decision === 'approved' ? 'aprovada' : 'recusada'} no AionCore.`,
        },
      });
    }
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

    if (input.resolution === 'approved' && esc.toModelRef) {
      const targetPart = proj.participants.find((p) => p.id === esc.participantId);
      const teamId = proj.conversation.externalTeamId;
      const slotId = targetPart?.sessionRef.externalSlotId;
      const nextModelId = esc.toModelRef.externalId?.trim();
      const prevModelId = esc.fromModelRef?.externalId?.trim();
      if (teamId && slotId && nextModelId && nextModelId !== prevModelId) {
        await this.syncCoreParticipantModel(teamId, slotId, nextModelId);
      }
    }

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
    const ok = row.status === 'online' || row.status === 'ready';
    const message = ok
      ? row.status === 'ready'
        ? `Agente "${row.name}" pronto no AionCore (${row.last_check_latency_ms ?? 0}ms).`
        : `Agente "${row.name}" online no AionCore (${row.last_check_latency_ms ?? 0}ms). Health-check confirma CLI responsiva; login no provedor é validado ao executar um turno.`
      : `Agente "${row.name}" em estado "${row.status}": ${row.last_check_error_message ?? row.last_check_guidance ?? 'requer verificação local'}.`;
    const discoveredModels = [
      ...extractAvailableModelOptions(row.available_models),
      ...extractModelsFromConfigOptions(row.config_options),
    ];
    const latestState = this.state ?? state;
    const nextConnections = latestState.connections.map((c) =>
      c.id === connectionId
        ? {
          ...c,
          coreReachability: 'reachable' as const,
          executableStatus: row.installed
            ? ('verified' as const)
            : ('missing' as const),
          coreAgentStatus: row.status,
          authStatus: mapCoreAgentStatusToAuthStatus(row.status),
          availableModels:
            discoveredModels.length > 0
              ? mergeConfirmedModels(c.availableModels, discoveredModels, 'core_catalog')
              : c.availableModels,
          lastConnectionTestAt: testedAt,
          lastConnectionTestResult: message,
        }
        : c,
    );
    this.state = {
      ...latestState,
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
    let authExpiredDetected = false;
    let teamNotFoundDetected = false;
    let coreUnreachableDetected = false;
    const inspectFailureReason = (reason: unknown): void => {
      if (reason instanceof GatewayCapabilityError) {
        if (reason.code === 'AUTH_REQUIRED' || reason.httpStatus === 401) {
          authExpiredDetected = true;
        } else if (reason.httpStatus === 404) {
          teamNotFoundDetected = true;
        } else if (reason.code === 'NOT_CONNECTED_LOCAL_CORE') {
          coreUnreachableDetected = true;
        }
      } else if (reason instanceof Error) {
        const lower = reason.message.toLowerCase();
        if (lower.includes('401') || lower.includes('expirada') || lower.includes('autenticação')) {
          authExpiredDetected = true;
        } else if (lower.includes('404')) {
          teamNotFoundDetected = true;
        }
      }
    };

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
    const slotWorkStateById = new Map<string, string>();
    if (runStateRes.status === 'fulfilled') {
      try {
        const runState = unwrapFlexibleData(
          runStateRes.value,
        ) as TeamRunStateResponse;
        if (!isRecord(runState) || !Array.isArray(runState.slot_work)) {
          throw new Error('Formato inválido de /run-state');
        }
        for (const s of runState.slot_work) {
          if (typeof s.slot_id === 'string' && typeof s.state === 'string') {
            slotWorkStateById.set(s.slot_id, s.state);
          }
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
      inspectFailureReason(runStateRes.reason);
      failedEndpoints.push('/run-state');
    }
    this.lastReconciledSlotWorkByConv.set(conversationId, slotWorkStateById);

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
      inspectFailureReason(mailboxRes.reason);
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
      inspectFailureReason(tasksRes.reason);
      failedEndpoints.push('/tasks');
    }

    // 4. Activity catch-up (`TeamActivityPageResponse` -> `TeamActivityItemResponse[]`)
    if (activityResult.failed) {
      if (activityResult.failureReason) {
        inspectFailureReason(new Error(activityResult.failureReason));
      }
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

    // 5. Slot conversation recovery if a WS drop missed a turn finish while a buffer or task was in-flight
    const latestProjForSlotCatchup = this.getStateSnapshot().conversations[conversationId];
    if (latestProjForSlotCatchup) {
      for (const participant of latestProjForSlotCatchup.participants) {
        if (participant.archived) continue;
        const extConvId = participant.sessionRef.externalConversationId;
        if (!extConvId) continue;

        const slotState = participant.sessionRef.externalSlotId
          ? slotWorkStateById.get(participant.sessionRef.externalSlotId)
          : undefined;
        if (
          slotState === 'running' ||
          slotState === 'queued' ||
          slotState === 'starting'
        ) {
          continue;
        }

        const hasOpenBuffer = Array.from(this.streamBuffers.values()).some(
          (buf) =>
            buf.conversationId === conversationId &&
            buf.participantId === participant.id &&
            !buf.finished,
        );
        const hasPendingTaskWork = latestProjForSlotCatchup.tasks.some(
          (t) =>
            (t.status === 'running' &&
              t.assigneeParticipantId === participant.id) ||
            (t.status === 'awaiting_review' &&
              t.reviewerParticipantId === participant.id),
        );
        const tabMessagesForParticipant =
          participant.id ===
            latestProjForSlotCatchup.conversation.coordinatorParticipantId
            ? [
              ...(latestProjForSlotCatchup.messagesByTab.general ?? []),
              ...(latestProjForSlotCatchup.messagesByTab[participant.id] ?? []),
            ]
            : (latestProjForSlotCatchup.messagesByTab[participant.id] ?? []);
        const lastTabMsg =
          tabMessagesForParticipant[tabMessagesForParticipant.length - 1];
        const hasUnansweredPausedTurn =
          latestProjForSlotCatchup.conversation.executionStatus ===
          'paused_queue' &&
          (participant.status === 'running' ||
            (lastTabMsg?.authorType === 'user' &&
              lastTabMsg.delivery?.status === 'enqueued_core' &&
              lastTabMsg.delivery?.targetParticipantId === participant.id));
        if (!hasOpenBuffer && !hasPendingTaskWork && !hasUnansweredPausedTurn) {
          continue;
        }

        try {
          const convRaw = await this.httpClient.requestJson<unknown>({
            method: 'GET',
            path: `/api/conversations/${encodeURIComponent(extConvId)}/messages?limit=15`,
            idempotent: true,
            operationName: 'core.reconcileSlotMessages',
            teamId,
          });
          const convData = unwrapFlexibleData(convRaw);
          if (!isRecord(convData) || !Array.isArray(convData.items)) continue;
          const items = convData.items.filter(isRecord);
          let lastRightIdx = -1;
          for (let idx = items.length - 1; idx >= 0; idx -= 1) {
            if (items[idx].position === 'right') {
              lastRightIdx = idx;
              break;
            }
          }
          const trailingTextItems = items
            .slice(lastRightIdx + 1)
            .filter(
              (it) =>
                it.position === 'left' &&
                it.hidden !== true &&
                it.type === 'text' &&
                it.status === 'finish' &&
                isRecord(it.content) &&
                typeof it.content.content === 'string' &&
                it.content.content.trim().length > 0,
            );
          if (trailingTextItems.length === 0) continue;

          const latestProjCheck = this.getStateSnapshot().conversations[conversationId];
          if (!latestProjCheck) continue;
          const anyStored = trailingTextItems.some((it) => {
            const id = asNonEmptyString(it.msg_id) ?? asNonEmptyString(it.id);
            return id ? this.isExternalMessageAlreadyStored(latestProjCheck, id) : false;
          });
          if (anyStored) continue;

          const mergedBody = trailingTextItems
            .map((it) => String((it.content as Record<string, unknown>).content))
            .join('\n\n')
            .trim();
          const lastItem = trailingTextItems[trailingTextItems.length - 1];
          const firstItem = trailingTextItems[0];
          const recoveryMsgId =
            asNonEmptyString(lastItem.msg_id) ??
            asNonEmptyString(lastItem.id) ??
            asNonEmptyString(firstItem.msg_id) ??
            asNonEmptyString(firstItem.id);
          if (!mergedBody || !recoveryMsgId) continue;
          const createdMs = toFiniteMs(lastItem.created_at);
          const recoveryTimestamp =
            createdMs !== undefined ? new Date(createdMs).toISOString() : undefined;
          const recoveryTurnId = asNonEmptyString(lastItem.backend_turn_id);

          this.closeUnfinishedStreamBuffersForTurn(conversationId, participant.id);
          const beforeLen = latestProjCheck.eventLog.length;
          this.finalizeCoreAgentMessage({
            convId: conversationId,
            participant,
            fullText: mergedBody,
            extMsgId: recoveryMsgId,
            turnId: recoveryTurnId,
            externalEventName: 'catchup.slot_messages',
            timestamp: recoveryTimestamp,
          });
          const afterProj = this.getStateSnapshot().conversations[conversationId];
          if (afterProj && afterProj.eventLog.length > beforeLen) {
            recoveredEvents.push(...afterProj.eventLog.slice(beforeLen));
          }
        } catch (err) {
          inspectFailureReason(err);
          // Best-effort slot conversation catch-up; do not overwrite main endpoint status if empty.
        }
      }
    }

    if (authExpiredDetected) {
      this.markCoreSessionExpired(
        'Sessão expirada no Core durante a reconciliação. Faça login novamente.',
      );
    }

    const finalState = this.getStateSnapshot();
    const finalProj = finalState.conversations[conversationId]!;
    const pendingOutOfOrderCount = Object.keys(
      finalProj.pendingOutOfOrder ?? {},
    ).length;

    const synced =
      failedEndpoints.length === 0 &&
      unresolvedIdentities.size === 0 &&
      malformedItems.count === 0 &&
      pendingOutOfOrderCount === 0;
    const issueParts: string[] = [];
    if (authExpiredDetected) {
      issueParts.push('sessão expirada no Core — faça login novamente');
    } else if (teamNotFoundDetected) {
      issueParts.push(
        'equipe não encontrada no Core (verifique se o Core foi reiniciado com outro banco ou vincule novamente)',
      );
    } else if (coreUnreachableDetected) {
      issueParts.push('Core inacessível');
    }
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
    if (pendingOutOfOrderCount > 0) {
      issueParts.push(
        `${pendingOutOfOrderCount} evento(s) fora de ordem pendente(s) de reconciliação`,
      );
    }

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
    this.clearRuntimeCaches();
    this.state = nextState;
    await this.persistence.resetAndSave(nextState);
    for (const listener of this.stateListeners) {
      listener(nextState);
    }
  }
}

export { DEFAULT_PARTICIPANT_PROFILES };
