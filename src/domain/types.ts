export type ExecutionMode = 'demo' | 'aion_core';

export type EventOriginSource =
  | 'demo_simulation'
  | 'aion_core'
  | 'user'
  | 'aion_desk_local';

export type DemoModelTier = 'fast' | 'review' | 'advanced';

export type ParticipantRole = 'coordinator' | 'planner' | 'executor' | 'reviewer';

export type CapabilityFlag = boolean | 'unknown';

export type ParticipantRuntimeStatus =
  | 'idle'
  | 'preparing'
  | 'running'
  | 'awaiting_review'
  | 'awaiting_permission'
  | 'blocked'
  | 'disconnected'
  | 'failed'
  | 'completed';

export type TaskStatus =
  | 'planned'
  | 'queued'
  | 'running'
  | 'awaiting_review'
  | 'changes_requested'
  | 'blocked'
  | 'failed'
  | 'cancelled'
  | 'completed';

export type ContextReceiptStatus =
  | 'pending_send'
  | 'sent'
  | 'received'
  | 'applied'
  | 'failed_needs_action';

export type ContextDeliveryPolicy =
  | 'next_turn'
  | 'mid_run_injection'
  | 'interrupt_requested';

export type StorageStatus = 'loading' | 'saved' | 'saving' | 'session_only';

export type ConversationExecutionStatus =
  | 'idle'
  | 'running'
  | 'paused_queue'
  | 'paused_demo'
  | 'blocked'
  | 'completed'
  | 'failed';

export type ConversationToolApprovalPolicy =
  | 'manual'
  | 'allow_read_edit'
  | 'allow_all_in_conversation';

export type ConversationSyncState =
  | 'synced'
  | 'gap_detected'
  | 'reconciling'
  | 'incomplete';

export interface CoreRuntimeSettings {
  baseUrl: string;
  workspacePath: string;
  authMode: 'cookie_or_bearer' | 'none';
}

export interface Project {
  id: string;
  name: string;
  description: string;
  workspacePathInfo: string;
  executionMode?: ExecutionMode;
  status: 'active' | 'archived';
  createdAt: string;
  updatedAt: string;
}

export interface AgentCapabilities {
  supportsInterrupt: CapabilityFlag;
  supportsMidRunContextInjection: CapabilityFlag;
  supportsModelSwitchInSession: CapabilityFlag;
  supportsPauseQueue: CapabilityFlag;
  supportsSessionTerminate: CapabilityFlag;
}

export interface CatalogModelOption {
  externalId: string;
  displayName: string;
  source: 'demo_tier' | 'core_catalog' | 'core_session';
  tier?: DemoModelTier;
  confirmed: boolean;
  reasoningEfforts?: string[];
  reasoningOptionId?: string;
}

export interface ModelRef {
  externalId?: string;
  displayName: string;
  source: 'demo_tier' | 'core_catalog' | 'core_session' | 'user_preference';
  tier?: DemoModelTier;
  confirmation: 'confirmed' | 'simulated' | 'unverified_preference';
  confirmationDetail?: 'observed' | 'pending_next_turn' | 'command_ack';
  reasoningEffort?: string;
  reasoningOptionId?: string;
}

export interface ConnectionAdapterConfig {
  id: string;
  displayName: string;
  vendorLabel: string;
  mode: ExecutionMode;
  backendId: string;
  coreAgentId?: string;
  coreAssistantId?: string;
  coreBaseUrl?: string;
  configured: boolean;
  coreReachability: 'unknown' | 'reachable' | 'unreachable';
  catalogLoaded: boolean;
  executableStatus: 'unknown_in_browser' | 'verified' | 'missing' | 'unknown';
  coreAgentStatus?: string;
  authStatus:
    | 'simulated'
    | 'authenticated'
    | 'unauthenticated'
    | 'expired'
    | 'unknown';
  sessionStatus: 'inactive' | 'active' | 'disconnected' | 'terminated' | 'unknown';
  availableModels: CatalogModelOption[];
  lastConnectionTestAt?: string;
  lastConnectionTestResult?: string;
  capabilities: AgentCapabilities;
  isSimulated: boolean;
}

export interface ConnectionState {
  configured: boolean;
  executableStatus: 'unknown_in_browser' | 'simulated_found' | 'not_found' | 'verified' | 'missing' | 'unknown';
  authStatus: 'simulated' | 'authenticated' | 'unauthenticated' | 'expired' | 'unknown';
  lastConnectionTestAt?: string;
  lastConnectionTestResult?: string;
  sessionStatus: 'inactive' | 'active' | 'disconnected' | 'terminated' | 'unknown';
  isSimulated: boolean;
}

