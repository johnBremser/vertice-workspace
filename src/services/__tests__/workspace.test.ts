import { describe, expect, it } from 'vitest';
import { createInitialWorkspaceState } from '../../domain/presets';
import type {
  ConnectionAdapterConfig,
  ConversationProjection,
  WorkspaceStoreState,
} from '../../domain/types';
import { probeCoreSessionOnStartup } from '../../features/workspace/WorkspaceContext';
import { AionCoreAdapter, AionCoreAdapterSkeleton } from '../aionCoreAdapter';
import {
  buildConversationMarkdownExport,
  buildWorkspaceJsonExport,
} from '../exportService';
import { GatewayCapabilityError, type AgentWorkspaceGateway } from '../gateway';
import {
  MemoryOnlyStorageDriver,
  type StorageDriver,
  WorkspacePersistenceManager,
  sanitizeLoadedStateAfterReload,
} from '../storage';

const SAMPLE_CORE_CONNECTION: ConnectionAdapterConfig = {
  id: 'conn_core_codex_test',
  displayName: 'Codex CLI (AionCore)',
  vendorLabel: 'AionCore · codex',
  mode: 'aion_core',
  backendId: 'codex',
  coreAgentId: 'agent_codex_test',
  coreAssistantId: 'asst_codex_test',
  configured: true,
  coreReachability: 'reachable',
  catalogLoaded: true,
  executableStatus: 'verified',
  coreAgentStatus: 'online',
  authStatus: 'authenticated',
  sessionStatus: 'active',
  availableModels: [
    {
      externalId: 'gpt-5.4',
      displayName: 'gpt-5.4',
      source: 'core_catalog',
      confirmed: true,
    },
  ],
  capabilities: {
    supportsInterrupt: false,
    supportsMidRunContextInjection: false,
    supportsModelSwitchInSession: true,
    supportsPauseQueue: true,
    supportsSessionTerminate: false,
  },
  isSimulated: false,
};

