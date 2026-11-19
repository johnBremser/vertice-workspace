import {
  connectionsToAgentProfiles,
  DEFAULT_TEAM_PRESETS,
  instantiateParticipantsFromPreset,
  makeDemoModelRef,
} from '../domain/presets';
import {
  createEmptyProjection,
  ingestEvent,
  markTabAsRead,
  reconcileWithMissingEvents,
} from '../domain/reducer';
import { getLatestContextRevision } from '../domain/selectors';
import { validateTaskInput } from '../domain/taskRules';
import {
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
  ExecutionEvent,
  ExecutionMode,
  ModelPolicy,
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
  WorkspaceConversation,
  WorkspaceStoreState,
  CoreRuntimeSettings,
} from '../domain/types';
import { PT_BR } from '../i18n/ptBR';
import { buildNextCollaborationStep } from './collaborationEngine';
import {
  build2000StressEvents,
  createInitialWorkspaceState,
} from './demoScenario';
import {
  GatewayCapabilityError,
  type AgentWorkspaceGateway,
  type ConfigureParticipantInput,
  type DemoGatewayControls,
  type GatewayEventListener,
  type PublishContextInput,
  type ReconcileResult,
  type SendMessageInput,
  type StepScenarioResult,
} from './gateway';
import { WorkspacePersistenceManager } from './storage';

export type { StepScenarioResult };