export interface AgentProfile {
  id: string;
  displayName: string;
  vendorLabel: string;
  defaultRole: ParticipantRole;
  capabilities: AgentCapabilities;
  connection: ConnectionState;
  supportedTiers: DemoModelTier[];
  isSimulated: boolean;
}

export interface SessionRef {
  id: string;
  conversationId: string;
  participantId: string;
  connectionId: string;
  externalTeamId?: string;
  externalSlotId?: string;
  externalConversationId?: string;
  nativeSessionId?: string;
  importedExternalRef?: {
    externalTeamId?: string;
    externalSlotId?: string;
    externalConversationId?: string;
    nativeSessionId?: string;
  };
  status: 'inactive' | 'active' | 'disconnected' | 'terminated' | 'unknown';
  createdAt: string;
}

export interface ParticipantProfile {
  id: string;
  displayName: string;
  connectionId: string;
  defaultRoles: ParticipantRole[];
  modelRef: ModelRef;
  instructions: string;
  archived?: boolean;
  isSimulated: boolean;
}

export interface TeamPresetMember {
  profileId?: string;
  connectionId: string;
  displayName: string;
  roles: ParticipantRole[];
  modelRef: ModelRef;
  instructions: string;
}

export interface TeamPreset {
  id: string;
  name: string;
  description: string;
  mode: ExecutionMode;
  isBuiltIn?: boolean;
  members: TeamPresetMember[];
}

export interface Participant {
  id: string;
  conversationId: string;
  profileId?: string;
  connectionId: string;
  agentProfileId: string;
  displayName: string;
  role: ParticipantRole;
  roles: ParticipantRole[];
  modelRef: ModelRef;
  modelTier: DemoModelTier;
  instructions: string;
  sessionRef: SessionRef;
  status: ParticipantRuntimeStatus;
  currentTaskId?: string;
  unreadCount: number;
  tabOrder: number;
  archived?: boolean;
  isSimulated: boolean;
}

export interface CoordinatorAssignment {
  id: string;
  conversationId: string;
  previousParticipantId?: string;
  nextParticipantId: string;
  reason: string;
  decidedAt: string;
  sourceEventId: string;
}

export interface PlanRevision {
  id: string;
  conversationId: string;
  versionNumber: number;
  authorLabel: string;
  createdAt: string;
  summary: string;
  taskIds: string[];
  sourceEventId: string;
  originSource: EventOriginSource;
}

export interface ConfigChangeRecord {
  id: string;
  conversationId: string;
  participantId: string;
  changeKind: 'roles' | 'model' | 'instructions' | 'connection' | 'coordinator';
  previousSummary: string;
  nextSummary: string;
  reason: string;
  appliesToNextAttemptOnly: true;
  decidedAt: string;
  sourceEventId: string;
}

export interface ToolArtifact {
  id: string;
  label: string;
  commandSimulated?: string;
  summary: string;
  details?: string;
  isSimulated: boolean;
}

export interface MessageDelivery {
  targetType: 'coordinator' | 'participant';
  targetParticipantId?: string;
  status: 'sent_simulated' | 'delivered_simulated' | 'enqueued_core' | 'delivered_core' | 'failed';
  externalMessageId?: string;
  note?: string;
}

export interface Message {
  id: string;
  conversationId: string;
  sourceEventId: string;
  authorType: 'user' | 'agent' | 'system';
  authorParticipantId?: string;
  authorLabel: string;
  targetTab: 'general' | string;
  bodyMarkdown: string;
  timestamp: string;
  delivery?: MessageDelivery;
  toolOutputs?: ToolArtifact[];
  originSource?: EventOriginSource;
  externalMessageId?: string;
  parseStatus?: 'valid' | 'incomplete' | 'invalid';
  parseReason?: string;
  isSimulated: boolean;
}

export interface TaskAttempt {
  id: string;
  taskId: string;
  attemptNumber: number;
  executorParticipantId: string;
  modelTierUsed: DemoModelTier;
  modelRefUsed?: ModelRef;
  rolesSnapshot?: ParticipantRole[];
  instructionsSnapshot?: string;
  contextRevisionId: string;
  contextRevisionNumber: number;
  status:
    | 'running'
    | 'delivered'
    | 'rejected_quality'
    | 'failed_operational'
    | 'approved'
    | 'interrupted';
  deliverySummary?: string;
  evidenceNotes: string[];
  startedAt: string;
  finishedAt?: string;
  sourceEventIds: string[];
  originSource?: EventOriginSource;
}

