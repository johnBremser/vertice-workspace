import { GatewayCapabilityError } from './gateway';

/**
 * External wire DTOs verified against AionCore v0.2.2
 * (commit 503a87199eb978790ca77675b39c84b241535bf3).
 *
 * Strictly separated from internal Aion Desk contracts (`src/domain/types.ts`).
 */

export interface HealthResponse {
  status: string;
  version: string;
  build_time: string;
}

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  message?: string;
}

export interface ErrorResponse {
  success: boolean;
  error: string;
  code: string;
  details?: unknown;
}

export interface PublicUser {
  id: string;
  username: string;
}

export interface LoginRequest {
  username: string;
  password: string;
}

export interface LoginResponse {
  success: boolean;
  message: string;
  user: PublicUser;
  token: string;
}

export interface AuthStatusResponse {
  success: boolean;
  needs_setup: boolean;
  user_count: number;
  is_authenticated: boolean;
}

export interface RefreshResponse {
  success: boolean;
  token: string;
  refresh_token: string;
}

export interface WsTokenResponse {
  success: boolean;
  ws_token: string;
  expires_in: number;
}

export type AgentManagementStatus =
  | 'ready'
  | 'unauthenticated'
  | 'not_installed'
  | 'disabled'
  | 'error'
  | string;

export interface AgentManagementRow {
  id: string;
  icon?: string | null;
  name: string;
  description?: string | null;
  backend?: string | null;
  agent_type?: string;
  agent_source?: string;
  enabled: boolean;
  installed: boolean;
  command?: string | null;
  config_options?: unknown;
  available_modes?: unknown;
  available_models?: unknown;
  available_commands?: unknown;
  sort_order: number;
  team_capable?: boolean;
  status: AgentManagementStatus;
  last_check_status?: string | null;
  last_check_error_code?: string | null;
  last_check_error_message?: string | null;
  last_check_guidance?: string | null;
  last_check_latency_ms?: number | null;
}

export interface AssistantResponse {
  id: string;
  source: string;
  name: string;
  description?: string | null;
  avatar?: string | null;
  enabled: boolean;
  sort_order: number;
  agent_id: string;
  models?: string[];
  last_used_at?: number | null;
  agent_status: AgentManagementStatus;
  agent_status_message?: string | null;
  team_selectable: boolean;
  team_block_reason?: string | null;
  deletable: boolean;
}

/**
 * Matches AionCore `TeamAgentInputCompat` (`#[serde(deny_unknown_fields)]`).
 * Never include `backend` or legacy `conversation_id`.
 */
export interface TeamAgentInputCompat {
  assistant_id: string;
  name: string;
  role: 'lead' | 'teammate';
  model: string;
}

export interface CreateTeamRequest {
  name: string;
  agents: TeamAgentInputCompat[];
  workspace?: string;
}

export interface TeamContextResetCapability {
  supported: boolean;
  availability: string;
}

export interface TeamAgentResponse {
  slot_id: string;
  assistant_name?: string;
  name: string;
  role: string;
  conversation_id: string;
  assistant_backend?: string;
  backend: string;
  icon?: string | null;
  model: string;
  assistant_id?: string | null;
  status?: string | null;
  pending_confirmations?: number;
  context_reset?: TeamContextResetCapability;
}

export interface TeamResponse {
  id: string;
  name: string;
  workspace?: string;
  assistants: TeamAgentResponse[];
  leader_assistant_id?: string | null;
  created_at: number;
  updated_at: number;
}

export type ChatFileRef =
  | { kind: 'project'; pe_id: string; relative_path: string }
  | { kind: 'upload'; path: string }
  | { kind: 'local'; path: string };

export interface SendTeamMessageRequest {
  content: string;
  files?: ChatFileRef[];
}

export interface SendAgentMessageRequest {
  content: string;
  files?: ChatFileRef[];
}

export type TeamMessageEnqueueStatus =
  | 'accepted'
  | 'queued'
  | 'blocked_runtime_starting';

export type TeamRunStatus =
  | 'accepted'
  | 'running'
  | 'cancelling'
  | 'completed'
  | 'cancelled'
  | 'failed';

