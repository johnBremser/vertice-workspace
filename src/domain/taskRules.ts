import type {
  ConversationToolApprovalPolicy,
  Participant,
  PermissionRequest,
  Task,
} from './types';

export interface TaskValidationResult {
  valid: boolean;
  errors: string[];
}

export function detectTaskCycle(
  tasks: Task[],
  candidateTaskId: string,
  candidateDependencyIds: string[],
): string[] | null {
  const adj = new Map<string, string[]>();
  for (const t of tasks) {
    adj.set(
      t.id,
      t.id === candidateTaskId ? [...candidateDependencyIds] : [...t.dependencyTaskIds],
    );
  }
  if (!adj.has(candidateTaskId)) {
    adj.set(candidateTaskId, [...candidateDependencyIds]);
  }

  const visited = new Set<string>();
  const stack = new Set<string>();
  const path: string[] = [];

  const dfs = (nodeId: string): string[] | null => {
    visited.add(nodeId);
    stack.add(nodeId);
    path.push(nodeId);

    for (const depId of adj.get(nodeId) ?? []) {
      if (depId === candidateTaskId && stack.has(depId)) {
        return [...path, depId];
      }
      if (!visited.has(depId)) {
        const res = dfs(depId);
        if (res) return res;
      } else if (stack.has(depId)) {
        return [...path, depId];
      }
    }

    path.pop();
    stack.delete(nodeId);
    return null;
  };

  return dfs(candidateTaskId);
}