export interface TaskReview {
  id: string;
  taskId: string;
  attemptId: string;
  reviewerParticipantId: string;
  decision: 'approved' | 'rejected';
  rationale: string;
  unmetCriteria: string[];
  decidedAt: string;
  sourceEventId: string;
  independentReview?: boolean;
}

export interface Task {
  id: string;
  conversationId: string;
  sourceRequestEventId: string;
  planRevisionId?: string;
  title: string;
  description: string;
  assigneeParticipantId: string;
  reviewerParticipantId?: string;
  dependencyTaskIds: string[];
  acceptanceCriteria: string[];
  status: TaskStatus;
  attempts: TaskAttempt[];
  reviews: TaskReview[];
  operationalFailureCount: number;
  qualityRejectionCount: number;
  activeContextRevisionId?: string;
  originSource?: EventOriginSource;
  createdAt?: string;
  updatedAt?: string;
  externalUpdatedAtMs?: number;
}

export interface ContextReceipt {
  participantId: string;
  revisionId: string;
  status: ContextReceiptStatus;
  policyApplied: ContextDeliveryPolicy;
  updatedAt: string;
  mechanismNote: string;
}

export interface SharedContextRevision {
  id: string;
  conversationId: string;
  versionNumber: number;
  authorLabel: string;
  createdAt: string;
  summaryOfChange: string;
  objective: string;
  permanentInstructions: string[];
  constraints: string[];
  acceptanceCriteria: string[];
  confirmedDecisions: string[];
  receipts: Record<string, ContextReceipt>;
}

export interface ModelPolicy {
  defaultExecutorTier: DemoModelTier;
  reviewerTier: DemoModelTier;
  escalationTargetTier: DemoModelTier;
  qualityRejectionsBeforeSuggest: number;
  approvalMode: 'manual' | 'auto_policy';
  rolePreferences?: Partial<Record<ParticipantRole, string>>;
}

export interface EscalationDecision {
  id: string;
  conversationId: string;
  taskId: string;
  attemptId: string;
  participantId: string;
  fromTier: DemoModelTier;
  toTier: DemoModelTier;
  fromModelRef?: ModelRef;
  toModelRef?: ModelRef;
  reason: string;
  expectedEffect: string;
  status: 'suggested' | 'approved' | 'dismissed';
  createdAt: string;
  resolvedAt?: string;
  sourceEventId: string;
}

export interface PermissionRequest {
  id: string;
  conversationId: string;
  participantId: string;
  taskId?: string;
  attemptId?: string;
  actionKey: string;
  scopeKey: string;
  supersedesRequestId?: string;
  actionTitle: string;
  commandSimulated: string;
  scopeDescription: string;
  status: 'pending' | 'approved' | 'denied';
  canAllowAlways?: boolean;
  createdAt: string;
  resolvedAt?: string;
  sourceEventId: string;
  isSimulated: boolean;
}

export interface PermissionDecision {
  requestId: string;
  decision: 'approved' | 'denied';
  decidedBy: string;
  note: string;
  decidedAt: string;
}

export type GeneralFeedKind =
  | 'user_request'
  | 'coordinator_plan'
  | 'task_delegated'
  | 'task_progress'
  | 'delivery_summary'
  | 'review_decision'
  | 'context_revision'
  | 'permission_event'
  | 'escalation_event'
  | 'status_change'
  | 'completion';

export interface GeneralFeedItem {
  id: string;
  conversationId: string;
  sourceEventId: string;
  kind: GeneralFeedKind;
  actorLabel: string;
  actorRoleLabel?: string;
  summary: string;
  detailLinkLabel?: string;
  targetTabId?: string;
  targetEventId?: string;
  targetTaskId?: string;
  targetContextVersion?: number;
  timestamp: string;
}

