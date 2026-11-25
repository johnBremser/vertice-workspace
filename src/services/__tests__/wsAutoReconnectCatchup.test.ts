import { describe, expect, it, vi } from 'vitest';
import { AionCoreAdapter } from '../aionCoreAdapter';
import type { WebSocketFactory, WsLike } from '../aionCoreTransport';
import type { AgentWorkspaceGateway, CoreGatewayOperations } from '../gateway';
import { probeCoreSessionOnStartup } from '../../features/workspace/WorkspaceContext';
import {
  MemoryOnlyStorageDriver,
  WorkspacePersistenceManager,
} from '../storage';
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

class FakeWebSocket implements WsLike {
  readyState = 0;
  onopen: ((ev: Event) => unknown) | null = null;
  onmessage: ((ev: MessageEvent) => unknown) | null = null;
  onerror: ((ev: Event) => unknown) | null = null;
  onclose: ((ev: CloseEvent) => unknown) | null = null;
  sent: string[] = [];

  open(): void {
    this.readyState = 1;
    this.onopen?.(new Event('open'));
  }

  emitMessage(payload: unknown): void {
    this.onmessage?.(
      new MessageEvent('message', { data: JSON.stringify(payload) }),
    );
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.readyState = 3;
    this.onclose?.({ code, reason } as CloseEvent);
  }
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 15));
}

