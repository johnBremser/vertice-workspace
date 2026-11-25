import { describe, expect, it } from 'vitest';
import { AionCoreAdapter } from '../aionCoreAdapter';
import type { WebSocketFactory, WsLike } from '../aionCoreTransport';
import {
  buildWorkspaceJsonExport,
  parseAndValidateWorkspaceBackup,
} from '../exportService';
import {
  MemoryOnlyStorageDriver,
  sanitizeLoadedStateAfterReload,
  WorkspacePersistenceManager,
} from '../storage';
import {
  REAL_CORE_AGENTS_MANAGEMENT_V022,
  REAL_CORE_ASSISTANTS_V022,
  REAL_CORE_AUTH_STATUS_V022,
  REAL_CORE_HEALTH_V022,
  buildRealMessageStreamFrame,
} from './fixtures/coreV022RealPayloads';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

class MockSocket implements WsLike {
  readyState = 1;
  onopen: ((ev: Event) => unknown) | null = null;
  onmessage: ((ev: MessageEvent) => unknown) | null = null;
  onerror: ((ev: Event) => unknown) | null = null;
  onclose: ((ev: CloseEvent) => unknown) | null = null;
  readonly sent: string[] = [];

  constructor(_url: string, _protocols?: string | string[]) {
    queueMicrotask(() => {
      this.onopen?.(new Event('open'));
    });
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
  }

  emitMessage(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) } as MessageEvent);
  }
}