export class MockWorkspaceGateway
  implements AgentWorkspaceGateway, DemoGatewayControls
{
  readonly kind = 'mock' as const;
  readonly demo: DemoGatewayControls = this;

  private state: WorkspaceStoreState | null = null;
  private listeners = new Set<GatewayEventListener>();
  private stateListeners = new Set<(state: WorkspaceStoreState) => void>();
  private readonly persistence: WorkspacePersistenceManager;
  private activeTabByConversation: Record<string, string> = {};
  private autoPlayTimer: ReturnType<typeof setInterval> | null = null;
  private autoPlayConvId: string | null = null;
  private autoPlayTicks = 0;
  private readonly maxAutoPlayTicks = 12;
  private autoPlayStopCallbacks = new Set<(reason?: string) => void>();
  private heldBackMissingEvents = new Map<string, ExecutionEvent[]>();
  private idCounter = 100;

  constructor(persistence: WorkspacePersistenceManager) {
    this.persistence = persistence;
  }

  private nextId(prefix: string): string {
    this.idCounter += 1;
    return `${prefix}_${Date.now().toString(36)}_${this.idCounter}`;
  }

  subscribeEvents(listener: GatewayEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  subscribeState(listener: (state: WorkspaceStoreState) => void): () => void {
    this.stateListeners.add(listener);
    if (this.state) {
      listener(this.state);
    }
    return () => {
      this.stateListeners.delete(listener);
    };
  }

  subscribeAutoPlayStop(listener: (reason?: string) => void): () => void {
    this.autoPlayStopCallbacks.add(listener);
    return () => {
      this.autoPlayStopCallbacks.delete(listener);
    };
  }

  getStateSnapshot(): WorkspaceStoreState {
    if (!this.state) {
      throw new GatewayCapabilityError(
        'OPERATION_FAILED',
        'Workspace ainda não foi inicializado.',
      );
    }
    return this.state;
  }

  private notifyState(): void {
    if (!this.state) return;
    for (const listener of this.stateListeners) {
      listener(this.state);
    }
    this.persistence.scheduleSave(this.state);
  }

  async setExecutionMode(mode: ExecutionMode): Promise<void> {
    const state = this.getStateSnapshot();
    this.pauseAutoPlay();
    this.state = {
      ...state,
      executionMode: mode,
    };
    this.notifyState();
  }

  async updateCoreSettings(settings: CoreRuntimeSettings): Promise<void> {
    const state = this.getStateSnapshot();
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
            ? {
                ...this.state.conversations,
                [input.conversationId]: markedProj,
              }
            : this.state.conversations,
      };
      this.notifyState();
    }
  }

  private getVisibleActiveTab(conversationId: string): string | undefined {
    if (!this.state || this.state.activeConversationId !== conversationId) {
      return undefined;
    }
    return this.activeTabByConversation[conversationId] ?? 'general';
  }

  private emitAndIngest(
    conversationId: string,
    event: ExecutionEvent,
    options?: { skipLocalIngest?: boolean },
  ): void {
    if (!this.state) return;
    if (!options?.skipLocalIngest) {
      const currentProj = this.state.conversations[conversationId];
      if (!currentProj) return;
      const activeTab = this.getVisibleActiveTab(conversationId);
      const result = ingestEvent(currentProj, event, activeTab);
      this.state = {
        ...this.state,
        conversations: {
          ...this.state.conversations,
          [conversationId]: result.projection,
        },
      };
      this.notifyState();
    }
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  async loadWorkspace(): Promise<WorkspaceStoreState> {
    let loaded = await this.persistence.loadInitial(createInitialWorkspaceState);
    if (Object.keys(loaded.conversations ?? {}).length === 0) {
      // An empty workspace in simulation mode always gets the deterministic
      // scenario, so the demo remains usable after working in Core mode.
      loaded = createInitialWorkspaceState();
      await this.persistence.resetAndSave(loaded);
    }
    this.state = loaded;
    this.heldBackMissingEvents.clear();
    if (loaded.simulatedHeldBackEvents) {
      for (const [convId, events] of Object.entries(
        loaded.simulatedHeldBackEvents,
      )) {
        if (events.length > 0) {
          this.heldBackMissingEvents.set(convId, events);
        }
      }
    }
    for (const listener of this.stateListeners) {
      listener(loaded);
    }
    return loaded;
  }

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
      executionMode: state.executionMode,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    };
    const convId = this.nextId('conv');
    const preset = state.teamPresets[0] ?? DEFAULT_TEAM_PRESETS[0];
    const participants = instantiateParticipantsFromPreset({
      preset,
      conversationId: convId,
      idGenerator: (p) => this.nextId(p),
      isSimulated: true,
      createdAt: now,
    });
    const coordinator =
      participants.find((p) => hasRole(p, 'coordinator')) ?? participants[0];
    const conv: WorkspaceConversation = {
      id: convId,
      projectId: project.id,
      title: 'Coordenação inicial',
      executionMode: 'demo',
      teamPresetId: preset.id,
      status: 'active',
      executionStatus: 'idle',
      coordinatorParticipantId: coordinator.id,
      syncState: 'synced',
      lastAppliedSeq: 0,
      scenarioStepIndex: 0,
      createdAt: now,
      updatedAt: now,
    };
    const projection = createEmptyProjection(conv, participants);
    this.activeTabByConversation[convId] = 'general';
    this.state = {
      ...state,
      projects: [...state.projects, project],
      conversations: {
        ...state.conversations,
        [convId]: projection,
      },
      activeProjectId: project.id,
      activeConversationId: convId,
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
        'O nome do projeto não pode ficar vazio.',
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
    this.state = {
      ...state,
      projects: state.projects.map((p) =>
        p.id === projectId
          ? {
              ...p,
              status: archived ? 'archived' : 'active',
              updatedAt: new Date().toISOString(),
            }
          : p,
      ),
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
    const now = new Date().toISOString();
    const convId = this.nextId('conv');
    const selectedPreset =
      state.teamPresets.find((p) => p.id === input.presetId) ??
      state.teamPresets[0] ??
      DEFAULT_TEAM_PRESETS[0];

    const presetToUse: TeamPreset = input.customMembers
      ? {
          id: 'custom',
          name: 'Personalizado',
          description: '',
          mode: 'demo',
          members: input.customMembers,
        }
      : selectedPreset;

    const participants = instantiateParticipantsFromPreset({
      preset: presetToUse,
      conversationId: convId,
      idGenerator: (p) => this.nextId(p),
      isSimulated: true,
      createdAt: now,
    });
    const validation = validateTeamConfiguration(participants, state.connections);
    if (!validation.valid) {
      throw new GatewayCapabilityError('VALIDATION_ERROR', validation.errors[0]);
    }

    const coordinator =
      participants.find((p) => hasRole(p, 'coordinator')) ?? participants[0];
    const conv: WorkspaceConversation = {
      id: convId,
      projectId: input.projectId,
      title: trimmed,
      executionMode: 'demo',
      teamPresetId: presetToUse.id,
      status: 'active',
      executionStatus: 'idle',
      coordinatorParticipantId: coordinator.id,
      syncState: 'synced',
      lastAppliedSeq: 0,
      scenarioStepIndex: 0,
      createdAt: now,
      updatedAt: now,
    };
    const projection = createEmptyProjection(conv, participants);
    this.activeTabByConversation[convId] = 'general';
    this.state = {
      ...state,
      conversations: {
        ...state.conversations,
        [convId]: projection,
      },
      activeProjectId: input.projectId,
      activeConversationId: convId,
    };
    this.notifyState();
    return projection;
  }

  async renameConversation(conversationId: string, title: string): Promise<void> {
    const state = this.getStateSnapshot();
    const trimmed = title.trim();
    if (!trimmed) {
      throw new GatewayCapabilityError(
        'VALIDATION_ERROR',
        'O título da conversa não pode ficar vazio.',
      );
    }
    const target = state.conversations[conversationId];
    if (!target) return;
    this.state = {
      ...state,
      conversations: {
        ...state.conversations,
        [conversationId]: {
          ...target,
          conversation: {
            ...target.conversation,
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
    const target = state.conversations[conversationId];
    if (!target) return;
    this.state = {
      ...state,
      conversations: {
        ...state.conversations,
        [conversationId]: {
          ...target,
          conversation: {
            ...target.conversation,
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
    const trimmed = profile.displayName.trim();
    if (!trimmed) {
      throw new GatewayCapabilityError(
        'VALIDATION_ERROR',
        'Informe um nome para o perfil de participante.',
      );
    }
    const id = profile.id ?? this.nextId('prof');
    const saved: ParticipantProfile = {
      ...profile,
      id,
      displayName: trimmed,
      defaultRoles:
        profile.defaultRoles.length > 0 ? [...profile.defaultRoles] : ['executor'],
    };
    const exists = state.participantProfiles.some((p) => p.id === id);
    this.state = {
      ...state,
      participantProfiles: exists
        ? state.participantProfiles.map((p) => (p.id === id ? saved : p))
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
    const trimmed = preset.name.trim();
    if (!trimmed) {
      throw new GatewayCapabilityError(
        'VALIDATION_ERROR',
        'Informe um nome para o preset de equipe.',
      );
    }
    const id = preset.id ?? this.nextId('preset');
    const saved: TeamPreset = {
      ...preset,
      id,
      name: trimmed,
      members: preset.members.map((m) => ({
        ...m,
        roles: [...m.roles],
        modelRef: { ...m.modelRef },
      })),
    };
    const exists = state.teamPresets.some((p) => p.id === id);
    this.state = {
      ...state,
      teamPresets: exists
        ? state.teamPresets.map((p) => (p.id === id ? saved : p))
        : [...state.teamPresets, saved],
    };
    this.notifyState();
    return saved;
  }

  async applyTeamPreset(conversationId: string, presetId: string): Promise<void> {
    const state = this.getStateSnapshot();
    const proj = state.conversations[conversationId];
    if (!proj) {
      throw new GatewayCapabilityError(
        'CONVERSATION_NOT_FOUND',
        'Conversa não encontrada.',
      );
    }
    const preset = state.teamPresets.find((p) => p.id === presetId);
    if (!preset) {
      throw new GatewayCapabilityError(
        'VALIDATION_ERROR',
        'Preset de equipe não encontrado.',
      );
    }
    if (proj.eventLog.length > 0 && proj.tasks.length > 0) {
      throw new GatewayCapabilityError(
        'VALIDATION_ERROR',
        'Esta conversa já possui execução iniciada. Crie uma nova conversa com o preset desejado ou ajuste participantes individualmente para não corromper o histórico.',
      );
    }
    const participants = instantiateParticipantsFromPreset({
      preset,
      conversationId,
      idGenerator: (p) => this.nextId(p),
      isSimulated: proj.conversation.executionMode !== 'aion_core',
    });
    const coord =
      participants.find((p) => hasRole(p, 'coordinator')) ?? participants[0];
    const nextMessagesByTab: ConversationProjection['messagesByTab'] = {
      general: proj.messagesByTab.general ?? [],
    };
    for (const p of participants) {
      nextMessagesByTab[p.id] = [];
    }
    this.activeTabByConversation[conversationId] = 'general';
    this.state = {
      ...state,
      conversations: {
        ...state.conversations,
        [conversationId]: {
          ...proj,
          conversation: {
            ...proj.conversation,
            teamPresetId: preset.id,
            coordinatorParticipantId: coord.id,
          },
          participants,
          messagesByTab: nextMessagesByTab,
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
    const roles: ParticipantRole[] =
      member.roles.length > 0 ? [...member.roles] : ['executor'];
    const participantId = this.nextId('part');
    const now = new Date().toISOString();
    const maxOrder = proj.participants.reduce(
      (max, p) => Math.max(max, p.tabOrder),
      -1,
    );
    const participant: Participant = {
      id: participantId,
      conversationId,
      profileId: member.profileId,
      connectionId: member.connectionId,
      agentProfileId: member.connectionId,
      displayName: member.displayName.trim() || 'Novo participante',
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
        status: 'active',
        createdAt: now,
      },
      status: 'idle',
      unreadCount: 0,
      tabOrder: maxOrder + 1,
      isSimulated: proj.conversation.executionMode !== 'aion_core',
    };

    const candidateList = [...proj.participants, participant];
    const validation = validateTeamConfiguration(candidateList, state.connections);
    if (!validation.valid) {
      throw new GatewayCapabilityError('VALIDATION_ERROR', validation.errors[0]);
    }

    const seq = this.getNextSeq(proj);
    this.emitAndIngest(conversationId, {
      id: this.nextId('evt_part_add'),
      seq,
      conversationId,
      timestamp: now,
      origin: 'user',
      originSource: 'user',
      participantId,
      type: 'participant_added',
      payload: { participant },
    });
    return participant;
  }

  async removeParticipantFromConversation(
    conversationId: string,
    participantId: string,
    reason = 'Removido pelo usuário na configuração da equipe.',
  ): Promise<void> {
    const state = this.getStateSnapshot();
    const proj = state.conversations[conversationId];
    if (!proj) {
      throw new GatewayCapabilityError(
        'CONVERSATION_NOT_FOUND',
        'Conversa não encontrada.',
      );
    }
    if (proj.conversation.coordinatorParticipantId === participantId) {
      throw new GatewayCapabilityError(
        'VALIDATION_ERROR',
        'Não é possível remover o coordenador ativo. Defina outro coordenador antes.',
      );
    }
    const seq = this.getNextSeq(proj);
    this.emitAndIngest(conversationId, {
      id: this.nextId('evt_part_rem'),
      seq,
      conversationId,
      timestamp: new Date().toISOString(),
      origin: 'user',
      originSource: 'user',
      participantId,
      type: 'participant_removed',
      payload: { participantId, reason },
    });
  }

  async reorderParticipantTabs(
    conversationId: string,
    orderedParticipantIds: string[],
  ): Promise<void> {
    const state = this.getStateSnapshot();
    const proj = state.conversations[conversationId];
    if (!proj) return;
    const seq = this.getNextSeq(proj);
    this.emitAndIngest(conversationId, {
      id: this.nextId('evt_reorder'),
      seq,
      conversationId,
      timestamp: new Date().toISOString(),
      origin: 'user',
      originSource: 'user',
      type: 'participant_tabs_reordered',
      payload: { orderedParticipantIds },
    });
  }

  async configureParticipant(input: ConfigureParticipantInput): Promise<void> {
    const state = this.getStateSnapshot();
    const proj = state.conversations[input.conversationId];
    if (!proj) {
      throw new GatewayCapabilityError(
        'CONVERSATION_NOT_FOUND',
        'Conversa não encontrada.',
      );
    }
    const target = proj.participants.find((p) => p.id === input.participantId);
    if (!target) {
      throw new GatewayCapabilityError(
        'VALIDATION_ERROR',
        'Participante não encontrado nesta conversa.',
      );
    }

    const nextRoles: ParticipantRole[] =
      input.roles && input.roles.length > 0
        ? [...input.roles]
        : input.role
          ? [input.role]
          : target.roles;
    const previousCoordId = proj.conversation.coordinatorParticipantId;
    const wantsCoordinator = nextRoles.includes('coordinator');

    if (wantsCoordinator && input.participantId !== previousCoordId) {
      const seq = this.getNextSeq(proj);
      this.emitAndIngest(input.conversationId, {
        id: this.nextId('evt_coord'),
        seq,
        conversationId: input.conversationId,
        timestamp: new Date().toISOString(),
        origin: 'user',
        originSource: 'user',
        participantId: input.participantId,
        type: 'coordinator_changed',
        payload: {
          assignmentId: this.nextId('assign'),
          previousParticipantId: previousCoordId,
          nextParticipantId: input.participantId,
          reason:
            input.reason?.trim() ||
            'Transição explícita definida pelo usuário (sem transferência automática de sessão entre fornecedores).',
        },
      });
    } else if (!wantsCoordinator && input.participantId === previousCoordId) {
      throw new GatewayCapabilityError(
        'VALIDATION_ERROR',
        'A conversa precisa manter exatamente um coordenador ativo. Promova outro participante antes de remover este papel.',
      );
    }

    const refreshedProj =
      this.getStateSnapshot().conversations[input.conversationId];
    const nextModelTier =
      input.modelTier ?? input.modelRef?.tier ?? target.modelTier;
    const nextModelRef =
      input.modelRef ??
      (input.modelTier && input.modelTier !== target.modelTier
        ? makeDemoModelRef(input.modelTier)
        : target.modelRef);

    const changeEventId = this.nextId('evt_pcfg');
    const seq2 = this.getNextSeq(refreshedProj);
    const changeRecord: ConfigChangeRecord = {
      id: this.nextId('cfg_chg'),
      conversationId: input.conversationId,
      participantId: input.participantId,
      changeKind:
        input.modelRef || input.modelTier
          ? 'model'
          : input.roles || input.role
            ? 'roles'
            : input.instructions !== undefined
              ? 'instructions'
              : 'connection',
      previousSummary: `${target.displayName} (${target.roles.join(', ')}) · ${target.modelRef.displayName}`,
      nextSummary: `${input.displayName?.trim() || target.displayName} (${nextRoles.join(', ')}) · ${nextModelRef.displayName}`,
      reason: input.reason?.trim() || 'Configuração atualizada pelo usuário.',
      appliesToNextAttemptOnly: true,
      decidedAt: new Date().toISOString(),
      sourceEventId: changeEventId,
    };

    this.emitAndIngest(input.conversationId, {
      id: changeEventId,
      seq: seq2,
      conversationId: input.conversationId,
      timestamp: changeRecord.decidedAt,
      origin: 'user',
      originSource: 'user',
      participantId: input.participantId,
      type: 'participant_configured',
      payload: {
        changeRecord,
        displayName: input.displayName?.trim() || target.displayName,
        roles: nextRoles,
        modelRef: nextModelRef,
        modelTier: nextModelTier,
        instructions: input.instructions ?? target.instructions,
        connectionId: input.connectionId ?? target.connectionId,
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
      throw new GatewayCapabilityError('VALIDATION_ERROR', validation.errors[0]);
    }

    const latestPlan = proj.planRevisions[proj.planRevisions.length - 1];
    const task: Task = {
      id: taskId,
      conversationId: input.conversationId,
      sourceRequestEventId:
        proj.eventLog[0]?.id ?? this.nextId('evt_manual_req'),
      planRevisionId: latestPlan?.id,
      title: input.title.trim(),
      description: input.description.trim() || input.title.trim(),
      assigneeParticipantId: input.assigneeParticipantId,
      reviewerParticipantId: input.reviewerParticipantId,
      dependencyTaskIds: [...input.dependencyTaskIds],
      acceptanceCriteria: input.acceptanceCriteria
        .map((c) => c.trim())
        .filter(Boolean),
      status: input.dependencyTaskIds.length > 0 ? 'planned' : 'queued',
      attempts: [],
      reviews: [],
      operationalFailureCount: 0,
      qualityRejectionCount: 0,
      originSource: 'user',
    };

    const assignee = proj.participants.find(
      (p) => p.id === input.assigneeParticipantId,
    );
    const seq = this.getNextSeq(proj);
    this.emitAndIngest(input.conversationId, {
      id: this.nextId('evt_task_create'),
      seq,
      conversationId: input.conversationId,
      timestamp: new Date().toISOString(),
      origin: 'user',
      originSource: 'user',
      taskId: task.id,
      type: 'task_created',
      payload: {
        task,
        generalSummary: `Nova tarefa criada: "${task.title}" (executor: ${assignee?.displayName ?? task.assigneeParticipantId}).`,
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
    if (!proj) {
      throw new GatewayCapabilityError(
        'CONVERSATION_NOT_FOUND',
        'Conversa não encontrada.',
      );
    }
    const existing = proj.tasks.find((t) => t.id === input.taskId);
    if (!existing) {
      throw new GatewayCapabilityError('VALIDATION_ERROR', 'Tarefa não encontrada.');
    }

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
      throw new GatewayCapabilityError('VALIDATION_ERROR', validation.errors[0]);
    }

    const seq = this.getNextSeq(proj);
    this.emitAndIngest(input.conversationId, {
      id: this.nextId('evt_task_upd'),
      seq,
      conversationId: input.conversationId,
      timestamp: new Date().toISOString(),
      origin: 'user',
      originSource: 'user',
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
          acceptanceCriteria: input.acceptanceCriteria
            .map((c) => c.trim())
            .filter(Boolean),
        },
        generalSummary: `Tarefa "${input.title.trim()}" atualizada (alterações aplicadas às próximas tentativas).`,
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
    const nextVersion =
      (proj.planRevisions[proj.planRevisions.length - 1]?.versionNumber ?? 0) +
      1;
    const seq = this.getNextSeq(proj);
    const eventId = this.nextId('evt_plan');
    const planRevision: PlanRevision = {
      id: this.nextId(`plan_rev_${nextVersion}`),
      conversationId: input.conversationId,
      versionNumber: nextVersion,
      authorLabel: input.authorLabel?.trim() || 'Você',
      createdAt: new Date().toISOString(),
      summary: input.summary.trim() || `Revisão do plano v${nextVersion}`,
      taskIds: proj.tasks.map((t) => t.id),
      sourceEventId: eventId,
      originSource: 'user',
    };
    this.emitAndIngest(input.conversationId, {
      id: eventId,
      seq,
      conversationId: input.conversationId,
      timestamp: planRevision.createdAt,
      origin: 'user',
      originSource: 'user',
      type: 'plan_revision_published',
      payload: {
        planRevision,
        generalSummary: `Plano v${nextVersion} publicado: ${planRevision.summary}`,
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

  private getNextSeq(proj: ConversationProjection): number {
    const pendingMax = Object.keys(proj.pendingOutOfOrder).reduce(
      (max, k) => Math.max(max, Number(k)),
      0,
    );
    const heldMax = (
      this.heldBackMissingEvents.get(proj.conversation.id) ?? []
    ).reduce((max, e) => Math.max(max, e.seq), 0);
    return (
      Math.max(proj.conversation.lastAppliedSeq, pendingMax, heldMax) + 1
    );
  }

  async sendMessage(input: SendMessageInput): Promise<void> {
    const state = this.getStateSnapshot();
    const proj = state.conversations[input.conversationId];
    if (!proj) {
      throw new GatewayCapabilityError(
        'CONVERSATION_NOT_FOUND',
        'Conversa não encontrada.',
      );
    }
    const text = input.bodyMarkdown.trim();
    if (!text) {
      throw new GatewayCapabilityError(
        'VALIDATION_ERROR',
        'Digite uma mensagem antes de enviar.',
      );
    }

    const isGeneral = input.targetTab === 'general';
    const targetParticipantId = isGeneral
      ? proj.conversation.coordinatorParticipantId
      : input.targetTab;
    const targetParticipant = proj.participants.find(
      (p) => p.id === targetParticipantId && !p.archived,
    );
    if (!targetParticipant) {
      throw new GatewayCapabilityError(
        'VALIDATION_ERROR',
        'Destinatário inválido ou arquivado para envio.',
      );
    }

    const now = new Date().toISOString();
    const seq1 = this.getNextSeq(proj);
    const userEvent: ExecutionEvent = {
      id: this.nextId('evt_user'),
      seq: seq1,
      conversationId: input.conversationId,
      timestamp: now,
      origin: 'user',
      originSource: 'user',
      participantId: targetParticipantId,
      type: 'user_message_sent',
      payload: {
        messageId: this.nextId('msg_u'),
        targetTab: input.targetTab,
        targetParticipantId,
        bodyMarkdown: text,
        generalSummary: isGeneral ? text : undefined,
      },
    };
    this.emitAndIngest(input.conversationId, userEvent);

    if (isGeneral && input.promoteToSharedContext) {
      const latestProj =
        this.getStateSnapshot().conversations[input.conversationId];
      const latestRev = getLatestContextRevision(latestProj);
      await this.publishContextRevision({
        conversationId: input.conversationId,
        authorLabel: 'Você (promovido da Geral)',
        summaryOfChange: `Orientação promovida ao Contexto Comum: "${text.slice(0, 72)}"`,
        objective: latestRev?.objective ?? text,
        permanentInstructions: latestRev?.permanentInstructions ?? [],
        constraints: [...(latestRev?.constraints ?? []), text],
        acceptanceCriteria: latestRev?.acceptanceCriteria ?? [],
        confirmedDecisions: latestRev?.confirmedDecisions ?? [],
      });
    }

    const currentProj =
      this.getStateSnapshot().conversations[input.conversationId];
    const seq2 = this.getNextSeq(currentProj);
    const primaryRole = getPrimaryRole(targetParticipant.roles);
    const replyEvent: ExecutionEvent = {
      id: this.nextId('evt_ack'),
      seq: seq2,
      conversationId: input.conversationId,
      timestamp: new Date().toISOString(),
      origin:
        primaryRole === 'coordinator'
          ? 'coordinator'
          : primaryRole === 'reviewer'
            ? 'reviewer'
            : 'executor',
      originSource: 'demo_simulation',
      participantId: targetParticipant.id,
      type: 'agent_message_posted',
      payload: {
        messageId: this.nextId('msg_a'),
        targetTab: isGeneral ? 'general' : targetParticipant.id,
        authorLabel: targetParticipant.displayName,
        authorRoleLabel: PT_BR.roleLabels[primaryRole],
        bodyMarkdown: isGeneral
          ? `Recebido pelo coordenador **${targetParticipant.displayName}** (simulação). ${
              input.promoteToSharedContext
                ? 'A orientação também gerou uma nova revisão no Contexto Compartilhado com recibos individuais.'
                : 'Demais participantes não foram alterados automaticamente; use Contexto Compartilhado se quiser distribuir como regra comum.'
            }`
          : `Mensagem direta recebida por **${targetParticipant.displayName}** (simulação). Este registro permanece restrito a esta aba.`,
        projectToGeneral: isGeneral,
        generalKind: 'coordinator_plan',
        generalSummary: isGeneral
          ? `${targetParticipant.displayName} registrou recebimento da orientação na Geral.`
          : undefined,
      },
    };
    this.emitAndIngest(input.conversationId, replyEvent);
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
      hasMore: end - limit > 0,
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
    if (!proj) {
      throw new GatewayCapabilityError(
        'CONVERSATION_NOT_FOUND',
        'Conversa não encontrada.',
      );
    }

    if (input.participantId) {
      const participant = proj.participants.find(
        (p) => p.id === input.participantId,
      );
      const conn = state.connections.find(
        (c) => c.id === participant?.connectionId,
      );
      if (
        input.action === 'request_interrupt' &&
        conn &&
        conn.capabilities.supportsInterrupt !== true
      ) {
        const seq = this.getNextSeq(proj);
        this.emitAndIngest(input.conversationId, {
          id: this.nextId('evt_int_fail'),
          seq,
          conversationId: input.conversationId,
          timestamp: new Date().toISOString(),
          origin: 'gateway',
          originSource: 'aion_desk_local',
          participantId: input.participantId,
          type: 'execution_control_applied',
          payload: {
            control: 'interrupt_failed',
            participantId: input.participantId,
            generalSummary: `Falha ao solicitar interrupção de ${participant?.displayName ?? 'agente'}: capacidade não suportada ou desconhecida na conexão.`,
          },
        });
        throw new GatewayCapabilityError(
          'CAPABILITY_UNSUPPORTED',
          `${participant?.displayName ?? 'Este participante'} não possui suporte confirmado a interrupção em andamento.`,
        );
      }
    }

    const seq = this.getNextSeq(proj);
    const now = new Date().toISOString();

    if (input.action === 'pause_queue') {
      this.pauseAutoPlay(input.conversationId);
      this.emitAndIngest(input.conversationId, {
        id: this.nextId('evt_ctrl'),
        seq,
        conversationId: input.conversationId,
        timestamp: now,
        origin: 'user',
        originSource: 'user',
        type: 'execution_control_applied',
        payload: {
          control: 'pause_queue',
          nextExecutionStatus: 'paused_queue',
          generalSummary:
            'Fila de novas tarefas pausada pelo usuário (execuções já iniciadas permanecem visíveis).',
        },
      });
      return;
    }

    if (input.action === 'resume_queue') {
      this.emitAndIngest(input.conversationId, {
        id: this.nextId('evt_ctrl'),
        seq,
        conversationId: input.conversationId,
        timestamp: now,
        origin: 'user',
        originSource: 'user',
        type: 'execution_control_applied',
        payload: {
          control: 'resume_queue',
          nextExecutionStatus: 'running',
          generalSummary: 'Fila de tarefas retomada pelo usuário.',
        },
      });
      return;
    }

    if (input.action === 'request_interrupt' && input.participantId) {
      const p = proj.participants.find((item) => item.id === input.participantId);
      this.emitAndIngest(input.conversationId, {
        id: this.nextId('evt_ctrl'),
        seq,
        conversationId: input.conversationId,
        timestamp: now,
        origin: 'user',
        originSource: 'user',
        participantId: input.participantId,
        type: 'execution_control_applied',
        payload: {
          control: 'request_interrupt',
          participantId: input.participantId,
          participantStatus: 'idle',
          generalSummary: `Interrupção solicitada para ${p?.displayName ?? 'agente'} (simulação — encerramento lógico na fila).`,
        },
      });
      return;
    }

    if (input.action === 'terminate_session' && input.participantId) {
      const p = proj.participants.find((item) => item.id === input.participantId);
      this.emitAndIngest(input.conversationId, {
        id: this.nextId('evt_ctrl'),
        seq,
        conversationId: input.conversationId,
        timestamp: now,
        origin: 'user',
        originSource: 'user',
        participantId: input.participantId,
        type: 'execution_control_applied',
        payload: {
          control: 'terminate_session',
          participantId: input.participantId,
          participantStatus: 'disconnected',
          generalSummary: `Sessão simulada de ${p?.displayName ?? 'agente'} encerrada pelo usuário.`,
        },
      });
    }
  }

  async respondPermission(input: {
    conversationId: string;
    requestId: string;
    decision: 'approved' | 'denied';
    note?: string;
  }): Promise<void> {
    const state = this.getStateSnapshot();
    const proj = state.conversations[input.conversationId];
    if (!proj) return;
    const req = proj.permissions.find((p) => p.id === input.requestId);
    if (!req || req.status !== 'pending') return;

    const seq = this.getNextSeq(proj);
    const now = new Date().toISOString();
    this.emitAndIngest(input.conversationId, {
      id: this.nextId('evt_perm_res'),
      seq,
      conversationId: input.conversationId,
      timestamp: now,
      origin: 'user',
      originSource: 'user',
      participantId: req.participantId,
      taskId: req.taskId,
      type: 'permission_decided',
      payload: {
        decision: {
          requestId: req.id,
          decision: input.decision,
          decidedBy: 'Você',
          note:
            input.note?.trim() ||
            (input.decision === 'approved'
              ? 'Aprovado no escopo simulado.'
              : 'Recusado pelo usuário; execução bloqueada para este escopo até nova autorização equivalente.'),
          decidedAt: now,
        },
        generalSummary:
          input.decision === 'approved'
            ? `Permissão aprovada para "${req.actionTitle}".`
            : `Permissão recusada para "${req.actionTitle}"; execução bloqueada.`,
      },
    });
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
    if (!esc || esc.status !== 'suggested') return;

    const participant = proj.participants.find((p) => p.id === esc.participantId);
    const seq = this.getNextSeq(proj);
    this.emitAndIngest(input.conversationId, {
      id: this.nextId('evt_esc_res'),
      seq,
      conversationId: input.conversationId,
      timestamp: new Date().toISOString(),
      origin: 'user',
      originSource: 'user',
      participantId: esc.participantId,
      taskId: esc.taskId,
      type: 'escalation_resolved',
      payload: {
        escalationId: esc.id,
        resolution: input.resolution,
        participantId: esc.participantId,
        appliedTier:
          input.resolution === 'approved' ? esc.toTier : esc.fromTier,
        appliedModelRef:
          input.resolution === 'approved' ? esc.toModelRef : esc.fromModelRef,
        generalSummary:
          input.resolution === 'approved'
            ? `Escalonamento aprovado para ${participant?.displayName ?? 'agente'}: perfil promovido.`
            : `Sugestão de escalonamento dispensada; mantendo perfil atual de ${participant?.displayName ?? 'agente'}.`,
      },
    });
  }

  async registerTaskReview(input: {
    conversationId: string;
    review: Omit<TaskReview, 'id' | 'decidedAt' | 'sourceEventId'>;
  }): Promise<void> {
    const state = this.getStateSnapshot();
    const proj = state.conversations[input.conversationId];
    if (!proj) return;
    const seq = this.getNextSeq(proj);
    const eventId = this.nextId('evt_rev');
    const now = new Date().toISOString();
    this.emitAndIngest(input.conversationId, {
      id: eventId,
      seq,
      conversationId: input.conversationId,
      timestamp: now,
      origin: 'reviewer',
      originSource: 'user',
      participantId: input.review.reviewerParticipantId,
      taskId: input.review.taskId,
      attemptId: input.review.attemptId,
      type: 'task_reviewed',
      payload: {
        review: {
          ...input.review,
          id: this.nextId('rev'),
          decidedAt: now,
          sourceEventId: eventId,
        },
        nextTaskStatus:
          input.review.decision === 'approved'
            ? 'completed'
            : 'changes_requested',
        generalSummary:
          input.review.decision === 'approved'
            ? `Revisão aprovada: ${input.review.rationale}`
            : `Reprovação de qualidade registrada: ${input.review.rationale}`,
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

    const nextVersion =
      (proj.contextRevisions[proj.contextRevisions.length - 1]?.versionNumber ??
        0) + 1;
    const revId = this.nextId(`ctx_rev_${nextVersion}`);
    const now = new Date().toISOString();

    const receipts: Record<string, ContextReceipt> = {};
    for (const p of proj.participants) {
      if (p.archived) continue;
      const conn = state.connections.find((c) => c.id === p.connectionId);
      const canInject = conn?.capabilities.supportsMidRunContextInjection === true;
      const isRunning = p.status === 'running';

      if (p.status === 'disconnected' || p.status === 'failed') {
        receipts[p.id] = {
          participantId: p.id,
          revisionId: revId,
          status: 'failed_needs_action',
          policyApplied: 'next_turn',
          updatedAt: now,
          mechanismNote:
            'Participante desconectado; entrega pendente de reconexão.',
        };
      } else if (canInject && isRunning) {
        receipts[p.id] = {
          participantId: p.id,
          revisionId: revId,
          status: 'applied',
          policyApplied: 'mid_run_injection',
          updatedAt: now,
          mechanismNote:
            'Simulado: conexão suporta injeção durante execução e confirmou aplicação.',
        };
      } else if (isRunning) {
        receipts[p.id] = {
          participantId: p.id,
          revisionId: revId,
          status: 'sent',
          policyApplied: 'next_turn',
          updatedAt: now,
          mechanismNote:
            'Simulado: enviado para o próximo turno (envio não comprova leitura durante a tentativa em curso).',
        };
      } else {
        receipts[p.id] = {
          participantId: p.id,
          revisionId: revId,
          status: 'received',
          policyApplied: 'next_turn',
          updatedAt: now,
          mechanismNote:
            'Simulado: recebido na fila; será aplicado ao iniciar o próximo turno.',
        };
      }
    }

    const revision: SharedContextRevision = {
      id: revId,
      conversationId: input.conversationId,
      versionNumber: nextVersion,
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

    const seq = this.getNextSeq(proj);
    this.emitAndIngest(input.conversationId, {
      id: this.nextId('evt_ctx'),
      seq,
      conversationId: input.conversationId,
      timestamp: now,
      origin: 'system',
      originSource: 'user',
      type: 'context_revision_published',
      payload: {
        revision,
        generalSummary: `Contexto compartilhado v${nextVersion} publicado: ${input.summaryOfChange}`,
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
    if (!conn) {
      throw new GatewayCapabilityError(
        'VALIDATION_ERROR',
        'Conexão de agente não encontrada.',
      );
    }
    const testedAt = new Date().toISOString();
    const message = `Resultado simulado para ${conn.displayName}: contrato de UI validado no navegador (executável local não verificado neste preview).`;
    const updatedConnections: ConnectionAdapterConfig[] = state.connections.map(
      (c) =>
        c.id === connectionId
          ? {
              ...c,
              lastConnectionTestAt: testedAt,
              lastConnectionTestResult: message,
            }
          : c,
    );
    this.state = {
      ...state,
      connections: updatedConnections,
      agentProfiles: connectionsToAgentProfiles(updatedConnections),
    };
    this.notifyState();
    return {
      ok: true,
      testedAt,
      message,
      isSimulated: true,
    };
  }

  async reconcileConversation(conversationId: string): Promise<ReconcileResult> {
    const state = this.getStateSnapshot();
    const proj = state.conversations[conversationId];
    if (!proj) {
      throw new GatewayCapabilityError(
        'CONVERSATION_NOT_FOUND',
        'Conversa não encontrada.',
      );
    }

    const combinedMap = new Map<string, ExecutionEvent>();
    for (const evt of state.simulatedHeldBackEvents?.[conversationId] ?? []) {
      combinedMap.set(evt.id, evt);
    }
    for (const evt of this.heldBackMissingEvents.get(conversationId) ?? []) {
      combinedMap.set(evt.id, evt);
    }
    const missing = Array.from(combinedMap.values());

    if (proj.conversation.syncState === 'gap_detected') {
      const pendingSeqs = Object.keys(proj.pendingOutOfOrder).map(Number);
      const maxPendingSeq =
        pendingSeqs.length > 0
          ? Math.max(...pendingSeqs)
          : proj.conversation.lastAppliedSeq;
      const coveredSeqs = new Set<number>([
        ...pendingSeqs,
        ...missing.map((e) => e.seq),
      ]);
      const roles = resolveTeamRoles(
        proj.participants,
        proj.conversation.coordinatorParticipantId,
      );
      const fallbackActor = roles.executor ?? roles.coordinator ?? proj.participants[0];

      for (
        let seq = proj.conversation.lastAppliedSeq + 1;
        seq < maxPendingSeq;
        seq += 1
      ) {
        if (!coveredSeqs.has(seq) && fallbackActor) {
          const fallbackEvent: ExecutionEvent = {
            id: `evt_reconciled_gap_${conversationId}_${seq}`,
            seq,
            conversationId,
            timestamp: new Date().toISOString(),
            origin: 'executor',
            originSource: 'demo_simulation',
            participantId: fallbackActor.id,
            type: 'agent_message_posted',
            payload: {
              messageId: `msg_reconciled_gap_${conversationId}_${seq}`,
              targetTab: fallbackActor.id,
              authorLabel: fallbackActor.displayName,
              authorRoleLabel: PT_BR.roleLabels[fallbackActor.role],
              bodyMarkdown: `Evento recuperado na reconciliação (\`seq ${seq}\`): estado intermediário reconstruído de forma determinística.`,
              projectToGeneral: true,
              generalKind: 'task_progress',
              generalSummary: `Evento faltante (seq ${seq}) recuperado na reconciliação.`,
            },
          };
          missing.push(fallbackEvent);
        }
      }
    }

    const activeTab = this.getVisibleActiveTab(conversationId);
    const reconciled = reconcileWithMissingEvents(proj, missing, activeTab);
    const remainingHeld = missing.filter(
      (evt) => evt.seq > reconciled.conversation.lastAppliedSeq,
    );
    if (remainingHeld.length === 0) {
      this.heldBackMissingEvents.delete(conversationId);
    } else {
      this.heldBackMissingEvents.set(conversationId, remainingHeld);
    }

    const nextHeldRecord = { ...(state.simulatedHeldBackEvents ?? {}) };
    if (remainingHeld.length === 0) {
      delete nextHeldRecord[conversationId];
    } else {
      nextHeldRecord[conversationId] = remainingHeld;
    }

    this.state = {
      ...state,
      simulatedHeldBackEvents:
        Object.keys(nextHeldRecord).length > 0 ? nextHeldRecord : undefined,
      conversations: {
        ...state.conversations,
        [conversationId]: reconciled,
      },
    };
    this.notifyState();
    return {
      mode: 'missing_events',
      events: missing,
      synced: reconciled.conversation.syncState === 'synced',
      remainingGapSeq: reconciled.conversation.missingFromSeq,
    };
  }

  async importWorkspaceState(nextState: WorkspaceStoreState): Promise<void> {
    this.pauseAutoPlay();
    this.heldBackMissingEvents.clear();
    this.activeTabByConversation = {};
    this.state = nextState;
    if (nextState.simulatedHeldBackEvents) {
      for (const [convId, events] of Object.entries(
        nextState.simulatedHeldBackEvents,
      )) {
        if (events.length > 0) {
          this.heldBackMissingEvents.set(convId, events);
        }
      }
    }
    await this.persistence.resetAndSave(nextState);
    for (const listener of this.stateListeners) {
      listener(nextState);
    }
  }

  // --- Deterministic Demonstration Controls ---

  stepScenario(conversationId: string): StepScenarioResult {
    const state = this.getStateSnapshot();
    const proj = state.conversations[conversationId];
    if (!proj) return { finished: true };

    const baseSeq = this.getNextSeq(proj) - 1;
    const stepOut = buildNextCollaborationStep(
      proj,
      state.modelPolicy,
      state.connections,
      baseSeq,
    );
    if (stepOut.blocked) {
      return {
        finished: false,
        blocked: true,
        blockedReason: stepOut.blockedReason,
      };
    }

    for (const evt of stepOut.events) {
      this.emitAndIngest(conversationId, evt);
    }

    const latest = this.getStateSnapshot().conversations[conversationId];
    if (latest && latest.conversation.syncState === 'synced') {
      this.state = {
        ...this.getStateSnapshot(),
        conversations: {
          ...this.getStateSnapshot().conversations,
          [conversationId]: {
            ...latest,
            conversation: {
              ...latest.conversation,
              scenarioStepIndex: stepOut.nextStepIndex,
              executionStatus: stepOut.finished
                ? 'completed'
                : latest.conversation.executionStatus,
            },
          },
        },
      };
      this.notifyState();
    }
    return { finished: stepOut.finished };
  }

  startAutoPlay(conversationId: string, intervalMs = 1500): boolean {
    this.pauseAutoPlay(conversationId);
    const state = this.getStateSnapshot();
    const proj = state.conversations[conversationId];
    if (!proj) return false;

    const preCheck = buildNextCollaborationStep(
      proj,
      state.modelPolicy,
      state.connections,
      this.getNextSeq(proj) - 1,
    );
    if (preCheck.blocked) {
      for (const cb of this.autoPlayStopCallbacks) {
        cb(preCheck.blockedReason);
      }
      return false;
    }
    if (preCheck.finished) {
      for (const cb of this.autoPlayStopCallbacks) {
        cb();
      }
      return false;
    }

    this.autoPlayConvId = conversationId;
    this.autoPlayTicks = 0;
    this.state = {
      ...state,
      conversations: {
        ...state.conversations,
        [conversationId]: {
          ...proj,
          conversation: {
            ...proj.conversation,
            executionStatus: 'running',
            autoPlayWasRunning: true,
          },
        },
      },
    };
    this.notifyState();

    this.autoPlayTimer = setInterval(() => {
      if (!this.autoPlayConvId) {
        this.pauseAutoPlay(conversationId);
        return;
      }
      this.autoPlayTicks += 1;
      const result = this.stepScenario(this.autoPlayConvId);
      if (result.blocked) {
        this.pauseAutoPlay(this.autoPlayConvId, result.blockedReason);
        return;
      }
      if (result.finished || this.autoPlayTicks >= this.maxAutoPlayTicks) {
        this.pauseAutoPlay(this.autoPlayConvId);
      }
    }, intervalMs);

    return true;
  }

  pauseAutoPlay(conversationId?: string, stopReason?: string): void {
    const wasActive = this.autoPlayTimer !== null;
    if (this.autoPlayTimer !== null) {
      clearInterval(this.autoPlayTimer);
      this.autoPlayTimer = null;
    }
    const targetId = conversationId ?? this.autoPlayConvId;
    this.autoPlayConvId = null;
    if (targetId && this.state?.conversations[targetId]) {
      const proj = this.state.conversations[targetId];
      const nextStatus =
        proj.conversation.executionStatus === 'running'
          ? 'paused_demo'
          : proj.conversation.executionStatus;
      this.state = {
        ...this.state,
        conversations: {
          ...this.state.conversations,
          [targetId]: {
            ...proj,
            conversation: {
              ...proj.conversation,
              autoPlayWasRunning: false,
              executionStatus: nextStatus,
            },
          },
        },
      };
      this.notifyState();
    }
    if (wasActive && stopReason) {
      for (const cb of this.autoPlayStopCallbacks) {
        cb(stopReason);
      }
    }
  }

  async resetDemo(): Promise<void> {
    this.pauseAutoPlay();
    this.heldBackMissingEvents.clear();
    this.activeTabByConversation = {};
    const fresh = createInitialWorkspaceState();
    const current = this.state;

    // Preserve any real aion_core projects/conversations when resetting demo!
    if (current) {
      const realProjects = current.projects.filter(
        (p) => p.executionMode === 'aion_core',
      );
      const realConvs: Record<string, ConversationProjection> = {};
      for (const [cid, cproj] of Object.entries(current.conversations)) {
        if (cproj.conversation.executionMode === 'aion_core') {
          realConvs[cid] = cproj;
        }
      }
      if (realProjects.length > 0 || Object.keys(realConvs).length > 0) {
        fresh.projects = [...fresh.projects, ...realProjects];
        fresh.conversations = { ...fresh.conversations, ...realConvs };
      }
      fresh.coreSettings = { ...current.coreSettings };
    }

    this.state = fresh;
    await this.persistence.resetAndSave(fresh);
    for (const listener of this.stateListeners) {
      listener(fresh);
    }
  }

  private resolveTargetExecutor(
    proj: ConversationProjection,
    explicitId?: string,
  ): Participant | undefined {
    if (explicitId) {
      const found = proj.participants.find(
        (item) => item.id === explicitId && !item.archived,
      );
      if (found) return found;
    }
    const roles = resolveTeamRoles(
      proj.participants,
      proj.conversation.coordinatorParticipantId,
    );
    return roles.executor ?? roles.coordinator ?? proj.participants[0];
  }

  triggerDisconnectResumeScenario(
    conversationId: string,
    participantId?: string,
  ): void {
    const proj = this.getStateSnapshot().conversations[conversationId];
    if (!proj) return;
    const p = this.resolveTargetExecutor(proj, participantId);
    if (!p) return;

    const isDisconnected = p.status === 'disconnected';
    const seq = this.getNextSeq(proj);
    this.emitAndIngest(conversationId, {
      id: this.nextId(isDisconnected ? 'evt_reconn' : 'evt_disconn'),
      seq,
      conversationId,
      timestamp: new Date().toISOString(),
      origin: 'gateway',
      originSource: 'demo_simulation',
      participantId: p.id,
      type: 'connection_state_changed',
      payload: {
        participantId: p.id,
        participantStatus: isDisconnected ? 'running' : 'disconnected',
        sessionStatus: isDisconnected ? 'active' : 'disconnected',
        projectToGeneral: true,
        generalSummary: isDisconnected
          ? `${p.displayName} reconectado e retomado com o histórico preservado (simulação).`
          : `${p.displayName} desconectado na simulação; o trabalho já registrado foi preservado.`,
      },
    });
  }

  triggerPermissionScenario(
    conversationId: string,
    options?: {
      actionKey?: string;
      scopeKey?: string;
      actionTitle?: string;
      supersedesRequestId?: string;
    },
  ): void {
    const proj = this.getStateSnapshot().conversations[conversationId];
    if (!proj) return;
    const target = this.resolveTargetExecutor(proj);
    if (!target) return;

    const seq = this.getNextSeq(proj);
    const evtId = this.nextId('evt_perm_edge');
    const taskId = proj.tasks[0]?.id;
    const actionKey = options?.actionKey ?? 'run_verification_edge';
    const scopeKey = options?.scopeKey ?? taskId ?? 'conversation_workspace';
    const actionTitle =
      options?.actionTitle ?? 'Executar comando de verificação simulada no workspace';

    this.emitAndIngest(conversationId, {
      id: evtId,
      seq,
      conversationId,
      timestamp: new Date().toISOString(),
      origin: 'executor',
      originSource: 'demo_simulation',
      participantId: target.id,
      taskId,
      type: 'permission_requested',
      payload: {
        request: {
          id: this.nextId('perm'),
          conversationId,
          participantId: target.id,
          taskId,
          actionKey,
          scopeKey,
          supersedesRequestId: options?.supersedesRequestId,
          actionTitle,
          commandSimulated: 'npm test -- --run busca-listagem (simulado)',
          scopeDescription:
            'Escopo demonstrativo: nenhuma leitura ou escrita real em disco ocorre no navegador.',
          status: 'pending',
          createdAt: new Date().toISOString(),
          sourceEventId: evtId,
          isSimulated: true,
        },
        generalSummary: `${target.displayName} solicitou permissão simulada para "${actionTitle}".`,
      },
    });
  }

  triggerDuplicateEventScenario(conversationId: string): {
    duplicatePrevented: boolean;
    replayedEventId?: string;
  } {
    const proj = this.getStateSnapshot().conversations[conversationId];
    if (!proj || proj.eventLog.length === 0) {
      return { duplicatePrevented: false };
    }
    const lastAgentEvent = [...proj.eventLog]
      .reverse()
      .find(
        (e) =>
          e.type === 'agent_message_posted' || e.type === 'user_message_sent',
      );
    const targetEvent = lastAgentEvent ?? proj.eventLog[proj.eventLog.length - 1];
    const beforeCount = proj.eventLog.length;
    this.emitAndIngest(conversationId, targetEvent);
    const afterCount =
      this.getStateSnapshot().conversations[conversationId].eventLog.length;
    return {
      duplicatePrevented: beforeCount === afterCount,
      replayedEventId: targetEvent.id,
    };
  }

  triggerOutOfOrderGapScenario(conversationId: string): void {
    const proj = this.getStateSnapshot().conversations[conversationId];
    if (!proj) return;
    const target = this.resolveTargetExecutor(proj);
    if (!target) return;

    const seqMissing = this.getNextSeq(proj);
    const seqLater = seqMissing + 1;
    const now = new Date().toISOString();

    const missingEvent: ExecutionEvent = {
      id: this.nextId('evt_gap_missing'),
      seq: seqMissing,
      conversationId,
      timestamp: now,
      origin: 'executor',
      originSource: 'demo_simulation',
      participantId: target.id,
      type: 'agent_message_posted',
      payload: {
        messageId: this.nextId('msg_gap_1'),
        targetTab: target.id,
        authorLabel: target.displayName,
        authorRoleLabel: PT_BR.roleLabels[target.role],
        bodyMarkdown: `Evento intermediário recuperado na reconciliação (\`seq ${seqMissing}\`): verificação parcial registrada antes da entrega seguinte.`,
        projectToGeneral: true,
        generalKind: 'task_progress',
        generalSummary: `${target.displayName} registrou evento intermediário (seq ${seqMissing}) recuperado na reconciliação.`,
      },
    };

    const laterEvent: ExecutionEvent = {
      id: this.nextId('evt_gap_later'),
      seq: seqLater,
      conversationId,
      timestamp: now,
      origin: 'executor',
      originSource: 'demo_simulation',
      participantId: target.id,
      type: 'agent_message_posted',
      payload: {
        messageId: this.nextId('msg_gap_2'),
        targetTab: target.id,
        authorLabel: target.displayName,
        authorRoleLabel: PT_BR.roleLabels[target.role],
        bodyMarkdown: `Evento posterior (\`seq ${seqLater}\`) recebido fora de ordem e retido no buffer até o recebimento de \`seq ${seqMissing}\`.`,
        projectToGeneral: true,
        generalKind: 'task_progress',
        generalSummary: `Evento posterior (seq ${seqLater}) mantido em ordem após reconciliação.`,
      },
    };

    const nextHeld = [
      ...(this.heldBackMissingEvents.get(conversationId) ?? []),
      missingEvent,
    ];
    this.heldBackMissingEvents.set(conversationId, nextHeld);

    const curState = this.getStateSnapshot();
    this.state = {
      ...curState,
      simulatedHeldBackEvents: {
        ...(curState.simulatedHeldBackEvents ?? {}),
        [conversationId]: nextHeld,
      },
    };

    this.emitAndIngest(conversationId, laterEvent);
  }

  triggerOperationalFailureScenario(conversationId: string): void {
    const proj = this.getStateSnapshot().conversations[conversationId];
    if (!proj) return;
    const task = proj.tasks[0];
    if (!task) return;
    const target = this.resolveTargetExecutor(proj, task.assigneeParticipantId);
    if (!target) return;
    const attempt = task.attempts[task.attempts.length - 1];
    if (!attempt) return;

    const seq = this.getNextSeq(proj);
    this.emitAndIngest(conversationId, {
      id: this.nextId('evt_op_edge'),
      seq,
      conversationId,
      timestamp: new Date().toISOString(),
      origin: 'gateway',
      originSource: 'demo_simulation',
      participantId: target.id,
      taskId: task.id,
      attemptId: attempt.id,
      type: 'operational_failure_recorded',
      payload: {
        taskId: task.id,
        attemptId: attempt.id,
        reason:
          'Timeout simulado de transporte (não afeta contagem de reprovações de qualidade).',
        participantStatus: 'disconnected',
        generalSummary: `Falha operacional simulada em ${target.displayName} (contador de qualidade mantido intacto).`,
      },
    });
  }

  triggerStress2000Scenario(conversationId: string): number {
    const proj = this.getStateSnapshot().conversations[conversationId];
    if (!proj) return 0;
    const target = this.resolveTargetExecutor(proj);
    const startingSeq = this.getNextSeq(proj) - 1;
    const events = build2000StressEvents(conversationId, startingSeq, target);
    const activeTab = this.getVisibleActiveTab(conversationId);

    let updated = proj;
    for (const evt of events) {
      updated = ingestEvent(updated, evt, activeTab).projection;
    }

    const state = this.getStateSnapshot();
    this.state = {
      ...state,
      conversations: {
        ...state.conversations,
        [conversationId]: updated,
      },
    };
    this.notifyState();
    return events.length;
  }

  dispose(): void {
    this.pauseAutoPlay();
    this.persistence.dispose();
  }
}
