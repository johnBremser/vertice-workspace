import type {
  ConversationProjection,
  EscalationDecision,
  PermissionRequest,
  SharedContextRevision,
  Task,
} from './types';

export function getLatestContextRevision(
  projection: ConversationProjection,
): SharedContextRevision | undefined {
  if (projection.contextRevisions.length === 0) return undefined;
  return projection.contextRevisions[projection.contextRevisions.length - 1];
}

export function getPendingPermissions(
  projection: ConversationProjection,
): PermissionRequest[] {
  return projection.permissions.filter((p) => p.status === 'pending');
}

export function getPendingEscalations(
  projection: ConversationProjection,
): EscalationDecision[] {
  return projection.escalations.filter((e) => e.status === 'suggested');
}

export function isTaskUsingStaleContext(
  task: Task,
  latestRevision: SharedContextRevision | undefined,
): boolean {
  if (!latestRevision || !task.activeContextRevisionId) return false;
  return task.activeContextRevisionId !== latestRevision.id;
}

export function getTaskSummaryCounts(tasks: Task[]): {
  total: number;
  completed: number;
  active: number;
  qualityRejections: number;
  operationalFailures: number;
} {
  let completed = 0;
  let active = 0;
  let qualityRejections = 0;
  let operationalFailures = 0;

  for (const task of tasks) {
    if (task.status === 'completed') completed += 1;
    if (
      task.status === 'running' ||
      task.status === 'queued' ||
      task.status === 'awaiting_review' ||
      task.status === 'changes_requested'
    ) {
      active += 1;
    }
    qualityRejections += task.qualityRejectionCount;
    operationalFailures += task.operationalFailureCount;
  }

  return {
    total: tasks.length,
    completed,
    active,
    qualityRejections,
    operationalFailures,
  };
}
