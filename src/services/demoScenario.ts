import { APP_BRAND } from '../config/brand';
import {
  connectionsToAgentProfiles,
  DEFAULT_CONNECTIONS,
  DEFAULT_PARTICIPANT_PROFILES,
  DEFAULT_TEAM_PRESETS,
  makeDemoModelRef,
} from '../domain/presets';
import { rebuildProjectionFromEvents } from '../domain/reducer';
import type {
  ExecutionEvent,
  ModelPolicy,
  Participant,
  Project,
  SharedContextRevision,
  WorkspaceConversation,
  WorkspaceStoreState,
} from '../domain/types';

export const DEMO_PROJECT_ID = 'proj_portal_demo';
export const DEMO_CONVERSATION_ID = 'conv_busca_listagem';

/**
 * True when the workspace holds only the seeded demonstration conversation.
 *
 * A seeded workspace is not an explicit user choice, so the bootstrap treats it as
 * "no preference yet" and applies the default operating mode.
 */
export function isDemoSeedOnlyState(state: WorkspaceStoreState): boolean {
  const conversationIds = Object.keys(state.conversations ?? {});
  if (conversationIds.length === 0) return false;
  return conversationIds.every((id) => id === DEMO_CONVERSATION_ID);
}


export const DEFAULT_MODEL_POLICY: ModelPolicy = {
  defaultExecutorTier: 'fast',
  reviewerTier: 'review',
  escalationTargetTier: 'advanced',
  qualityRejectionsBeforeSuggest: 2,
  approvalMode: 'manual',
};

export function createDemoParticipants(conversationId: string): Participant[] {
  const createdAt = '2026-11-16T09:59:00.000Z';
  const isInitialSeed = conversationId === DEMO_CONVERSATION_ID;
  return [
    {
      id: isInitialSeed ? 'part_codex' : `part_${conversationId}_1`,
      conversationId,
      profileId: 'prof_codex_coord',
      connectionId: 'conn_codex_demo',
      agentProfileId: 'conn_codex_demo',
      displayName: 'Codex',
      role: 'coordinator',
      roles: ['coordinator', 'planner'],
      modelRef: makeDemoModelRef('review'),
      modelTier: 'review',
      instructions: 'Organizar o pedido da Geral em tarefas claras e rastreáveis.',
      sessionRef: {
        id: `sess_${conversationId}_1`,
        conversationId,
        participantId: isInitialSeed ? 'part_codex' : `part_${conversationId}_1`,
        connectionId: 'conn_codex_demo',
        status: 'active',
        createdAt,
      },
      status: isInitialSeed ? 'running' : 'idle',
      unreadCount: 0,
      tabOrder: 0,
      isSimulated: true,
    },
    {
      id: isInitialSeed ? 'part_claude' : `part_${conversationId}_2`,
      conversationId,
      profileId: 'prof_claude_exec',
      connectionId: 'conn_claude_demo',
      agentProfileId: 'conn_claude_demo',
      displayName: 'Claude',
      role: 'executor',
      roles: ['executor'],
      modelRef: makeDemoModelRef('fast'),
      modelTier: 'fast',
      instructions: 'Implementar as tarefas atribuídas respeitando critérios e contexto.',
      sessionRef: {
        id: `sess_${conversationId}_2`,
        conversationId,
        participantId: isInitialSeed ? 'part_claude' : `part_${conversationId}_2`,
        connectionId: 'conn_claude_demo',
        status: 'active',
        createdAt,
      },
      status: isInitialSeed ? 'running' : 'idle',
      currentTaskId: isInitialSeed ? 'task_busca_nome' : undefined,
      unreadCount: isInitialSeed ? 1 : 0,
      tabOrder: 1,
      isSimulated: true,
    },
    {
      id: isInitialSeed ? 'part_antigravity' : `part_${conversationId}_3`,
      conversationId,
      profileId: 'prof_antigravity_rev',
      connectionId: 'conn_antigravity_demo',
      agentProfileId: 'conn_antigravity_demo',
      displayName: 'Antigravity',
      role: 'reviewer',
      roles: ['reviewer'],
      modelRef: makeDemoModelRef('review'),
      modelTier: 'review',
      instructions: 'Auditar entregas contra critérios de aceitação e contexto vigente.',
      sessionRef: {
        id: `sess_${conversationId}_3`,
        conversationId,
        participantId: isInitialSeed ? 'part_antigravity' : `part_${conversationId}_3`,
        connectionId: 'conn_antigravity_demo',
        status: 'active',
        createdAt,
      },
      status: 'idle',
      unreadCount: 0,
      tabOrder: 2,
      isSimulated: true,
    },
  ];
}

