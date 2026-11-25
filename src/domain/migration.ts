import { APP_BRAND } from '../config/brand';
import {
  connectionsToAgentProfiles,
  DEFAULT_CONNECTIONS,
  DEFAULT_PARTICIPANT_PROFILES,
  DEFAULT_TEAM_PRESETS,
  makeDemoModelRef,
} from './presets';
import { getPrimaryRole } from './teamValidation';
import type {
  AgentProfile,
  ConnectionAdapterConfig,
  ConversationProjection,
  DemoModelTier,
  ModelRef,
  Participant,
  ParticipantProfile,
  ParticipantRole,
  PermissionRequest,
  TeamPreset,
  VerticeAssistantMessage,
  VerticeAssistantState,
  WorkspaceStoreState,
} from './types';

export class IncompatibleSchemaError extends Error {
  readonly foundVersion: number;
  readonly supportedVersion: number;

  constructor(foundVersion: number, supportedVersion: number) {
    super(
      `Schema incompatível (versão ${foundVersion}; este aplicativo suporta até a versão ${supportedVersion}). Exporte ou atualize o aplicativo antes de carregar estes dados.`,
    );
    this.name = 'IncompatibleSchemaError';
    this.foundVersion = foundVersion;
    this.supportedVersion = supportedVersion;
  }
}

const LEGACY_AGENT_ID_MAP: Record<string, string> = {
  agent_codex_demo: 'conn_codex_demo',
  agent_claude_demo: 'conn_claude_demo',
  agent_antigravity_demo: 'conn_antigravity_demo',
};

function mapConnectionId(legacyOrNewId: string | undefined): string {
  if (!legacyOrNewId) return 'conn_codex_demo';
  return LEGACY_AGENT_ID_MAP[legacyOrNewId] ?? legacyOrNewId;
}

function migrateLegacyAgentProfileToConnection(
  agent: AgentProfile,
): ConnectionAdapterConfig {
  const mappedId = mapConnectionId(agent.id);
  const presetMatch = DEFAULT_CONNECTIONS.find((c) => c.id === mappedId);
  const backendId = mappedId.includes('codex')
    ? 'codex'
    : mappedId.includes('claude')
      ? 'claude'
      : mappedId.includes('antigravity')
        ? 'antigravity'
        : mappedId;
  return {
    id: mappedId,
    displayName: agent.displayName,
    vendorLabel: agent.vendorLabel,
    mode: agent.isSimulated ? 'demo' : 'aion_core',
    backendId,
    configured: agent.connection.configured,
    coreReachability: 'unknown',
    catalogLoaded: false,
    executableStatus:
      agent.connection.executableStatus === 'simulated_found'
        ? 'unknown_in_browser'
        : agent.connection.executableStatus === 'not_found'
          ? 'missing'
          : agent.connection.executableStatus,
    authStatus: agent.connection.authStatus,
    sessionStatus: agent.connection.sessionStatus,
    availableModels: presetMatch?.availableModels ?? [],
    lastConnectionTestAt: agent.connection.lastConnectionTestAt,
    lastConnectionTestResult: agent.connection.lastConnectionTestResult,
    capabilities: { ...agent.capabilities },
    isSimulated: Boolean(agent.isSimulated),
  };
}

