import { describe, expect, it } from 'vitest';
import type { WorkspaceStoreState } from '../../domain/types';
import { AionCoreAdapterSkeleton } from '../aionCoreAdapter';
import {
  DEMO_CONVERSATION_ID,
  DEMO_PROJECT_ID,
  createInitialWorkspaceState,
} from '../demoScenario';
import {
  buildConversationMarkdownExport,
  buildWorkspaceJsonExport,
} from '../exportService';
import { GatewayCapabilityError } from '../gateway';
import { MockWorkspaceGateway } from '../mockGateway';
import {
  MemoryOnlyStorageDriver,
  type StorageDriver,
  WorkspacePersistenceManager,
  sanitizeLoadedStateAfterReload,
} from '../storage';

async function advanceScenarioWithManualApprovals(
  gateway: MockWorkspaceGateway,
  conversationId: string,
  escalationChoice: 'approved' | 'dismissed' = 'approved',
) {
  for (let i = 0; i < 12; i += 1) {
    const res = gateway.stepScenario(conversationId);
    if (res.blocked) {
      const conv = gateway.getStateSnapshot().conversations[conversationId];
      const pendingPerm = conv.permissions.find((p) => p.status === 'pending');
      if (pendingPerm) {
        await gateway.respondPermission({
          conversationId,
          requestId: pendingPerm.id,
          decision: 'approved',
        });
        continue;
      }
      const pendingEsc = conv.escalations.find((e) => e.status === 'suggested');
      if (pendingEsc) {
        await gateway.resolveEscalation({
          conversationId,
          escalationId: pendingEsc.id,
          resolution: escalationChoice,
        });
        continue;
      }
    }
    if (res.finished) break;
  }
}

