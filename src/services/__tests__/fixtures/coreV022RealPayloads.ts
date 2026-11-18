/**
 * Payloads reais sanitizados capturados do AionCore v0.2.2 (WebUI local) e conferidos
 * contra os DTOs de `crates/aionui-api-types` e logs reais (`2026-11-18.aioncore.log`,
 * `GET /api/conversations/:id/messages`, `/api/agents/management`, `/api/assistants`).
 *
 * Sem credenciais, cookies ou caminhos pessoais.
 */

export const REAL_CORE_HEALTH_V022 = {
  status: 'ok',
  version: '0.2.2',
  build_time: '2026-11-18T14:49:30Z',
} as const;

export const REAL_CORE_AUTH_STATUS_V022 = {
  is_authenticated: true,
  needs_setup: false,
  user: {
    id: 'system_default_user',
    username: 'admin',
  },
} as const;

export const REAL_CORE_AGENTS_MANAGEMENT_V022 = [
  {
    id: 'codex-1',
    name: 'Codex',
    backend: 'codex',
    installed: true,
    enabled: true,
    status: 'online',
    available_models: {
      available_models: [
        { id: 'gpt-5.6-luna', label: 'GPT-5.6-Luna' },
      ],
    },
  },
  {
    id: 'cursor-1',
    name: 'Cursor',
    backend: 'cursor-agent',
    installed: true,
    enabled: true,
    status: 'online',
    available_models: {
      available_models: [
        { id: 'composer-2.5', label: 'Composer 2.5' },
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
        { id: 'gemini-3.8-flash-low', label: 'Gemini 3.8 Flash' },
      ],
    },
  },
] as const;

export const REAL_CORE_ASSISTANTS_V022 = [
  {
    id: 'bare:8e1acf31',
    name: 'Codex',
    agent_id: 'codex-1',
    enabled: true,
    team_selectable: true,
  },
  {
    id: 'bare:cursor-1',
    name: 'Cursor',
    agent_id: 'cursor-1',
    enabled: true,
    team_selectable: true,
  },
  {
    id: 'bare:agy-1',
    name: 'Antigravity',
    agent_id: 'antigravity-1',
    enabled: true,
    team_selectable: true,
  },
] as const;

/** Estrutura exata de `TeamChildTurnPayload` (`crates/aionui-api-types/src/team.rs:452-464`) */
export function buildRealTeamChildTurnEvent(params: {
  name: 'team.childTurnStarted' | 'team.childTurnCompleted';
  teamId: string;
  teamRunId: string;
  slotId: string;
  role: 'lead' | 'teammate';
  extConvId: string;
  turnId: string;
  status: 'running' | 'completed';
}) {
  return {
    name: params.name,
    data: {
      user_id: 'system_default_user',
      team_id: params.teamId,
      team_run_id: params.teamRunId,
      slot_id: params.slotId,
      role: params.role,
      conversation_id: params.extConvId,
      turn_id: params.turnId,
      status: params.status,
    },
  };
}

/** Frame `team.slotWorkChanged` observado ao vivo (`runtime_starting` / `working` / `quiescent`) */
export function buildRealSlotWorkChangedEvent(params: {
  teamId: string;
  slotId: string;
  state: 'blocked' | 'working' | 'quiescent';
  reason?: string;
}) {
  return {
    name: 'team.slotWorkChanged',
    data: {
      user_id: 'system_default_user',
      team_id: params.teamId,
      slot_id: params.slotId,
      slot_work: {
        slot_id: params.slotId,
        state: params.state,
        reason: params.reason ?? null,
      },
    },
  };
}

/** Envelope `message.stream` alinhado ao `session_agent.rs:3640-3649` e aos logs capturados */
export function buildRealMessageStreamFrame(params: {
  extConvId: string;
  msgId: string;
  turnId: string;
  type: 'tips' | 'content' | 'tool_call' | 'acp_permission' | 'finish';
  data: Record<string, unknown>;
  position?: 'left' | 'right';
  hidden?: boolean;
}) {
  return {
    name: 'message.stream',
    data: {
      conversation_id: params.extConvId,
      user_id: 'system_default_user',
      msg_id: params.msgId,
      turn_id: params.turnId,
      type: params.type,
      data: params.data,
      position: params.position ?? 'left',
      hidden: params.hidden ?? false,
    },
  };
}

/** Item sanitizado real capturado de `GET /api/conversations/:id/messages` (V6-08) */
export function buildRealCapturedConversationMessagesResponse(params: {
  extConvId: string;
  turnId: string;
  replyText: string;
}) {
  return {
    success: true,
    data: {
      items: [
        {
          id: '7eaa78d8',
          conversation_id: params.extConvId,
          msg_id: '7eaa78d8',
          type: 'tips',
          content: {
            content:
              'The installed codex is newer than the version AionUi verified. (installed codex-cli 0.169.0-alpha.11.1 / verified by AionUi: 0.151.0)',
            type: 'info',
            code: 'CLI_VERSION_NEWER',
          },
          position: 'left',
          status: 'finish',
          hidden: false,
          created_at: 1795017217345,
        },
        {
          id: '24a6eed4',
          conversation_id: params.extConvId,
          msg_id: '24a6eed4',
          type: 'text',
          content: {
            content: params.replyText,
          },
          position: 'left',
          status: 'finish',
          hidden: false,
          created_at: 1795017234201,
          backend_turn_id: params.turnId,
        },
      ],
      has_more_before: false,
      has_more_after: false,
    },
  };
}