function migrateParticipant(
  raw: Partial<Participant> & { id: string; conversationId: string },
  index: number,
  fallbackCreatedAt: string,
): Participant {
  const roles: ParticipantRole[] =
    Array.isArray(raw.roles) && raw.roles.length > 0
      ? [...raw.roles]
      : [raw.role ?? 'executor'];
  const tier: DemoModelTier = raw.modelTier ?? raw.modelRef?.tier ?? 'fast';
  const connectionId = mapConnectionId(raw.connectionId ?? raw.agentProfileId);
  const modelRef: ModelRef = raw.modelRef
    ? { ...raw.modelRef }
    : makeDemoModelRef(tier);

  return {
    id: raw.id,
    conversationId: raw.conversationId,
    profileId: raw.profileId,
    connectionId,
    agentProfileId: raw.agentProfileId ?? connectionId,
    displayName: raw.displayName ?? raw.id,
    role: getPrimaryRole(roles),
    roles,
    modelRef,
    modelTier: tier,
    instructions: raw.instructions ?? '',
    sessionRef: raw.sessionRef
      ? { ...raw.sessionRef, connectionId: raw.sessionRef.connectionId || connectionId }
      : {
          id: `sess_migrated_${raw.conversationId}_${raw.id}`,
          conversationId: raw.conversationId,
          participantId: raw.id,
          connectionId,
          status: raw.status === 'disconnected' ? 'disconnected' : 'active',
          createdAt: fallbackCreatedAt,
        },
    status: raw.status ?? 'idle',
    currentTaskId: raw.currentTaskId,
    unreadCount: raw.unreadCount ?? 0,
    tabOrder: typeof raw.tabOrder === 'number' ? raw.tabOrder : index,
    archived: raw.archived,
    isSimulated: raw.isSimulated ?? true,
  };
}

function migratePermission(
  raw: Partial<PermissionRequest> & { id: string; conversationId: string; participantId: string },
): PermissionRequest {
  return {
    id: raw.id,
    conversationId: raw.conversationId,
    participantId: raw.participantId,
    taskId: raw.taskId,
    attemptId: raw.attemptId,
    actionKey: raw.actionKey ?? raw.commandSimulated ?? raw.actionTitle ?? raw.id,
    scopeKey: raw.scopeKey ?? raw.taskId ?? 'conversation_workspace',
    supersedesRequestId: raw.supersedesRequestId,
    actionTitle: raw.actionTitle ?? 'Solicitação de permissão',
    commandSimulated: raw.commandSimulated ?? '',
    scopeDescription: raw.scopeDescription ?? '',
    status: raw.status ?? 'pending',
    createdAt: raw.createdAt ?? new Date().toISOString(),
    resolvedAt: raw.resolvedAt,
    sourceEventId: raw.sourceEventId ?? '',
    isSimulated: raw.isSimulated ?? true,
  };
}

function mergePresetCatalog(existing: TeamPreset[] | undefined): TeamPreset[] {
  const list = existing ? [...existing] : [];
  const seenIds = new Set(list.map((p) => p.id));
  for (const builtIn of DEFAULT_TEAM_PRESETS) {
    if (!seenIds.has(builtIn.id)) {
      list.push(builtIn);
    }
  }
  return list;
}

function mergeProfileCatalog(
  existing: ParticipantProfile[] | undefined,
): ParticipantProfile[] {
  const list = existing ? [...existing] : [];
  const seenIds = new Set(list.map((p) => p.id));
  for (const builtIn of DEFAULT_PARTICIPANT_PROFILES) {
    if (!seenIds.has(builtIn.id)) {
      list.push(builtIn);
    }
  }
  return list;
}

/**
 * Migrates workspace state from schema v1 -> v2 or normalizes v2 payloads.
 * Preserves all historical IDs, messages, tasks, attempts, reviews, and held-back events.
 */
