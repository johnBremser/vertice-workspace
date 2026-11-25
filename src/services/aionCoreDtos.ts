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
  | 'online'
  | 'offline'
  | 'missing'
  | 'unchecked'
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
  CONFIRMATION_REMOVE: 'confirmation.remove',
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

export interface ExtractedCoreModelOption {
  externalId: string;
  displayName: string;
  reasoningEfforts?: string[];
  reasoningOptionId?: string;
}

export interface ExtractedReasoningConfig {
  optionId: string;
  currentValue?: string;
  options: string[];
}

function normalizeStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    const trimmed = entry.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

/**
 * Surfaces Cursor-style bracketed capability tags (e.g. `[context=256k,reasoning_effort=high,fast=true]`)
 * cleanly in the model label when the Core `label` omits them.
 */
export function formatBracketedModelDisplayName(
  externalId: string,
  baseLabel: string,
): string {
  const cleanLabel = baseLabel.trim();
  const match = externalId.match(/\[([^\]]*)\]$/);
  if (!match) return cleanLabel || externalId;
  const rawTags = match[1]?.trim();
  if (!rawTags) return cleanLabel || externalId;

  const kvPairs = rawTags
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  const badges: string[] = [];
  let hasThinkingTrue = false;
  let hasExplicitEffort = false;

  for (const pair of kvPairs) {
    const eqIdx = pair.indexOf('=');
    if (eqIdx <= 0) continue;
    const key = pair.slice(0, eqIdx).trim().toLowerCase();
    const val = pair.slice(eqIdx + 1).trim();
    if (!val) continue;

    if (
      key === 'reasoning_effort' ||
      key === 'effort' ||
      key === 'reasoning' ||
      key === 'thought_level'
    ) {
      hasExplicitEffort = true;
      badges.push(`raciocínio: ${val}`);
    } else if (key === 'thinking' && val.toLowerCase() === 'true') {
      hasThinkingTrue = true;
    } else if (key === 'fast' && val.toLowerCase() === 'true') {
      badges.push('fast');
    } else if (key === 'context') {
      badges.push(val);
    } else if (key === 'optimize_for') {
      badges.push(val);
    }
  }

  if (hasThinkingTrue && !hasExplicitEffort) {
    badges.unshift('thinking');
  } else if (hasThinkingTrue) {
    badges.push('thinking');
  }

  if (badges.length === 0) return cleanLabel || externalId;
  const lowerLabel = cleanLabel.toLowerCase();
  if (lowerLabel.includes('(') && lowerLabel.includes(')')) {
    return cleanLabel;
  }
  return `${cleanLabel || externalId} (${badges.join(' · ')})`;
}

export function extractAvailableModelOptions(
  rawModels: unknown,
): ExtractedCoreModelOption[] {
  if (!rawModels) return [];
  if (Array.isArray(rawModels)) {
    const out: ExtractedCoreModelOption[] = [];
    const seen = new Set<string>();
    for (const item of rawModels) {
      if (typeof item === 'string' && item.trim()) {
        const id = item.trim();
        if (!seen.has(id)) {
          seen.add(id);
          out.push({
            externalId: id,
            displayName: formatBracketedModelDisplayName(id, id),
          });
        }
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
        const cleanId = id.trim();
        const rawLabel =
          typeof item.label === 'string'
            ? item.label
            : typeof item.name === 'string'
              ? item.name
              : typeof item.displayName === 'string'
                ? item.displayName
                : cleanId;
        const reasoningEfforts = normalizeStringArray(
          item.reasoning_efforts ??
            item.reasoningEfforts ??
            item.supportedEffortLevels ??
            item.supported_effort_levels,
        );
        if (!seen.has(cleanId)) {
          seen.add(cleanId);
          out.push({
            externalId: cleanId,
            displayName: formatBracketedModelDisplayName(cleanId, rawLabel),
            ...(reasoningEfforts.length > 0
              ? { reasoningEfforts, reasoningOptionId: 'reasoning_effort' }
              : {}),
          });
        }
      }
    }
    return out;
  }
  if (isObjectRecord(rawModels)) {
    if (Array.isArray(rawModels.available_models)) {
      return extractAvailableModelOptions(rawModels.available_models);
    }
    if (Array.isArray(rawModels.availableModels)) {
      return extractAvailableModelOptions(rawModels.availableModels);
    }
    if (Array.isArray(rawModels.models)) {
      return extractAvailableModelOptions(rawModels.models);
    }
  }
  return [];
}

function normalizeConfigOptionEntries(rawConfigOptions: unknown): unknown[] {
  if (Array.isArray(rawConfigOptions)) {
    return rawConfigOptions;
  }
  if (isObjectRecord(rawConfigOptions)) {
    if (Array.isArray(rawConfigOptions.config_options)) {
      return rawConfigOptions.config_options;
    }
    if (Array.isArray(rawConfigOptions.configOptions)) {
      return rawConfigOptions.configOptions;
    }
    return [rawConfigOptions];
  }
  return [];
}

/**
 * Parses ACP `config_options` payloads (`AgentManagementRow.config_options` or WS `acp_config_option`).
 */
export function extractModelsFromConfigOptions(
  rawConfigOptions: unknown,
): ExtractedCoreModelOption[] {
  const entries = normalizeConfigOptionEntries(rawConfigOptions);
  const out: ExtractedCoreModelOption[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!isObjectRecord(entry)) continue;
    const category = typeof entry.category === 'string' ? entry.category : '';
    const id = typeof entry.id === 'string' ? entry.id : '';
    if (category !== 'model' && id !== 'model') continue;
    for (const m of extractAvailableModelOptions(entry.options)) {
      if (!seen.has(m.externalId)) {
        seen.add(m.externalId);
        out.push(m);
      }
    }
  }
  return out;
}

/**
 * Extracts reasoning / thought_level options from ACP `config_options` (used by Codex, Claude, etc.).
 */
export function extractReasoningConfigFromConfigOptions(
  rawConfigOptions: unknown,
): ExtractedReasoningConfig | null {
  const entries = normalizeConfigOptionEntries(rawConfigOptions);
  for (const entry of entries) {
    if (!isObjectRecord(entry)) continue;
    const category = typeof entry.category === 'string' ? entry.category : '';
    const id = typeof entry.id === 'string' ? entry.id : '';
    if (
      category !== 'thought_level' &&
      id !== 'reasoning_effort' &&
      id !== 'thought_level' &&
      id !== 'effort'
    ) {
      continue;
    }
    const rawOpts = Array.isArray(entry.options) ? entry.options : [];
    const options: string[] = [];
    const seen = new Set<string>();
    for (const opt of rawOpts) {
      const val =
        typeof opt === 'string'
          ? opt.trim()
          : isObjectRecord(opt) && typeof opt.value === 'string'
            ? opt.value.trim()
            : isObjectRecord(opt) && typeof opt.id === 'string'
              ? opt.id.trim()
              : '';
      if (val && !seen.has(val)) {
        seen.add(val);
        options.push(val);
      }
    }
    if (options.length === 0) continue;
    const currentRaw =
      typeof entry.currentValue === 'string'
        ? entry.currentValue.trim()
        : typeof entry.current_value === 'string'
          ? entry.current_value.trim()
          : '';
    return {
      optionId: id || 'reasoning_effort',
      currentValue: currentRaw || undefined,
      options,
    };
  }
  return null;
}