describe('Workspace gateway, storage failure, reload recovery & export', () => {
  it('switches to session_only mode on QuotaExceededError without silent data loss and keeps export functional', async () => {
    const failingDriver = new MemoryOnlyStorageDriver({ failOnWrite: true });
    const persistence = new WorkspacePersistenceManager(failingDriver);
    const gateway = new AionCoreAdapter(persistence);

    const loaded = await gateway.loadWorkspace();
    expect(persistence.getInfo().status).toBe('session_only');

    await gateway.importWorkspaceState({
      ...loaded,
      connections: [SAMPLE_CORE_CONNECTION],
    });
    const project = await gateway.createProject({
      name: 'Projeto em Sessão',
      description: 'Mantido em memória quando armazenamento falha',
      workspacePathInfo: 'C:/session-only',
    });
    const conv = await gateway.createConversation({
      projectId: project.id,
      title: 'Conversa em Sessão',
      presetId: 'preset_terra_sol_gemini',
    });
    await gateway.publishContextRevision({
      conversationId: conv.conversation.id,
      authorLabel: 'Você',
      summaryOfChange: 'Contexto mantido apenas na sessão',
      objective: 'Objetivo preservado para exportação',
      permanentInstructions: [],
      constraints: [],
      acceptanceCriteria: ['Exportar JSON e Markdown'],
      confirmedDecisions: [],
    });

    const snapshot = gateway.getStateSnapshot();
    const updatedConv = snapshot.conversations[conv.conversation.id];
    const md = buildConversationMarkdownExport(
      snapshot.projects[0],
      updatedConv,
      snapshot.modelPolicy,
    );
    const json = buildWorkspaceJsonExport(snapshot);

    expect(md).toContain('Objetivo preservado para exportação');
    expect(json).toContain('"exportSchemaVersion": "2.0.0"');
    expect(json).toContain(updatedConv.conversation.id);

    gateway.dispose();
  });

  it('strips legacy demo entities and recovers persisted running conversations as paused_queue after reload', () => {
    const base = createInitialWorkspaceState();
    const realConv: ConversationProjection = {
      conversation: {
        id: 'conv_real_1',
        projectId: 'proj_real_1',
        title: 'Conversa Real',
        status: 'active',
        coordinatorParticipantId: 'part_coord',
        executionMode: 'aion_core',
        executionStatus: 'running',
        syncState: 'synced',
        lastAppliedSeq: 2,
        scenarioStepIndex: 0,
        autoPlayWasRunning: true,
        createdAt: '2026-11-18T10:00:00.000Z',
        updatedAt: '2026-11-18T10:00:00.000Z',
      },
      participants: [],
      contextRevisions: [],
      planRevisions: [],
      tasks: [],
      permissions: [],
      escalations: [],
      eventLog: [],
      generalFeed: [],
      messagesByTab: {},
      pendingOutOfOrder: {},
      coordinatorHistory: [],
      configChanges: [],
      seenEventIds: [],
    };

    const legacyState: WorkspaceStoreState = {
      ...base,
      executionMode: 'demo',
      projects: [
        {
          id: 'proj_demo_portal',
          name: 'Portal de demonstração',
          description: 'Legado',
          workspacePathInfo: '',
          executionMode: 'demo',
          status: 'active',
          createdAt: '2026-11-16T10:00:00.000Z',
          updatedAt: '2026-11-16T10:00:00.000Z',
        },
        {
          id: 'proj_real_1',
          name: 'Projeto Real',
          description: 'Mantido',
          workspacePathInfo: 'C:/real',
          executionMode: 'aion_core',
          status: 'active',
          createdAt: '2026-11-18T10:00:00.000Z',
          updatedAt: '2026-11-18T10:00:00.000Z',
        },
      ],
      connections: [
        {
          ...SAMPLE_CORE_CONNECTION,
          id: 'conn_codex_demo',
          mode: 'demo',
          isSimulated: true,
        },
        SAMPLE_CORE_CONNECTION,
      ],
      conversations: {
        conv_demo_busca_nome: {
          ...structuredClone(realConv),
          conversation: {
            ...realConv.conversation,
            id: 'conv_demo_busca_nome',
            projectId: 'proj_demo_portal',
            executionMode: 'demo',
          },
        },
        conv_real_1: realConv,
      },
      activeProjectId: 'proj_demo_portal',
      activeConversationId: 'conv_demo_busca_nome',
    };

    const sanitized = sanitizeLoadedStateAfterReload(legacyState);
    expect(sanitized.executionMode).toBe('aion_core');
    expect(sanitized.projects.map((p) => p.id)).toEqual(['proj_real_1']);
    expect(Object.keys(sanitized.conversations)).toEqual(['conv_real_1']);
    expect(sanitized.connections.every((c) => c.mode === 'aion_core')).toBe(true);
    expect(sanitized.activeProjectId).toBe('proj_real_1');
    expect(sanitized.activeConversationId).toBe('conv_real_1');

    const conv = sanitized.conversations.conv_real_1.conversation;
    expect(conv.executionStatus).toBe('paused_queue');
    expect(conv.autoPlayWasRunning).toBe(false);
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
    stateA.activeProjectId = 'proj_versao_a';
    const stateB = structuredClone(initial);
    stateB.activeProjectId = 'proj_versao_b';

    persistence.scheduleSave(stateA, 0);
    await new Promise((resolve) => setTimeout(resolve, 10));
    persistence.scheduleSave(stateB, 0);
    await new Promise((resolve) => setTimeout(resolve, 80));
    await persistence.flushSave();

    const lastSaved = savedSnapshots[savedSnapshots.length - 1];
    expect(lastSaved.activeProjectId).toBe('proj_versao_b');
    expect(persistence.getInfo().status).toBe('saved');
    expect(statuses[statuses.length - 1]).toBe('saved');

    persistence.dispose();
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
    stateA.activeProjectId = 'proj_gravacao_a_lenta';
    const stateB = structuredClone(initial);
    stateB.activeProjectId = 'proj_gravacao_b_debounce';

    persistence.scheduleSave(stateA, 0);
    await new Promise((resolve) => setTimeout(resolve, 15));

    persistence.scheduleSave(stateB, 180);
    expect(persistence.getInfo().status).toBe('saving');

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(persistence.getInfo().status).toBe('saved');
    expect(savedSnapshots[savedSnapshots.length - 1].activeProjectId).toBe(
      'proj_gravacao_b_debounce',
    );

    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(persistence.getInfo().status).toBe('saved');

    persistence.dispose();
  });

  it('rejects unsupported interrupt capability honestly and fails explicitly in AionCoreAdapterSkeleton', async () => {
    const persistence = new WorkspacePersistenceManager(
      new MemoryOnlyStorageDriver(),
    );
    const gateway = new AionCoreAdapter(persistence);
    const loaded = await gateway.loadWorkspace();
    await gateway.importWorkspaceState({
      ...loaded,
      connections: [SAMPLE_CORE_CONNECTION],
    });
    const project = await gateway.createProject({
      name: 'Projeto Interrupção',
      description: 'Teste de capacidade',
      workspacePathInfo: 'C:/cap',
    });
    const conv = await gateway.createConversation({
      projectId: project.id,
      title: 'Conversa Interrupção',
      presetId: 'preset_terra_sol_gemini',
    });

    await expect(
      gateway.controlExecution({
        conversationId: conv.conversation.id,
        action: 'request_interrupt',
        participantId: conv.participants[0].id,
      }),
    ).rejects.toBeInstanceOf(GatewayCapabilityError);

    const coreSkeleton = new AionCoreAdapterSkeleton();
    await expect(coreSkeleton.loadWorkspace()).rejects.toMatchObject({
      code: 'NOT_CONNECTED_LOCAL_CORE',
    });

    gateway.dispose();
  });

  it('handles IndexedDB load errors, preserves future incompatible schemas without overwriting, migrates v1->v2 on load, and drains nested flushSave writes (V6-06)', async () => {
    // 1. Storage unavailable on loadInitial -> switches to session_only with explicit warning
    const failingLoadDriver: StorageDriver = {
      async load() {
        throw new Error('Abertura do IndexedDB bloqueada pelo navegador.');
      },
      async save() {
        throw new Error('Should not overwrite when load failed');
      },
      async clear() {},
    };
    const pFailLoad = new WorkspacePersistenceManager(failingLoadDriver);
    const gwFailLoad = new AionCoreAdapter(pFailLoad);
    await gwFailLoad.loadWorkspace();
    expect(pFailLoad.getInfo().status).toBe('session_only');
    expect(pFailLoad.getInfo().errorMessage).toContain('IndexedDB bloqueada');
    gwFailLoad.dispose();

    // 2. Future incompatible schema -> session_only WITHOUT calling save() (preserves local DB)
    let incompatibleSaveCalls = 0;
    const futureSchemaDriver: StorageDriver = {
      async load() {
        return {
          schemaVersion: 99,
          projects: [],
          conversations: {},
        } as unknown as WorkspaceStoreState;
      },
      async save() {
        incompatibleSaveCalls += 1;
      },
      async clear() {},
    };
    const pFuture = new WorkspacePersistenceManager(futureSchemaDriver);
    const gwFuture = new AionCoreAdapter(pFuture);
    await gwFuture.loadWorkspace();
    expect(pFuture.getInfo().status).toBe('session_only');
    expect(pFuture.getInfo().errorMessage).toContain('Schema incompatível');
    expect(pFuture.getInfo().errorMessage).toContain('sem sobrescrita');
    expect(incompatibleSaveCalls).toBe(0);
    gwFuture.dispose();

    // 3. Schema v1 payload loaded -> migrated to v2 and saved back
    let savedAfterMigration: WorkspaceStoreState | null = null;
    const v1Driver: StorageDriver = {
      async load() {
        return {
          schemaVersion: 1,
          projects: [
            {
              id: 'proj_v1',
              name: 'Projeto Legado v1',
              description: 'Migrado',
              workspacePathInfo: '',
              status: 'active',
              createdAt: '2026-10-01T00:00:00.000Z',
              updatedAt: '2026-10-01T00:00:00.000Z',
            },
          ],
          conversations: {},
          activeProjectId: 'proj_v1',
          activeConversationId: '',
        } as unknown as WorkspaceStoreState;
      },
      async save(state) {
        savedAfterMigration = structuredClone(state);
      },
      async clear() {},
    };
    const pMig = new WorkspacePersistenceManager(v1Driver);
    const gwMig = new AionCoreAdapter(pMig);
    const migrated = await gwMig.loadWorkspace();
    expect(migrated.schemaVersion).toBe(2);
    expect(migrated.executionMode).toBe('aion_core');
    expect(savedAfterMigration).not.toBeNull();
    expect(savedAfterMigration!.schemaVersion).toBe(2);
    expect(pMig.getInfo().status).toBe('saved');
    gwMig.dispose();

    // 4. Nested flushSave drains queued writes arriving during an active write
    const persistedVersions: string[] = [];
    let releaseFirstWrite: (() => void) | null = null;
    const slowDriver: StorageDriver = {
      async load() {
        return null;
      },
      async save(state) {
        if (persistedVersions.length === 0) {
          await new Promise<void>((resolve) => {
            releaseFirstWrite = resolve;
          });
        }
        persistedVersions.push(state.activeProjectId);
      },
      async clear() {},
    };
    const pQueue = new WorkspacePersistenceManager(slowDriver);
    const baseState = createInitialWorkspaceState();
    pQueue.scheduleSave({ ...baseState, activeProjectId: 'p_1' }, 0);
    const firstFlush = pQueue.flushSave();
    await new Promise((r) => setTimeout(r, 10));
    pQueue.scheduleSave({ ...baseState, activeProjectId: 'p_2' }, 200);
    const secondFlush = pQueue.flushSave();
    releaseFirstWrite!();
    await Promise.all([firstFlush, secondFlush]);
    expect(persistedVersions[persistedVersions.length - 1]).toBe('p_2');
    expect(pQueue.getInfo().status).toBe('saved');
    pQueue.dispose();
  });

  it('clears stale Core runtime/auth confirmations on reload so previous-runtime state cannot confirm guided setup steps (V6-07)', async () => {
    const driver = new MemoryOnlyStorageDriver();
    const p1 = new WorkspacePersistenceManager(driver);
    const gw1 = new AionCoreAdapter(p1);
    const initial = await gw1.loadWorkspace();
    const staleCoreState: WorkspaceStoreState = {
      ...structuredClone(initial),
      executionMode: 'aion_core',
      coreSessionAuthenticated: true,
      connections: [SAMPLE_CORE_CONNECTION],
    };
    await gw1.importWorkspaceState(staleCoreState);
    gw1.dispose();

    const p2 = new WorkspacePersistenceManager(driver);
    const gw2 = new AionCoreAdapter(p2);
    const reloaded = await gw2.loadWorkspace();
    expect(reloaded.coreSessionAuthenticated).toBe(false);
    const coreConn = reloaded.connections.find((c) => c.mode === 'aion_core')!;
    expect(coreConn.coreReachability).toBe('unknown');
    expect(coreConn.catalogLoaded).toBe(false);
    expect(coreConn.authStatus).toBe('unknown');
    expect(coreConn.sessionStatus).toBe('inactive');
    gw2.dispose();
  });

  it('starts a real Core workspace cleanly without seeded demonstration data', async () => {
    const driver = new MemoryOnlyStorageDriver();
    const persistence = new WorkspacePersistenceManager(driver);
    const adapter = new AionCoreAdapter(persistence);
    const coreState = await adapter.loadWorkspace();

    expect(coreState.executionMode).toBe('aion_core');
    expect(coreState.projects).toEqual([]);
    expect(Object.keys(coreState.conversations)).toEqual([]);
    expect(coreState.connections).toEqual([]);
    adapter.dispose();
  });

  it('revalidates /health, /api/auth/status and catalog silently on startup without model cost when authenticated (V6-07 P2)', async () => {
    const calls: string[] = [];
    let authenticated = true;
    let healthFails = false;

    const fakeCoreGateway = {
      kind: 'aion_core',
      core: {
        checkHealth: async () => {
          calls.push('health');
          if (healthFails) throw new Error('ECONNREFUSED');
          return {
            reachable: true,
            version: '0.2.2',
            buildTime: '2026-11-18T00:00:00Z',
            message: 'ok',
          };
        },
        checkAuthStatus: async () => {
          calls.push('auth');
          return { authenticated, message: authenticated ? 'ok' : 'no' };
        },
        refreshCoreCatalog: async () => {
          calls.push('catalog');
          return {
            connectionsUpdated: 2,
            assistantsCount: 2,
            agentsCount: 2,
            message: 'ok',
          };
        },
      },
    } as unknown as AgentWorkspaceGateway;

    // 1. Authenticated cookie -> probes health, auth, and catalog
    await probeCoreSessionOnStartup(fakeCoreGateway, () => true);
    expect(calls).toEqual(['health', 'auth', 'catalog']);

    // 2. Unauthenticated -> stops before catalog
    calls.length = 0;
    authenticated = false;
    await probeCoreSessionOnStartup(fakeCoreGateway, () => true);
    expect(calls).toEqual(['health', 'auth']);

    // 3. Unreachable Core -> swallows silently without throwing or calling auth/catalog
    calls.length = 0;
    healthFails = true;
    await expect(
      probeCoreSessionOnStartup(fakeCoreGateway, () => true),
    ).resolves.toBeUndefined();
    expect(calls).toEqual(['health']);

    // 4. Unmounted / cancelled guard -> aborts cleanly
    calls.length = 0;
    healthFails = false;
    await probeCoreSessionOnStartup(fakeCoreGateway, () => false);
    expect(calls).toEqual([]);
  });
});
