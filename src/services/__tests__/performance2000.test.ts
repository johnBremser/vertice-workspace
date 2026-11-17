import { describe, expect, it } from 'vitest';
import { ingestEvent } from '../../domain/reducer';
import type { ExecutionEvent } from '../../domain/types';
import { createInitialWorkspaceState, DEMO_CONVERSATION_ID } from '../demoScenario';
import { MockWorkspaceGateway } from '../mockGateway';
import {
  MemoryOnlyStorageDriver,
  WorkspacePersistenceManager,
} from '../storage';

describe('Performance benchmark: 2,000 events incremental ingestion', () => {
  it('ingests 2,000 sequential events on hidden and active tabs incrementally without loss and preserves bounded pagination', async () => {
    const baseState = createInitialWorkspaceState();
    const initialProj = baseState.conversations[DEMO_CONVERSATION_ID];
    const startSeq = initialProj.conversation.lastAppliedSeq;
    const executorId =
      initialProj.participants.find((p) => p.roles.includes('executor'))?.id ??
      initialProj.participants[0].id;

    // Generate 1,000 events with 'general' active (tab hidden) + 1,000 events with executor tab active
    const events: ExecutionEvent[] = [];
    for (let i = 1; i <= 2000; i += 1) {
      const seq = startSeq + i;
      events.push({
        id: `evt_bench_${seq}`,
        seq,
        conversationId: DEMO_CONVERSATION_ID,
        timestamp: '2026-11-16T12:00:00.000Z',
        origin: 'executor',
        originSource: 'demo_simulation',
        participantId: executorId,
        type: 'agent_message_posted',
        payload: {
          messageId: `msg_bench_${seq}`,
          targetTab: executorId,
          authorLabel: 'Executor Bench',
          bodyMarkdown: `Evento incremental #${seq}`,
          projectToGeneral: i % 10 === 0,
          generalKind: 'task_progress',
          generalSummary: i % 10 === 0 ? `Progresso #${seq}` : undefined,
        },
      });
    }

    let projection = initialProj;
    const t0 = performance.now();
    for (let i = 0; i < events.length; i += 1) {
      const openTab = i < 1000 ? 'general' : executorId;
      projection = ingestEvent(projection, events[i], openTab).projection;
    }
    const elapsedMs = performance.now() - t0;

    expect(projection.conversation.lastAppliedSeq).toBe(startSeq + 2000);
    expect(Object.keys(projection.pendingOutOfOrder)).toHaveLength(0);
    expect(projection.eventLog.length).toBeGreaterThanOrEqual(2000);
    expect(projection.messagesByTab[executorId].length).toBeGreaterThanOrEqual(2000);
    expect(elapsedMs).toBeLessThan(2000);

    // Also verify gateway pagination bounds when stress-loading 2,000 events
    const persistence = new WorkspacePersistenceManager(new MemoryOnlyStorageDriver());
    const gateway = new MockWorkspaceGateway(persistence);
    await gateway.loadWorkspace();
    const count = gateway.triggerStress2000Scenario(DEMO_CONVERSATION_ID);
    expect(count).toBe(2000);

    const execTabId =
      gateway
        .getStateSnapshot()
        .conversations[DEMO_CONVERSATION_ID].participants.find((p) =>
          p.roles.includes('executor'),
        )?.id ?? 'part_claude';

    const page = await gateway.getPaginatedEvents(
      DEMO_CONVERSATION_ID,
      execTabId,
      40,
    );
    expect(page.total).toBeGreaterThanOrEqual(2000);
    expect(page.hasMore).toBe(true);

    gateway.dispose();
  });
});