describe('WebSocket auto-connect, initial catch-up & working status mapping', () => {
  it('recovers an unanswered enqueued_core plan_proposal on initial WS connect even when executionStatus is idle, and maps working -> running', async () => {
    const sockets: FakeWebSocket[] = [];
    const wsFactory: WebSocketFactory = () => {
      const s = new FakeWebSocket();
      sockets.push(s);
      return s;
    };

    let activeConvId = '';
    const buildPlanReplyMarkdown = () =>
      [
        'Plano preparado.',
        '',
        '```aion-desk-json',
        JSON.stringify({
          protocol: 'aion-desk/v1',
          kind: 'plan_proposal',
          conversationId: activeConvId,
          summary: 'Plano Calculadora Romana PWA',
          tasks: [
            {
              title: 'Estruturar projeto HTML5/PWA',
              description: 'Criar manifest e service worker.',
              assigneeRole: 'executor',
              dependencies: [],
              acceptanceCriteria: ['Manifest e service worker criados'],
            },
            {
              title: 'Implementar conversor romano',
              description: 'Suportar 1 a 3999 e validação.',
              assigneeRole: 'executor',
              dependencies: [],
              acceptanceCriteria: ['Conversão correta de 1 a 3999'],
            },
          ],
        }),
        '```',
      ].join('\n');

    let currentRunState: 'idle' | 'working' = 'working';

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
      if (url.endsWith('/api/ws-token')) {
        return jsonResponse({ success: true, ws_token: 'ws_tok_test' });
      }
      if (url.endsWith('/api/teams') && method === 'POST') {
        return jsonResponse({
          success: true,
          data: {
            id: 'team_calc',
            name: 'Calculadora Romana',
            workspace: 'C:/llm/POCs',
            assistants: [
              {
                slot_id: 'slot_lead',
                name: 'Hydrogen',
                role: 'lead',
                conversation_id: 'ext_conv_lead',
                backend: 'antigravity',
                model: 'gemini-4-hydrogen-high',
              },
              {
                slot_id: 'slot_exec',
                name: 'Composer 2.5',
                role: 'teammate',
                conversation_id: 'ext_conv_exec',
                backend: 'cursor',
                model: 'composer-2.5',
              },
            ],
            created_at: 1000,
            updated_at: 1000,
          },
        });
      }
      if (url.endsWith('/api/teams/team_calc/messages') && method === 'POST') {
        return jsonResponse({
          success: true,
          data: {
            message_id: 'msg_enqueued_1',
            enqueue_status: 'enqueued',
          },
        });
      }
      if (url.endsWith('/api/teams/team_calc/run-state')) {
        return jsonResponse({
          success: true,
          data: {
            team_id: 'team_calc',
            status: currentRunState,
            slot_work: [
              {
                slot_id: 'slot_lead',
                conversation_id: 'ext_conv_lead',
                state: currentRunState,
                updated_at: Date.now(),
              },
            ],
          },
        });
      }
      if (url.includes('/api/teams/team_calc/mailbox')) {
        return jsonResponse({ success: true, data: { items: [], total: 0 } });
      }
      if (url.includes('/api/teams/team_calc/tasks')) {
        return jsonResponse({ success: true, data: { items: [], total: 0 } });
      }
      if (url.includes('/api/teams/team_calc/activity')) {
        return jsonResponse({ success: true, data: { items: [], total: 0 } });
      }
      if (url.includes('/api/conversations/ext_conv_lead/messages')) {
        return jsonResponse({
          success: true,
          data: {
            items: [
              {
                id: 'raw_u_1',
                msg_id: 'msg_enqueued_1',
                position: 'right',
                type: 'text',
                status: 'finish',
                content: { content: 'Crie calculadora romana PWA' },
                created_at: Date.now() - 35_000,
              },
              {
                id: 'raw_a_1',
                msg_id: 'b695a92e',
                backend_turn_id: 'turn_1',
                position: 'left',
                type: 'text',
                status: 'finish',
                content: { content: buildPlanReplyMarkdown() },
                created_at: Date.now(),
              },
            ],
          },
        });
      }
      return jsonResponse({ success: true, data: { items: [], total: 0 } });
    };

    const adapter = new AionCoreAdapter(
      new WorkspacePersistenceManager(new MemoryOnlyStorageDriver()),
      { fetchFn, wsFactory, readCookie: () => 'csrf_ws_test' },
    );
    await adapter.loadWorkspace();
    await adapter.core.checkHealth();
    await adapter.core.checkAuthStatus();
    await adapter.core.refreshCoreCatalog();

    const proj = await adapter.createProject({
      name: 'POCs',
      description: 'Ideias',
      workspacePathInfo: 'C:/llm/POCs',
    });
    const conv = await adapter.createConversation({
      projectId: proj.id,
      title: 'Calculadora Romana',
      presetId: '__empty__',
    });
    activeConvId = conv.conversation.id;

    const connections = adapter.getStateSnapshot().connections;
    const agyConn = connections.find(
      (c) =>
        c.id.includes('antigravity') ||
        c.displayName.toLowerCase().includes('antigravity'),
    )!;
    const curConn = connections.find(
      (c) =>
        c.id.includes('cursor') ||
        c.displayName.toLowerCase().includes('cursor'),
    )!;
    expect(agyConn).toBeTruthy();
    expect(curConn).toBeTruthy();

    const agyModel = agyConn.availableModels[0]!;
    const curModel = curConn.availableModels[0]!;

    const lead = await adapter.addParticipantToConversation(
      conv.conversation.id,
      {
        displayName: 'Hydrogen',
        roles: ['coordinator'],
        connectionId: agyConn.id,
        modelRef: {
          externalId: agyModel.externalId,
          displayName: agyModel.displayName,
          source: 'core_catalog',
          confirmation: 'confirmed',
        },
        instructions: 'Coordenar.',
      },
    );
    await adapter.addParticipantToConversation(conv.conversation.id, {
      displayName: 'Composer 2.5',
      roles: ['executor'],
      connectionId: curConn.id,
      modelRef: {
        externalId: curModel.externalId,
        displayName: curModel.displayName,
        source: 'core_catalog',
        confirmation: 'confirmed',
      },
      instructions: 'Implementar.',
    });

    await adapter.core.createCoreTeamForConversation(conv.conversation.id);

    // Send prompt while WebSocket is still disconnected (reproducing reported bug)
    await adapter.sendMessage({
      conversationId: conv.conversation.id,
      targetTab: 'general',
      bodyMarkdown: 'Crie calculadora romana PWA',
      promoteToSharedContext: false,
    });
    expect(adapter.getStateSnapshot().conversations[conv.conversation.id]?.tasks).toHaveLength(0);

    // First WebSocket connection: must catch up pending enqueued_core turn AND map slot state 'working' -> 'running'
    await adapter.core.ensureWebSocketConnected!(conv.conversation.id);
    expect(sockets).toHaveLength(1);
    sockets[0]!.open();
    await flushMicrotasks();

    const afterCatchup =
      adapter.getStateSnapshot().conversations[conv.conversation.id]!;
    const leadParticipant = afterCatchup.participants.find(
      (p) => p.id === lead.id,
    );
    expect(leadParticipant?.status).toBe('running');
    expect(afterCatchup.tasks).toHaveLength(2);
    expect(afterCatchup.tasks.map((t) => t.title)).toEqual([
      'Estruturar projeto HTML5/PWA',
      'Implementar conversor romano',
    ]);
    expect(
      afterCatchup.messagesByTab[lead.id]?.some((m) =>
        m.bodyMarkdown.includes('Plano preparado.'),
      ),
    ).toBe(true);

    // Calling ensureWebSocketConnected again while open must reuse existing socket
    await adapter.core.ensureWebSocketConnected!(conv.conversation.id);
    expect(sockets).toHaveLength(1);

    // Live WebSocket slotWorkUpdated with state 'working' keeps participant 'running', then 'idle' clears it
    sockets[0]!.emitMessage({
      name: 'team.slotWorkUpdated',
      data: {
        team_id: 'team_calc',
        slot_id: 'slot_lead',
        state: 'idle',
      },
    });
    currentRunState = 'idle';
    sockets[0]!.emitMessage({
      name: 'team.slotWorkUpdated',
      data: {
        team_id: 'team_calc',
        slot_id: 'slot_lead',
        state: 'working',
      },
    });
    await flushMicrotasks();
    const afterWsWorking =
      adapter.getStateSnapshot().conversations[conv.conversation.id]!;
    expect(
      afterWsWorking.participants.find((p) => p.id === lead.id)?.status,
    ).toBe('running');
  });

  it('probeCoreSessionOnStartup automatically ensures WebSocket connection when Core session is authenticated', async () => {
    const ensureWs = vi.fn(async () => {});
    const connectWs = vi.fn(async () => {});
    const coreMock: Partial<CoreGatewayOperations> = {
      checkHealth: vi.fn(async () => ({ reachable: true, message: 'ok' })),
      checkAuthStatus: vi.fn(async () => ({
        authenticated: true,
        username: 'admin',
        message: 'ok',
      })),
      refreshCoreCatalog: vi.fn(async () => ({
        connectionsUpdated: 1,
        assistantsCount: 1,
        agentsCount: 1,
        message: 'ok',
      })),
      ensureWebSocketConnected: ensureWs,
      connectWebSocket: connectWs,
    };
    const gatewayMock = {
      kind: 'aion_core',
      core: coreMock as CoreGatewayOperations,
    } as AgentWorkspaceGateway;

    await probeCoreSessionOnStartup(gatewayMock, () => true);
    expect(coreMock.refreshCoreCatalog).toHaveBeenCalledTimes(1);
    expect(ensureWs).toHaveBeenCalledTimes(1);
    expect(connectWs).not.toHaveBeenCalled();
  });
});
