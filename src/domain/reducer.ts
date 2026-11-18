import { areTaskDependenciesSatisfied } from './taskRules';
import { getParticipantRoles, getPrimaryRole, hasRole } from './teamValidation';
import type {
  ConfigChangeRecord,
  ContextReceiptStatus,
  ConversationProjection,
  EscalationDecision,
  ExecutionEvent,
  GeneralFeedItem,
  Message,
  Participant,
  ParticipantRole,
  PlanRevision,
  Task,
  WorkspaceConversation,
} from './types';

const RECEIPT_STATUS_RANK: Record<Exclude<ContextReceiptStatus, 'failed_needs_action'>, number> = {
  pending_send: 0,
  sent: 1,
  received: 2,
  applied: 3,
};

/**
 * Imposes monotonic receipt ordering at the reducer layer; preventing `pending_send -> received`
 * without prior `sent` evidence and validating turn order remain the adapter's responsibility
 * (`finalizeCoreAgentMessage()`).
 */
function shouldAcceptReceiptTransition(
  current: ContextReceiptStatus | undefined,
  next: ContextReceiptStatus,
): boolean {
  if (!current) return true;
  if (current === 'applied') return next === 'applied';
  if (next === 'failed_needs_action') {
    return current === 'pending_send' || current === 'sent' || current === 'failed_needs_action';
  }
  if (current === 'failed_needs_action') {
    return next !== 'pending_send';
  }
  return RECEIPT_STATUS_RANK[next] >= RECEIPT_STATUS_RANK[current];
}

function hasExecutableOrActiveWork(
  tasks: Task[],
  escalations: EscalationDecision[],
): boolean {
  return tasks.some((t) => {
    if (t.status === 'running' || t.status === 'awaiting_review') {
      return true;
    }
    if (
      t.status === 'queued' ||
      t.status === 'planned' ||
      t.status === 'changes_requested'
    ) {
      const hasPendingEscalation = escalations.some(
        (e) => e.taskId === t.id && e.status === 'suggested',
      );
      if (hasPendingEscalation) return false;
      return areTaskDependenciesSatisfied(t, tasks).satisfied;
    }
    return false;
  });
}

export type IngestResultStatus =
  | 'applied'
  | 'buffered_gap'
  | 'duplicate'
  | 'stale';

export interface IngestEventResult {
  projection: ConversationProjection;
  status: IngestResultStatus;
  appliedCount: number;
}

export function createEmptyProjection(
  conversation: WorkspaceConversation,
  participants: Participant[],
): ConversationProjection {
  const messagesByTab: Record<string, Message[]> = {
    general: [],
  };
  for (const participant of participants) {
    messagesByTab[participant.id] = [];
  }
  return {
    conversation: { ...conversation },
    participants: participants.map((p, idx) => ({
      ...p,
      roles: getParticipantRoles(p),
      role: getPrimaryRole(getParticipantRoles(p)),
      tabOrder: typeof p.tabOrder === 'number' ? p.tabOrder : idx,
    })),
    messagesByTab,
    generalFeed: [],
    tasks: [],
    planRevisions: [],
    contextRevisions: [],
    permissions: [],
    escalations: [],
    coordinatorHistory: [],
    configChanges: [],
    seenEventIds: [],
    pendingOutOfOrder: {},
    eventLog: [],
  };
}

function appendMessage(
  messagesByTab: Record<string, Message[]>,
  tabId: string,
  message: Message,
): Record<string, Message[]> {
  const existing = messagesByTab[tabId] ?? [];
  if (existing.some((m) => m.sourceEventId === message.sourceEventId && m.id === message.id)) {
    return messagesByTab;
  }
  return {
    ...messagesByTab,
    [tabId]: [...existing, message],
  };
}

function appendGeneralItem(
  feed: GeneralFeedItem[],
  item: GeneralFeedItem,
): GeneralFeedItem[] {
  if (feed.some((existing) => existing.sourceEventId === item.sourceEventId)) {
    return feed;
  }
  return [...feed, item];
}

function bumpUnreadIfInactive(
  participants: Participant[],
  participantId: string | undefined,
  activeTabId?: string,
): Participant[] {
  if (!participantId || activeTabId === participantId) {
    return participants;
  }
  return participants.map((participant) =>
    participant.id === participantId
      ? { ...participant, unreadCount: participant.unreadCount + 1 }
      : participant,
  );
}

function isEventSimulated(event: ExecutionEvent, projection: ConversationProjection): boolean {
  if (event.originSource === 'aion_core') return false;
  if (event.originSource === 'demo_simulation') return true;
  return projection.conversation.executionMode !== 'aion_core';
}

function appendSystemExecutionRecord(
  messagesByTab: Record<string, Message[]>,
  event: ExecutionEvent,
  participantId: string | undefined,
  authorLabel: string,
  bodyMarkdown: string,
  isSimulated: boolean,
): Record<string, Message[]> {
  if (!participantId || participantId === 'general') {
    return messagesByTab;
  }
  const msg: Message = {
    id: `exec_rec_${event.id}`,
    conversationId: event.conversationId,
    sourceEventId: event.id,
    authorType: 'system',
    authorParticipantId: participantId,
    authorLabel,
    targetTab: participantId,
    bodyMarkdown,
    timestamp: event.timestamp,
    originSource: event.originSource ?? (isSimulated ? 'demo_simulation' : 'aion_desk_local'),
    isSimulated,
  };
  return appendMessage(messagesByTab, participantId, msg);
}

/**
 * Applies a single contiguous event incrementally, updating only the affected
 * records in the conversation projection without re-reducing prior history.
 */
