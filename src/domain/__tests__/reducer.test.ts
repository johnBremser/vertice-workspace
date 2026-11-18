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

  it('aggregates conversation executionStatus honestly across blocked, cancelled, and failed tasks with dependent vs independent work (V6-05 P2)', () => {
    const createTask = (
      id: string,
      title: string,
      status: 'queued' | 'planned' | 'running',
      dependencyTaskIds: string[] = [],
    ) => ({
      id,
      conversationId: 'conv_p2',
      sourceRequestEventId: 'evt_req',
      title,
      description: title,
      assigneeParticipantId: 'part_claude',
      reviewerParticipantId: 'part_antigravity',
      dependencyTaskIds,
      acceptanceCriteria: ['OK'],
      status,
      attempts: [],
      reviews: [],
      operationalFailureCount: 0,
      qualityRejectionCount: 0,
    });

    const startAttempt = (proj: ReturnType<typeof makeBase>, seq: number, taskId: string, attId: string) =>
      ingestEvent(proj, {
        id: `evt_att_${seq}`,
        seq,
        conversationId: 'conv_p2',
        timestamp: '2026-11-18T10:00:00.000Z',
        origin: 'executor',
        participantId: 'part_claude',
        taskId,
        attemptId: attId,
        type: 'attempt_started',
        payload: {
          taskId,
          attempt: {
            id: attId,
            taskId,
            attemptNumber: 1,
            executorParticipantId: 'part_claude',
            modelTierUsed: 'fast',
            rolesSnapshot: ['executor'],
            instructionsSnapshot: 'Exec',
            contextRevisionId: 'ctx_1',
            contextRevisionNumber: 1,
            status: 'running',
            evidenceNotes: [],
            startedAt: '2026-11-18T10:00:00.000Z',
            sourceEventIds: [`evt_att_${seq}`],
          },
          participantStatus: 'running',
          projectToGeneral: false,
        },
      }).projection;

    // 1. Dependent case: A blocked by cap, B queued depending on A, C planned depending on B -> conversation MUST be 'blocked'
    let depProj = makeBase('conv_p2');
    depProj = ingestEvent(depProj, {
      id: 'evt_a',
      seq: 1,
      conversationId: 'conv_p2',
      timestamp: '2026-11-18T10:00:01.000Z',
      origin: 'coordinator',
      taskId: 't_a',
      type: 'task_created',
      payload: { task: createTask('t_a', 'Tarefa A', 'queued'), generalSummary: 'A' },
    }).projection;
    depProj = ingestEvent(depProj, {
      id: 'evt_b',
      seq: 2,
      conversationId: 'conv_p2',
      timestamp: '2026-11-18T10:00:02.000Z',
      origin: 'coordinator',
      taskId: 't_b',
      type: 'task_created',
      payload: { task: createTask('t_b', 'Tarefa B', 'queued', ['t_a']), generalSummary: 'B' },
    }).projection;
    depProj = ingestEvent(depProj, {
      id: 'evt_c',
      seq: 3,
      conversationId: 'conv_p2',
      timestamp: '2026-11-18T10:00:03.000Z',
      origin: 'coordinator',
      taskId: 't_c',
      type: 'task_created',
      payload: { task: createTask('t_c', 'Tarefa C', 'planned', ['t_b']), generalSummary: 'C' },
    }).projection;
    depProj = startAttempt(depProj, 4, 't_a', 'att_a_1');
    expect(depProj.conversation.executionStatus).toBe('running');

    depProj = ingestEvent(depProj, {
      id: 'evt_a_blocked',
      seq: 5,
      conversationId: 'conv_p2',
      timestamp: '2026-11-18T10:00:05.000Z',
      origin: 'system',
      participantId: 'part_claude',
      taskId: 't_a',
      type: 'task_status_changed',
      payload: {
        taskId: 't_a',
        nextStatus: 'blocked',
        participantStatus: 'blocked',
        projectToGeneral: true,
        generalSummary: 'Teto atingido em A',
      },
    }).projection;
    expect(depProj.tasks.find((t) => t.id === 't_a')?.status).toBe('blocked');
    expect(depProj.tasks.find((t) => t.id === 't_b')?.status).toBe('queued');
    expect(depProj.conversation.executionStatus).toBe('blocked');

    // 2. Independent case: A blocked, B queued with NO dependencies -> conversation MUST remain 'running'
    let indepProj = makeBase('conv_p2');
    indepProj = ingestEvent(indepProj, {
      id: 'evt_ia',
      seq: 1,
      conversationId: 'conv_p2',
      timestamp: '2026-11-18T10:01:01.000Z',
      origin: 'coordinator',
      taskId: 't_a',
      type: 'task_created',
      payload: { task: createTask('t_a', 'Tarefa A', 'queued'), generalSummary: 'A' },
    }).projection;
    indepProj = ingestEvent(indepProj, {
      id: 'evt_ib',
      seq: 2,
      conversationId: 'conv_p2',
      timestamp: '2026-11-18T10:01:02.000Z',
      origin: 'coordinator',
      taskId: 't_b',
      type: 'task_created',
      payload: { task: createTask('t_b', 'Tarefa B independente', 'queued', []), generalSummary: 'B' },
    }).projection;
    indepProj = startAttempt(indepProj, 3, 't_a', 'att_ia_1');
    indepProj = ingestEvent(indepProj, {
      id: 'evt_ia_blocked',
      seq: 4,
      conversationId: 'conv_p2',
      timestamp: '2026-11-18T10:01:04.000Z',
      origin: 'system',
      participantId: 'part_claude',
      taskId: 't_a',
      type: 'task_status_changed',
      payload: {
        taskId: 't_a',
        nextStatus: 'blocked',
        participantStatus: 'blocked',
        projectToGeneral: true,
        generalSummary: 'Teto atingido em A',
      },
    }).projection;
    expect(indepProj.conversation.executionStatus).toBe('running');

    // 3. Isolated task blocked -> 'blocked'
    let isoProj = makeBase('conv_p2');
    isoProj = ingestEvent(isoProj, {
      id: 'evt_iso_a',
      seq: 1,
      conversationId: 'conv_p2',
      timestamp: '2026-11-18T10:02:01.000Z',
      origin: 'coordinator',
      taskId: 't_a',
      type: 'task_created',
      payload: { task: createTask('t_a', 'Isolada', 'queued'), generalSummary: 'A' },
    }).projection;
    isoProj = startAttempt(isoProj, 2, 't_a', 'att_iso_1');
    isoProj = ingestEvent(isoProj, {
      id: 'evt_iso_blocked',
      seq: 3,
      conversationId: 'conv_p2',
      timestamp: '2026-11-18T10:02:03.000Z',
      origin: 'system',
      participantId: 'part_claude',
      taskId: 't_a',
      type: 'task_status_changed',
      payload: { taskId: 't_a', nextStatus: 'blocked', participantStatus: 'blocked' },
    }).projection;
    expect(isoProj.conversation.executionStatus).toBe('blocked');

    // 4. Cancellation paths: isolated -> 'idle'; with dependent queued -> 'blocked'; with independent queued -> 'running'
    let cancelIso = makeBase('conv_p2');
    cancelIso = ingestEvent(cancelIso, {
      id: 'evt_ca',
      seq: 1,
      conversationId: 'conv_p2',
      timestamp: '2026-11-18T10:03:01.000Z',
      origin: 'coordinator',
      taskId: 't_a',
      type: 'task_created',
      payload: { task: createTask('t_a', 'Cancelável', 'queued'), generalSummary: 'A' },
    }).projection;
    cancelIso = startAttempt(cancelIso, 2, 't_a', 'att_ca_1');
    cancelIso = ingestEvent(cancelIso, {
      id: 'evt_ca_cancel',
      seq: 3,
      conversationId: 'conv_p2',
      timestamp: '2026-11-18T10:03:03.000Z',
      origin: 'gateway',
      participantId: 'part_claude',
      taskId: 't_a',
      type: 'task_status_changed',
      payload: { taskId: 't_a', nextStatus: 'cancelled', participantStatus: 'idle' },
    }).projection;
    expect(cancelIso.conversation.executionStatus).toBe('idle');

    let cancelDep = makeBase('conv_p2');
    cancelDep = ingestEvent(cancelDep, {
      id: 'evt_cd_a',
      seq: 1,
      conversationId: 'conv_p2',
      timestamp: '2026-11-18T10:04:01.000Z',
      origin: 'coordinator',
      taskId: 't_a',
      type: 'task_created',
      payload: { task: createTask('t_a', 'A', 'queued'), generalSummary: 'A' },
    }).projection;
    cancelDep = ingestEvent(cancelDep, {
      id: 'evt_cd_b',
      seq: 2,
      conversationId: 'conv_p2',
      timestamp: '2026-11-18T10:04:02.000Z',
      origin: 'coordinator',
      taskId: 't_b',
      type: 'task_created',
      payload: { task: createTask('t_b', 'B dep A', 'queued', ['t_a']), generalSummary: 'B' },
    }).projection;
    cancelDep = startAttempt(cancelDep, 3, 't_a', 'att_cd_1');
    cancelDep = ingestEvent(cancelDep, {
      id: 'evt_cd_cancel',
      seq: 4,
      conversationId: 'conv_p2',
      timestamp: '2026-11-18T10:04:04.000Z',
      origin: 'gateway',
      participantId: 'part_claude',
      taskId: 't_a',
      type: 'task_status_changed',
      payload: { taskId: 't_a', nextStatus: 'cancelled', participantStatus: 'idle' },
    }).projection;
    expect(cancelDep.conversation.executionStatus).toBe('blocked');

    let cancelIndep = makeBase('conv_p2');
    cancelIndep = ingestEvent(cancelIndep, {
      id: 'evt_ci_a',
      seq: 1,
      conversationId: 'conv_p2',
      timestamp: '2026-11-18T10:05:01.000Z',
      origin: 'coordinator',
      taskId: 't_a',
      type: 'task_created',
      payload: { task: createTask('t_a', 'A', 'queued'), generalSummary: 'A' },
    }).projection;
    cancelIndep = ingestEvent(cancelIndep, {
      id: 'evt_ci_b',
      seq: 2,
      conversationId: 'conv_p2',
      timestamp: '2026-11-18T10:05:02.000Z',
      origin: 'coordinator',
      taskId: 't_b',
      type: 'task_created',
      payload: { task: createTask('t_b', 'B indep', 'queued', []), generalSummary: 'B' },
    }).projection;
    cancelIndep = startAttempt(cancelIndep, 3, 't_a', 'att_ci_1');
    cancelIndep = ingestEvent(cancelIndep, {
      id: 'evt_ci_cancel',
      seq: 4,
      conversationId: 'conv_p2',
      timestamp: '2026-11-18T10:05:04.000Z',
      origin: 'gateway',
      participantId: 'part_claude',
      taskId: 't_a',
      type: 'task_status_changed',
      payload: { taskId: 't_a', nextStatus: 'cancelled', participantStatus: 'idle' },
    }).projection;
    expect(cancelIndep.conversation.executionStatus).toBe('running');

    // 5. Operational failure with dependent queued -> 'failed'; with independent queued -> 'running'
    let failDep = makeBase('conv_p2');
    failDep = ingestEvent(failDep, {
      id: 'evt_fd_a',
      seq: 1,
      conversationId: 'conv_p2',
      timestamp: '2026-11-18T10:06:01.000Z',
      origin: 'coordinator',
      taskId: 't_a',
      type: 'task_created',
      payload: { task: createTask('t_a', 'A', 'queued'), generalSummary: 'A' },
    }).projection;
    failDep = ingestEvent(failDep, {
      id: 'evt_fd_b',
      seq: 2,
      conversationId: 'conv_p2',
      timestamp: '2026-11-18T10:06:02.000Z',
      origin: 'coordinator',
      taskId: 't_b',
      type: 'task_created',
      payload: { task: createTask('t_b', 'B dep A', 'queued', ['t_a']), generalSummary: 'B' },
    }).projection;
    failDep = startAttempt(failDep, 3, 't_a', 'att_fd_1');
    failDep = ingestEvent(failDep, {
      id: 'evt_fd_fail',
      seq: 4,
      conversationId: 'conv_p2',
      timestamp: '2026-11-18T10:06:04.000Z',
      origin: 'gateway',
      participantId: 'part_claude',
      taskId: 't_a',
      attemptId: 'att_fd_1',
      type: 'operational_failure_recorded',
      payload: {
        taskId: 't_a',
        attemptId: 'att_fd_1',
        reason: 'CLI exit 1',
        participantStatus: 'failed',
        generalSummary: 'Falha operacional em A',
      },
    }).projection;
    expect(failDep.conversation.executionStatus).toBe('failed');
  });

  it('enforces monotonic context receipt transitions without downgrades and syncs executionStatus on task_updated (V6-06)', () => {
    let proj = makeBase('conv_v606_rcpt');

    proj = ingestEvent(proj, {
      id: 'evt_ctx_pub_1',
      seq: 1,
      conversationId: 'conv_v606_rcpt',
      timestamp: '2026-11-18T11:00:00.000Z',
      origin: 'user',
      type: 'context_revision_published',
      payload: {
        revision: {
          id: 'ctx_v1',
          conversationId: 'conv_v606_rcpt',
          versionNumber: 1,
          authorLabel: 'Você',
          createdAt: '2026-11-18T11:00:00.000Z',
          summaryOfChange: 'Base v1',
          objective: 'Entregar V6-06',
          permanentInstructions: [],
          constraints: [],
          acceptanceCriteria: [],
          confirmedDecisions: [],
          receipts: {
            part_claude: {
              participantId: 'part_claude',
              revisionId: 'ctx_v1',
              status: 'pending_send',
              policyApplied: 'next_turn',
              updatedAt: '2026-11-18T11:00:00.000Z',
              mechanismNote: 'Aguardando envio.',
            },
          },
        },
        generalSummary: 'Contexto v1 publicado.',
      },
    }).projection;

    const pushReceipt = (
      seq: number,
      status: 'pending_send' | 'sent' | 'received' | 'applied' | 'failed_needs_action',
      note: string,
    ) => {
      proj = ingestEvent(proj, {
        id: `evt_rcpt_${seq}`,
        seq,
        conversationId: 'conv_v606_rcpt',
        timestamp: `2026-11-18T11:00:0${seq}.000Z`,
        origin: 'gateway',
        participantId: 'part_claude',
        type: 'context_receipt_updated',
        payload: {
          revisionId: 'ctx_v1',
          versionNumber: 1,
          participantId: 'part_claude',
          receipt: {
            participantId: 'part_claude',
            revisionId: 'ctx_v1',
            status,
            policyApplied: 'next_turn',
            updatedAt: `2026-11-18T11:00:0${seq}.000Z`,
            mechanismNote: note,
          },
          projectToGeneral: false,
        },
      }).projection;
    };

    // pending_send -> failed_needs_action -> sent -> received -> applied
    pushReceipt(2, 'failed_needs_action', 'Falha HTTP 500');
    expect(proj.contextRevisions[0].receipts.part_claude.status).toBe('failed_needs_action');

    pushReceipt(3, 'sent', 'Reenviado');
    expect(proj.contextRevisions[0].receipts.part_claude.status).toBe('sent');

    pushReceipt(4, 'pending_send', 'Tentativa de downgrade para pending_send');
    expect(proj.contextRevisions[0].receipts.part_claude.status).toBe('sent');

    pushReceipt(5, 'received', 'Resposta recebida');
    expect(proj.contextRevisions[0].receipts.part_claude.status).toBe('received');

    pushReceipt(6, 'sent', 'Tentativa de downgrade para sent');
    expect(proj.contextRevisions[0].receipts.part_claude.status).toBe('received');

    pushReceipt(7, 'applied', 'Aplicado na entrega da Tentativa #1');
    expect(proj.contextRevisions[0].receipts.part_claude.status).toBe('applied');

    pushReceipt(8, 'received', 'Tentativa de downgrade de applied para received');
    pushReceipt(9, 'failed_needs_action', 'Tentativa de downgrade de applied para failed');
    expect(proj.contextRevisions[0].receipts.part_claude.status).toBe('applied');

    // task_updated syncing executionStatus when active, and preserving paused_queue when paused
    proj = ingestEvent(proj, {
      id: 'evt_tu_create',
      seq: 10,
      conversationId: 'conv_v606_rcpt',
      timestamp: '2026-11-18T11:01:00.000Z',
      origin: 'gateway',
      taskId: 't_sync_1',
      type: 'task_created',
      payload: {
        task: {
          id: 't_sync_1',
          conversationId: 'conv_v606_rcpt',
          sourceRequestEventId: 'evt_req',
          title: 'Tarefa sincronizada',
          description: 'Desc',
          assigneeParticipantId: 'part_claude',
          dependencyTaskIds: [],
          acceptanceCriteria: ['OK'],
          status: 'running',
          attempts: [],
          reviews: [],
          operationalFailureCount: 0,
          qualityRejectionCount: 0,
        },
        generalSummary: 'Criada',
      },
    }).projection;
    proj = ingestEvent(proj, {
      id: 'evt_tu_done',
      seq: 11,
      conversationId: 'conv_v606_rcpt',
      timestamp: '2026-11-18T11:01:05.000Z',
      origin: 'gateway',
      taskId: 't_sync_1',
      type: 'task_updated',
      payload: {
        taskId: 't_sync_1',
        patch: { status: 'completed' },
        generalSummary: 'Concluída via catch-up',
      },
    }).projection;
    expect(proj.conversation.executionStatus).toBe('completed');

    // When conversation is paused_queue, task_updated MUST preserve paused_queue
    const pausedProj = {
      ...proj,
      conversation: { ...proj.conversation, executionStatus: 'paused_queue' as const },
    };
    const afterPausedUpdate = ingestEvent(pausedProj, {
      id: 'evt_tu_paused_check',
      seq: 12,
      conversationId: 'conv_v606_rcpt',
      timestamp: '2026-11-18T11:01:10.000Z',
      origin: 'gateway',
      taskId: 't_sync_1',
      type: 'task_updated',
      payload: {
        taskId: 't_sync_1',
        patch: { status: 'completed', description: 'Atualizada pausada' },
        generalSummary: 'Atualizada',
      },
    }).projection;
    expect(afterPausedUpdate.conversation.executionStatus).toBe('paused_queue');
  });
});
