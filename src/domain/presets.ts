import { APP_BRAND } from '../config/brand';
import type {
  AgentProfile,
  ConnectionAdapterConfig,
  DemoModelTier,
  ModelPolicy,
  ModelRef,
  Participant,
  ParticipantProfile,
  ParticipantRole,
  TeamPreset,
  WorkspaceStoreState,
} from './types';
import { getPrimaryRole } from './teamValidation';

export const DEFAULT_MODEL_POLICY: ModelPolicy = {
  defaultExecutorTier: 'fast',
  reviewerTier: 'review',
  escalationTargetTier: 'advanced',
  qualityRejectionsBeforeSuggest: 2,
  approvalMode: 'manual',
};

export function makeDemoModelRef(
  tier: DemoModelTier,
  customLabel?: string,
): ModelRef {
  const defaultLabels: Record<DemoModelTier, string> = {
    fast: 'Rápido',
    review: 'Revisão',
    advanced: 'Avançado',
  };
  return {
    displayName: customLabel ?? defaultLabels[tier],
    source: 'user_preference',
    tier,
    confirmation: 'unverified_preference',
  };
}

export function makePreferenceModelRef(
  preferenceName: string,
  tierFallback: DemoModelTier = 'fast',
): ModelRef {
  return {
    displayName: preferenceName,
    source: 'user_preference',
    tier: tierFallback,
    confirmation: 'unverified_preference',
  };
}

export const DEFAULT_CONNECTIONS: ConnectionAdapterConfig[] = [];

export const DEFAULT_PARTICIPANT_PROFILES: ParticipantProfile[] = [
  {
    id: 'prof_terra_61',
    displayName: 'Terra 6.1',
    connectionId: '',
    defaultRoles: ['coordinator'],
    modelRef: makePreferenceModelRef('Terra 6.1 (preferência)', 'review'),
    instructions: 'Coordenar a equipe, consolidar decisões e aprovar delegações.',
    isSimulated: false,
  },
  {
    id: 'prof_sol_61',
    displayName: 'Sol 6.1',
    connectionId: '',
    defaultRoles: ['planner', 'reviewer'],
    modelRef: makePreferenceModelRef('Sol 6.1 (preferência)', 'review'),
    instructions: 'Estruturar o plano de tarefas e auditar entregas em sessão dedicada.',
    isSimulated: false,
  },
  {
    id: 'prof_gemini_hydrogen',
    displayName: 'Gemini Hydrogen',
    connectionId: '',
    defaultRoles: ['executor'],
    modelRef: makePreferenceModelRef('Gemini Hydrogen (preferência)', 'fast'),
    instructions: 'Executar implementação e registrar evidências na aba dedicada.',
    isSimulated: false,
  },
];

export const DEFAULT_TEAM_PRESETS: TeamPreset[] = [
  {
    id: 'preset_terra_sol_gemini',
    name: 'Terra 6.1 / Sol 6.1 / Gemini Hydrogen',
    description:
      'Coordenador (Terra 6.1), Planejador+Auditor (Sol 6.1) e Executor (Gemini Hydrogen) vinculados aos CLIs reais do AionCore.',
    mode: 'aion_core',
    isBuiltIn: true,
    members: [
      {
        profileId: 'prof_terra_61',
        connectionId: '',
        displayName: 'Terra 6.1',
        roles: ['coordinator'],
        modelRef: makePreferenceModelRef('Terra 6.1 (preferência)', 'review'),
        instructions: 'Coordenar solicitações da Geral e manter alinhamento da equipe.',
      },
      {
        profileId: 'prof_sol_61',
        connectionId: '',
        displayName: 'Sol 6.1',
        roles: ['planner', 'reviewer'],
        modelRef: makePreferenceModelRef('Sol 6.1 (preferência)', 'review'),
        instructions: 'Planejar tarefas e auditar entregas em sessão separada.',
      },
      {
        profileId: 'prof_gemini_hydrogen',
        connectionId: '',
        displayName: 'Gemini Hydrogen',
        roles: ['executor'],
        modelRef: makePreferenceModelRef('Gemini Hydrogen (preferência)', 'fast'),
        instructions: 'Implementar tarefas delegadas e enviar evidências.',
      },
    ],
  },
  {
    id: 'preset_terra_sol_split_gemini',
    name: 'Terra 6.1 / Sol Planejador + Sol Auditor / Gemini Hydrogen',
    description:
      'Quatro sessões independentes vinculadas aos CLIs reais do AionCore: Coordenador, Planejador, Auditor independente e Executor.',
    mode: 'aion_core',
    isBuiltIn: true,
    members: [
      {
        profileId: 'prof_terra_61',
        connectionId: '',
        displayName: 'Terra 6.1',
        roles: ['coordinator'],
        modelRef: makePreferenceModelRef('Terra 6.1 (preferência)', 'review'),
        instructions: 'Coordenar a conversa e delegações.',
      },
      {
        connectionId: '',
        displayName: 'Sol Planejador',
        roles: ['planner'],
        modelRef: makePreferenceModelRef('Sol 6.1 (preferência)', 'review'),
        instructions: 'Elaborar plano de tarefas, dependências e critérios.',
      },
      {
        connectionId: '',
        displayName: 'Sol Auditor',
        roles: ['reviewer'],
        modelRef: makePreferenceModelRef('Sol 6.1 (preferência)', 'review'),
        instructions: 'Auditar entregas com sessão independente do planejador e do executor.',
      },
      {
        profileId: 'prof_gemini_hydrogen',
        connectionId: '',
        displayName: 'Gemini Hydrogen',
        roles: ['executor'],
        modelRef: makePreferenceModelRef('Gemini Hydrogen (preferência)', 'fast'),
        instructions: 'Implementar tarefas delegadas.',
      },
    ],
  },
];