export function applyEventIncrementally(
  projection: ConversationProjection,
  event: ExecutionEvent,
  activeTabId?: string,
): ConversationProjection {
  if (projection.seenEventIds.includes(event.id)) {
    return projection;
  }

  const simulated = isEventSimulated(event, projection);

  let {
    conversation,
    participants,
    messagesByTab,
    generalFeed,
    tasks,
    planRevisions,
    contextRevisions,
    permissions,
    escalations,
    coordinatorHistory,
    configChanges,
  } = projection;

  const seenEventIds = [...projection.seenEventIds, event.id];
  const eventLog = [...projection.eventLog, event];

  conversation = {
    ...conversation,
    lastAppliedSeq: Math.max(conversation.lastAppliedSeq, event.seq),
    updatedAt: event.timestamp,
  };

  switch (event.type) {
    case 'user_message_sent': {
      const targetParticipant = participants.find(
        (p) => p.id === event.payload.targetParticipantId,
      );
      const isGeneral = event.payload.targetTab === 'general';
      const defaultDeliveryStatus = simulated
        ? 'delivered_simulated'
        : 'enqueued_core';
      const msg: Message = {
        id: event.payload.messageId,
        conversationId: event.conversationId,
        sourceEventId: event.id,
        authorType: 'user',
        authorLabel: 'Você',
        targetTab: event.payload.targetTab,
        bodyMarkdown: event.payload.bodyMarkdown,
        timestamp: event.timestamp,
        originSource: 'user',
        externalMessageId: event.payload.externalMessageId,
        delivery: {
          targetType: isGeneral ? 'coordinator' : 'participant',
          targetParticipantId: event.payload.targetParticipantId,
          status: event.payload.deliveryStatus ?? defaultDeliveryStatus,
          externalMessageId: event.payload.externalMessageId,
          note:
            event.payload.deliveryNote ??
            (isGeneral
              ? `Enviado ao coordenador (${targetParticipant?.displayName ?? 'não definido'})`
              : `Enviado diretamente para ${targetParticipant?.displayName ?? 'participante'}`),
        },
        isSimulated: simulated,
      };
      messagesByTab = appendMessage(messagesByTab, event.payload.targetTab, msg);

      if (isGeneral) {
        generalFeed = appendGeneralItem(generalFeed, {
          id: `gf_${event.id}`,
          conversationId: event.conversationId,
          sourceEventId: event.id,
          kind: 'user_request',
          actorLabel: 'Você',
          summary: event.payload.generalSummary ?? event.payload.bodyMarkdown,
          detailLinkLabel: targetParticipant
            ? `Destinado a ${targetParticipant.displayName}`
            : undefined,
          targetTabId: 'general',
          targetEventId: event.id,
          timestamp: event.timestamp,
        });
      }
      break;
    }

    case 'agent_message_posted': {
      const targetTab = event.payload.targetTab;
      const existingList = messagesByTab[targetTab] ?? [];
      const existingIndex = event.payload.upsertByMessageId
        ? existingList.findIndex(
            (m) =>
              m.id === event.payload.messageId ||
              (event.payload.externalMessageId !== undefined &&
                m.externalMessageId === event.payload.externalMessageId),
          )
        : -1;

      const msg: Message = {
        id:
          existingIndex >= 0
            ? existingList[existingIndex].id
            : event.payload.messageId,
        conversationId: event.conversationId,
        sourceEventId: event.id,
        authorType: 'agent',
        authorParticipantId: event.participantId,
        authorLabel: event.payload.authorLabel,
        targetTab,
        bodyMarkdown: event.payload.bodyMarkdown,
        timestamp: event.timestamp,
        toolOutputs: event.payload.toolOutputs,
        originSource:
          event.originSource ?? (simulated ? 'demo_simulation' : 'aion_core'),
        externalMessageId: event.payload.externalMessageId,
        parseStatus: event.payload.parseStatus,
        parseReason: event.payload.parseReason,
        isSimulated: simulated,
      };

      if (existingIndex >= 0) {
        const updatedList = [...existingList];
        updatedList[existingIndex] = msg;
        messagesByTab = {
          ...messagesByTab,
          [targetTab]: updatedList,
        };
      } else {
        messagesByTab = appendMessage(messagesByTab, targetTab, msg);
        if (targetTab !== 'general') {
          participants = bumpUnreadIfInactive(
            participants,
            event.participantId ?? targetTab,
            activeTabId,
          );
        }
      }

      if (event.payload.projectToGeneral && event.payload.generalSummary) {
        generalFeed = appendGeneralItem(generalFeed, {
          id: `gf_${event.id}`,
          conversationId: event.conversationId,
          sourceEventId: event.id,
          kind: event.payload.generalKind ?? 'task_progress',
          actorLabel: event.payload.authorLabel,
          actorRoleLabel: event.payload.authorRoleLabel,
          summary: event.payload.generalSummary,
          detailLinkLabel:
            event.payload.detailLinkLabel ??
            (targetTab !== 'general' ? 'Ver execução' : undefined),
          targetTabId: targetTab,
          targetEventId: event.id,
          targetTaskId: event.taskId,
          timestamp: event.timestamp,
        });
      }
      break;
    }

    case 'coordinator_changed': {
      const nextCoord = participants.find(
        (p) => p.id === event.payload.nextParticipantId,
      );
      const prevCoord = participants.find(
        (p) => p.id === event.payload.previousParticipantId,
      );
      conversation = {
        ...conversation,
        coordinatorParticipantId: event.payload.nextParticipantId,
      };
      participants = participants.map((p) => {
        const currentRoles = getParticipantRoles(p);
        if (p.id === event.payload.nextParticipantId) {
          const updatedRoles: ParticipantRole[] = currentRoles.includes('coordinator')
            ? currentRoles
            : ['coordinator', ...currentRoles];
          return {
            ...p,
            roles: updatedRoles,
            role: 'coordinator',
          };
        }
        if (
          p.id === event.payload.previousParticipantId &&
          hasRole(p, 'coordinator')
        ) {
          const withoutCoord = currentRoles.filter((r) => r !== 'coordinator');
          const nextRoles: ParticipantRole[] =
            withoutCoord.length > 0 ? withoutCoord : ['executor'];
          return {
            ...p,
            roles: nextRoles,
            role: getPrimaryRole(nextRoles),
          };
        }
        return p;
      });
      coordinatorHistory = [
        ...coordinatorHistory,
        {
          id: event.payload.assignmentId,
          conversationId: event.conversationId,
          previousParticipantId: event.payload.previousParticipantId,
          nextParticipantId: event.payload.nextParticipantId,
          reason: event.payload.reason,
          decidedAt: event.timestamp,
          sourceEventId: event.id,
        },
      ];
      messagesByTab = appendSystemExecutionRecord(
        messagesByTab,
        event,
        event.payload.nextParticipantId,
        'Transição de coordenação',
        `Coordenador alterado de **${prevCoord?.displayName ?? 'nenhum'}** para **${nextCoord?.displayName ?? event.payload.nextParticipantId}**: ${event.payload.reason}`,
        simulated,
      );
      generalFeed = appendGeneralItem(generalFeed, {
        id: `gf_${event.id}`,
        conversationId: event.conversationId,
        sourceEventId: event.id,
        kind: 'status_change',
        actorLabel: 'Coordenação',
        summary: `Coordenador alterado de ${prevCoord?.displayName ?? 'nenhum'} para ${nextCoord?.displayName ?? event.payload.nextParticipantId}: ${event.payload.reason}`,
        detailLinkLabel: 'Ver coordenação',
        targetTabId: event.payload.nextParticipantId,
        targetEventId: event.id,
        timestamp: event.timestamp,
      });
      break;
    }

    case 'participant_configured': {
      const rec: ConfigChangeRecord = event.payload.changeRecord;
      configChanges = [...configChanges, rec];
      participants = participants.map((p) => {
        if (p.id !== rec.participantId) return p;
        const nextRoles = event.payload.roles ?? getParticipantRoles(p);
        const nextModelRef = event.payload.modelRef ?? p.modelRef;
        const nextTier =
          event.payload.modelTier ?? nextModelRef.tier ?? p.modelTier;
        const nextConnId = event.payload.connectionId ?? p.connectionId;
        return {
          ...p,
          displayName: event.payload.displayName ?? p.displayName,
          roles: nextRoles,
          role: getPrimaryRole(nextRoles),
          modelRef: nextModelRef,
          modelTier: nextTier,
          instructions: event.payload.instructions ?? p.instructions,
          connectionId: nextConnId,
          agentProfileId: nextConnId,
        };
      });
      messagesByTab = appendSystemExecutionRecord(
        messagesByTab,
        event,
        rec.participantId,
        'Alteração de configuração',
        `**${rec.changeKind}** alterado: ${rec.previousSummary} → **${rec.nextSummary}** _(aplicado às próximas tentativas; histórico anterior preservado)_.`,
        simulated,
      );
      break;
    }

    case 'participant_tabs_reordered': {
      const orderMap = new Map(
        event.payload.orderedParticipantIds.map((id, idx) => [id, idx]),
      );
      participants = participants.map((p) =>
        orderMap.has(p.id) ? { ...p, tabOrder: orderMap.get(p.id)! } : p,
      );
      break;
    }

    case 'participant_added': {
      const incoming = event.payload.participant;
      if (!participants.some((p) => p.id === incoming.id)) {
        participants = [...participants, incoming];
      }
      if (!messagesByTab[incoming.id]) {
        messagesByTab = { ...messagesByTab, [incoming.id]: [] };
      }
      break;
    }

    case 'participant_removed': {
      participants = participants.map((p) =>
        p.id === event.payload.participantId
          ? { ...p, archived: true, status: 'disconnected' }
          : p,
      );
      messagesByTab = appendSystemExecutionRecord(
        messagesByTab,
        event,
        event.payload.participantId,
        'Participante desativado',
        `Participante removido da equipe ativa (${event.payload.reason}); histórico preservado para auditoria.`,
        simulated,
      );
      break;
    }

    case 'plan_revision_published': {
      const planRev: PlanRevision = event.payload.planRevision;
      if (!planRevisions.some((r) => r.id === planRev.id)) {
        planRevisions = [...planRevisions, planRev];
      }
      generalFeed = appendGeneralItem(generalFeed, {
        id: `gf_${event.id}`,
        conversationId: event.conversationId,
        sourceEventId: event.id,
        kind: 'coordinator_plan',
        actorLabel: planRev.authorLabel,
        actorRoleLabel: `Plano v${planRev.versionNumber}`,
        summary: event.payload.generalSummary,
        targetEventId: event.id,
        timestamp: event.timestamp,
      });
      break;
    }

    case 'task_created': {
      const taskExists = tasks.some((t) => t.id === event.payload.task.id);
      if (!taskExists) {
        tasks = [...tasks, event.payload.task];
      }
      const assignee = participants.find(
        (p) => p.id === event.payload.task.assigneeParticipantId,
      );
      generalFeed = appendGeneralItem(generalFeed, {
        id: `gf_${event.id}`,
        conversationId: event.conversationId,
        sourceEventId: event.id,
        kind: 'task_delegated',
        actorLabel: assignee?.displayName ?? 'Coordenação',
        actorRoleLabel: assignee ? 'Delegação' : undefined,
        summary: event.payload.generalSummary,
        detailLinkLabel: 'Abrir tarefa',
        targetTaskId: event.payload.task.id,
        targetEventId: event.id,
        timestamp: event.timestamp,
      });
      break;
    }

    case 'task_updated': {
      tasks = tasks.map((t) =>
        t.id === event.payload.taskId
          ? {
              ...t,
              ...event.payload.patch,
            }
          : t,
      );
      if (
        event.payload.patch.status === 'completed' ||
        event.payload.patch.status === 'cancelled'
      ) {
        participants = participants.map((p) =>
          p.currentTaskId === event.payload.taskId
            ? { ...p, currentTaskId: undefined }
            : p,
        );
      }
      if (
        event.payload.patch.status &&
        conversation.executionStatus !== 'paused_queue' &&
        conversation.executionStatus !== 'paused_demo'
      ) {
        if (tasks.length > 0 && tasks.every((t) => t.status === 'completed')) {
          conversation = {
            ...conversation,
            executionStatus: 'completed',
          };
        } else if (
          (event.payload.patch.status === 'blocked' ||
            event.payload.patch.status === 'failed' ||
            event.payload.patch.status === 'cancelled') &&
          !hasExecutableOrActiveWork(tasks, escalations)
        ) {
          const hasBlockedOrStuck = tasks.some(
            (t) =>
              t.status === 'blocked' ||
              t.status === 'queued' ||
              t.status === 'planned' ||
              t.status === 'changes_requested',
          );
          conversation = {
            ...conversation,
            executionStatus:
              event.payload.patch.status === 'failed'
                ? 'failed'
                : event.payload.patch.status === 'blocked' || hasBlockedOrStuck
                  ? 'blocked'
                  : 'idle',
          };
        }
      }
      generalFeed = appendGeneralItem(generalFeed, {
        id: `gf_${event.id}`,
        conversationId: event.conversationId,
        sourceEventId: event.id,
        kind: 'status_change',
        actorLabel: 'Planejamento',
        summary: event.payload.generalSummary,
        detailLinkLabel: 'Abrir tarefa',
        targetTaskId: event.payload.taskId,
        targetEventId: event.id,
        timestamp: event.timestamp,
      });
      break;
    }

    case 'task_status_changed': {
      tasks = tasks.map((task) =>
        task.id === event.payload.taskId
          ? {
              ...task,
              status: event.payload.nextStatus,
              updatedAt: event.timestamp,
              attempts:
                event.payload.nextStatus === 'cancelled'
                  ? task.attempts.map((a) =>
                      a.status === 'running'
                        ? {
                            ...a,
                            status: 'interrupted',
                            finishedAt: a.finishedAt ?? event.timestamp,
                          }
                        : a,
                    )
                  : task.attempts,
            }
          : task,
      );
      if (event.participantId && event.payload.participantStatus) {
        participants = participants.map((p) =>
          p.id === event.participantId
            ? {
                ...p,
                status: event.payload.participantStatus!,
                currentTaskId:
                  event.payload.nextStatus === 'completed' ||
                  event.payload.nextStatus === 'cancelled'
                    ? undefined
                    : event.payload.taskId,
              }
            : p,
        );
      }
      if (
        event.payload.nextStatus === 'blocked' ||
        event.payload.nextStatus === 'cancelled'
      ) {
        if (!hasExecutableOrActiveWork(tasks, escalations)) {
          const hasBlockedOrStalledTask = tasks.some(
            (t) =>
              t.status === 'blocked' ||
              t.status === 'queued' ||
              t.status === 'planned' ||
              t.status === 'changes_requested',
          );
          conversation = {
            ...conversation,
            executionStatus:
              event.payload.nextStatus === 'blocked' || hasBlockedOrStalledTask
                ? 'blocked'
                : 'idle',
          };
        }
      }
      if (event.payload.projectToGeneral && event.payload.generalSummary) {
        generalFeed = appendGeneralItem(generalFeed, {
          id: `gf_${event.id}`,
          conversationId: event.conversationId,
          sourceEventId: event.id,
          kind:
            event.payload.nextStatus === 'completed'
              ? 'completion'
              : 'status_change',
          actorLabel: 'Fluxo de tarefa',
          summary: event.payload.generalSummary,
          detailLinkLabel: 'Abrir tarefa',
          targetTaskId: event.payload.taskId,
          targetEventId: event.id,
          timestamp: event.timestamp,
        });
      }
      break;
    }

    case 'attempt_started': {
      const targetTask = tasks.find((t) => t.id === event.payload.taskId);
      tasks = tasks.map((task) =>
        task.id === event.payload.taskId
          ? {
              ...task,
              status: 'running',
              activeContextRevisionId: event.payload.attempt.contextRevisionId,
              attempts: [...task.attempts, event.payload.attempt],
            }
          : task,
      );
      const executorId = event.payload.attempt.executorParticipantId;
      participants = participants.map((p) =>
        p.id === executorId
          ? {
              ...p,
              status: event.payload.participantStatus,
              currentTaskId: event.payload.taskId,
              modelTier: event.payload.attempt.modelTierUsed,
            }
          : p,
      );
      conversation = { ...conversation, executionStatus: 'running' };

      const modelDisplay =
        event.payload.attempt.modelRefUsed?.displayName ??
        event.payload.attempt.modelTierUsed;
      messagesByTab = appendSystemExecutionRecord(
        messagesByTab,
        event,
        executorId,
        'Execução iniciada',
        `**Tentativa #${event.payload.attempt.attemptNumber}** iniciada para \`${targetTask?.title ?? event.payload.taskId}\` · Contexto **v${event.payload.attempt.contextRevisionNumber}** · Modelo/perfil: **${modelDisplay}**${simulated ? ' (simulação)' : ''}.`,
        simulated,
      );
      participants = bumpUnreadIfInactive(participants, executorId, activeTabId);

      if (event.payload.projectToGeneral && event.payload.generalSummary) {
        const execParticipant = participants.find((p) => p.id === executorId);
        generalFeed = appendGeneralItem(generalFeed, {
          id: `gf_${event.id}`,
          conversationId: event.conversationId,
          sourceEventId: event.id,
          kind: 'task_progress',
          actorLabel: execParticipant?.displayName ?? 'Executor',
          actorRoleLabel: `Tentativa #${event.payload.attempt.attemptNumber}`,
          summary: event.payload.generalSummary,
          detailLinkLabel: 'Ver execução',
          targetTabId: executorId,
          targetTaskId: event.payload.taskId,
          targetEventId: event.id,
          timestamp: event.timestamp,
        });
      }
      break;
    }

    case 'attempt_delivered': {
      tasks = tasks.map((task) => {
        if (task.id !== event.payload.taskId) return task;
        return {
          ...task,
          status: 'awaiting_review',
          attempts: task.attempts.map((attempt) =>
            attempt.id === event.payload.attemptId
              ? {
                  ...attempt,
                  status: 'delivered',
                  deliverySummary: event.payload.deliverySummary,
                  evidenceNotes: event.payload.evidenceNotes,
                  finishedAt: event.timestamp,
                  sourceEventIds: [...attempt.sourceEventIds, event.id],
                }
              : attempt,
          ),
        };
      });
      if (event.participantId) {
        participants = participants.map((p) =>
          p.id === event.participantId
            ? { ...p, status: 'awaiting_review' }
            : p,
        );
        messagesByTab = appendSystemExecutionRecord(
          messagesByTab,
          event,
          event.participantId,
          'Entrega registrada',
          `${event.payload.deliverySummary}\n\n${event.payload.evidenceNotes.map((n) => `- ${n}`).join('\n')}`,
          simulated,
        );
        participants = bumpUnreadIfInactive(
          participants,
          event.participantId,
          activeTabId,
        );
      }
      const actor = participants.find((p) => p.id === event.participantId);
      generalFeed = appendGeneralItem(generalFeed, {
        id: `gf_${event.id}`,
        conversationId: event.conversationId,
        sourceEventId: event.id,
        kind: 'delivery_summary',
        actorLabel: actor?.displayName ?? 'Executor',
        actorRoleLabel: 'Entrega para revisão',
        summary: event.payload.generalSummary,
        detailLinkLabel: 'Ver execução',
        targetTabId: event.participantId,
        targetTaskId: event.payload.taskId,
        targetEventId: event.id,
        timestamp: event.timestamp,
      });
      break;
    }

    case 'operational_failure_recorded': {
      tasks = tasks.map((task) => {
        if (task.id !== event.payload.taskId) return task;
        return {
          ...task,
          status: 'failed',
          operationalFailureCount: task.operationalFailureCount + 1,
          attempts: task.attempts.map((attempt) =>
            attempt.id === event.payload.attemptId
              ? {
                  ...attempt,
                  status: 'failed_operational',
                  finishedAt: event.timestamp,
                  evidenceNotes: [
                    ...attempt.evidenceNotes,
                    `Falha operacional: ${event.payload.reason}`,
                  ],
                  sourceEventIds: [...attempt.sourceEventIds, event.id],
                }
              : attempt,
          ),
        };
      });
      if (event.participantId) {
        participants = participants.map((p) =>
          p.id === event.participantId
            ? { ...p, status: event.payload.participantStatus }
            : p,
        );
        messagesByTab = appendSystemExecutionRecord(
          messagesByTab,
          event,
          event.participantId,
          'Falha operacional',
          `Falha operacional registrada: ${event.payload.reason}. Não contabilizada como reprovação de qualidade.`,
          simulated,
        );
        participants = bumpUnreadIfInactive(
          participants,
          event.participantId,
          activeTabId,
        );
      }
      if (!hasExecutableOrActiveWork(tasks, escalations)) {
        conversation = {
          ...conversation,
          executionStatus: 'failed',
        };
      }
      generalFeed = appendGeneralItem(generalFeed, {
        id: `gf_${event.id}`,
        conversationId: event.conversationId,
        sourceEventId: event.id,
        kind: 'status_change',
        actorLabel: 'Operação',
        actorRoleLabel: 'Falha operacional',
        summary: event.payload.generalSummary,
        detailLinkLabel: event.participantId ? 'Ver execução' : 'Abrir tarefa',
        targetTabId: event.participantId,
        targetTaskId: event.payload.taskId,
        targetEventId: event.id,
        timestamp: event.timestamp,
      });
      break;
    }

    case 'task_reviewed': {
      const review = event.payload.review;
      const isRejected = review.decision === 'rejected';
      tasks = tasks.map((task) => {
        if (task.id !== review.taskId) return task;
        return {
          ...task,
          status: event.payload.nextTaskStatus,
          qualityRejectionCount: isRejected
            ? task.qualityRejectionCount + 1
            : task.qualityRejectionCount,
          reviews: [...task.reviews, review],
          attempts: task.attempts.map((attempt) =>
            attempt.id === review.attemptId
              ? {
                  ...attempt,
                  status: isRejected ? 'rejected_quality' : 'approved',
                  finishedAt: attempt.finishedAt ?? event.timestamp,
                  sourceEventIds: [...attempt.sourceEventIds, event.id],
                }
              : attempt,
          ),
        };
      });

      const reviewer = participants.find(
        (p) => p.id === review.reviewerParticipantId,
      );
      participants = participants.map((p) => {
        if (p.id === review.reviewerParticipantId) {
          return {
            ...p,
            status: isRejected ? 'idle' : 'completed',
          };
        }
        return p;
      });
      messagesByTab = appendSystemExecutionRecord(
        messagesByTab,
        event,
        review.reviewerParticipantId,
        reviewer?.displayName ?? 'Auditor',
        `**Decisão da revisão**: ${isRejected ? 'Reprovada por qualidade' : 'Aprovada'} — ${review.rationale}${review.independentReview === false ? '\n\n_(Parecer combinado: planejamento e auditoria compartilham o mesmo participante/sessão.)_' : ''}`,
        simulated,
      );
      participants = bumpUnreadIfInactive(
        participants,
        review.reviewerParticipantId,
        activeTabId,
      );

      const allCompleted =
        !isRejected &&
        tasks.length > 0 &&
        tasks.every((t) =>
          t.id === review.taskId ? event.payload.nextTaskStatus === 'completed' : t.status === 'completed',
        );
      if (allCompleted) {
        conversation = { ...conversation, executionStatus: 'completed' };
      }
      generalFeed = appendGeneralItem(generalFeed, {
        id: `gf_${event.id}`,
        conversationId: event.conversationId,
        sourceEventId: event.id,
        kind: 'review_decision',
        actorLabel: reviewer?.displayName ?? 'Auditor',
        actorRoleLabel: isRejected
          ? 'Reprovação de qualidade'
          : review.independentReview === false
            ? 'Aprovação (parecer combinado)'
            : 'Aprovação independente',
        summary: event.payload.generalSummary,
        detailLinkLabel: 'Ver execução',
        targetTabId: review.reviewerParticipantId,
        targetTaskId: review.taskId,
        targetEventId: event.id,
        timestamp: event.timestamp,
      });
      break;
    }

    case 'context_revision_published': {
      const rev = event.payload.revision;
      if (!contextRevisions.some((r) => r.id === rev.id)) {
        contextRevisions = [...contextRevisions, rev];
      }
      generalFeed = appendGeneralItem(generalFeed, {
        id: `gf_${event.id}`,
        conversationId: event.conversationId,
        sourceEventId: event.id,
        kind: 'context_revision',
        actorLabel: rev.authorLabel,
        actorRoleLabel: `Contexto v${rev.versionNumber}`,
        summary: event.payload.generalSummary,
        detailLinkLabel: 'Ver contexto',
        targetContextVersion: rev.versionNumber,
        targetEventId: event.id,
        timestamp: event.timestamp,
      });
      break;
    }

    case 'context_receipt_updated': {
      contextRevisions = contextRevisions.map((rev) => {
        if (rev.id !== event.payload.revisionId) return rev;
        const existingReceipt = rev.receipts[event.payload.participantId];
        if (
          !shouldAcceptReceiptTransition(
            existingReceipt?.status,
            event.payload.receipt.status,
          )
        ) {
          return rev;
        }
        return {
          ...rev,
          receipts: {
            ...rev.receipts,
            [event.payload.participantId]: event.payload.receipt,
          },
        };
      });
      if (event.payload.projectToGeneral && event.payload.generalSummary) {
        const participant = participants.find(
          (p) => p.id === event.payload.participantId,
        );
        generalFeed = appendGeneralItem(generalFeed, {
          id: `gf_${event.id}`,
          conversationId: event.conversationId,
          sourceEventId: event.id,
          kind: 'context_revision',
          actorLabel: participant?.displayName ?? 'Participante',
          actorRoleLabel: `Recibo v${event.payload.versionNumber}`,
          summary: event.payload.generalSummary,
          detailLinkLabel: 'Ver contexto',
          targetContextVersion: event.payload.versionNumber,
          targetEventId: event.id,
          timestamp: event.timestamp,
        });
      }
      break;
    }

    case 'permission_requested': {
      const req = event.payload.request;
      if (!permissions.some((p) => p.id === req.id)) {
        permissions = [...permissions, req];
      }
      participants = participants.map((p) =>
        p.id === req.participantId
          ? { ...p, status: 'awaiting_permission' }
          : p,
      );
      conversation = { ...conversation, executionStatus: 'blocked' };
      messagesByTab = appendSystemExecutionRecord(
        messagesByTab,
        event,
        req.participantId,
        'Solicitação de permissão',
        `Solicitada permissão${req.isSimulated ? ' simulada' : ''} para **${req.actionTitle}** (\`${req.commandSimulated}\`). Escopo: \`${req.scopeKey}\`.`,
        simulated,
      );
      participants = bumpUnreadIfInactive(
        participants,
        req.participantId,
        activeTabId,
      );
      const requester = participants.find((p) => p.id === req.participantId);
      generalFeed = appendGeneralItem(generalFeed, {
        id: `gf_${event.id}`,
        conversationId: event.conversationId,
        sourceEventId: event.id,
        kind: 'permission_event',
        actorLabel: requester?.displayName ?? 'Agente',
        actorRoleLabel: 'Permissão solicitada',
        summary: event.payload.generalSummary,
        detailLinkLabel: 'Ver execução',
        targetTabId: req.participantId,
        targetTaskId: req.taskId,
        targetEventId: event.id,
        timestamp: event.timestamp,
      });
      break;
    }

    case 'permission_decided': {
      const decision = event.payload.decision;
      let affectedParticipantId: string | undefined;
      permissions = permissions.map((req) => {
        if (req.id !== decision.requestId) return req;
        affectedParticipantId = req.participantId;
        return {
          ...req,
          status: decision.decision,
          resolvedAt: decision.decidedAt,
        };
      });
      if (affectedParticipantId) {
        participants = participants.map((p) =>
          p.id === affectedParticipantId
            ? {
                ...p,
                status: decision.decision === 'approved' ? 'running' : 'blocked',
              }
            : p,
        );
        messagesByTab = appendSystemExecutionRecord(
          messagesByTab,
          event,
          affectedParticipantId,
          'Decisão de permissão',
          `Permissão **${decision.decision === 'approved' ? 'aprovada' : 'recusada'}** por ${decision.decidedBy}: ${decision.note}`,
          simulated,
        );
      }
      conversation = {
        ...conversation,
        executionStatus:
          decision.decision === 'approved' ? 'running' : 'blocked',
      };
      generalFeed = appendGeneralItem(generalFeed, {
        id: `gf_${event.id}`,
        conversationId: event.conversationId,
        sourceEventId: event.id,
        kind: 'permission_event',
        actorLabel: decision.decidedBy,
        actorRoleLabel:
          decision.decision === 'approved'
            ? 'Permissão aprovada'
            : 'Permissão recusada',
        summary: event.payload.generalSummary,
        detailLinkLabel: affectedParticipantId ? 'Ver execução' : undefined,
        targetTabId: affectedParticipantId,
        targetEventId: event.id,
        timestamp: event.timestamp,
      });
      break;
    }

    case 'escalation_suggested': {
      const esc = event.payload.escalation;
      if (!escalations.some((e) => e.id === esc.id)) {
        escalations = [...escalations, esc];
      }
      generalFeed = appendGeneralItem(generalFeed, {
        id: `gf_${event.id}`,
        conversationId: event.conversationId,
        sourceEventId: event.id,
        kind: 'escalation_event',
        actorLabel: 'Política de escalonamento',
        summary: event.payload.generalSummary,
        detailLinkLabel: 'Abrir tarefa',
        targetTaskId: esc.taskId,
        targetEventId: event.id,
        timestamp: event.timestamp,
      });
      break;
    }

    case 'escalation_resolved': {
      escalations = escalations.map((esc) =>
        esc.id === event.payload.escalationId
          ? {
              ...esc,
              status: event.payload.resolution,
              resolvedAt: event.timestamp,
            }
          : esc,
      );
      if (event.payload.resolution === 'approved') {
        participants = participants.map((p) =>
          p.id === event.payload.participantId
            ? {
                ...p,
                modelTier: event.payload.appliedTier,
                modelRef: event.payload.appliedModelRef ?? p.modelRef,
              }
            : p,
        );
      }
      messagesByTab = appendSystemExecutionRecord(
        messagesByTab,
        event,
        event.payload.participantId,
        'Decisão de escalonamento',
        event.payload.generalSummary,
        simulated,
      );
      generalFeed = appendGeneralItem(generalFeed, {
        id: `gf_${event.id}`,
        conversationId: event.conversationId,
        sourceEventId: event.id,
        kind: 'escalation_event',
        actorLabel: 'Escalonamento',
        summary: event.payload.generalSummary,
        detailLinkLabel: 'Ver execução',
        targetTabId: event.payload.participantId,
        targetEventId: event.id,
        timestamp: event.timestamp,
      });
      break;
    }

    case 'connection_state_changed': {
      participants = participants.map((p) =>
        p.id === event.payload.participantId
          ? {
              ...p,
              status: event.payload.participantStatus,
              sessionRef: {
                ...p.sessionRef,
                status: event.payload.sessionStatus,
              },
            }
          : p,
      );
      if (event.payload.projectToGeneral) {
        messagesByTab = appendSystemExecutionRecord(
          messagesByTab,
          event,
          event.payload.participantId,
          'Estado da conexão',
          event.payload.generalSummary,
          simulated,
        );
        participants = bumpUnreadIfInactive(
          participants,
          event.payload.participantId,
          activeTabId,
        );
        const participant = participants.find(
          (p) => p.id === event.payload.participantId,
        );
        generalFeed = appendGeneralItem(generalFeed, {
          id: `gf_${event.id}`,
          conversationId: event.conversationId,
          sourceEventId: event.id,
          kind: 'status_change',
          actorLabel: participant?.displayName ?? 'Agente',
          summary: event.payload.generalSummary,
          detailLinkLabel: 'Ver execução',
          targetTabId: event.payload.participantId,
          targetEventId: event.id,
          timestamp: event.timestamp,
        });
      }
      break;
    }

    case 'execution_control_applied': {
      if (event.payload.nextExecutionStatus) {
        conversation = {
          ...conversation,
          executionStatus: event.payload.nextExecutionStatus,
        };
      }
      if (event.payload.participantId && event.payload.participantStatus) {
        participants = participants.map((p) =>
          p.id === event.payload.participantId
            ? { ...p, status: event.payload.participantStatus! }
            : p,
        );
      }
      if (event.payload.participantId) {
        messagesByTab = appendSystemExecutionRecord(
          messagesByTab,
          event,
          event.payload.participantId,
          'Controle de execução',
          event.payload.generalSummary,
          simulated,
        );
      }
      generalFeed = appendGeneralItem(generalFeed, {
        id: `gf_${event.id}`,
        conversationId: event.conversationId,
        sourceEventId: event.id,
        kind: 'status_change',
        actorLabel: 'Controle de execução',
        summary: event.payload.generalSummary,
        detailLinkLabel: event.payload.participantId ? 'Ver execução' : undefined,
        targetTabId: event.payload.participantId ?? 'general',
        targetEventId: event.id,
        timestamp: event.timestamp,
      });
      break;
    }
  }

  return {
    ...projection,
    conversation,
    participants,
    messagesByTab,
    generalFeed,
    tasks,
    planRevisions,
    contextRevisions,
    permissions,
    escalations,
    coordinatorHistory,
    configChanges,
    seenEventIds,
    eventLog,
  };
}

