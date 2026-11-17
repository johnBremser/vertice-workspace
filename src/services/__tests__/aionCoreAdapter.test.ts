import { describe, expect, it, vi } from 'vitest';
import { INTERNAL_PROTOCOL_VERSION } from '../../domain/internalProtocol';
import { AionCoreAdapter } from '../aionCoreAdapter';
import type { WebSocketFactory, WsLike } from '../aionCoreTransport';
import { GatewayCapabilityError } from '../gateway';
import {
  MemoryOnlyStorageDriver,
  WorkspacePersistenceManager,
} from '../storage';

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
});
