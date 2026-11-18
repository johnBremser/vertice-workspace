import { describe, expect, it, vi } from 'vitest';
import { INTERNAL_PROTOCOL_VERSION } from '../../domain/internalProtocol';
import { AionCoreAdapter } from '../aionCoreAdapter';
import type { WebSocketFactory, WsLike } from '../aionCoreTransport';
import { GatewayCapabilityError } from '../gateway';
import {
  MemoryOnlyStorageDriver,
  WorkspacePersistenceManager,
} from '../storage';
import {
  REAL_CORE_AGENTS_MANAGEMENT_V022,
  REAL_CORE_ASSISTANTS_V022,
  REAL_CORE_AUTH_STATUS_V022,
  REAL_CORE_HEALTH_V022,
  buildRealCapturedConversationMessagesResponse,
  buildRealMessageStreamFrame,
  buildRealSlotWorkChangedEvent,
  buildRealTeamChildTurnEvent,
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
  readonly url: string;
  readonly protocols?: string | string[];
  closeCalls: { code?: number; reason?: string }[] = [];

  constructor(url: string, protocols?: string | string[]) {
    this.url = url;
    this.protocols = protocols;
    queueMicrotask(() => {
      this.onopen?.(new Event('open'));
    });
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.readyState = 3;
    this.closeCalls.push({ code, reason });
  }

  emitMessage(payload: unknown): void {
    this.onmessage?.({
      data: JSON.stringify(payload),
    } as MessageEvent);
  }

  emitClose(code: number, reason = ''): void {
    this.readyState = 3;
    this.onclose?.({ code, reason } as CloseEvent);
  }
}

