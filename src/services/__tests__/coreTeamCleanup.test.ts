import { describe, expect, it } from 'vitest';
import { AionCoreAdapter } from '../aionCoreAdapter';
import { MemoryOnlyStorageDriver, WorkspacePersistenceManager } from '../storage';
import {
  REAL_CORE_AGENTS_MANAGEMENT_V022,
  REAL_CORE_ASSISTANTS_V022,
  REAL_CORE_AUTH_STATUS_V022,
  REAL_CORE_HEALTH_V022,
} from './fixtures/coreV022RealPayloads';

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('Core Teams Orphan Cleanup (DELETE /api/teams/{id})', () => {
  it('deletes only unlinked teams during cleanupOrphanCoreTeams while keeping linked conversations and internal assistant intact', async () => {
    let remoteTeams = [
      {
        id: 'team_linked_1',
        name: 'Projeto Real',
        workspace: 'C:/fontes/inet',
        assistants: [
          {
            slot_id: 'slot_1',
            name: 'Terra 6.1',
            role: 'lead',
            conversation_id: 'conv_1',
            backend: 'codex',
            model: 'gpt-5.6-luna',
          },
        ],
        created_at: 1,
        updated_at: 1,
      },
      {
        id: 'team_ast_1',
        name: '__vertice_internal_assistant__',
        workspace: 'C:/llm/vertice-workspace',
        assistants: [
          {
            slot_id: 'slot_ast_1',
            name: 'Assistente Vértice',
            role: 'lead',
            conversation_id: 'conv_ast_1',
            backend: 'codex',
            model: 'gpt-5.6-luna',
          },
        ],
        created_at: 2,
        updated_at: 2,
      },
      {
        id: 'team_orphan_probe_1',
        name: 'Probe V6-02 Codex',
        workspace: 'C:/Temp/probe',
        assistants: [],
        created_at: 3,
        updated_at: 3,
      },
      {
        id: 'team_orphan_ast_old',
        name: '__vertice_internal_assistant__',
        workspace: 'C:/llm/vertice-workspace',
        assistants: [],
        created_at: 4,
        updated_at: 4,
      },
    ];
    const deletedIds: string[] = [];

    const fetchFn = async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      if (url.endsWith('/health')) return jsonResponse(REAL_CORE_HEALTH_V022);
      if (url.endsWith('/api/auth/status')) {
        return jsonResponse({ success: true, ...REAL_CORE_AUTH_STATUS_V022 });
      }
      if (url.endsWith('/api/agents/management')) {
        return jsonResponse({ success: true, data: REAL_CORE_AGENTS_MANAGEMENT_V022 });
      }
      if (url.endsWith('/api/assistants')) {
        return jsonResponse({ success: true, data: REAL_CORE_ASSISTANTS_V022 });
      }
      if (url.endsWith('/api/teams') && method === 'GET') {
        return jsonResponse({ success: true, data: remoteTeams });
      }
      if (url.endsWith('/api/teams') && method === 'POST') {
        return jsonResponse({
          success: true,
          data: remoteTeams[1],
        });
      }
      if (url.includes('/api/teams/') && method === 'DELETE') {
        const teamId = decodeURIComponent(url.split('/api/teams/')[1] ?? '');
        deletedIds.push(teamId);
        remoteTeams = remoteTeams.filter((t) => t.id !== teamId);
        return jsonResponse({ success: true });
      }
      return jsonResponse({ success: false, message: 'Unhandled' }, 404);
    };

    const adapter = new AionCoreAdapter(
      new WorkspacePersistenceManager(new MemoryOnlyStorageDriver()),
      { fetchFn, readCookie: () => 'csrf_cleanup' },
    );

    await adapter.loadWorkspace();
    await adapter.core.checkHealth();
    await adapter.core.checkAuthStatus();
    await adapter.core.refreshCoreCatalog();

    // Activate assistant on team_ast_1 and link a local conversation to team_linked_1
    await adapter.core.configureVerticeAssistant({
      connectionId: 'conn_core_bare:8e1acf31',
      modelExternalId: 'gpt-5.6-luna',
      modelDisplayName: 'GPT-5.6-Luna',
    });

    const proj = await adapter.createProject({
      name: 'P1',
      description: 'D1',
      workspacePathInfo: 'C:/fontes/inet',
    });
    const conv = await adapter.createConversation({
      projectId: proj.id,
      title: 'Projeto Real',
      presetId: '__empty__',
    });
    const snap = adapter.getStateSnapshot();
    snap.conversations[conv.conversation.id]!.conversation.externalTeamId =
      'team_linked_1';

    const cleanupRes = await adapter.core.cleanupOrphanCoreTeams();
    expect(cleanupRes.deletedCount).toBe(2);
    expect(cleanupRes.failedCount).toBe(0);
    expect(deletedIds).toEqual(['team_orphan_probe_1', 'team_orphan_ast_old']);
    expect(cleanupRes.teams.map((t) => t.id)).toEqual([
      'team_linked_1',
      'team_ast_1',
    ]);

    await adapter.updateProject({
      projectId: proj.id,
      name: 'P1 Editado',
      description: 'Nova descrição',
      workspacePathInfo: 'C:/fontes/novo-caminho',
    });
    const updatedProject = adapter
      .getStateSnapshot()
      .projects.find((p) => p.id === proj.id);
    expect(updatedProject?.name).toBe('P1 Editado');
    expect(updatedProject?.description).toBe('Nova descrição');
    expect(updatedProject?.workspacePathInfo).toBe('C:/fontes/novo-caminho');
  });
});