function drainContiguousBuffer(
  projection: ConversationProjection,
  activeTabId?: string,
): { projection: ConversationProjection; drainedCount: number } {
  let current = projection;
  let drainedCount = 0;
  let nextSeq = current.conversation.lastAppliedSeq + 1;

  while (current.pendingOutOfOrder[nextSeq]) {
    const bufferedEvent = current.pendingOutOfOrder[nextSeq];
    const remaining = { ...current.pendingOutOfOrder };
    delete remaining[nextSeq];
    current = applyEventIncrementally(
      { ...current, pendingOutOfOrder: remaining },
      bufferedEvent,
      activeTabId,
    );
    drainedCount += 1;
    nextSeq = current.conversation.lastAppliedSeq + 1;
  }

  const remainingKeys = Object.keys(current.pendingOutOfOrder);
  if (remainingKeys.length === 0) {
    current = {
      ...current,
      conversation: {
        ...current.conversation,
        syncState: 'synced',
        missingFromSeq: undefined,
      },
      syncErrorNote: undefined,
    };
  } else {
    const expectedSeq = current.conversation.lastAppliedSeq + 1;
    current = {
      ...current,
      conversation: {
        ...current.conversation,
        syncState: 'gap_detected',
        missingFromSeq: expectedSeq,
      },
      syncErrorNote: `Lacuna detectada na sequência: aguardando evento seq ${expectedSeq} (${remainingKeys.length} evento(s) posterior(es) retido(s) no buffer).`,
    };
  }

  return { projection: current, drainedCount };
}

