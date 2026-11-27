import { describe, expect, it } from 'vitest';
import {
  buildRoleInstructionPrompt,
  INTERNAL_PROTOCOL_VERSION,
  parseStructuredAgentOutput,
} from '../internalProtocol';
import { IncompatibleSchemaError, migrateWorkspaceState } from '../migration';
import {
  DEFAULT_TEAM_PRESETS,
  instantiateParticipantsFromPreset,
  makeDemoModelRef,
} from '../presets';
import {
  classifyToolPermissionKind,
  hasBlockingDenialForAutoApproval,
  isPermissionStillBlocked,
  shouldAutoApprovePermission,
  validateTaskInput,
} from '../taskRules';
import {
  checkAuditIndependence,
  sortParticipantsByTabOrder,
  validateTeamConfiguration,
} from '../teamValidation';
import type {
  ConnectionAdapterConfig,
  PermissionRequest,
  Task,
  WorkspaceStoreState,
} from '../types';
import { AionCoreAdapter } from '../../services/aionCoreAdapter';
import {
  applyImportedWorkspaceBackup,
  buildWorkspaceJsonExport,
  parseAndValidateWorkspaceBackup,
} from '../../services/exportService';
import { GatewayCapabilityError } from '../../services/gateway';
import {
  MemoryOnlyStorageDriver,
  sanitizeLoadedStateAfterReload,
  WorkspacePersistenceManager,
} from '../../services/storage';

