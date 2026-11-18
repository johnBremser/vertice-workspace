import { describe, expect, it } from 'vitest';
import {
  buildRoleInstructionPrompt,
  INTERNAL_PROTOCOL_VERSION,
  parseStructuredAgentOutput,
} from '../internalProtocol';
import { IncompatibleSchemaError, migrateWorkspaceState } from '../migration';
import {
  DEFAULT_CONNECTIONS,
  DEFAULT_TEAM_PRESETS,
  instantiateParticipantsFromPreset,
  makeDemoModelRef,
} from '../presets';
import { isPermissionStillBlocked, validateTaskInput } from '../taskRules';
import {
  checkAuditIndependence,
  sortParticipantsByTabOrder,
  validateTeamConfiguration,
} from '../teamValidation';
import type { PermissionRequest, Task, WorkspaceStoreState } from '../types';
import { DEMO_CONVERSATION_ID, DEMO_PROJECT_ID } from '../../services/demoScenario';
import {
  applyImportedWorkspaceBackup,
  buildWorkspaceJsonExport,
  parseAndValidateWorkspaceBackup,
} from '../../services/exportService';
import { GatewayCapabilityError } from '../../services/gateway';
import { MockWorkspaceGateway } from '../../services/mockGateway';
import { MemoryOnlyStorageDriver, WorkspacePersistenceManager } from '../../services/storage';