export function createInitialSeedEvents(
  conversationId: string,
): ExecutionEvent[] {
  const rev1: SharedContextRevision = {
    id: 'ctx_rev_1',
    conversationId,
    versionNumber: 1,
    authorLabel: 'Você + Codex (Demonstração)',
    createdAt: '2026-11-16T10:02:00.000Z',
    summaryOfChange: 'Definição inicial do objetivo e critérios da busca por nome.',
    objective:
      'Adicionar uma busca por nome em uma listagem, preservando a estrutura existente.',
    permanentInstructions: [
      'Manter os componentes de listagem e paginação existentes sem refatoração ampla.',
      'Registrar entregas parciais apenas após revisão independente.',
    ],
    constraints: ['Não alterar o contrato de ordenação atual da listagem.'],
    acceptanceCriteria: [
      'Filtrar itens pelo nome de forma previsível (insensível a maiúsculas).',
      'Preservar a estrutura de colunas e paginação existente.',
      'Exibir estado vazio claro quando nenhum item corresponder.',
    ],
    confirmedDecisions: [
      'Codex atua como coordenador; Claude executa; Antigravity revisa.',
    ],
    receipts: {
      part_codex: {
        participantId: 'part_codex',
        revisionId: 'ctx_rev_1',
        status: 'applied',
        policyApplied: 'mid_run_injection',
        updatedAt: '2026-11-16T10:02:05.000Z',
        mechanismNote: 'Simulado: coordenador confirmou aplicação no plano.',
      },
      part_claude: {
        participantId: 'part_claude',
        revisionId: 'ctx_rev_1',
        status: 'applied',
        policyApplied: 'next_turn',
        updatedAt: '2026-11-16T10:02:10.000Z',
        mechanismNote: 'Simulado: incluído na abertura da Tentativa #1.',
      },
      part_antigravity: {
        participantId: 'part_antigravity',
        revisionId: 'ctx_rev_1',
        status: 'received',
        policyApplied: 'next_turn',
        updatedAt: '2026-11-16T10:02:12.000Z',
        mechanismNote:
          'Simulado: entregue à fila do revisor; aguardando início da revisão para confirmar aplicação.',
      },
    },
  };

  return [
    {
      id: 'evt_001',
      seq: 1,
      conversationId,
      timestamp: '2026-11-16T10:00:00.000Z',
      origin: 'user',
      originSource: 'user',
      type: 'user_message_sent',
      payload: {
        messageId: 'msg_001',
        targetTab: 'general',
        targetParticipantId: 'part_codex',
        bodyMarkdown:
          'Adicionar uma busca por nome em uma listagem, preservando a estrutura existente.',
        generalSummary:
          'Pedido inicial: adicionar uma busca por nome em uma listagem, preservando a estrutura existente.',
      },
    },
    {
      id: 'evt_002',
      seq: 2,
      conversationId,
      timestamp: '2026-11-16T10:00:40.000Z',
      origin: 'coordinator',
      originSource: 'demo_simulation',
      participantId: 'part_codex',
      type: 'agent_message_posted',
      payload: {
        messageId: 'msg_002',
        targetTab: 'general',
        authorLabel: 'Codex',
        authorRoleLabel: 'Coordenador',
        bodyMarkdown:
          'Entendido (simulação). Vou dividir o trabalho em duas frentes para preservar a estrutura atual:\n\n1. **Implementar filtro por nome** no componente da listagem (`Claude`).\n2. **Validar acessibilidade e estado vazio** após a entrega (`Antigravity`).',
        projectToGeneral: true,
        generalKind: 'coordinator_plan',
        generalSummary:
          'Plano registrado: implementar busca por nome preservando a listagem e validar critérios após entrega.',
        detailLinkLabel: 'Ver coordenação',
      },
    },
    {
      id: 'evt_003',
      seq: 3,
      conversationId,
      timestamp: '2026-11-16T10:01:00.000Z',
      origin: 'coordinator',
      originSource: 'demo_simulation',
      participantId: 'part_codex',
      type: 'agent_message_posted',
      payload: {
        messageId: 'msg_003',
        targetTab: 'part_codex',
        authorLabel: 'Codex',
        authorRoleLabel: 'Coordenador',
        bodyMarkdown:
          '### Análise inicial de coordenação [Simulado]\n\n- Pedido vinculado ao evento `evt_001`.\n- Delegação principal atribuída a `Claude` com perfil **Rápido (Demonstração)**.\n- Revisão independente obrigatória atribuída a `Antigravity`.',
        projectToGeneral: false,
      },
    },
    {
      id: 'evt_004',
      seq: 4,
      conversationId,
      timestamp: '2026-11-16T10:01:25.000Z',
      origin: 'coordinator',
      originSource: 'demo_simulation',
      taskId: 'task_busca_nome',
      type: 'task_created',
      payload: {
        task: {
          id: 'task_busca_nome',
          conversationId,
          sourceRequestEventId: 'evt_001',
          planRevisionId: 'plan_rev_seed_1',
          title: 'Implementar filtro por nome na listagem',
          description:
            'Adicionar campo de busca por nome sobre a listagem demonstrativa mantendo colunas e paginação intactas.',
          assigneeParticipantId: 'part_claude',
          reviewerParticipantId: 'part_antigravity',
          dependencyTaskIds: [],
          acceptanceCriteria: [
            'Filtrar itens pelo nome sem diferenciar maiúsculas/minúsculas.',
            'Preservar estrutura atual de colunas e paginação.',
            'Exibir mensagem clara de estado vazio quando não houver correspondências.',
          ],
          status: 'queued',
          attempts: [],
          reviews: [],
          operationalFailureCount: 0,
          qualityRejectionCount: 0,
          originSource: 'demo_simulation',
        },
        generalSummary:
          'Tarefa delegada a Claude: "Implementar filtro por nome na listagem" (auditor: Antigravity).',
      },
    },
    {
      id: 'evt_005',
      seq: 5,
      conversationId,
      timestamp: '2026-11-16T10:01:40.000Z',
      origin: 'coordinator',
      originSource: 'demo_simulation',
      taskId: 'task_validacao_final',
      type: 'task_created',
      payload: {
        task: {
          id: 'task_validacao_final',
          conversationId,
          sourceRequestEventId: 'evt_001',
          planRevisionId: 'plan_rev_seed_1',
          title: 'Validar foco e limpeza da busca após aprovação',
          description:
            'Conferir fluxo de teclado e retorno de estado após limpar o campo de busca.',
          assigneeParticipantId: 'part_claude',
          reviewerParticipantId: 'part_antigravity',
          dependencyTaskIds: ['task_busca_nome'],
          acceptanceCriteria: [
            'Limpar busca restaura todos os itens da página inicial.',
            'Dependência de implementação aprovada antes do fechamento.',
          ],
          status: 'planned',
          attempts: [],
          reviews: [],
          operationalFailureCount: 0,
          qualityRejectionCount: 0,
          originSource: 'demo_simulation',
        },
        generalSummary:
          'Tarefa dependente planejada: "Validar foco e limpeza da busca após aprovação" (aguarda conclusão da tarefa anterior).',
      },
    },
    {
      id: 'evt_006',
      seq: 6,
      conversationId,
      timestamp: '2026-11-16T10:02:00.000Z',
      origin: 'system',
      originSource: 'demo_simulation',
      type: 'context_revision_published',
      payload: {
        revision: rev1,
        generalSummary:
          'Contexto compartilhado v1 publicado e distribuído com recibos individuais por participante.',
      },
    },
    {
      id: 'evt_007',
      seq: 7,
      conversationId,
      timestamp: '2026-11-16T10:02:30.000Z',
      origin: 'executor',
      originSource: 'demo_simulation',
      participantId: 'part_claude',
      taskId: 'task_busca_nome',
      attemptId: 'att_1',
      type: 'attempt_started',
      payload: {
        taskId: 'task_busca_nome',
        attempt: {
          id: 'att_1',
          taskId: 'task_busca_nome',
          attemptNumber: 1,
          executorParticipantId: 'part_claude',
          modelTierUsed: 'fast',
          modelRefUsed: makeDemoModelRef('fast'),
          rolesSnapshot: ['executor'],
          contextRevisionId: 'ctx_rev_1',
          contextRevisionNumber: 1,
          status: 'running',
          evidenceNotes: [],
          startedAt: '2026-11-16T10:02:30.000Z',
          sourceEventIds: ['evt_007'],
          originSource: 'demo_simulation',
        },
        participantStatus: 'running',
        projectToGeneral: true,
        generalSummary:
          'Claude iniciou a Tentativa #1 da tarefa "Implementar filtro por nome na listagem" utilizando Contexto v1.',
      },
    },
    {
      id: 'evt_008',
      seq: 8,
      conversationId,
      timestamp: '2026-11-16T10:02:55.000Z',
      origin: 'executor',
      originSource: 'demo_simulation',
      participantId: 'part_claude',
      taskId: 'task_busca_nome',
      attemptId: 'att_1',
      type: 'agent_message_posted',
      payload: {
        messageId: 'msg_004',
        targetTab: 'part_claude',
        authorLabel: 'Claude',
        authorRoleLabel: 'Executor',
        bodyMarkdown:
          'Iniciando implementação em modo de demonstração com **Contexto v1**.\n\n```ts\n// Exemplo ilustrativo (demonstração)\nconst filtered = items.filter((item) =>\n  item.name.toLowerCase().includes(query.trim().toLowerCase())\n);\n```\n\nPronto para incorporar novas restrições ou solicitar validação de testes.',
        toolOutputs: [
          {
            id: 'tool_demo_1',
            label: 'Inspeção simulada de estrutura',
            commandSimulated: 'demo-inspect src/listagem (simulado)',
            summary: 'Identificados componente de listagem e paginação demonstrativos.',
            isSimulated: true,
          },
        ],
        projectToGeneral: false,
      },
    },
  ];
}