describe('Workspace gateway, storage failure, reload recovery & export', () => {
  it('switches to session_only mode on QuotaExceededError without silent data loss and keeps export functional', async () => {
    const failingDriver = new MemoryOnlyStorageDriver({ failOnWrite: true });
    const persistence = new WorkspacePersistenceManager(failingDriver);
    const gateway = new MockWorkspaceGateway(persistence);

    await gateway.loadWorkspace();
    expect(persistence.getInfo().status).toBe('session_only');

    await gateway.sendMessage({
      conversationId: DEMO_CONVERSATION_ID,
      targetTab: 'general',
      bodyMarkdown: 'Mensagem mantida apenas na sessão',
    });

    const snapshot = gateway.getStateSnapshot();
    const conv = snapshot.conversations[DEMO_CONVERSATION_ID];
    const md = buildConversationMarkdownExport(
      snapshot.projects[0],
      conv,
      snapshot.modelPolicy,
    );
    const json = buildWorkspaceJsonExport(snapshot);

    expect(md).toContain('Mensagem mantida apenas na sessão');
    expect(json).toContain('"exportSchemaVersion": "2.0.0"');
    expect(json).toContain(conv.eventLog[0].id);

    gateway.dispose();
  });

  it('recovers persisted runs as paused_demo after reload without restarting timers', () => {
    const state = createInitialWorkspaceState();
    state.conversations[DEMO_CONVERSATION_ID].conversation.executionStatus =
      'running';
    state.conversations[DEMO_CONVERSATION_ID].conversation.autoPlayWasRunning =
      true;

    const sanitized = sanitizeLoadedStateAfterReload(state);
    const conv = sanitized.conversations[DEMO_CONVERSATION_ID].conversation;

    expect(conv.executionStatus).toBe('paused_demo');
    expect(conv.autoPlayWasRunning).toBe(false);
  });

  it('sends General messages to coordinator only unless explicitly promoted to Shared Context', async () => {
    const persistence = new WorkspacePersistenceManager(
      new MemoryOnlyStorageDriver(),
    );
    const gateway = new MockWorkspaceGateway(persistence);
    await gateway.loadWorkspace();

    const beforeRevs =
      gateway.getStateSnapshot().conversations[DEMO_CONVERSATION_ID]
        .contextRevisions.length;

    await gateway.sendMessage({
      conversationId: DEMO_CONVERSATION_ID,
      targetTab: 'general',
      bodyMarkdown: 'Pergunta apenas ao coordenador',
      promoteToSharedContext: false,
    });

    const afterNoPromote =
      gateway.getStateSnapshot().conversations[DEMO_CONVERSATION_ID];
    expect(afterNoPromote.contextRevisions).toHaveLength(beforeRevs);
    expect(
      afterNoPromote.participants.find((p) => p.id === 'part_antigravity')
        ?.unreadCount,
    ).toBe(0);

    await gateway.sendMessage({
      conversationId: DEMO_CONVERSATION_ID,
      targetTab: 'general',
      bodyMarkdown: 'Restrição promovida explicitamente',
      promoteToSharedContext: true,
    });

    const afterPromote =
      gateway.getStateSnapshot().conversations[DEMO_CONVERSATION_ID];
    expect(afterPromote.contextRevisions).toHaveLength(beforeRevs + 1);
    const rev2 =
      afterPromote.contextRevisions[afterPromote.contextRevisions.length - 1];
    expect(rev2.receipts.part_codex.status).toBe('applied');
    expect(rev2.receipts.part_claude.status).toBe('sent');

    gateway.dispose();
  });

  it('completes full deterministic scenario in manual mode only after explicit permission and escalation decisions', async () => {
    const persistence = new WorkspacePersistenceManager(
      new MemoryOnlyStorageDriver(),
    );
    const gateway = new MockWorkspaceGateway(persistence);
    await gateway.loadWorkspace();

    // Step 6 (context v2) & Step 7 (permission requested)
    expect(gateway.stepScenario(DEMO_CONVERSATION_ID).blocked).toBeFalsy();
    expect(gateway.stepScenario(DEMO_CONVERSATION_ID).blocked).toBeFalsy();

    // Must block at step 7 -> 8 until perm_test_suite_1 is explicitly resolved
    const blockedOnPerm = gateway.stepScenario(DEMO_CONVERSATION_ID);
    expect(blockedOnPerm.blocked).toBe(true);

    await gateway.respondPermission({
      conversationId: DEMO_CONVERSATION_ID,
      requestId: 'perm_test_suite_1',
      decision: 'approved',
    });

    // Step 8 (Att #1 rejected #1), Step 9 (Att #2 operational failure), Step 10 (Att #3 rejected #2 + escalation suggested)
    expect(gateway.stepScenario(DEMO_CONVERSATION_ID).blocked).toBeFalsy();
    expect(gateway.stepScenario(DEMO_CONVERSATION_ID).blocked).toBeFalsy();
    expect(gateway.stepScenario(DEMO_CONVERSATION_ID).blocked).toBeFalsy();

    // In manual mode, step 10 -> 11 MUST block until user approves or dismisses escalation
    const blockedOnEsc = gateway.stepScenario(DEMO_CONVERSATION_ID);
    expect(blockedOnEsc.blocked).toBe(true);

    const esc =
      gateway.getStateSnapshot().conversations[DEMO_CONVERSATION_ID]
        .escalations[0];
    expect(esc?.status).toBe('suggested');

    await gateway.resolveEscalation({
      conversationId: DEMO_CONVERSATION_ID,
      escalationId: esc.id,
      resolution: 'approved',
    });

    expect(gateway.stepScenario(DEMO_CONVERSATION_ID).blocked).toBeFalsy();
    expect(gateway.stepScenario(DEMO_CONVERSATION_ID).finished).toBe(true);

    const proj =
      gateway.getStateSnapshot().conversations[DEMO_CONVERSATION_ID];
    const mainTask = proj.tasks.find((t) => t.id === 'task_busca_nome');
    const depTask = proj.tasks.find((t) => t.id === 'task_validacao_final');

    expect(mainTask?.status).toBe('completed');
    expect(mainTask?.qualityRejectionCount).toBe(2);
    expect(mainTask?.operationalFailureCount).toBe(1);
    expect(depTask?.status).toBe('completed');
    expect(proj.escalations[0]?.status).toBe('approved');
    expect(proj.conversation.executionStatus).toBe('completed');

    gateway.dispose();
  });

  it('preserves active conversation selection across sendMessage and keeps unreadCount at 0 for the currently open agent tab', async () => {
    const persistence = new WorkspacePersistenceManager(
      new MemoryOnlyStorageDriver(),
    );
    const gateway = new MockWorkspaceGateway(persistence);
    await gateway.loadWorkspace();

    const convB = await gateway.createConversation({
      projectId: DEMO_PROJECT_ID,
      title: 'Conversa secundária',
    });
    expect(gateway.getStateSnapshot().activeConversationId).toBe(
      convB.conversation.id,
    );

    // Switch back to Conversation A and send a message
    gateway.setActiveView({
      projectId: DEMO_PROJECT_ID,
      conversationId: DEMO_CONVERSATION_ID,
      tabId: 'general',
    });
    expect(gateway.getStateSnapshot().activeConversationId).toBe(
      DEMO_CONVERSATION_ID,
    );

    await gateway.sendMessage({
      conversationId: DEMO_CONVERSATION_ID,
      targetTab: 'general',
      bodyMarkdown: 'Mensagem na conversa A',
    });
    expect(gateway.getStateSnapshot().activeConversationId).toBe(
      DEMO_CONVERSATION_ID,
    );

    // Open Claude tab -> clears initial unreadCount to 0 and keeps it 0 on incoming replies/system records
    gateway.setActiveView({
      projectId: DEMO_PROJECT_ID,
      conversationId: DEMO_CONVERSATION_ID,
      tabId: 'part_claude',
    });
    expect(
      gateway
        .getStateSnapshot()
        .conversations[DEMO_CONVERSATION_ID].participants.find(
          (p) => p.id === 'part_claude',
        )?.unreadCount,
    ).toBe(0);

    await gateway.sendMessage({
      conversationId: DEMO_CONVERSATION_ID,
      targetTab: 'part_claude',
      bodyMarkdown: 'Mensagem direta com a aba Claude aberta',
    });
    gateway.stepScenario(DEMO_CONVERSATION_ID);
    gateway.stepScenario(DEMO_CONVERSATION_ID);

    expect(
      gateway
        .getStateSnapshot()
        .conversations[DEMO_CONVERSATION_ID].participants.find(
          (p) => p.id === 'part_claude',
        )?.unreadCount,
    ).toBe(0);

    gateway.dispose();
  });

  it('respects dismissed escalations, custom rejection threshold (5), and denied permissions', async () => {
    const persistence = new WorkspacePersistenceManager(
      new MemoryOnlyStorageDriver(),
    );
    const gateway = new MockWorkspaceGateway(persistence);
    await gateway.loadWorkspace();

    // 1. Dismissed escalation must keep executor on fast tier for Attempt #4
    await advanceScenarioWithManualApprovals(
      gateway,
      DEMO_CONVERSATION_ID,
      'dismissed',
    );
    const dismissedConv =
      gateway.getStateSnapshot().conversations[DEMO_CONVERSATION_ID];
    const att4 = dismissedConv.tasks
      .find((t) => t.id === 'task_busca_nome')
      ?.attempts.find((a) => a.id === 'att_4');
    expect(dismissedConv.escalations[0]?.status).toBe('dismissed');
    expect(att4?.modelTierUsed).toBe('fast');

    // 2. Threshold of 5 quality rejections must NOT suggest escalation after 2 rejections
    await gateway.resetDemo();
    await gateway.updateModelPolicy({
      defaultExecutorTier: 'fast',
      reviewerTier: 'review',
      escalationTargetTier: 'advanced',
      qualityRejectionsBeforeSuggest: 5,
      approvalMode: 'manual',
    });
    await advanceScenarioWithManualApprovals(gateway, DEMO_CONVERSATION_ID);
    const highThresholdConv =
      gateway.getStateSnapshot().conversations[DEMO_CONVERSATION_ID];
    expect(highThresholdConv.escalations).toHaveLength(0);
    expect(highThresholdConv.conversation.executionStatus).toBe('completed');

    // 3. Denied permission must permanently block scenario progression (including autoPlay)
    await gateway.resetDemo();
    gateway.stepScenario(DEMO_CONVERSATION_ID);
    gateway.stepScenario(DEMO_CONVERSATION_ID);
    await gateway.respondPermission({
      conversationId: DEMO_CONVERSATION_ID,
      requestId: 'perm_test_suite_1',
      decision: 'denied',
    });
    const deniedStep = gateway.stepScenario(DEMO_CONVERSATION_ID);
    expect(deniedStep.blocked).toBe(true);
    const att1 = gateway
      .getStateSnapshot()
      .conversations[DEMO_CONVERSATION_ID].tasks.find(
        (t) => t.id === 'task_busca_nome',
      )
      ?.attempts.find((a) => a.id === 'att_1');
    expect(att1?.status).toBe('running');

    gateway.dispose();
  });

  it('blocks scenario advancement during gap_detected and resumes cleanly after reconciliation without losing buffered events', async () => {
    const persistence = new WorkspacePersistenceManager(
      new MemoryOnlyStorageDriver(),
    );
    const gateway = new MockWorkspaceGateway(persistence);
    await gateway.loadWorkspace();

    gateway.triggerOutOfOrderGapScenario(DEMO_CONVERSATION_ID);
    const gapped =
      gateway.getStateSnapshot().conversations[DEMO_CONVERSATION_ID];
    expect(gapped.conversation.syncState).toBe('gap_detected');
    const stepBefore = gapped.conversation.scenarioStepIndex;

    const blockedStep = gateway.stepScenario(DEMO_CONVERSATION_ID);
    expect(blockedStep.blocked).toBe(true);
    expect(
      gateway.getStateSnapshot().conversations[DEMO_CONVERSATION_ID]
        .conversation.scenarioStepIndex,
    ).toBe(stepBefore);

    await gateway.reconcileConversation(DEMO_CONVERSATION_ID);
    const reconciled =
      gateway.getStateSnapshot().conversations[DEMO_CONVERSATION_ID];
    expect(reconciled.conversation.syncState).toBe('synced');
    expect(Object.keys(reconciled.pendingOutOfOrder)).toHaveLength(0);

    const resumedStep = gateway.stepScenario(DEMO_CONVERSATION_ID);
    expect(resumedStep.blocked).toBeFalsy();
    expect(
      gateway.getStateSnapshot().conversations[DEMO_CONVERSATION_ID]
        .conversation.scenarioStepIndex,
    ).toBe(stepBefore + 1);

    gateway.dispose();
  });

  it('avoids context version collisions when user publishes manual revision before step 6 and keeps traceability links intact', async () => {
    const persistence = new WorkspacePersistenceManager(
      new MemoryOnlyStorageDriver(),
    );
    const gateway = new MockWorkspaceGateway(persistence);
    await gateway.loadWorkspace();

    const manualRev = await gateway.publishContextRevision({
      conversationId: DEMO_CONVERSATION_ID,
      authorLabel: 'Você',
      summaryOfChange: 'Revisão manual antes do passo 6',
      objective: 'Objetivo atualizado manualmente',
      permanentInstructions: ['Instrução manual'],
      constraints: ['Restrição manual'],
      acceptanceCriteria: ['Critério manual'],
      confirmedDecisions: [],
    });
    expect(manualRev.versionNumber).toBe(2);

    await advanceScenarioWithManualApprovals(gateway, DEMO_CONVERSATION_ID);
    const conv =
      gateway.getStateSnapshot().conversations[DEMO_CONVERSATION_ID];
    const versionNumbers = conv.contextRevisions.map((r) => r.versionNumber);
    expect(versionNumbers).toEqual([1, 2, 3]);

    const mainTask = conv.tasks.find((t) => t.id === 'task_busca_nome');
    const att2 = mainTask?.attempts.find((a) => a.id === 'att_2');
    expect(att2?.contextRevisionNumber).toBe(3);

    // Every Ver execução link in Geral must resolve to a renderable message in the target tab
    for (const item of conv.generalFeed) {
      if (
        item.targetTabId &&
        item.targetTabId !== 'general' &&
        item.targetEventId
      ) {
        const tabMessages = conv.messagesByTab[item.targetTabId] ?? [];
        expect(
          tabMessages.some((m) => m.sourceEventId === item.targetEventId),
        ).toBe(true);
      }
    }

    gateway.dispose();
  });

  it('serializes concurrent persistence writes so newer state always wins and saved status waits for the latest generation', async () => {
    let savedSnapshots: WorkspaceStoreState[] = [];
    let callCount = 0;

    const delayedDriver: StorageDriver = {
      async load() {
        return null;
      },
      async save(state: WorkspaceStoreState) {
        callCount += 1;
        const delay = callCount === 2 ? 40 : 5;
        await new Promise((resolve) => setTimeout(resolve, delay));
        savedSnapshots.push(structuredClone(state));
      },
      async clear() {
        savedSnapshots = [];
      },
    };

    const persistence = new WorkspacePersistenceManager(delayedDriver);
    const statuses: string[] = [];
    persistence.subscribe((info) => statuses.push(info.status));

    const initial = await persistence.loadInitial(createInitialWorkspaceState);
    const stateA = structuredClone(initial);
    stateA.projects[0].name = 'Versão A (antiga)';
    const stateB = structuredClone(initial);
    stateB.projects[0].name = 'Versão B (mais recente)';

    persistence.scheduleSave(stateA, 0);
    await new Promise((resolve) => setTimeout(resolve, 10));
    persistence.scheduleSave(stateB, 0);
    await new Promise((resolve) => setTimeout(resolve, 80));
    await persistence.flushSave();

    const lastSaved = savedSnapshots[savedSnapshots.length - 1];
    expect(lastSaved.projects[0].name).toBe('Versão B (mais recente)');
    expect(persistence.getInfo().status).toBe('saved');
    expect(statuses[statuses.length - 1]).toBe('saved');

    persistence.dispose();
  });

  it('blocks manual and automatic scenario progression when a menu-triggered permission is pending or denied', async () => {
    const persistence = new WorkspacePersistenceManager(
      new MemoryOnlyStorageDriver(),
    );
    const gateway = new MockWorkspaceGateway(persistence);
    await gateway.loadWorkspace();

    // Advance past main permission (step 6 -> step 7 -> approve -> step 8)
    gateway.stepScenario(DEMO_CONVERSATION_ID);
    gateway.stepScenario(DEMO_CONVERSATION_ID);
    await gateway.respondPermission({
      conversationId: DEMO_CONVERSATION_ID,
      requestId: 'perm_test_suite_1',
      decision: 'approved',
    });
    gateway.stepScenario(DEMO_CONVERSATION_ID);

    // Trigger dynamic permission from menu and deny it
    gateway.triggerPermissionScenario(DEMO_CONVERSATION_ID);
    const pending = gateway
      .getStateSnapshot()
      .conversations[DEMO_CONVERSATION_ID].permissions.find(
        (p) => p.status === 'pending',
      );
    expect(pending).toBeDefined();

    // Pending menu permission blocks both step and autoPlay
    expect(gateway.stepScenario(DEMO_CONVERSATION_ID).blocked).toBe(true);
    let stopReason: string | undefined;
    gateway.subscribeAutoPlayStop((r) => {
      stopReason = r;
    });
    expect(gateway.startAutoPlay(DEMO_CONVERSATION_ID, 50)).toBe(false);
    expect(stopReason).toBeTruthy();

    await gateway.respondPermission({
      conversationId: DEMO_CONVERSATION_ID,
      requestId: pending!.id,
      decision: 'denied',
    });

    // Denied menu permission must continue blocking Attempt #2 in both manual step and autoPlay
    const stepAfterDeny = gateway.stepScenario(DEMO_CONVERSATION_ID);
    expect(stepAfterDeny.blocked).toBe(true);
    expect(gateway.startAutoPlay(DEMO_CONVERSATION_ID, 50)).toBe(false);
    const conv =
      gateway.getStateSnapshot().conversations[DEMO_CONVERSATION_ID];
    expect(conv.conversation.executionStatus).toBe('blocked');
    expect(
      conv.tasks
        .find((t) => t.id === 'task_busca_nome')
        ?.attempts.some((a) => a.id === 'att_2'),
    ).toBe(false);

    gateway.dispose();
  });

  it('reconciles a persisted gap cleanly after a full gateway reload without requiring demo reset', async () => {
    const sharedDriver = new MemoryOnlyStorageDriver();
    const persistence1 = new WorkspacePersistenceManager(sharedDriver);
    const gateway1 = new MockWorkspaceGateway(persistence1);
    await gateway1.loadWorkspace();

    gateway1.triggerOutOfOrderGapScenario(DEMO_CONVERSATION_ID);
    await persistence1.flushSave();
    gateway1.dispose();

    // Simulate page reload with a fresh gateway and fresh persistence manager
    const persistence2 = new WorkspacePersistenceManager(sharedDriver);
    const gateway2 = new MockWorkspaceGateway(persistence2);
    await gateway2.loadWorkspace();

    const beforeReconcile =
      gateway2.getStateSnapshot().conversations[DEMO_CONVERSATION_ID];
    expect(beforeReconcile.conversation.syncState).toBe('gap_detected');

    const reconcileRes =
      await gateway2.reconcileConversation(DEMO_CONVERSATION_ID);
    expect(reconcileRes.synced).toBe(true);
    expect(reconcileRes.events?.length).toBeGreaterThanOrEqual(1);

    const afterReconcile =
      gateway2.getStateSnapshot().conversations[DEMO_CONVERSATION_ID];
    expect(afterReconcile.conversation.syncState).toBe('synced');
    expect(Object.keys(afterReconcile.pendingOutOfOrder)).toHaveLength(0);

    // Scenario advancement resumes cleanly after post-reload reconciliation
    const nextStep = gateway2.stepScenario(DEMO_CONVERSATION_ID);
    expect(nextStep.blocked).toBeFalsy();

    gateway2.dispose();
  });

  it('increments unreadCount on a background conversation even when that agent tab was previously open', async () => {
    const persistence = new WorkspacePersistenceManager(
      new MemoryOnlyStorageDriver(),
    );
    const gateway = new MockWorkspaceGateway(persistence);
    await gateway.loadWorkspace();

    // Open Claude tab in conversation A (clears initial unreadCount to 0)
    gateway.setActiveView({
      projectId: DEMO_PROJECT_ID,
      conversationId: DEMO_CONVERSATION_ID,
      tabId: 'part_claude',
    });
    expect(
      gateway
        .getStateSnapshot()
        .conversations[DEMO_CONVERSATION_ID].participants.find(
          (p) => p.id === 'part_claude',
        )?.unreadCount,
    ).toBe(0);

    // Switch active view to conversation B
    const convB = await gateway.createConversation({
      projectId: DEMO_PROJECT_ID,
      title: 'Conversa visível B',
    });
    expect(gateway.getStateSnapshot().activeConversationId).toBe(
      convB.conversation.id,
    );

    // Deliver a message to Claude in hidden conversation A
    await gateway.sendMessage({
      conversationId: DEMO_CONVERSATION_ID,
      targetTab: 'part_claude',
      bodyMarkdown: 'Atualização em conversa oculta',
    });

    const unreadInHiddenA = gateway
      .getStateSnapshot()
      .conversations[DEMO_CONVERSATION_ID].participants.find(
        (p) => p.id === 'part_claude',
      )?.unreadCount;
    expect(unreadInHiddenA).toBe(1);

    // Returning to conversation A on Claude tab marks it read again
    gateway.setActiveView({
      projectId: DEMO_PROJECT_ID,
      conversationId: DEMO_CONVERSATION_ID,
      tabId: 'part_claude',
    });
    expect(
      gateway
        .getStateSnapshot()
        .conversations[DEMO_CONVERSATION_ID].participants.find(
          (p) => p.id === 'part_claude',
        )?.unreadCount,
    ).toBe(0);

    gateway.dispose();
  });

  it('transitions persistence status to saved when a debounced write is drained by the active write loop before timer expiry', async () => {
    let savedSnapshots: WorkspaceStoreState[] = [];
    let callCount = 0;

    const controlledDriver: StorageDriver = {
      async load() {
        return null;
      },
      async save(state: WorkspaceStoreState) {
        callCount += 1;
        // Write #2 (state A) is slow (60ms); Write #3 (state B) is fast (10ms)
        const delay = callCount === 2 ? 60 : 10;
        await new Promise((resolve) => setTimeout(resolve, delay));
        savedSnapshots.push(structuredClone(state));
      },
      async clear() {
        savedSnapshots = [];
      },
    };

    const persistence = new WorkspacePersistenceManager(controlledDriver);
    const initial = await persistence.loadInitial(createInitialWorkspaceState);

    const stateA = structuredClone(initial);
    stateA.projects[0].name = 'Gravação A lenta';
    const stateB = structuredClone(initial);
    stateB.projects[0].name = 'Gravação B com debounce';

    // Start slow write A immediately
    persistence.scheduleSave(stateA, 0);
    await new Promise((resolve) => setTimeout(resolve, 15));

    // Schedule B with a 180ms debounce while A is still writing
    persistence.scheduleSave(stateB, 180);
    expect(persistence.getInfo().status).toBe('saving');

    // Wait 100ms: A finishes at ~60ms, loop drains B at ~70ms (BEFORE 180ms timer)
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(persistence.getInfo().status).toBe('saved');
    expect(savedSnapshots[savedSnapshots.length - 1].projects[0].name).toBe(
      'Gravação B com debounce',
    );

    // Let original 180ms window pass and confirm status stays saved cleanly
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(persistence.getInfo().status).toBe('saved');

    persistence.dispose();
  });

  it('rejects unsupported interrupt capability honestly and fails explicitly in AionCoreAdapterSkeleton', async () => {
    const persistence = new WorkspacePersistenceManager(
      new MemoryOnlyStorageDriver(),
    );
    const gateway = new MockWorkspaceGateway(persistence);
    await gateway.loadWorkspace();

    await expect(
      gateway.controlExecution({
        conversationId: DEMO_CONVERSATION_ID,
        action: 'request_interrupt',
        participantId: 'part_antigravity',
      }),
    ).rejects.toBeInstanceOf(GatewayCapabilityError);

    const coreSkeleton = new AionCoreAdapterSkeleton();
    await expect(coreSkeleton.loadWorkspace()).rejects.toMatchObject({
      code: 'NOT_CONNECTED_LOCAL_CORE',
    });

    gateway.dispose();
  });
});