describe('V4 Domain, Migration, Configurable Teams, Protocol & Backup', () => {
  it('migrates schema v1 payloads to v2 preserving IDs and rejecting unsupported future versions', () => {
    const legacyV1 = {
      schemaVersion: 1,
      activeProjectId: 'proj_legacy',
      activeConversationId: 'conv_legacy',
      projects: [
        {
          id: 'proj_legacy',
          name: 'Projeto Legado',
          description: 'Teste v1',
          workspacePathInfo: 'C:/legacy',
          status: 'active',
          createdAt: '2026-11-01T10:00:00.000Z',
          updatedAt: '2026-11-01T10:00:00.000Z',
        },
      ],
      agentProfiles: [
        {
          id: 'agent_codex_demo',
          displayName: 'Codex Legado',
          vendorLabel: 'Codex',
          defaultRole: 'coordinator',
          capabilities: {
            supportsInterrupt: true,
            supportsMidRunContextInjection: true,
            supportsModelSwitchInSession: false,
            supportsPauseQueue: true,
            supportsSessionTerminate: true,
          },
          connection: {
            configured: true,
            executableStatus: 'simulated_found',
            authStatus: 'simulated',
            sessionStatus: 'active',
            isSimulated: true,
          },
          supportedTiers: ['fast', 'review', 'advanced'],
          isSimulated: true,
        },
      ],
      modelPolicy: {
        defaultExecutorTier: 'fast',
        reviewerTier: 'review',
        escalationTargetTier: 'advanced',
        qualityRejectionsBeforeSuggest: 2,
        approvalMode: 'manual',
      },
      conversations: {
        conv_legacy: {
          conversation: {
            id: 'conv_legacy',
            projectId: 'proj_legacy',
            title: 'Conversa v1',
            status: 'active',
            executionStatus: 'idle',
            coordinatorParticipantId: 'part_custom_1',
            syncState: 'synced',
            lastAppliedSeq: 2,
            scenarioStepIndex: 4,
            createdAt: '2026-11-01T10:00:00.000Z',
            updatedAt: '2026-11-01T10:00:00.000Z',
          },
          participants: [
            {
              id: 'part_custom_1',
              conversationId: 'conv_legacy',
              agentProfileId: 'agent_codex_demo',
              displayName: 'Codex',
              role: 'coordinator',
              modelTier: 'review',
              status: 'idle',
              unreadCount: 0,
              isSimulated: true,
            },
          ],
          messagesByTab: { general: [], part_custom_1: [] },
          generalFeed: [],
          tasks: [],
          contextRevisions: [],
          permissions: [],
          escalations: [],
          coordinatorHistory: [],
          seenEventIds: [],
          pendingOutOfOrder: {},
          eventLog: [],
        },
      },
      simulatedHeldBackEvents: { conv_legacy: [] },
    };

    const migrated = migrateWorkspaceState(legacyV1);
    expect(migrated.schemaVersion).toBe(2);
    expect(migrated.executionMode).toBe('demo');
    expect(migrated.conversations.conv_legacy.participants[0].id).toBe('part_custom_1');
    expect(migrated.conversations.conv_legacy.participants[0].connectionId).toBe('conn_codex_demo');
    expect(migrated.conversations.conv_legacy.participants[0].sessionRef.id).toBeTruthy();
    expect(migrated.teamPresets.some((p) => p.id === 'preset_terra_sol_gemini')).toBe(true);
    expect(migrated.simulatedHeldBackEvents?.conv_legacy).toEqual([]);

    expect(() =>
      migrateWorkspaceState({ schemaVersion: 99, projects: [], conversations: {} }),
    ).toThrow(IncompatibleSchemaError);
  });

  it('validates teams (0/2 coordinators, duplicate sessions, 2 Codex + 1 Antigravity without Claude) and audit independence', () => {
    const presetCombined = DEFAULT_TEAM_PRESETS.find(
      (p) => p.id === 'preset_terra_sol_gemini',
    )!;
    let counter = 0;
    const gen = (prefix: string) => {
      counter += 1;
      return `${prefix}_${counter}`;
    };

    const terraSolGemini = instantiateParticipantsFromPreset({
      preset: presetCombined,
      conversationId: 'conv_tsg',
      idGenerator: gen,
      isSimulated: true,
    });
    expect(terraSolGemini.some((p) => p.connectionId.includes('claude'))).toBe(false);

    const validCombined = validateTeamConfiguration(terraSolGemini, DEFAULT_CONNECTIONS);
    expect(validCombined.valid).toBe(true);
    expect(
      validCombined.warnings.some((w) => w.includes('auditoria independente')),
    ).toBe(true);

    const solParticipant = terraSolGemini.find((p) => p.displayName.includes('Sol'))!;
    const geminiParticipant = terraSolGemini.find((p) =>
      p.displayName.includes('Gemini'),
    )!;
    const combinedAudit = checkAuditIndependence(terraSolGemini, {
      assigneeParticipantId: geminiParticipant.id,
      reviewerParticipantId: solParticipant.id,
    });
    expect(combinedAudit.independent).toBe(false);

    // Split preset: Sol Planejador and Sol Auditor in distinct Codex sessions
    const presetSplit = DEFAULT_TEAM_PRESETS.find(
      (p) => p.id === 'preset_terra_sol_split_gemini',
    )!;
    const splitTeam = instantiateParticipantsFromPreset({
      preset: presetSplit,
      conversationId: 'conv_split',
      idGenerator: gen,
      isSimulated: true,
    });
    const splitValid = validateTeamConfiguration(splitTeam, DEFAULT_CONNECTIONS);
    expect(splitValid.valid).toBe(true);
    const splitExecutor = splitTeam.find((p) => p.roles.includes('executor'))!;
    const splitReviewer = splitTeam.find((p) => p.roles.includes('reviewer'))!;
    const independentAudit = checkAuditIndependence(splitTeam, {
      assigneeParticipantId: splitExecutor.id,
      reviewerParticipantId: splitReviewer.id,
    });
    expect(independentAudit.independent).toBe(true);

    // 0 coordinators -> error
    const noCoord = terraSolGemini.map((p) => ({
      ...p,
      role: 'executor' as const,
      roles: ['executor' as const],
    }));
    expect(validateTeamConfiguration(noCoord, DEFAULT_CONNECTIONS).valid).toBe(false);

    // 2 coordinators -> error
    const twoCoords = terraSolGemini.map((p, idx) =>
      idx < 2 ? { ...p, role: 'coordinator' as const, roles: ['coordinator' as const] } : p,
    );
    expect(validateTeamConfiguration(twoCoords, DEFAULT_CONNECTIONS).valid).toBe(false);

    // Duplicate session -> error
    const dupSession = terraSolGemini.map((p) => ({
      ...p,
      sessionRef: { ...terraSolGemini[0].sessionRef },
    }));
    expect(validateTeamConfiguration(dupSession, DEFAULT_CONNECTIONS).valid).toBe(false);
  });

  it('runs config-driven collaboration on a new Terra 6.1 / Sol 6.1 / Gemini Hydrogen conversation without Claude', async () => {
    const persistence = new WorkspacePersistenceManager(new MemoryOnlyStorageDriver());
    const gateway = new MockWorkspaceGateway(persistence);
    await gateway.loadWorkspace();

    const conv = await gateway.createConversation({
      projectId: DEMO_PROJECT_ID,
      title: 'Pipeline Terra/Sol/Gemini',
      presetId: 'preset_terra_sol_gemini',
    });

    expect(conv.participants.some((p) => p.id === 'part_claude')).toBe(false);
    expect(conv.participants.map((p) => p.displayName)).toEqual([
      'Terra 6.1',
      'Sol 6.1',
      'Gemini Hydrogen',
    ]);

    // Step through full scenario with manual approvals
    for (let i = 0; i < 20; i += 1) {
      const res = gateway.stepScenario(conv.conversation.id);
      if (res.blocked) {
        const snap = gateway.getStateSnapshot().conversations[conv.conversation.id];
        const pendingPerm = snap.permissions.find((p) => p.status === 'pending');
        if (pendingPerm) {
          await gateway.respondPermission({
            conversationId: conv.conversation.id,
            requestId: pendingPerm.id,
            decision: 'approved',
          });
          continue;
        }
        const pendingEsc = snap.escalations.find((e) => e.status === 'suggested');
        if (pendingEsc) {
          await gateway.resolveEscalation({
            conversationId: conv.conversation.id,
            escalationId: pendingEsc.id,
            resolution: 'approved',
          });
          continue;
        }
      }
      if (res.finished) break;
    }

    const finalConv = gateway.getStateSnapshot().conversations[conv.conversation.id];
    expect(finalConv.conversation.executionStatus).toBe('completed');
    expect(finalConv.tasks.length).toBeGreaterThanOrEqual(2);
    expect(finalConv.tasks.every((t) => t.status === 'completed')).toBe(true);
    expect(finalConv.tasks[0].reviews[0]?.independentReview).toBe(false);

    // Reorder tabs & verify sortParticipantsByTabOrder
    const reversedIds = [...finalConv.participants].reverse().map((p) => p.id);
    await gateway.reorderParticipantTabs(conv.conversation.id, reversedIds);
    const reordered = sortParticipantsByTabOrder(
      gateway.getStateSnapshot().conversations[conv.conversation.id].participants,
    );
    expect(reordered.map((p) => p.id)).toEqual(reversedIds);

    gateway.dispose();
  });

  it('rejects dependency cycles and supports task creation/update + plan revision + preserving aion_core work on resetDemo', async () => {
    const persistence = new WorkspacePersistenceManager(new MemoryOnlyStorageDriver());
    const gateway = new MockWorkspaceGateway(persistence);
    await gateway.loadWorkspace();

    const conv = await gateway.createConversation({
      projectId: DEMO_PROJECT_ID,
      title: 'Tarefas & Dependências',
      presetId: 'preset_terra_sol_split_gemini',
    });

    const executor = conv.participants.find((p) => p.roles.includes('executor'))!;
    const reviewer = conv.participants.find((p) => p.roles.includes('reviewer'))!;

    const t1 = await gateway.createTask({
      conversationId: conv.conversation.id,
      title: 'Tarefa A',
      description: 'Base',
      assigneeParticipantId: executor.id,
      reviewerParticipantId: reviewer.id,
      dependencyTaskIds: [],
      acceptanceCriteria: ['Critério A'],
    });
    const t2 = await gateway.createTask({
      conversationId: conv.conversation.id,
      title: 'Tarefa B',
      description: 'Depende de A',
      assigneeParticipantId: executor.id,
      reviewerParticipantId: reviewer.id,
      dependencyTaskIds: [t1.id],
      acceptanceCriteria: ['Critério B'],
    });

    await expect(
      gateway.updateTask({
        conversationId: conv.conversation.id,
        taskId: t1.id,
        title: 'Tarefa A',
        description: 'Ciclo proibido',
        assigneeParticipantId: executor.id,
        reviewerParticipantId: reviewer.id,
        dependencyTaskIds: [t2.id],
        acceptanceCriteria: ['Critério A'],
      }),
    ).rejects.toBeInstanceOf(GatewayCapabilityError);

    const cycleCheck = validateTaskInput({
      taskId: t1.id,
      title: 'Tarefa A',
      assigneeParticipantId: executor.id,
      dependencyTaskIds: [t2.id],
      acceptanceCriteria: ['Critério A'],
      existingTasks: gateway.getStateSnapshot().conversations[conv.conversation.id].tasks,
      participants: conv.participants,
    });
    expect(cycleCheck.valid).toBe(false);

    const plan = await gateway.publishPlanRevision({
      conversationId: conv.conversation.id,
      summary: 'Plano revisado manualmente',
    });
    expect(plan.versionNumber).toBe(1);

    // Simulate an imported/stored aion_core project + conversation; resetDemo() must preserve it!
    const snapshot = structuredClone(gateway.getStateSnapshot());
    snapshot.projects.push({
      id: 'proj_core_keep',
      name: 'Projeto Core Preservado',
      description: 'Real',
      workspacePathInfo: 'C:/core',
      executionMode: 'aion_core',
      status: 'active',
      createdAt: '2026-11-16T10:00:00.000Z',
      updatedAt: '2026-11-16T10:00:00.000Z',
    });
    snapshot.conversations.conv_core_keep = {
      ...structuredClone(snapshot.conversations[DEMO_CONVERSATION_ID]),
      conversation: {
        ...snapshot.conversations[DEMO_CONVERSATION_ID].conversation,
        id: 'conv_core_keep',
        projectId: 'proj_core_keep',
        title: 'Conversa Core Real',
        executionMode: 'aion_core',
        externalTeamId: 'team_real_1',
      },
    };
    await gateway.importWorkspaceState(snapshot);
    await gateway.resetDemo();

    const afterReset = gateway.getStateSnapshot();
    expect(afterReset.projects.some((p) => p.id === 'proj_core_keep')).toBe(true);
    expect(afterReset.conversations.conv_core_keep).toBeDefined();

    gateway.dispose();
  });

  it('enforces strict permission blocking by actionKey + scopeKey + supersedesRequestId', () => {
    const deniedReq: PermissionRequest = {
      id: 'perm_denied_1',
      conversationId: 'conv_1',
      participantId: 'part_exec',
      taskId: 'task_1',
      actionKey: 'run_tests',
      scopeKey: 'workspace',
      actionTitle: 'Executar testes',
      commandSimulated: 'npm test',
      scopeDescription: 'Workspace',
      status: 'denied',
      createdAt: '2026-11-16T10:00:00.000Z',
      sourceEventId: 'evt_1',
      isSimulated: true,
    };

    const unrelatedApproval: PermissionRequest = {
      id: 'perm_other_approved',
      conversationId: 'conv_1',
      participantId: 'part_exec',
      taskId: 'task_1',
      actionKey: 'read_docs',
      scopeKey: 'docs',
      actionTitle: 'Ler docs',
      commandSimulated: 'cat README.md',
      scopeDescription: 'Docs',
      status: 'approved',
      createdAt: '2026-11-16T10:01:00.000Z',
      sourceEventId: 'evt_2',
      isSimulated: true,
    };

    // Unrelated approval MUST NOT clear previous denial
    expect(isPermissionStillBlocked([deniedReq, unrelatedApproval]).blocked).toBe(true);

    // Matching actionKey + scopeKey supersedes denial
    const equivalentApproval: PermissionRequest = {
      ...unrelatedApproval,
      id: 'perm_equiv_approved',
      actionKey: 'run_tests',
      scopeKey: 'workspace',
    };
    expect(isPermissionStillBlocked([deniedReq, equivalentApproval]).blocked).toBe(false);

    // Explicit supersedesRequestId supersedes denial
    const explicitSupersede: PermissionRequest = {
      ...unrelatedApproval,
      id: 'perm_supersede',
      supersedesRequestId: 'perm_denied_1',
    };
    expect(isPermissionStillBlocked([deniedReq, explicitSupersede]).blocked).toBe(false);
  });

  it('parses internal aion-desk/v1 blocks and falls back safely on incomplete or invalid outputs', () => {
    const prompt = buildRoleInstructionPrompt({
      roleLabel: 'Executor',
      participantName: 'Gemini Hydrogen',
      customInstructions: 'Seguir padrão.',
      expectedKind: 'delivery_report',
      conversationId: 'conv_1',
      taskId: 'task_1',
      attemptId: 'att_1',
    });
    expect(prompt).toContain(INTERNAL_PROTOCOL_VERSION);

    const validOut = parseStructuredAgentOutput(
      `Entrega concluída.\n\`\`\`aion-desk-json\n${JSON.stringify({
        kind: 'delivery_report',
        protocol: INTERNAL_PROTOCOL_VERSION,
        conversationId: 'conv_1',
        taskId: 'task_1',
        deliverySummary: 'OK',
        evidenceNotes: ['npm test ok'],
      })}\n\`\`\``,
      'delivery_report',
    );
    expect(validOut.valid).toBe(true);
    expect(validOut.parseStatus).toBe('valid');

    const freeText = parseStructuredAgentOutput('Texto livre sem bloco', 'delivery_report');
    expect(freeText.valid).toBe(false);
    expect(freeText.parseStatus).toBe('incomplete');
    expect(freeText.requiresManualReview).toBe(true);

    const badJson = parseStructuredAgentOutput(
      '```aion-desk-json\n{ quebrado }\n```',
      'delivery_report',
    );
    expect(badJson.valid).toBe(false);
    expect(badJson.parseStatus).toBe('invalid');
  });

  it('validates backup JSON exports/imports cleanly without credentials or mutating state on errors', async () => {
    const persistence = new WorkspacePersistenceManager(new MemoryOnlyStorageDriver());
    const gateway = new MockWorkspaceGateway(persistence);
    const initial = await gateway.loadWorkspace();

    const snapshotWithSensitiveConnection: WorkspaceStoreState = {
      ...structuredClone(initial),
      connections: initial.connections.map((c, idx) =>
        idx === 0
          ? {
              ...c,
              mode: 'aion_core',
              authStatus: 'authenticated',
              sessionStatus: 'active',
              coreReachability: 'reachable',
            }
          : c,
      ),
    };

    const jsonText = buildWorkspaceJsonExport(snapshotWithSensitiveConnection);
    expect(jsonText).toContain('"exportSchemaVersion": "2.0.0"');
    expect(jsonText).not.toContain('aionui-csrf-token');
    expect(jsonText).not.toContain('Bearer ');

    const parsedExport = JSON.parse(jsonText) as {
      connections: { mode: string; authStatus: string; sessionStatus: string }[];
    };
    expect(parsedExport.connections[0].authStatus).toBe('unknown');
    expect(parsedExport.connections[0].sessionStatus).toBe('inactive');

    // Malformed & future version rejection
    expect(parseAndValidateWorkspaceBackup('{invalid').valid).toBe(false);
    expect(
      parseAndValidateWorkspaceBackup(
        JSON.stringify({ schemaVersion: 99, projects: [], conversations: [] }),
      ).valid,
    ).toBe(false);

    // Valid import as copy remaps IDs cleanly without colliding
    const validated = parseAndValidateWorkspaceBackup(jsonText);
    expect(validated.valid).toBe(true);
    if (validated.valid) {
      const copied = applyImportedWorkspaceBackup(
        initial,
        validated.migratedState,
        'copy',
      );
      expect(copied.projects.length).toBe(2);
      expect(Object.keys(copied.conversations).length).toBe(2);
      expect(makeDemoModelRef('fast').confirmation).toBe('simulated');
    }

    gateway.dispose();
  });

  it('keeps contiguous seq without gaps when sending an initial General message on a new Terra/Sol/Gemini conversation before stepping forward (Fix 1)', async () => {
    const persistence = new WorkspacePersistenceManager(new MemoryOnlyStorageDriver());
    const gateway = new MockWorkspaceGateway(persistence);
    await gateway.loadWorkspace();

    const conv = await gateway.createConversation({
      projectId: DEMO_PROJECT_ID,
      title: 'Nova conversa sem lacuna',
      presetId: 'preset_terra_sol_gemini',
    });
    expect(conv.conversation.lastAppliedSeq).toBe(0);

    await gateway.sendMessage({
      conversationId: conv.conversation.id,
      targetTab: 'general',
      bodyMarkdown: 'Iniciar plano completo da nova conversa',
    });

    const afterSend = gateway.getStateSnapshot().conversations[conv.conversation.id];
    expect(afterSend.conversation.syncState).toBe('synced');
    expect(afterSend.conversation.lastAppliedSeq).toBe(2);
    expect(Object.keys(afterSend.pendingOutOfOrder)).toHaveLength(0);

    const stepOut = gateway.stepScenario(conv.conversation.id);
    expect(Boolean(stepOut.blocked)).toBe(false);
    expect(stepOut.finished).toBe(false);

    const afterStep = gateway.getStateSnapshot().conversations[conv.conversation.id];
    expect(afterStep.conversation.syncState).toBe('synced');
    expect(afterStep.conversation.lastAppliedSeq).toBe(3);
    expect(Object.keys(afterStep.pendingOutOfOrder)).toHaveLength(0);
    expect(afterStep.conversation.scenarioStepIndex).toBe(2);
    // Strict contiguous sequence audit across eventLog
    const seqs = afterStep.eventLog.map((e) => e.seq);
    expect(seqs).toEqual([1, 2, 3]);

    gateway.dispose();
  });

  it('processes 3+ tasks (chained dependencies & parallel tasks, custom IDs) without premature completion and blocks false completion on rejections/failures (Fix 2)', async () => {
    const persistence = new WorkspacePersistenceManager(new MemoryOnlyStorageDriver());
    const gateway = new MockWorkspaceGateway(persistence);
    await gateway.loadWorkspace();

    const conv = await gateway.createConversation({
      projectId: DEMO_PROJECT_ID,
      title: 'Três+ tarefas encadeadas e paralelas',
      presetId: 'preset_terra_sol_split_gemini',
    });
    const executor = conv.participants.find((p) => p.roles.includes('executor'))!;
    const reviewer = conv.participants.find((p) => p.roles.includes('reviewer'))!;

    const taskAlpha = await gateway.createTask({
      conversationId: conv.conversation.id,
      title: 'Alpha base',
      description: 'Primeira entrega base',
      assigneeParticipantId: executor.id,
      reviewerParticipantId: reviewer.id,
      dependencyTaskIds: [],
      acceptanceCriteria: ['Alpha pronta'],
    });
    const taskBeta = await gateway.createTask({
      conversationId: conv.conversation.id,
      title: 'Beta paralela',
      description: 'Entrega paralela independente',
      assigneeParticipantId: executor.id,
      reviewerParticipantId: reviewer.id,
      dependencyTaskIds: [],
      acceptanceCriteria: ['Beta pronta'],
    });
    const taskGamma = await gateway.createTask({
      conversationId: conv.conversation.id,
      title: 'Gamma dependente',
      description: 'Depende de Alpha e Beta',
      assigneeParticipantId: executor.id,
      reviewerParticipantId: reviewer.id,
      dependencyTaskIds: [taskAlpha.id, taskBeta.id],
      acceptanceCriteria: ['Gamma pronta'],
    });
    const taskDelta = await gateway.createTask({
      conversationId: conv.conversation.id,
      title: 'Delta final',
      description: 'Depende de Gamma',
      assigneeParticipantId: executor.id,
      reviewerParticipantId: reviewer.id,
      dependencyTaskIds: [taskGamma.id],
      acceptanceCriteria: ['Delta pronta'],
    });

    // Step through entire flow approving permissions/escalations cleanly
    let finishedFlag = false;
    for (let i = 0; i < 40; i += 1) {
      const snapBefore = gateway.getStateSnapshot().conversations[conv.conversation.id];
      const hasUnfinished = snapBefore.tasks.some(
        (t) => t.status !== 'completed' && t.status !== 'cancelled',
      );
      const stepRes = gateway.stepScenario(conv.conversation.id);
      if (stepRes.finished && hasUnfinished) {
        const snapAfter = gateway.getStateSnapshot().conversations[conv.conversation.id];
        const stillUnfinished = snapAfter.tasks.some(
          (t) => t.status !== 'completed' && t.status !== 'cancelled',
        );
        expect(stillUnfinished).toBe(false);
      }

      if (stepRes.blocked) {
        const snap = gateway.getStateSnapshot().conversations[conv.conversation.id];
        const pendingPerm = snap.permissions.find((p) => p.status === 'pending');
        if (pendingPerm) {
          await gateway.respondPermission({
            conversationId: conv.conversation.id,
            requestId: pendingPerm.id,
            decision: 'approved',
          });
          continue;
        }
        const pendingEsc = snap.escalations.find((e) => e.status === 'suggested');
        if (pendingEsc) {
          await gateway.resolveEscalation({
            conversationId: conv.conversation.id,
            escalationId: pendingEsc.id,
            resolution: 'approved',
          });
          continue;
        }
      }
      if (stepRes.finished) {
        finishedFlag = true;
        break;
      }
    }

    expect(finishedFlag).toBe(true);
    const finalConv = gateway.getStateSnapshot().conversations[conv.conversation.id];
    expect(finalConv.conversation.executionStatus).toBe('completed');
    expect(finalConv.tasks.length).toBeGreaterThanOrEqual(4);
    expect(finalConv.tasks.every((t) => t.status === 'completed')).toBe(true);
    expect(finalConv.tasks.find((t) => t.id === taskAlpha.id)?.status).toBe('completed');
    expect(finalConv.tasks.find((t) => t.id === taskBeta.id)?.status).toBe('completed');
    expect(finalConv.tasks.find((t) => t.id === taskGamma.id)?.status).toBe('completed');
    expect(finalConv.tasks.find((t) => t.id === taskDelta.id)?.status).toBe('completed');

    // Negative check: denied permission blocks execution and NEVER finishes
    const convDenied = await gateway.createConversation({
      projectId: DEMO_PROJECT_ID,
      title: 'Permissão recusada não conclui',
      presetId: 'preset_terra_sol_gemini',
    });
    for (let i = 0; i < 12; i += 1) {
      const r = gateway.stepScenario(convDenied.conversation.id);
      const snap = gateway.getStateSnapshot().conversations[convDenied.conversation.id];
      const perm = snap.permissions.find((p) => p.status === 'pending');
      if (perm) {
        await gateway.respondPermission({
          conversationId: convDenied.conversation.id,
          requestId: perm.id,
          decision: 'denied',
        });
        const nextStep = gateway.stepScenario(convDenied.conversation.id);
        expect(nextStep.blocked).toBe(true);
        expect(nextStep.finished).toBe(false);
        const afterDenied = gateway.getStateSnapshot().conversations[convDenied.conversation.id];
        expect(afterDenied.conversation.executionStatus).not.toBe('completed');
        break;
      }
      expect(r.finished).toBe(false);
    }

    gateway.dispose();
  });

  it('detaches live Core external bindings on backup import (copy & replace), preserves historical provenance, never assumes login or auto-starts execution (V6-06)', async () => {
    const persistence = new WorkspacePersistenceManager(new MemoryOnlyStorageDriver());
    const gateway = new MockWorkspaceGateway(persistence);
    const initial = await gateway.loadWorkspace();
    const convId = Object.keys(initial.conversations)[0];
    const baseProj = initial.conversations[convId];

    const coreRichState: WorkspaceStoreState = {
      ...structuredClone(initial),
      executionMode: 'aion_core',
      coreSessionAuthenticated: true,
      connections: initial.connections.map((c, idx) =>
        idx === 0
          ? {
              ...c,
              mode: 'aion_core',
              coreAgentId: 'agent_remote_1',
              coreAssistantId: 'asst_remote_1',
              authStatus: 'authenticated',
              coreAgentStatus: 'online',
              sessionStatus: 'active',
              coreReachability: 'reachable',
              catalogLoaded: true,
            }
          : c,
      ),
      conversations: {
        [convId]: {
          ...structuredClone(baseProj),
          conversation: {
            ...baseProj.conversation,
            executionMode: 'aion_core',
            executionStatus: 'running',
            autoPlayWasRunning: true,
            externalTeamId: 'team_remote_env_123',
          },
          participants: baseProj.participants.map((p, idx) => ({
            ...p,
            status: idx === 0 ? 'running' : 'idle',
            sessionRef: {
              ...p.sessionRef,
              externalTeamId: 'team_remote_env_123',
              externalSlotId: `slot_remote_${idx}`,
              externalConversationId: `ext_conv_remote_${idx}`,
              nativeSessionId: `cli_sess_remote_${idx}`,
              status: 'active',
            },
          })),
          contextRevisions: [
            {
              id: 'ctx_backup_v1',
              conversationId: convId,
              versionNumber: 1,
              authorLabel: 'Você',
              createdAt: '2026-11-18T10:00:00.000Z',
              summaryOfChange: 'Contexto real exportado',
              objective: 'Validar backup V6-06',
              permanentInstructions: ['Sem credenciais'],
              constraints: [],
              acceptanceCriteria: ['Desvincular referências externas'],
              confirmedDecisions: [],
              receipts: {
                [baseProj.participants[0].id]: {
                  participantId: baseProj.participants[0].id,
                  revisionId: 'ctx_backup_v1',
                  status: 'applied',
                  policyApplied: 'next_turn',
                  updatedAt: '2026-11-18T10:01:00.000Z',
                  mechanismNote: 'Aplicado na Tentativa #1.',
                },
              },
            },
          ],
        },
      },
    };

    const jsonText = buildWorkspaceJsonExport(coreRichState);
    expect(jsonText).not.toContain('coreSessionAuthenticated');
    expect(jsonText).not.toContain('aionui-session');
    expect(jsonText).not.toContain('aionui-csrf-token');

    const validation = parseAndValidateWorkspaceBackup(jsonText);
    expect(validation.valid).toBe(true);
    if (!validation.valid) return;

    expect(validation.preview.externalTeamRefsCount).toBe(1);
    expect(validation.preview.externalSessionRefsCount).toBe(baseProj.participants.length);

    // 1. Replace mode: detaches live Core refs, clears login & Core connection bindings, pauses execution
    const replaced = applyImportedWorkspaceBackup(initial, validation.migratedState, 'replace');
    expect(replaced.coreSessionAuthenticated).toBe(false);
    expect(replaced.connections[0].authStatus).toBe('unknown');
    expect(replaced.connections[0].catalogLoaded).toBe(false);
    expect(replaced.connections[0].coreAgentId).toBeUndefined();
    expect(replaced.connections[0].coreAssistantId).toBeUndefined();
    expect(replaced.connections[0].sessionStatus).toBe('inactive');

    const repConv = replaced.conversations[convId];
    expect(repConv.conversation.executionStatus).toBe('paused_queue');
    expect(repConv.conversation.autoPlayWasRunning).toBe(false);
    expect(repConv.conversation.externalTeamId).toBeUndefined();
    expect(repConv.conversation.importedExternalTeamId).toBe('team_remote_env_123');
    expect(repConv.participants[0].status).toBe('idle');
    expect(repConv.participants[0].sessionRef.externalTeamId).toBeUndefined();
    expect(repConv.participants[0].sessionRef.externalSlotId).toBeUndefined();
    expect(repConv.participants[0].sessionRef.externalConversationId).toBeUndefined();
    expect(repConv.participants[0].sessionRef.nativeSessionId).toBeUndefined();
    expect(repConv.participants[0].sessionRef.status).toBe('inactive');
    expect(repConv.participants[0].sessionRef.importedExternalRef).toEqual({
      externalTeamId: 'team_remote_env_123',
      externalSlotId: 'slot_remote_0',
      externalConversationId: 'ext_conv_remote_0',
      nativeSessionId: 'cli_sess_remote_0',
    });
    expect(repConv.contextRevisions).toHaveLength(1);
    expect(repConv.contextRevisions[0].receipts[repConv.participants[0].id]?.status).toBe('applied');

    // 2. Copy mode: remaps IDs, detaches live Core refs so two conversations never share a live Core team/slot
    const copied = applyImportedWorkspaceBackup(coreRichState, validation.migratedState, 'copy');
    const copiedConvIds = Object.keys(copied.conversations).filter((id) => id !== convId);
    expect(copiedConvIds).toHaveLength(1);
    const copiedProj = copied.conversations[copiedConvIds[0]];
    expect(copiedProj.conversation.executionStatus).toBe('paused_queue');
    expect(copiedProj.conversation.externalTeamId).toBeUndefined();
    expect(copiedProj.conversation.importedExternalTeamId).toBe('team_remote_env_123');
    expect(copiedProj.participants[0].sessionRef.externalSlotId).toBeUndefined();
    expect(copiedProj.participants[0].sessionRef.importedExternalRef?.externalSlotId).toBe('slot_remote_0');
    expect(copiedProj.participants[0].sessionRef.status).toBe('inactive');
    // Original conversation kept untouched
    expect(copied.conversations[convId].conversation.externalTeamId).toBe('team_remote_env_123');

    gateway.dispose();
  });
});