export function createInitialWorkspaceState(): WorkspaceStoreState {
  const defaultCoreBaseUrl =
    typeof import.meta !== 'undefined' &&
    import.meta.env &&
    typeof import.meta.env.VITE_AIONCORE_BASE_URL === 'string'
      ? import.meta.env.VITE_AIONCORE_BASE_URL
      : '';

  return {
    schemaVersion: APP_BRAND.storageSchemaVersion,
    executionMode: 'aion_core',
    coreSettings: {
      baseUrl: defaultCoreBaseUrl,
      workspacePath: '',
      authMode: 'cookie_or_bearer',
    },
    coreRuntimeStatus: 'unknown',
    coreSessionAuthenticated: false,
    projects: [],
    connections: [],
    agentProfiles: [],
    participantProfiles: structuredClone(DEFAULT_PARTICIPANT_PROFILES),
    teamPresets: structuredClone(DEFAULT_TEAM_PRESETS),
    modelPolicy: { ...DEFAULT_MODEL_POLICY },
    conversations: {},
    activeProjectId: '',
    activeConversationId: '',
  };
}

export function connectionsToAgentProfiles(
  connections: ConnectionAdapterConfig[],
): AgentProfile[] {
  return connections.map((c) => ({
    id: c.id,
    displayName: c.displayName,
    vendorLabel: c.vendorLabel,
    defaultRole:
      c.backendId === 'codex'
        ? 'coordinator'
        : c.backendId === 'antigravity'
          ? 'reviewer'
          : 'executor',
    capabilities: { ...c.capabilities },
    connection: {
      configured: c.configured,
      executableStatus: c.executableStatus,
      authStatus: c.authStatus,
      lastConnectionTestAt: c.lastConnectionTestAt,
      lastConnectionTestResult: c.lastConnectionTestResult,
      sessionStatus: c.sessionStatus,
      isSimulated: c.isSimulated,
    },
    supportedTiers: ['fast', 'review', 'advanced'],
    isSimulated: c.isSimulated,
  }));
}

export function instantiateParticipantsFromPreset(input: {
  preset: TeamPreset;
  conversationId: string;
  idGenerator: (prefix: string) => string;
  isSimulated: boolean;
  createdAt?: string;
}): Participant[] {
  const now = input.createdAt ?? new Date().toISOString();
  return input.preset.members.map((member, index) => {
    const participantId = input.idGenerator('part');
    const roles: ParticipantRole[] =
      member.roles.length > 0 ? [...member.roles] : ['executor'];
    const tier: DemoModelTier = member.modelRef.tier ?? 'fast';
    return {
      id: participantId,
      conversationId: input.conversationId,
      profileId: member.profileId,
      connectionId: member.connectionId,
      agentProfileId: member.connectionId,
      displayName: member.displayName,
      role: getPrimaryRole(roles),
      roles,
      modelRef: { ...member.modelRef },
      modelTier: tier,
      instructions: member.instructions,
      sessionRef: {
        id: input.idGenerator('sess'),
        conversationId: input.conversationId,
        participantId,
        connectionId: member.connectionId,
        status: input.isSimulated ? 'active' : 'inactive',
        createdAt: now,
      },
      status: 'idle',
      unreadCount: 0,
      tabOrder: index,
      isSimulated: input.isSimulated,
    };
  });
}