export function createInitialWorkspaceState(): WorkspaceStoreState {
  const project: Project = {
    id: DEMO_PROJECT_ID,
    name: 'Portal de demonstração',
    description:
      'Projeto demonstrativo com cenário determinístico de coordenação, contexto versionado e revisão de qualidade.',
    workspacePathInfo: 'C:/demo/portal-listagem (informativo — sem acesso a disco)',
    executionMode: 'demo',
    status: 'active',
    createdAt: '2026-11-16T09:55:00.000Z',
    updatedAt: '2026-11-16T10:02:55.000Z',
  };

  const baseConversation: WorkspaceConversation = {
    id: DEMO_CONVERSATION_ID,
    projectId: DEMO_PROJECT_ID,
    title: 'Busca por nome na listagem',
    executionMode: 'demo',
    teamPresetId: 'preset_demo_original',
    status: 'active',
    executionStatus: 'running',
    coordinatorParticipantId: 'part_codex',
    syncState: 'synced',
    lastAppliedSeq: 0,
    scenarioStepIndex: 5,
    autoPlayWasRunning: false,
    createdAt: '2026-11-16T09:59:00.000Z',
    updatedAt: '2026-11-16T10:02:55.000Z',
  };

  const participants = createDemoParticipants(DEMO_CONVERSATION_ID);
  const seedEvents = createInitialSeedEvents(DEMO_CONVERSATION_ID);
  const projection = rebuildProjectionFromEvents(
    baseConversation,
    participants,
    seedEvents,
  );
  projection.participants = projection.participants.map((p) =>
    p.id === 'part_claude' ? { ...p, unreadCount: 1 } : p,
  );
  projection.planRevisions = [
    {
      id: 'plan_rev_seed_1',
      conversationId: DEMO_CONVERSATION_ID,
      versionNumber: 1,
      authorLabel: 'Codex',
      createdAt: '2026-11-16T10:01:40.000Z',
      summary: 'Plano inicial com implementação da busca por nome e validação final dependente.',
      taskIds: ['task_busca_nome', 'task_validacao_final'],
      sourceEventId: 'evt_004',
      originSource: 'demo_simulation',
    },
  ];

  const connections = DEFAULT_CONNECTIONS.map((c) => ({
    ...c,
    capabilities: { ...c.capabilities },
    availableModels: c.availableModels.map((m) => ({ ...m })),
  }));

  return {
    schemaVersion: APP_BRAND.storageSchemaVersion,
    executionMode: 'demo',
    coreSettings: {
      baseUrl: '',
      workspacePath: '',
      authMode: 'cookie_or_bearer',
    },
    projects: [project],
    connections,
    agentProfiles: connectionsToAgentProfiles(connections),
    participantProfiles: DEFAULT_PARTICIPANT_PROFILES.map((p) => ({
      ...p,
      defaultRoles: [...p.defaultRoles],
      modelRef: { ...p.modelRef },
    })),
    teamPresets: DEFAULT_TEAM_PRESETS.map((preset) => ({
      ...preset,
      members: preset.members.map((m) => ({
        ...m,
        roles: [...m.roles],
        modelRef: { ...m.modelRef },
      })),
    })),
    modelPolicy: { ...DEFAULT_MODEL_POLICY },
    conversations: {
      [DEMO_CONVERSATION_ID]: projection,
    },
    activeProjectId: DEMO_PROJECT_ID,
    activeConversationId: DEMO_CONVERSATION_ID,
  };
}

export function build2000StressEvents(
  conversationId: string,
  startingSeq: number,
  targetParticipant?: Participant,
): ExecutionEvent[] {
  const targetTab = targetParticipant?.id ?? 'part_claude';
  const authorLabel = targetParticipant?.displayName ?? 'Claude';
  const events: ExecutionEvent[] = [];
  const baseMs = Date.UTC(2026, 10, 16, 11, 0, 0);

  for (let i = 1; i <= 2000; i += 1) {
    const seq = startingSeq + i;
    events.push({
      id: `evt_stress_${conversationId}_${seq}`,
      seq,
      conversationId,
      timestamp: new Date(baseMs + i * 250).toISOString(),
      origin: 'executor',
      originSource: 'demo_simulation',
      participantId: targetTab,
      type: 'agent_message_posted',
      payload: {
        messageId: `msg_stress_${conversationId}_${seq}`,
        targetTab,
        authorLabel,
        authorRoleLabel: 'Executor',
        bodyMarkdown: `Registro de carga #${i} (\`seq ${seq}\`) — verificação de paginação incremental sem remontagem global.`,
        projectToGeneral: false,
      },
    });
  }
  return events;
}