export function migrateWorkspaceState(raw: unknown): WorkspaceStoreState {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Estado persistido inválido ou corrompido.');
  }
  const obj = raw as Record<string, unknown>;
  const foundVersion = Number(obj.schemaVersion ?? 1);
  if (Number.isNaN(foundVersion) || foundVersion < 1) {
    throw new Error('Versão de schema inválida nos dados carregados.');
  }
  if (foundVersion > APP_BRAND.storageSchemaVersion) {
    throw new IncompatibleSchemaError(foundVersion, APP_BRAND.storageSchemaVersion);
  }

  const rawConnections = obj.connections as ConnectionAdapterConfig[] | undefined;
  const rawAgents = obj.agentProfiles as AgentProfile[] | undefined;
  const connections: ConnectionAdapterConfig[] =
    Array.isArray(rawConnections) && rawConnections.length > 0
      ? rawConnections.map((c) => ({ ...c }))
      : Array.isArray(rawAgents) && rawAgents.length > 0
        ? rawAgents.map(migrateLegacyAgentProfileToConnection)
        : DEFAULT_CONNECTIONS.map((c) => ({ ...c }));

  // Ensure built-in demo connections exist so preset instantiation never breaks
  const connIds = new Set(connections.map((c) => c.id));
  for (const def of DEFAULT_CONNECTIONS) {
    if (!connIds.has(def.id)) {
      connections.push({ ...def });
    }
  }

  const rawConversations = (obj.conversations ?? {}) as Record<
    string,
    Partial<ConversationProjection>
  >;
  const migratedConversations: Record<string, ConversationProjection> = {};

  for (const [convId, rawProj] of Object.entries(rawConversations)) {
    if (!rawProj || !rawProj.conversation) continue;
    const convCreated = rawProj.conversation.createdAt ?? new Date().toISOString();
    const participants = (rawProj.participants ?? []).map((p, idx) =>
      migrateParticipant(p, idx, convCreated),
    );
    const permissions = (rawProj.permissions ?? []).map((perm) =>
      migratePermission(perm),
    );
    const tasks = (rawProj.tasks ?? []).map((t) => ({
      ...t,
      attempts: (t.attempts ?? []).map((a) => ({
        ...a,
        modelRefUsed: a.modelRefUsed ?? makeDemoModelRef(a.modelTierUsed),
      })),
    }));

    migratedConversations[convId] = {
      conversation: {
        ...rawProj.conversation,
        executionMode: rawProj.conversation.executionMode ?? 'demo',
      },
      participants,
      messagesByTab: rawProj.messagesByTab ?? { general: [] },
      generalFeed: rawProj.generalFeed ?? [],
      tasks,
      planRevisions: rawProj.planRevisions ?? [],
      contextRevisions: rawProj.contextRevisions ?? [],
      permissions,
      escalations: rawProj.escalations ?? [],
      coordinatorHistory: rawProj.coordinatorHistory ?? [],
      configChanges: rawProj.configChanges ?? [],
      seenEventIds: rawProj.seenEventIds ?? [],
      pendingOutOfOrder: rawProj.pendingOutOfOrder ?? {},
      eventLog: rawProj.eventLog ?? [],
      syncErrorNote: rawProj.syncErrorNote,
    };
  }

  const executionMode =
    obj.executionMode === 'aion_core' ? 'aion_core' : 'demo';

  const rawCoreSettings = obj.coreSettings as
    | WorkspaceStoreState['coreSettings']
    | undefined;

  return {
    schemaVersion: APP_BRAND.storageSchemaVersion,
    executionMode,
    coreSettings: {
      baseUrl: rawCoreSettings?.baseUrl ?? '',
      workspacePath: rawCoreSettings?.workspacePath ?? '',
      authMode: rawCoreSettings?.authMode ?? 'cookie_or_bearer',
    },
    projects: (obj.projects as WorkspaceStoreState['projects']) ?? [],
    connections,
    agentProfiles: connectionsToAgentProfiles(connections),
    participantProfiles: mergeProfileCatalog(
      obj.participantProfiles as ParticipantProfile[] | undefined,
    ),
    teamPresets: mergePresetCatalog(obj.teamPresets as TeamPreset[] | undefined),
    modelPolicy: (obj.modelPolicy as WorkspaceStoreState['modelPolicy']) ?? {
      defaultExecutorTier: 'fast',
      reviewerTier: 'review',
      escalationTargetTier: 'advanced',
      qualityRejectionsBeforeSuggest: 2,
      approvalMode: 'manual',
    },
    conversations: migratedConversations,
    activeProjectId: String(obj.activeProjectId ?? ''),
    activeConversationId: String(obj.activeConversationId ?? ''),
    simulatedHeldBackEvents:
      obj.simulatedHeldBackEvents as WorkspaceStoreState['simulatedHeldBackEvents'],
    assistantState: normalizeAssistantState(obj.assistantState),
  };
}