describe('AionCoreAdapter HTTP/CSRF/Refresh/WS & Collaboration Pipeline integration tests (mocked Core contracts from commit 503a8719)', () => {
  it('handles native Core WS events (team.slotWorkChanged, message.stream, team.childTurnStarted/Completed/Cancelled, team.runFailed, team.taskChanged, team.mailboxChanged), enforces multi-conversation isolation, and deduplicates redeliveries', async () => {
    const calls: {
      method: string;
      url: string;
      headers: Record<string, string>;
      body?: unknown;
    }[] = [];
    const sockets: MockSocket[] = [];
    const csrfCookieValue = 'csrf_token_abc123';
    let teamCounter = 0;

    const fetchFn = async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      const hdrs = (init?.headers ?? {}) as Record<string, string>;
      const parsedBody =
        typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      calls.push({ method, url, headers: hdrs, body: parsedBody });

      if (url.endsWith('/health') && method === 'GET') {
        return jsonResponse({
          status: 'ok',
          version: '0.2.2',
          build_time: '2026-11-16',
        });
      }
      if (url.endsWith('/api/auth/status') && method === 'GET') {
        return jsonResponse({
          success: true,
          needs_setup: false,
          user_count: 1,
          is_authenticated: true,
        });
      }
      if (url.endsWith('/api/agents/management') && method === 'GET') {
        return jsonResponse({
          success: true,
          data: [
            {
              id: 'codex',
              name: 'Codex CLI',
              backend: 'codex',
              installed: true,
              enabled: true,
              status: 'ready',
              available_models: ['terra-6.1', 'sol-6.1'],
            },
            {
              id: 'antigravity',
              name: 'Antigravity',
              backend: 'antigravity',
              installed: true,
              enabled: true,
              status: 'ready',
              available_models: ['gemini-hydrogen'],
            },
          ],
        });
      }
      if (url.endsWith('/api/assistants') && method === 'GET') {
        return jsonResponse({
          success: true,
          data: [
            {
              id: 'asst_codex_1',
              name: 'Codex',
              backend: 'codex',
              agent_id: 'codex',
              enabled: true,
              available_models: ['terra-6.1', 'sol-6.1'],
              agent_installed: true,
              agent_status: 'ready',
              team_selectable: true,
            },
            {
              id: 'asst_anti_1',
              name: 'Antigravity',
              backend: 'antigravity',
              agent_id: 'antigravity',
              enabled: true,
              available_models: ['gemini-hydrogen'],
              agent_installed: true,
              agent_status: 'ready',
              team_selectable: true,
            },
          ],
        });
      }
      if (url.endsWith('/api/teams') && method === 'POST') {
        teamCounter += 1;
        const suffix = teamCounter === 1 ? 'A' : 'B';
        return jsonResponse({
          success: true,
          data: {
            id: `team_real_${suffix}`,
            name: `Time ${suffix}`,
            assistants: [
              {
                slot_id: `slot_terra_${suffix}`,
                conversation_id: `ext_conv_terra_${suffix}`,
                name: 'Terra 6.1',
                role: 'lead',
                model: 'terra-6.1',
              },
              {
                slot_id: `slot_gemini_${suffix}`,
                conversation_id: `ext_conv_gemini_${suffix}`,
                name: 'Gemini Hydrogen',
                role: 'teammate',
                model: 'gemini-hydrogen',
              },
            ],
          },
        });
      }
      if (url.includes('/messages') && method === 'POST') {
        return jsonResponse({
          success: true,
          data: {
            message_id: `msg_core_${calls.length}`,
            enqueue_status: 'queued',
            run: { team_run_id: `run_${calls.length}`, status: 'queued' },
          },
        });
      }
      if (url.endsWith('/api/ws-token') && method === 'GET') {
        return jsonResponse({
          success: true,
          ws_token: 'ws_jwt_xyz',
          expires_in: 300,
        });
      }
      return jsonResponse({ success: false, msg: 'not found' }, 404);
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
      baseUrl: 'http://127.0.0.1:25808',
      fetchFn,
      wsFactory,
      readCookie: (name) =>
        name === 'aionui-csrf-token' ? csrfCookieValue : undefined,
    });

    await adapter.loadWorkspace();
    expect((await adapter.checkHealth()).reachable).toBe(true);
    expect((await adapter.checkAuthStatus()).authenticated).toBe(true);
    await adapter.refreshCoreCatalog();

    const conns = adapter.getStateSnapshot().connections;
    const codexConn = conns.find((c) => c.coreAssistantId === 'asst_codex_1')!;
    const antiConn = conns.find((c) => c.coreAssistantId === 'asst_anti_1')!;

    const proj = await adapter.createProject({
      name: 'Core Real Project',
      description: 'Teste isolamento e WS real',
      workspacePathInfo: 'C:/repo',
    });

    const createTwoMemberConv = async (title: string) =>
      adapter.createConversation({
        projectId: proj.id,
        title,
        customMembers: [
          {
            connectionId: codexConn.id,
            displayName: 'Terra 6.1',
            roles: ['coordinator'],
            modelRef: {
              externalId: 'terra-6.1',
              displayName: 'terra-6.1',
              source: 'core_catalog',
              confirmation: 'confirmed',
            },
            instructions: 'Coordenar.',
          },
          {
            connectionId: antiConn.id,
            displayName: 'Gemini Hydrogen',
            roles: ['executor'],
            modelRef: {
              externalId: 'gemini-hydrogen',
              displayName: 'gemini-hydrogen',
              source: 'core_catalog',
              confirmation: 'confirmed',
            },
            instructions: 'Executar.',
          },
        ],
      });

    const convA = await createTwoMemberConv('Conversa A');
    const convB = await createTwoMemberConv('Conversa B');
    await adapter.createCoreTeamForConversation(convA.conversation.id);
    await adapter.createCoreTeamForConversation(convB.conversation.id);

    // Strict POST /api/teams DTO (no backend field + CSRF header)
    const createTeamCall = calls.find(
      (c) => c.method === 'POST' && c.url.endsWith('/api/teams'),
    )!;
    expect(createTeamCall.headers['x-csrf-token']).toBe('csrf_token_abc123');
    const reqBody = createTeamCall.body as {
      agents: Record<string, unknown>[];
    };
    expect('backend' in reqBody.agents[0]).toBe(false);

    // Focus Conversa A on General and send message -> ACK must NOT complete anything
    adapter.setActiveView({
      conversationId: convA.conversation.id,
      tabId: 'general',
    });
    await adapter.sendMessage({
      conversationId: convA.conversation.id,
      targetTab: 'general',
      bodyMarkdown: 'Organizar entrega A',
    });
    expect(
      adapter.getStateSnapshot().conversations[convA.conversation.id]
        .messagesByTab.general[0].delivery?.status,
    ).toBe('enqueued_core');

    await adapter.connectWebSocket(convA.conversation.id);
    expect(sockets).toHaveLength(1);
    expect(sockets[0].protocols).toEqual(['ws_jwt_xyz']);

    const geminiA = adapter
      .getStateSnapshot()
      .conversations[convA.conversation.id].participants.find(
        (p) => p.displayName === 'Gemini Hydrogen',
      )!;
    const geminiB = adapter
      .getStateSnapshot()
      .conversations[convB.conversation.id].participants.find(
        (p) => p.displayName === 'Gemini Hydrogen',
      )!;

    // 1. Real producer event: `team.slotWorkChanged` (camelCase from events.rs:39)
    sockets[0].emitMessage({
      name: 'team.slotWorkChanged',
      data: {
        slot_work: {
          team_id: 'team_real_A',
          slot_id: 'slot_gemini_A',
          state: 'running',
          active_turn_id: 'turn_A1',
          team_run_id: 'run_1',
        },
      },
    });
    expect(
      adapter
        .getStateSnapshot()
        .conversations[convA.conversation.id].participants.find(
          (p) => p.id === geminiA.id,
        )?.status,
    ).toBe('running');

    // 2. Real producer event: `message.stream` deltas + finish (stream_relay.rs + TextEventData)
    sockets[0].emitMessage({
      name: 'message.stream',
      data: {
        conversation_id: 'ext_conv_gemini_A',
        msg_id: 'ws_msg_stream_A1',
        turn_id: 'turn_A1',
        type: 'content',
        data: { content: 'Parte 1 ' },
      },
    });
    sockets[0].emitMessage({
      name: 'message.stream',
      data: {
        conversation_id: 'ext_conv_gemini_A',
        msg_id: 'ws_msg_stream_A1',
        turn_id: 'turn_A1',
        type: 'content',
        data: { content: 'e Parte 2.' },
      },
    });
    sockets[0].emitMessage({
      name: 'message.stream',
      data: {
        conversation_id: 'ext_conv_gemini_A',
        msg_id: 'ws_msg_stream_A1',
        turn_id: 'turn_A1',
        type: 'finish',
        data: {},
      },
    });

    // Redeliver exact same msg_id after finish -> MUST NOT duplicate or double-increment unread!
    sockets[0].emitMessage({
      name: 'message.stream',
      data: {
        conversation_id: 'ext_conv_gemini_A',
        msg_id: 'ws_msg_stream_A1',
        turn_id: 'turn_A1',
        type: 'content',
        data: { content: 'Parte duplicada!' },
      },
    });
    sockets[0].emitMessage({
      name: 'message.stream',
      data: {
        conversation_id: 'ext_conv_gemini_A',
        msg_id: 'ws_msg_stream_A1',
        turn_id: 'turn_A1',
        type: 'finish',
        data: {},
      },
    });

    const convAAfter =
      adapter.getStateSnapshot().conversations[convA.conversation.id];
    const msgsA = convAAfter.messagesByTab[geminiA.id];
    expect(msgsA).toHaveLength(1);
    expect(msgsA[0].bodyMarkdown).toBe('Parte 1 e Parte 2.');
    expect(msgsA[0].originSource).toBe('aion_core');
    expect(
      convAAfter.participants.find((p) => p.id === geminiA.id)?.unreadCount,
    ).toBe(1);

    // 3. Isolation: message.stream carrying ext_conv_gemini_B must route ONLY to Conv B!
    sockets[0].emitMessage({
      name: 'message.stream',
      data: {
        conversation_id: 'ext_conv_gemini_B',
        msg_id: 'ws_msg_stream_B1',
        turn_id: 'turn_B1',
        type: 'content',
        data: { content: 'Mensagem isolada B' },
      },
    });
    sockets[0].emitMessage({
      name: 'message.stream',
      data: {
        conversation_id: 'ext_conv_gemini_B',
        msg_id: 'ws_msg_stream_B1',
        turn_id: 'turn_B1',
        type: 'finish',
        data: {},
      },
    });

    expect(
      adapter.getStateSnapshot().conversations[convA.conversation.id]
        .messagesByTab[geminiA.id],
    ).toHaveLength(1);
    expect(
      adapter.getStateSnapshot().conversations[convB.conversation.id]
        .messagesByTab[geminiB.id],
    ).toHaveLength(1);
    expect(
      adapter.getStateSnapshot().conversations[convB.conversation.id]
        .messagesByTab[geminiB.id][0].bodyMarkdown,
    ).toBe('Mensagem isolada B');

    // 4. Native `team.childTurnStarted` + partial stream + `team.childTurnCancelled`
    // MUST close open stream buffer WITHOUT publishing delivery, cancel cleanly, and dedupe redelivery!
    sockets[0].emitMessage({
      name: 'team.childTurnStarted',
      data: {
        team_id: 'team_real_A',
        team_run_id: 'run_cancel_A',
        slot_id: 'slot_gemini_A',
        role: 'teammate',
        conversation_id: 'ext_conv_gemini_A',
        turn_id: 'turn_cancel_A1',
        status: 'running',
      },
    });
    expect(
      adapter
        .getStateSnapshot()
        .conversations[convA.conversation.id].participants.find(
          (p) => p.id === geminiA.id,
        )?.status,
    ).toBe('running');

    sockets[0].emitMessage({
      name: 'message.stream',
      data: {
        conversation_id: 'ext_conv_gemini_A',
        msg_id: 'ws_msg_cancelled_A',
        turn_id: 'turn_cancel_A1',
        type: 'content',
        data: { content: 'Trecho parcial antes de cancelar' },
      },
    });
    sockets[0].emitMessage({
      name: 'team.childTurnCancelled',
      data: {
        team_id: 'team_real_A',
        team_run_id: 'run_cancel_A',
        slot_id: 'slot_gemini_A',
        role: 'teammate',
        conversation_id: 'ext_conv_gemini_A',
        turn_id: 'turn_cancel_A1',
        status: 'cancelled',
        reason: 'substituido por nova instrucao',
        replacement_message_id: 'msg_repl_99',
      },
    });
    // Late finish after cancellation or redelivered cancellation MUST NOT publish delivery or duplicate logs!
    sockets[0].emitMessage({
      name: 'message.stream',
      data: {
        conversation_id: 'ext_conv_gemini_A',
        msg_id: 'ws_msg_cancelled_A',
        turn_id: 'turn_cancel_A1',
        type: 'finish',
        data: {},
      },
    });
    sockets[0].emitMessage({
      name: 'team.childTurnCancelled',
      data: {
        team_id: 'team_real_A',
        team_run_id: 'run_cancel_A',
        slot_id: 'slot_gemini_A',
        role: 'teammate',
        conversation_id: 'ext_conv_gemini_A',
        turn_id: 'turn_cancel_A1',
        status: 'cancelled',
        reason: 'substituido por nova instrucao',
        replacement_message_id: 'msg_repl_99',
      },
    });

    const convAAfterCancel =
      adapter.getStateSnapshot().conversations[convA.conversation.id];
    expect(
      convAAfterCancel.participants.find((p) => p.id === geminiA.id)?.status,
    ).toBe('idle');
    expect(
      convAAfterCancel.seenEventIds.includes(
        `evt_core_msg_final_${convA.conversation.id}_ws_msg_cancelled_A`,
      ),
    ).toBe(false);
    expect(
      convAAfterCancel.generalFeed.some(
        (g) =>
          g.kind === 'delivery_summary' &&
          g.summary.includes('Trecho parcial antes de cancelar'),
      ),
    ).toBe(false);
    expect(
      convAAfterCancel.generalFeed.filter((g) =>
        g.summary.includes('substituido por nova instrucao'),
      ),
    ).toHaveLength(1);

    // 5. Native `team.childTurnCompleted` with `status: 'failed'` -> records failure once (deduped)
    sockets[0].emitMessage({
      name: 'team.childTurnCompleted',
      data: {
        team_id: 'team_real_A',
        team_run_id: 'run_fail_turn_A',
        slot_id: 'slot_gemini_A',
        role: 'teammate',
        conversation_id: 'ext_conv_gemini_A',
        turn_id: 'turn_fail_A1',
        status: 'failed',
        reason: 'cli exit code 1',
      },
    });
    sockets[0].emitMessage({
      name: 'team.childTurnCompleted',
      data: {
        team_id: 'team_real_A',
        team_run_id: 'run_fail_turn_A',
        slot_id: 'slot_gemini_A',
        role: 'teammate',
        conversation_id: 'ext_conv_gemini_A',
        turn_id: 'turn_fail_A1',
        status: 'failed',
        reason: 'cli exit code 1',
      },
    });
    const convAAfterTurnFail =
      adapter.getStateSnapshot().conversations[convA.conversation.id];
    expect(
      convAAfterTurnFail.participants.find((p) => p.id === geminiA.id)?.status,
    ).toBe('failed');
    expect(
      convAAfterTurnFail.generalFeed.filter((g) =>
        g.summary.includes('cli exit code 1'),
      ),
    ).toHaveLength(1);

    // 6. Native `team.runFailed` (`TeamRunPayload`: only `team_id` + `target_slot_id` + `slot_work[]`, NO top-level `slot_id`/`conversation_id`)
    // Also verify `team_id: 'team_real_B'` routes ONLY to Conv B and unknown `team_id` is ignored!
    sockets[0].emitMessage({
      name: 'team.runFailed',
      data: {
        team_id: 'team_unknown_Z',
        team_run_id: 'run_unknown_Z',
        source: 'user_message',
        has_user_intervention: true,
        target_slot_id: 'slot_gemini_A',
        target_role: 'teammate',
        status: 'failed',
        queued_intent_count: 0,
        starting_batch_count: 0,
        running_batch_count: 0,
        active_enqueue_lease_count: 0,
        slot_work: [],
      },
    });
    expect(
      adapter.getStateSnapshot().conversations[convA.conversation.id]
        .conversation.executionStatus,
    ).not.toBe('failed');

    sockets[0].emitMessage({
      name: 'team.runFailed',
      data: {
        team_id: 'team_real_B',
        team_run_id: 'run_failed_B1',
        source: 'user_message',
        has_user_intervention: true,
        target_slot_id: 'slot_gemini_B',
        target_role: 'teammate',
        status: 'failed',
        queued_intent_count: 0,
        starting_batch_count: 0,
        running_batch_count: 0,
        active_enqueue_lease_count: 0,
        slot_work: [
          {
            slot_id: 'slot_gemini_B',
            role: 'teammate',
            state: 'idle',
            queued_foreground_count: 0,
            queued_background_count: 0,
          },
        ],
      },
    });
    // Redeliver exact same team.runFailed -> must not duplicate!
    sockets[0].emitMessage({
      name: 'team.runFailed',
      data: {
        team_id: 'team_real_B',
        team_run_id: 'run_failed_B1',
        source: 'user_message',
        has_user_intervention: true,
        target_slot_id: 'slot_gemini_B',
        target_role: 'teammate',
        status: 'failed',
        queued_intent_count: 0,
        starting_batch_count: 0,
        running_batch_count: 0,
        active_enqueue_lease_count: 0,
        slot_work: [],
      },
    });

    const convBAfterRunFail =
      adapter.getStateSnapshot().conversations[convB.conversation.id];
    expect(convBAfterRunFail.conversation.executionStatus).toBe('failed');
    expect(
      convBAfterRunFail.participants.find((p) => p.id === geminiB.id)?.status,
    ).toBe('failed');
    expect(
      convBAfterRunFail.generalFeed.filter((g) =>
        g.summary.includes('run_failed_B1'),
      ),
    ).toHaveLength(1);
    // Conv A remains isolated from Conv B's team.runFailed
    expect(
      adapter.getStateSnapshot().conversations[convA.conversation.id]
        .conversation.executionStatus,
    ).not.toBe('failed');

    adapter.dispose();
  });

  it('runs complete Terra 6.1 / Sol 6.1 / Gemini Hydrogen Core pipeline (instructions, SharedContext receipts, structured plan/delivery/review, escalation gate, invalid output fallback) without Claude', async () => {
    const outgoingPosts: { url: string; content: string }[] = [];
    const sockets: MockSocket[] = [];
    let msgSeq = 0;

    const fetchFn = async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      const parsedBody =
        typeof init?.body === 'string'
          ? (JSON.parse(init.body) as Record<string, unknown>)
          : undefined;

      if (url.endsWith('/api/agents/management') && method === 'GET') {
        return jsonResponse({
          success: true,
          data: [
            {
              id: 'codex',
              name: 'Codex',
              backend: 'codex',
              installed: true,
              enabled: true,
              status: 'ready',
              available_models: ['terra-6.1', 'sol-6.1'],
            },
            {
              id: 'antigravity',
              name: 'Antigravity',
              backend: 'antigravity',
              installed: true,
              enabled: true,
              status: 'ready',
              available_models: ['gemini-hydrogen'],
            },
          ],
        });
      }
      if (url.endsWith('/api/assistants') && method === 'GET') {
        return jsonResponse({
          success: true,
          data: [
            {
              id: 'asst_codex',
              name: 'Codex',
              backend: 'codex',
              agent_id: 'codex',
              enabled: true,
              available_models: ['terra-6.1', 'sol-6.1'],
              agent_installed: true,
              agent_status: 'ready',
              team_selectable: true,
            },
            {
              id: 'asst_anti',
              name: 'Antigravity',
              backend: 'antigravity',
              agent_id: 'antigravity',
              enabled: true,
              available_models: ['gemini-hydrogen'],
              agent_installed: true,
              agent_status: 'ready',
              team_selectable: true,
            },
          ],
        });
      }
      if (url.endsWith('/api/teams') && method === 'POST') {
        return jsonResponse({
          success: true,
          data: {
            id: 'team_pipe_1',
            name: 'Terra Sol Gemini Core',
            assistants: [
              {
                slot_id: 'slot_terra',
                conversation_id: 'ext_c_terra',
                name: 'Terra 6.1',
                role: 'lead',
                model: 'terra-6.1',
              },
              {
                slot_id: 'slot_sol',
                conversation_id: 'ext_c_sol',
                name: 'Sol 6.1',
                role: 'teammate',
                model: 'sol-6.1',
              },
              {
                slot_id: 'slot_gemini',
                conversation_id: 'ext_c_gemini',
                name: 'Gemini Hydrogen',
                role: 'teammate',
                model: 'gemini-hydrogen',
              },
            ],
          },
        });
      }
      if (url.includes('/messages') && method === 'POST') {
        msgSeq += 1;
        outgoingPosts.push({
          url,
          content: String(parsedBody?.content ?? ''),
        });
        return jsonResponse({
          success: true,
          data: {
            message_id: `ack_msg_${msgSeq}`,
            enqueue_status: 'queued',
            run: { team_run_id: `run_pipe_${msgSeq}`, status: 'queued' },
          },
        });
      }
      if (url.endsWith('/api/ws-token') && method === 'GET') {
        return jsonResponse({
          success: true,
          ws_token: 'ws_tok_pipe',
          expires_in: 300,
        });
      }
      if (url.includes('/agents/') && url.endsWith('/model') && method === 'PATCH') {
        return jsonResponse({ success: true, data: { updated: true } });
      }
      return jsonResponse({ success: false }, 404);
    };

    const wsFactory: WebSocketFactory = (url, protocols) => {
      const s = new MockSocket(url, protocols);
      sockets.push(s);
      return s;
    };

    const persistence = new WorkspacePersistenceManager(
      new MemoryOnlyStorageDriver(),
    );
    const adapter = new AionCoreAdapter(persistence, {
      baseUrl: 'http://127.0.0.1:25808',
      fetchFn,
      wsFactory,
      readCookie: () => 'csrf_pipe',
    });

    await adapter.loadWorkspace();
    await adapter.refreshCoreCatalog();
    await adapter.updateModelPolicy({
      defaultExecutorTier: 'fast',
      reviewerTier: 'review',
      escalationTargetTier: 'advanced',
      qualityRejectionsBeforeSuggest: 1,
      approvalMode: 'manual',
    });

    const conns = adapter.getStateSnapshot().connections;
    const codexConn = conns.find((c) => c.coreAssistantId === 'asst_codex')!;
    const antiConn = conns.find((c) => c.coreAssistantId === 'asst_anti')!;

    const proj = await adapter.createProject({
      name: 'Projeto Pipe Core',
      description: 'Fluxo completo sem Claude',
      workspacePathInfo: 'C:/repo/pipe',
    });

    const conv = await adapter.createConversation({
      projectId: proj.id,
      title: 'Pipeline Core Configurável',
      customMembers: [
        {
          connectionId: codexConn.id,
          displayName: 'Terra 6.1',
          roles: ['coordinator'],
          modelRef: {
            externalId: 'terra-6.1',
            displayName: 'terra-6.1',
            source: 'core_catalog',
            confirmation: 'confirmed',
          },
          instructions: 'INSTR_TERRA_COORD',
        },
        {
          connectionId: codexConn.id,
          displayName: 'Sol 6.1',
          roles: ['planner', 'reviewer'],
          modelRef: {
            externalId: 'sol-6.1',
            displayName: 'sol-6.1',
            source: 'core_catalog',
            confirmation: 'confirmed',
          },
          instructions: 'INSTR_SOL_AUDITOR',
        },
        {
          connectionId: antiConn.id,
          displayName: 'Gemini Hydrogen',
          roles: ['executor'],
          modelRef: {
            externalId: 'gemini-hydrogen',
            displayName: 'gemini-hydrogen',
            source: 'core_catalog',
            confirmation: 'confirmed',
          },
          instructions: 'INSTR_GEMINI_EXECUTOR',
        },
      ],
    });

    expect(
      conv.participants.some((p) =>
        p.displayName.toLowerCase().includes('claude'),
      ),
    ).toBe(false);

    const convId = conv.conversation.id;
    await adapter.createCoreTeamForConversation(convId);
    await adapter.connectWebSocket(convId);
    const sock = sockets[0];

    const streamTurn = (
      extConvId: string,
      msgId: string,
      turnId: string,
      content: string,
    ) => {
      sock.emitMessage({
        name: 'message.stream',
        data: {
          conversation_id: extConvId,
          msg_id: msgId,
          turn_id: turnId,
          type: 'content',
          data: { content },
        },
      });
      sock.emitMessage({
        name: 'message.stream',
        data: {
          conversation_id: extConvId,
          msg_id: msgId,
          turn_id: turnId,
          type: 'finish',
          data: {},
        },
      });
    };

    // 1. User sends prompt with promoteToSharedContext=true
    await adapter.sendMessage({
      conversationId: convId,
      targetTab: 'general',
      bodyMarkdown: 'Implementar busca segura em listagem com 2 etapas',
      promoteToSharedContext: true,
    });

    // Verify composed payload sent to Core contains custom instructions, roster & SharedContext v1,
    // while UI stores original raw user text cleanly!
    expect(outgoingPosts[0].content).toContain('INSTR_TERRA_COORD');
    expect(outgoingPosts[0].content).toContain('[Contexto Compartilhado v1');
    expect(outgoingPosts[0].content).toContain('plan_proposal');
    const stateAfterPrompt = adapter.getStateSnapshot().conversations[convId];
    expect(stateAfterPrompt.messagesByTab.general[0].bodyMarkdown).toBe(
      'Implementar busca segura em listagem com 2 etapas',
    );
    const terraPart = stateAfterPrompt.participants.find(
      (p) => p.displayName === 'Terra 6.1',
    )!;
    const geminiPart = stateAfterPrompt.participants.find(
      (p) => p.displayName === 'Gemini Hydrogen',
    )!;
    const solPart = stateAfterPrompt.participants.find(
      (p) => p.displayName === 'Sol 6.1',
    )!;
    expect(
      stateAfterPrompt.contextRevisions[0].receipts[terraPart.id]?.status,
    ).toBe('sent');

    // 2. Terra 6.1 responds with structured plan_proposal (2 chained tasks)
    const planPayload = {
      kind: 'plan_proposal',
      protocol: INTERNAL_PROTOCOL_VERSION,
      conversationId: convId,
      summary: 'Plano em duas tarefas sequenciais',
      tasks: [
        {
          title: 'Etapa 1: Implementar filtro',
          description: 'Adicionar filtro case-insensitive',
          assigneeRole: 'executor',
          dependencies: [],
          acceptanceCriteria: ['Filtro funciona'],
        },
        {
          title: 'Etapa 2: Validar desempenho',
          description: 'Conferir latência',
          assigneeRole: 'executor',
          dependencies: ['task_1'],
          acceptanceCriteria: ['Latência < 50ms'],
        },
      ],
    };
    streamTurn(
      'ext_c_terra',
      'm_plan_1',
      't_plan_1',
      `Plano estruturado:\n\`\`\`aion-desk-json\n${JSON.stringify(planPayload)}\n\`\`\``,
    );

    // Wait for background auto-dispatch of Task 1 to Gemini Hydrogen
    await vi.waitFor(() => {
      expect(
        outgoingPosts.some((p) => p.url.includes('/agents/slot_gemini/messages')),
      ).toBe(true);
    });

    const afterPlanState = adapter.getStateSnapshot().conversations[convId];
    expect(afterPlanState.tasks).toHaveLength(2);
    expect(afterPlanState.planRevisions).toHaveLength(1);
    const task1 = afterPlanState.tasks[0];
    const task2 = afterPlanState.tasks[1];
    expect(task2.dependencyTaskIds).toContain(task1.id);
    expect(
      afterPlanState.contextRevisions[0].receipts[terraPart.id]?.status,
    ).toBe('received');
    expect(
      afterPlanState.contextRevisions[0].receipts[geminiPart.id]?.status,
    ).toBe('sent');
    const geminiDispatch = outgoingPosts.find((p) =>
      p.url.includes('/agents/slot_gemini/messages'),
    )!;
    expect(geminiDispatch.content).toContain('INSTR_GEMINI_EXECUTOR');
    expect(geminiDispatch.content).toContain('[Contexto Compartilhado v1');

    // 3. Test invalid/free-text output first when delivery_report is expected -> MUST NOT complete task!
    streamTurn(
      'ext_c_gemini',
      'm_invalid_1',
      't_invalid_1',
      'Resposta livre sem bloco aion-desk-json.',
    );
    const afterInvalid = adapter.getStateSnapshot().conversations[convId];
    const invalidMsg = afterInvalid.messagesByTab[geminiPart.id].find(
      (m) => m.externalMessageId === 'm_invalid_1',
    )!;
    expect(invalidMsg.parseStatus).toBe('incomplete');
    expect(afterInvalid.tasks[0].status).toBe('running');

    // 4. Gemini delivers Attempt #1 validly -> triggers automatic review dispatch to Sol 6.1
    streamTurn(
      'ext_c_gemini',
      'm_deliv_1',
      't_deliv_1',
      `Entrega pronta.\n\`\`\`aion-desk-json\n${JSON.stringify({
        kind: 'delivery_report',
        protocol: INTERNAL_PROTOCOL_VERSION,
        conversationId: convId,
        taskId: task1.id,
        attemptId: task1.attempts[0].id,
        deliverySummary: 'Filtro inicial aplicado.',
        evidenceNotes: ['teste parcial ok'],
      })}\n\`\`\``,
    );

    await vi.waitFor(() => {
      expect(
        outgoingPosts.some((p) => p.url.includes('/agents/slot_sol/messages')),
      ).toBe(true);
    });
    const afterDeliv1 = adapter.getStateSnapshot().conversations[convId];
    expect(afterDeliv1.tasks[0].status).toBe('awaiting_review');
    expect(
      afterDeliv1.contextRevisions[0].receipts[geminiPart.id]?.status,
    ).toBe('applied');
    const solDispatch = outgoingPosts.find((p) =>
      p.url.includes('/agents/slot_sol/messages'),
    )!;
    expect(solDispatch.content).toContain('INSTR_SOL_AUDITOR');

    // 5. Sol 6.1 rejects Attempt #1 -> manual escalation pauses retry until user approves!
    streamTurn(
      'ext_c_sol',
      'm_rev_1',
      't_rev_1',
      `Reprovado.\n\`\`\`aion-desk-json\n${JSON.stringify({
        kind: 'review_decision',
        protocol: INTERNAL_PROTOCOL_VERSION,
        conversationId: convId,
        taskId: task1.id,
        attemptId: task1.attempts[0].id,
        decision: 'rejected',
        rationale: 'Falta sanitizar entrada vazia.',
        unmetCriteria: ['Tratar consulta vazia'],
      })}\n\`\`\``,
    );

    const afterReject = adapter.getStateSnapshot().conversations[convId];
    expect(afterReject.tasks[0].qualityRejectionCount).toBe(1);
    expect(afterReject.escalations).toHaveLength(1);
    expect(afterReject.escalations[0].status).toBe('suggested');
    // Still only 1 dispatch to Gemini (manual policy holds attempt #2!)
    expect(
      outgoingPosts.filter((p) => p.url.includes('/agents/slot_gemini/messages')),
    ).toHaveLength(1);

    // Approve escalation -> promotes Gemini tier and dispatches Attempt #2 with rejection feedback!
    await adapter.resolveEscalation({
      conversationId: convId,
      escalationId: afterReject.escalations[0].id,
      resolution: 'approved',
    });
    expect(
      outgoingPosts.filter((p) => p.url.includes('/agents/slot_gemini/messages')),
    ).toHaveLength(2);
    const attempt2Prompt = outgoingPosts.filter((p) =>
      p.url.includes('/agents/slot_gemini/messages'),
    )[1].content;
    expect(attempt2Prompt).toContain('Falta sanitizar entrada vazia.');

    const afterAtt2Start = adapter.getStateSnapshot().conversations[convId];
    expect(afterAtt2Start.tasks[0].attempts).toHaveLength(2);
    expect(
      afterAtt2Start.participants.find((p) => p.id === geminiPart.id)?.modelTier,
    ).toBe('advanced');

    // 6. Gemini delivers Attempt #2 -> Sol approves Task 1 -> Task 2 auto-dispatches -> delivered & approved!
    streamTurn(
      'ext_c_gemini',
      'm_deliv_2',
      't_deliv_2',
      `\`\`\`aion-desk-json\n${JSON.stringify({
        kind: 'delivery_report',
        protocol: INTERNAL_PROTOCOL_VERSION,
        conversationId: convId,
        taskId: task1.id,
        attemptId: afterAtt2Start.tasks[0].attempts[1].id,
        deliverySummary: 'Sanitização adicionada.',
        evidenceNotes: ['100% ok'],
      })}\n\`\`\``,
    );
    await vi.waitFor(() => {
      expect(
        outgoingPosts.filter((p) => p.url.includes('/agents/slot_sol/messages')),
      ).toHaveLength(2);
    });

    streamTurn(
      'ext_c_sol',
      'm_rev_2',
      't_rev_2',
      `\`\`\`aion-desk-json\n${JSON.stringify({
        kind: 'review_decision',
        protocol: INTERNAL_PROTOCOL_VERSION,
        conversationId: convId,
        taskId: task1.id,
        attemptId: afterAtt2Start.tasks[0].attempts[1].id,
        decision: 'approved',
        rationale: 'Critérios atendidos.',
        unmetCriteria: [],
      })}\n\`\`\``,
    );

    // Task 2 dispatches automatically to Gemini
    await vi.waitFor(() => {
      expect(
        outgoingPosts.filter((p) => p.url.includes('/agents/slot_gemini/messages')),
      ).toHaveLength(3);
    });
    const afterT2Start = adapter.getStateSnapshot().conversations[convId];
    expect(afterT2Start.tasks[0].status).toBe('completed');
    expect(afterT2Start.tasks[1].status).toBe('running');

    streamTurn(
      'ext_c_gemini',
      'm_deliv_t2',
      't_deliv_t2',
      `\`\`\`aion-desk-json\n${JSON.stringify({
        kind: 'delivery_report',
        protocol: INTERNAL_PROTOCOL_VERSION,
        conversationId: convId,
        taskId: task2.id,
        attemptId: afterT2Start.tasks[1].attempts[0].id,
        deliverySummary: 'Benchmark < 15ms.',
        evidenceNotes: ['benchmark ok'],
      })}\n\`\`\``,
    );
    await vi.waitFor(() => {
      expect(
        outgoingPosts.filter((p) => p.url.includes('/agents/slot_sol/messages')),
      ).toHaveLength(3);
    });

    streamTurn(
      'ext_c_sol',
      'm_rev_t2',
      't_rev_t2',
      `\`\`\`aion-desk-json\n${JSON.stringify({
        kind: 'review_decision',
        protocol: INTERNAL_PROTOCOL_VERSION,
        conversationId: convId,
        taskId: task2.id,
        attemptId: afterT2Start.tasks[1].attempts[0].id,
        decision: 'approved',
        rationale: 'Auditoria concluída.',
        unmetCriteria: [],
      })}\n\`\`\``,
    );

    await vi.waitFor(() => {
      expect(
        adapter.getStateSnapshot().conversations[convId].conversation
          .executionStatus,
      ).toBe('completed');
    });

    const completedConv = adapter.getStateSnapshot().conversations[convId];
    expect(completedConv.tasks.every((t) => t.status === 'completed')).toBe(
      true,
    );
    expect(solPart.id).toBeTruthy();
    expect(
      completedConv.generalFeed.some((g) => g.kind === 'completion'),
    ).toBe(true);

    adapter.dispose();
  });

  it('implements native Core catch-up (/run-state, /mailbox, /tasks, paginated /activity), preserves concurrent WS mutations, rejects unresolved identities honestly, and auto-reconciles on WS reconnect', async () => {
    const sockets: MockSocket[] = [];
    const activityUrlsCalled: string[] = [];
    let activityPage2ShouldFail = false;
    let injectUnresolvedMailboxIdentity = false;
    let injectUnresolvedTaskOwner = false;
    let delayTasksMs = 0;
    let reconcileFetchCount = 0;
    let tasksSnapshotStatus: 'in_progress' | 'completed' = 'completed';
    let tasksSnapshotUpdatedAt = 2000;

    const fetchFn = async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      if (url.endsWith('/api/ws-token')) {
        return jsonResponse({ success: true, ws_token: 'tok_cu', expires_in: 300 });
      }
      if (url.endsWith('/api/teams/team_cu/run-state')) {
        return jsonResponse({
          success: true,
          data: {
            session_generation: 'gen_1',
            active_run: null,
            slot_work: [
              {
                slot_id: 'slot_terra',
                role: 'lead',
                state: 'idle',
                queued_foreground_count: 0,
                queued_background_count: 0,
              },
              {
                slot_id: 'slot_sol',
                role: 'teammate',
                state: 'idle',
                queued_foreground_count: 0,
                queued_background_count: 0,
              },
              {
                slot_id: 'slot_gemini',
                role: 'teammate',
                state: 'running',
                queued_foreground_count: 0,
                queued_background_count: 0,
                active_turn_id: 'turn_cu_1',
              },
            ],
          },
        });
      }
      if (url.endsWith('/api/teams/team_cu/mailbox')) {
        reconcileFetchCount += 1;
        return jsonResponse({
          success: true,
          data: [
            {
              id: 'mb_missed_1',
              team_id: 'team_cu',
              from_agent_id: 'slot_gemini',
              to_agent_id: 'lead',
              msg_type: 'chat',
              content: 'Mensagem recuperada do /mailbox após queda.',
              summary: null,
              files: [],
              read: false,
              created_at: 1731780000100,
            },
            {
              id: 'mb_lead_1',
              team_id: 'team_cu',
              from_agent_id: 'lead',
              to_agent_id: 'slot_gemini',
              msg_type: 'task',
              content: 'Delegação enviada pelo coordenador no mailbox.',
              summary: null,
              files: [],
              read: true,
              created_at: 1731780000050,
            },
            ...(injectUnresolvedMailboxIdentity
              ? [
                  {
                    id: 'mb_unresolved_1',
                    team_id: 'team_cu',
                    from_agent_id: 'slot_fantasma',
                    to_agent_id: 'lead',
                    msg_type: 'chat',
                    content: 'Mensagem de agente desconhecido.',
                    summary: null,
                    files: [],
                    read: false,
                    created_at: 1731780000150,
                  },
                ]
              : []),
          ],
        });
      }
      if (url.endsWith('/api/teams/team_cu/tasks')) {
        if (delayTasksMs > 0) {
          await new Promise((r) => setTimeout(r, delayTasksMs));
        }
        return jsonResponse({
          success: true,
          data: [
            {
              id: 'task_existing_cu_1',
              team_id: 'team_cu',
              subject: 'Tarefa existente atualizada',
              description:
                tasksSnapshotUpdatedAt === 2500
                  ? 'Concluída via WS concorrente'
                  : 'Concluída no Core durante queda',
              status: tasksSnapshotStatus,
              owner: 'slot_gemini',
              blocked_by: [],
              blocks: ['task_core_cu_2'],
              created_at: 1000,
              updated_at: tasksSnapshotUpdatedAt,
            },
            {
              id: 'task_core_cu_2',
              team_id: 'team_cu',
              subject: 'Tarefa dependente do Core',
              description: 'Recuperada via /tasks com blocked_by e owner',
              status: 'pending',
              owner: 'slot_sol',
              blocked_by: ['task_existing_cu_1'],
              blocks: [],
              created_at: 1500,
              updated_at: 1600,
            },
            ...(injectUnresolvedTaskOwner
              ? [
                  {
                    id: 'task_unresolved_cu_3',
                    team_id: 'team_cu',
                    subject: 'Tarefa de dono desconhecido',
                    description: 'Owner inválido',
                    status: 'pending',
                    owner: 'owner_desconhecido',
                    blocked_by: [],
                    blocks: [],
                    created_at: 1550,
                    updated_at: 1650,
                  },
                ]
              : []),
          ],
        });
      }
      if (url.includes('/api/teams/team_cu/activity')) {
        activityUrlsCalled.push(url);
        const parsedUrl = new URL(url, 'http://127.0.0.1');
        const cursorTs = parsedUrl.searchParams.get('cursor_ts');
        const cursorId = parsedUrl.searchParams.get('cursor_id');

        if (!cursorTs && !cursorId) {
          // Page 1: contains nested `kind: 'message'` duplicating `mb_missed_1` + cursor to Page 2
          return jsonResponse({
            success: true,
            data: {
              items: [
                {
                  kind: 'message',
                  created_at: 1731780000100,
                  id: 'mb_missed_1',
                  message: {
                    id: 'mb_missed_1',
                    team_id: 'team_cu',
                    from_agent_id: 'slot_gemini',
                    to_agent_id: 'lead',
                    msg_type: 'chat',
                    content: 'Mensagem recuperada do /mailbox após queda.',
                    files: [],
                    read: false,
                    created_at: 1731780000100,
                  },
                },
              ],
              next_cursor: { ts: 1731780000100, id: 'mb_missed_1' },
              has_more: true,
            },
          });
        }

        if (cursorTs === '1731780000100' && cursorId === 'mb_missed_1') {
          if (activityPage2ShouldFail) {
            return jsonResponse({ success: false, message: 'page 2 error' }, 500);
          }
          // Page 2: returns a new message from `slot_sol` + an older task snapshot (updated_at: 1100 < 2000)
          return jsonResponse({
            success: true,
            data: {
              items: [
                {
                  kind: 'message',
                  created_at: 1731780000200,
                  id: 'mb_act_page2_sol',
                  message: {
                    id: 'mb_act_page2_sol',
                    team_id: 'team_cu',
                    from_agent_id: 'slot_sol',
                    to_agent_id: 'lead',
                    msg_type: 'chat',
                    content: 'Parecer recuperado da página 2 do /activity.',
                    files: [],
                    read: false,
                    created_at: 1731780000200,
                  },
                },
                {
                  kind: 'task',
                  created_at: 1000,
                  id: 'task_existing_cu_1',
                  task: {
                    id: 'task_existing_cu_1',
                    team_id: 'team_cu',
                    subject: 'Tarefa existente desatualizada',
                    description: 'Snapshot antigo em /activity',
                    status: 'in_progress',
                    owner: 'slot_gemini',
                    blocked_by: [],
                    blocks: [],
                    created_at: 1000,
                    updated_at: 1100,
                  },
                },
              ],
              next_cursor: null,
              has_more: false,
            },
          });
        }
        return jsonResponse({ success: false, message: 'cursor invalido' }, 400);
      }
      return jsonResponse({ success: false }, 404);
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
      baseUrl: 'http://127.0.0.1:25808',
      fetchFn,
      wsFactory,
      readCookie: () => 'csrf_cu',
    });

    await adapter.loadWorkspace();
    const proj = await adapter.createProject({
      name: 'Catch-up Project',
      description: '',
      workspacePathInfo: 'C:/cu',
    });
    const conv = await adapter.createConversation({
      projectId: proj.id,
      title: 'Conversa Catch-up',
      presetId: 'preset_terra_sol_gemini',
    });
    const cid = conv.conversation.id;
    const state = structuredClone(adapter.getStateSnapshot());
    state.conversations[cid].conversation.externalTeamId = 'team_cu';
    state.conversations[cid].participants[0].sessionRef.externalSlotId = 'slot_terra';
    state.conversations[cid].participants[0].sessionRef.externalConversationId = 'ext_cu_terra';
    state.conversations[cid].participants[1].sessionRef.externalSlotId = 'slot_sol';
    state.conversations[cid].participants[1].sessionRef.externalConversationId = 'ext_cu_sol';
    state.conversations[cid].participants[2].sessionRef.externalSlotId = 'slot_gemini';
    state.conversations[cid].participants[2].sessionRef.externalConversationId = 'ext_cu_gemini';
    // Pre-populate an existing running task to verify catch-up updates existing tasks idempotently
    state.conversations[cid].tasks = [
      {
        id: 'task_existing_cu_1',
        conversationId: cid,
        sourceRequestEventId: 'req_init',
        title: 'Tarefa existente inicial',
        description: 'Em andamento antes da queda',
        assigneeParticipantId: state.conversations[cid].participants[2].id,
        dependencyTaskIds: [],
        acceptanceCriteria: ['Critério 1'],
        status: 'running',
        attempts: [],
        reviews: [],
        operationalFailureCount: 0,
        qualityRejectionCount: 0,
        originSource: 'aion_core',
        externalUpdatedAtMs: 1000,
      },
    ];
    await adapter.importWorkspaceState(state);

    const terraId = state.conversations[cid].participants[0].id;
    const solId = state.conversations[cid].participants[1].id;
    const geminiId = state.conversations[cid].participants[2].id;
    await adapter.connectWebSocket(cid);
    expect(sockets).toHaveLength(1);

    // Case A: Page 2 of `/activity` fails (HTTP 500) -> MUST mark synced=false and syncState='incomplete'
    activityPage2ShouldFail = true;
    const page2FailRes = await adapter.reconcileConversation(cid);
    expect(page2FailRes.synced).toBe(false);
    const afterPage2Fail = adapter.getStateSnapshot().conversations[cid];
    expect(afterPage2Fail.conversation.syncState).toBe('incomplete');
    expect(afterPage2Fail.syncErrorNote).toContain('/activity');
    expect(
      activityUrlsCalled.some(
        (u) =>
          u.includes('cursor_ts=1731780000100') &&
          u.includes('cursor_id=mb_missed_1'),
      ),
    ).toBe(true);

    // Case B: Unresolved identity (`from_agent_id` or `owner`) MUST NOT silently fall back to coordinator!
    activityPage2ShouldFail = false;
    injectUnresolvedMailboxIdentity = true;
    injectUnresolvedTaskOwner = true;
    const unresolvedRes = await adapter.reconcileConversation(cid);
    expect(unresolvedRes.synced).toBe(false);
    const afterUnresolved = adapter.getStateSnapshot().conversations[cid];
    expect(afterUnresolved.conversation.syncState).toBe('incomplete');
    expect(afterUnresolved.syncErrorNote).toContain('slot_fantasma');
    expect(afterUnresolved.syncErrorNote).toContain('owner_desconhecido');
    expect(
      afterUnresolved.messagesByTab[terraId].some((m) =>
        m.bodyMarkdown.includes('Mensagem de agente desconhecido.'),
      ),
    ).toBe(false);
    expect(
      afterUnresolved.tasks.some((t) => t.id === 'task_unresolved_cu_3'),
    ).toBe(false);

    // Case C: Recover cleanly + preserve concurrent WS mutations (`team.taskChanged` + `message.stream`) during slow catch-up
    injectUnresolvedMailboxIdentity = false;
    injectUnresolvedTaskOwner = false;
    delayTasksMs = 30;
    tasksSnapshotStatus = 'in_progress';
    tasksSnapshotUpdatedAt = 1800;

    // Interrupted partial delta before reconnect
    sockets[0].emitMessage({
      name: 'message.stream',
      data: {
        conversation_id: 'ext_cu_gemini',
        msg_id: 'mb_missed_1',
        turn_id: 'turn_cu_1',
        type: 'content',
        data: { content: 'Delta incompleto...' },
      },
    });

    const reconcilePromise = adapter.reconcileConversation(cid);
    await new Promise((r) => setTimeout(r, 10));

    // Concurrent live WS task update + live WS stream arrive WHILE `/tasks` HTTP is in flight!
    sockets[0].emitMessage({
      name: 'team.taskChanged',
      data: {
        team_id: 'team_cu',
        change: 'updated',
        task: {
          id: 'task_existing_cu_1',
          team_id: 'team_cu',
          subject: 'Tarefa existente atualizada',
          description: 'Concluída via WS concorrente',
          status: 'completed',
          owner: 'slot_gemini',
          blocked_by: [],
          blocks: ['task_core_cu_2'],
          created_at: 1000,
          updated_at: 2500,
        },
      },
    });
    sockets[0].emitMessage({
      name: 'message.stream',
      data: {
        conversation_id: 'ext_cu_gemini',
        msg_id: 'ws_live_concurrent_1',
        turn_id: 'turn_cu_2',
        type: 'content',
        data: { content: 'Evento concorrente durante catch-up' },
      },
    });
    sockets[0].emitMessage({
      name: 'message.stream',
      data: {
        conversation_id: 'ext_cu_gemini',
        msg_id: 'ws_live_concurrent_1',
        turn_id: 'turn_cu_2',
        type: 'finish',
        data: {},
      },
    });

    const fullRes = await reconcilePromise;
    expect(fullRes.synced).toBe(true);

    const afterFull = adapter.getStateSnapshot().conversations[cid];
    expect(afterFull.conversation.syncState).toBe('synced');
    expect(afterFull.syncErrorNote).toBeUndefined();

    // Correct participant attribution (no fallback to coordinator, and 'lead' -> Terra 6.1)
    const geminiMsgs = afterFull.messagesByTab[geminiId];
    const solMsgs = afterFull.messagesByTab[solId];
    const terraMsgs = afterFull.messagesByTab[terraId];
    expect(
      geminiMsgs.filter((m) =>
        m.bodyMarkdown.includes('Mensagem recuperada do /mailbox após queda.'),
      ),
    ).toHaveLength(1);
    expect(
      geminiMsgs.some((m) =>
        m.bodyMarkdown.includes('Evento concorrente durante catch-up'),
      ),
    ).toBe(true);
    expect(
      terraMsgs.some((m) =>
        m.bodyMarkdown.includes('Delegação enviada pelo coordenador no mailbox.'),
      ),
    ).toBe(true);
    expect(
      solMsgs.some((m) =>
        m.bodyMarkdown.includes('Parecer recuperado da página 2 do /activity.'),
      ),
    ).toBe(true);

    // Existing task preserved concurrent WS `completed` (NOT overwritten by stale HTTP `in_progress` 1800 or /activity 1100!)
    const updatedExisting = afterFull.tasks.find(
      (t) => t.id === 'task_existing_cu_1',
    )!;
    expect(updatedExisting.status).toBe('completed');
    expect(updatedExisting.externalUpdatedAtMs).toBe(2500);

    // Dependent task from `/tasks` mapped `owner: 'slot_sol'` and `blocked_by: ['task_existing_cu_1']`
    const createdDepTask = afterFull.tasks.find(
      (t) => t.id === 'task_core_cu_2',
    )!;
    expect(createdDepTask.assigneeParticipantId).toBe(solId);
    expect(createdDepTask.dependencyTaskIds).toEqual(['task_existing_cu_1']);
    expect(createdDepTask.status).toBe('queued');

    // Case D: Idempotent retry does not duplicate any mailbox/activity/task records
    delayTasksMs = 0;
    tasksSnapshotStatus = 'completed';
    tasksSnapshotUpdatedAt = 2500;
    const retryRes = await adapter.reconcileConversation(cid);
    expect(retryRes.synced).toBe(true);
    expect(retryRes.events).toHaveLength(0);
    const afterRetry = adapter.getStateSnapshot().conversations[cid];
    expect(
      afterRetry.messagesByTab[geminiId].filter((m) =>
        m.bodyMarkdown.includes('Mensagem recuperada do /mailbox após queda.'),
      ),
    ).toHaveLength(1);
    expect(
      afterRetry.messagesByTab[solId].filter((m) =>
        m.bodyMarkdown.includes('Parecer recuperado da página 2 do /activity.'),
      ),
    ).toHaveLength(1);

    // Case E: WS drop + reconnect automatically triggers catch-up!
    const countBeforeReconnect = reconcileFetchCount;
    sockets[0].emitClose(1006, 'network drop');
    await vi.waitFor(
      () => {
        expect(sockets.length).toBeGreaterThanOrEqual(2);
        expect(reconcileFetchCount).toBeGreaterThan(countBeforeReconnect);
      },
      { timeout: 2500 },
    );

    adapter.dispose();
  });

  it('coalesces concurrent 401 refresh requests into a single /api/auth/refresh call, retries once, handles 403 CSRF, timeouts, invalid payloads, WS 1008, and never falls back to demo', async () => {
    let refreshCalls = 0;
    let accessTokenValid = false;
    let sendPostCalls = 0;
    const sockets: MockSocket[] = [];

    const fetchFn = async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();

      if (url.endsWith('/api/auth/refresh') && method === 'POST') {
        refreshCalls += 1;
        await new Promise((r) => setTimeout(r, 20));
        accessTokenValid = true;
        return jsonResponse({ success: true, token: 'refreshed_tok' });
      }
      if (url.endsWith('/api/teams') && method === 'GET') {
        if (!accessTokenValid) {
          return jsonResponse({ success: false, msg: 'expired' }, 401);
        }
        return jsonResponse({ success: true, data: [] });
      }
      if (url.endsWith('/api/assistants') && method === 'GET') {
        if (!accessTokenValid) {
          return jsonResponse({ success: false, msg: 'expired' }, 401);
        }
        return jsonResponse({ success: true, data: [] });
      }
      if (url.endsWith('/api/agents/management') && method === 'GET') {
        return jsonResponse({ success: true, data: [] });
      }
      if (url.endsWith('/api/teams') && method === 'POST') {
        return jsonResponse({ success: false, msg: 'csrf mismatch' }, 403);
      }
      if (url.endsWith('/api/teams/t1/messages') && method === 'POST') {
        sendPostCalls += 1;
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'));
          });
        });
      }
      if (url.endsWith('/health') && method === 'GET') {
        return jsonResponse({ invalid_health_payload: true });
      }
      if (url.endsWith('/api/ws-token') && method === 'GET') {
        return jsonResponse({
          success: true,
          ws_token: `tok_${refreshCalls}`,
          expires_in: 300,
        });
      }
      return jsonResponse({ success: false }, 404);
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
      baseUrl: 'http://127.0.0.1:25808',
      fetchFn,
      wsFactory,
      timeoutMs: 30,
      readCookie: () => 'csrf_123',
    });

    await adapter.loadWorkspace();

    await Promise.all([adapter.syncCoreTeams(), adapter.refreshCoreCatalog()]);
    expect(refreshCalls).toBe(1);

    await expect(adapter.checkHealth()).rejects.toMatchObject({
      code: 'INVALID_PAYLOAD',
    });

    const proj = await adapter.createProject({
      name: 'P',
      description: '',
      workspacePathInfo: '',
    });
    const conv = await adapter.createConversation({
      projectId: proj.id,
      title: 'C',
      presetId: 'preset_terra_sol_gemini',
    });
    await expect(
      adapter.sendMessage({
        conversationId: conv.conversation.id,
        targetTab: 'general',
        bodyMarkdown: 'Teste sem equipe',
      }),
    ).rejects.toMatchObject({ code: 'NOT_CONNECTED_LOCAL_CORE' });

    const state = structuredClone(adapter.getStateSnapshot());
    state.conversations[conv.conversation.id].conversation.externalTeamId = 't1';
    await adapter.importWorkspaceState(state);
    await expect(
      adapter.sendMessage({
        conversationId: conv.conversation.id,
        targetTab: 'general',
        bodyMarkdown: 'Vai expirar timeout',
      }),
    ).rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(sendPostCalls).toBe(1);

    await expect(
      adapter.controlExecution({
        conversationId: conv.conversation.id,
        action: 'pause_queue',
      }),
    ).rejects.toBeInstanceOf(GatewayCapabilityError);

    await adapter.connectWebSocket(conv.conversation.id);
    expect(sockets).toHaveLength(1);
    sockets[0].emitClose(1008, 'policy violation');
    await vi.waitFor(
      () => {
        expect(refreshCalls).toBeGreaterThanOrEqual(2);
      },
      { timeout: 1500 },
    );

    adapter.dispose();
  });

  it('handles real Core v0.2.2 online status, snake_case available_models, acp_config_option, position:right echoes, tips frames, and native session_id', async () => {
    const sockets: MockSocket[] = [];
    const postedContents: string[] = [];

    const fetchFn: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = (init?.method ?? 'GET').toUpperCase();

      if (url.endsWith('/login') && method === 'POST') {
        return jsonResponse({
          success: true,
          user: { id: 'u1', username: 'admin' },
          token: 'jwt_real_shape',
        });
      }
      if (url.endsWith('/api/agents/management') && method === 'GET') {
        return jsonResponse({
          success: true,
          data: [
            {
              id: '8e1acf31',
              name: 'Codex',
              backend: 'codex',
              installed: true,
              enabled: true,
              status: 'unchecked',
              available_models: {
                current_model_id: 'gpt-6.1-terra',
                available_models: [
                  { id: 'gpt-6.1-terra', label: 'gpt-6.1-terra' },
                  { id: 'gpt-6.1-sol', label: 'gpt-6.1-sol' },
                ],
              },
            },
          ],
        });
      }
      if (url.endsWith('/api/assistants') && method === 'GET') {
        return jsonResponse({
          success: true,
          data: [
            {
              id: 'bare:8e1acf31',
              name: 'Codex',
              agent_id: '8e1acf31',
              enabled: true,
              models: [],
              agent_status: 'unchecked',
              team_selectable: true,
            },
          ],
        });
      }
      if (url.endsWith('/api/agents/8e1acf31/health-check') && method === 'POST') {
        return jsonResponse({
          success: true,
          data: {
            id: '8e1acf31',
            name: 'Codex',
            backend: 'codex',
            installed: true,
            enabled: true,
            status: 'online',
            last_check_latency_ms: 42,
            available_models: {
              available_models: [
                { id: 'gpt-6.1-terra', label: 'gpt-6.1-terra' },
                { id: 'gpt-6.1-sol', label: 'gpt-6.1-sol' },
              ],
            },
          },
        });
      }
      if (url.endsWith('/api/ws-token') && method === 'GET') {
        return jsonResponse({
          success: true,
          ws_token: 'ws_tok_v602',
          expires_in: 300,
        });
      }
      if (url.endsWith('/api/teams') && method === 'POST') {
        return jsonResponse({
          success: true,
          data: {
            id: 'team_v602_single',
            name: 'Sessão Única',
            assistants: [
              {
                slot_id: 'slot_single_1',
                conversation_id: 'ext_conv_single_1',
                name: 'Codex Solo',
                role: 'lead',
                model: 'gpt-6.1-terra',
              },
            ],
          },
        });
      }
      if (url.endsWith('/api/teams/team_v602_single/messages') && method === 'POST') {
        const body = init?.body ? (JSON.parse(String(init.body)) as { content: string }) : { content: '' };
        postedContents.push(body.content);
        return jsonResponse({
          success: true,
          data: {
            message_id: 'msg_ack_solo_1',
            enqueue_status: 'started',
            run: { team_run_id: 'run_solo_1', status: 'running' },
          },
        });
      }
      return jsonResponse({ success: true, data: [] });
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
      baseUrl: 'http://127.0.0.1:25828',
      fetchFn,
      wsFactory,
      readCookie: () => 'csrf_v602',
    });

    await adapter.loadWorkspace();
    await adapter.login('admin', 'secret');
    expect(adapter.getStateSnapshot().coreSessionAuthenticated).toBe(true);

    await adapter.refreshCoreCatalog();
    // Preserves WebUI session auth independently of agent status (`unchecked`)
    expect(adapter.getStateSnapshot().coreSessionAuthenticated).toBe(true);
    const codexConnBeforeCheck = adapter
      .getStateSnapshot()
      .connections.find((c) => c.coreAssistantId === 'bare:8e1acf31')!;
    expect(codexConnBeforeCheck.coreAgentStatus).toBe('unchecked');
    expect(codexConnBeforeCheck.availableModels.map((m) => m.externalId)).toEqual([
      'gpt-6.1-terra',
      'gpt-6.1-sol',
    ]);

    const checkRes = await adapter.testAgentConnection(codexConnBeforeCheck.id);
    expect(checkRes.ok).toBe(true);
    const codexConnAfterCheck = adapter
      .getStateSnapshot()
      .connections.find((c) => c.id === codexConnBeforeCheck.id)!;
    expect(codexConnAfterCheck.coreAgentStatus).toBe('online');
    expect(codexConnAfterCheck.authStatus).toBe('unknown');

    const proj = await adapter.createProject({
      name: 'V6-02 Solo',
      description: '',
      workspacePathInfo: 'C:/tmp/ws',
    });
    const conv = await adapter.createConversation({
      projectId: proj.id,
      title: 'Solo Core',
      customMembers: [
        {
          connectionId: codexConnBeforeCheck.id,
          displayName: 'Codex Solo',
          roles: ['coordinator', 'executor'],
          modelRef: {
            externalId: 'gpt-6.1-terra',
            displayName: 'gpt-6.1-terra',
            source: 'core_catalog',
            confirmation: 'confirmed',
          },
          instructions: 'Responder objetivamente.',
        },
      ],
    });
    await adapter.createCoreTeamForConversation(conv.conversation.id);
    await adapter.connectWebSocket(conv.conversation.id);

    await adapter.sendMessage({
      conversationId: conv.conversation.id,
      targetTab: 'general',
      bodyMarkdown: 'Responda apenas CODIGO-SOLO-123.',
    });
    // Single-participant conversation does NOT force multi-agent `plan_proposal` JSON
    expect(postedContents[0]).not.toContain('plan_proposal');

    const sock = sockets[0];
    // 1. Outgoing user prompt echo (`position: "right"`) MUST NOT leak into agent tab
    sock.emitMessage({
      name: 'message.stream',
      data: {
        conversation_id: 'ext_conv_single_1',
        msg_id: 'msg_echo_right',
        type: 'text',
        position: 'right',
        data: { content: '[Contrato interno aion-desk/v1 ...]' },
      },
    });
    // 2. Live `acp_config_option` adds confirmed model without creating bogus message
    sock.emitMessage({
      name: 'message.stream',
      data: {
        conversation_id: 'ext_conv_single_1',
        msg_id: 'msg_cfg_1',
        type: 'acp_config_option',
        data: [
          {
            id: 'model',
            category: 'model',
            options: [{ value: 'gpt-6.1-codex-extra', name: 'GPT 6.1 Extra' }],
          },
        ],
      },
    });
    // 3. `start` carries null session_id, `tips` shares SAME msg_id as real answer!
    sock.emitMessage({
      name: 'message.stream',
      data: {
        conversation_id: 'ext_conv_single_1',
        msg_id: 'msg_real_1',
        turn_id: 'turn_real_1',
        type: 'start',
        data: { session_id: null },
      },
    });
    sock.emitMessage({
      name: 'message.stream',
      data: {
        conversation_id: 'ext_conv_single_1',
        msg_id: 'msg_real_1',
        turn_id: 'turn_real_1',
        type: 'tips',
        data: { code: 'CLI_VERSION_NEWER', content: 'Update Codex CLI' },
      },
    });
    sock.emitMessage({
      name: 'message.stream',
      data: {
        conversation_id: 'ext_conv_single_1',
        msg_id: 'msg_real_1',
        turn_id: 'turn_real_1',
        type: 'content',
        data: { content: 'CODIGO-SOLO-123' },
      },
    });
    sock.emitMessage({
      name: 'message.stream',
      data: {
        conversation_id: 'ext_conv_single_1',
        msg_id: 'msg_real_1',
        turn_id: 'turn_real_1',
        type: 'finish',
        data: { session_id: '01a1ea94-native-cli-session-1' },
      },
    });

    const finalState = adapter.getStateSnapshot();
    const finalConv = finalState.conversations[conv.conversation.id];
    const soloPart = finalConv.participants[0];
    expect(soloPart.sessionRef.nativeSessionId).toBe(
      '01a1ea94-native-cli-session-1',
    );
    const agentMsgs = finalConv.messagesByTab[soloPart.id].filter(
      (m) => m.authorType === 'agent',
    );
    expect(agentMsgs).toHaveLength(1);
    expect(agentMsgs[0].bodyMarkdown).toBe('CODIGO-SOLO-123');
    expect(agentMsgs[0].bodyMarkdown).not.toContain('Update Codex CLI');
    expect(agentMsgs[0].parseStatus).toBeUndefined();

    const updatedConn = finalState.connections.find(
      (c) => c.id === codexConnBeforeCheck.id,
    )!;
    expect(
      updatedConn.availableModels.some(
        (m) => m.externalId === 'gpt-6.1-codex-extra' && m.confirmed,
      ),
    ).toBe(true);

    adapter.dispose();
  });

  it('auto-binds built-in Core presets without Claude, sends PATCH .../model with model_id, verifies capability matrix, and forbids MCP delegation tools', async () => {
    const modelPatchBodies: Array<{ url: string; body: unknown }> = [];
    const postedContents: string[] = [];

    const fetchFn: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = (init?.method ?? 'GET').toUpperCase();

      if (url.endsWith('/login') && method === 'POST') {
        return jsonResponse({
          success: true,
          user: { id: 'u1', username: 'admin' },
          token: 'jwt_v603',
        });
      }
      if (url.endsWith('/api/agents/management') && method === 'GET') {
        return jsonResponse({
          success: true,
          data: [
            {
              id: 'codex-1',
              name: 'Codex',
              backend: 'codex',
              installed: true,
              enabled: true,
              status: 'online',
              available_models: {
                available_models: [
                  { id: 'gpt-6.1-terra', label: 'gpt-6.1-terra' },
                  { id: 'gpt-6.1-sol', label: 'gpt-6.1-sol' },
                ],
              },
            },
            {
              id: 'antigravity-1',
              name: 'Antigravity',
              backend: 'antigravity',
              installed: true,
              enabled: true,
              status: 'online',
              available_models: {
                available_models: [
                  { id: 'gemini-4-hydrogen-high', label: 'gemini-4-hydrogen-high' },
                  { id: 'gemini-4-hydrogen-xhigh', label: 'gemini-4-hydrogen-xhigh' },
                ],
              },
            },
          ],
        });
      }
      if (url.endsWith('/api/assistants') && method === 'GET') {
        return jsonResponse({
          success: true,
          data: [
            {
              id: 'bare:codex-1',
              name: 'Codex',
              agent_id: 'codex-1',
              enabled: true,
              team_selectable: true,
            },
            {
              id: 'bare:antigravity-1',
              name: 'Antigravity',
              agent_id: 'antigravity-1',
              enabled: true,
              team_selectable: true,
            },
          ],
        });
      }
      if (url.endsWith('/api/ws-token') && method === 'GET') {
        return jsonResponse({ success: true, ws_token: 'ws_tok_v603', expires_in: 300 });
      }
      if (url.endsWith('/api/teams') && method === 'POST') {
        const body = JSON.parse(String(init?.body ?? '{}')) as {
          agents?: Array<{ slot_id?: string; name: string; role: string; model?: string }>;
          assistants?: Array<{ slot_id?: string; name: string; role: string; model?: string }>;
        };
        const items = body.agents ?? body.assistants ?? [];
        return jsonResponse({
          success: true,
          data: {
            id: 'team_v603',
            name: 'V6-03 Team',
            assistants: items.map((a, idx) => ({
              slot_id: `slot_v603_${idx + 1}`,
              conversation_id: `ext_conv_v603_${idx + 1}`,
              name: a.name,
              role: a.role,
              model: a.model,
            })),
          },
        });
      }
      if (url.includes('/agents/') && url.endsWith('/model') && method === 'PATCH') {
        modelPatchBodies.push({
          url,
          body: JSON.parse(String(init?.body ?? '{}')),
        });
        return jsonResponse({ success: true, data: { updated: true } });
      }
      if (url.endsWith('/api/teams/team_v603/messages') && method === 'POST') {
        const body = JSON.parse(String(init?.body ?? '{}')) as { content: string };
        postedContents.push(body.content);
        return jsonResponse({
          success: true,
          data: { message_id: 'msg_v603_1', enqueue_status: 'started' },
        });
      }
      return jsonResponse({ success: true, data: [] });
    };

    const persistence = new WorkspacePersistenceManager(
      new MemoryOnlyStorageDriver(),
    );
    let capturedSock: MockSocket | null = null;
    const adapter = new AionCoreAdapter(persistence, {
      baseUrl: 'http://127.0.0.1:25828',
      fetchFn,
      wsFactory: (url, protocols) => {
        capturedSock = new MockSocket(url, protocols);
        return capturedSock;
      },
      readCookie: () => 'csrf_v603',
    });

    await adapter.loadWorkspace();
    await adapter.login('admin', 'secret');
    await adapter.refreshCoreCatalog();

    const project = await adapter.createProject({
      name: 'Projeto V6-03',
      description: 'Teste preset sem Claude',
      workspacePathInfo: 'C:/tmp/v6-test-repo',
    });
    const conv = await adapter.createConversation({
      projectId: project.id,
      title: 'Conversa V6-03',
    });

    expect(conv.participants.map((p) => p.displayName)).toEqual([
      'Terra 6.1',
      'Sol 6.1',
      'Gemini Hydrogen',
    ]);
    expect(conv.participants.some((p) => /claude/i.test(p.displayName))).toBe(false);
    expect(conv.participants.map((p) => p.modelRef.externalId)).toEqual([
      'gpt-6.1-terra',
      'gpt-6.1-sol',
      'gemini-4-hydrogen-high',
    ]);

    await adapter.createCoreTeamForConversation(conv.conversation.id);
    const sol = adapter.getStateSnapshot().conversations[conv.conversation.id].participants[1];
    const solConn = adapter
      .getStateSnapshot()
      .connections.find((c) => c.id === sol.connectionId)!;
    expect(solConn.capabilities.supportsInterrupt).toBe(true);
    expect(solConn.capabilities.supportsModelSwitchInSession).toBe(true);
    expect(solConn.capabilities.supportsPauseQueue).toBe(false);
    expect(solConn.capabilities.supportsSessionTerminate).toBe(false);
    expect(solConn.capabilities.supportsMidRunContextInjection).toBe(false);

    await adapter.configureParticipant({
      conversationId: conv.conversation.id,
      participantId: sol.id,
      displayName: 'Sol Auditor',
      roles: ['reviewer'],
      connectionId: sol.connectionId,
      modelRef: {
        externalId: 'gpt-6.1-terra',
        displayName: 'gpt-6.1-terra',
        source: 'core_catalog',
        confirmation: 'confirmed',
      },
      instructions: 'Auditar apenas.',
    });

    expect(modelPatchBodies).toHaveLength(1);
    expect(modelPatchBodies[0].url).toContain('/agents/slot_v603_2/model');
    expect(modelPatchBodies[0].body).toEqual({ model_id: 'gpt-6.1-terra' });

    await adapter.connectWebSocket(conv.conversation.id);
    await adapter.sendMessage({
      conversationId: conv.conversation.id,
      targetTab: 'general',
      bodyMarkdown: 'Planeje 3 tarefas.',
    });

    expect(postedContents).toHaveLength(1);
    expect(postedContents[0]).toContain('team_send_message');
    expect(postedContents[0]).toContain('team_task_create');

    // Verify Core ping heartbeat is answered immediately with pong
    capturedSock!.emitMessage({
      name: 'ping',
      data: { timestamp: 1794940000000 },
    });
    expect(capturedSock!.sent.some((raw) => {
      const msg = JSON.parse(raw) as { name: string; data?: { timestamp?: number } };
      return msg.name === 'pong' && msg.data?.timestamp === 1794940000000;
    })).toBe(true);

    // Verify split msg_id frames within the same turn_id merge before finish on root msg_id
    expect(capturedSock).not.toBeNull();
    capturedSock!.emitMessage({
      name: 'message.stream',
      data: {
        conversation_id: 'ext_conv_v603_1',
        msg_id: 'msg_root_1',
        turn_id: 'turn_split_1',
        type: 'content',
        data: { content: 'Vou planejar a tarefa.' },
      },
    });
    capturedSock!.emitMessage({
      name: 'message.stream',
      data: {
        conversation_id: 'ext_conv_v603_1',
        msg_id: 'msg_post_tool_2',
        turn_id: 'turn_split_1',
        type: 'content',
        data: {
          content:
            '```aion-desk-json\n' +
            JSON.stringify({
              protocol: INTERNAL_PROTOCOL_VERSION,
              kind: 'plan_proposal',
              conversationId: conv.conversation.id,
              summary: 'Plano único',
              tasks: [
                {
                  title: 'Executar tarefa 1',
                  description: 'Validar merge de frames por turn_id',
                  assigneeRole: 'executor',
                  dependencies: [],
                  acceptanceCriteria: ['OK'],
                },
              ],
            }) +
            '\n```',
        },
      },
    });
    capturedSock!.emitMessage({
      name: 'message.stream',
      data: {
        conversation_id: 'ext_conv_v603_1',
        msg_id: 'msg_root_1',
        turn_id: 'turn_split_1',
        type: 'finish',
        data: { session_id: 'cli-sess-split-1' },
      },
    });

    const convAfterSplit = adapter.getStateSnapshot().conversations[conv.conversation.id];
    expect(convAfterSplit.tasks).toHaveLength(1);
    expect(convAfterSplit.tasks[0].title).toBe('Executar tarefa 1');

    adapter.dispose();
  });

  it('caps rework loops at MAX_CORE_TASK_ATTEMPTS=3 and escalates to a confirmed Core model via PATCH', async () => {
    const modelPatchBodies: Array<{ url: string; body: unknown }> = [];
    const postedTeamMessages: Array<{ to?: string; content: string }> = [];
    let capturedSock: MockSocket | null = null;
    let msgCounter = 0;

    const fetchFn: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = (init?.method ?? 'GET').toUpperCase();
      if (url.endsWith('/login') && method === 'POST') {
        return jsonResponse({ success: true, user: { username: 'admin' } });
      }
      if (url.endsWith('/api/agents/management') && method === 'GET') {
        return jsonResponse({
          success: true,
          data: [
            {
              id: 'codex-1',
              backend: 'codex',
              name: 'Codex',
              installed: true,
              enabled: true,
              status: 'online',
              available_models: {
                available_models: [
                  { id: 'gpt-5.6-luna', label: 'gpt-5.6-luna' },
                  { id: 'gpt-6.1-terra', label: 'gpt-6.1-terra' },
                ],
              },
            },
            {
              id: 'antigravity-1',
              backend: 'antigravity',
              name: 'Antigravity',
              installed: true,
              enabled: true,
              status: 'online',
              available_models: {
                available_models: [
                  { id: 'gemini-3.8-flash-low', label: 'gemini-3.8-flash-low' },
                  { id: 'gemini-4-hydrogen-xhigh', label: 'gemini-4-hydrogen-xhigh' },
                ],
              },
            },
          ],
        });
      }
      if (url.endsWith('/api/assistants') && method === 'GET') {
        return jsonResponse({
          success: true,
          data: [
            { id: 'bare:codex-1', name: 'Codex', agent_id: 'codex-1', enabled: true, team_selectable: true },
            { id: 'bare:antigravity-1', name: 'Antigravity', agent_id: 'antigravity-1', enabled: true, team_selectable: true },
          ],
        });
      }
      if (url.endsWith('/api/ws-token') && method === 'GET') {
        return jsonResponse({ success: true, ws_token: 'ws_tok_v605', expires_in: 300 });
      }
      if (url.endsWith('/api/teams') && method === 'POST') {
        const body = JSON.parse(String(init?.body ?? '{}')) as {
          agents?: Array<{ name: string; role: string; model?: string }>;
        };
        const items = body.agents ?? [];
        return jsonResponse({
          success: true,
          data: {
            id: 'team_v605',
            name: 'V6-05 Team',
            assistants: items.map((a, idx) => ({
              slot_id: `slot_v605_${idx + 1}`,
              conversation_id: `ext_conv_v605_${idx + 1}`,
              name: a.name,
              role: a.role,
              model: a.model,
            })),
          },
        });
      }
      if (url.includes('/agents/') && url.endsWith('/model') && method === 'PATCH') {
        modelPatchBodies.push({
          url,
          body: JSON.parse(String(init?.body ?? '{}')),
        });
        return jsonResponse({ success: true, data: { updated: true } });
      }
      if (url.endsWith('/api/teams/team_v605/messages') && method === 'POST') {
        const body = JSON.parse(String(init?.body ?? '{}')) as {
          to?: string;
          content: string;
        };
        postedTeamMessages.push({ to: body.to, content: body.content });
        msgCounter += 1;
        return jsonResponse({
          success: true,
          data: { message_id: `msg_v605_${msgCounter}`, enqueue_status: 'started' },
        });
      }
      return jsonResponse({ success: true, data: [] });
    };

    const persistence = new WorkspacePersistenceManager(
      new MemoryOnlyStorageDriver(),
    );
    const adapter = new AionCoreAdapter(persistence, {
      baseUrl: 'http://127.0.0.1:25828',
      fetchFn,
      wsFactory: (url, protocols) => {
        capturedSock = new MockSocket(url, protocols);
        return capturedSock;
      },
      readCookie: () => 'csrf_v605',
    });

    await adapter.loadWorkspace();
    await adapter.login('admin', 'secret');
    await adapter.refreshCoreCatalog();
    await adapter.updateModelPolicy({
      approvalMode: 'auto_policy',
      qualityRejectionsBeforeSuggest: 1,
      defaultExecutorTier: 'fast',
      reviewerTier: 'review',
      escalationTargetTier: 'advanced',
    });

    const project = await adapter.createProject({
      name: 'Projeto V6-05',
      description: 'Teste limite de retentativas e escalonamento',
      workspacePathInfo: 'C:/tmp/v605-test-repo',
    });
    const conv = await adapter.createConversation({
      projectId: project.id,
      title: 'Conversa V6-05',
    });
    await adapter.createCoreTeamForConversation(conv.conversation.id);
    await adapter.connectWebSocket(conv.conversation.id);

    const team = adapter.getStateSnapshot().conversations[conv.conversation.id];
    const planner = team.participants.find((p) => p.roles.includes('planner'))!;
    const executor = team.participants.find((p) => p.roles.includes('executor'))!;
    const reviewer = team.participants.find((p) => p.roles.includes('reviewer'))!;

    // Force executor onto weak/cheap confirmed model so escalation promotes to gemini-4-hydrogen-xhigh
    await adapter.configureParticipant({
      conversationId: conv.conversation.id,
      participantId: executor.id,
      displayName: executor.displayName,
      roles: executor.roles,
      connectionId: executor.connectionId,
      modelRef: {
        externalId: 'gemini-3.8-flash-low',
        displayName: 'gemini-3.8-flash-low',
        source: 'core_catalog',
        confirmation: 'confirmed',
      },
      instructions: executor.instructions,
    });
    modelPatchBodies.length = 0;

    // Emit plan_proposal from planner
    const planJson = JSON.stringify({
      protocol: INTERNAL_PROTOCOL_VERSION,
      kind: 'plan_proposal',
      conversationId: conv.conversation.id,
      summary: 'Plano V6-05',
      tasks: [
        {
          title: 'Corrigir validações',
          description: 'Implementar checagem segura',
          assigneeRole: 'executor',
          dependencies: [],
          acceptanceCriteria: ['Marker presente'],
        },
      ],
    });
    capturedSock!.emitMessage({
      name: 'message.stream',
      data: {
        conversation_id: planner.sessionRef.externalConversationId,
        msg_id: 'msg_plan_v605',
        type: 'content',
        data: { content: '```aion-desk-json\n' + planJson + '\n```' },
      },
    });
    capturedSock!.emitMessage({
      name: 'message.stream',
      data: {
        conversation_id: planner.sessionRef.externalConversationId,
        msg_id: 'msg_plan_v605',
        type: 'finish',
        data: {},
      },
    });
    await new Promise((r) => setTimeout(r, 30));

    let state = adapter.getStateSnapshot().conversations[conv.conversation.id];
    expect(state.tasks).toHaveLength(1);
    const taskId = state.tasks[0].id;

    // Simulate 3 executor reports followed by 3 reviewer rejections
    for (let cycle = 1; cycle <= 3; cycle++) {
      state = adapter.getStateSnapshot().conversations[conv.conversation.id];
      const currentAttempt = state.tasks[0].attempts[state.tasks[0].attempts.length - 1];
      const reportJson = JSON.stringify({
        protocol: INTERNAL_PROTOCOL_VERSION,
        kind: 'delivery_report',
        conversationId: conv.conversation.id,
        taskId,
        attemptId: currentAttempt.id,
        deliverySummary: `Entrega tentativa ${cycle}`,
        evidenceNotes: ['calc.mjs', 'node --test'],
      });
      capturedSock!.emitMessage({
        name: 'message.stream',
        data: {
          conversation_id: executor.sessionRef.externalConversationId,
          msg_id: `msg_exec_${cycle}`,
          type: 'content',
          data: { content: '```aion-desk-json\n' + reportJson + '\n```' },
        },
      });
      capturedSock!.emitMessage({
        name: 'message.stream',
        data: {
          conversation_id: executor.sessionRef.externalConversationId,
          msg_id: `msg_exec_${cycle}`,
          type: 'finish',
          data: {},
        },
      });
      await new Promise((r) => setTimeout(r, 30));

      const reviewJson = JSON.stringify({
        protocol: INTERNAL_PROTOCOL_VERSION,
        kind: 'review_decision',
        conversationId: conv.conversation.id,
        taskId,
        attemptId: currentAttempt.id,
        decision: 'rejected',
        rationale: `Critério ausente no ciclo ${cycle}`,
        unmetCriteria: ['Marker presente'],
      });
      capturedSock!.emitMessage({
        name: 'message.stream',
        data: {
          conversation_id: reviewer.sessionRef.externalConversationId,
          msg_id: `msg_rev_${cycle}`,
          type: 'content',
          data: { content: '```aion-desk-json\n' + reviewJson + '\n```' },
        },
      });
      capturedSock!.emitMessage({
        name: 'message.stream',
        data: {
          conversation_id: reviewer.sessionRef.externalConversationId,
          msg_id: `msg_rev_${cycle}`,
          type: 'finish',
          data: {},
        },
      });
      await new Promise((r) => setTimeout(r, 30));
    }

    const finalConv = adapter.getStateSnapshot().conversations[conv.conversation.id];
    const finalTask = finalConv.tasks[0];
    expect(finalTask.attempts).toHaveLength(3);
    expect(finalTask.qualityRejectionCount).toBe(3);
    expect(finalTask.status).toBe('blocked');
    expect(finalConv.conversation.executionStatus).toBe('blocked');
    expect(finalConv.escalations).toHaveLength(1);
    expect(finalConv.escalations[0].toModelRef?.externalId).toBe('gemini-4-hydrogen-xhigh');
    expect(modelPatchBodies).toHaveLength(1);
    expect(modelPatchBodies[0].url).toContain(`/agents/${executor.sessionRef.externalSlotId}/model`);
    expect(modelPatchBodies[0].body).toEqual({ model_id: 'gemini-4-hydrogen-xhigh' });

    adapter.dispose();
  });

  it('ignores unsolicited duplicate plan_proposal frames emitted on Core lead idle_notification wakeups', async () => {
    let capturedSock: MockSocket | null = null;
    const fetchFn: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = (init?.method ?? 'GET').toUpperCase();
      if (url.endsWith('/login') && method === 'POST') {
        return jsonResponse({ success: true, user: { username: 'admin' } });
      }
      if (url.endsWith('/api/agents/management') && method === 'GET') {
        return jsonResponse({
          success: true,
          data: [
            {
              id: 'codex-1',
              backend: 'codex',
              name: 'Codex',
              installed: true,
              enabled: true,
              status: 'online',
              available_models: {
                available_models: [{ id: 'gpt-5.6-luna', label: 'gpt-5.6-luna' }],
              },
            },
            {
              id: 'antigravity-1',
              backend: 'antigravity',
              name: 'Antigravity',
              installed: true,
              enabled: true,
              status: 'online',
              available_models: {
                available_models: [{ id: 'gemini-3.8-flash-low', label: 'gemini-3.8-flash-low' }],
              },
            },
          ],
        });
      }
      if (url.endsWith('/api/assistants') && method === 'GET') {
        return jsonResponse({
          success: true,
          data: [
            { id: 'bare:codex-1', name: 'Codex', agent_id: 'codex-1', enabled: true, team_selectable: true },
            { id: 'bare:antigravity-1', name: 'Antigravity', agent_id: 'antigravity-1', enabled: true, team_selectable: true },
          ],
        });
      }
      if (url.endsWith('/api/ws-token') && method === 'GET') {
        return jsonResponse({ success: true, ws_token: 'ws_tok_dup', expires_in: 300 });
      }
      if (url.endsWith('/api/teams') && method === 'POST') {
        const body = JSON.parse(String(init?.body ?? '{}')) as {
          agents?: Array<{ name: string; role: string; model?: string }>;
        };
        return jsonResponse({
          success: true,
          data: {
            id: 'team_dup_guard',
            name: 'Guard Team',
            assistants: (body.agents ?? []).map((a, idx) => ({
              slot_id: `slot_dup_${idx + 1}`,
              conversation_id: `ext_conv_dup_${idx + 1}`,
              name: a.name,
              role: a.role,
              model: a.model,
            })),
          },
        });
      }
      if (url.endsWith('/messages') && method === 'POST') {
        return jsonResponse({
          success: true,
          data: { message_id: `ack_${Date.now()}`, enqueue_status: 'started' },
        });
      }
      return jsonResponse({ success: true, data: [] });
    };

    const persistence = new WorkspacePersistenceManager(new MemoryOnlyStorageDriver());
    const adapter = new AionCoreAdapter(persistence, {
      baseUrl: 'http://127.0.0.1:25828',
      fetchFn,
      wsFactory: (url, protocols) => {
        capturedSock = new MockSocket(url, protocols);
        return capturedSock;
      },
      readCookie: () => 'csrf_dup',
    });

    await adapter.loadWorkspace();
    await adapter.login('admin', 'secret');
    await adapter.refreshCoreCatalog();
    const project = await adapter.createProject({
      name: 'Projeto Guard',
      description: 'Evitar duplicação de plano',
      workspacePathInfo: 'C:/tmp/guard',
    });
    const conv = await adapter.createConversation({
      projectId: project.id,
      title: 'Conversa Guard',
    });
    await adapter.createCoreTeamForConversation(conv.conversation.id);
    await adapter.connectWebSocket(conv.conversation.id);
    await adapter.sendMessage({
      conversationId: conv.conversation.id,
      targetTab: 'general',
      bodyMarkdown: 'Crie 1 tarefa.',
    });

    const lead = adapter.getStateSnapshot().conversations[conv.conversation.id].participants[0];
    const planPayload = JSON.stringify({
      protocol: INTERNAL_PROTOCOL_VERSION,
      kind: 'plan_proposal',
      conversationId: conv.conversation.id,
      summary: 'Plano único',
      tasks: [
        {
          title: 'Tarefa única',
          description: 'Executar 1x',
          assigneeRole: 'executor',
          dependencies: [],
          acceptanceCriteria: ['OK'],
        },
      ],
    });

    // Turn 1: initial plan_proposal
    capturedSock!.emitMessage({
      name: 'message.stream',
      data: {
        conversation_id: lead.sessionRef.externalConversationId,
        msg_id: 'msg_plan_1',
        type: 'content',
        data: { content: '```aion-desk-json\n' + planPayload + '\n```' },
      },
    });
    capturedSock!.emitMessage({
      name: 'message.stream',
      data: {
        conversation_id: lead.sessionRef.externalConversationId,
        msg_id: 'msg_plan_1',
        type: 'finish',
        data: {},
      },
    });

    // Unsolicited wakeup #2 (e.g., Core lead triggered by teammate idle_notification)
    capturedSock!.emitMessage({
      name: 'message.stream',
      data: {
        conversation_id: lead.sessionRef.externalConversationId,
        msg_id: 'msg_plan_wakeup_2',
        type: 'content',
        data: { content: 'Recebido.\n\n```aion-desk-json\n' + planPayload + '\n```' },
      },
    });
    capturedSock!.emitMessage({
      name: 'message.stream',
      data: {
        conversation_id: lead.sessionRef.externalConversationId,
        msg_id: 'msg_plan_wakeup_2',
        type: 'finish',
        data: {},
      },
    });

    const after = adapter.getStateSnapshot().conversations[conv.conversation.id];
    expect(after.tasks).toHaveLength(1);
    expect(after.planRevisions).toHaveLength(1);

    adapter.dispose();
  });

  it('wires real Core permissions (acp_permission, POST .../confirm, confirmation.remove), operational failure accounting without penalizing quality, and live request_interrupt', async () => {
    const confirmCalls: Array<{ url: string; body: unknown }> = [];
    const cancelCalls: Array<{ url: string; body: unknown }> = [];
    let capturedSock: MockSocket | null = null;

    const fetchFn: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = (init?.method ?? 'GET').toUpperCase();
      if (url.endsWith('/login') && method === 'POST') {
        return jsonResponse({ success: true, user: { id: 'u1', username: 'admin' }, token: 'jwt_v605_perm' });
      }
      if (url.endsWith('/api/agents/management') && method === 'GET') {
        return jsonResponse({
          success: true,
          data: [
            {
              id: 'codex-1',
              backend: 'codex',
              name: 'Codex',
              installed: true,
              enabled: true,
              status: 'online',
              available_models: { available_models: [{ id: 'gpt-6.1-terra', label: 'gpt-6.1-terra' }, { id: 'gpt-6.1-sol', label: 'gpt-6.1-sol' }] },
            },
            {
              id: 'antigravity-1',
              backend: 'antigravity',
              name: 'Antigravity',
              installed: true,
              enabled: true,
              status: 'online',
              available_models: { available_models: [{ id: 'gemini-4-hydrogen-high', label: 'gemini-4-hydrogen-high' }] },
            },
          ],
        });
      }
      if (url.endsWith('/api/assistants') && method === 'GET') {
        return jsonResponse({
          success: true,
          data: [
            { id: 'bare:codex-1', name: 'Codex', agent_id: 'codex-1', enabled: true, team_selectable: true },
            { id: 'bare:antigravity-1', name: 'Antigravity', agent_id: 'antigravity-1', enabled: true, team_selectable: true },
          ],
        });
      }
      if (url.endsWith('/api/ws-token') && method === 'GET') {
        return jsonResponse({ success: true, ws_token: 'ws_tok_perm', expires_in: 300 });
      }
      if (url.endsWith('/api/teams') && method === 'POST') {
        const body = JSON.parse(String(init?.body ?? '{}')) as { agents?: Array<{ name: string; role: string; model?: string }> };
        return jsonResponse({
          success: true,
          data: {
            id: 'team_perm_1',
            name: 'Perm Team',
            assistants: (body.agents ?? []).map((a, idx) => ({
              slot_id: `slot_perm_${idx + 1}`,
              conversation_id: `ext_conv_perm_${idx + 1}`,
              name: a.name,
              role: a.role,
              model: a.model,
            })),
          },
        });
      }
      if (url.includes('/confirmations/') && url.endsWith('/confirm') && method === 'POST') {
        confirmCalls.push({ url, body: JSON.parse(String(init?.body ?? '{}')) });
        return jsonResponse({ success: true });
      }
      if (url.endsWith('/api/teams/team_perm_1/run-state') && method === 'GET') {
        return jsonResponse({
          success: true,
          data: {
            active_run: { team_run_id: 'run_active_1', status: 'running' },
            slot_work: [
              { slot_id: 'slot_perm_3', state: 'running', team_run_id: 'run_active_1', active_turn_id: 'turn_exec_1' },
            ],
          },
        });
      }
      if (url.includes('/runs/run_active_1/agents/slot_perm_3/cancel') && method === 'POST') {
        cancelCalls.push({ url, body: JSON.parse(String(init?.body ?? '{}')) });
        return jsonResponse({ success: true, data: { cancelled: true } });
      }
      return jsonResponse({ success: true, data: { message_id: 'ack_1', enqueue_status: 'started' } });
    };

    const persistence = new WorkspacePersistenceManager(new MemoryOnlyStorageDriver());
    const adapter = new AionCoreAdapter(persistence, {
      baseUrl: 'http://127.0.0.1:25828',
      fetchFn,
      wsFactory: (url, protocols) => {
        capturedSock = new MockSocket(url, protocols);
        return capturedSock;
      },
      readCookie: () => 'csrf_perm',
    });

    await adapter.loadWorkspace();
    await adapter.login('admin', 'secret');
    await adapter.refreshCoreCatalog();

    const proj = await adapter.createProject({
      name: 'Projeto V6-05 Perm',
      description: 'Teste permissão/falha/interrupção',
      workspacePathInfo: 'C:/tmp/v605-perm',
    });
    const conv = await adapter.createConversation({ projectId: proj.id, title: 'V6-05 Wire' });
    await adapter.createCoreTeamForConversation(conv.conversation.id);
    await adapter.connectWebSocket(conv.conversation.id);

    const team = adapter.getStateSnapshot().conversations[conv.conversation.id];
    const planner = team.participants.find((p) => p.roles.includes('planner'))!;
    const executor = team.participants.find((p) => p.roles.includes('executor'))!;

    capturedSock!.emitMessage({
      name: 'message.stream',
      data: {
        conversation_id: planner.sessionRef.externalConversationId,
        msg_id: 'm_plan_p',
        type: 'content',
        data: {
          content: '```aion-desk-json\n' + JSON.stringify({
            protocol: INTERNAL_PROTOCOL_VERSION,
            kind: 'plan_proposal',
            conversationId: conv.conversation.id,
            summary: 'Plano V6-05 Perm',
            tasks: [{
              title: 'Rodar script protegido',
              description: 'Testar permissão e falha operacional',
              assigneeRole: 'executor',
              dependencies: [],
              acceptanceCriteria: ['OK'],
            }],
          }) + '\n```',
        },
      },
    });
    capturedSock!.emitMessage({
      name: 'message.stream',
      data: { conversation_id: planner.sessionRef.externalConversationId, msg_id: 'm_plan_p', type: 'finish', data: {} },
    });
    await new Promise((r) => setTimeout(r, 30));

    capturedSock!.emitMessage({
      name: 'message.stream',
      data: {
        conversation_id: executor.sessionRef.externalConversationId,
        msg_id: 'm_perm_1',
        turn_id: 'turn_exec_1',
        type: 'acp_permission',
        data: {
          session_id: 'cli_s_1',
          tool_call: {
            tool_call_id: 'call_perm_99',
            title: 'Executar comando npm test',
            kind: 'execute',
            raw_input: { command: 'npm test' },
          },
          options: [
            { option_id: 'allow_once_id', name: 'Allow', kind: 'allow_once' },
            { option_id: 'reject_once_id', name: 'Reject', kind: 'reject_once' },
          ],
        },
      },
    });

    const convPendingPerm = adapter.getStateSnapshot().conversations[conv.conversation.id];
    expect(convPendingPerm.permissions).toHaveLength(1);
    expect(convPendingPerm.permissions[0].status).toBe('pending');
    expect(convPendingPerm.permissions[0].isSimulated).toBe(false);
    expect(convPendingPerm.permissions[0].commandSimulated).toBe('npm test');

    await adapter.respondPermission({
      conversationId: conv.conversation.id,
      requestId: convPendingPerm.permissions[0].id,
      decision: 'approved',
    });
    expect(confirmCalls).toHaveLength(1);
    expect(confirmCalls[0].url).toContain('/api/conversations/ext_conv_perm_3/confirmations/call_perm_99/confirm');
    expect(confirmCalls[0].body).toEqual({
      msg_id: 'm_perm_1',
      data: 'allow_once_id',
      always_allow: false,
    });
    expect(adapter.getStateSnapshot().conversations[conv.conversation.id].permissions[0].status).toBe('approved');

    capturedSock!.emitMessage({
      name: 'message.stream',
      data: {
        conversation_id: executor.sessionRef.externalConversationId,
        msg_id: 'm_perm_2',
        turn_id: 'turn_exec_1',
        type: 'acp_permission',
        data: {
          session_id: 'cli_s_1',
          tool_call: { tool_call_id: 'call_perm_100', title: 'Editar arquivo', kind: 'edit' },
          options: [{ option_id: 'allow_once_id', name: 'Allow', kind: 'allow_once' }],
        },
      },
    });
    capturedSock!.emitMessage({
      name: 'confirmation.remove',
      data: { conversation_id: executor.sessionRef.externalConversationId, id: 'call_perm_100' },
    });
    expect(adapter.getStateSnapshot().conversations[conv.conversation.id].permissions[1].status).toBe('approved');

    await adapter.controlExecution({
      conversationId: conv.conversation.id,
      action: 'request_interrupt',
      participantId: executor.id,
    });
    expect(cancelCalls).toHaveLength(1);
    expect(cancelCalls[0].url).toContain('/api/teams/team_perm_1/runs/run_active_1/agents/slot_perm_3/cancel');

    // Operational failure on running task sets executionStatus='failed' without penalizing quality
    capturedSock!.emitMessage({
      name: 'team.runFailed',
      data: {
        team_id: 'team_perm_1',
        team_run_id: 'run_fail_op_1',
        target_slot_id: executor.sessionRef.externalSlotId,
        reason: 'Processo CLI encerrado inesperadamente (exit 1).',
      },
    });
    const afterOpFail = adapter.getStateSnapshot().conversations[conv.conversation.id];
    const failedTask = afterOpFail.tasks[0];
    expect(failedTask.operationalFailureCount).toBe(1);
    expect(failedTask.qualityRejectionCount).toBe(0);
    expect(afterOpFail.conversation.executionStatus).toBe('failed');

    // Verify request_interrupt confirmation (team.childTurnCancelled) is distinct from request sent and sets executionStatus='idle'
    const reqEvents = afterOpFail.eventLog.filter(
      (e) => e.type === 'execution_control_applied' && e.origin === 'user',
    );
    expect(reqEvents).toHaveLength(1);
    capturedSock!.emitMessage({
      name: 'team.childTurnCancelled',
      data: {
        team_id: 'team_perm_1',
        team_run_id: 'run_active_1',
        slot_id: executor.sessionRef.externalSlotId,
        turn_id: 'turn_exec_1',
        reason: 'Cancelado pelo usuário',
      },
    });
    const afterCancelConfirm = adapter.getStateSnapshot().conversations[conv.conversation.id];
    const confirmEvents = afterCancelConfirm.eventLog.filter(
      (e) => e.type === 'execution_control_applied' && e.externalEventName === 'team.childTurnCancelled',
    );
    expect(confirmEvents).toHaveLength(1);
    expect(afterCancelConfirm.participants.find((p) => p.id === executor.id)?.status).toBe('idle');

    adapter.dispose();
  });

  it('proves permission denial sends reject option to Core and does not execute the denied operation (V6-05 recusa)', async () => {
    const confirmCalls: Array<{ url: string; body: unknown }> = [];
    let capturedSock: MockSocket | null = null;

    const fetchFn: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = (init?.method ?? 'GET').toUpperCase();
      if (url.endsWith('/login') && method === 'POST') {
        return jsonResponse({ success: true, user: { id: 'u1', username: 'admin' }, token: 'jwt_deny' });
      }
      if (url.endsWith('/api/agents/management') && method === 'GET') {
        return jsonResponse({
          success: true,
          data: [
            {
              id: 'codex-1', backend: 'codex', name: 'Codex', installed: true, enabled: true, status: 'online',
              available_models: { available_models: [{ id: 'gpt-6.1-terra', label: 'gpt-6.1-terra' }, { id: 'gpt-6.1-sol', label: 'gpt-6.1-sol' }] },
            },
            {
              id: 'antigravity-1', backend: 'antigravity', name: 'Antigravity', installed: true, enabled: true, status: 'online',
              available_models: { available_models: [{ id: 'gemini-4-hydrogen-high', label: 'gemini-4-hydrogen-high' }] },
            },
          ],
        });
      }
      if (url.endsWith('/api/assistants') && method === 'GET') {
        return jsonResponse({
          success: true,
          data: [
            { id: 'bare:codex-1', name: 'Codex', agent_id: 'codex-1', enabled: true, team_selectable: true },
            { id: 'bare:antigravity-1', name: 'Antigravity', agent_id: 'antigravity-1', enabled: true, team_selectable: true },
          ],
        });
      }
      if (url.endsWith('/api/ws-token') && method === 'GET') {
        return jsonResponse({ success: true, ws_token: 'ws_deny', expires_in: 300 });
      }
      if (url.endsWith('/api/teams') && method === 'POST') {
        const body = JSON.parse(String(init?.body ?? '{}')) as { agents?: Array<{ name: string; role: string; model?: string }> };
        return jsonResponse({
          success: true,
          data: {
            id: 'team_deny_1',
            name: 'Deny Team',
            assistants: (body.agents ?? []).map((a, idx) => ({
              slot_id: `slot_deny_${idx + 1}`,
              conversation_id: `ext_conv_deny_${idx + 1}`,
              name: a.name,
              role: a.role,
              model: a.model,
            })),
          },
        });
      }
      if (url.includes('/confirmations/') && url.endsWith('/confirm') && method === 'POST') {
        confirmCalls.push({ url, body: JSON.parse(String(init?.body ?? '{}')) });
        return jsonResponse({ success: true });
      }
      return jsonResponse({ success: true, data: { message_id: 'ack_deny', enqueue_status: 'started' } });
    };

    const persistence = new WorkspacePersistenceManager(new MemoryOnlyStorageDriver());
    const adapter = new AionCoreAdapter(persistence, {
      baseUrl: 'http://127.0.0.1:25828',
      fetchFn,
      wsFactory: (url, protocols) => {
        capturedSock = new MockSocket(url, protocols);
        return capturedSock;
      },
      readCookie: () => 'csrf_deny',
    });

    await adapter.loadWorkspace();
    await adapter.login('admin', 'secret');
    await adapter.refreshCoreCatalog();

    const proj = await adapter.createProject({
      name: 'Projeto Recusa',
      description: 'Teste recusa de permissão',
      workspacePathInfo: 'C:/tmp/deny-test',
    });
    const conv = await adapter.createConversation({ projectId: proj.id, title: 'Recusa Perm V6-05' });
    await adapter.createCoreTeamForConversation(conv.conversation.id);
    await adapter.connectWebSocket(conv.conversation.id);

    const team = adapter.getStateSnapshot().conversations[conv.conversation.id];
    const planner = team.participants.find((p) => p.roles.includes('planner'))!;
    const executor = team.participants.find((p) => p.roles.includes('executor'))!;

    // Planner emits plan with 1 task
    capturedSock!.emitMessage({
      name: 'message.stream',
      data: {
        conversation_id: planner.sessionRef.externalConversationId,
        msg_id: 'm_plan_deny',
        type: 'content',
        data: {
          content: '```aion-desk-json\n' + JSON.stringify({
            protocol: INTERNAL_PROTOCOL_VERSION,
            kind: 'plan_proposal',
            conversationId: conv.conversation.id,
            summary: 'Plano Recusa',
            tasks: [{
              title: 'Executar rm -rf perigoso',
              description: 'Comando perigoso que deve ser recusado',
              assigneeRole: 'executor',
              dependencies: [],
              acceptanceCriteria: ['OK'],
            }],
          }) + '\n```',
        },
      },
    });
    capturedSock!.emitMessage({
      name: 'message.stream',
      data: { conversation_id: planner.sessionRef.externalConversationId, msg_id: 'm_plan_deny', type: 'finish', data: {} },
    });
    await new Promise((r) => setTimeout(r, 30));

    // Executor requests permission for a dangerous command
    capturedSock!.emitMessage({
      name: 'message.stream',
      data: {
        conversation_id: executor.sessionRef.externalConversationId,
        msg_id: 'm_perm_deny_1',
        turn_id: 'turn_deny_1',
        type: 'acp_permission',
        data: {
          session_id: 'cli_deny',
          tool_call: {
            tool_call_id: 'call_deny_rm',
            title: 'Executar rm -rf /',
            kind: 'execute',
            raw_input: { command: 'rm -rf /' },
          },
          options: [
            { option_id: 'allow_once_id_rm', name: 'Allow once', kind: 'allow_once' },
            { option_id: 'reject_once_id_rm', name: 'Reject', kind: 'reject_once' },
          ],
        },
      },
    });

    // Verify permission is pending
    const convBeforeDeny = adapter.getStateSnapshot().conversations[conv.conversation.id];
    expect(convBeforeDeny.permissions).toHaveLength(1);
    expect(convBeforeDeny.permissions[0].status).toBe('pending');
    expect(convBeforeDeny.permissions[0].commandSimulated).toBe('rm -rf /');

    // User DENIES the permission
    await adapter.respondPermission({
      conversationId: conv.conversation.id,
      requestId: convBeforeDeny.permissions[0].id,
      decision: 'denied',
    });

    // Verify the DENY decision was sent to Core with the reject option ID
    expect(confirmCalls).toHaveLength(1);
    expect(confirmCalls[0].url).toContain('/api/conversations/ext_conv_deny_');
    expect(confirmCalls[0].url).toContain('/confirmations/call_deny_rm/confirm');
    expect(confirmCalls[0].body).toEqual({
      msg_id: 'm_perm_deny_1',
      data: 'reject_once_id_rm',
      always_allow: false,
    });

    // Verify permission status is now denied
    const convAfterDeny = adapter.getStateSnapshot().conversations[conv.conversation.id];
    expect(convAfterDeny.permissions[0].status).toBe('denied');

    // Verify the task is NOT completed (operation was blocked by denial)
    expect(convAfterDeny.tasks[0].status).not.toBe('completed');

    // Verify qualityRejectionCount and operationalFailureCount were NOT incremented by denial
    expect(convAfterDeny.tasks[0].qualityRejectionCount).toBe(0);
    expect(convAfterDeny.tasks[0].operationalFailureCount).toBe(0);

    adapter.dispose();
  });

  it('does not auto-complete task when executor output lacks aion-desk-json block (invalid output fallback V6-05)', async () => {
    let capturedSock: MockSocket | null = null;

    const fetchFn: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = (init?.method ?? 'GET').toUpperCase();
      if (url.endsWith('/login') && method === 'POST') {
        return jsonResponse({ success: true, user: { id: 'u1', username: 'admin' }, token: 'jwt_inv' });
      }
      if (url.endsWith('/api/agents/management') && method === 'GET') {
        return jsonResponse({
          success: true,
          data: [
            {
              id: 'codex-1', backend: 'codex', name: 'Codex', installed: true, enabled: true, status: 'online',
              available_models: { available_models: [{ id: 'gpt-6.1-terra', label: 'gpt-6.1-terra' }] },
            },
            {
              id: 'antigravity-1', backend: 'antigravity', name: 'Antigravity', installed: true, enabled: true, status: 'online',
              available_models: { available_models: [{ id: 'gemini-4-hydrogen-high', label: 'gemini-4-hydrogen-high' }] },
            },
          ],
        });
      }
      if (url.endsWith('/api/assistants') && method === 'GET') {
        return jsonResponse({
          success: true,
          data: [
            { id: 'bare:codex-1', name: 'Codex', agent_id: 'codex-1', enabled: true, team_selectable: true },
            { id: 'bare:antigravity-1', name: 'Antigravity', agent_id: 'antigravity-1', enabled: true, team_selectable: true },
          ],
        });
      }
      if (url.endsWith('/api/ws-token') && method === 'GET') {
        return jsonResponse({ success: true, ws_token: 'ws_inv', expires_in: 300 });
      }
      if (url.endsWith('/api/teams') && method === 'POST') {
        const body = JSON.parse(String(init?.body ?? '{}')) as { agents?: Array<{ name: string; role: string; model?: string }> };
        return jsonResponse({
          success: true,
          data: {
            id: 'team_inv_1',
            name: 'Invalid Output Team',
            assistants: (body.agents ?? []).map((a, idx) => ({
              slot_id: `slot_inv_${idx + 1}`,
              conversation_id: `ext_conv_inv_${idx + 1}`,
              name: a.name,
              role: a.role,
              model: a.model,
            })),
          },
        });
      }
      return jsonResponse({ success: true, data: { message_id: 'ack_inv', enqueue_status: 'started' } });
    };

    const persistence = new WorkspacePersistenceManager(new MemoryOnlyStorageDriver());
    const adapter = new AionCoreAdapter(persistence, {
      baseUrl: 'http://127.0.0.1:25828',
      fetchFn,
      wsFactory: (url, protocols) => {
        capturedSock = new MockSocket(url, protocols);
        return capturedSock;
      },
      readCookie: () => 'csrf_inv',
    });

    await adapter.loadWorkspace();
    await adapter.login('admin', 'secret');
    await adapter.refreshCoreCatalog();

    const proj = await adapter.createProject({
      name: 'Projeto Invalid Out',
      description: 'Teste saída inválida',
      workspacePathInfo: 'C:/tmp/invalid-out',
    });
    const conv = await adapter.createConversation({ projectId: proj.id, title: 'Invalid Output V6-05' });
    await adapter.createCoreTeamForConversation(conv.conversation.id);
    await adapter.connectWebSocket(conv.conversation.id);

    const team = adapter.getStateSnapshot().conversations[conv.conversation.id];
    const planner = team.participants.find((p) => p.roles.includes('planner'))!;
    const executor = team.participants.find((p) => p.roles.includes('executor'))!;

    // Planner emits plan with 1 task
    capturedSock!.emitMessage({
      name: 'message.stream',
      data: {
        conversation_id: planner.sessionRef.externalConversationId,
        msg_id: 'm_plan_inv',
        type: 'content',
        data: {
          content: '```aion-desk-json\n' + JSON.stringify({
            protocol: INTERNAL_PROTOCOL_VERSION,
            kind: 'plan_proposal',
            conversationId: conv.conversation.id,
            summary: 'Plano Invalid Out',
            tasks: [{
              title: 'Criar arquivo de teste',
              description: 'Deve responder com delivery_report',
              assigneeRole: 'executor',
              dependencies: [],
              acceptanceCriteria: ['Arquivo existe'],
            }],
          }) + '\n```',
        },
      },
    });
    capturedSock!.emitMessage({
      name: 'message.stream',
      data: { conversation_id: planner.sessionRef.externalConversationId, msg_id: 'm_plan_inv', type: 'finish', data: {} },
    });
    await new Promise((r) => setTimeout(r, 30));

    // Task should be dispatched (queued -> running)
    const afterPlan = adapter.getStateSnapshot().conversations[conv.conversation.id];
    expect(afterPlan.tasks).toHaveLength(1);

    // Executor responds WITHOUT aion-desk-json block (plain text only)
    capturedSock!.emitMessage({
      name: 'message.stream',
      data: {
        conversation_id: executor.sessionRef.externalConversationId,
        msg_id: 'm_inv_response',
        turn_id: 'turn_inv_1',
        type: 'content',
        data: { content: 'Pronto, criei o arquivo. Tudo certo!' },
      },
    });
    capturedSock!.emitMessage({
      name: 'message.stream',
      data: { conversation_id: executor.sessionRef.externalConversationId, msg_id: 'm_inv_response', type: 'finish', data: {} },
    });
    await new Promise((r) => setTimeout(r, 30));

    // Task MUST NOT be completed — the output lacked structured block
    const afterInvalid = adapter.getStateSnapshot().conversations[conv.conversation.id];
    expect(afterInvalid.tasks[0].status).not.toBe('completed');
    expect(afterInvalid.tasks[0].reviews).toHaveLength(0);

    // The message should still be stored as agent_message_posted with parseStatus info
    const msgEvents = afterInvalid.eventLog.filter(
      (e) => e.type === 'agent_message_posted' && e.participantId === executor.id,
    );
    expect(msgEvents.length).toBeGreaterThanOrEqual(1);
    const lastMsg = msgEvents[msgEvents.length - 1];
    // Check it was projected to general (since envelope was invalid/incomplete)
    expect((lastMsg.payload as Record<string, unknown>).projectToGeneral).toBe(true);

    // Also test malformed JSON in aion-desk-json block
    capturedSock!.emitMessage({
      name: 'message.stream',
      data: {
        conversation_id: executor.sessionRef.externalConversationId,
        msg_id: 'm_inv_malformed',
        turn_id: 'turn_inv_2',
        type: 'content',
        data: { content: '```aion-desk-json\n{ "protocol": "wrong-version", "kind": "delivery_report" }\n```' },
      },
    });
    capturedSock!.emitMessage({
      name: 'message.stream',
      data: { conversation_id: executor.sessionRef.externalConversationId, msg_id: 'm_inv_malformed', type: 'finish', data: {} },
    });
    await new Promise((r) => setTimeout(r, 30));

    // Still no auto-completion — wrong protocol version
    const afterMalformed = adapter.getStateSnapshot().conversations[conv.conversation.id];
    expect(afterMalformed.tasks[0].status).not.toBe('completed');
    expect(afterMalformed.tasks[0].reviews).toHaveLength(0);

    adapter.dispose();
  });

  it('enforces strict task/attempt/author correlation on delivery_report & review_decision, rejects stale/nonexistent IDs for manual review, handles idempotent duplicates, and preserves valid flow (V6-05 P1)', async () => {
    const outgoingPosts: Array<{ url: string; content: string }> = [];
    let capturedSock: MockSocket | null = null;

    const fetchFn: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = (init?.method ?? 'GET').toUpperCase();
      if (url.endsWith('/login') && method === 'POST') {
        return jsonResponse({ success: true, user: { id: 'u1', username: 'admin' }, token: 'jwt_p1' });
      }
      if (url.endsWith('/api/agents/management') && method === 'GET') {
        return jsonResponse({
          success: true,
          data: [
            {
              id: 'codex-1', backend: 'codex', name: 'Codex', installed: true, enabled: true, status: 'online',
              available_models: { available_models: [{ id: 'gpt-6.1-terra', label: 'gpt-6.1-terra' }, { id: 'gpt-6.1-sol', label: 'gpt-6.1-sol' }] },
            },
            {
              id: 'antigravity-1', backend: 'antigravity', name: 'Antigravity', installed: true, enabled: true, status: 'online',
              available_models: { available_models: [{ id: 'gemini-4-hydrogen-high', label: 'gemini-4-hydrogen-high' }] },
            },
          ],
        });
      }
      if (url.endsWith('/api/assistants') && method === 'GET') {
        return jsonResponse({
          success: true,
          data: [
            { id: 'bare:codex-1', name: 'Codex', agent_id: 'codex-1', enabled: true, team_selectable: true },
            { id: 'bare:antigravity-1', name: 'Antigravity', agent_id: 'antigravity-1', enabled: true, team_selectable: true },
          ],
        });
      }
      if (url.endsWith('/api/ws-token') && method === 'GET') {
        return jsonResponse({ success: true, ws_token: 'ws_p1', expires_in: 300 });
      }
      if (url.endsWith('/api/teams') && method === 'POST') {
        const body = JSON.parse(String(init?.body ?? '{}')) as { agents?: Array<{ name: string; role: string; model?: string }> };
        return jsonResponse({
          success: true,
          data: {
            id: 'team_p1',
            name: 'P1 Team',
            assistants: (body.agents ?? []).map((a, idx) => ({
              slot_id: `slot_p1_${idx + 1}`,
              conversation_id: `ext_conv_p1_${idx + 1}`,
              name: a.name,
              role: a.role,
              model: a.model,
            })),
          },
        });
      }
      if (url.includes('/messages') && method === 'POST') {
        const parsed = JSON.parse(String(init?.body ?? '{}')) as { content?: string };
        outgoingPosts.push({ url, content: parsed.content ?? '' });
        return jsonResponse({ success: true, data: { message_id: `ack_p1_${outgoingPosts.length}`, enqueue_status: 'started' } });
      }
      return jsonResponse({ success: true, data: {} });
    };

    const persistence = new WorkspacePersistenceManager(new MemoryOnlyStorageDriver());
    const adapter = new AionCoreAdapter(persistence, {
      baseUrl: 'http://127.0.0.1:25828',
      fetchFn,
      wsFactory: (url, protocols) => {
        capturedSock = new MockSocket(url, protocols);
        return capturedSock;
      },
      readCookie: () => 'csrf_p1',
    });

    await adapter.loadWorkspace();
    await adapter.login('admin', 'secret');
    await adapter.refreshCoreCatalog();

    const proj = await adapter.createProject({
      name: 'Projeto P1 Correlação',
      description: 'Teste P1 estrito',
      workspacePathInfo: 'C:/tmp/v605-p1',
    });
    const conv = await adapter.createConversation({ projectId: proj.id, title: 'V6-05 P1 Estrito' });
    const convId = conv.conversation.id;
    await adapter.createCoreTeamForConversation(convId);
    await adapter.connectWebSocket(convId);

    const team = adapter.getStateSnapshot().conversations[convId];
    const planner = team.participants.find((p) => p.roles.includes('planner'))!;
    const reviewer = team.participants.find((p) => p.roles.includes('reviewer'))!;
    const executor = team.participants.find((p) => p.roles.includes('executor'))!;

    const emitTurn = (extConvId: string, msgId: string, content: string) => {
      capturedSock!.emitMessage({
        name: 'message.stream',
        data: { conversation_id: extConvId, msg_id: msgId, turn_id: `t_${msgId}`, type: 'content', data: { content } },
      });
      capturedSock!.emitMessage({
        name: 'message.stream',
        data: { conversation_id: extConvId, msg_id: msgId, turn_id: `t_${msgId}`, type: 'finish', data: {} },
      });
    };

    // Planner emits 1 task -> Attempt #1 dispatched to executor
    emitTurn(
      planner.sessionRef.externalConversationId!,
      'm_plan_p1',
      '```aion-desk-json\n' + JSON.stringify({
        protocol: INTERNAL_PROTOCOL_VERSION,
        kind: 'plan_proposal',
        conversationId: convId,
        summary: 'Plano P1',
        tasks: [{
          title: 'Tarefa correlacionada',
          description: 'Validar correlação estrita',
          assigneeRole: 'executor',
          dependencies: [],
          acceptanceCriteria: ['OK'],
        }],
      }) + '\n```',
    );
    await new Promise((r) => setTimeout(r, 30));

    const afterPlan = adapter.getStateSnapshot().conversations[convId];
    const task = afterPlan.tasks[0];
    const att1 = task.attempts[0];
    expect(task.status).toBe('running');
    expect(att1.status).toBe('running');
    const postsAfterPlan = outgoingPosts.length;

    // Repro 1: delivery_report with nonexistent taskId MUST NOT affect current task
    emitTurn(
      executor.sessionRef.externalConversationId!,
      'm_del_bad_task',
      '```aion-desk-json\n' + JSON.stringify({
        protocol: INTERNAL_PROTOCOL_VERSION,
        kind: 'delivery_report',
        conversationId: convId,
        taskId: 'task_inexistente_999',
        attemptId: att1.id,
        deliverySummary: 'Falsa entrega tarefa inexistente',
        evidenceNotes: ['fake'],
      }) + '\n```',
    );
    await new Promise((r) => setTimeout(r, 30));
    let snap = adapter.getStateSnapshot().conversations[convId];
    expect(snap.tasks[0].status).toBe('running');
    expect(snap.tasks[0].attempts[0].status).toBe('running');
    expect(outgoingPosts.length).toBe(postsAfterPlan);
    expect(snap.messagesByTab[executor.id].find((m) => m.id === 'msg_core_m_del_bad_task')?.parseStatus).toBe('invalid');

    // Repro 2: delivery_report with nonexistent explicit attemptId MUST NOT affect current attempt or create implicit attempt
    emitTurn(
      executor.sessionRef.externalConversationId!,
      'm_del_bad_att',
      '```aion-desk-json\n' + JSON.stringify({
        protocol: INTERNAL_PROTOCOL_VERSION,
        kind: 'delivery_report',
        conversationId: convId,
        taskId: task.id,
        attemptId: 'att_inexistente_999',
        deliverySummary: 'Falsa entrega tentativa inexistente',
        evidenceNotes: ['fake'],
      }) + '\n```',
    );
    await new Promise((r) => setTimeout(r, 30));
    snap = adapter.getStateSnapshot().conversations[convId];
    expect(snap.tasks[0].status).toBe('running');
    expect(snap.tasks[0].attempts).toHaveLength(1);
    expect(snap.tasks[0].attempts[0].status).toBe('running');
    expect(outgoingPosts.length).toBe(postsAfterPlan);
    expect(snap.messagesByTab[executor.id].find((m) => m.id === 'msg_core_m_del_bad_att')?.parseStatus).toBe('invalid');

    // Non-executor attempting delivery_report MUST be rejected
    emitTurn(
      reviewer.sessionRef.externalConversationId!,
      'm_del_wrong_role',
      '```aion-desk-json\n' + JSON.stringify({
        protocol: INTERNAL_PROTOCOL_VERSION,
        kind: 'delivery_report',
        conversationId: convId,
        taskId: task.id,
        attemptId: att1.id,
        deliverySummary: 'Auditor fingindo ser executor',
        evidenceNotes: [],
      }) + '\n```',
    );
    await new Promise((r) => setTimeout(r, 30));
    snap = adapter.getStateSnapshot().conversations[convId];
    expect(snap.tasks[0].status).toBe('running');
    expect(snap.messagesByTab[reviewer.id].find((m) => m.id === 'msg_core_m_del_wrong_role')?.parseStatus).toBe('invalid');

    // Valid delivery_report with attemptId omitted (unambiguously matches the single active latest running attempt)
    emitTurn(
      executor.sessionRef.externalConversationId!,
      'm_del_valid_1',
      '```aion-desk-json\n' + JSON.stringify({
        protocol: INTERNAL_PROTOCOL_VERSION,
        kind: 'delivery_report',
        conversationId: convId,
        taskId: task.id,
        deliverySummary: 'Entrega válida 1',
        evidenceNotes: ['ev1'],
      }) + '\n```',
    );
    await new Promise((r) => setTimeout(r, 30));
    snap = adapter.getStateSnapshot().conversations[convId];
    expect(snap.tasks[0].status).toBe('awaiting_review');
    expect(snap.tasks[0].attempts[0].status).toBe('delivered');
    const postsAfterDel1 = outgoingPosts.length;
    expect(postsAfterDel1).toBe(postsAfterPlan + 1);

    // Idempotent duplicate delivery_report (new msg_id, same task/attempt) MUST NOT dispatch a 2nd review
    emitTurn(
      executor.sessionRef.externalConversationId!,
      'm_del_dup_1',
      '```aion-desk-json\n' + JSON.stringify({
        protocol: INTERNAL_PROTOCOL_VERSION,
        kind: 'delivery_report',
        conversationId: convId,
        taskId: task.id,
        attemptId: att1.id,
        deliverySummary: 'Reentrega duplicada 1',
        evidenceNotes: ['ev1'],
      }) + '\n```',
    );
    await new Promise((r) => setTimeout(r, 30));
    expect(outgoingPosts.length).toBe(postsAfterDel1);

    // Repro 3: review_decision approved with nonexistent taskId MUST NOT complete current task
    emitTurn(
      reviewer.sessionRef.externalConversationId!,
      'm_rev_bad_task',
      '```aion-desk-json\n' + JSON.stringify({
        protocol: INTERNAL_PROTOCOL_VERSION,
        kind: 'review_decision',
        conversationId: convId,
        taskId: 'task_inexistente_999',
        attemptId: att1.id,
        decision: 'approved',
        rationale: 'Falsa aprovação tarefa inexistente',
        unmetCriteria: [],
      }) + '\n```',
    );
    await new Promise((r) => setTimeout(r, 30));
    snap = adapter.getStateSnapshot().conversations[convId];
    expect(snap.tasks[0].status).toBe('awaiting_review');
    expect(snap.tasks[0].reviews).toHaveLength(0);
    expect(snap.messagesByTab[reviewer.id].find((m) => m.id === 'msg_core_m_rev_bad_task')?.parseStatus).toBe('invalid');

    // Repro 4: review_decision approved with nonexistent explicit attemptId MUST NOT approve current attempt
    emitTurn(
      reviewer.sessionRef.externalConversationId!,
      'm_rev_bad_att',
      '```aion-desk-json\n' + JSON.stringify({
        protocol: INTERNAL_PROTOCOL_VERSION,
        kind: 'review_decision',
        conversationId: convId,
        taskId: task.id,
        attemptId: 'att_inexistente_999',
        decision: 'approved',
        rationale: 'Falsa aprovação tentativa inexistente',
        unmetCriteria: [],
      }) + '\n```',
    );
    await new Promise((r) => setTimeout(r, 30));
    snap = adapter.getStateSnapshot().conversations[convId];
    expect(snap.tasks[0].status).toBe('awaiting_review');
    expect(snap.tasks[0].attempts[0].status).toBe('delivered');
    expect(snap.tasks[0].reviews).toHaveLength(0);
    expect(snap.messagesByTab[reviewer.id].find((m) => m.id === 'msg_core_m_rev_bad_att')?.parseStatus).toBe('invalid');

    // Non-reviewer attempting review_decision MUST be rejected
    emitTurn(
      executor.sessionRef.externalConversationId!,
      'm_rev_wrong_role',
      '```aion-desk-json\n' + JSON.stringify({
        protocol: INTERNAL_PROTOCOL_VERSION,
        kind: 'review_decision',
        conversationId: convId,
        taskId: task.id,
        attemptId: att1.id,
        decision: 'approved',
        rationale: 'Executor se auto-aprovando',
        unmetCriteria: [],
      }) + '\n```',
    );
    await new Promise((r) => setTimeout(r, 30));
    snap = adapter.getStateSnapshot().conversations[convId];
    expect(snap.tasks[0].status).toBe('awaiting_review');
    expect(snap.tasks[0].reviews).toHaveLength(0);

    // Valid rejection on Attempt #1 -> dispatches Attempt #2 (running)
    emitTurn(
      reviewer.sessionRef.externalConversationId!,
      'm_rev_rej_1',
      '```aion-desk-json\n' + JSON.stringify({
        protocol: INTERNAL_PROTOCOL_VERSION,
        kind: 'review_decision',
        conversationId: convId,
        taskId: task.id,
        attemptId: att1.id,
        decision: 'rejected',
        rationale: 'Precisa corrigir',
        unmetCriteria: ['OK'],
      }) + '\n```',
    );
    await new Promise((r) => setTimeout(r, 30));
    snap = adapter.getStateSnapshot().conversations[convId];
    expect(snap.tasks[0].attempts).toHaveLength(2);
    expect(snap.tasks[0].status).toBe('running');
    expect(snap.tasks[0].attempts[0].status).toBe('rejected_quality');
    expect(snap.tasks[0].attempts[1].status).toBe('running');
    const att2 = snap.tasks[0].attempts[1];
    const postsAfterAtt2 = outgoingPosts.length;

    // Repro 5: Stale review_decision approved targeting att1 while att2 is running (even if seenEventIds did not block it!)
    // Simulate a state where att1's revEvtId is absent from seenEventIds to verify semantic guard directly
    snap.seenEventIds = snap.seenEventIds.filter((id) => !id.includes(`evt_core_rev_${task.id}_${att1.id}`));
    emitTurn(
      reviewer.sessionRef.externalConversationId!,
      'm_rev_stale_old_att',
      '```aion-desk-json\n' + JSON.stringify({
        protocol: INTERNAL_PROTOCOL_VERSION,
        kind: 'review_decision',
        conversationId: convId,
        taskId: task.id,
        attemptId: att1.id,
        decision: 'approved',
        rationale: 'Parecer atrasado de tentativa antiga',
        unmetCriteria: [],
      }) + '\n```',
    );
    await new Promise((r) => setTimeout(r, 30));
    snap = adapter.getStateSnapshot().conversations[convId];
    expect(snap.tasks[0].status).toBe('running');
    expect(snap.tasks[0].attempts[0].status).toBe('rejected_quality');
    expect(snap.tasks[0].attempts[1].status).toBe('running');
    expect(snap.tasks[0].reviews).toHaveLength(1);
    expect(snap.messagesByTab[reviewer.id].find((m) => m.id === 'msg_core_m_rev_stale_old_att')?.parseStatus).toBe('invalid');

    // Stale delivery_report targeting att1 while att2 is running MUST also be rejected
    emitTurn(
      executor.sessionRef.externalConversationId!,
      'm_del_stale_old_att',
      '```aion-desk-json\n' + JSON.stringify({
        protocol: INTERNAL_PROTOCOL_VERSION,
        kind: 'delivery_report',
        conversationId: convId,
        taskId: task.id,
        attemptId: att1.id,
        deliverySummary: 'Entrega atrasada de att1',
        evidenceNotes: [],
      }) + '\n```',
    );
    await new Promise((r) => setTimeout(r, 30));
    snap = adapter.getStateSnapshot().conversations[convId];
    expect(snap.tasks[0].status).toBe('running');
    expect(snap.tasks[0].attempts[1].status).toBe('running');
    expect(outgoingPosts.length).toBe(postsAfterAtt2);
    expect(snap.messagesByTab[executor.id].find((m) => m.id === 'msg_core_m_del_stale_old_att')?.parseStatus).toBe('invalid');

    // Positive valid flow: deliver att2 + approve att2 -> completed!
    emitTurn(
      executor.sessionRef.externalConversationId!,
      'm_del_valid_2',
      '```aion-desk-json\n' + JSON.stringify({
        protocol: INTERNAL_PROTOCOL_VERSION,
        kind: 'delivery_report',
        conversationId: convId,
        taskId: task.id,
        attemptId: att2.id,
        deliverySummary: 'Entrega corrigida 2',
        evidenceNotes: ['ev2'],
      }) + '\n```',
    );
    await new Promise((r) => setTimeout(r, 30));
    expect(adapter.getStateSnapshot().conversations[convId].tasks[0].status).toBe('awaiting_review');

    emitTurn(
      reviewer.sessionRef.externalConversationId!,
      'm_rev_valid_2',
      '```aion-desk-json\n' + JSON.stringify({
        protocol: INTERNAL_PROTOCOL_VERSION,
        kind: 'review_decision',
        conversationId: convId,
        taskId: task.id,
        attemptId: att2.id,
        decision: 'approved',
        rationale: 'Corrigido e verificado',
        unmetCriteria: [],
      }) + '\n```',
    );
    await new Promise((r) => setTimeout(r, 30));
    snap = adapter.getStateSnapshot().conversations[convId];
    expect(snap.tasks[0].status).toBe('completed');
    expect(snap.tasks[0].attempts[1].status).toBe('approved');
    expect(snap.tasks[0].reviews).toHaveLength(2);
    expect(snap.conversation.executionStatus).toBe('completed');

    // Idempotent duplicate review_decision on completed att2 MUST NOT add a 3rd review
    emitTurn(
      reviewer.sessionRef.externalConversationId!,
      'm_rev_dup_2',
      '```aion-desk-json\n' + JSON.stringify({
        protocol: INTERNAL_PROTOCOL_VERSION,
        kind: 'review_decision',
        conversationId: convId,
        taskId: task.id,
        attemptId: att2.id,
        decision: 'approved',
        rationale: 'Corrigido e verificado',
        unmetCriteria: [],
      }) + '\n```',
    );
    await new Promise((r) => setTimeout(r, 30));
    snap = adapter.getStateSnapshot().conversations[convId];
    expect(snap.tasks[0].reviews).toHaveLength(2);
    expect(snap.tasks[0].status).toBe('completed');

    adapter.dispose();
  });

  it('rejects late delivery/review after cancellation and sets conversation blocked when attempt cap stalls a dependent task (V6-05 P1+P2)', async () => {
    let capturedSock: MockSocket | null = null;
    let teamSeq = 0;

    const fetchFn: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = (init?.method ?? 'GET').toUpperCase();
      if (url.endsWith('/login') && method === 'POST') {
        return jsonResponse({ success: true, user: { id: 'u1', username: 'admin' }, token: 'jwt_p12' });
      }
      if (url.endsWith('/api/agents/management') && method === 'GET') {
        return jsonResponse({
          success: true,
          data: [
            {
              id: 'codex-1', backend: 'codex', name: 'Codex', installed: true, enabled: true, status: 'online',
              available_models: { available_models: [{ id: 'gpt-6.1-terra', label: 'gpt-6.1-terra' }] },
            },
            {
              id: 'antigravity-1', backend: 'antigravity', name: 'Antigravity', installed: true, enabled: true, status: 'online',
              available_models: { available_models: [{ id: 'gemini-4-hydrogen-high', label: 'gemini-4-hydrogen-high' }] },
            },
          ],
        });
      }
      if (url.endsWith('/api/assistants') && method === 'GET') {
        return jsonResponse({
          success: true,
          data: [
            { id: 'bare:codex-1', name: 'Codex', agent_id: 'codex-1', enabled: true, team_selectable: true },
            { id: 'bare:antigravity-1', name: 'Antigravity', agent_id: 'antigravity-1', enabled: true, team_selectable: true },
          ],
        });
      }
      if (url.endsWith('/api/ws-token') && method === 'GET') {
        return jsonResponse({ success: true, ws_token: 'ws_p12', expires_in: 300 });
      }
      if (url.endsWith('/api/teams') && method === 'POST') {
        teamSeq += 1;
        const tSeq = teamSeq;
        const body = JSON.parse(String(init?.body ?? '{}')) as { agents?: Array<{ name: string; role: string; model?: string }> };
        return jsonResponse({
          success: true,
          data: {
            id: `team_p12_${tSeq}`,
            name: `P12 Team ${tSeq}`,
            assistants: (body.agents ?? []).map((a, idx) => ({
              slot_id: `slot_p12_${tSeq}_${idx + 1}`,
              conversation_id: `ext_conv_p12_${tSeq}_${idx + 1}`,
              name: a.name,
              role: a.role,
              model: a.model,
            })),
          },
        });
      }
      return jsonResponse({ success: true, data: { message_id: 'ack_p12', enqueue_status: 'started' } });
    };

    const persistence = new WorkspacePersistenceManager(new MemoryOnlyStorageDriver());
    const adapter = new AionCoreAdapter(persistence, {
      baseUrl: 'http://127.0.0.1:25828',
      fetchFn,
      wsFactory: (url, protocols) => {
        capturedSock = new MockSocket(url, protocols);
        return capturedSock;
      },
      readCookie: () => 'csrf_p12',
    });

    await adapter.loadWorkspace();
    await adapter.login('admin', 'secret');
    await adapter.refreshCoreCatalog();
    await adapter.updateModelPolicy({
      approvalMode: 'auto_policy',
      qualityRejectionsBeforeSuggest: 2,
      defaultExecutorTier: 'fast',
      reviewerTier: 'review',
      escalationTargetTier: 'advanced',
    });

    const proj = await adapter.createProject({
      name: 'Projeto P1+P2',
      description: 'Cancelamento tardio + teto com dependente',
      workspacePathInfo: 'C:/tmp/v605-p12',
    });
    const conv = await adapter.createConversation({ projectId: proj.id, title: 'V6-05 P1+P2' });
    const convId = conv.conversation.id;
    await adapter.createCoreTeamForConversation(convId);
    await adapter.connectWebSocket(convId);

    const team = adapter.getStateSnapshot().conversations[convId];
    const planner = team.participants.find((p) => p.roles.includes('planner'))!;
    const reviewer = team.participants.find((p) => p.roles.includes('reviewer'))!;
    const executor = team.participants.find((p) => p.roles.includes('executor'))!;

    const emitTurn = (extConvId: string, msgId: string, content: string) => {
      capturedSock!.emitMessage({
        name: 'message.stream',
        data: { conversation_id: extConvId, msg_id: msgId, turn_id: `t_${msgId}`, type: 'content', data: { content } },
      });
      capturedSock!.emitMessage({
        name: 'message.stream',
        data: { conversation_id: extConvId, msg_id: msgId, turn_id: `t_${msgId}`, type: 'finish', data: {} },
      });
    };

    // Part A: Plan with Task A and dependent Task B -> hit 3-attempt cap on A -> conversation MUST become 'blocked' (not stay 'running')
    emitTurn(
      planner.sessionRef.externalConversationId!,
      'm_plan_dep_cap',
      '```aion-desk-json\n' + JSON.stringify({
        protocol: INTERNAL_PROTOCOL_VERSION,
        kind: 'plan_proposal',
        conversationId: convId,
        summary: 'Plano dependente',
        tasks: [
          {
            title: 'Tarefa A',
            description: 'Base',
            assigneeRole: 'executor',
            dependencies: [],
            acceptanceCriteria: ['OK'],
          },
          {
            title: 'Tarefa B dependente',
            description: 'Depende de A',
            assigneeRole: 'executor',
            dependencies: ['Tarefa A'],
            acceptanceCriteria: ['OK'],
          },
        ],
      }) + '\n```',
    );
    await new Promise((r) => setTimeout(r, 30));

    // Force B to 'queued' with dependency on A (exact auditor reproduction!)
    let snap = adapter.getStateSnapshot().conversations[convId];
    const taskA = snap.tasks[0];
    const taskB = snap.tasks[1];
    expect(taskB.dependencyTaskIds).toContain(taskA.id);
    taskB.status = 'queued';

    for (let i = 1; i <= 3; i += 1) {
      snap = adapter.getStateSnapshot().conversations[convId];
      const currentAtt = snap.tasks[0].attempts[i - 1];
      emitTurn(
        executor.sessionRef.externalConversationId!,
        `m_cap_del_${i}`,
        '```aion-desk-json\n' + JSON.stringify({
          protocol: INTERNAL_PROTOCOL_VERSION,
          kind: 'delivery_report',
          conversationId: convId,
          taskId: taskA.id,
          attemptId: currentAtt.id,
          deliverySummary: `Tentativa ${i}`,
          evidenceNotes: [],
        }) + '\n```',
      );
      await new Promise((r) => setTimeout(r, 30));
      emitTurn(
        reviewer.sessionRef.externalConversationId!,
        `m_cap_rev_${i}`,
        '```aion-desk-json\n' + JSON.stringify({
          protocol: INTERNAL_PROTOCOL_VERSION,
          kind: 'review_decision',
          conversationId: convId,
          taskId: taskA.id,
          attemptId: currentAtt.id,
          decision: 'rejected',
          rationale: `Reprovada #${i}`,
          unmetCriteria: ['OK'],
        }) + '\n```',
      );
      await new Promise((r) => setTimeout(r, 30));
    }

    snap = adapter.getStateSnapshot().conversations[convId];
    expect(snap.tasks[0].status).toBe('blocked');
    expect(snap.tasks[1].status).toBe('queued');
    expect(snap.conversation.executionStatus).toBe('blocked');

    // Late delivery & late approval after attempt cap MUST be rejected as invalid
    emitTurn(
      executor.sessionRef.externalConversationId!,
      'm_late_after_cap_del',
      '```aion-desk-json\n' + JSON.stringify({
        protocol: INTERNAL_PROTOCOL_VERSION,
        kind: 'delivery_report',
        conversationId: convId,
        taskId: taskA.id,
        deliverySummary: 'Entrega tardia pós-teto',
        evidenceNotes: [],
      }) + '\n```',
    );
    emitTurn(
      reviewer.sessionRef.externalConversationId!,
      'm_late_after_cap_rev',
      '```aion-desk-json\n' + JSON.stringify({
        protocol: INTERNAL_PROTOCOL_VERSION,
        kind: 'review_decision',
        conversationId: convId,
        taskId: taskA.id,
        decision: 'approved',
        rationale: 'Aprovação tardia pós-teto',
        unmetCriteria: [],
      }) + '\n```',
    );
    await new Promise((r) => setTimeout(r, 30));
    snap = adapter.getStateSnapshot().conversations[convId];
    expect(snap.tasks[0].status).toBe('blocked');
    expect(snap.tasks[0].reviews).toHaveLength(3);
    expect(snap.messagesByTab[executor.id].find((m) => m.id === 'msg_core_m_late_after_cap_del')?.parseStatus).toBe('invalid');
    expect(snap.messagesByTab[reviewer.id].find((m) => m.id === 'msg_core_m_late_after_cap_rev')?.parseStatus).toBe('invalid');

    // Part B: Late delivery after cancellation in a fresh conversation MUST NOT complete or reopen cancelled task
    const convCancel = await adapter.createConversation({ projectId: proj.id, title: 'V6-05 Cancel Tardio' });
    const cId = convCancel.conversation.id;
    await adapter.createCoreTeamForConversation(cId);
    await adapter.connectWebSocket(cId);
    const cTeam = adapter.getStateSnapshot().conversations[cId];
    const cPlan = cTeam.participants.find((p) => p.roles.includes('planner'))!;
    const cExec = cTeam.participants.find((p) => p.roles.includes('executor'))!;
    const cRev = cTeam.participants.find((p) => p.roles.includes('reviewer'))!;

    emitTurn(
      cPlan.sessionRef.externalConversationId!,
      'm_c_plan',
      '```aion-desk-json\n' + JSON.stringify({
        protocol: INTERNAL_PROTOCOL_VERSION,
        kind: 'plan_proposal',
        conversationId: cId,
        summary: 'Plano cancel',
        tasks: [{
          title: 'Tarefa cancelada',
          description: 'Será interrompida',
          assigneeRole: 'executor',
          dependencies: [],
          acceptanceCriteria: ['OK'],
        }],
      }) + '\n```',
    );
    await new Promise((r) => setTimeout(r, 30));
    const cTask = adapter.getStateSnapshot().conversations[cId].tasks[0];
    const cAtt = cTask.attempts[0];

    capturedSock!.emitMessage({
      name: 'team.childTurnCancelled',
      data: {
        team_id: 'team_p12_2',
        team_run_id: 'run_cancel_1',
        slot_id: cExec.sessionRef.externalSlotId,
        turn_id: 'turn_cancel_1',
        reason: 'Interrompido',
      },
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(adapter.getStateSnapshot().conversations[cId].tasks[0].status).toBe('cancelled');
    expect(adapter.getStateSnapshot().conversations[cId].conversation.executionStatus).toBe('idle');

    // Late delivery & late approval after cancel MUST be rejected for manual review
    emitTurn(
      cExec.sessionRef.externalConversationId!,
      'm_c_late_del',
      '```aion-desk-json\n' + JSON.stringify({
        protocol: INTERNAL_PROTOCOL_VERSION,
        kind: 'delivery_report',
        conversationId: cId,
        taskId: cTask.id,
        attemptId: cAtt.id,
        deliverySummary: 'Entrega tardia pós-cancelamento',
        evidenceNotes: [],
      }) + '\n```',
    );
    emitTurn(
      cRev.sessionRef.externalConversationId!,
      'm_c_late_rev',
      '```aion-desk-json\n' + JSON.stringify({
        protocol: INTERNAL_PROTOCOL_VERSION,
        kind: 'review_decision',
        conversationId: cId,
        taskId: cTask.id,
        attemptId: cAtt.id,
        decision: 'approved',
        rationale: 'Aprovação tardia pós-cancelamento',
        unmetCriteria: [],
      }) + '\n```',
    );
    await new Promise((r) => setTimeout(r, 30));
    const afterCancelLate = adapter.getStateSnapshot().conversations[cId];
    expect(afterCancelLate.tasks[0].status).toBe('cancelled');
    expect(afterCancelLate.tasks[0].attempts[0].status).toBe('interrupted');
    expect(afterCancelLate.tasks[0].reviews).toHaveLength(0);
    expect(afterCancelLate.messagesByTab[cExec.id].find((m) => m.id === 'msg_core_m_c_late_del')?.parseStatus).toBe('invalid');
    expect(afterCancelLate.messagesByTab[cRev.id].find((m) => m.id === 'msg_core_m_c_late_rev')?.parseStatus).toBe('invalid');

    adapter.dispose();
  });

  it('rejects stale/unproven deliveries and reviews without attemptId after retries, and allows proven dispatch-turn correlation (V6-05 revalidação P1)', async () => {
    const outgoingPosts: Array<{ url: string; content: string }> = [];
    let capturedSock: MockSocket | null = null;

    const fetchFn: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = (init?.method ?? 'GET').toUpperCase();
      if (url.endsWith('/login') && method === 'POST') {
        return jsonResponse({ success: true, user: { id: 'u1', username: 'admin' }, token: 'jwt_reval_p1' });
      }
      if (url.endsWith('/api/agents/management') && method === 'GET') {
        return jsonResponse({
          success: true,
          data: [
            {
              id: 'codex-1', backend: 'codex', name: 'Codex', installed: true, enabled: true, status: 'online',
              available_models: { available_models: [{ id: 'gpt-6.1-terra', label: 'gpt-6.1-terra' }] },
            },
            {
              id: 'antigravity-1', backend: 'antigravity', name: 'Antigravity', installed: true, enabled: true, status: 'online',
              available_models: { available_models: [{ id: 'gemini-4-hydrogen-high', label: 'gemini-4-hydrogen-high' }] },
            },
          ],
        });
      }
      if (url.endsWith('/api/assistants') && method === 'GET') {
        return jsonResponse({
          success: true,
          data: [
            { id: 'bare:codex-1', name: 'Codex', agent_id: 'codex-1', enabled: true, team_selectable: true },
            { id: 'bare:antigravity-1', name: 'Antigravity', agent_id: 'antigravity-1', enabled: true, team_selectable: true },
          ],
        });
      }
      if (url.endsWith('/api/ws-token') && method === 'GET') {
        return jsonResponse({ success: true, ws_token: 'ws_reval_p1', expires_in: 300 });
      }
      if (url.endsWith('/api/teams') && method === 'POST') {
        const body = JSON.parse(String(init?.body ?? '{}')) as { agents?: Array<{ name: string; role: string; model?: string }> };
        return jsonResponse({
          success: true,
          data: {
            id: 'team_reval_p1',
            name: 'Reval P1 Team',
            assistants: (body.agents ?? []).map((a, idx) => ({
              slot_id: `slot_rp1_${idx + 1}`,
              conversation_id: `ext_conv_rp1_${idx + 1}`,
              name: a.name,
              role: a.role,
              model: a.model,
            })),
          },
        });
      }
      if (url.includes('/messages') && method === 'POST') {
        const parsed = JSON.parse(String(init?.body ?? '{}')) as { content?: string };
        outgoingPosts.push({ url, content: parsed.content ?? '' });
        return jsonResponse({ success: true, data: { message_id: `ack_rp1_${outgoingPosts.length}`, enqueue_status: 'started' } });
      }
      return jsonResponse({ success: true, data: {} });
    };

    const persistence = new WorkspacePersistenceManager(new MemoryOnlyStorageDriver());
    const adapter = new AionCoreAdapter(persistence, {
      baseUrl: 'http://127.0.0.1:25828',
      fetchFn,
      wsFactory: (url, protocols) => {
        capturedSock = new MockSocket(url, protocols);
        return capturedSock;
      },
      readCookie: () => 'csrf_reval_p1',
    });

    await adapter.loadWorkspace();
    await adapter.login('admin', 'secret');
    await adapter.refreshCoreCatalog();

    const proj = await adapter.createProject({
      name: 'Projeto Reval P1',
      description: 'Revalidação sem attemptId após retentativa',
      workspacePathInfo: 'C:/tmp/v605-reval-p1',
    });
    const conv = await adapter.createConversation({ projectId: proj.id, title: 'Reval P1' });
    const convId = conv.conversation.id;
    await adapter.createCoreTeamForConversation(convId);
    await adapter.connectWebSocket(convId);

    const team = adapter.getStateSnapshot().conversations[convId];
    const planner = team.participants.find((p) => p.roles.includes('planner'))!;
    const reviewer = team.participants.find((p) => p.roles.includes('reviewer'))!;
    const executor = team.participants.find((p) => p.roles.includes('executor'))!;

    const emitTurn = (extConvId: string, msgId: string, turnId: string | undefined, content: string) => {
      capturedSock!.emitMessage({
        name: 'message.stream',
        data: { conversation_id: extConvId, msg_id: msgId, ...(turnId ? { turn_id: turnId } : {}), type: 'content', data: { content } },
      });
      capturedSock!.emitMessage({
        name: 'message.stream',
        data: { conversation_id: extConvId, msg_id: msgId, ...(turnId ? { turn_id: turnId } : {}), type: 'finish', data: {} },
      });
    };

    // Plan -> Attempt #1 dispatched
    emitTurn(
      planner.sessionRef.externalConversationId!,
      'm_rp1_plan',
      'turn_plan_1',
      '```aion-desk-json\n' + JSON.stringify({
        protocol: INTERNAL_PROTOCOL_VERSION,
        kind: 'plan_proposal',
        conversationId: convId,
        summary: 'Plano Reval P1',
        tasks: [{
          title: 'Tarefa Reval P1',
          description: 'Testar omissão após retentativa',
          assigneeRole: 'executor',
          dependencies: [],
          acceptanceCriteria: ['OK'],
        }],
      }) + '\n```',
    );
    await new Promise((r) => setTimeout(r, 30));

    const taskId = adapter.getStateSnapshot().conversations[convId].tasks[0].id;

    // Attempt #1 delivered WITHOUT attemptId (1st attempt -> allowed) on turn_exec_1
    const delivery1Payload = '```aion-desk-json\n' + JSON.stringify({
      protocol: INTERNAL_PROTOCOL_VERSION,
      kind: 'delivery_report',
      conversationId: convId,
      taskId,
      deliverySummary: 'Resumo da tentativa 1',
      evidenceNotes: ['ev_att1'],
    }) + '\n```';
    emitTurn(executor.sessionRef.externalConversationId!, 'm_rp1_del_1', 'turn_exec_1', delivery1Payload);
    await new Promise((r) => setTimeout(r, 30));
    expect(adapter.getStateSnapshot().conversations[convId].tasks[0].status).toBe('awaiting_review');

    // Attempt #1 rejected WITHOUT attemptId (1st attempt -> allowed) on turn_rev_1 -> dispatches Attempt #2
    const reject1Payload = '```aion-desk-json\n' + JSON.stringify({
      protocol: INTERNAL_PROTOCOL_VERSION,
      kind: 'review_decision',
      conversationId: convId,
      taskId,
      decision: 'rejected',
      rationale: 'Falta ajuste na tentativa 1',
      unmetCriteria: ['OK'],
    }) + '\n```';
    emitTurn(reviewer.sessionRef.externalConversationId!, 'm_rp1_rev_1', 'turn_rev_1', reject1Payload);
    await new Promise((r) => setTimeout(r, 30));

    let snap = adapter.getStateSnapshot().conversations[convId];
    expect(snap.tasks[0].attempts).toHaveLength(2);
    expect(snap.tasks[0].status).toBe('running');
    expect(snap.tasks[0].qualityRejectionCount).toBe(1);
    const att2 = snap.tasks[0].attempts[1];
    expect(att2.status).toBe('running');
    const postsAfterAtt2Start = outgoingPosts.length;

    // Repro 1a: Repeat Attempt #1 delivery WITHOUT attemptId using old turn_exec_1 via message.stream (dropped at finished buffer) AND via finalizeCoreAgentMessage (e.g. mailbox/catchup) -> MUST NOT deliver Attempt #2
    emitTurn(executor.sessionRef.externalConversationId!, 'm_rp1_del_1_replay_stream', 'turn_exec_1', delivery1Payload);
    (adapter as unknown as {
      finalizeCoreAgentMessage: (arg: {
        convId: string;
        participant: typeof executor;
        fullText: string;
        extMsgId: string;
        turnId?: string;
        externalEventName: string;
      }) => void;
    }).finalizeCoreAgentMessage({
      convId,
      participant: executor,
      fullText: delivery1Payload,
      extMsgId: 'm_rp1_del_1_replay_turn',
      turnId: 'turn_exec_1',
      externalEventName: 'team.mailboxChanged',
    });
    // Repro 1b: Repeat delivery WITHOUT attemptId and WITHOUT proven turnId on retry history -> MUST ALSO be rejected as ambiguous
    emitTurn(executor.sessionRef.externalConversationId!, 'm_rp1_del_1_replay_noturn', undefined, delivery1Payload);
    await new Promise((r) => setTimeout(r, 30));

    snap = adapter.getStateSnapshot().conversations[convId];
    expect(snap.tasks[0].status).toBe('running');
    expect(snap.tasks[0].attempts[1].status).toBe('running');
    expect(snap.tasks[0].attempts[1].deliverySummary).toBeUndefined();
    expect(outgoingPosts.length).toBe(postsAfterAtt2Start);
    expect(snap.messagesByTab[executor.id].find((m) => m.id === 'msg_core_m_rp1_del_1_replay_turn')?.parseStatus).toBe('invalid');
    expect(snap.messagesByTab[executor.id].find((m) => m.id === 'msg_core_m_rp1_del_1_replay_noturn')?.parseStatus).toBe('invalid');

    // Valid Attempt #2 delivery WITH explicit attemptId -> awaiting_review + review dispatched
    emitTurn(
      executor.sessionRef.externalConversationId!,
      'm_rp1_del_2_valid',
      'turn_exec_2',
      '```aion-desk-json\n' + JSON.stringify({
        protocol: INTERNAL_PROTOCOL_VERSION,
        kind: 'delivery_report',
        conversationId: convId,
        taskId,
        attemptId: att2.id,
        deliverySummary: 'Resumo corrigido da tentativa 2',
        evidenceNotes: ['ev_att2'],
      }) + '\n```',
    );
    await new Promise((r) => setTimeout(r, 30));
    snap = adapter.getStateSnapshot().conversations[convId];
    expect(snap.tasks[0].status).toBe('awaiting_review');
    expect(snap.tasks[0].attempts[1].status).toBe('delivered');
    const postsAfterDel2 = outgoingPosts.length;
    expect(postsAfterDel2).toBe(postsAfterAtt2Start + 1);

    // Repro 2: Repeat Attempt #1 rejected review WITHOUT attemptId on old turn_rev_1 -> MUST NOT reject Attempt #2 or increment qualityRejectionCount or escalate
    (adapter as unknown as {
      finalizeCoreAgentMessage: (arg: {
        convId: string;
        participant: typeof reviewer;
        fullText: string;
        extMsgId: string;
        turnId?: string;
        externalEventName: string;
      }) => void;
    }).finalizeCoreAgentMessage({
      convId,
      participant: reviewer,
      fullText: reject1Payload,
      extMsgId: 'm_rp1_rev_1_replay',
      turnId: 'turn_rev_1',
      externalEventName: 'team.mailboxChanged',
    });
    // Also test without turnId on retry history -> MUST be rejected as ambiguous
    emitTurn(reviewer.sessionRef.externalConversationId!, 'm_rp1_rev_1_noturn', undefined, reject1Payload);
    await new Promise((r) => setTimeout(r, 30));

    snap = adapter.getStateSnapshot().conversations[convId];
    expect(snap.tasks[0].status).toBe('awaiting_review');
    expect(snap.tasks[0].attempts[1].status).toBe('delivered');
    expect(snap.tasks[0].qualityRejectionCount).toBe(1);
    expect(snap.tasks[0].reviews).toHaveLength(1);
    expect(snap.escalations).toHaveLength(0);
    expect(outgoingPosts.length).toBe(postsAfterDel2);
    expect(snap.messagesByTab[reviewer.id].find((m) => m.id === 'msg_core_m_rp1_rev_1_replay')?.parseStatus).toBe('invalid');
    expect(snap.messagesByTab[reviewer.id].find((m) => m.id === 'msg_core_m_rp1_rev_1_noturn')?.parseStatus).toBe('invalid');

    // Repro 3: Stale approved review WITHOUT attemptId on old turn_rev_1 -> MUST NOT complete Attempt #2
    const approveNoIdPayload = '```aion-desk-json\n' + JSON.stringify({
      protocol: INTERNAL_PROTOCOL_VERSION,
      kind: 'review_decision',
      conversationId: convId,
      taskId,
      decision: 'approved',
      rationale: 'Aprovação antiga sem attemptId',
      unmetCriteria: [],
    }) + '\n```';
    (adapter as unknown as {
      finalizeCoreAgentMessage: (arg: {
        convId: string;
        participant: typeof reviewer;
        fullText: string;
        extMsgId: string;
        turnId?: string;
        externalEventName: string;
      }) => void;
    }).finalizeCoreAgentMessage({
      convId,
      participant: reviewer,
      fullText: approveNoIdPayload,
      extMsgId: 'm_rp1_rev_stale_approve',
      turnId: 'turn_rev_1',
      externalEventName: 'team.mailboxChanged',
    });
    await new Promise((r) => setTimeout(r, 30));

    snap = adapter.getStateSnapshot().conversations[convId];
    expect(snap.tasks[0].status).toBe('awaiting_review');
    expect(snap.tasks[0].attempts[1].status).toBe('delivered');
    expect(snap.tasks[0].reviews).toHaveLength(1);
    expect(snap.messagesByTab[reviewer.id].find((m) => m.id === 'msg_core_m_rp1_rev_stale_approve')?.parseStatus).toBe('invalid');

    // Positive proven-turn path on Attempt #2: Core signals team.childTurnStarted for the active review dispatch -> review without attemptId on THAT proven turn succeeds!
    capturedSock!.emitMessage({
      name: 'team.childTurnStarted',
      data: {
        team_id: 'team_reval_p1',
        team_run_id: 'run_rev_2',
        slot_id: reviewer.sessionRef.externalSlotId,
        turn_id: 'turn_rev_2_proven',
      },
    });
    emitTurn(reviewer.sessionRef.externalConversationId!, 'm_rp1_rev_2_proven', 'turn_rev_2_proven', approveNoIdPayload);
    await new Promise((r) => setTimeout(r, 30));

    snap = adapter.getStateSnapshot().conversations[convId];
    expect(snap.tasks[0].status).toBe('completed');
    expect(snap.tasks[0].attempts[1].status).toBe('approved');
    expect(snap.tasks[0].reviews).toHaveLength(2);
    expect(snap.conversation.executionStatus).toBe('completed');

    adapter.dispose();
  });

  it('rejects non-string or empty attemptId values without throwing and records manual review messages (V6-05 revalidação P2)', async () => {
    let capturedSock: MockSocket | null = null;

    const fetchFn: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = (init?.method ?? 'GET').toUpperCase();
      if (url.endsWith('/login') && method === 'POST') {
        return jsonResponse({ success: true, user: { id: 'u1', username: 'admin' }, token: 'jwt_reval_p2' });
      }
      if (url.endsWith('/api/agents/management') && method === 'GET') {
        return jsonResponse({
          success: true,
          data: [
            {
              id: 'codex-1', backend: 'codex', name: 'Codex', installed: true, enabled: true, status: 'online',
              available_models: { available_models: [{ id: 'gpt-6.1-terra', label: 'gpt-6.1-terra' }] },
            },
            {
              id: 'antigravity-1', backend: 'antigravity', name: 'Antigravity', installed: true, enabled: true, status: 'online',
              available_models: { available_models: [{ id: 'gemini-4-hydrogen-high', label: 'gemini-4-hydrogen-high' }] },
            },
          ],
        });
      }
      if (url.endsWith('/api/assistants') && method === 'GET') {
        return jsonResponse({
          success: true,
          data: [
            { id: 'bare:codex-1', name: 'Codex', agent_id: 'codex-1', enabled: true, team_selectable: true },
            { id: 'bare:antigravity-1', name: 'Antigravity', agent_id: 'antigravity-1', enabled: true, team_selectable: true },
          ],
        });
      }
      if (url.endsWith('/api/ws-token') && method === 'GET') {
        return jsonResponse({ success: true, ws_token: 'ws_reval_p2', expires_in: 300 });
      }
      if (url.endsWith('/api/teams') && method === 'POST') {
        const body = JSON.parse(String(init?.body ?? '{}')) as { agents?: Array<{ name: string; role: string; model?: string }> };
        return jsonResponse({
          success: true,
          data: {
            id: 'team_reval_p2',
            name: 'Reval P2 Team',
            assistants: (body.agents ?? []).map((a, idx) => ({
              slot_id: `slot_rp2_${idx + 1}`,
              conversation_id: `ext_conv_rp2_${idx + 1}`,
              name: a.name,
              role: a.role,
              model: a.model,
            })),
          },
        });
      }
      return jsonResponse({ success: true, data: { message_id: 'ack_rp2', enqueue_status: 'started' } });
    };

    const persistence = new WorkspacePersistenceManager(new MemoryOnlyStorageDriver());
    const adapter = new AionCoreAdapter(persistence, {
      baseUrl: 'http://127.0.0.1:25828',
      fetchFn,
      wsFactory: (url, protocols) => {
        capturedSock = new MockSocket(url, protocols);
        return capturedSock;
      },
      readCookie: () => 'csrf_reval_p2',
    });

    await adapter.loadWorkspace();
    await adapter.login('admin', 'secret');
    await adapter.refreshCoreCatalog();

    const proj = await adapter.createProject({
      name: 'Projeto Reval P2',
      description: 'attemptId com tipo inválido',
      workspacePathInfo: 'C:/tmp/v605-reval-p2',
    });
    const conv = await adapter.createConversation({ projectId: proj.id, title: 'Reval P2' });
    const convId = conv.conversation.id;
    await adapter.createCoreTeamForConversation(convId);
    await adapter.connectWebSocket(convId);

    const team = adapter.getStateSnapshot().conversations[convId];
    const planner = team.participants.find((p) => p.roles.includes('planner'))!;
    const reviewer = team.participants.find((p) => p.roles.includes('reviewer'))!;
    const executor = team.participants.find((p) => p.roles.includes('executor'))!;

    const emitTurn = (extConvId: string, msgId: string, content: string) => {
      capturedSock!.emitMessage({
        name: 'message.stream',
        data: { conversation_id: extConvId, msg_id: msgId, turn_id: `t_${msgId}`, type: 'content', data: { content } },
      });
      capturedSock!.emitMessage({
        name: 'message.stream',
        data: { conversation_id: extConvId, msg_id: msgId, turn_id: `t_${msgId}`, type: 'finish', data: {} },
      });
    };

    emitTurn(
      planner.sessionRef.externalConversationId!,
      'm_rp2_plan',
      '```aion-desk-json\n' + JSON.stringify({
        protocol: INTERNAL_PROTOCOL_VERSION,
        kind: 'plan_proposal',
        conversationId: convId,
        summary: 'Plano Reval P2',
        tasks: [{
          title: 'Tarefa attemptId inválido',
          description: 'Validar tipos de attemptId',
          assigneeRole: 'executor',
          dependencies: [],
          acceptanceCriteria: ['OK'],
        }],
      }) + '\n```',
    );
    await new Promise((r) => setTimeout(r, 30));

    const taskId = adapter.getStateSnapshot().conversations[convId].tasks[0].id;
    const badAttemptValues: Array<{ label: string; value: unknown }> = [
      { label: 'num', value: 123 },
      { label: 'obj', value: { id: 'att_1' } },
      { label: 'arr', value: ['att_1'] },
      { label: 'null', value: null },
      { label: 'empty', value: '' },
      { label: 'spaces', value: '   ' },
    ];

    for (const bad of badAttemptValues) {
      const msgId = `m_rp2_del_${bad.label}`;
      expect(() =>
        emitTurn(
          executor.sessionRef.externalConversationId!,
          msgId,
          '```aion-desk-json\n' + JSON.stringify({
            protocol: INTERNAL_PROTOCOL_VERSION,
            kind: 'delivery_report',
            conversationId: convId,
            taskId,
            attemptId: bad.value,
            deliverySummary: `Entrega inválida ${bad.label}`,
            evidenceNotes: ['ev'],
          }) + '\n```',
        ),
      ).not.toThrow();
    }
    await new Promise((r) => setTimeout(r, 30));

    let snap = adapter.getStateSnapshot().conversations[convId];
    expect(snap.tasks[0].status).toBe('running');
    expect(snap.tasks[0].attempts[0].status).toBe('running');
    for (const bad of badAttemptValues) {
      const stored = snap.messagesByTab[executor.id].find((m) => m.id === `msg_core_m_rp2_del_${bad.label}`);
      expect(stored).toBeDefined();
      expect(stored?.parseStatus).toBe('invalid');
    }

    // Real omission of attemptId still works cleanly on Attempt #1
    emitTurn(
      executor.sessionRef.externalConversationId!,
      'm_rp2_del_omitted_valid',
      '```aion-desk-json\n' + JSON.stringify({
        protocol: INTERNAL_PROTOCOL_VERSION,
        kind: 'delivery_report',
        conversationId: convId,
        taskId,
        deliverySummary: 'Entrega válida com attemptId ausente',
        evidenceNotes: ['ev'],
      }) + '\n```',
    );
    await new Promise((r) => setTimeout(r, 30));
    expect(adapter.getStateSnapshot().conversations[convId].tasks[0].status).toBe('awaiting_review');

    // Invalid attemptId values on review_decision MUST NOT throw, MUST record invalid message, and MUST keep awaiting_review
    for (const bad of badAttemptValues) {
      const msgId = `m_rp2_rev_${bad.label}`;
      expect(() =>
        emitTurn(
          reviewer.sessionRef.externalConversationId!,
          msgId,
          '```aion-desk-json\n' + JSON.stringify({
            protocol: INTERNAL_PROTOCOL_VERSION,
            kind: 'review_decision',
            conversationId: convId,
            taskId,
            attemptId: bad.value,
            decision: 'approved',
            rationale: `Parecer inválido ${bad.label}`,
            unmetCriteria: [],
          }) + '\n```',
        ),
      ).not.toThrow();
    }
    await new Promise((r) => setTimeout(r, 30));

    snap = adapter.getStateSnapshot().conversations[convId];
    expect(snap.tasks[0].status).toBe('awaiting_review');
    expect(snap.tasks[0].reviews).toHaveLength(0);
    for (const bad of badAttemptValues) {
      const stored = snap.messagesByTab[reviewer.id].find((m) => m.id === `msg_core_m_rp2_rev_${bad.label}`);
      expect(stored).toBeDefined();
      expect(stored?.parseStatus).toBe('invalid');
    }

    adapter.dispose();
  });

  it('enforces honest context receipt semantics (pending_send -> failed_needs_action -> sent -> received -> applied, no false received without send, no downgrade, exact revision correlation on v2 mid-attempt) (V6-06 contexto)', async () => {
    const sockets: MockSocket[] = [];
    let failNextPost = false;
    let msgSeq = 0;

    const fetchFn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.endsWith('/api/ws-token')) {
        return jsonResponse({ success: true, ws_token: 'tok_ctx', expires_in: 300 });
      }
      if (url.endsWith('/api/agents/management')) {
        return jsonResponse({
          success: true,
          data: [
            {
              id: 'codex-1',
              name: 'Codex',
              backend: 'codex',
              installed: true,
              enabled: true,
              status: 'online',
              available_models: { available_models: [{ id: 'gpt-5.6-luna', label: 'GPT-5.6-Luna' }] },
            },
            {
              id: 'antigravity-1',
              name: 'Antigravity',
              backend: 'antigravity',
              installed: true,
              enabled: true,
              status: 'online',
              available_models: { available_models: [{ id: 'gemini-3.8-flash-low', label: 'Gemini 3.8 Flash' }] },
            },
          ],
        });
      }
      if (url.endsWith('/api/assistants')) {
        return jsonResponse({
          success: true,
          data: [
            { id: 'bare:codex-1', name: 'Codex', agent_id: 'codex-1', enabled: true, team_selectable: true },
            { id: 'bare:antigravity-1', name: 'Antigravity', agent_id: 'antigravity-1', enabled: true, team_selectable: true },
          ],
        });
      }
      if (url.endsWith('/api/teams') && method === 'POST') {
        return jsonResponse(
          {
            success: true,
            data: {
              id: 'team_v606_ctx',
              name: 'Equipe V6-06 Contexto',
              workspace: 'C:/sandbox',
              assistants: [
                { slot_id: 'slot_lead', conversation_id: 'conv_ext_lead', role: 'lead', name: 'Terra 6.1' },
                { slot_id: 'slot_rev', conversation_id: 'conv_ext_rev', role: 'teammate', name: 'Sol 6.1' },
                { slot_id: 'slot_exec', conversation_id: 'conv_ext_exec', role: 'teammate', name: 'Gemini Hydrogen' },
              ],
            },
          },
          201,
        );
      }
      if (url.includes('/messages') && method === 'POST') {
        if (failNextPost) {
          failNextPost = false;
          return jsonResponse({ success: false, error: 'Core indisponível temporariamente' }, 500);
        }
        msgSeq += 1;
        if (msgSeq === 1 && sockets[0]) {
          // Reproduce real Core v0.2.2 ordering: WS team.childTurnStarted arrives BEFORE HTTP POST ACK returns
          sockets[0].emitMessage({
            name: 'team.childTurnStarted',
            data: {
              team_id: 'team_v606_ctx',
              slot_id: 'slot_lead',
              conversation_id: 'conv_ext_lead',
              turn_id: 'turn_plan_v1_live_race',
            },
          });
        }
        return jsonResponse({
          success: true,
          data: {
            message_id: `ack_ctx_${msgSeq}`,
            enqueue_status: 'enqueued',
            run: { team_run_id: `run_ctx_${msgSeq}` },
          },
        });
      }
      return jsonResponse({ success: true, data: {} });
    };

    const persistence = new WorkspacePersistenceManager(new MemoryOnlyStorageDriver());
    const adapter = new AionCoreAdapter(persistence, {
      baseUrl: 'http://127.0.0.1:25828',
      fetchFn,
      wsFactory: (url, protocols) => {
        const s = new MockSocket(url, protocols);
        sockets.push(s);
        return s;
      },
      readCookie: () => 'csrf_ctx',
    });

    await adapter.loadWorkspace();
    await adapter.refreshCoreCatalog();
    const project = await adapter.createProject({
      name: 'Projeto V6-06 Contexto',
      description: 'Recibos honestos',
      workspacePathInfo: 'C:/sandbox',
    });
    const created = await adapter.createConversation({
      projectId: project.id,
      title: 'Conversa V6-06 Contexto',
    });
    const convId = created.conversation.id;
    await adapter.createCoreTeamForConversation(convId);
    await adapter.connectWebSocket(convId);
    await new Promise((r) => setTimeout(r, 10));

    const proj0 = adapter.getStateSnapshot().conversations[convId];
    const lead = proj0.participants.find((p) => p.roles.includes('coordinator'))!;
    const executor = proj0.participants.find((p) => p.roles.includes('executor'))!;
    const reviewer = proj0.participants.find((p) => p.roles.includes('reviewer'))!;

    // 1. Publish Context v1 -> everyone starts strictly at 'pending_send'
    const rev1 = await adapter.publishContextRevision({
      conversationId: convId,
      authorLabel: 'Você',
      summaryOfChange: 'Objetivo inicial v1',
      objective: 'Implementar regra v1',
      permanentInstructions: ['Manter semântica honesta'],
      constraints: ['Sem mocks em produção'],
      acceptanceCriteria: ['Recibos verificados'],
      confirmedDecisions: [],
    });
    expect(rev1.receipts[lead.id].status).toBe('pending_send');
    expect(rev1.receipts[executor.id].status).toBe('pending_send');
    expect(rev1.receipts[reviewer.id].status).toBe('pending_send');

    const emitWsTurn = (extConvId: string, msgId: string, text: string, turnId?: string) => {
      sockets[0].emitMessage({
        name: 'message.stream',
        data: {
          conversation_id: extConvId,
          msg_id: msgId,
          turn_id: turnId ?? `t_${msgId}`,
          type: 'content',
          data: { content: text },
        },
      });
      sockets[0].emitMessage({
        name: 'message.stream',
        data: {
          conversation_id: extConvId,
          msg_id: msgId,
          turn_id: turnId ?? `t_${msgId}`,
          type: 'finish',
          data: {},
        },
      });
    };

    // 2. Unsolicited message from executor BEFORE v1 was ever sent MUST NOT fabricate 'received'
    emitWsTurn(executor.sessionRef.externalConversationId!, 'm_unsol_1', 'Mensagem espontânea antes do envio de v1');
    let snap = adapter.getStateSnapshot().conversations[convId];
    expect(snap.contextRevisions[0].receipts[executor.id].status).toBe('pending_send');

    // 3. Send failure marks 'failed_needs_action' on lead without crashing
    failNextPost = true;
    await expect(
      adapter.sendMessage({
        conversationId: convId,
        targetTab: 'general',
        bodyMarkdown: 'Proponha o plano para v1',
      }),
    ).rejects.toBeTruthy();
    snap = adapter.getStateSnapshot().conversations[convId];
    expect(snap.contextRevisions[0].receipts[lead.id].status).toBe('failed_needs_action');

    // 3b. Record a pre-send turn on lead BEFORE sendMessage is even initiated
    sockets[0].emitMessage({
      name: 'team.childTurnStarted',
      data: {
        team_id: 'team_v606_ctx',
        slot_id: 'slot_lead',
        conversation_id: 'conv_ext_lead',
        turn_id: 'turn_lead_pre_send',
      },
    });

    // 4. Subsequent successful send recovers to 'sent' (NOT 'received', NOT 'applied')
    await adapter.sendMessage({
      conversationId: convId,
      targetTab: 'general',
      bodyMarkdown: 'Proponha o plano para v1',
    });
    snap = adapter.getStateSnapshot().conversations[convId];
    expect(snap.contextRevisions[0].receipts[lead.id].status).toBe('sent');

    // 4b. Late message belonging to pre-send turn MUST NOT mark v1 as 'received'
    emitWsTurn(
      lead.sessionRef.externalConversationId!,
      'm_lead_stale_pre_send',
      'Resposta tardia de turno iniciado antes do envio',
      'turn_lead_pre_send',
    );
    snap = adapter.getStateSnapshot().conversations[convId];
    expect(snap.contextRevisions[0].receipts[lead.id].status).toBe('sent');

    // 5. Lead replies on the real turn (whose childTurnStarted arrived before HTTP ACK!) ->
    // lead receipt advances to 'received' (NOT 'applied'), and Task 1 is dispatched with v1 -> executor receipt becomes 'sent'
    emitWsTurn(
      lead.sessionRef.externalConversationId!,
      'm_plan_v1',
      '```aion-desk-json\n' +
        JSON.stringify({
          protocol: INTERNAL_PROTOCOL_VERSION,
          kind: 'plan_proposal',
          conversationId: convId,
          summary: 'Plano v1',
          tasks: [
            {
              title: 'Implementar v1',
              description: 'Executar tarefa sob contexto v1',
              acceptanceCriteria: ['Arquivo criado'],
              dependencyTitles: [],
            },
          ],
        }) +
        '\n```',
      'turn_plan_v1_live_race',
    );
    await new Promise((r) => setTimeout(r, 40));
    snap = adapter.getStateSnapshot().conversations[convId];
    expect(snap.contextRevisions[0].receipts[lead.id].status).toBe('received');
    expect(snap.contextRevisions[0].receipts[executor.id].status).toBe('sent');
    expect(snap.tasks).toHaveLength(1);
    const task1 = snap.tasks[0];
    const att1 = task1.attempts[0];
    expect(att1.contextRevisionId).toBe(rev1.id);

    // 6. Publish Context v2 MID-ATTEMPT while Attempt #1 (bound to v1) is still running!
    const rev2 = await adapter.publishContextRevision({
      conversationId: convId,
      authorLabel: 'Você',
      summaryOfChange: 'Nova restrição v2',
      objective: 'Implementar regra v2',
      permanentInstructions: ['Regra nova'],
      constraints: ['Restrição v2'],
      acceptanceCriteria: ['Critério v2'],
      confirmedDecisions: [],
    });
    snap = adapter.getStateSnapshot().conversations[convId];
    expect(snap.contextRevisions).toHaveLength(2);
    expect(snap.contextRevisions[1].receipts[executor.id].status).toBe('pending_send');

    // 7. Executor delivers Attempt #1 (which ran with v1):
    //    - v1 MUST become 'applied' for executor (exact revision correlated to Attempt #1)
    //    - v2 MUST remain strictly 'pending_send' for executor (was NEVER sent to executor!)
    //    - Reviewer receives review dispatch carrying v2 -> v2 becomes 'sent' for reviewer
    emitWsTurn(
      executor.sessionRef.externalConversationId!,
      'm_del_v1',
      '```aion-desk-json\n' +
        JSON.stringify({
          protocol: INTERNAL_PROTOCOL_VERSION,
          kind: 'delivery_report',
          conversationId: convId,
          taskId: task1.id,
          attemptId: att1.id,
          deliverySummary: 'Entregue sob v1',
          evidenceNotes: ['teste ok'],
        }) +
        '\n```',
    );
    await new Promise((r) => setTimeout(r, 40));
    snap = adapter.getStateSnapshot().conversations[convId];
    const r1AfterDel = snap.contextRevisions.find((r) => r.id === rev1.id)!;
    const r2AfterDel = snap.contextRevisions.find((r) => r.id === rev2.id)!;
    expect(r1AfterDel.receipts[executor.id].status).toBe('applied');
    expect(r2AfterDel.receipts[executor.id].status).toBe('pending_send');
    expect(r2AfterDel.receipts[reviewer.id].status).toBe('sent');

    // 8. Reviewer replies with rejection -> reviewer receipt on v2 advances to 'received',
    //    and Attempt #2 dispatches v2 to executor -> v2 becomes 'sent' for executor while v1 stays 'applied' (NO downgrade!)
    emitWsTurn(
      reviewer.sessionRef.externalConversationId!,
      'm_rev_v2_rej',
      '```aion-desk-json\n' +
        JSON.stringify({
          protocol: INTERNAL_PROTOCOL_VERSION,
          kind: 'review_decision',
          conversationId: convId,
          taskId: task1.id,
          attemptId: att1.id,
          decision: 'rejected',
          rationale: 'Falta critério v2',
          unmetCriteria: ['Critério v2'],
        }) +
        '\n```',
    );
    await new Promise((r) => setTimeout(r, 40));
    snap = adapter.getStateSnapshot().conversations[convId];
    expect(snap.contextRevisions.find((r) => r.id === rev1.id)!.receipts[executor.id].status).toBe('applied');
    expect(snap.contextRevisions.find((r) => r.id === rev2.id)!.receipts[reviewer.id].status).toBe('received');
    expect(snap.contextRevisions.find((r) => r.id === rev2.id)!.receipts[executor.id].status).toBe('sent');

    adapter.dispose();
  });

  it('recovers task finished while tab was closed into paused_queue without auto-dispatch, refuses resume on incomplete sync, and resumes flow cleanly without repeating work (V6-06 tab-close/resume)', async () => {
    const sockets: MockSocket[] = [];
    const postedMessages: Array<{ path: string; body: unknown }> = [];
    let slotExecState: 'running' | 'idle' = 'idle';
    let slotRevState: 'running' | 'idle' = 'idle';
    let activityShouldFail = false;
    let coreTasksPayload: unknown[] = [];
    let execSlotMessages: unknown[] = [];
    let msgSeq = 0;

    const makeFetch = () => async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.endsWith('/api/ws-token')) {
        return jsonResponse({ success: true, ws_token: 'tok_tab', expires_in: 300 });
      }
      if (url.endsWith('/api/agents/management')) {
        return jsonResponse({
          success: true,
          data: [
            {
              id: 'codex-1',
              name: 'Codex',
              backend: 'codex',
              installed: true,
              enabled: true,
              status: 'online',
              available_models: { available_models: [{ id: 'gpt-5.6-luna', label: 'GPT-5.6-Luna' }] },
            },
            {
              id: 'antigravity-1',
              name: 'Antigravity',
              backend: 'antigravity',
              installed: true,
              enabled: true,
              status: 'online',
              available_models: { available_models: [{ id: 'gemini-3.8-flash-low', label: 'Gemini 3.8 Flash' }] },
            },
          ],
        });
      }
      if (url.endsWith('/api/assistants')) {
        return jsonResponse({
          success: true,
          data: [
            { id: 'bare:codex-1', name: 'Codex', agent_id: 'codex-1', enabled: true, team_selectable: true },
            { id: 'bare:antigravity-1', name: 'Antigravity', agent_id: 'antigravity-1', enabled: true, team_selectable: true },
          ],
        });
      }
      if (url.endsWith('/api/teams') && method === 'POST') {
        return jsonResponse(
          {
            success: true,
            data: {
              id: 'team_tab_close',
              name: 'Equipe Tab Close',
              workspace: 'C:/sandbox',
              assistants: [
                { slot_id: 'slot_lead', conversation_id: 'ext_lead', role: 'lead', name: 'Terra 6.1' },
                { slot_id: 'slot_rev', conversation_id: 'ext_rev', role: 'teammate', name: 'Sol 6.1' },
                { slot_id: 'slot_exec', conversation_id: 'ext_exec', role: 'teammate', name: 'Gemini Hydrogen' },
              ],
            },
          },
          201,
        );
      }
      if (url.includes('/messages') && method === 'POST') {
        msgSeq += 1;
        postedMessages.push({
          path: new URL(url, 'http://127.0.0.1').pathname,
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
        });
        return jsonResponse({
          success: true,
          data: {
            message_id: `ack_tab_${msgSeq}`,
            enqueue_status: 'enqueued',
            run: { team_run_id: `run_tab_${msgSeq}` },
          },
        });
      }
      if (url.endsWith('/api/teams/team_tab_close/run-state')) {
        return jsonResponse({
          success: true,
          data: {
            session_generation: 'gen_tab',
            active_run: null,
            slot_work: [
              { slot_id: 'slot_lead', role: 'lead', state: 'idle', queued_foreground_count: 0, queued_background_count: 0 },
              { slot_id: 'slot_rev', role: 'teammate', state: slotRevState, queued_foreground_count: 0, queued_background_count: 0 },
              { slot_id: 'slot_exec', role: 'teammate', state: slotExecState, queued_foreground_count: 0, queued_background_count: 0 },
            ],
          },
        });
      }
      if (url.endsWith('/api/teams/team_tab_close/mailbox')) {
        return jsonResponse({ success: true, data: [] });
      }
      if (url.endsWith('/api/teams/team_tab_close/tasks')) {
        return jsonResponse({ success: true, data: coreTasksPayload });
      }
      if (url.includes('/api/teams/team_tab_close/activity')) {
        if (activityShouldFail) {
          return jsonResponse({ success: false, error: 'activity page failure' }, 500);
        }
        return jsonResponse({ success: true, data: { items: [], has_more: false } });
      }
      if (url.includes('/api/conversations/ext_exec/messages')) {
        return jsonResponse({ success: true, data: { items: execSlotMessages } });
      }
      return jsonResponse({ success: true, data: { items: [] } });
    };

    const driver = new MemoryOnlyStorageDriver();
    const persistence1 = new WorkspacePersistenceManager(driver);
    const adapter1 = new AionCoreAdapter(persistence1, {
      baseUrl: 'http://127.0.0.1:25828',
      fetchFn: makeFetch(),
      wsFactory: (url, protocols) => {
        const s = new MockSocket(url, protocols);
        sockets.push(s);
        return s;
      },
      readCookie: () => 'csrf_tab',
    });

    await adapter1.loadWorkspace();
    await adapter1.refreshCoreCatalog();
    const project = await adapter1.createProject({
      name: 'Projeto Tab Close',
      description: 'Teste fechamento de aba',
      workspacePathInfo: 'C:/sandbox',
    });
    const created = await adapter1.createConversation({
      projectId: project.id,
      title: 'Conversa Tab Close',
    });
    const convId = created.conversation.id;
    await adapter1.createCoreTeamForConversation(convId);
    await adapter1.connectWebSocket(convId);
    await new Promise((r) => setTimeout(r, 10));

    // Send initial prompt -> Terra proposes 2 dependent tasks -> Task 1 dispatched to executor
    await adapter1.sendMessage({
      conversationId: convId,
      targetTab: 'general',
      bodyMarkdown: 'Execute tarefa 1 e depois tarefa 2',
    });
    sockets[0].emitMessage({
      name: 'message.stream',
      data: {
        conversation_id: 'ext_lead',
        msg_id: 'm_tab_plan',
        turn_id: 't_tab_plan',
        type: 'content',
        data: {
          content:
            '```aion-desk-json\n' +
            JSON.stringify({
              protocol: INTERNAL_PROTOCOL_VERSION,
              kind: 'plan_proposal',
              conversationId: convId,
              summary: 'Plano 2 etapas',
              tasks: [
                { title: 'Etapa 1', description: 'Criar base', acceptanceCriteria: ['base ok'], dependencyTitles: [] },
                { title: 'Etapa 2', description: 'Finalizar', acceptanceCriteria: ['final ok'], dependencyTitles: ['Etapa 1'] },
              ],
            }) +
            '\n```',
        },
      },
    });
    sockets[0].emitMessage({
      name: 'message.stream',
      data: { conversation_id: 'ext_lead', msg_id: 'm_tab_plan', turn_id: 't_tab_plan', type: 'finish', data: {} },
    });
    await new Promise((r) => setTimeout(r, 40));

    const beforeClose = adapter1.getStateSnapshot().conversations[convId];
    expect(beforeClose.conversation.executionStatus).toBe('running');
    expect(beforeClose.tasks).toHaveLength(2);
    const task1Id = beforeClose.tasks[0].id;
    const att1Id = beforeClose.tasks[0].attempts[0].id;
    expect(beforeClose.tasks[0].status).toBe('running');
    expect(postedMessages).toHaveLength(2); // 1 user prompt + 1 Task 1 dispatch

    // Flush persistence & simulate TAB CLOSED (dispose adapter1)
    await persistence1.flushSave();
    adapter1.dispose();

    // While tab is closed, Core finishes Task 1's turn and saves the delivery_report in ext_exec messages
    slotExecState = 'idle';
    execSlotMessages = [
      { id: 'm_req_1', position: 'right', type: 'text', status: 'finish', hidden: false, content: { content: 'prompt' }, created_at: 1000 },
      {
        id: 'm_hidden_sys',
        position: 'left',
        type: 'text',
        status: 'finish',
        hidden: true,
        content: { content: 'mensagem interna oculta que nao deve vazar' },
        created_at: 1500,
      },
      {
        id: 'm_exec_done_closed',
        msg_id: 'm_exec_done_closed',
        position: 'left',
        type: 'text',
        status: 'finish',
        hidden: false,
        content: {
          content:
            '```aion-desk-json\n' +
            JSON.stringify({
              protocol: INTERNAL_PROTOCOL_VERSION,
              kind: 'delivery_report',
              conversationId: convId,
              taskId: task1Id,
              attemptId: att1Id,
              deliverySummary: 'Etapa 1 concluída enquanto aba esteve fechada',
              evidenceNotes: ['arquivo base.txt criado'],
            }) +
            '\n```',
        },
        created_at: 2000,
      },
    ];

    // Reopen tab (new adapter instance loading from same persistence driver)
    const persistence2 = new WorkspacePersistenceManager(driver);
    const adapter2 = new AionCoreAdapter(persistence2, {
      baseUrl: 'http://127.0.0.1:25828',
      fetchFn: makeFetch(),
      wsFactory: (url, protocols) => {
        const s = new MockSocket(url, protocols);
        sockets.push(s);
        return s;
      },
      readCookie: () => 'csrf_tab',
    });
    const reloaded = await adapter2.loadWorkspace();
    expect(reloaded.conversations[convId].conversation.executionStatus).toBe('paused_queue');
    // Zero automatic dispatches on reload!
    expect(postedMessages).toHaveLength(2);

    // Case 1: Incomplete catch-up refuses resume_queue and preserves paused_queue
    activityShouldFail = true;
    await expect(
      adapter2.controlExecution({ conversationId: convId, action: 'resume_queue' }),
    ).rejects.toMatchObject({ code: 'OPERATION_FAILED' });
    expect(adapter2.getStateSnapshot().conversations[convId].conversation.executionStatus).toBe('paused_queue');
    expect(adapter2.getStateSnapshot().conversations[convId].conversation.syncState).toBe('incomplete');
    expect(postedMessages).toHaveLength(2);

    // Case 2: Reconcile alone recovers the delivery finished while tab was closed WITHOUT auto-dispatching review
    activityShouldFail = false;
    const recRes = await adapter2.reconcileConversation(convId);
    expect(recRes.synced).toBe(true);
    const afterReconcile = adapter2.getStateSnapshot().conversations[convId];
    expect(afterReconcile.tasks[0].status).toBe('awaiting_review');
    expect(afterReconcile.tasks[0].attempts[0].status).toBe('delivered');
    expect(afterReconcile.conversation.executionStatus).toBe('paused_queue');
    // Hidden message was filtered out
    const execMsgs = afterReconcile.messagesByTab[afterReconcile.tasks[0].assigneeParticipantId] ?? [];
    expect(execMsgs.some((m) => m.bodyMarkdown.includes('mensagem interna oculta'))).toBe(false);
    // Still NO dispatch while paused_queue!
    expect(postedMessages).toHaveLength(2);

    // Case 3: Explicit user "Retomar fluxo" (resume_queue) resumes and dispatches ONLY the pending review
    // (does NOT repeat the user's original prompt and does NOT re-dispatch Task 1!)
    await adapter2.controlExecution({ conversationId: convId, action: 'resume_queue' });
    await new Promise((r) => setTimeout(r, 40));
    const afterResume = adapter2.getStateSnapshot().conversations[convId];
    expect(afterResume.conversation.executionStatus).toBe('running');
    expect(postedMessages).toHaveLength(3);
    expect(postedMessages[2].path).toBe('/api/teams/team_tab_close/agents/slot_rev/messages');

    // Case 4: Verify resume_queue when Core slot is STILL running -> transitions to running WITHOUT duplicate dispatch
    const postCountBeforeStillRunning = postedMessages.length;
    await persistence2.flushSave();
    adapter2.dispose();

    slotRevState = 'running';
    const persistence3 = new WorkspacePersistenceManager(driver);
    const adapter3 = new AionCoreAdapter(persistence3, {
      baseUrl: 'http://127.0.0.1:25828',
      fetchFn: makeFetch(),
      wsFactory: (url, protocols) => {
        const s = new MockSocket(url, protocols);
        sockets.push(s);
        return s;
      },
      readCookie: () => 'csrf_tab',
    });
    await adapter3.loadWorkspace();
    expect(adapter3.getStateSnapshot().conversations[convId].conversation.executionStatus).toBe('paused_queue');
    await adapter3.controlExecution({ conversationId: convId, action: 'resume_queue' });
    expect(adapter3.getStateSnapshot().conversations[convId].conversation.executionStatus).toBe('running');
    expect(postedMessages).toHaveLength(postCountBeforeStillRunning);

    adapter3.dispose();
  });

  it('handles expired session (401 + WS 1008), restarted Core (404), pendingOutOfOrder incomplete sync, 2-conversation isolation, and never auto-imports unrelated manual teams (V6-06 falhas/sessões)', async () => {
    const sockets: MockSocket[] = [];
    let mode: 'normal' | 'expired_401' | 'restarted_404' = 'normal';
    let teamSeq = 0;

    const fetchFn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.endsWith('/api/auth/refresh')) {
        return jsonResponse({ success: false, error: 'refresh expired' }, 401);
      }
      if (url.endsWith('/api/ws-token')) {
        return jsonResponse({ success: true, ws_token: 'tok_multi', expires_in: 300 });
      }
      if (url.endsWith('/api/agents/management')) {
        return jsonResponse({
          success: true,
          data: [
            {
              id: 'codex-1',
              name: 'Codex',
              backend: 'codex',
              installed: true,
              enabled: true,
              status: 'online',
              available_models: { available_models: [{ id: 'gpt-5.6-luna', label: 'GPT-5.6-Luna' }] },
            },
            {
              id: 'antigravity-1',
              name: 'Antigravity',
              backend: 'antigravity',
              installed: true,
              enabled: true,
              status: 'online',
              available_models: { available_models: [{ id: 'gemini-3.8-flash-low', label: 'Gemini 3.8 Flash' }] },
            },
          ],
        });
      }
      if (url.endsWith('/api/assistants')) {
        return jsonResponse({
          success: true,
          data: [
            { id: 'bare:codex-1', name: 'Codex', agent_id: 'codex-1', enabled: true, team_selectable: true },
            { id: 'bare:antigravity-1', name: 'Antigravity', agent_id: 'antigravity-1', enabled: true, team_selectable: true },
          ],
        });
      }
      if (url.endsWith('/api/teams') && method === 'POST') {
        teamSeq += 1;
        const tid = teamSeq === 1 ? 'team_alpha' : 'team_beta';
        return jsonResponse(
          {
            success: true,
            data: {
              id: tid,
              name: tid,
              workspace: 'C:/sandbox',
              assistants: [
                { slot_id: `slot_lead_${tid}`, conversation_id: `ext_lead_${tid}`, role: 'lead', name: 'Terra 6.1' },
                { slot_id: `slot_rev_${tid}`, conversation_id: `ext_rev_${tid}`, role: 'teammate', name: 'Sol 6.1' },
                { slot_id: `slot_exec_${tid}`, conversation_id: `ext_exec_${tid}`, role: 'teammate', name: 'Gemini Hydrogen' },
              ],
            },
          },
          201,
        );
      }
      if (url.endsWith('/api/teams') && method === 'GET') {
        return jsonResponse({
          success: true,
          data: [
            {
              id: 'team_alpha',
              name: 'team_alpha',
              assistants: [{ slot_id: 'slot_lead_team_alpha', conversation_id: 'ext_lead_team_alpha', role: 'lead', name: 'Terra 6.1' }],
            },
            {
              id: 'team_beta',
              name: 'team_beta',
              assistants: [{ slot_id: 'slot_lead_team_beta', conversation_id: 'ext_lead_team_beta', role: 'lead', name: 'Terra 6.1' }],
            },
            {
              id: 'team_manual_external_chat',
              name: 'Chat manual existente no Core',
              assistants: [{ slot_id: 'slot_manual', conversation_id: 'ext_manual', role: 'lead', name: 'Externo' }],
            },
          ],
        });
      }
      if (url.includes('/api/teams/team_')) {
        if (mode === 'expired_401') {
          return jsonResponse({ success: false, error: 'session expired' }, 401);
        }
        if (mode === 'restarted_404') {
          return jsonResponse({ success: false, error: 'team not found' }, 404);
        }
        const isAlpha = url.includes('/team_alpha/');
        const tid = isAlpha ? 'team_alpha' : 'team_beta';
        if (url.endsWith('/run-state')) {
          return jsonResponse({
            success: true,
            data: {
              session_generation: 'g1',
              active_run: null,
              slot_work: [
                { slot_id: `slot_lead_${tid}`, role: 'lead', state: 'idle', queued_foreground_count: 0, queued_background_count: 0 },
              ],
            },
          });
        }
        if (url.endsWith('/mailbox')) {
          return jsonResponse({
            success: true,
            data: [
              {
                id: `mb_${tid}_only`,
                team_id: tid,
                from_agent_id: `slot_lead_${tid}`,
                to_agent_id: 'user',
                msg_type: 'chat',
                content: `Mensagem exclusiva de ${tid}`,
                files: [],
                read: false,
                created_at: 1731780000100,
              },
            ],
          });
        }
        if (url.endsWith('/tasks')) {
          return jsonResponse({ success: true, data: [] });
        }
        if (url.includes('/activity')) {
          return jsonResponse({ success: true, data: { items: [], has_more: false } });
        }
      }
      return jsonResponse({ success: true, data: {} });
    };

    const persistence = new WorkspacePersistenceManager(new MemoryOnlyStorageDriver());
    const adapter = new AionCoreAdapter(persistence, {
      baseUrl: 'http://127.0.0.1:25828',
      fetchFn,
      wsFactory: (url, protocols) => {
        const s = new MockSocket(url, protocols);
        sockets.push(s);
        return s;
      },
      readCookie: () => 'csrf_multi',
    });

    await adapter.loadWorkspace();
    await adapter.refreshCoreCatalog();
    const project = await adapter.createProject({
      name: 'Projeto Multi',
      description: 'Duas conversas + falhas',
      workspacePathInfo: 'C:/sandbox',
    });
    const convA = (await adapter.createConversation({ projectId: project.id, title: 'Conv Alpha' })).conversation.id;
    const convB = (await adapter.createConversation({ projectId: project.id, title: 'Conv Beta' })).conversation.id;
    await adapter.createCoreTeamForConversation(convA);
    await adapter.createCoreTeamForConversation(convB);

    // 1. syncCoreTeams MUST NOT auto-import unrelated manual teams
    const syncRes = await adapter.syncCoreTeams();
    expect(syncRes.teamsCount).toBe(3);
    const allConvs = Object.values(adapter.getStateSnapshot().conversations);
    expect(allConvs.some((c) => c.conversation.externalTeamId === 'team_manual_external_chat')).toBe(false);

    // 2. WS drop + reconnect reconciles BOTH conversations with strict isolation
    await adapter.connectWebSocket(convA);
    await new Promise((r) => setTimeout(r, 15));
    sockets[0].emitClose(1006);
    await new Promise((r) => setTimeout(r, 550));
    expect(sockets.length).toBeGreaterThanOrEqual(2);
    await new Promise((r) => setTimeout(r, 80));

    const snapA = adapter.getStateSnapshot().conversations[convA];
    const snapB = adapter.getStateSnapshot().conversations[convB];
    const msgsA = Object.values(snapA.messagesByTab).flat().map((m) => m.bodyMarkdown);
    const msgsB = Object.values(snapB.messagesByTab).flat().map((m) => m.bodyMarkdown);
    expect(msgsA.some((t) => t.includes('team_alpha'))).toBe(true);
    expect(msgsA.some((t) => t.includes('team_beta'))).toBe(false);
    expect(msgsB.some((t) => t.includes('team_beta'))).toBe(true);
    expect(msgsB.some((t) => t.includes('team_alpha'))).toBe(false);

    // 3. Pending out-of-order events MUST force synced=false & syncState='incomplete'
    const stateWithPending = structuredClone(adapter.getStateSnapshot());
    const alphaLeadId = stateWithPending.conversations[convA].participants[0].id;
    stateWithPending.conversations[convA].pendingOutOfOrder = {
      999: {
        id: 'evt_ooo_999',
        seq: 999,
        conversationId: convA,
        timestamp: '2026-11-18T12:00:00.000Z',
        origin: 'gateway',
        type: 'connection_state_changed',
        payload: {
          participantId: alphaLeadId,
          participantStatus: 'idle',
          sessionStatus: 'active',
          generalSummary: 'fora de ordem',
          projectToGeneral: false,
        },
      },
    };
    await adapter.importWorkspaceState(stateWithPending);
    const recPending = await adapter.reconcileConversation(convA);
    expect(recPending.synced).toBe(false);
    expect(adapter.getStateSnapshot().conversations[convA].conversation.syncState).toBe('incomplete');
    expect(adapter.getStateSnapshot().conversations[convA].syncErrorNote).toContain('fora de ordem pendente');

    // Clear pendingOutOfOrder for next checks
    const clearedState = structuredClone(adapter.getStateSnapshot());
    clearedState.conversations[convA].pendingOutOfOrder = {};
    clearedState.coreSessionAuthenticated = true;
    await adapter.importWorkspaceState(clearedState);

    // 4. Expired session (401 + failed refresh) during reconcile
    mode = 'expired_401';
    const rec401 = await adapter.reconcileConversation(convA);
    expect(rec401.synced).toBe(false);
    expect(adapter.getStateSnapshot().coreSessionAuthenticated).toBe(false);
    expect(adapter.getStateSnapshot().conversations[convA].conversation.syncState).toBe('incomplete');
    expect(adapter.getStateSnapshot().conversations[convA].syncErrorNote).toContain('sessão expirada');
    expect(
      adapter.getStateSnapshot().connections.filter((c) => c.mode === 'aion_core').every((c) => c.authStatus === 'expired'),
    ).toBe(true);

    // 5. Core restarted with missing team (404)
    mode = 'restarted_404';
    const rec404 = await adapter.reconcileConversation(convA);
    expect(rec404.synced).toBe(false);
    expect(adapter.getStateSnapshot().conversations[convA].conversation.syncState).toBe('incomplete');
    expect(adapter.getStateSnapshot().conversations[convA].syncErrorNote).toContain('equipe não encontrada no Core');

    // 6. WS close 1008 (policy violation) with failed refresh marks session expired
    mode = 'normal';
    const beforeWs1008 = structuredClone(adapter.getStateSnapshot());
    beforeWs1008.coreSessionAuthenticated = true;
    await adapter.importWorkspaceState(beforeWs1008);
    await adapter.connectWebSocket(convA);
    await new Promise((r) => setTimeout(r, 15));
    const activeSocket = sockets[sockets.length - 1];
    activeSocket.emitClose(1008);
    await new Promise((r) => setTimeout(r, 550));
    expect(adapter.getStateSnapshot().coreSessionAuthenticated).toBe(false);

    adapter.dispose();
  });

  it('V6-07: rastreia coreRuntimeStatus mesmo sem conexões Core, preserva auth=false no catálogo e reseta ao mudar baseUrl', async () => {
    let healthOk = true;
    const fetchFn = async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/health')) {
        if (!healthOk) {
          throw new Error('connect ECONNREFUSED 127.0.0.1:25828');
        }
        return jsonResponse({
          status: 'ok',
          version: '0.2.2',
          build_time: '2026-11-18T00:00:00Z',
        });
      }
      if (url.endsWith('/api/agents/management') || url.endsWith('/api/assistants')) {
        return jsonResponse({ success: true, data: [] });
      }
      return jsonResponse({ success: true, data: {} });
    };

    const persistence = new WorkspacePersistenceManager(new MemoryOnlyStorageDriver());
    const adapter = new AionCoreAdapter(persistence, {
      baseUrl: 'http://127.0.0.1:25828',
      fetchFn,
      wsFactory: (url, protocols) => new MockSocket(url, protocols),
      readCookie: () => 'csrf_v607',
    });

    await adapter.loadWorkspace();
    expect(adapter.getStateSnapshot().connections.filter((c) => c.mode === 'aion_core')).toHaveLength(0);
    expect(adapter.getStateSnapshot().coreRuntimeStatus ?? 'unknown').toBe('unknown');

    // checkHealth() succeeds -> coreRuntimeStatus becomes 'reachable' even with 0 Core connections
    const health1 = await adapter.checkHealth();
    expect(health1.reachable).toBe(true);
    expect(adapter.getStateSnapshot().coreRuntimeStatus).toBe('reachable');

    // checkHealth() fails -> coreRuntimeStatus becomes 'unreachable'
    healthOk = false;
    await expect(adapter.checkHealth()).rejects.toThrow();
    expect(adapter.getStateSnapshot().coreRuntimeStatus).toBe('unreachable');

    // refreshCoreCatalog() when unauthenticated does NOT mark coreSessionAuthenticated=true
    healthOk = true;
    const unauthenticatedState = structuredClone(adapter.getStateSnapshot());
    unauthenticatedState.coreSessionAuthenticated = false;
    await adapter.importWorkspaceState(unauthenticatedState);
    await adapter.refreshCoreCatalog();
    expect(adapter.getStateSnapshot().coreSessionAuthenticated).toBe(false);
    expect(adapter.getStateSnapshot().coreRuntimeStatus).toBe('reachable');

    // updateCoreSettings() changing baseUrl resets live verification flags
    const authedState = structuredClone(adapter.getStateSnapshot());
    authedState.coreSessionAuthenticated = true;
    authedState.coreRuntimeStatus = 'reachable';
    await adapter.importWorkspaceState(authedState);
    const currentCoreSettings = authedState.coreSettings ?? {
      baseUrl: 'http://127.0.0.1:25828',
      workspacePath: 'C:/sandbox',
      authMode: 'local_session',
    };
    await adapter.updateCoreSettings({
      ...currentCoreSettings,
      baseUrl: 'http://127.0.0.1:29999',
    });
    expect(adapter.getStateSnapshot().coreRuntimeStatus).toBe('unknown');
    expect(adapter.getStateSnapshot().coreSessionAuthenticated).toBe(false);

    adapter.dispose();
  });

  it('V6-09: processa payloads reais sanitizados do AionCore v0.2.2 (childTurnStarted <-> message.stream, tips, ConfirmRequest, PATCH /model e slot_messages catch-up)', async () => {
    const sockets: MockSocket[] = [];
    let patchedModelId: string | undefined;
    const confirmPayloads: unknown[] = [];

    const teamId = '01a1ef60-f8b5-7543-b26e-c6e8dd203695';
    const slotLead = '01a1ef5d-0925-7a10-9f35-0b5b7f4c5b63';
    const slotExec = '01a1ef5d-0a9d-7762-9ca5-8f1c82c20326';
    const extLead = '6dfc3ce4';
    const extExec = '89ab12cd';

    const fetchFn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.endsWith('/health')) {
        return jsonResponse(REAL_CORE_HEALTH_V022);
      }
      if (url.endsWith('/api/auth/status')) {
        return jsonResponse(REAL_CORE_AUTH_STATUS_V022);
      }
      if (url.endsWith('/api/agents/management')) {
        return jsonResponse({ success: true, data: REAL_CORE_AGENTS_MANAGEMENT_V022 });
      }
      if (url.endsWith('/api/assistants')) {
        return jsonResponse({ success: true, data: REAL_CORE_ASSISTANTS_V022 });
      }
      if (url.endsWith('/api/ws-token')) {
        return jsonResponse({ ws_token: 'ws_tok_v609_real_shape', expires_in: 300 });
      }
      if (url.endsWith('/api/teams') && method === 'POST') {
        return jsonResponse(
          {
            success: true,
            data: {
              id: teamId,
              name: 'Execucao Dist Real',
              workspace: 'C:/sandbox/vertice-workspace',
              lead_slot_id: slotLead,
              assistants: [
                { slot_id: slotLead, conversation_id: extLead, role: 'lead', name: 'Terra 6.1', model: 'gpt-5.6-luna' },
                { slot_id: slotExec, conversation_id: extExec, role: 'teammate', name: 'Gemini Hydrogen', model: 'gpt-5.6-luna' },
              ],
            },
          },
          201,
        );
      }
      if (url.endsWith(`/api/teams/${teamId}/agents/${slotExec}/model`) && method === 'PATCH') {
        const parsed = JSON.parse(String(init?.body || '{}')) as { model_id?: string };
        patchedModelId = parsed.model_id;
        return jsonResponse({ success: true, data: { slot_id: slotExec, model_id: parsed.model_id } });
      }
      if (url.includes('/confirmations/') && url.endsWith('/confirm') && method === 'POST') {
        confirmPayloads.push(JSON.parse(String(init?.body || '{}')));
        return jsonResponse({ success: true });
      }
      if (url.endsWith(`/api/teams/${teamId}/messages`) && method === 'POST') {
        return jsonResponse({
          success: true,
          data: {
            message_id: '01a1ef5d-1242-75c2-a185-6e0e21fb778d',
            enqueue_status: 'started',
            team_run_id: '01a1ef5d-1242-75c2-a185-6de505cbfa45',
          },
        });
      }
      if (url.endsWith(`/api/teams/${teamId}/run-state`)) {
        return jsonResponse({
          success: true,
          data: {
            team_id: teamId,
            active_run: null,
            slot_work: [],
          },
        });
      }
      if (url.endsWith(`/api/teams/${teamId}/mailbox`)) {
        return jsonResponse({ success: true, data: [] });
      }
      if (url.endsWith(`/api/teams/${teamId}/tasks`)) {
        return jsonResponse({ success: true, data: [] });
      }
      if (url.includes(`/api/teams/${teamId}/activity`)) {
        return jsonResponse({ success: true, data: { items: [], has_more: false } });
      }
      if (url.includes(`/api/conversations/${extLead}/messages`)) {
        return jsonResponse(
          buildRealCapturedConversationMessagesResponse({
            extConvId: extLead,
            turnId: '01a1ef5d-19f2-7210-8b84-12d2098879f8',
            replyText: 'V609_REAL_SHAPE_VERIFIED',
          }),
        );
      }
      return jsonResponse({ success: true, data: {} });
    };

    const persistence = new WorkspacePersistenceManager(new MemoryOnlyStorageDriver());
    const adapter = new AionCoreAdapter(persistence, {
      baseUrl: 'http://127.0.0.1:25828',
      fetchFn,
      wsFactory: (url, protocols) => {
        const s = new MockSocket(url, protocols);
        sockets.push(s);
        return s;
      },
      readCookie: () => 'csrf_v609',
    });

    await adapter.loadWorkspace();
    await adapter.checkHealth();
    await adapter.checkAuthStatus();
    await adapter.refreshCoreCatalog();

    const project = await adapter.createProject({
      name: 'Projeto Real Shape',
      description: 'Validar payloads reais v0.2.2',
      workspacePathInfo: 'C:/sandbox/vertice-workspace',
    });
    const conv = await adapter.createConversation({
      projectId: project.id,
      title: 'Conversa Real V6-09',
    });
    const leadPart = conv.participants.find((p) => p.role === 'coordinator')!;
    const execPart = conv.participants.find((p) => p.role === 'executor')!;

    await adapter.createCoreTeamForConversation(conv.conversation.id);
    await adapter.connectWebSocket(conv.conversation.id);
    await new Promise((r) => setTimeout(r, 15));
    const ws = sockets[sockets.length - 1];

    // 1. Live PATCH .../model promotion matches Core snake_case model_id contract
    await adapter.configureParticipant({
      conversationId: conv.conversation.id,
      participantId: execPart.id,
      displayName: execPart.displayName,
      roles: execPart.roles,
      connectionId: execPart.connectionId,
      modelRef: {
        externalId: 'gpt-5.6-luna',
        displayName: 'GPT-5.6-Luna',
        source: 'core_catalog',
        confirmation: 'confirmed',
      },
      instructions: execPart.instructions,
    });
    expect(patchedModelId).toBe('gpt-5.6-luna');

    // 2. Real team.slotWorkChanged (blocked/runtime_starting) + team.childTurnStarted <-> message.stream <-> team.childTurnCompleted
    await adapter.sendMessage({
      conversationId: conv.conversation.id,
      targetTab: 'general',
      bodyMarkdown: 'Teste real v0.2.2',
    });

    const leadTurnId = '01a1ef5d-19f2-7210-8b84-12d2098879f8';
    ws.emitMessage(
      buildRealSlotWorkChangedEvent({
        teamId,
        slotId: slotLead,
        state: 'blocked',
        reason: 'runtime_starting',
      }),
    );
    ws.emitMessage(
      buildRealTeamChildTurnEvent({
        name: 'team.childTurnStarted',
        teamId,
        teamRunId: '01a1ef5d-1242-75c2-a185-6de505cbfa45',
        slotId: slotLead,
        role: 'lead',
        extConvId: extLead,
        turnId: leadTurnId,
        status: 'running',
      }),
    );
    ws.emitMessage(
      buildRealMessageStreamFrame({
        extConvId: extLead,
        msgId: '7eaa78d8',
        turnId: leadTurnId,
        type: 'tips',
        data: { content: 'The installed codex is newer...' },
      }),
    );
    ws.emitMessage(
      buildRealMessageStreamFrame({
        extConvId: extLead,
        msgId: '24a6eed4',
        turnId: leadTurnId,
        type: 'content',
        data: { session_id: 'cli_sess_v609_lead', content: 'V609_REAL_SHAPE_VERIFIED' },
      }),
    );
    ws.emitMessage(
      buildRealMessageStreamFrame({
        extConvId: extLead,
        msgId: '24a6eed4',
        turnId: leadTurnId,
        type: 'finish',
        data: { session_id: 'cli_sess_v609_lead' },
      }),
    );
    ws.emitMessage(
      buildRealTeamChildTurnEvent({
        name: 'team.childTurnCompleted',
        teamId,
        teamRunId: '01a1ef5d-1242-75c2-a185-6de505cbfa45',
        slotId: slotLead,
        role: 'lead',
        extConvId: extLead,
        turnId: leadTurnId,
        status: 'completed',
      }),
    );

    const snap = adapter.getStateSnapshot().conversations[conv.conversation.id];
    const leadMsgs = snap.messagesByTab[leadPart.id] ?? [];
    expect(leadMsgs.some((m) => m.bodyMarkdown.includes('V609_REAL_SHAPE_VERIFIED'))).toBe(true);
    expect(snap.participants.find((p) => p.id === leadPart.id)?.sessionRef.nativeSessionId).toBe(
      'cli_sess_v609_lead',
    );
    // Strict tab isolation: executor tab recorded config update only and did NOT receive lead turn output
    const execMsgs = snap.messagesByTab[execPart.id] ?? [];
    expect(execMsgs.some((m) => m.bodyMarkdown.includes('GPT-5.6-Luna'))).toBe(true);
    expect(execMsgs.some((m) => m.bodyMarkdown.includes('V609_REAL_SHAPE_VERIFIED'))).toBe(false);

    // 3. Real ConfirmRequest schema (`always_allow: false`, exact `msg_id` and option_id `allow_once`)
    ws.emitMessage(
      buildRealMessageStreamFrame({
        extConvId: extExec,
        msgId: 'msg_perm_exec_1',
        turnId: 'turn_exec_perm_1',
        type: 'acp_permission',
        data: {
          tool_call: {
            tool_call_id: 'call_perm_real_1',
            kind: 'execute',
            title: 'Executar comando sandbox',
            raw_input: { command: 'git status' },
          },
          options: [
            { kind: 'allow_once', option_id: 'allow_once', label: 'Allow once' },
            { kind: 'reject_once', option_id: 'reject_once', label: 'Reject' },
          ],
        },
      }),
    );
    const createdPerm = adapter
      .getStateSnapshot()
      .conversations[conv.conversation.id].permissions.find((p) =>
        p.scopeKey.includes('call_perm_real_1'),
      );
    expect(createdPerm).toBeDefined();
    await adapter.respondPermission({
      conversationId: conv.conversation.id,
      requestId: createdPerm!.id,
      decision: 'approved',
    });
    expect(confirmPayloads).toEqual([
      {
        msg_id: 'msg_perm_exec_1',
        data: 'allow_once',
        always_allow: false,
      },
    ]);

    adapter.dispose();
  });
});
