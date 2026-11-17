import type {
  AgentProfile,
  ConnectionAdapterConfig,
  DemoModelTier,
  ModelRef,
  Participant,
  ParticipantProfile,
  ParticipantRole,
  TeamPreset,
} from './types';
import { getPrimaryRole } from './teamValidation';

export function makeDemoModelRef(
  tier: DemoModelTier,
  customLabel?: string,
): ModelRef {
  const defaultLabels: Record<DemoModelTier, string> = {
    fast: 'Rápido (Demonstração)',
    review: 'Revisão (Demonstração)',
    advanced: 'Avançado (Demonstração)',
  };
  return {
    displayName: customLabel ?? defaultLabels[tier],
    source: 'demo_tier',
    tier,
    confirmation: 'simulated',
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

export const DEFAULT_CONNECTIONS: ConnectionAdapterConfig[] = [
  {
    id: 'conn_codex_demo',
    displayName: 'Codex (Demonstração)',
    vendorLabel: 'Adaptador demonstrativo Codex',
    mode: 'demo',
    backendId: 'codex',
    configured: true,
    coreReachability: 'unknown',
    catalogLoaded: false,
    executableStatus: 'unknown_in_browser',
    authStatus: 'simulated',
    sessionStatus: 'active',
    availableModels: [
      { externalId: 'demo:fast', displayName: 'Rápido (Demonstração)', source: 'demo_tier', tier: 'fast', confirmed: false },
      { externalId: 'demo:review', displayName: 'Revisão (Demonstração)', source: 'demo_tier', tier: 'review', confirmed: false },
      { externalId: 'demo:advanced', displayName: 'Avançado (Demonstração)', source: 'demo_tier', tier: 'advanced', confirmed: false },
    ],
    lastConnectionTestAt: '2026-11-16T09:58:00.000Z',
    lastConnectionTestResult: 'Simulação verificada: protocolo interno pronto no preview.',
    capabilities: {
      supportsInterrupt: true,
      supportsMidRunContextInjection: true,
      supportsModelSwitchInSession: false,
      supportsPauseQueue: true,
      supportsSessionTerminate: true,
    },
    isSimulated: true,
  },
  {
    id: 'conn_claude_demo',
    displayName: 'Claude (Demonstração)',
    vendorLabel: 'Adaptador demonstrativo Claude',
    mode: 'demo',
    backendId: 'claude',
    configured: true,
    coreReachability: 'unknown',
    catalogLoaded: false,
    executableStatus: 'unknown_in_browser',
    authStatus: 'simulated',
    sessionStatus: 'active',
    availableModels: [
      { externalId: 'demo:fast', displayName: 'Rápido (Demonstração)', source: 'demo_tier', tier: 'fast', confirmed: false },
      { externalId: 'demo:review', displayName: 'Revisão (Demonstração)', source: 'demo_tier', tier: 'review', confirmed: false },
      { externalId: 'demo:advanced', displayName: 'Avançado (Demonstração)', source: 'demo_tier', tier: 'advanced', confirmed: false },
    ],
    lastConnectionTestAt: '2026-11-16T09:58:10.000Z',
    lastConnectionTestResult: 'Simulação verificada: canal de execução simulado ativo.',
    capabilities: {
      supportsInterrupt: true,
      supportsMidRunContextInjection: false,
      supportsModelSwitchInSession: true,
      supportsPauseQueue: true,
      supportsSessionTerminate: true,
    },
    isSimulated: true,
  },
  {
    id: 'conn_antigravity_demo',
    displayName: 'Antigravity (Demonstração)',
    vendorLabel: 'Adaptador demonstrativo Antigravity',
    mode: 'demo',
    backendId: 'antigravity',
    configured: true,
    coreReachability: 'unknown',
    catalogLoaded: false,
    executableStatus: 'unknown_in_browser',
    authStatus: 'unknown',
    sessionStatus: 'active',
    availableModels: [
      { externalId: 'demo:fast', displayName: 'Rápido (Demonstração)', source: 'demo_tier', tier: 'fast', confirmed: false },
      { externalId: 'demo:review', displayName: 'Revisão (Demonstração)', source: 'demo_tier', tier: 'review', confirmed: false },
      { externalId: 'demo:advanced', displayName: 'Avançado (Demonstração)', source: 'demo_tier', tier: 'advanced', confirmed: false },
    ],
    lastConnectionTestAt: '2026-11-16T09:58:15.000Z',
    lastConnectionTestResult: 'Simulação verificada: perfil demonstrativo pronto sob demanda.',
    capabilities: {
      supportsInterrupt: false,
      supportsMidRunContextInjection: false,
      supportsModelSwitchInSession: false,
      supportsPauseQueue: true,
      supportsSessionTerminate: true,
    },
    isSimulated: true,
  },
];

export const DEFAULT_PARTICIPANT_PROFILES: ParticipantProfile[] = [
  {
    id: 'prof_codex_coord',
    displayName: 'Codex',
    connectionId: 'conn_codex_demo',
    defaultRoles: ['coordinator', 'planner'],
    modelRef: makeDemoModelRef('review'),
    instructions: 'Organizar o pedido da Geral em tarefas claras e rastreáveis.',
    isSimulated: true,
  },
  {
    id: 'prof_claude_exec',
    displayName: 'Claude',
    connectionId: 'conn_claude_demo',
    defaultRoles: ['executor'],
    modelRef: makeDemoModelRef('fast'),
    instructions: 'Implementar as tarefas atribuídas respeitando critérios e contexto.',
    isSimulated: true,
  },
  {
    id: 'prof_antigravity_rev',
    displayName: 'Antigravity',
    connectionId: 'conn_antigravity_demo',
    defaultRoles: ['reviewer'],
    modelRef: makeDemoModelRef('review'),
    instructions: 'Auditar entregas contra critérios de aceitação e contexto vigente.',
    isSimulated: true,
  },
  {
    id: 'prof_terra_61',
    displayName: 'Terra 6.1',
    connectionId: 'conn_codex_demo',
    defaultRoles: ['coordinator'],
    modelRef: makePreferenceModelRef('Terra 6.1 (preferência demonstrativa)', 'review'),
    instructions: 'Coordenar a equipe, consolidar decisões e aprovar delegações.',
    isSimulated: true,
  },
  {
    id: 'prof_sol_61',
    displayName: 'Sol 6.1',
    connectionId: 'conn_codex_demo',
    defaultRoles: ['planner', 'reviewer'],
    modelRef: makePreferenceModelRef('Sol 6.1 (preferência demonstrativa)', 'review'),
    instructions: 'Estruturar o plano de tarefas e auditar entregas em sessão dedicada Codex.',
    isSimulated: true,
  },
  {
    id: 'prof_gemini_hydrogen',
    displayName: 'Gemini Hydrogen',
    connectionId: 'conn_antigravity_demo',
    defaultRoles: ['executor'],
    modelRef: makePreferenceModelRef('Gemini Hydrogen (preferência demonstrativa)', 'fast'),
    instructions: 'Executar implementação e registrar evidências via conexão Antigravity.',
    isSimulated: true,
  },
];

export const DEFAULT_TEAM_PRESETS: TeamPreset[] = [
  {
    id: 'preset_demo_original',
    name: 'Equipe padrão (Demonstração)',
    description: 'Codex (coordenador), Claude (executor) e Antigravity (auditor/revisor).',
    mode: 'demo',
    isBuiltIn: true,
    members: [
      {
        profileId: 'prof_codex_coord',
        connectionId: 'conn_codex_demo',
        displayName: 'Codex',
        roles: ['coordinator', 'planner'],
        modelRef: makeDemoModelRef('review'),
        instructions: 'Coordenar a conversa e estruturar o plano.',
      },
      {
        profileId: 'prof_claude_exec',
        connectionId: 'conn_claude_demo',
        displayName: 'Claude',
        roles: ['executor'],
        modelRef: makeDemoModelRef('fast'),
        instructions: 'Executar tarefas técnicas conforme contexto compartilhado.',
      },
      {
        profileId: 'prof_antigravity_rev',
        connectionId: 'conn_antigravity_demo',
        displayName: 'Antigravity',
        roles: ['reviewer'],
        modelRef: makeDemoModelRef('review'),
        instructions: 'Validar entregas contra critérios de aceitação.',
      },
    ],
  },
  {
    id: 'preset_terra_sol_gemini',
    name: 'Terra 6.1 / Sol 6.1 / Gemini Hydrogen',
    description:
      'Duas sessões distintas pela conexão Codex (Terra coordenador; Sol planejador+auditor) e Gemini Hydrogen (executor) via Antigravity — sem Claude.',
    mode: 'demo',
    isBuiltIn: true,
    members: [
      {
        profileId: 'prof_terra_61',
        connectionId: 'conn_codex_demo',
        displayName: 'Terra 6.1',
        roles: ['coordinator'],
        modelRef: makePreferenceModelRef('Terra 6.1 (preferência)', 'review'),
        instructions: 'Coordenar solicitações da Geral e manter alinhamento da equipe.',
      },
      {
        profileId: 'prof_sol_61',
        connectionId: 'conn_codex_demo',
        displayName: 'Sol 6.1',
        roles: ['planner', 'reviewer'],
        modelRef: makePreferenceModelRef('Sol 6.1 (preferência)', 'review'),
        instructions: 'Planejar tarefas e auditar entregas em sessão Codex separada.',
      },
      {
        profileId: 'prof_gemini_hydrogen',
        connectionId: 'conn_antigravity_demo',
        displayName: 'Gemini Hydrogen',
        roles: ['executor'],
        modelRef: makePreferenceModelRef('Gemini Hydrogen (preferência)', 'fast'),
        instructions: 'Implementar tarefas delegadas e enviar evidências via Antigravity.',
      },
    ],
  },
  {
    id: 'preset_terra_sol_split_gemini',
    name: 'Terra 6.1 / Sol Planejador + Sol Auditor / Gemini Hydrogen',
    description:
      'Quatro sessões independentes: Terra (coordenador Codex), Sol Planejador (Codex), Sol Auditor (sessão distinta Codex) e Gemini Hydrogen (executor Antigravity).',
    mode: 'demo',
    isBuiltIn: true,
    members: [
      {
        profileId: 'prof_terra_61',
        connectionId: 'conn_codex_demo',
        displayName: 'Terra 6.1',
        roles: ['coordinator'],
        modelRef: makePreferenceModelRef('Terra 6.1 (preferência)', 'review'),
        instructions: 'Coordenar a conversa e delegações.',
      },
      {
        connectionId: 'conn_codex_demo',
        displayName: 'Sol Planejador',
        roles: ['planner'],
        modelRef: makePreferenceModelRef('Sol 6.1 (preferência)', 'review'),
        instructions: 'Elaborar plano de tarefas, dependências e critérios.',
      },
      {
        connectionId: 'conn_codex_demo',
        displayName: 'Sol Auditor',
        roles: ['reviewer'],
        modelRef: makePreferenceModelRef('Sol 6.1 (preferência)', 'review'),
        instructions: 'Auditar entregas com sessão independente do planejador e do executor.',
      },
      {
        profileId: 'prof_gemini_hydrogen',
        connectionId: 'conn_antigravity_demo',
        displayName: 'Gemini Hydrogen',
        roles: ['executor'],
        modelRef: makePreferenceModelRef('Gemini Hydrogen (preferência)', 'fast'),
        instructions: 'Implementar tarefas delegadas via conexão Antigravity.',
      },
    ],
  },
];

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