const SAMPLE_CORE_CONNECTION: ConnectionAdapterConfig = {
  id: 'conn_core_codex_1',
  displayName: 'Codex CLI (AionCore)',
  vendorLabel: 'AionCore · codex',
  mode: 'aion_core',
  backendId: 'codex',
  coreAgentId: 'agent_remote_1',
  coreAssistantId: 'asst_remote_1',
  configured: true,
  coreReachability: 'reachable',
  catalogLoaded: true,
  executableStatus: 'verified',
  coreAgentStatus: 'online',
  authStatus: 'authenticated',
  sessionStatus: 'active',
  availableModels: [
    { externalId: 'gpt-5.6-luna', displayName: 'GPT-5.6-Luna', source: 'core_catalog', confirmed: true },
  ],
  capabilities: {
    supportsInterrupt: true,
    supportsMidRunContextInjection: false,
    supportsModelSwitchInSession: true,
    supportsPauseQueue: true,
    supportsSessionTerminate: false,
  },
  isSimulated: false,
};

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
      isSimulated: false,
    }).map((p) => ({ ...p, connectionId: SAMPLE_CORE_CONNECTION.id }));
    expect(terraSolGemini.some((p) => p.connectionId.includes('claude'))).toBe(false);

    const validCombined = validateTeamConfiguration(terraSolGemini, [SAMPLE_CORE_CONNECTION]);
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
      isSimulated: false,
    }).map((p) => ({ ...p, connectionId: SAMPLE_CORE_CONNECTION.id }));
    const splitValid = validateTeamConfiguration(splitTeam, [SAMPLE_CORE_CONNECTION]);
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
    expect(validateTeamConfiguration(noCoord, [SAMPLE_CORE_CONNECTION]).valid).toBe(false);

    // 2 coordinators -> error
    const twoCoords = terraSolGemini.map((p, idx) =>
      idx < 2 ? { ...p, role: 'coordinator' as const, roles: ['coordinator' as const] } : p,
    );
    expect(validateTeamConfiguration(twoCoords, [SAMPLE_CORE_CONNECTION]).valid).toBe(false);

    // Duplicate session -> error
    const dupSession = terraSolGemini.map((p) => ({
      ...p,
      sessionRef: { ...terraSolGemini[0].sessionRef },
    }));
    expect(validateTeamConfiguration(dupSession, [SAMPLE_CORE_CONNECTION]).valid).toBe(false);
  });

  it('rejects dependency cycles and supports task creation/update + plan revision + tab reordering', async () => {
    const persistence = new WorkspacePersistenceManager(new MemoryOnlyStorageDriver());
    const gateway = new AionCoreAdapter(persistence);
    const loaded = await gateway.loadWorkspace();
    await gateway.importWorkspaceState({
      ...loaded,
      connections: [SAMPLE_CORE_CONNECTION],
    });
    const project = await gateway.createProject({
      name: 'Projeto Core Real',
      description: 'Teste de tarefas e dependências',
      workspacePathInfo: 'C:/core',
    });

    const conv = await gateway.createConversation({
      projectId: project.id,
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

    // Reorder tabs & verify sortParticipantsByTabOrder
    const reversedIds = [...conv.participants].reverse().map((p) => p.id);
    await gateway.reorderParticipantTabs(conv.conversation.id, reversedIds);
    const reordered = sortParticipantsByTabOrder(
      gateway.getStateSnapshot().conversations[conv.conversation.id].participants,
    );
    expect(reordered.map((p) => p.id)).toEqual(reversedIds);

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
    const gateway = new AionCoreAdapter(persistence);
    const loaded = await gateway.loadWorkspace();
    await gateway.importWorkspaceState({
      ...loaded,
      connections: [SAMPLE_CORE_CONNECTION],
    });
    const project = await gateway.createProject({
      name: 'Projeto Backup',
      description: 'Backup sem credenciais',
      workspacePathInfo: 'C:/backup',
    });
    await gateway.createConversation({
      projectId: project.id,
      title: 'Conversa Backup',
      presetId: 'preset_terra_sol_gemini',
    });
    const initial = gateway.getStateSnapshot();

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
      expect(makeDemoModelRef('fast').confirmation).toBe('unverified_preference');
    }

    gateway.dispose();
  });

  it('detaches live Core external bindings on backup import (copy & replace), preserves historical provenance, never assumes login or auto-starts execution (V6-06)', async () => {
    const persistence = new WorkspacePersistenceManager(new MemoryOnlyStorageDriver());
    const gateway = new AionCoreAdapter(persistence);
    const loaded = await gateway.loadWorkspace();
    await gateway.importWorkspaceState({
      ...loaded,
      connections: [SAMPLE_CORE_CONNECTION],
    });
    const project = await gateway.createProject({
      name: 'Projeto Core Backup',
      description: 'Proveniência',
      workspacePathInfo: 'C:/core',
    });
    const createdConv = await gateway.createConversation({
      projectId: project.id,
      title: 'Conversa Core',
      presetId: 'preset_terra_sol_gemini',
    });
    const initial = gateway.getStateSnapshot();
    const convId = createdConv.conversation.id;
    const baseProj = initial.conversations[convId];

    const coreRichState: WorkspaceStoreState = {
      ...structuredClone(initial),
      executionMode: 'aion_core',
      coreRuntimeStatus: 'reachable',
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
    expect(replaced.coreRuntimeStatus).toBe('unknown');
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

    // 2. Copy mode: remaps IDs, detaches live Core refs on copied conversations WITHOUT dropping live session/catalog/runtime state (V6-07 P1)
    const copied = applyImportedWorkspaceBackup(coreRichState, validation.migratedState, 'copy');
    const copiedConvIds = Object.keys(copied.conversations).filter((id) => id !== convId);
    expect(copiedConvIds).toHaveLength(1);
    const copiedProj = copied.conversations[copiedConvIds[0]];
    expect(copiedProj.conversation.executionStatus).toBe('paused_queue');
    expect(copiedProj.conversation.autoPlayWasRunning).toBe(false);
    expect(copiedProj.conversation.externalTeamId).toBeUndefined();
    expect(copiedProj.conversation.importedExternalTeamId).toBe('team_remote_env_123');
    expect(copiedProj.participants[0].sessionRef.externalSlotId).toBeUndefined();
    expect(copiedProj.participants[0].sessionRef.importedExternalRef?.externalSlotId).toBe('slot_remote_0');
    expect(copiedProj.participants[0].sessionRef.status).toBe('inactive');
    // Live session, runtime reachability, catalog connections, and active conversation preserved untouched
    expect(copied.coreRuntimeStatus).toBe('reachable');
    expect(copied.coreSessionAuthenticated).toBe(true);
    expect(copied.connections[0].authStatus).toBe('authenticated');
    expect(copied.connections[0].catalogLoaded).toBe(true);
    expect(copied.connections[0].coreReachability).toBe('reachable');
    expect(copied.connections[0].sessionStatus).toBe('active');
    expect(copied.connections[0].coreAgentId).toBe('agent_remote_1');
    expect(copied.conversations[convId].conversation.externalTeamId).toBe('team_remote_env_123');
    expect(copied.conversations[convId].conversation.executionStatus).toBe('running');

    // Direct copy of unsanitized running state also detaches and pauses only the copy
    const directCopy = applyImportedWorkspaceBackup(coreRichState, coreRichState, 'copy');
    const directCopiedIds = Object.keys(directCopy.conversations).filter((id) => id !== convId);
    expect(directCopiedIds).toHaveLength(1);
    expect(directCopy.conversations[directCopiedIds[0]].conversation.executionStatus).toBe('paused_queue');
    expect(directCopy.coreSessionAuthenticated).toBe(true);
    expect(directCopy.connections[0].catalogLoaded).toBe(true);

    gateway.dispose();
  });

  it('classifies tool permissions fail-closed and reverts allow_all_in_conversation on reload and backup (BL-01)', () => {
    expect(classifyToolPermissionKind('read_file', 'Ler arquivo', 'src/App.tsx')).toBe('read');
    expect(classifyToolPermissionKind('edit_file', 'Editar arquivo', 'src/App.tsx')).toBe('edit');
    expect(classifyToolPermissionKind('edit_file', 'Editar arquivo fora', '../.env')).toBe('execute');
    expect(classifyToolPermissionKind('execute', 'Executar testes', 'npm test')).toBe('execute');
    expect(classifyToolPermissionKind('unknown_tool', 'Ação desconhecida', 'foo')).toBe('execute');

    expect(shouldAutoApprovePermission(undefined, 'read')).toBe(false);
    expect(shouldAutoApprovePermission('manual', 'read')).toBe(false);
    expect(shouldAutoApprovePermission('allow_read_edit', 'read')).toBe(true);
    expect(shouldAutoApprovePermission('allow_read_edit', 'edit')).toBe(true);
    expect(shouldAutoApprovePermission('allow_read_edit', 'execute')).toBe(false);
    expect(shouldAutoApprovePermission('allow_all_in_conversation', 'execute')).toBe(true);

    const deniedPerms: PermissionRequest[] = [
      {
        id: 'perm_denied_1',
        conversationId: 'conv_1',
        participantId: 'part_exec',
        actionKey: 'execute',
        scopeKey: 'ext_1:call_1',
        actionTitle: 'Rodar shell',
        commandSimulated: 'rm -rf tmp',
        scopeDescription: 'Core',
        status: 'denied',
        createdAt: '2026-11-27T10:00:00Z',
        sourceEventId: 'evt_1',
        isSimulated: false,
      },
    ];
    expect(
      hasBlockingDenialForAutoApproval(deniedPerms, 'part_exec', 'execute', 'ext_1:call_2'),
    ).toBe(true);

    const baseState: WorkspaceStoreState = {
      schemaVersion: 2,
      executionMode: 'aion_core',
      coreSettings: { baseUrl: '', workspacePath: '', authMode: 'cookie_or_bearer' },
      projects: [
        {
          id: 'proj_1',
          name: 'Proj',
          description: '',
          workspacePathInfo: 'C:/repo',
          executionMode: 'aion_core',
          status: 'active',
          createdAt: '2026-11-27T10:00:00Z',
          updatedAt: '2026-11-27T10:00:00Z',
        },
      ],
      connections: [],
      agentProfiles: [],
      participantProfiles: [],
      teamPresets: [],
      modelPolicy: {
        defaultExecutorTier: 'fast',
        reviewerTier: 'review',
        escalationTargetTier: 'advanced',
        qualityRejectionsBeforeSuggest: 2,
        approvalMode: 'manual',
      },
      conversations: {
        conv_auto_all: {
          conversation: {
            id: 'conv_auto_all',
            projectId: 'proj_1',
            title: 'Auto All',
            executionMode: 'aion_core',
            status: 'active',
            executionStatus: 'idle',
            toolApprovalPolicy: 'allow_all_in_conversation',
            coordinatorParticipantId: 'p1',
            syncState: 'synced',
            lastAppliedSeq: 0,
            scenarioStepIndex: 0,
            createdAt: '2026-11-27T10:00:00Z',
            updatedAt: '2026-11-27T10:00:00Z',
          },
          participants: [],
          messagesByTab: { general: [] },
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
        },
        conv_read_edit: {
          conversation: {
            id: 'conv_read_edit',
            projectId: 'proj_1',
            title: 'Read Edit',
            executionMode: 'aion_core',
            status: 'active',
            executionStatus: 'idle',
            toolApprovalPolicy: 'allow_read_edit',
            coordinatorParticipantId: 'p1',
            syncState: 'synced',
            lastAppliedSeq: 0,
            scenarioStepIndex: 0,
            createdAt: '2026-11-27T10:00:00Z',
            updatedAt: '2026-11-27T10:00:00Z',
          },
          participants: [],
          messagesByTab: { general: [] },
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
        },
      },
      activeProjectId: 'proj_1',
      activeConversationId: 'conv_auto_all',
    };

    const reloaded = sanitizeLoadedStateAfterReload(baseState);
    expect(reloaded.conversations.conv_auto_all.conversation.toolApprovalPolicy).toBe('manual');
    expect(reloaded.conversations.conv_read_edit.conversation.toolApprovalPolicy).toBe('allow_read_edit');

    const exportedJson = buildWorkspaceJsonExport(baseState);
    const parsed = parseAndValidateWorkspaceBackup(exportedJson);
    expect(parsed.valid).toBe(true);
    if (parsed.valid) {
      expect(parsed.migratedState.conversations.conv_auto_all.conversation.toolApprovalPolicy).toBe('manual');
      const replaced = applyImportedWorkspaceBackup(baseState, baseState, 'replace');
      expect(replaced.conversations.conv_auto_all.conversation.toolApprovalPolicy).toBe('manual');
      const copied = applyImportedWorkspaceBackup(baseState, baseState, 'copy');
      const copiedId = Object.keys(copied.conversations).find((id) => id.startsWith('conv_auto_all_copia_'))!;
      expect(copied.conversations[copiedId].conversation.toolApprovalPolicy).toBe('manual');
    }
  });
});
