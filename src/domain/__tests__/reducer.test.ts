import { describe, expect, it } from 'vitest';
import {
  createEmptyProjection,
  ingestEvent,
  reconcileWithMissingEvents,
  reconcileWithSnapshot,
} from '../reducer';
import type {
  ExecutionEvent,
  Participant,
  WorkspaceConversation,
} from '../types';

function makeBase(convId = 'conv_a') {
  const conversation: WorkspaceConversation = {
    id: convId,
    projectId: 'proj_1',
    title: `Conversa ${convId}`,
    executionMode: 'demo',
    status: 'active',
    executionStatus: 'running',
    coordinatorParticipantId: 'part_codex',
    syncState: 'synced',
    lastAppliedSeq: 0,
    scenarioStepIndex: 0,
    createdAt: '2026-11-16T10:00:00.000Z',
    updatedAt: '2026-11-16T10:00:00.000Z',
  };
  const participants: Participant[] = [
    {
      id: 'part_codex',
      conversationId: convId,
      connectionId: 'conn_codex_demo',
      agentProfileId: 'conn_codex_demo',
      displayName: 'Codex',
      role: 'coordinator',
      roles: ['coordinator', 'planner'],
      modelRef: {
        displayName: 'Revisão (Demonstração)',
        source: 'demo_tier',
        tier: 'review',
        confirmation: 'simulated',
      },
      modelTier: 'review',
      instructions: 'Coordenar.',
      sessionRef: {
        id: 'sess_codex',
        conversationId: convId,
        participantId: 'part_codex',
        connectionId: 'conn_codex_demo',
        status: 'active',
        createdAt: '2026-11-16T10:00:00.000Z',
      },
      status: 'running',
      unreadCount: 0,
      tabOrder: 0,
      isSimulated: true,
    },
    {
      id: 'part_claude',
      conversationId: convId,
      connectionId: 'conn_claude_demo',
      agentProfileId: 'conn_claude_demo',
      displayName: 'Claude',
      role: 'executor',
      roles: ['executor'],
      modelRef: {
        displayName: 'Rápido (Demonstração)',
        source: 'demo_tier',
        tier: 'fast',
        confirmation: 'simulated',
      },
      modelTier: 'fast',
      instructions: 'Executar.',
      sessionRef: {
        id: 'sess_claude',
        conversationId: convId,
        participantId: 'part_claude',
        connectionId: 'conn_claude_demo',
        status: 'active',
        createdAt: '2026-11-16T10:00:00.000Z',
      },
      status: 'running',
      unreadCount: 0,
      tabOrder: 1,
      isSimulated: true,
    },
    {
      id: 'part_antigravity',
      conversationId: convId,
      connectionId: 'conn_antigravity_demo',
      agentProfileId: 'conn_antigravity_demo',
      displayName: 'Antigravity',
      role: 'reviewer',
      roles: ['reviewer'],
      modelRef: {
        displayName: 'Revisão (Demonstração)',
        source: 'demo_tier',
        tier: 'review',
        confirmation: 'simulated',
      },
      modelTier: 'review',
      instructions: 'Revisar.',
      sessionRef: {
        id: 'sess_antigravity',
        conversationId: convId,
        participantId: 'part_antigravity',
        connectionId: 'conn_antigravity_demo',
        status: 'active',
        createdAt: '2026-11-16T10:00:00.000Z',
      },
      status: 'idle',
      unreadCount: 0,
      tabOrder: 2,
      isSimulated: true,
    },
  ];
  return createEmptyProjection(conversation, participants);
}

function makeMsgEvent(
  convId: string,
  seq: number,
  targetTab: 'general' | string = 'part_claude',
): ExecutionEvent {
  return {
    id: `evt_${convId}_${seq}`,
    seq,
    conversationId: convId,
    timestamp: `2026-11-16T10:00:${String(seq).padStart(2, '0')}.000Z`,
    origin: 'executor',
    participantId: targetTab === 'general' ? 'part_codex' : targetTab,
    type: 'agent_message_posted',
    payload: {
      messageId: `msg_${convId}_${seq}`,
      targetTab,
      authorLabel: targetTab === 'general' ? 'Codex' : 'Claude',
      bodyMarkdown: `Mensagem seq ${seq}`,
      projectToGeneral: targetTab === 'general',
      generalSummary: targetTab === 'general' ? `Resumo seq ${seq}` : undefined,
    },
  };
}

