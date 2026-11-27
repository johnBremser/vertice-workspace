import type {
  ConversationProjection,
  ConversationSnapshot,
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
  TaskReview,
  TeamPreset,
  TeamPresetMember,
  WorkspaceStoreState,
} from '../domain/types';

export type GatewayErrorCode =
  | 'NOT_CONNECTED_LOCAL_CORE'
  | 'AUTH_REQUIRED'
  | 'CSRF_REJECTED'
  | 'TIMEOUT'
  | 'INVALID_PAYLOAD'
  | 'CAPABILITY_UNSUPPORTED'
  | 'VALIDATION_ERROR'
  | 'CONVERSATION_NOT_FOUND'
  | 'OPERATION_FAILED'
  | 'NOT_IMPLEMENTED_IN_PREVIEW';

export class GatewayCapabilityError extends Error {
  readonly code: GatewayErrorCode;
  readonly isRecoverable: boolean;
  readonly httpStatus?: number;

  constructor(
    code: GatewayErrorCode,
    message: string,
    isRecoverable = true,
    httpStatus?: number,
  ) {
    super(message);
    this.name = 'GatewayCapabilityError';
    this.code = code;
    this.isRecoverable = isRecoverable;
    this.httpStatus = httpStatus;
  }
}

export type GatewayEventListener = (event: ExecutionEvent) => void;

export interface SendMessageInput {
  conversationId: string;
  targetTab: 'general' | string;
  bodyMarkdown: string;
  promoteToSharedContext?: boolean;
}

export interface PublishContextInput {
  conversationId: string;
  authorLabel: string;
  summaryOfChange: string;
  objective: string;
  permanentInstructions: string[];
  constraints: string[];
  acceptanceCriteria: string[];
  confirmedDecisions: string[];
}

export interface ReconcileResult {
  mode: 'missing_events' | 'snapshot';
  events?: ExecutionEvent[];
  snapshot?: ConversationSnapshot;
  synced?: boolean;
  remainingGapSeq?: number;
}

export interface CoreDiagnosticEntry {
  timestamp: string;
  operation: string;
  status: 'ok' | 'error';
  code?: string;
  httpStatus?: number;
  teamId?: string;
  slotId?: string;
  correlationId?: string;
  detail: string;
}

export interface CoreTeamSummary {
  id: string;
  name: string;
  workspace?: string;
  agentsCount: number;
  createdAt: number;
  linkedConversationId?: string;
  isInternalAssistant?: boolean;
}

export interface CoreGatewayOperations {
  checkHealth(): Promise<{
    reachable: boolean;
    version?: string;
    buildTime?: string;
    message: string;
  }>;
  checkAuthStatus(): Promise<{
    authenticated: boolean;
    user?: string;
    message: string;
  }>;
  login(username: string, password: string): Promise<{
    authenticated: boolean;
    message: string;
  }>;
  logout(): Promise<void>;
  refreshCoreCatalog(): Promise<{
    connectionsUpdated: number;
    assistantsCount: number;
    agentsCount: number;
    message: string;
  }>;
  syncCoreTeams(): Promise<{
    teamsCount: number;
    teams: CoreTeamSummary[];
    message: string;
  }>;
  deleteCoreTeam(teamId: string): Promise<{
    teams: CoreTeamSummary[];
    message: string;
  }>;
  cleanupOrphanCoreTeams(): Promise<{
    deletedCount: number;
    failedCount: number;
    teams: CoreTeamSummary[];
    message: string;
  }>;
  createCoreTeamForConversation(
    conversationId: string,
    teamName?: string,
  ): Promise<{
    externalTeamId: string;
    message: string;
  }>;
  connectWebSocket(conversationId?: string): Promise<void>;
  ensureWebSocketConnected?(conversationId?: string): Promise<void>;
  disconnectWebSocket(): void;
  getDiagnostics(): CoreDiagnosticEntry[];

  configureVerticeAssistant(input: {
    connectionId: string;
    modelExternalId: string;
    modelDisplayName: string;
    includeLiveDiagnostics?: boolean;
    includeSourceContext?: boolean;
  }): Promise<{ externalTeamId: string; message: string }>;
  updateVerticeAssistantPreferences(input: {
    includeLiveDiagnostics?: boolean;
    includeSourceContext?: boolean;
  }): void;
  sendVerticeAssistantMessage(input: {
    prompt: string;
    sourceQuery?: string;
    attachments?: VerticeAssistantAttachmentInput[];
  }): Promise<void>;
  respondVerticeAssistantPermission(input: {
    requestId: string;
    decision: 'approved' | 'denied';
  }): Promise<void>;
  clearVerticeAssistantHistory(): Promise<void>;
}

export interface VerticeAssistantAttachmentInput {
  id: string;
  name: string;
  kind: 'image' | 'text';
  mimeType: string;
  sizeBytes: number;
  textContent?: string;
  truncated?: boolean;
  file?: File;
}