export function validateTaskInput(input: {
  taskId: string;
  title: string;
  assigneeParticipantId: string;
  reviewerParticipantId?: string;
  dependencyTaskIds: string[];
  acceptanceCriteria: string[];
  existingTasks: Task[];
  participants: Participant[];
}): TaskValidationResult {
  const errors: string[] = [];
  if (!input.title.trim()) {
    errors.push('Informe um título para a tarefa.');
  }

  const activeParticipants = input.participants.filter((p) => !p.archived);
  if (!activeParticipants.some((p) => p.id === input.assigneeParticipantId)) {
    errors.push('Executor atribuído não está ativo nesta conversa.');
  }
  if (
    input.reviewerParticipantId &&
    !activeParticipants.some((p) => p.id === input.reviewerParticipantId)
  ) {
    errors.push('Auditor/Revisor atribuído não está ativo nesta conversa.');
  }

  const existingIds = new Set(input.existingTasks.map((t) => t.id));
  for (const depId of input.dependencyTaskIds) {
    if (depId === input.taskId) {
      errors.push('Uma tarefa não pode depender de si mesma.');
      continue;
    }
    if (!existingIds.has(depId)) {
      errors.push(`Dependência inexistente informada: ${depId}.`);
    }
  }

  if (errors.length === 0 && input.dependencyTaskIds.length > 0) {
    const cycle = detectTaskCycle(
      input.existingTasks,
      input.taskId,
      input.dependencyTaskIds,
    );
    if (cycle) {
      errors.push(
        `Ciclo detectado nas dependências entre tarefas (${cycle.join(' → ')}).`,
      );
    }
  }

  if (input.acceptanceCriteria.filter((c) => c.trim()).length === 0) {
    errors.push('Informe pelo menos um critério de aceitação para a tarefa.');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

export function areTaskDependenciesSatisfied(
  task: Task,
  allTasks: Task[],
): { satisfied: boolean; pendingDependencies: Task[] } {
  if (task.dependencyTaskIds.length === 0) {
    return { satisfied: true, pendingDependencies: [] };
  }
  const byId = new Map(allTasks.map((t) => [t.id, t]));
  const pendingDependencies: Task[] = [];
  for (const depId of task.dependencyTaskIds) {
    const dep = byId.get(depId);
    if (!dep || dep.status !== 'completed') {
      if (dep) pendingDependencies.push(dep);
    }
  }
  return {
    satisfied: pendingDependencies.length === 0 && task.dependencyTaskIds.every((id) => byId.get(id)?.status === 'completed'),
    pendingDependencies,
  };
}

/**
 * Checks whether a denied permission request is STILL blocking execution.
 * A later approval supersedes an earlier denial ONLY when:
 * 1) `later.supersedesRequestId === denied.id`, OR
 * 2) Same participant + same `actionKey` + same `scopeKey`, and if the denial
 *    was tied to a task, same `taskId`.
 * Approving an unrelated action for the same participant NEVER unblocks a
 * previous denial!
 */
export function isPermissionStillBlocked(permissions: PermissionRequest[]): {
  blocked: boolean;
  blockingRequest?: PermissionRequest;
  pendingRequest?: PermissionRequest;
} {
  const pendingRequest = permissions.find((p) => p.status === 'pending');
  if (pendingRequest) {
    return { blocked: true, pendingRequest };
  }

  for (let i = 0; i < permissions.length; i += 1) {
    const req = permissions[i];
    if (req.status !== 'denied') continue;

    const laterApprovals = permissions.slice(i + 1);
    const superseded = laterApprovals.some((later) => {
      if (later.status !== 'approved') return false;
      if (later.supersedesRequestId && later.supersedesRequestId === req.id) {
        return true;
      }
      if (later.participantId !== req.participantId) return false;
      if (later.actionKey !== req.actionKey) return false;
      if (later.scopeKey !== req.scopeKey) return false;
      if (req.taskId && later.taskId && req.taskId !== later.taskId) {
        return false;
      }
      return true;
    });

    if (!superseded) {
      return { blocked: true, blockingRequest: req };
    }
  }

  return { blocked: false };
}

export type ToolPermissionKind = 'read' | 'edit' | 'execute';

const EXECUTE_INDICATORS_RE =
  /(?:^|[\s:_-])(execute|exec|shell|bash|powershell|pwsh|cmd|terminal|run_command|run|delete|remove|rm|rmdir|unlink|mv|chmod|chown)(?:$|[\s:_-])/i;
const READ_KIND_RE =
  /^(read|read_file|view|view_file|list|list_dir|search|grep|find|glob|ls|inspect|fetch|cat)$/i;
const EDIT_KIND_RE =
  /^(edit|edit_file|write|write_file|create|create_file|patch|update|modify|replace_in_file|multi_edit|apply_patch)$/i;

/**
 * Classifies an ACP tool permission request into read / edit / execute.
 * Always fails closed to `'execute'` when ambiguous or unknown.
 */
export function classifyToolPermissionKind(
  actionKey: string,
  actionTitle: string,
  commandPreview: string,
): ToolPermissionKind {
  const key = actionKey.trim();
  const preview = commandPreview.trim();
  const title = actionTitle.trim();

  if (
    EXECUTE_INDICATORS_RE.test(key) ||
    EXECUTE_INDICATORS_RE.test(title) ||
    /(?:^|\s)(rm\s+-|del\s+|rmdir\s+|remove-item\b|chmod\b|powershell\b|bash\s+-c|cmd\s+\/c)/i.test(
      preview,
    )
  ) {
    return 'execute';
  }

  if (READ_KIND_RE.test(key)) {
    return 'read';
  }

  if (EDIT_KIND_RE.test(key)) {
    if (/(^|[\\/])\.\.([\\/]|$)/.test(preview)) {
      return 'execute';
    }
    return 'edit';
  }

  return 'execute';
}

/**
 * Extracts candidate target file/directory paths from an ACP permission payload.
 */
export function extractPermissionTargetPaths(
  rawInput: unknown,
  toolCall?: Record<string, unknown>,
  permInner?: Record<string, unknown>,
): string[] {
  const candidates: string[] = [];
  const pushString = (val: unknown) => {
    if (typeof val === 'string') {
      const trimmed = val.trim();
      if (trimmed) candidates.push(trimmed);
    }
  };

  if (rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput)) {
    const inputRec = rawInput as Record<string, unknown>;
    for (const key of [
      'path',
      'file_path',
      'filePath',
      'target_path',
      'targetPath',
      'file',
      'filename',
      'directory',
      'dir',
      'cwd',
    ]) {
      pushString(inputRec[key]);
    }
    for (const arrKey of ['paths', 'files']) {
      const arr = inputRec[arrKey];
      if (Array.isArray(arr)) {
        for (const item of arr) pushString(item);
      }
    }
    if (Array.isArray(inputRec.edits)) {
      for (const edit of inputRec.edits) {
        if (edit && typeof edit === 'object') {
          const editRec = edit as Record<string, unknown>;
          pushString(editRec.path ?? editRec.file_path ?? editRec.filePath);
        }
      }
    }
  }

  if (toolCall && Array.isArray(toolCall.locations)) {
    for (const loc of toolCall.locations) {
      if (loc && typeof loc === 'object') {
        const locRec = loc as Record<string, unknown>;
        pushString(locRec.path);
        if (typeof locRec.uri === 'string') {
          const uri = locRec.uri.trim();
          if (uri.toLowerCase().startsWith('file:///')) {
            const stripped = decodeURIComponent(uri.slice('file:///'.length));
            pushString(/^[a-zA-Z]:/.test(stripped) ? stripped : `/${stripped}`);
          }
        }
      }
    }
  }

  if (permInner) {
    pushString(permInner.path ?? permInner.file_path ?? permInner.filePath);
  }

  return Array.from(new Set(candidates));
}

function normalizePosixOrWinSegments(
  rawPath: string,
): { root: string; segments: string[]; isWindowsDrive: boolean } | null {
  if (!rawPath || rawPath.includes('\0')) return null;
  const slash = rawPath.trim().replaceAll('\\', '/');
  if (!slash || slash.startsWith('~') || /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(slash)) {
    return null;
  }

  const driveMatch = slash.match(/^([a-zA-Z]:)(?:\/(.*))?$/);
  if (driveMatch) {
    const root = `${driveMatch[1].toUpperCase()}/`;
    const rest = (driveMatch[2] ?? '').split('/').filter(Boolean);
    const segments: string[] = [];
    for (const seg of rest) {
      if (seg === '.') continue;
      if (seg === '..') {
        if (segments.length === 0) return null;
        segments.pop();
      } else {
        segments.push(seg);
      }
    }
    return { root, segments, isWindowsDrive: true };
  }

  if (slash.startsWith('/')) {
    const rest = slash.split('/').filter(Boolean);
    const segments: string[] = [];
    for (const seg of rest) {
      if (seg === '.') continue;
      if (seg === '..') {
        if (segments.length === 0) return null;
        segments.pop();
      } else {
        segments.push(seg);
      }
    }
    return { root: '/', segments, isWindowsDrive: false };
  }

  return null;
}

/**
 * Verifies whether a candidate target path stays strictly inside `workspaceRoot`.
 */
export function isTargetPathWithinWorkspace(
  targetPath: string,
  workspaceRoot: string,
): boolean {
  const rootNorm = normalizePosixOrWinSegments(workspaceRoot);
  if (!rootNorm) return false;

  const trimmed = targetPath.trim().replaceAll('\\', '/');
  if (!trimmed || trimmed.includes('\0') || trimmed.startsWith('~')) {
    return false;
  }
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) {
    return false;
  }

  const isAbsoluteTarget =
    trimmed.startsWith('/') || /^[a-zA-Z]:(?:\/|$)/.test(trimmed);

  let targetNorm: { root: string; segments: string[]; isWindowsDrive: boolean } | null;
  if (!isAbsoluteTarget) {
    const relSegments = [...rootNorm.segments];
    for (const seg of trimmed.split('/').filter(Boolean)) {
      if (seg === '.') continue;
      if (seg === '..') {
        if (relSegments.length <= rootNorm.segments.length) {
          return false;
        }
        relSegments.pop();
      } else {
        relSegments.push(seg);
      }
    }
    targetNorm = {
      root: rootNorm.root,
      segments: relSegments,
      isWindowsDrive: rootNorm.isWindowsDrive,
    };
  } else {
    targetNorm = normalizePosixOrWinSegments(trimmed);
  }

  if (!targetNorm) return false;
  if (targetNorm.root !== rootNorm.root) return false;
  if (targetNorm.segments.length < rootNorm.segments.length) return false;

  const caseInsensitive = rootNorm.isWindowsDrive;
  for (let i = 0; i < rootNorm.segments.length; i += 1) {
    const a = rootNorm.segments[i];
    const b = targetNorm.segments[i];
    if (caseInsensitive ? a.toLowerCase() !== b.toLowerCase() : a !== b) {
      return false;
    }
  }
  return true;
}