function normalizeAssistantState(raw: unknown): VerticeAssistantState | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return undefined;
  }
  const obj = raw as Record<string, unknown>;
  const rawConfig =
    obj.config && typeof obj.config === 'object' && !Array.isArray(obj.config)
      ? (obj.config as Record<string, unknown>)
      : undefined;
  const config =
    rawConfig &&
    typeof rawConfig.connectionId === 'string' &&
    typeof rawConfig.modelExternalId === 'string'
      ? {
          connectionId: rawConfig.connectionId,
          modelExternalId: rawConfig.modelExternalId,
          modelDisplayName:
            typeof rawConfig.modelDisplayName === 'string'
              ? rawConfig.modelDisplayName
              : rawConfig.modelExternalId,
          workspaceRoot:
            typeof rawConfig.workspaceRoot === 'string'
              ? rawConfig.workspaceRoot
              : undefined,
          externalTeamId:
            typeof rawConfig.externalTeamId === 'string'
              ? rawConfig.externalTeamId
              : undefined,
          externalSlotId:
            typeof rawConfig.externalSlotId === 'string'
              ? rawConfig.externalSlotId
              : undefined,
          externalConversationId:
            typeof rawConfig.externalConversationId === 'string'
              ? rawConfig.externalConversationId
              : undefined,
          nativeSessionId:
            typeof rawConfig.nativeSessionId === 'string'
              ? rawConfig.nativeSessionId
              : undefined,
          includeLiveDiagnostics: rawConfig.includeLiveDiagnostics !== false,
          includeSourceContext: rawConfig.includeSourceContext !== false,
          accessMode: 'read_only' as const,
        }
      : undefined;

  const messages: VerticeAssistantMessage[] = Array.isArray(obj.messages)
    ? obj.messages
        .filter((m): m is Record<string, unknown> => Boolean(m && typeof m === 'object'))
        .map((m) => {
          const role: VerticeAssistantMessage['role'] =
            m.role === 'user' || m.role === 'assistant' || m.role === 'system'
              ? m.role
              : 'assistant';
          const status: NonNullable<VerticeAssistantMessage['status']> =
            m.status === 'streaming' || m.status === 'completed' || m.status === 'error'
              ? m.status
              : 'completed';
          const attachments = Array.isArray(m.attachments)
            ? m.attachments
                .filter(
                  (a): a is Record<string, unknown> =>
                    Boolean(a && typeof a === 'object' && typeof (a as Record<string, unknown>).name === 'string'),
                )
                .map((a, idx) => ({
                  id:
                    typeof a.id === 'string'
                      ? a.id
                      : `att_${idx}_${Math.random().toString(36).slice(2, 7)}`,
                  name: a.name as string,
                  kind: a.kind === 'image' ? ('image' as const) : ('text' as const),
                  mimeType:
                    typeof a.mimeType === 'string'
                      ? a.mimeType
                      : 'application/octet-stream',
                  sizeBytes:
                    typeof a.sizeBytes === 'number' && Number.isFinite(a.sizeBytes)
                      ? a.sizeBytes
                      : 0,
                  truncated: a.truncated === true ? true : undefined,
                }))
            : undefined;
          return {
            id: typeof m.id === 'string' ? m.id : `ast_msg_${Math.random().toString(36).slice(2)}`,
            role,
            contentMarkdown:
              typeof m.contentMarkdown === 'string' ? m.contentMarkdown : '',
            timestamp:
              typeof m.timestamp === 'string'
                ? m.timestamp
                : new Date().toISOString(),
            status,
            sourcesCited: Array.isArray(m.sourcesCited)
              ? m.sourcesCited.filter((s): s is string => typeof s === 'string')
              : undefined,
            attachments: attachments && attachments.length > 0 ? attachments : undefined,
          };
        })
    : [];

  return {
    config,
    status:
      obj.status === 'configuring' || obj.status === 'streaming' || obj.status === 'error'
        ? obj.status
        : 'idle',
    lastError: typeof obj.lastError === 'string' ? obj.lastError : undefined,
    messages,
  };
}