export interface ConfigureParticipantInput {
  conversationId: string;
  participantId: string;
  displayName?: string;
  role?: ParticipantRole;
  roles?: ParticipantRole[];
  modelTier?: DemoModelTier;
  modelRef?: ModelRef;
  instructions?: string;
  connectionId?: string;
  reason?: string;
}

export interface AgentWorkspaceGateway {
  readonly kind: 'aion_core';
  readonly core?: CoreGatewayOperations;

  loadWorkspace(): Promise<WorkspaceStoreState>;
  getStateSnapshot(): WorkspaceStoreState;
  subscribeState(listener: (state: WorkspaceStoreState) => void): () => void;
  subscribeEvents(listener: GatewayEventListener): () => void;
  dispose(): void;

  setExecutionMode(mode: ExecutionMode): Promise<void>;
  updateCoreSettings(settings: CoreRuntimeSettings): Promise<void>;

  setActiveView(input: {
    projectId?: string;
    conversationId: string;
    tabId?: string;
  }): void;
  createProject(input: {
    name: string;
    description: string;
    workspacePathInfo: string;
  }): Promise<Project>;
  renameProject(projectId: string, name: string): Promise<void>;
  updateProject(input: {
    projectId: string;
    name: string;
    description?: string;
    workspacePathInfo?: string;
  }): Promise<void>;
  setProjectArchived(projectId: string, archived: boolean): Promise<void>;

  createConversation(input: {
    projectId: string;
    title: string;
    presetId?: string;
    customMembers?: TeamPresetMember[];
  }): Promise<ConversationProjection>;
  renameConversation(conversationId: string, title: string): Promise<void>;
  setConversationArchived(conversationId: string, archived: boolean): Promise<void>;

  saveParticipantProfile(
    profile: Omit<ParticipantProfile, 'id'> & { id?: string },
  ): Promise<ParticipantProfile>;
  archiveParticipantProfile(profileId: string, archived: boolean): Promise<void>;
  saveTeamPreset(
    preset: Omit<TeamPreset, 'id'> & { id?: string },
  ): Promise<TeamPreset>;
  applyTeamPreset(conversationId: string, presetId: string): Promise<void>;
  addParticipantToConversation(
    conversationId: string,
    member: TeamPresetMember,
  ): Promise<Participant>;
  removeParticipantFromConversation(
    conversationId: string,
    participantId: string,
    reason?: string,
  ): Promise<void>;
  reorderParticipantTabs(
    conversationId: string,
    orderedParticipantIds: string[],
  ): Promise<void>;
  configureParticipant(input: ConfigureParticipantInput): Promise<void>;

  createTask(input: {
    conversationId: string;
    title: string;
    description: string;
    assigneeParticipantId: string;
    reviewerParticipantId?: string;
    dependencyTaskIds: string[];
    acceptanceCriteria: string[];
  }): Promise<Task>;
  updateTask(input: {
    conversationId: string;
    taskId: string;
    title: string;
    description: string;
    assigneeParticipantId: string;
    reviewerParticipantId?: string;
    dependencyTaskIds: string[];
    acceptanceCriteria: string[];
  }): Promise<void>;
  publishPlanRevision(input: {
    conversationId: string;
    summary: string;
    authorLabel?: string;
  }): Promise<PlanRevision>;

  updateModelPolicy(policy: ModelPolicy): Promise<void>;
  sendMessage(input: SendMessageInput): Promise<void>;
  getPaginatedEvents(
    conversationId: string,
    tabId: string,
    limit: number,
    beforeIndex?: number,
  ): Promise<{ total: number; hasMore: boolean }>;
  controlExecution(input: {
    conversationId: string;
    action: 'pause_queue' | 'resume_queue' | 'request_interrupt' | 'terminate_session';
    participantId?: string;
  }): Promise<void>;
  dispatchTask?(input: {
    conversationId: string;
    taskId: string;
  }): Promise<void>;
  respondPermission(input: {
    conversationId: string;
    requestId: string;
    decision: 'approved' | 'denied';
    note?: string;
  }): Promise<void>;
  resolveEscalation(input: {
    conversationId: string;
    escalationId: string;
    resolution: 'approved' | 'dismissed';
  }): Promise<void>;
  registerTaskReview(input: {
    conversationId: string;
    review: Omit<TaskReview, 'id' | 'decidedAt' | 'sourceEventId'>;
  }): Promise<void>;
  publishContextRevision(input: PublishContextInput): Promise<SharedContextRevision>;
  testAgentConnection(connectionId: string): Promise<{
    ok: boolean;
    testedAt: string;
    message: string;
    isSimulated: boolean;
  }>;
  reconcileConversation(conversationId: string): Promise<ReconcileResult>;
  importWorkspaceState(nextState: WorkspaceStoreState): Promise<void>;
}
