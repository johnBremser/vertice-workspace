import { INTERNAL_PROTOCOL_VERSION } from '../domain/internalProtocol';
import { makeDemoModelRef } from '../domain/presets';
import {
  areTaskDependenciesSatisfied,
  isPermissionStillBlocked,
} from '../domain/taskRules';
import {
  checkAuditIndependence,
  hasRole,
  resolveTeamRoles,
  validateTeamConfiguration,
} from '../domain/teamValidation';
import type {
  ConnectionAdapterConfig,
  ContextReceipt,
  ConversationProjection,
  DemoModelTier,
  ExecutionEvent,
  ModelPolicy,
  ModelRef,
  Participant,
  PlanRevision,
  SharedContextRevision,
  Task,
} from '../domain/types';
import { PT_BR } from '../i18n/ptBR';

export interface ScenarioStepOutput {
  events: ExecutionEvent[];
  nextStepIndex: number;
  finished: boolean;
  blocked?: boolean;
  blockedReason?: string;
}

function buildReceiptsForParticipants(
  participants: Participant[],
  connections: ConnectionAdapterConfig[],
  revisionId: string,
  versionNumber: number,
  now: string,
): Record<string, ContextReceipt> {
  const connMap = new Map(connections.map((c) => [c.id, c]));
  const receipts: Record<string, ContextReceipt> = {};

  for (const p of participants) {
    if (p.archived) continue;
    const conn = connMap.get(p.connectionId);
    const canInject = conn?.capabilities.supportsMidRunContextInjection === true;
    const isRunning = p.status === 'running';

    if (p.status === 'disconnected' || p.status === 'failed') {
      receipts[p.id] = {
        participantId: p.id,
        revisionId,
        status: 'failed_needs_action',
        policyApplied: 'next_turn',
        updatedAt: now,
        mechanismNote: 'Participante desconectado; entrega pendente de reconexão.',
      };
    } else if (canInject && isRunning) {
      receipts[p.id] = {
        participantId: p.id,
        revisionId,
        status: 'applied',
        policyApplied: 'mid_run_injection',
        updatedAt: now,
        mechanismNote: `Simulado: conexão suporta injeção em curso e aplicou Contexto v${versionNumber}.`,
      };
    } else if (isRunning) {
      receipts[p.id] = {
        participantId: p.id,
        revisionId,
        status: 'sent',
        policyApplied: 'next_turn',
        updatedAt: now,
        mechanismNote:
          'Simulado: enviado para o próximo turno (envio não comprova aplicação na tentativa em curso).',
      };
    } else {
      receipts[p.id] = {
        participantId: p.id,
        revisionId,
        status: 'received',
        policyApplied: 'next_turn',
        updatedAt: now,
        mechanismNote:
          'Simulado: recebido na fila; será aplicado ao iniciar o próximo turno.',
      };
    }
  }
  return receipts;
}

function resolvePromotedModel(
  executor: Participant,
  modelPolicy: ModelPolicy,
): { targetTier: DemoModelTier; targetModelRef: ModelRef } {
  const targetTier = modelPolicy.escalationTargetTier;
  const currentName = executor.modelRef.displayName;
  const targetModelRef: ModelRef =
    executor.modelRef.source === 'user_preference'
      ? {
          ...executor.modelRef,
          displayName: `${currentName} → ${PT_BR.modelTierLabels[targetTier]}`,
          tier: targetTier,
        }
      : makeDemoModelRef(targetTier);
  return { targetTier, targetModelRef };
}

function findPrimaryAndSecondaryTasks(projection: ConversationProjection): {
  primaryTask?: Task;
  dependentTask?: Task;
} {
  const sorted = [...projection.tasks];
  if (sorted.length === 0) return {};

  const activeAttemptTask = sorted.find(
    (t) =>
      t.status !== 'completed' &&
      t.status !== 'cancelled' &&
      t.attempts.length > 0,
  );

  const primaryTask =
    activeAttemptTask ??
    sorted.find(
      (t) =>
        t.status !== 'completed' &&
        t.status !== 'cancelled' &&
        t.status !== 'failed' &&
        t.status !== 'blocked' &&
        areTaskDependenciesSatisfied(t, sorted).satisfied,
    ) ??
    sorted.find((t) => t.status !== 'completed' && t.status !== 'cancelled') ??
    sorted.find((t) => t.status !== 'cancelled') ??
    sorted[0];

  const dependentTask = sorted.find(
    (t) =>
      t.id !== primaryTask.id &&
      t.status !== 'completed' &&
      t.status !== 'cancelled' &&
      t.status !== 'failed' &&
      t.status !== 'blocked',
  );
  return { primaryTask, dependentTask };
}

/**
 * Config-driven deterministic collaboration engine.
 * Works identically for any valid team preset or custom participant layout
 * without hardcoding Codex, Claude, or Antigravity participant IDs.
 */