describe('Vertice Floating Assistant in AionCoreAdapter (isolated session, WS routing & sanitization)', () => {
  it('activates after catalog sync, isolates assistant team/WS messages from project conversations, flags write permissions, and sanitizes reload/export', async () => {
    const sockets: MockSocket[] = [];
    const postedBodies: Array<{ path: string; body: unknown }> = [];

    const fetchFn = async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      const body =
        typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      if (method === 'POST') {
        postedBodies.push({ path: url, body: body ?? init?.body });
      }
      if (url.endsWith('/api/fs/upload') && method === 'POST') {
        return jsonResponse({
          success: true,
          data: 'C:/tmp/uploads/print-tela.png',
        });
      }

      if (url.endsWith('/health')) return jsonResponse(REAL_CORE_HEALTH_V022);
      if (url.endsWith('/api/auth/status')) {
        return jsonResponse({ success: true, ...REAL_CORE_AUTH_STATUS_V022 });
      }
      if (url.endsWith('/api/ws-token')) {
        return jsonResponse({
          success: true,
          ws_token: 'ws_tok_assistant',
          expires_in: 300,
        });
      }
      if (url.endsWith('/api/agents/management')) {
        return jsonResponse({
          success: true,
          data: REAL_CORE_AGENTS_MANAGEMENT_V022,
        });
      }
      if (url.endsWith('/api/assistants')) {
        return jsonResponse({ success: true, data: REAL_CORE_ASSISTANTS_V022 });
      }
      if (url.endsWith('/api/teams') && method === 'GET') {
        return jsonResponse({
          success: true,
          data: [
            {
              id: 'team_assistant_1',
              name: '__vertice_internal_assistant__',
              assistants: [],
              created_at: 1,
              updated_at: 1,
            },
          ],
        });
      }
      if (url.endsWith('/api/teams') && method === 'POST') {
        return jsonResponse({
          success: true,
          data: {
            id:
              body.name === '__vertice_internal_assistant__'
                ? 'team_assistant_1'
                : 'team_custom_1',
            name: body.name,
            assistants: [
              {
                slot_id: 'slot_assistant_1',
                name: body.agents[0]?.name ?? 'Assistente Vértice',
                role: 'lead',
                conversation_id: 'ext_conv_assistant_1',
                backend: 'codex',
                model: body.agents[0].model,
              },
            ],
            created_at: 1,
            updated_at: 1,
          },
        });
      }
      if (url.endsWith('/api/teams/team_assistant_1/messages') && method === 'POST') {
        return jsonResponse({
          success: true,
          data: {
            enqueue_status: 'accepted',
            message_id: 'msg_ast_req_1',
            run: {
              team_id: 'team_assistant_1',
              team_run_id: 'run_ast_1',
              source: 'user_message',
              has_user_intervention: false,
              target_slot_id: 'slot_assistant_1',
              target_role: 'lead',
              status: 'accepted',
              queued_intent_count: 0,
              starting_batch_count: 0,
              running_batch_count: 1,
              active_enqueue_lease_count: 0,
              slot_work: [],
            },
          },
        });
      }
      if (
        url.includes('/api/conversations/ext_conv_assistant_1/confirmations/') &&
        method === 'POST'
      ) {
        return jsonResponse({ success: true });
      }
      return jsonResponse({ success: false, message: 'Unhandled route' }, 404);
    };

    const wsFactory: WebSocketFactory = (url, protocols) => {
      const sock = new MockSocket(url, protocols);
      sockets.push(sock);
      return sock;
    };

    const persistence = new WorkspacePersistenceManager(
      new MemoryOnlyStorageDriver(),
    );
    const adapter = new AionCoreAdapter(persistence, {
      fetchFn,
      wsFactory,
      readCookie: () => 'csrf_ast_1',
    });

    await adapter.loadWorkspace();
    await adapter.core.checkHealth();
    await adapter.core.checkAuthStatus();
    await adapter.core.refreshCoreCatalog();

    // Create a user project/conversation to ensure strict isolation
    const proj = await adapter.createProject({
      name: 'Meu Projeto',
      description: 'Teste',
      workspacePathInfo: 'C:/projetos/meu-app',
    });
    const conv = await adapter.createConversation({
      projectId: proj.id,
      title: 'Conversa Principal',
    });

    // Activate assistant on the first synced Codex connection + confirmed model
    const cfgRes = await adapter.core.configureVerticeAssistant({
      connectionId: 'conn_core_bare:8e1acf31',
      modelExternalId: 'gpt-5.6-luna',
      modelDisplayName: 'GPT-5.6-Luna',
    });
    expect(cfgRes.externalTeamId).toBe('team_assistant_1');

    // syncCoreTeams should ignore the assistant team and keep user conversations untouched
    await adapter.core.syncCoreTeams();
    const stateAfterSync = adapter.getStateSnapshot();
    expect(Object.keys(stateAfterSync.conversations)).toEqual([conv.conversation.id]);
    expect(stateAfterSync.conversations[conv.conversation.id]?.conversation.externalTeamId).toBeUndefined();

    // Send a question to the assistant
    await adapter.core.sendVerticeAssistantMessage({
      prompt: 'Como funciona o reducer.ts no Vértice?',
    });

    const sendCall = postedBodies.find((c) =>
      c.path.endsWith('/api/teams/team_assistant_1/messages'),
    );
    expect(sendCall).toBeDefined();
    expect((sendCall?.body as { content: string }).content).toContain(
      'MODO SOMENTE LEITURA',
    );

    const sock = sockets[0];
    expect(sock).toBeDefined();

    // Stream content + finish into the assistant without touching project conversation
    sock.emitMessage(
      buildRealMessageStreamFrame({
        extConvId: 'ext_conv_assistant_1',
        msgId: 'msg_ast_reply_1',
        turnId: 'turn_ast_1',
        type: 'content',
        data: { content: 'O reducer incremental aplica eventos por `seq`.' },
      }),
    );
    sock.emitMessage(
      buildRealMessageStreamFrame({
        extConvId: 'ext_conv_assistant_1',
        msgId: 'msg_ast_reply_1',
        turnId: 'turn_ast_1',
        type: 'finish',
        data: {},
      }),
    );

    let snap = adapter.getStateSnapshot();
    expect(snap.assistantState?.status).toBe('idle');
    expect(snap.assistantState?.messages).toHaveLength(2);
    expect(snap.assistantState?.messages[1]?.status).toBe('completed');
    expect(snap.assistantState?.messages[1]?.contentMarkdown).toContain(
      'reducer incremental',
    );
    expect(snap.conversations[conv.conversation.id]?.generalFeed).toHaveLength(0);

    // Emit a write tool permission request -> flagged as isWriteAttempt: true
    sock.emitMessage(
      buildRealMessageStreamFrame({
        extConvId: 'ext_conv_assistant_1',
        msgId: 'msg_ast_perm_1',
        turnId: 'turn_ast_2',
        type: 'acp_permission',
        data: {
          tool_call: {
            tool_call_id: 'call_write_1',
            title: 'edit_file src/App.tsx',
            kind: 'edit',
            raw_input: { command: 'write src/App.tsx' },
          },
          options: [
            { kind: 'allow_once', option_id: 'allow_once' },
            { kind: 'reject_once', option_id: 'reject_once' },
          ],
        },
      }),
    );

    snap = adapter.getStateSnapshot();
    const permMsg = snap.assistantState?.messages.find((m) => m.permissionRequest);
    expect(permMsg?.permissionRequest?.isWriteAttempt).toBe(true);
    expect(permMsg?.permissionRequest?.status).toBe('pending');

    await adapter.core.respondVerticeAssistantPermission({
      requestId: permMsg!.permissionRequest!.requestId,
      decision: 'denied',
    });
    expect(
      adapter.getStateSnapshot().assistantState?.messages.find((m) => m.permissionRequest)
        ?.permissionRequest?.status,
    ).toBe('denied');

    // Export & import sanitizes external IDs of assistantState
    const exportedJson = buildWorkspaceJsonExport(adapter.getStateSnapshot());
    const parsedBackup = parseAndValidateWorkspaceBackup(exportedJson);
    expect(parsedBackup.valid).toBe(true);
    if (parsedBackup.valid) {
      expect(parsedBackup.migratedState.assistantState?.config?.connectionId).toBe(
        'conn_core_bare:8e1acf31',
      );
      expect(
        parsedBackup.migratedState.assistantState?.config?.externalTeamId,
      ).toBeUndefined();
    }

    // Reload sanitization stops in-flight streaming assistant messages
    const streamingState = adapter.getStateSnapshot();
    streamingState.assistantState = {
      ...streamingState.assistantState!,
      status: 'streaming',
      messages: [
        ...streamingState.assistantState!.messages,
        {
          id: 'ast_stream_interrupted',
          role: 'assistant',
          contentMarkdown: 'Parcial',
          timestamp: new Date().toISOString(),
          status: 'streaming',
        },
      ],
    };
    const afterReload = sanitizeLoadedStateAfterReload(streamingState);
    expect(afterReload.assistantState?.status).toBe('idle');
    expect(
      afterReload.assistantState?.messages.find(
        (m) => m.id === 'ast_stream_interrupted',
      )?.status,
    ).toBe('error');

    // Empty conversation creation (__empty__) starts with 0 participants, accepts custom team name on Core create
    const emptyConv = await adapter.createConversation({
      projectId: proj.id,
      title: 'Teste',
      presetId: '__empty__',
    });
    expect(emptyConv.participants).toHaveLength(0);
    expect(emptyConv.conversation.teamPresetId).toBeUndefined();

    await adapter.addParticipantToConversation(emptyConv.conversation.id, {
      connectionId: 'conn_core_bare:8e1acf31',
      displayName: 'Líder Custom',
      roles: ['coordinator', 'planner', 'executor'],
      modelRef: {
        externalId: 'gpt-5.6-luna',
        displayName: 'GPT-5.6-Luna',
        source: 'core_catalog',
        confirmation: 'confirmed',
      },
      instructions: 'Executar tudo.',
    });
    const afterAdd = adapter.getStateSnapshot().conversations[emptyConv.conversation.id]!;
    expect(afterAdd.participants).toHaveLength(1);
    expect(afterAdd.conversation.coordinatorParticipantId).toBe(
      afterAdd.participants[0]!.id,
    );

    const createdCustomTeam = await adapter.core.createCoreTeamForConversation(
      emptyConv.conversation.id,
      'Equipe Stars',
    );
    expect(createdCustomTeam.externalTeamId).toBe('team_custom_1');
    expect(createdCustomTeam.message).toContain('Equipe Stars');

    const syncedTeams = await adapter.core.syncCoreTeams();
    expect(syncedTeams.teams.some((t) => t.isInternalAssistant)).toBe(true);

    // Send text scope attachment + image screenshot attachment to the assistant
    const pngFile = new File([new Uint8Array([137, 80, 78, 71])], 'tela-erro.png', {
      type: 'image/png',
    });
    await adapter.core.sendVerticeAssistantMessage({
      prompt: 'Analise este escopo e recomende a equipe ideal.',
      attachments: [
        {
          id: 'att_txt_1',
          name: 'escopo.md',
          kind: 'text',
          mimeType: 'text/markdown',
          sizeBytes: 64,
          textContent: '# Projeto iNET\nPrecisa de planner e reviewer separados.',
        },
        {
          id: 'att_img_1',
          name: 'tela-erro.png',
          kind: 'image',
          mimeType: 'image/png',
          sizeBytes: 4,
          file: pngFile,
        },
      ],
    });

    const uploadCall = postedBodies.find((c) => c.path.endsWith('/api/fs/upload'));
    expect(uploadCall).toBeDefined();
    expect(uploadCall?.body).toBeInstanceOf(FormData);

    const attachmentSendCalls = postedBodies.filter((c) =>
      c.path.endsWith('/api/teams/team_assistant_1/messages'),
    );
    const lastSendBody = attachmentSendCalls[attachmentSendCalls.length - 1]?.body as {
      content: string;
      files?: Array<{ kind: string; path: string }>;
    };
    expect(lastSendBody.content).toContain('[Arquivos Anexados pelo Usuário]');
    expect(lastSendBody.content).toContain('escopo.md');
    expect(lastSendBody.content).toContain('tela-erro.png');
    expect(lastSendBody.files).toEqual([
      { kind: 'upload', path: 'C:/tmp/uploads/print-tela.png' },
    ]);

    const afterAttachSnap = adapter.getStateSnapshot();
    const lastUserMsg = afterAttachSnap.assistantState?.messages
      .filter((m) => m.role === 'user')
      .pop();
    expect(lastUserMsg?.attachments).toHaveLength(2);
    expect(lastUserMsg?.attachments?.[0]?.name).toBe('escopo.md');
    expect(lastUserMsg?.attachments?.[1]?.name).toBe('tela-erro.png');
  });
});