export interface TeamSlotWorkPayload {
  slot_id: string;
  role: 'lead' | 'teammate';
  state: 'idle' | 'queued' | 'starting' | 'running' | 'paused' | 'blocked';
  queued_foreground_count: number;
  queued_background_count: number;
  active_turn_id?: string | null;
  active_turn_started_at_ms?: number | null;
  active_turn_elapsed_ms?: number | null;
  active_turn_slow?: boolean | null;
  blocked_reason?: string | null;
  team_run_id?: string | null;
}

export interface TeamRunPayload {
  team_id: string;
  team_run_id: string;
  source: 'user_message' | 'system_lifecycle';
  has_user_intervention: boolean;
  target_slot_id: string;
  target_role: 'lead' | 'teammate';
  status: TeamRunStatus;
  queued_intent_count: number;
  starting_batch_count: number;
  running_batch_count: number;
  active_enqueue_lease_count: number;
  slot_work: TeamSlotWorkPayload[];
}

export interface TeamRunAckResponse {
  enqueue_status: TeamMessageEnqueueStatus;
  message_id: string;
  run: TeamRunPayload;
}

export interface TeamRunStateResponse {
  session_generation?: string | null;
  active_run?: TeamRunPayload | null;
  slot_work: TeamSlotWorkPayload[];
}

/**
 * Exact WebSocket event names emitted by AionCore
 * `crates/aionui-team/src/events.rs` & `stream_relay.rs`
 * (commit 503a87199eb978790ca77675b39c84b241535bf3).
 */
export const CORE_WS_EVENTS = {
  TEAM_SLOT_WORK_CHANGED: 'team.slotWorkChanged',
  TEAM_CHILD_TURN_STARTED: 'team.childTurnStarted',
  TEAM_CHILD_TURN_COMPLETED: 'team.childTurnCompleted',
  TEAM_CHILD_TURN_CANCELLED: 'team.childTurnCancelled',
  TEAM_RUN_ACCEPTED: 'team.runAccepted',
  TEAM_RUN_STARTED: 'team.runStarted',
  TEAM_RUN_UPDATED: 'team.runUpdated',
  TEAM_RUN_COMPLETED: 'team.runCompleted',
  TEAM_RUN_CANCELLED: 'team.runCancelled',
  TEAM_RUN_FAILED: 'team.runFailed',
  TEAM_TASK_CHANGED: 'team.taskChanged',
  TEAM_MAILBOX_CHANGED: 'team.mailboxChanged',
  TEAM_TEAMMATE_MESSAGE: 'team.teammateMessage',
  MESSAGE_STREAM: 'message.stream',
} as const;

export interface TeamChildTurnPayload {
  team_id: string;
  team_run_id: string;
  slot_id: string;
  role: 'lead' | 'teammate';
  conversation_id: string;
  turn_id: string;
  status: TeamRunStatus;
  reason?: string | null;
  replacement_message_id?: string | null;
}

export interface TeamSlotWorkChangedPayload {
  team_id: string;
  slot_work: TeamSlotWorkPayload;
}

/**
 * Matches `TeamMailboxMessageResponse` (`crates/aionui-api-types/src/team.rs`).
 */
export interface TeamMailboxMessageResponse {
  id: string;
  team_id: string;
  from_agent_id: string;
  to_agent_id: string;
  msg_type: string;
  content: string;
  summary?: string | null;
  files: string[];
  read: boolean;
  created_at: number;
}

/**
 * Matches `TeamTaskResponse` (`crates/aionui-api-types/src/team.rs`).
 */
export interface TeamTaskResponse {
  id: string;
  team_id: string;
  subject: string;
  description?: string | null;
  status: 'pending' | 'in_progress' | 'completed' | 'deleted' | string;
  owner?: string | null;
  blocked_by: string[];
  blocks: string[];
  created_at: number;
  updated_at: number;
}

export type TeamActivityKind = 'message' | 'task';

/**
 * Matches `TeamActivityItemResponse` (`crates/aionui-api-types/src/team.rs`).
 */
export interface TeamActivityItemResponse {
  kind: TeamActivityKind;
  created_at: number;
  id: string;
  message?: TeamMailboxMessageResponse | null;
  task?: TeamTaskResponse | null;
}

export interface TeamActivityCursor {
  ts: number;
  id: string;
}

/**
 * Matches `TeamActivityPageResponse` (`crates/aionui-api-types/src/team.rs`).
 */