export interface WorkspaceConversation {
  id: string;
  projectId: string;
  title: string;
  executionMode: ExecutionMode;
  teamPresetId?: string;
  externalTeamId?: string;
  coreLeadParticipantId?: string;
  coreTeamNeedsResync?: boolean;
  importedExternalTeamId?: string;
  status: 'active' | 'archived';
  executionStatus: ConversationExecutionStatus;
  toolApprovalPolicy?: ConversationToolApprovalPolicy;
  coordinatorParticipantId: string;
  syncState: ConversationSyncState;
  missingFromSeq?: number;
  lastAppliedSeq: number;
  scenarioStepIndex: number;
  autoPlayWasRunning?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface BaseExecutionEvent {
  id: string;
  seq: number;
  conversationId: string;
  timestamp: string;
  origin: 'user' | 'coordinator' | 'executor' | 'reviewer' | 'system' | 'gateway';
  originSource?: EventOriginSource;
  correlationId?: string;
  externalEventName?: string;
  externalCursor?: string;
  participantId?: string;
  taskId?: string;
  attemptId?: string;
}

export type ExecutionEvent =
  | (BaseExecutionEvent & {
      type: 'user_message_sent';
      payload: {
        messageId: string;
        targetTab: 'general' | string;
        targetParticipantId: string;
        bodyMarkdown: string;
        generalSummary?: string;
        deliveryStatus?: MessageDelivery['status'];
        deliveryNote?: string;
        externalMessageId?: string;
      };
    })
  | (BaseExecutionEvent & {
      type: 'agent_message_posted';
      payload: {
        messageId: string;
        targetTab: 'general' | string;
        authorLabel: string;
        authorRoleLabel?: string;
        bodyMarkdown: string;
        toolOutputs?: ToolArtifact[];
        projectToGeneral?: boolean;
        generalKind?: GeneralFeedKind;
        generalSummary?: string;
        detailLinkLabel?: string;
        externalMessageId?: string;
        parseStatus?: 'valid' | 'incomplete' | 'invalid';
        parseReason?: string;
        upsertByMessageId?: boolean;
        isStreamingDelta?: boolean;
      };
    })
  | (BaseExecutionEvent & {
      type: 'coordinator_changed';
      payload: {
        assignmentId: string;
        previousParticipantId?: string;
        nextParticipantId: string;
        reason: string;
      };
    })
  | (BaseExecutionEvent & {
      type: 'participant_configured';
      payload: {
        changeRecord: ConfigChangeRecord;
        displayName?: string;
        roles?: ParticipantRole[];
        modelRef?: ModelRef;
        modelTier?: DemoModelTier;
        instructions?: string;
        connectionId?: string;
      };
    })
  | (BaseExecutionEvent & {
      type: 'participant_tabs_reordered';
      payload: {
        orderedParticipantIds: string[];
      };
    })
  | (BaseExecutionEvent & {
      type: 'participant_added';
      payload: {
        participant: Participant;
      };
    })
  | (BaseExecutionEvent & {
      type: 'participant_removed';
      payload: {
        participantId: string;
        reason: string;
      };
    })
  | (BaseExecutionEvent & {
      type: 'plan_revision_published';
      payload: {
        planRevision: PlanRevision;
        generalSummary: string;
      };
    })
  | (BaseExecutionEvent & {
      type: 'task_created';
      payload: {
        task: Task;
        generalSummary: string;
      };
    })
  | (BaseExecutionEvent & {
      type: 'task_updated';
      payload: {
        taskId: string;
        patch: {
          title?: string;
          description?: string;
          assigneeParticipantId?: string;
          reviewerParticipantId?: string;
          dependencyTaskIds?: string[];
          acceptanceCriteria?: string[];
          planRevisionId?: string;
          status?: TaskStatus;
          createdAt?: string;
          updatedAt?: string;
          externalUpdatedAtMs?: number;
        };
        generalSummary: string;
      };
    })
  | (BaseExecutionEvent & {
      type: 'task_status_changed';
      payload: {
        taskId: string;
        nextStatus: TaskStatus;
        participantStatus?: ParticipantRuntimeStatus;
        generalSummary?: string;
        projectToGeneral?: boolean;
      };
    })
  | (BaseExecutionEvent & {
      type: 'attempt_started';
      payload: {
        taskId: string;
        attempt: TaskAttempt;
        participantStatus: ParticipantRuntimeStatus;
        generalSummary?: string;
        projectToGeneral?: boolean;
      };
    })
  | (BaseExecutionEvent & {
      type: 'attempt_delivered';
      payload: {
        taskId: string;
        attemptId: string;
        deliverySummary: string;
        evidenceNotes: string[];
        generalSummary: string;
      };
    })
  | (BaseExecutionEvent & {
      type: 'operational_failure_recorded';
      payload: {
        taskId: string;
        attemptId: string;
        reason: string;
        participantStatus: ParticipantRuntimeStatus;
        generalSummary: string;
      };
    })
  | (BaseExecutionEvent & {
      type: 'task_reviewed';
      payload: {
        review: TaskReview;
        nextTaskStatus: TaskStatus;
        generalSummary: string;
      };
    })
  | (BaseExecutionEvent & {
      type: 'context_revision_published';
      payload: {
        revision: SharedContextRevision;
        generalSummary: string;
      };
    })
  | (BaseExecutionEvent & {
      type: 'context_receipt_updated';
      payload: {
        revisionId: string;
        versionNumber: number;
        participantId: string;
        receipt: ContextReceipt;
        generalSummary?: string;
        projectToGeneral?: boolean;
      };
    })
  | (BaseExecutionEvent & {
      type: 'permission_requested';
      payload: {
        request: PermissionRequest;
        generalSummary: string;
      };
    })
  | (BaseExecutionEvent & {
      type: 'permission_decided';
      payload: {
        decision: PermissionDecision;
        generalSummary: string;
      };
    })
  | (BaseExecutionEvent & {
      type: 'escalation_suggested';
      payload: {
        escalation: EscalationDecision;
        generalSummary: string;
      };
    })
  | (BaseExecutionEvent & {
      type: 'escalation_resolved';
      payload: {
        escalationId: string;
        resolution: 'approved' | 'dismissed';
        participantId: string;
        appliedTier: DemoModelTier;
        appliedModelRef?: ModelRef;
        generalSummary: string;
      };
    })
  | (BaseExecutionEvent & {
      type: 'connection_state_changed';
      payload: {
        participantId: string;
        participantStatus: ParticipantRuntimeStatus;
        sessionStatus: SessionRef['status'];
        generalSummary: string;
        projectToGeneral: boolean;
      };
    })
  | (BaseExecutionEvent & {
      type: 'execution_control_applied';
      payload: {
        control:
          | 'pause_queue'
          | 'resume_queue'
          | 'request_interrupt'
          | 'interrupt_failed'
          | 'terminate_session'
          | 'pause_demo'
          | 'resume_demo';
        nextExecutionStatus?: ConversationExecutionStatus;
        participantId?: string;
        participantStatus?: ParticipantRuntimeStatus;
        generalSummary: string;
      };
    });

export interface ConversationProjection {
  conversation: WorkspaceConversation;
  participants: Participant[];
  messagesByTab: Record<string, Message[]>;
  generalFeed: GeneralFeedItem[];
  tasks: Task[];
  planRevisions: PlanRevision[];
  contextRevisions: SharedContextRevision[];
  permissions: PermissionRequest[];
  escalations: EscalationDecision[];
  coordinatorHistory: CoordinatorAssignment[];
  configChanges: ConfigChangeRecord[];
  seenEventIds: string[];
  pendingOutOfOrder: Record<number, ExecutionEvent>;
  eventLog: ExecutionEvent[];
  syncErrorNote?: string;
}

export interface ConversationSnapshot {
  conversationId: string;
  snapshotSeq: number;
  projection: Omit<ConversationProjection, 'pendingOutOfOrder' | 'eventLog'>;
  coveredEventLog: ExecutionEvent[];
}

export interface VerticeAssistantConfig {
  connectionId: string;
  modelExternalId: string;
  modelDisplayName: string;
  workspaceRoot?: string;
  externalTeamId?: string;
  externalSlotId?: string;
  externalConversationId?: string;
  nativeSessionId?: string;
  includeLiveDiagnostics: boolean;
  includeSourceContext: boolean;
  accessMode: 'read_only';
}

export interface VerticeAssistantPermissionCard {
  requestId: string;
  actionTitle: string;
  commandPreview: string;
  status: 'pending' | 'approved' | 'denied';
  isWriteAttempt: boolean;
}

export interface VerticeAssistantAttachmentMeta {
  id: string;
  name: string;
  kind: 'image' | 'text';
  mimeType: string;
  sizeBytes: number;
  truncated?: boolean;
}

export interface VerticeAssistantMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  contentMarkdown: string;
  timestamp: string;
  status?: 'streaming' | 'completed' | 'error';
  sourcesCited?: string[];
  permissionRequest?: VerticeAssistantPermissionCard;
  attachments?: VerticeAssistantAttachmentMeta[];
}

export interface VerticeAssistantState {
  config?: VerticeAssistantConfig;
  status: 'idle' | 'configuring' | 'streaming' | 'error';
  lastError?: string;
  messages: VerticeAssistantMessage[];
}

export interface WorkspaceStoreState {
  schemaVersion: number;
  executionMode: ExecutionMode;
  coreRuntimeStatus?: 'unknown' | 'reachable' | 'unreachable';
  coreSessionAuthenticated?: boolean;
  coreSettings: CoreRuntimeSettings;
  projects: Project[];
  connections: ConnectionAdapterConfig[];
  agentProfiles: AgentProfile[];
  participantProfiles: ParticipantProfile[];
  teamPresets: TeamPreset[];
  modelPolicy: ModelPolicy;
  conversations: Record<string, ConversationProjection>;
  activeProjectId: string;
  activeConversationId: string;
  simulatedHeldBackEvents?: Record<string, ExecutionEvent[]>;
  assistantState?: VerticeAssistantState;
}