/**
 * Determines whether a classified tool permission may be auto-approved under
 * the active conversation tool-approval policy.
 */
export function shouldAutoApprovePermission(
  policy: ConversationToolApprovalPolicy | undefined,
  kind: ToolPermissionKind,
  options?: { workspaceVerified?: boolean },
): boolean {
  if (!policy || policy === 'manual') {
    return false;
  }
  if (policy === 'allow_read_edit') {
    return (kind === 'read' || kind === 'edit') && options?.workspaceVerified === true;
  }
  return policy === 'allow_all_in_conversation';
}

/**
 * Checks whether an earlier unresolved denial prevents automatic approval for
 * this participant/action/scope/task.
 */
export function hasBlockingDenialForAutoApproval(
  permissions: PermissionRequest[],
  participantId: string,
  actionKey: string,
  scopeKey: string,
  taskId?: string,
): boolean {
  const overall = isPermissionStillBlocked(permissions);
  if (overall.pendingRequest) {
    return true;
  }
  if (overall.blockingRequest) {
    const b = overall.blockingRequest;
    if (
      (b.participantId === participantId && b.actionKey === actionKey) ||
      b.scopeKey === scopeKey ||
      (taskId && b.taskId === taskId && b.participantId === participantId)
    ) {
      return true;
    }
  }

  for (let i = 0; i < permissions.length; i += 1) {
    const req = permissions[i];
    if (req.status !== 'denied') continue;
    const matchesTarget =
      req.scopeKey === scopeKey ||
      (req.participantId === participantId && req.actionKey === actionKey) ||
      (taskId && req.taskId === taskId && req.participantId === participantId);
    if (!matchesTarget) continue;

    const laterApprovals = permissions.slice(i + 1);
    const superseded = laterApprovals.some((later) => {
      if (later.status !== 'approved') return false;
      if (later.supersedesRequestId && later.supersedesRequestId === req.id) {
        return true;
      }
      return (
        later.participantId === req.participantId &&
        later.actionKey === req.actionKey &&
        later.scopeKey === req.scopeKey &&
        (!req.taskId || !later.taskId || req.taskId === later.taskId)
      );
    });
    if (!superseded) {
      return true;
    }
  }

  return false;
}