export interface TeamActivityPageResponse {
  items: TeamActivityItemResponse[];
  next_cursor?: TeamActivityCursor | null;
  has_more: boolean;
}

export interface TeamTaskChangedPayload {
  team_id: string;
  task: TeamTaskResponse;
  change: 'created' | 'updated';
}

export interface TeamMailboxChangedPayload {
  team_id: string;
  message: TeamMailboxMessageResponse;
  change: 'created' | 'read';
}

export type ConfigOptionConfirmation =
  | 'observed'
  | 'pending_next_turn'
  | 'command_ack';

export interface AcpConfigSelectOptionDto {
  value: string;
  name?: string | null;
  label?: string | null;
  description?: string | null;
}

export interface AcpConfigOptionDto {
  id: string;
  name?: string | null;
  label?: string | null;
  description?: string | null;
  category?: string | null;
  type: string;
  current_value?: string | null;
  options: AcpConfigSelectOptionDto[];
}

export interface SetConfigOptionResponse {
  confirmation: ConfigOptionConfirmation;
  config_options?: AcpConfigOptionDto[] | null;
}

export interface WebSocketMessage<T = Record<string, unknown>> {
  name: string;
  data: T;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function assertHealthResponse(raw: unknown): HealthResponse {
  if (
    !isObjectRecord(raw) ||
    typeof raw.status !== 'string' ||
    typeof raw.version !== 'string' ||
    typeof raw.build_time !== 'string'
  ) {
    throw new GatewayCapabilityError(
      'INVALID_PAYLOAD',
      'Resposta inválida de /health: esperado objeto com status, version e build_time.',
      true,
    );
  }
  return {
    status: raw.status,
    version: raw.version,
    build_time: raw.build_time,
  };
}

export function unwrapApiResponse<T>(
  raw: unknown,
  endpointLabel: string,
  validateData?: (data: unknown) => data is T,
): T {
  if (!isObjectRecord(raw) || typeof raw.success !== 'boolean') {
    throw new GatewayCapabilityError(
      'INVALID_PAYLOAD',
      `Resposta fora do envelope ApiResponse em ${endpointLabel}.`,
      true,
    );
  }
  if (!raw.success) {
    const errMsg =
      typeof raw.message === 'string' && raw.message
        ? raw.message
        : `Operação ${endpointLabel} retornou success=false.`;
    throw new GatewayCapabilityError('OPERATION_FAILED', errMsg, true);
  }
  if (validateData && !validateData(raw.data)) {
    throw new GatewayCapabilityError(
      'INVALID_PAYLOAD',
      `Campo data inválido na resposta de ${endpointLabel}.`,
      true,
    );
  }
  return raw.data as T;
}

export function assertWebSocketMessage(raw: unknown): WebSocketMessage {
  if (!isObjectRecord(raw) || typeof raw.name !== 'string' || !('data' in raw)) {
    throw new GatewayCapabilityError(
      'INVALID_PAYLOAD',
      'Evento WebSocket inválido: esperado envelope { name, data }.',
      true,
    );
  }
  const data = isObjectRecord(raw.data) ? raw.data : { value: raw.data };
  return {
    name: raw.name,
    data,
  };
}

export function extractAvailableModelOptions(
  rawModels: unknown,
): Array<{ externalId: string; displayName: string }> {
  if (!rawModels) return [];
  if (Array.isArray(rawModels)) {
    const out: Array<{ externalId: string; displayName: string }> = [];
    for (const item of rawModels) {
      if (typeof item === 'string' && item.trim()) {
        out.push({ externalId: item.trim(), displayName: item.trim() });
      } else if (isObjectRecord(item)) {
        const id =
          typeof item.id === 'string'
            ? item.id
            : typeof item.value === 'string'
              ? item.value
              : typeof item.modelId === 'string'
                ? item.modelId
                : typeof item.name === 'string'
                  ? item.name
                  : '';
        if (!id.trim()) continue;
        const label =
          typeof item.label === 'string'
            ? item.label
            : typeof item.name === 'string'
              ? item.name
              : typeof item.displayName === 'string'
                ? item.displayName
                : id;
        out.push({ externalId: id.trim(), displayName: label.trim() });
      }
    }
    return out;
  }
  if (isObjectRecord(rawModels) && Array.isArray(rawModels.availableModels)) {
    return extractAvailableModelOptions(rawModels.availableModels);
  }
  return [];
}