export function ingestEvent(
  projection: ConversationProjection,
  event: ExecutionEvent,
  activeTabId?: string,
): IngestEventResult {
  if (event.conversationId !== projection.conversation.id) {
    return { projection, status: 'stale', appliedCount: 0 };
  }

  if (projection.seenEventIds.includes(event.id)) {
    return { projection, status: 'duplicate', appliedCount: 0 };
  }

  const expectedSeq = projection.conversation.lastAppliedSeq + 1;

  if (event.seq < expectedSeq) {
    return { projection, status: 'stale', appliedCount: 0 };
  }

  if (event.seq > expectedSeq) {
    const alreadyBuffered = Object.values(projection.pendingOutOfOrder).some(
      (item) => item.id === event.id,
    );
    if (alreadyBuffered) {
      return { projection, status: 'duplicate', appliedCount: 0 };
    }
    const nextPending = {
      ...projection.pendingOutOfOrder,
      [event.seq]: event,
    };
    const bufferedCount = Object.keys(nextPending).length;
    return {
      projection: {
        ...projection,
        pendingOutOfOrder: nextPending,
        conversation: {
          ...projection.conversation,
          syncState: 'gap_detected',
          missingFromSeq: expectedSeq,
        },
        syncErrorNote: `Lacuna detectada na sequência: esperado seq ${expectedSeq}, recebido seq ${event.seq}. ${bufferedCount} evento(s) retido(s) aguardando reconciliação.`,
      },
      status: 'buffered_gap',
      appliedCount: 0,
    };
  }

  const applied = applyEventIncrementally(projection, event, activeTabId);
  const drained = drainContiguousBuffer(applied, activeTabId);

  return {
    projection: drained.projection,
    status: 'applied',
    appliedCount: 1 + drained.drainedCount,
  };
}

