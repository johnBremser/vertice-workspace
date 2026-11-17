import type { Participant, PermissionRequest, Task } from './types';

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