describe('Domain incremental reducer & reconciliation', () => {
  it('routes user messages to the right recipient without marking other tabs unread', () => {
    const base = makeBase('conv_a');
    const evtGeneral: ExecutionEvent = {
      id: 'evt_u_1',
      seq: 1,
      conversationId: 'conv_a',
      timestamp: '2026-11-16T10:00:01.000Z',
      origin: 'user',
      type: 'user_message_sent',
      payload: {
        messageId: 'msg_u_1',
        targetTab: 'general',
        targetParticipantId: 'part_codex',
        bodyMarkdown: 'Ajustar ordenação',
      },
    };
    const res = ingestEvent(base, evtGeneral, 'general');
    expect(res.status).toBe('applied');
    expect(res.projection.messagesByTab.general).toHaveLength(1);
    expect(res.projection.messagesByTab.general[0].delivery?.targetType).toBe(
      'coordinator',
    );
    expect(res.projection.messagesByTab.part_claude).toHaveLength(0);
    expect(res.projection.participants.every((p) => p.unreadCount === 0)).toBe(
      true,
    );
  });

  it('deduplicates replayed events by event.id without duplicating messages', () => {
    let proj = makeBase('conv_a');
    const evt1 = makeMsgEvent('conv_a', 1, 'part_claude');
    proj = ingestEvent(proj, evt1, 'general').projection;
    const replay = ingestEvent(proj, evt1, 'general');

    expect(replay.status).toBe('duplicate');
    expect(replay.projection.messagesByTab.part_claude).toHaveLength(1);
    expect(replay.projection.eventLog).toHaveLength(1);
  });

  it('buffers out-of-order events, signals gap_detected, and merges missing events without losing buffered seq 12', () => {
    let proj = makeBase('conv_a');
    for (let seq = 1; seq <= 10; seq += 1) {
      proj = ingestEvent(proj, makeMsgEvent('conv_a', seq), 'part_claude').projection;
    }
    expect(proj.conversation.lastAppliedSeq).toBe(10);

    // Event 12 arrives before 11
    const evt12 = makeMsgEvent('conv_a', 12);
    const gapRes = ingestEvent(proj, evt12, 'part_claude');
    expect(gapRes.status).toBe('buffered_gap');
    expect(gapRes.projection.conversation.syncState).toBe('gap_detected');
    expect(gapRes.projection.conversation.missingFromSeq).toBe(11);
    expect(gapRes.projection.conversation.lastAppliedSeq).toBe(10);
    expect(gapRes.projection.pendingOutOfOrder[12]?.id).toBe(evt12.id);

    // Reconciliation returns ONLY missing event 11; 12 must NOT be lost!
    const evt11 = makeMsgEvent('conv_a', 11);
    const reconciled = reconcileWithMissingEvents(
      gapRes.projection,
      [evt11],
      'part_claude',
    );
    expect(reconciled.conversation.syncState).toBe('synced');
    expect(reconciled.conversation.lastAppliedSeq).toBe(12);
    expect(Object.keys(reconciled.pendingOutOfOrder)).toHaveLength(0);
    expect(reconciled.messagesByTab.part_claude).toHaveLength(12);
    expect(reconciled.messagesByTab.part_claude[10].bodyMarkdown).toBe(
      'Mensagem seq 11',
    );
    expect(reconciled.messagesByTab.part_claude[11].bodyMarkdown).toBe(
      'Mensagem seq 12',
    );
  });

  it('reconciles with snapshotSeq discarding only covered events and preserving seq > snapshotSeq (12 and 13)', () => {
    let proj = makeBase('conv_a');
    for (let seq = 1; seq <= 10; seq += 1) {
      proj = ingestEvent(proj, makeMsgEvent('conv_a', seq), 'part_claude').projection;
    }

    // Buffer 12 and 13 while 11 is missing
    const evt12 = makeMsgEvent('conv_a', 12);
    const evt13 = makeMsgEvent('conv_a', 13);
    proj = ingestEvent(proj, evt12, 'part_claude').projection;
    proj = ingestEvent(proj, evt13, 'part_claude').projection;
    expect(proj.conversation.syncState).toBe('gap_detected');

    // Snapshot covers up to seq 11
    let snapSource = makeBase('conv_a');
    for (let seq = 1; seq <= 11; seq += 1) {
      snapSource = ingestEvent(
        snapSource,
        makeMsgEvent('conv_a', seq),
        'part_claude',
      ).projection;
    }

    const reconciled = reconcileWithSnapshot(
      proj,
      {
        snapshotSeq: 11,
        projection: {
          conversation: snapSource.conversation,
          participants: snapSource.participants,
          messagesByTab: snapSource.messagesByTab,
          generalFeed: snapSource.generalFeed,
          tasks: snapSource.tasks,
          planRevisions: snapSource.planRevisions,
          contextRevisions: snapSource.contextRevisions,
          permissions: snapSource.permissions,
          escalations: snapSource.escalations,
          coordinatorHistory: snapSource.coordinatorHistory,
          configChanges: snapSource.configChanges,
          seenEventIds: snapSource.seenEventIds,
        },
        coveredEventLog: snapSource.eventLog,
      },
      'part_claude',
    );

    expect(reconciled.conversation.syncState).toBe('synced');
    expect(reconciled.conversation.lastAppliedSeq).toBe(13);
    expect(reconciled.messagesByTab.part_claude).toHaveLength(13);
    expect(reconciled.messagesByTab.part_claude[11].bodyMarkdown).toBe(
      'Mensagem seq 12',
    );
    expect(reconciled.messagesByTab.part_claude[12].bodyMarkdown).toBe(
      'Mensagem seq 13',
    );
  });

  it('isolates event ingestion and cursors strictly per conversationId', () => {
    const convA = makeBase('conv_a');
    const convB = makeBase('conv_b');
    const eventForB = makeMsgEvent('conv_b', 1);

    const resA = ingestEvent(convA, eventForB, 'general');
    expect(resA.status).toBe('stale');
    expect(resA.projection.conversation.lastAppliedSeq).toBe(0);
    expect(resA.projection.eventLog).toHaveLength(0);

    const resB = ingestEvent(convB, eventForB, 'general');
    expect(resB.status).toBe('applied');
    expect(resB.projection.conversation.lastAppliedSeq).toBe(1);
  });

  it('separates operational failures from quality rejections without consuming quality attempts', () => {
    let proj = makeBase('conv_a');
    proj = ingestEvent(proj, {
      id: 'evt_t1',
      seq: 1,
      conversationId: 'conv_a',
      timestamp: '2026-11-16T10:00:01.000Z',
      origin: 'coordinator',
      taskId: 't1',
      type: 'task_created',
      payload: {
        task: {
          id: 't1',
          conversationId: 'conv_a',
          sourceRequestEventId: 'evt_req',
          title: 'Tarefa teste',
          description: 'Desc',
          assigneeParticipantId: 'part_claude',
          reviewerParticipantId: 'part_antigravity',
          dependencyTaskIds: [],
          acceptanceCriteria: ['Critério 1'],
          status: 'queued',
          attempts: [],
          reviews: [],
          operationalFailureCount: 0,
          qualityRejectionCount: 0,
        },
        generalSummary: 'Criada',
      },
    }).projection;

    proj = ingestEvent(proj, {
      id: 'evt_a1',
      seq: 2,
      conversationId: 'conv_a',
      timestamp: '2026-11-16T10:00:02.000Z',
      origin: 'executor',
      participantId: 'part_claude',
      taskId: 't1',
      attemptId: 'att_1',
      type: 'attempt_started',
      payload: {
        taskId: 't1',
        attempt: {
          id: 'att_1',
          taskId: 't1',
          attemptNumber: 1,
          executorParticipantId: 'part_claude',
          modelTierUsed: 'fast',
          contextRevisionId: 'ctx_1',
          contextRevisionNumber: 1,
          status: 'running',
          evidenceNotes: [],
          startedAt: '2026-11-16T10:00:02.000Z',
          sourceEventIds: ['evt_a1'],
        },
        participantStatus: 'running',
      },
    }).projection;

    // Operational failure must NOT increment qualityRejectionCount
    proj = ingestEvent(proj, {
      id: 'evt_op',
      seq: 3,
      conversationId: 'conv_a',
      timestamp: '2026-11-16T10:00:03.000Z',
      origin: 'gateway',
      participantId: 'part_claude',
      taskId: 't1',
      attemptId: 'att_1',
      type: 'operational_failure_recorded',
      payload: {
        taskId: 't1',
        attemptId: 'att_1',
        reason: 'Timeout de rede',
        participantStatus: 'disconnected',
        generalSummary: 'Falha operacional',
      },
    }).projection;

    expect(proj.tasks[0].operationalFailureCount).toBe(1);
    expect(proj.tasks[0].qualityRejectionCount).toBe(0);

    // Quality rejection increments ONLY qualityRejectionCount
    proj = ingestEvent(proj, {
      id: 'evt_qual',
      seq: 4,
      conversationId: 'conv_a',
      timestamp: '2026-11-16T10:00:04.000Z',
      origin: 'reviewer',
      participantId: 'part_antigravity',
      taskId: 't1',
      attemptId: 'att_1',
      type: 'task_reviewed',
      payload: {
        review: {
          id: 'rev_1',
          taskId: 't1',
          attemptId: 'att_1',
          reviewerParticipantId: 'part_antigravity',
          decision: 'rejected',
          rationale: 'Faltou teste unitário',
          unmetCriteria: ['Critério 1'],
          decidedAt: '2026-11-16T10:00:04.000Z',
          sourceEventId: 'evt_qual',
        },
        nextTaskStatus: 'changes_requested',
        generalSummary: 'Reprovada por qualidade',
      },
    }).projection;

    expect(proj.tasks[0].operationalFailureCount).toBe(1);
    expect(proj.tasks[0].qualityRejectionCount).toBe(1);
  });

  it('preserves already-applied local events (seq > snapshotSeq) and buffered events when reconciling with an older snapshot', () => {
    let proj = makeBase('conv_a');
    for (let seq = 1; seq <= 8; seq += 1) {
      proj = ingestEvent(proj, makeMsgEvent('conv_a', seq), 'part_claude').projection;
    }

    // Snapshot was taken at seq 8
    const snapSource = proj;

    // Later events 9 and 10 were already applied locally in eventLog, and 12 is buffered (gap at 11)
    proj = ingestEvent(proj, makeMsgEvent('conv_a', 9), 'part_claude').projection;
    proj = ingestEvent(proj, makeMsgEvent('conv_a', 10), 'part_claude').projection;
    proj = ingestEvent(proj, makeMsgEvent('conv_a', 12), 'part_claude').projection;
    expect(proj.conversation.lastAppliedSeq).toBe(10);
    expect(proj.conversation.syncState).toBe('gap_detected');

    const reconciled = reconcileWithSnapshot(
      proj,
      {
        snapshotSeq: 8,
        projection: {
          conversation: snapSource.conversation,
          participants: snapSource.participants,
          messagesByTab: snapSource.messagesByTab,
          generalFeed: snapSource.generalFeed,
          tasks: snapSource.tasks,
          planRevisions: snapSource.planRevisions,
          contextRevisions: snapSource.contextRevisions,
          permissions: snapSource.permissions,
          escalations: snapSource.escalations,
          coordinatorHistory: snapSource.coordinatorHistory,
          configChanges: snapSource.configChanges,
          seenEventIds: snapSource.seenEventIds,
        },
        coveredEventLog: snapSource.eventLog,
      },
      'part_claude',
    );

    // Events 9 and 10 from eventLog must NOT be discarded; 12 remains buffered waiting for 11
    expect(reconciled.conversation.lastAppliedSeq).toBe(10);
    expect(reconciled.conversation.syncState).toBe('gap_detected');
    expect(reconciled.conversation.missingFromSeq).toBe(11);
    expect(reconciled.messagesByTab.part_claude).toHaveLength(10);
    expect(reconciled.messagesByTab.part_claude[8].bodyMarkdown).toBe('Mensagem seq 9');
    expect(reconciled.messagesByTab.part_claude[9].bodyMarkdown).toBe('Mensagem seq 10');
    expect(reconciled.pendingOutOfOrder[12]?.id).toBe('evt_conv_a_12');
  });

  it('records renderable system execution entries in target participant tabs for every General Ver execução link', () => {
    let proj = makeBase('conv_a');

    proj = ingestEvent(proj, {
      id: 'evt_trace_task',
      seq: 1,
      conversationId: 'conv_a',
      timestamp: '2026-11-16T10:00:01.000Z',
      origin: 'coordinator',
      taskId: 't1',
      type: 'task_created',
      payload: {
        task: {
          id: 't1',
          conversationId: 'conv_a',
          sourceRequestEventId: 'evt_req',
          title: 'Tarefa rastreável',
          description: 'Desc',
          assigneeParticipantId: 'part_claude',
          reviewerParticipantId: 'part_antigravity',
          dependencyTaskIds: [],
          acceptanceCriteria: ['Critério'],
          status: 'queued',
          attempts: [],
          reviews: [],
          operationalFailureCount: 0,
          qualityRejectionCount: 0,
        },
        generalSummary: 'Criada',
      },
    }).projection;

    proj = ingestEvent(proj, {
      id: 'evt_trace_att',
      seq: 2,
      conversationId: 'conv_a',
      timestamp: '2026-11-16T10:00:02.000Z',
      origin: 'executor',
      participantId: 'part_claude',
      taskId: 't1',
      attemptId: 'att_1',
      type: 'attempt_started',
      payload: {
        taskId: 't1',
        attempt: {
          id: 'att_1',
          taskId: 't1',
          attemptNumber: 1,
          executorParticipantId: 'part_claude',
          modelTierUsed: 'fast',
          contextRevisionId: 'ctx_1',
          contextRevisionNumber: 1,
          status: 'running',
          evidenceNotes: [],
          startedAt: '2026-11-16T10:00:02.000Z',
          sourceEventIds: ['evt_trace_att'],
        },
        participantStatus: 'running',
        projectToGeneral: true,
        generalSummary: 'Tentativa #1 iniciada',
      },
    }).projection;

    proj = ingestEvent(proj, {
      id: 'evt_trace_perm',
      seq: 3,
      conversationId: 'conv_a',
      timestamp: '2026-11-16T10:00:03.000Z',
      origin: 'executor',
      participantId: 'part_claude',
      taskId: 't1',
      type: 'permission_requested',
      payload: {
        request: {
          id: 'perm_1',
          conversationId: 'conv_a',
          participantId: 'part_claude',
          taskId: 't1',
          actionKey: 'run_tests',
          scopeKey: 'workspace_sim',
          actionTitle: 'Rodar testes',
          commandSimulated: 'npm test',
          scopeDescription: 'Escopo simulado',
          status: 'pending',
          createdAt: '2026-11-16T10:00:03.000Z',
          sourceEventId: 'evt_trace_perm',
          isSimulated: true,
        },
        generalSummary: 'Permissão solicitada',
      },
    }).projection;

    proj = ingestEvent(proj, {
      id: 'evt_trace_del',
      seq: 4,
      conversationId: 'conv_a',
      timestamp: '2026-11-16T10:00:04.000Z',
      origin: 'executor',
      participantId: 'part_claude',
      taskId: 't1',
      attemptId: 'att_1',
      type: 'attempt_delivered',
      payload: {
        taskId: 't1',
        attemptId: 'att_1',
        deliverySummary: 'Entrega pronta',
        evidenceNotes: ['Evidência'],
        generalSummary: 'Entrega registrada',
      },
    }).projection;

    proj = ingestEvent(proj, {
      id: 'evt_trace_rev',
      seq: 5,
      conversationId: 'conv_a',
      timestamp: '2026-11-16T10:00:05.000Z',
      origin: 'reviewer',
      participantId: 'part_antigravity',
      taskId: 't1',
      attemptId: 'att_1',
      type: 'task_reviewed',
      payload: {
        review: {
          id: 'rev_1',
          taskId: 't1',
          attemptId: 'att_1',
          reviewerParticipantId: 'part_antigravity',
          decision: 'approved',
          rationale: 'Aprovado',
          unmetCriteria: [],
          decidedAt: '2026-11-16T10:00:05.000Z',
          sourceEventId: 'evt_trace_rev',
        },
        nextTaskStatus: 'completed',
        generalSummary: 'Revisão aprovada',
      },
    }).projection;

    for (const item of proj.generalFeed) {
      if (item.targetTabId && item.targetTabId !== 'general' && item.targetEventId) {
        const targetMessages = proj.messagesByTab[item.targetTabId] ?? [];
        expect(
          targetMessages.some((m) => m.sourceEventId === item.targetEventId),
        ).toBe(true);
      }
    }
  });
});