export function reconcileWithMissingEvents(
  projection: ConversationProjection,
  missingEvents: ExecutionEvent[],
  activeTabId?: string,
): ConversationProjection {
  const nextPending: Record<number, ExecutionEvent> = {
    ...projection.pendingOutOfOrder,
  };
  const seenSet = new Set(projection.seenEventIds);

  for (const event of missingEvents) {
    if (event.conversationId !== projection.conversation.id) continue;
    if (seenSet.has(event.id)) continue;
    if (event.seq <= projection.conversation.lastAppliedSeq) continue;
    nextPending[event.seq] = event;
  }

  const merged: ConversationProjection = {
    ...projection,
    pendingOutOfOrder: nextPending,
  };

  return drainContiguousBuffer(merged, activeTabId).projection;
}

export function reconcileWithSnapshot(
  currentProjection: ConversationProjection,
  snapshot: {
    snapshotSeq: number;
    projection: Omit<ConversationProjection, 'pendingOutOfOrder' | 'eventLog'>;
    coveredEventLog: ExecutionEvent[];
  },
  activeTabId?: string,
): ConversationProjection {
  const seenSet = new Set(snapshot.projection.seenEventIds);
  const preservedLaterEvents: Record<number, ExecutionEvent> = {};

  for (const appliedEvent of currentProjection.eventLog) {
    if (
      appliedEvent.seq > snapshot.snapshotSeq &&
      !seenSet.has(appliedEvent.id)
    ) {
      preservedLaterEvents[appliedEvent.seq] = appliedEvent;
    }
  }

  for (const [seqKey, bufferedEvent] of Object.entries(
    currentProjection.pendingOutOfOrder,
  )) {
    const numericSeq = Number(seqKey);
    if (numericSeq > snapshot.snapshotSeq && !seenSet.has(bufferedEvent.id)) {
      preservedLaterEvents[numericSeq] = bufferedEvent;
    }
  }

  const adopted: ConversationProjection = {
    ...snapshot.projection,
    conversation: {
      ...snapshot.projection.conversation,
      lastAppliedSeq: snapshot.snapshotSeq,
    },
    seenEventIds: Array.from(seenSet),
    pendingOutOfOrder: preservedLaterEvents,
    eventLog: [...snapshot.coveredEventLog],
  };

  return drainContiguousBuffer(adopted, activeTabId).projection;
}

export function rebuildProjectionFromEvents(
  conversation: WorkspaceConversation,
  participants: Participant[],
  events: ExecutionEvent[],
): ConversationProjection {
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  let projection = createEmptyProjection(
    { ...conversation, lastAppliedSeq: 0, syncState: 'synced', missingFromSeq: undefined },
    participants.map((p) => ({ ...p, unreadCount: 0 })),
  );

  for (const event of ordered) {
    projection = ingestEvent(projection, event).projection;
  }
  return projection;
}

export function markTabAsRead(
  projection: ConversationProjection,
  tabId: string,
): ConversationProjection {
  if (tabId === 'general') return projection;
  let changed = false;
  const participants = projection.participants.map((p) => {
    if (p.id === tabId && p.unreadCount > 0) {
      changed = true;
      return { ...p, unreadCount: 0 };
    }
    return p;
  });
  return changed ? { ...projection, participants } : projection;
}