export function buildNextCollaborationStep(
  projection: ConversationProjection,
  modelPolicy: ModelPolicy,
  connections: ConnectionAdapterConfig[],
  startingSeq?: number,
): ScenarioStepOutput {
  if (projection.conversation.executionMode === 'aion_core') {
    return {
      events: [],
      nextStepIndex: projection.conversation.scenarioStepIndex,
      finished: false,
      blocked: true,
      blockedReason:
        'Em modo AionCore local, avanços simulados permanecem desativados. Aguarde eventos reais do transporte ou envie mensagens pela interface.',
    };
  }

  if (projection.conversation.syncState === 'gap_detected') {
    return {
      events: [],
      nextStepIndex: projection.conversation.scenarioStepIndex,
      finished: false,
      blocked: true,
      blockedReason:
        'Há uma lacuna de sequência pendente nesta conversa. Reconcilie os eventos antes de avançar o fluxo.',
    };
  }

  if (projection.conversation.executionStatus === 'paused_queue') {
    return {
      events: [],
      nextStepIndex: projection.conversation.scenarioStepIndex,
      finished: false,
      blocked: true,
      blockedReason:
        'A fila de novas tarefas está pausada pelo usuário. Retome a fila antes de avançar.',
    };
  }

  const teamCheck = validateTeamConfiguration(
    projection.participants,
    connections,
  );
  if (!teamCheck.valid) {
    return {
      events: [],
      nextStepIndex: projection.conversation.scenarioStepIndex,
      finished: false,
      blocked: true,
      blockedReason: teamCheck.errors[0],
    };
  }

  const rawStep = projection.conversation.scenarioStepIndex;
  const hasRemainingTasks = projection.tasks.some(
    (t) => t.status !== 'completed' && t.status !== 'cancelled',
  );
  if (rawStep >= 12 && !hasRemainingTasks) {
    return { nextStepIndex: rawStep, finished: true, events: [] };
  }
  const step = rawStep >= 12 ? 11 : rawStep;

  const permCheck = isPermissionStillBlocked(projection.permissions);
  if (permCheck.pendingRequest) {
    return {
      events: [],
      nextStepIndex: step,
      finished: false,
      blocked: true,
      blockedReason: `Aguardando decisão na solicitação de permissão simulada "${permCheck.pendingRequest.actionTitle}" (Aprove ou Recuse antes de avançar).`,
    };
  }

  if (
    permCheck.blockingRequest ||
    projection.conversation.executionStatus === 'blocked'
  ) {
    return {
      events: [],
      nextStepIndex: step,
      finished: false,
      blocked: true,
      blockedReason:
        'Execução bloqueada porque uma solicitação de permissão simulada foi recusada para esta ação/escopo. Reinicie a demonstração ou aprove uma solicitação equivalente.',
    };
  }

  const convId = projection.conversation.id;
  let seq = startingSeq ?? projection.conversation.lastAppliedSeq;
  const nextSeq = () => {
    seq += 1;
    return seq;
  };
  const now = new Date().toISOString();

  const roles = resolveTeamRoles(
    projection.participants,
    projection.conversation.coordinatorParticipantId,
  );
  const coordinator = roles.coordinator!;
  const planner = roles.planner ?? coordinator;

  const { primaryTask, dependentTask } = findPrimaryAndSecondaryTasks(projection);
  const executor =
    (primaryTask
      ? projection.participants.find(
          (p) => p.id === primaryTask.assigneeParticipantId && !p.archived,
        )
      : undefined) ?? roles.executor!;
  const reviewer =
    (primaryTask?.reviewerParticipantId
      ? projection.participants.find(
          (p) => p.id === primaryTask.reviewerParticipantId && !p.archived,
        )
      : undefined) ??
    roles.reviewer ??
    coordinator;

  const latestRev =
    projection.contextRevisions[projection.contextRevisions.length - 1];
  const activeContextId = latestRev?.id ?? `ctx_rev_${convId}_1`;
  const activeContextVersion = latestRev?.versionNumber ?? 1;
  const currentExecutorTier = executor.modelTier ?? modelPolicy.defaultExecutorTier;
  const currentExecutorModelRef = executor.modelRef;

  switch (step) {
    case 0: {
      // Dynamic initialization when conversation has no seeded plan yet
      const userPrompt =
        projection.generalFeed[0]?.summary ??
        `Executar objetivo da conversa "${projection.conversation.title}" com a equipe configurada.`;
      const events: ExecutionEvent[] = [];

      if (projection.generalFeed.length === 0) {
        const sUser = nextSeq();
        events.push({
          id: `evt_dyn_req_${convId}_${sUser}`,
          seq: sUser,
          conversationId: convId,
          timestamp: now,
          origin: 'user',
          type: 'user_message_sent',
          payload: {
            messageId: `msg_dyn_req_${convId}_${sUser}`,
            targetTab: 'general',
            targetParticipantId: coordinator.id,
            bodyMarkdown: userPrompt,
            generalSummary: `Pedido inicial: ${userPrompt}`,
          },
        });
      }

      const sCoord = nextSeq();

      events.push({
        id: `evt_dyn_coord_${convId}_${sCoord}`,
        seq: sCoord,
        conversationId: convId,
        timestamp: now,
        origin: 'coordinator',
        participantId: coordinator.id,
        type: 'agent_message_posted',
        payload: {
          messageId: `msg_dyn_coord_${convId}_${sCoord}`,
          targetTab: 'general',
          authorLabel: coordinator.displayName,
          authorRoleLabel: PT_BR.roleLabels.coordinator,
          bodyMarkdown: `Recebido por **${coordinator.displayName}** (simulação). Encaminhando planejamento para **${planner.displayName}** e execução para **${executor.displayName}** (auditoria: **${reviewer.displayName}**).`,
          projectToGeneral: true,
          generalKind: 'coordinator_plan',
          generalSummary: `${coordinator.displayName} assumiu coordenação e delegou planejamento para ${planner.displayName}.`,
          detailLinkLabel: 'Ver coordenação',
        },
      });

      return { nextStepIndex: 2, finished: false, events };
    }

    case 1:
    case 2: {
      // Planning & task creation (respects existing user tasks if already created!)
      if (projection.tasks.length > 0) {
        const sPlan = nextSeq();
        const planRevision: PlanRevision = {
          id: `plan_rev_${convId}_${projection.planRevisions.length + 1}`,
          conversationId: convId,
          versionNumber: projection.planRevisions.length + 1,
          authorLabel: planner.displayName,
          createdAt: now,
          summary: `Plano confirmado com ${projection.tasks.length} tarefa(s) configurada(s) manualmente.`,
          taskIds: projection.tasks.map((t) => t.id),
          sourceEventId: `evt_dyn_plan_${convId}_${sPlan}`,
          originSource: 'demo_simulation',
        };
        return {
          nextStepIndex: 4,
          finished: false,
          events: [
            {
              id: planRevision.sourceEventId,
              seq: sPlan,
              conversationId: convId,
              timestamp: now,
              origin: 'coordinator',
              participantId: planner.id,
              type: 'plan_revision_published',
              payload: {
                planRevision,
                generalSummary: `Plano v${planRevision.versionNumber} publicado por ${planner.displayName}.`,
              },
            },
          ],
        };
      }

      const task1Id = `task_${convId}_1`;
      const task2Id = `task_${convId}_2`;
      const sPlanMsg = nextSeq();
      const sT1 = nextSeq();
      const sT2 = nextSeq();
      const sPlanRev = nextSeq();
      const planRevId = `plan_rev_${convId}_1`;

      const planEnvelope = JSON.stringify(
        {
          kind: 'plan_proposal',
          protocol: INTERNAL_PROTOCOL_VERSION,
          conversationId: convId,
          summary: `Dividir "${projection.conversation.title}" em implementação e validação com dependência explícita.`,
          tasks: [
            {
              title: 'Implementar entrega principal da conversa',
              description: `Executar implementação conforme critérios publicados por ${planner.displayName}.`,
              assigneeRole: 'executor',
              acceptanceCriteria: [
                'Atender aos critérios funcionais combinados no Contexto Compartilhado.',
                'Preservar comportamento existente e registrar evidências.',
              ],
            },
            {
              title: 'Validar integração final após aprovação',
              description: 'Verificar aderência final após aprovação da entrega principal.',
              assigneeRole: 'executor',
              dependencies: [task1Id],
              acceptanceCriteria: [
                'Dependência principal aprovada anteriormente.',
                'Registrar evidências finais de verificação.',
              ],
            },
          ],
        },
        null,
        2,
      );

      return {
        nextStepIndex: 4,
        finished: false,
        events: [
          {
            id: `evt_plan_msg_${convId}_${sPlanMsg}`,
            seq: sPlanMsg,
            conversationId: convId,
            timestamp: now,
            origin: 'coordinator',
            participantId: planner.id,
            type: 'agent_message_posted',
            payload: {
              messageId: `msg_plan_${convId}_${sPlanMsg}`,
              targetTab: planner.id,
              authorLabel: planner.displayName,
              authorRoleLabel: PT_BR.roleLabels.planner,
              bodyMarkdown: `### Proposta de plano [Simulado]\n\n\`\`\`aion-desk-json\n${planEnvelope}\n\`\`\``,
              parseStatus: 'valid',
              projectToGeneral: false,
            },
          },
          {
            id: `evt_t1_${convId}_${sT1}`,
            seq: sT1,
            conversationId: convId,
            timestamp: now,
            origin: 'coordinator',
            taskId: task1Id,
            type: 'task_created',
            payload: {
              task: {
                id: task1Id,
                conversationId: convId,
                sourceRequestEventId: projection.eventLog[0]?.id ?? `evt_plan_msg_${convId}_${sPlanMsg}`,
                planRevisionId: planRevId,
                title: 'Implementar entrega principal da conversa',
                description: `Implementar a entrega principal respeitando as instruções de ${coordinator.displayName}.`,
                assigneeParticipantId: executor.id,
                reviewerParticipantId: reviewer.id,
                dependencyTaskIds: [],
                acceptanceCriteria: [
                  'Atender aos critérios funcionais definidos no Contexto Compartilhado.',
                  'Cobrir cenário com evidências rastreáveis.',
                ],
                status: 'queued',
                attempts: [],
                reviews: [],
                operationalFailureCount: 0,
                qualityRejectionCount: 0,
                originSource: 'demo_simulation',
              },
              generalSummary: `Tarefa delegada a ${executor.displayName} (auditoria: ${reviewer.displayName}).`,
            },
          },
          {
            id: `evt_t2_${convId}_${sT2}`,
            seq: sT2,
            conversationId: convId,
            timestamp: now,
            origin: 'coordinator',
            taskId: task2Id,
            type: 'task_created',
            payload: {
              task: {
                id: task2Id,
                conversationId: convId,
                sourceRequestEventId: projection.eventLog[0]?.id ?? `evt_plan_msg_${convId}_${sPlanMsg}`,
                planRevisionId: planRevId,
                title: 'Validar integração final após aprovação',
                description: 'Executar verificação final dependente da aprovação da entrega principal.',
                assigneeParticipantId: executor.id,
                reviewerParticipantId: reviewer.id,
                dependencyTaskIds: [task1Id],
                acceptanceCriteria: [
                  'Dependência principal aprovada anteriormente.',
                  'Registrar evidências finais de verificação.',
                ],
                status: 'planned',
                attempts: [],
                reviews: [],
                operationalFailureCount: 0,
                qualityRejectionCount: 0,
                originSource: 'demo_simulation',
              },
              generalSummary: 'Tarefa dependente planejada aguardando conclusão da primeira tarefa.',
            },
          },
          {
            id: `evt_plan_rev_${convId}_${sPlanRev}`,
            seq: sPlanRev,
            conversationId: convId,
            timestamp: now,
            origin: 'coordinator',
            participantId: planner.id,
            type: 'plan_revision_published',
            payload: {
              planRevision: {
                id: planRevId,
                conversationId: convId,
                versionNumber: 1,
                authorLabel: planner.displayName,
                createdAt: now,
                summary: `Plano inicial com 2 tarefas encadeadas criado por ${planner.displayName}.`,
                taskIds: [task1Id, task2Id],
                sourceEventId: `evt_plan_rev_${convId}_${sPlanRev}`,
                originSource: 'demo_simulation',
              },
              generalSummary: `Plano v1 publicado por ${planner.displayName} (2 tarefas).`,
            },
          },
        ],
      };
    }

    case 3:
    case 4: {
      // Publish Context v1 if missing & start Attempt #1 on primaryTask
      const events: ExecutionEvent[] = [];
      let ctxId = activeContextId;
      let ctxVer = activeContextVersion;

      if (projection.contextRevisions.length === 0) {
        const sCtx = nextSeq();
        ctxVer = 1;
        ctxId = `ctx_rev_${convId}_1`;
        const rev1: SharedContextRevision = {
          id: ctxId,
          conversationId: convId,
          versionNumber: 1,
          authorLabel: `${coordinator.displayName} (Demonstração)`,
          createdAt: now,
          summaryOfChange: 'Publicação inicial do Contexto Compartilhado da equipe.',
          objective: projection.conversation.title,
          permanentInstructions: [
            'Respeitar critérios de aceitação e recibos individuais antes da conclusão.',
          ],
          constraints: ['Não alterar entregas anteriores ao atualizar revisões.'],
          acceptanceCriteria: primaryTask?.acceptanceCriteria ?? ['Critério principal atendido.'],
          confirmedDecisions: [
            `Equipe configurada: Coordenador=${coordinator.displayName}, Executor=${executor.displayName}, Auditor=${reviewer.displayName}.`,
          ],
          receipts: buildReceiptsForParticipants(
            projection.participants,
            connections,
            ctxId,
            1,
            now,
          ),
        };
        events.push({
          id: `evt_dyn_ctx1_${convId}_${sCtx}`,
          seq: sCtx,
          conversationId: convId,
          timestamp: now,
          origin: 'system',
          type: 'context_revision_published',
          payload: {
            revision: rev1,
            generalSummary: 'Contexto compartilhado v1 publicado com recibos por participante.',
          },
        });
      }

      if (primaryTask && primaryTask.attempts.length === 0) {
        const sAtt1 = nextSeq();
        const attId = `att_${primaryTask.id}_1`;
        events.push({
          id: `evt_dyn_att1_${convId}_${sAtt1}`,
          seq: sAtt1,
          conversationId: convId,
          timestamp: now,
          origin: 'executor',
          participantId: executor.id,
          taskId: primaryTask.id,
          attemptId: attId,
          type: 'attempt_started',
          payload: {
            taskId: primaryTask.id,
            attempt: {
              id: attId,
              taskId: primaryTask.id,
              attemptNumber: 1,
              executorParticipantId: executor.id,
              modelTierUsed: currentExecutorTier,
              modelRefUsed: { ...currentExecutorModelRef },
              rolesSnapshot: [...executor.roles],
              instructionsSnapshot: executor.instructions,
              contextRevisionId: ctxId,
              contextRevisionNumber: ctxVer,
              status: 'running',
              evidenceNotes: [],
              startedAt: now,
              sourceEventIds: [`evt_dyn_att1_${convId}_${sAtt1}`],
              originSource: 'demo_simulation',
            },
            participantStatus: 'running',
            projectToGeneral: true,
            generalSummary: `${executor.displayName} iniciou Tentativa #1 de "${primaryTask.title}" (Contexto v${ctxVer}).`,
          },
        });
      }

      return { nextStepIndex: 5, finished: false, events };
    }

    case 5: {
      // Step 6: Publish next context revision dynamically
      const nextVersion = activeContextVersion + 1;
      const newRevId = `ctx_rev_${convId}_${nextVersion}_${seq + 2}`;
      const constraintText =
        'Preservar os testes existentes; acrescentar cobertura para a busca.';
      const existingConstraints = latestRev?.constraints ?? [];
      const nextConstraints = existingConstraints.includes(constraintText)
        ? existingConstraints
        : [...existingConstraints, constraintText];
      const testCriterion =
        'Cobrir busca por nome com testes automatizados (demonstração).';
      const existingCriteria = latestRev?.acceptanceCriteria ?? [];
      const nextCriteria = existingCriteria.includes(testCriterion)
        ? existingCriteria
        : [...existingCriteria, testCriterion];

      const newRev: SharedContextRevision = {
        id: newRevId,
        conversationId: convId,
        versionNumber: nextVersion,
        authorLabel: 'Você',
        createdAt: now,
        summaryOfChange:
          'Adicionada restrição de preservar testes existentes e incluir cobertura.',
        objective: latestRev?.objective ?? projection.conversation.title,
        permanentInstructions: latestRev?.permanentInstructions ?? [],
        constraints: nextConstraints,
        acceptanceCriteria: nextCriteria,
        confirmedDecisions: latestRev?.confirmedDecisions ?? [],
        receipts: buildReceiptsForParticipants(
          projection.participants,
          connections,
          newRevId,
          nextVersion,
          now,
        ),
      };
      const s1 = nextSeq();
      const s2 = nextSeq();
      return {
        nextStepIndex: 6,
        finished: false,
        events: [
          {
            id: `evt_step6_user_${s1}`,
            seq: s1,
            conversationId: convId,
            timestamp: now,
            origin: 'user',
            type: 'user_message_sent',
            payload: {
              messageId: `msg_step6_${s1}`,
              targetTab: 'general',
              targetParticipantId: coordinator.id,
              bodyMarkdown:
                'Nova restrição para o contexto compartilhado: **Preservar os testes existentes; acrescentar cobertura para a busca.**',
              generalSummary:
                'Orientação adicionada: preservar os testes existentes e acrescentar cobertura.',
            },
          },
          {
            id: `evt_step6_ctx_${s2}`,
            seq: s2,
            conversationId: convId,
            timestamp: now,
            origin: 'system',
            type: 'context_revision_published',
            payload: {
              revision: newRev,
              generalSummary: `Contexto v${nextVersion} publicado. ${executor.displayName} recebeu envio para o próximo turno.`,
            },
          },
        ],
      };
    }

    case 6: {
      // Step 7: Permission requested with actionKey + scopeKey for current task/executor
      const s1 = nextSeq();
      const s2 = nextSeq();
      const targetTaskId = primaryTask?.id ?? `task_${convId}_1`;
      const permId =
        convId === 'conv_busca_listagem'
          ? 'perm_test_suite_1'
          : `perm_test_suite_${convId}_${s1}`;
      return {
        nextStepIndex: 7,
        finished: false,
        events: [
          {
            id: `evt_step7_perm_${s1}`,
            seq: s1,
            conversationId: convId,
            timestamp: now,
            origin: 'executor',
            participantId: executor.id,
            taskId: targetTaskId,
            attemptId: primaryTask?.attempts[0]?.id ?? 'att_1',
            type: 'permission_requested',
            payload: {
              request: {
                id: permId,
                conversationId: convId,
                participantId: executor.id,
                taskId: targetTaskId,
                attemptId: primaryTask?.attempts[0]?.id ?? 'att_1',
                actionKey: 'run_verification_suite',
                scopeKey: targetTaskId,
                actionTitle: 'Executar suíte demonstrativa de testes da listagem',
                commandSimulated: 'npm test -- listagem-busca (simulação)',
                scopeDescription:
                  'Leitura e execução simuladas apenas no workspace demonstrativo, sem tocar arquivos reais.',
                status: 'pending',
                createdAt: now,
                sourceEventId: `evt_step7_perm_${s1}`,
                isSimulated: true,
              },
              generalSummary: `${executor.displayName} solicitou permissão simulada para executar testes demonstrativos.`,
            },
          },
          {
            id: `evt_step7_msg_${s2}`,
            seq: s2,
            conversationId: convId,
            timestamp: now,
            origin: 'executor',
            participantId: executor.id,
            taskId: targetTaskId,
            type: 'agent_message_posted',
            payload: {
              messageId: `msg_step7_${s2}`,
              targetTab: executor.id,
              authorLabel: executor.displayName,
              authorRoleLabel: PT_BR.roleLabels.executor,
              bodyMarkdown:
                'Aguardando aprovação explícita de permissão simulada para rodar `npm test -- listagem-busca (simulação)`.',
              projectToGeneral: false,
            },
          },
        ],
      };
    }

    case 7: {
      // Step 8: Attempt #1 delivered & rejected on quality (1st rejection)
      if (!primaryTask) {
        return { nextStepIndex: 12, finished: true, events: [] };
      }
      const attempt1 = primaryTask.attempts[0] ?? { id: 'att_1', contextRevisionNumber: 1 };
      const sDel = nextSeq();
      const sRevMsg = nextSeq();
      const sRev = nextSeq();
      const nextRejectionCount = primaryTask.qualityRejectionCount + 1;
      const independence = checkAuditIndependence(
        projection.participants,
        primaryTask,
        reviewer.id,
      );

      const events: ExecutionEvent[] = [
        {
          id: `evt_step8_del_${sDel}`,
          seq: sDel,
          conversationId: convId,
          timestamp: now,
          origin: 'executor',
          participantId: executor.id,
          taskId: primaryTask.id,
          attemptId: attempt1.id,
          type: 'attempt_delivered',
          payload: {
            taskId: primaryTask.id,
            attemptId: attempt1.id,
            deliverySummary: `Entrega #1 (Demonstração): implementação sobre Contexto v${attempt1.contextRevisionNumber}; suíte anterior preservada (simulação).`,
            evidenceNotes: [
              'Testes existentes preservados (simulação).',
              `Cobertura específica exigida no Contexto v${activeContextVersion} ainda ausente nesta tentativa.`,
            ],
            generalSummary: `${executor.displayName} entregou Tentativa #1 para revisão de ${reviewer.displayName}.`,
          },
        },
        {
          id: `evt_step8_rev_msg_${sRevMsg}`,
          seq: sRevMsg,
          conversationId: convId,
          timestamp: now,
          origin: 'reviewer',
          participantId: reviewer.id,
          taskId: primaryTask.id,
          attemptId: attempt1.id,
          type: 'agent_message_posted',
          payload: {
            messageId: `msg_step8_rev_${sRevMsg}`,
            targetTab: reviewer.id,
            authorLabel: reviewer.displayName,
            authorRoleLabel: PT_BR.roleLabels.reviewer,
            bodyMarkdown: `### Parecer da Tentativa #1 [Simulado]\n\n- Estrutura base presente.\n- **Critério não atendido (Contexto v${activeContextVersion})**: falta cobertura de testes para o requisito atualizado.\n- Decisão: **Correção necessária** (reprovação de qualidade #${nextRejectionCount}).${!independence.independent ? `\n\n> _Nota de auditoria: ${independence.reason}_` : ''}`,
            projectToGeneral: false,
          },
        },
        {
          id: `evt_step8_rev_${sRev}`,
          seq: sRev,
          conversationId: convId,
          timestamp: now,
          origin: 'reviewer',
          participantId: reviewer.id,
          taskId: primaryTask.id,
          attemptId: attempt1.id,
          type: 'task_reviewed',
          payload: {
            review: {
              id: `rev_${primaryTask.id}_1_${sRev}`,
              taskId: primaryTask.id,
              attemptId: attempt1.id,
              reviewerParticipantId: reviewer.id,
              decision: 'rejected',
              rationale: `Tentativa #1 executada com Contexto v${attempt1.contextRevisionNumber} não cobriu o critério exigido no Contexto v${activeContextVersion}.`,
              unmetCriteria: [
                'Cobrir requisito atualizado com testes automatizados (demonstração).',
              ],
              decidedAt: now,
              sourceEventId: `evt_step8_rev_${sRev}`,
              independentReview: independence.independent,
            },
            nextTaskStatus: 'changes_requested',
            generalSummary: `${reviewer.displayName} reprovou Tentativa #1 (reprovação de qualidade #${nextRejectionCount}).`,
          },
        },
      ];

      const alreadyEscalated = projection.escalations.some(
        (e) => e.taskId === primaryTask.id,
      );
      const { targetTier, targetModelRef } = resolvePromotedModel(
        executor,
        modelPolicy,
      );
      if (
        !alreadyEscalated &&
        nextRejectionCount >= modelPolicy.qualityRejectionsBeforeSuggest &&
        currentExecutorTier !== targetTier
      ) {
        const sEsc = nextSeq();
        const escId = `esc_${primaryTask.id}_${sEsc}`;
        events.push({
          id: `evt_step8_esc_${sEsc}`,
          seq: sEsc,
          conversationId: convId,
          timestamp: now,
          origin: 'system',
          participantId: executor.id,
          taskId: primaryTask.id,
          attemptId: attempt1.id,
          type: 'escalation_suggested',
          payload: {
            escalation: {
              id: escId,
              conversationId: convId,
              taskId: primaryTask.id,
              attemptId: attempt1.id,
              participantId: executor.id,
              fromTier: currentExecutorTier,
              toTier: targetTier,
              fromModelRef: { ...currentExecutorModelRef },
              toModelRef: targetModelRef,
              reason: `Atingido o limite configurado de ${modelPolicy.qualityRejectionsBeforeSuggest} reprovação(ões) de qualidade na tarefa.`,
              expectedEffect: `Promover ${executor.displayName} para ${PT_BR.modelTierLabels[targetTier]} na próxima tentativa preservando Contexto v${activeContextVersion}.`,
              status: 'suggested',
              createdAt: now,
              sourceEventId: `evt_step8_esc_${sEsc}`,
            },
            generalSummary: `Escalonamento sugerido para ${executor.displayName}: ${nextRejectionCount} reprovação(ões) atingida(s).`,
          },
        });
        if (modelPolicy.approvalMode === 'auto_policy') {
          const sAuto = nextSeq();
          events.push({
            id: `evt_step8_esc_auto_${sAuto}`,
            seq: sAuto,
            conversationId: convId,
            timestamp: now,
            origin: 'system',
            participantId: executor.id,
            taskId: primaryTask.id,
            type: 'escalation_resolved',
            payload: {
              escalationId: escId,
              resolution: 'approved',
              participantId: executor.id,
              appliedTier: targetTier,
              appliedModelRef: targetModelRef,
              generalSummary: `Promoção automática aplicada pela política (${PT_BR.modelTierLabels[targetTier]}).`,
            },
          });
        }
      }

      return { nextStepIndex: 8, finished: false, events };
    }

    case 8: {
      // Step 9: Attempt #2 starts with latest context + records operational failure (does NOT increment qualityRejectionCount)
      if (!primaryTask) {
        return { nextStepIndex: 12, finished: true, events: [] };
      }
      const pendingManualEsc = projection.escalations.find(
        (e) => e.taskId === primaryTask.id && e.status === 'suggested',
      );
      if (pendingManualEsc && modelPolicy.approvalMode === 'manual') {
        return {
          events: [],
          nextStepIndex: step,
          finished: false,
          blocked: true,
          blockedReason:
            'Aguardando decisão manual sobre o escalonamento sugerido (Aprove a promoção ou mantenha o perfil atual).',
        };
      }

      const events: ExecutionEvent[] = [];
      let tierForAttempt2 = currentExecutorTier;
      let modelRefForAttempt2 = currentExecutorModelRef;

      if (pendingManualEsc && modelPolicy.approvalMode === 'auto_policy') {
        const sAuto = nextSeq();
        tierForAttempt2 = pendingManualEsc.toTier;
        modelRefForAttempt2 = pendingManualEsc.toModelRef ?? currentExecutorModelRef;
        events.push({
          id: `evt_step9_esc_auto_${sAuto}`,
          seq: sAuto,
          conversationId: convId,
          timestamp: now,
          origin: 'system',
          participantId: executor.id,
          taskId: primaryTask.id,
          type: 'escalation_resolved',
          payload: {
            escalationId: pendingManualEsc.id,
            resolution: 'approved',
            participantId: executor.id,
            appliedTier: pendingManualEsc.toTier,
            appliedModelRef: pendingManualEsc.toModelRef,
            generalSummary: `Promoção aplicada pela política automática para ${PT_BR.modelTierLabels[pendingManualEsc.toTier]}.`,
          },
        });
      }

      const sReceipt = nextSeq();
      const sAtt2 = nextSeq();
      const sOpFail = nextSeq();
      const sRecMsg = nextSeq();
      const att2Id = convId === 'conv_busca_listagem' ? 'att_2' : `att_${primaryTask.id}_2`;

      events.push(
        {
          id: `evt_step9_ctx_app_${sReceipt}`,
          seq: sReceipt,
          conversationId: convId,
          timestamp: now,
          origin: 'system',
          participantId: executor.id,
          type: 'context_receipt_updated',
          payload: {
            revisionId: activeContextId,
            versionNumber: activeContextVersion,
            participantId: executor.id,
            receipt: {
              participantId: executor.id,
              revisionId: activeContextId,
              status: 'applied',
              policyApplied: 'next_turn',
              updatedAt: now,
              mechanismNote: `Simulado: Contexto v${activeContextVersion} confirmado na inicialização da Tentativa #2.`,
            },
            projectToGeneral: true,
            generalSummary: `${executor.displayName} confirmou aplicação do Contexto v${activeContextVersion} antes da Tentativa #2.`,
          },
        },
        {
          id: `evt_step9_att2_${sAtt2}`,
          seq: sAtt2,
          conversationId: convId,
          timestamp: now,
          origin: 'executor',
          participantId: executor.id,
          taskId: primaryTask.id,
          attemptId: att2Id,
          type: 'attempt_started',
          payload: {
            taskId: primaryTask.id,
            attempt: {
              id: att2Id,
              taskId: primaryTask.id,
              attemptNumber: 2,
              executorParticipantId: executor.id,
              modelTierUsed: tierForAttempt2,
              modelRefUsed: { ...modelRefForAttempt2 },
              rolesSnapshot: [...executor.roles],
              instructionsSnapshot: executor.instructions,
              contextRevisionId: activeContextId,
              contextRevisionNumber: activeContextVersion,
              status: 'running',
              evidenceNotes: [],
              startedAt: now,
              sourceEventIds: [`evt_step9_att2_${sAtt2}`],
              originSource: 'demo_simulation',
            },
            participantStatus: 'running',
            projectToGeneral: true,
            generalSummary: `${executor.displayName} iniciou a Tentativa #2 vinculada ao Contexto v${activeContextVersion}.`,
          },
        },
        {
          id: `evt_step9_opfail_${sOpFail}`,
          seq: sOpFail,
          conversationId: convId,
          timestamp: now,
          origin: 'gateway',
          participantId: executor.id,
          taskId: primaryTask.id,
          attemptId: att2Id,
          type: 'operational_failure_recorded',
          payload: {
            taskId: primaryTask.id,
            attemptId: att2Id,
            reason: 'Queda simulada de transporte durante envio de artefato.',
            participantStatus: 'disconnected',
            generalSummary: `Falha operacional registrada no transporte de ${executor.displayName} (não consome tentativa nem conta como reprovação de qualidade).`,
          },
        },
        {
          id: `evt_step9_rec_${sRecMsg}`,
          seq: sRecMsg,
          conversationId: convId,
          timestamp: now,
          origin: 'gateway',
          participantId: executor.id,
          type: 'connection_state_changed',
          payload: {
            participantId: executor.id,
            participantStatus: 'running',
            sessionStatus: 'active',
            projectToGeneral: false,
            generalSummary: `${executor.displayName} reconectado sem perda de histórico.`,
          },
        },
      );
      return { nextStepIndex: 9, finished: false, events };
    }

    case 9: {
      // Step 10: Attempt #3 delivered & rejected 2nd time -> escalation suggestion check
      if (!primaryTask) {
        return { nextStepIndex: 12, finished: true, events: [] };
      }
      const sAtt3 = nextSeq();
      const sDel3 = nextSeq();
      const sRev2 = nextSeq();
      const att3Id = convId === 'conv_busca_listagem' ? 'att_3' : `att_${primaryTask.id}_3`;
      const nextRejectionCount = primaryTask.qualityRejectionCount + 1;
      const independence = checkAuditIndependence(
        projection.participants,
        primaryTask,
        reviewer.id,
      );

      const events: ExecutionEvent[] = [
        {
          id: `evt_step10_att3_${sAtt3}`,
          seq: sAtt3,
          conversationId: convId,
          timestamp: now,
          origin: 'executor',
          participantId: executor.id,
          taskId: primaryTask.id,
          attemptId: att3Id,
          type: 'attempt_started',
          payload: {
            taskId: primaryTask.id,
            attempt: {
              id: att3Id,
              taskId: primaryTask.id,
              attemptNumber: 3,
              executorParticipantId: executor.id,
              modelTierUsed: currentExecutorTier,
              modelRefUsed: { ...currentExecutorModelRef },
              rolesSnapshot: [...executor.roles],
              instructionsSnapshot: executor.instructions,
              contextRevisionId: activeContextId,
              contextRevisionNumber: activeContextVersion,
              status: 'running',
              evidenceNotes: [],
              startedAt: now,
              sourceEventIds: [`evt_step10_att3_${sAtt3}`],
              originSource: 'demo_simulation',
            },
            participantStatus: 'running',
            projectToGeneral: false,
          },
        },
        {
          id: `evt_step10_del3_${sDel3}`,
          seq: sDel3,
          conversationId: convId,
          timestamp: now,
          origin: 'executor',
          participantId: executor.id,
          taskId: primaryTask.id,
          attemptId: att3Id,
          type: 'attempt_delivered',
          payload: {
            taskId: primaryTask.id,
            attemptId: att3Id,
            deliverySummary: `Entrega #3 (Demonstração): adicionados testes de busca com Contexto v${activeContextVersion}.`,
            evidenceNotes: ['Testes básicos adicionados (demonstração).'],
            generalSummary: `${executor.displayName} entregou Tentativa #3 (Contexto v${activeContextVersion}) para nova revisão.`,
          },
        },
        {
          id: `evt_step10_rev2_${sRev2}`,
          seq: sRev2,
          conversationId: convId,
          timestamp: now,
          origin: 'reviewer',
          participantId: reviewer.id,
          taskId: primaryTask.id,
          attemptId: att3Id,
          type: 'task_reviewed',
          payload: {
            review: {
              id: `rev_${primaryTask.id}_2_${sRev2}`,
              taskId: primaryTask.id,
              attemptId: att3Id,
              reviewerParticipantId: reviewer.id,
              decision: 'rejected',
              rationale: `Estado vazio após limpar filtro não restaurou a ordenação/paginação original (reprovação de qualidade #${nextRejectionCount}).`,
              unmetCriteria: [
                primaryTask.acceptanceCriteria[1] ??
                  'Preservar estrutura atual de colunas e paginação.',
              ],
              decidedAt: now,
              sourceEventId: `evt_step10_rev2_${sRev2}`,
              independentReview: independence.independent,
            },
            nextTaskStatus: 'changes_requested',
            generalSummary: `${reviewer.displayName} reprovou Tentativa #3 (${nextRejectionCount}ª reprovação de qualidade).`,
          },
        },
      ];

      const alreadyEscalated = projection.escalations.some(
        (e) => e.taskId === primaryTask.id,
      );
      const { targetTier, targetModelRef } = resolvePromotedModel(
        executor,
        modelPolicy,
      );
      if (
        !alreadyEscalated &&
        nextRejectionCount >= modelPolicy.qualityRejectionsBeforeSuggest &&
        currentExecutorTier !== targetTier
      ) {
        const sEsc = nextSeq();
        const escId = `esc_${primaryTask.id}_${sEsc}`;
        events.push({
          id: `evt_step10_esc_${sEsc}`,
          seq: sEsc,
          conversationId: convId,
          timestamp: now,
          origin: 'system',
          participantId: executor.id,
          taskId: primaryTask.id,
          attemptId: att3Id,
          type: 'escalation_suggested',
          payload: {
            escalation: {
              id: escId,
              conversationId: convId,
              taskId: primaryTask.id,
              attemptId: att3Id,
              participantId: executor.id,
              fromTier: currentExecutorTier,
              toTier: targetTier,
              fromModelRef: { ...currentExecutorModelRef },
              toModelRef: targetModelRef,
              reason: `Atingido o limite de ${modelPolicy.qualityRejectionsBeforeSuggest} reprovações de qualidade na mesma tarefa (falhas operacionais não foram contabilizadas).`,
              expectedEffect: `Promover ${executor.displayName} para ${PT_BR.modelTierLabels[targetTier]} na próxima tentativa preservando Contexto v${activeContextVersion}.`,
              status: 'suggested',
              createdAt: now,
              sourceEventId: `evt_step10_esc_${sEsc}`,
            },
            generalSummary: `Escalonamento sugerido para ${executor.displayName}: ${nextRejectionCount} reprovações de qualidade atingidas.`,
          },
        });

        if (modelPolicy.approvalMode === 'auto_policy') {
          const sAuto = nextSeq();
          events.push({
            id: `evt_step10_esc_auto_${sAuto}`,
            seq: sAuto,
            conversationId: convId,
            timestamp: now,
            origin: 'system',
            participantId: executor.id,
            taskId: primaryTask.id,
            type: 'escalation_resolved',
            payload: {
              escalationId: escId,
              resolution: 'approved',
              participantId: executor.id,
              appliedTier: targetTier,
              appliedModelRef: targetModelRef,
              generalSummary: `Promoção aplicada automaticamente conforme política (${PT_BR.modelTierLabels[targetTier]}).`,
            },
          });
        }
      }

      return { nextStepIndex: 10, finished: false, events };
    }

    case 10: {
      // Step 11: Escalation manual gate & Attempt #4 approved
      if (!primaryTask) {
        return { nextStepIndex: 12, finished: true, events: [] };
      }
      const pendingEsc = projection.escalations.find(
        (e) => e.taskId === primaryTask.id && e.status === 'suggested',
      );
      if (pendingEsc && modelPolicy.approvalMode === 'manual') {
        return {
          events: [],
          nextStepIndex: step,
          finished: false,
          blocked: true,
          blockedReason:
            'Escalonamento aguardando aprovação manual: clique em "Aprovar promoção" ou "Manter perfil atual" antes de avançar.',
        };
      }

      const events: ExecutionEvent[] = [];
      let effectiveTier = currentExecutorTier;
      let effectiveModelRef = currentExecutorModelRef;

      if (pendingEsc && modelPolicy.approvalMode === 'auto_policy') {
        const sEscRes = nextSeq();
        effectiveTier = pendingEsc.toTier;
        effectiveModelRef = pendingEsc.toModelRef ?? currentExecutorModelRef;
        events.push({
          id: `evt_step11_esc_auto_${sEscRes}`,
          seq: sEscRes,
          conversationId: convId,
          timestamp: now,
          origin: 'system',
          participantId: executor.id,
          taskId: primaryTask.id,
          type: 'escalation_resolved',
          payload: {
            escalationId: pendingEsc.id,
            resolution: 'approved',
            participantId: executor.id,
            appliedTier: pendingEsc.toTier,
            appliedModelRef: pendingEsc.toModelRef,
            generalSummary: `Promoção aplicada automaticamente para ${PT_BR.modelTierLabels[pendingEsc.toTier]}.`,
          },
        });
      }

      const sAtt4 = nextSeq();
      const sMsg4 = nextSeq();
      const sDel4 = nextSeq();
      const sRev3 = nextSeq();
      const att4Id = convId === 'conv_busca_listagem' ? 'att_4' : `att_${primaryTask.id}_4`;
      const independence = checkAuditIndependence(
        projection.participants,
        primaryTask,
        reviewer.id,
      );

      events.push(
        {
          id: `evt_step11_att4_${sAtt4}`,
          seq: sAtt4,
          conversationId: convId,
          timestamp: now,
          origin: 'executor',
          participantId: executor.id,
          taskId: primaryTask.id,
          attemptId: att4Id,
          type: 'attempt_started',
          payload: {
            taskId: primaryTask.id,
            attempt: {
              id: att4Id,
              taskId: primaryTask.id,
              attemptNumber: 4,
              executorParticipantId: executor.id,
              modelTierUsed: effectiveTier,
              modelRefUsed: { ...effectiveModelRef },
              rolesSnapshot: [...executor.roles],
              instructionsSnapshot: executor.instructions,
              contextRevisionId: activeContextId,
              contextRevisionNumber: activeContextVersion,
              status: 'running',
              evidenceNotes: [],
              startedAt: now,
              sourceEventIds: [`evt_step11_att4_${sAtt4}`],
              originSource: 'demo_simulation',
            },
            participantStatus: 'running',
            projectToGeneral: true,
            generalSummary: `${executor.displayName} iniciou Tentativa #4 (${PT_BR.modelTierLabels[effectiveTier]}) com Contexto v${activeContextVersion}.`,
          },
        },
        {
          id: `evt_step11_msg4_${sMsg4}`,
          seq: sMsg4,
          conversationId: convId,
          timestamp: now,
          origin: 'executor',
          participantId: executor.id,
          taskId: primaryTask.id,
          attemptId: att4Id,
          type: 'agent_message_posted',
          payload: {
            messageId: `msg_step11_${sMsg4}`,
            targetTab: executor.id,
            authorLabel: executor.displayName,
            authorRoleLabel: PT_BR.roleLabels.executor,
            bodyMarkdown: `### Correção final concluída [Simulado]\n\n- Filtro insensível a maiúsculas aplicado.\n- Paginação e ordenação originais preservadas ao limpar a busca.\n- Cobertura demonstrativa de testes atualizada conforme **Contexto v${activeContextVersion}**.`,
            toolOutputs: [
              {
                id: `tool_demo_final_${sMsg4}`,
                label: 'Verificação simulada final',
                commandSimulated: 'npm test -- listagem-busca (simulação)',
                summary: 'Todos os critérios da tarefa principal validados na simulação.',
                isSimulated: true,
              },
            ],
            projectToGeneral: false,
          },
        },
        {
          id: `evt_step11_del4_${sDel4}`,
          seq: sDel4,
          conversationId: convId,
          timestamp: now,
          origin: 'executor',
          participantId: executor.id,
          taskId: primaryTask.id,
          attemptId: att4Id,
          type: 'attempt_delivered',
          payload: {
            taskId: primaryTask.id,
            attemptId: att4Id,
            deliverySummary: `Entrega #4 (Demonstração): critérios completos atendidos com Contexto v${activeContextVersion}.`,
            evidenceNotes: [
              'Estado vazio e paginação preservados (simulação).',
              'Cobertura demonstrativa de busca aprovada.',
            ],
            generalSummary: `${executor.displayName} entregou Tentativa #4 para revisão final.`,
          },
        },
        {
          id: `evt_step11_rev3_${sRev3}`,
          seq: sRev3,
          conversationId: convId,
          timestamp: now,
          origin: 'reviewer',
          participantId: reviewer.id,
          taskId: primaryTask.id,
          attemptId: att4Id,
          type: 'task_reviewed',
          payload: {
            review: {
              id: `rev_${primaryTask.id}_3_${sRev3}`,
              taskId: primaryTask.id,
              attemptId: att4Id,
              reviewerParticipantId: reviewer.id,
              decision: 'approved',
              rationale: `Critérios do Contexto v${activeContextVersion} integralmente atendidos na simulação.`,
              unmetCriteria: [],
              decidedAt: now,
              sourceEventId: `evt_step11_rev3_${sRev3}`,
              independentReview: independence.independent,
            },
            nextTaskStatus: 'completed',
            generalSummary: `${reviewer.displayName} aprovou "${primaryTask.title}" (${independence.independent ? 'auditoria independente' : 'parecer combinado'}).`,
          },
        },
      );

      return { nextStepIndex: 11, finished: false, events };
    }

    case 11: {
      // Execute remaining tasks across the full queue / dependency graph until ALL non-cancelled tasks complete
      const unfinishedTasks = projection.tasks.filter(
        (t) => t.status !== 'completed' && t.status !== 'cancelled',
      );

      if (unfinishedTasks.length === 0) {
        if (projection.conversation.executionStatus !== 'completed') {
          const sFinal = nextSeq();
          return {
            nextStepIndex: 12,
            finished: true,
            events: [
              {
                id: `evt_step12_done_${sFinal}`,
                seq: sFinal,
                conversationId: convId,
                timestamp: now,
                origin: 'coordinator',
                participantId: coordinator.id,
                type: 'agent_message_posted',
                payload: {
                  messageId: `msg_step12_done_${sFinal}`,
                  targetTab: 'general',
                  authorLabel: coordinator.displayName,
                  authorRoleLabel: PT_BR.roleLabels.coordinator,
                  bodyMarkdown: `Fluxo demonstrativo concluído por **${coordinator.displayName}** (simulação). Todas as tarefas foram auditadas e encerradas com rastreabilidade completa.`,
                  projectToGeneral: true,
                  generalKind: 'completion',
                  generalSummary: 'Coordenação encerrada com todas as tarefas aprovadas.',
                },
              },
            ],
          };
        }
        return { nextStepIndex: 12, finished: true, events: [] };
      }

      const pendingManualEsc = unfinishedTasks
        .map((t) =>
          projection.escalations.find(
            (e) => e.taskId === t.id && e.status === 'suggested',
          ),
        )
        .find((e) => e !== undefined);
      if (pendingManualEsc && modelPolicy.approvalMode === 'manual') {
        return {
          events: [],
          nextStepIndex: step,
          finished: false,
          blocked: true,
          blockedReason:
            'Escalonamento aguardando aprovação manual antes de continuar as tarefas pendentes.',
        };
      }

      const nextTask = unfinishedTasks.find(
        (t) =>
          t.status !== 'failed' &&
          t.status !== 'blocked' &&
          areTaskDependenciesSatisfied(t, projection.tasks).satisfied,
      );

      if (!nextTask) {
        return {
          events: [],
          nextStepIndex: step,
          finished: false,
          blocked: true,
          blockedReason:
            'Há tarefa(s) pendente(s) bloqueada(s) por dependência não concluída, ciclo ou falha sem retomada.',
        };
      }

      const taskExecutor =
        projection.participants.find(
          (p) => p.id === nextTask.assigneeParticipantId && !p.archived,
        ) ?? executor;
      const taskReviewer =
        (nextTask.reviewerParticipantId
          ? projection.participants.find(
              (p) => p.id === nextTask.reviewerParticipantId && !p.archived,
            )
          : undefined) ?? reviewer;
      const independence = checkAuditIndependence(
        projection.participants,
        nextTask,
        taskReviewer.id,
      );

      const events: ExecutionEvent[] = [];
      if (nextTask.status === 'planned') {
        const sQueue = nextSeq();
        events.push({
          id: `evt_step12_q_${nextTask.id}_${sQueue}`,
          seq: sQueue,
          conversationId: convId,
          timestamp: now,
          origin: 'coordinator',
          taskId: nextTask.id,
          type: 'task_status_changed',
          payload: {
            taskId: nextTask.id,
            nextStatus: 'queued',
            projectToGeneral: false,
          },
        });
      }

      const nextAttemptNum = nextTask.attempts.length + 1;
      const sAtt = nextSeq();
      const sDel = nextSeq();
      const sRev = nextSeq();
      const attId = `att_${nextTask.id}_${nextAttemptNum}_${sAtt}`;

      events.push(
        {
          id: `evt_step12_att_${nextTask.id}_${sAtt}`,
          seq: sAtt,
          conversationId: convId,
          timestamp: now,
          origin: 'executor',
          participantId: taskExecutor.id,
          taskId: nextTask.id,
          attemptId: attId,
          type: 'attempt_started',
          payload: {
            taskId: nextTask.id,
            attempt: {
              id: attId,
              taskId: nextTask.id,
              attemptNumber: nextAttemptNum,
              executorParticipantId: taskExecutor.id,
              modelTierUsed: taskExecutor.modelTier,
              modelRefUsed: { ...taskExecutor.modelRef },
              rolesSnapshot: [...taskExecutor.roles],
              instructionsSnapshot: taskExecutor.instructions,
              contextRevisionId: activeContextId,
              contextRevisionNumber: activeContextVersion,
              status: 'running',
              evidenceNotes: [],
              startedAt: now,
              sourceEventIds: [`evt_step12_att_${nextTask.id}_${sAtt}`],
              originSource: 'demo_simulation',
            },
            participantStatus: 'running',
            projectToGeneral: true,
            generalSummary: `Dependências satisfeitas: ${taskExecutor.displayName} iniciou "${nextTask.title}" (Tentativa #${nextAttemptNum}).`,
          },
        },
        {
          id: `evt_step12_del_${nextTask.id}_${sDel}`,
          seq: sDel,
          conversationId: convId,
          timestamp: now,
          origin: 'executor',
          participantId: taskExecutor.id,
          taskId: nextTask.id,
          attemptId: attId,
          type: 'attempt_delivered',
          payload: {
            taskId: nextTask.id,
            attemptId: attId,
            deliverySummary: `Entrega de "${nextTask.title}" concluída com Contexto v${activeContextVersion} (simulação).`,
            evidenceNotes: [
              `Critérios da tarefa "${nextTask.title}" verificados na simulação.`,
            ],
            generalSummary: `${taskExecutor.displayName} entregou "${nextTask.title}" para revisão de ${taskReviewer.displayName}.`,
          },
        },
        {
          id: `evt_step12_rev_${nextTask.id}_${sRev}`,
          seq: sRev,
          conversationId: convId,
          timestamp: now,
          origin: 'reviewer',
          participantId: taskReviewer.id,
          taskId: nextTask.id,
          attemptId: attId,
          type: 'task_reviewed',
          payload: {
            review: {
              id: `rev_${nextTask.id}_final_${sRev}`,
              taskId: nextTask.id,
              attemptId: attId,
              reviewerParticipantId: taskReviewer.id,
              decision: 'approved',
              rationale: `Critérios de "${nextTask.title}" validados com Contexto v${activeContextVersion}.`,
              unmetCriteria: [],
              decidedAt: now,
              sourceEventId: `evt_step12_rev_${nextTask.id}_${sRev}`,
              independentReview: independence.independent,
            },
            nextTaskStatus: 'completed',
            generalSummary: `${taskReviewer.displayName} aprovou "${nextTask.title}" (${independence.independent ? 'auditoria independente' : 'parecer combinado'}).`,
          },
        },
      );

      const remainingAfterThis = unfinishedTasks.filter(
        (t) => t.id !== nextTask.id,
      );
      if (remainingAfterThis.length > 0) {
        return {
          nextStepIndex: 11,
          finished: false,
          events,
        };
      }

      const sFinal = nextSeq();
      events.push({
        id: `evt_step12_done_${sFinal}`,
        seq: sFinal,
        conversationId: convId,
        timestamp: now,
        origin: 'coordinator',
        participantId: coordinator.id,
        type: 'agent_message_posted',
        payload: {
          messageId: `msg_step12_done_${sFinal}`,
          targetTab: 'general',
          authorLabel: coordinator.displayName,
          authorRoleLabel: PT_BR.roleLabels.coordinator,
          bodyMarkdown: `Fluxo demonstrativo concluído por **${coordinator.displayName}** (simulação). Todas as tarefas foram auditadas e encerradas com rastreabilidade completa.`,
          projectToGeneral: true,
          generalKind: 'completion',
          generalSummary: 'Coordenação encerrada com todas as tarefas aprovadas.',
        },
      });

      return {
        nextStepIndex: 12,
        finished: true,
        events,
      };
    }

    default:
      return { nextStepIndex: step, finished: true, events: [] };
  }
}

export function buildConversationRoleCheckNote(participants: Participant[]): string {
  const roles = resolveTeamRoles(participants);
  const independent = roles.planner?.id !== roles.reviewer?.id;
  return `Coordenador: ${roles.coordinator?.displayName ?? '—'} · Planejador: ${roles.planner?.displayName ?? '—'} · Executor: ${roles.executor?.displayName ?? '—'} · Auditor: ${roles.reviewer?.displayName ?? '—'}${independent ? '' : ' (planejamento e auditoria no mesmo participante)'}`;
}

export function participantDisplayRoleSummary(participant: Participant): string {
  const roles = participant.roles.length > 0 ? participant.roles : [participant.role];
  return roles.map((r) => PT_BR.roleLabels[r]).join(' + ');
}

export function isPlannerAndReviewerSameParticipant(
  participants: Participant[],
  reviewerParticipantId?: string,
): boolean {
  if (!reviewerParticipantId) return false;
  const rev = participants.find((p) => p.id === reviewerParticipantId);
  return hasRole(rev, 'planner');
}
