import {
  AlertTriangle,
  CheckCircle2,
  Circle,
  Clock,
  Pencil,
  Play,
  XCircle,
} from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { isTaskUsingStaleContext } from '../../domain/selectors';
import {
  checkAuditIndependence,
  sortParticipantsByTabOrder,
} from '../../domain/teamValidation';
import type {
  Participant,
  SharedContextRevision,
  Task,
  TaskReview,
} from '../../domain/types';
import { PT_BR } from '../../i18n/ptBR';

interface TaskDetailCardProps {
  task: Task;
  allTasks?: Task[];
  participants: Participant[];
  latestRevision?: SharedContextRevision;
  selected: boolean;
  onRegisterReview: (
    review: Omit<TaskReview, 'id' | 'decidedAt' | 'sourceEventId'>,
  ) => Promise<void>;
  onUpdateTask?: (input: {
    taskId: string;
    title: string;
    description: string;
    assigneeParticipantId: string;
    reviewerParticipantId?: string;
    dependencyTaskIds: string[];
    acceptanceCriteria: string[];
  }) => Promise<void>;
  onDispatchTask?: (taskId: string) => Promise<void>;
  onJumpToEvent: (participantId: string, eventId: string) => void;
}

function taskStatusClass(status: Task['status']): string {
  switch (status) {
    case 'completed':
      return 'text-[var(--status-success)]';
    case 'running':
      return 'text-[var(--accent)]';
    case 'awaiting_review':
    case 'changes_requested':
    case 'blocked':
      return 'text-[var(--status-warning)]';
    case 'failed':
    case 'cancelled':
      return 'text-[var(--status-danger)]';
    default:
      return 'text-[var(--text-muted)]';
  }
}

export function TaskDetailCard({
  task,
  allTasks = [],
  participants,
  latestRevision,
  selected,
  onRegisterReview,
  onUpdateTask,
  onDispatchTask,
  onJumpToEvent,
}: TaskDetailCardProps) {
  const [rejectNote, setRejectNote] = useState('');
  const [showRejectBox, setShowRejectBox] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editTitle, setEditTitle] = useState(task.title);
  const [editDesc, setEditDesc] = useState(task.description);
  const [editAssignee, setEditAssignee] = useState(task.assigneeParticipantId);
  const [editReviewer, setEditReviewer] = useState(
    task.reviewerParticipantId ?? '',
  );
  const [editDeps, setEditDeps] = useState<string[]>(task.dependencyTaskIds);
  const [editCriteria, setEditCriteria] = useState(
    task.acceptanceCriteria.join('\n'),
  );
  const [expanded, setExpanded] = useState(
    selected ||
      task.status === 'running' ||
      task.status === 'awaiting_review' ||
      task.status === 'changes_requested',
  );

  const activeParticipants = sortParticipantsByTabOrder(participants);
  const assignee = participants.find((p) => p.id === task.assigneeParticipantId);
  const reviewer = participants.find((p) => p.id === task.reviewerParticipantId);
  const staleContext = isTaskUsingStaleContext(task, latestRevision);
  const latestAttempt = task.attempts[task.attempts.length - 1];
  const auditCheck = checkAuditIndependence(participants, task);

  const handleSaveEdit = async (e: FormEvent) => {
    e.preventDefault();
    if (!onUpdateTask || !editTitle.trim()) return;
    await onUpdateTask({
      taskId: task.id,
      title: editTitle.trim(),
      description: editDesc.trim(),
      assigneeParticipantId: editAssignee,
      reviewerParticipantId: editReviewer || undefined,
      dependencyTaskIds: editDeps,
      acceptanceCriteria: editCriteria
        .split('\n')
        .map((c) => c.trim())
        .filter(Boolean),
    });
    setEditing(false);
  };

  const StatusIcon =
    task.status === 'completed'
      ? CheckCircle2
      : task.status === 'failed' || task.status === 'cancelled'
        ? XCircle
        : task.status === 'running' || task.status === 'awaiting_review'
          ? Clock
          : Circle;

  return (
    <article
      className={`py-3.5 transition-colors ${
        selected
          ? '-mx-2 rounded-lg border border-[var(--border-strong)] bg-[var(--accent-soft)] px-2.5'
          : ''
      }`}
    >
      <div className="grid grid-cols-[18px_minmax(0,1fr)] gap-2.5">
        <StatusIcon
          className={`mt-0.5 h-4 w-4 shrink-0 ${taskStatusClass(task.status)}`}
          aria-hidden="true"
        />

        <div className="min-w-0">
          <div className="flex items-start justify-between gap-2">
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="min-w-0 flex-1 text-left"
            >
              <h3 className="text-[13px] font-semibold leading-snug text-[var(--text-primary)]">
                {task.title}
              </h3>
              <div className="mt-1 flex flex-wrap items-center gap-x-1.5 text-[11px] text-[var(--text-muted)]">
                <span>{assignee?.displayName ?? task.assigneeParticipantId}</span>
                {reviewer && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span>Revisor: {reviewer.displayName}</span>
                  </>
                )}
              </div>
              <div
                className={`mt-0.5 text-[11px] font-medium ${taskStatusClass(
                  task.status,
                )}`}
              >
                {PT_BR.taskStatusLabels[task.status]}
              </div>
            </button>

            {onUpdateTask && (
              <button
                type="button"
                onClick={() => {
                  setEditTitle(task.title);
                  setEditDesc(task.description);
                  setEditAssignee(task.assigneeParticipantId);
                  setEditReviewer(task.reviewerParticipantId ?? '');
                  setEditDeps(task.dependencyTaskIds);
                  setEditCriteria(task.acceptanceCriteria.join('\n'));
                  setEditing((s) => !s);
                  setExpanded(true);
                }}
                aria-label={`Editar tarefa ${task.title}`}
                className="rounded p-1 text-[var(--text-muted)] hover:bg-[var(--bg-elevated)] hover:text-[var(--text-primary)]"
              >
                <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            )}
          </div>

          {editing && (
            <form
              onSubmit={(e) => void handleSaveEdit(e)}
              className="mt-2.5 space-y-2 rounded-md border border-[var(--border-strong)] bg-[var(--bg-surface)] p-2.5 text-xs"
            >
              <input
                type="text"
                value={editTitle}
                onChange={(e) => setEditTitle(e.target.value)}
                className="w-full rounded border border-[var(--border-strong)] bg-[var(--bg-canvas)] px-2 py-1 text-xs text-[var(--text-primary)]"
              />
              <textarea
                rows={2}
                value={editDesc}
                onChange={(e) => setEditDesc(e.target.value)}
                className="w-full rounded border border-[var(--border-strong)] bg-[var(--bg-canvas)] px-2 py-1 text-xs text-[var(--text-primary)]"
              />
              <div className="grid grid-cols-1 gap-2">
                <select
                  value={editAssignee}
                  onChange={(e) => setEditAssignee(e.target.value)}
                  className="rounded border border-[var(--border-strong)] bg-[var(--bg-canvas)] px-2 py-1 text-xs text-[var(--text-primary)]"
                >
                  {activeParticipants.map((p) => (
                    <option key={p.id} value={p.id}>
                      Resp.: {p.displayName}
                    </option>
                  ))}
                </select>
                <select
                  value={editReviewer}
                  onChange={(e) => setEditReviewer(e.target.value)}
                  className="rounded border border-[var(--border-strong)] bg-[var(--bg-canvas)] px-2 py-1 text-xs text-[var(--text-primary)]"
                >
                  <option value="">Sem auditor</option>
                  {activeParticipants.map((p) => (
                    <option key={p.id} value={p.id}>
                      Auditor: {p.displayName}
                    </option>
                  ))}
                </select>
              </div>
              {allTasks.filter((other) => other.id !== task.id).length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {allTasks
                    .filter((other) => other.id !== task.id)
                    .map((other) => (
                      <label
                        key={other.id}
                        className="inline-flex items-center gap-1 text-[11px]"
                      >
                        <input
                          type="checkbox"
                          checked={editDeps.includes(other.id)}
                          onChange={(e) =>
                            setEditDeps((prev) =>
                              e.target.checked
                                ? [...prev, other.id]
                                : prev.filter((id) => id !== other.id),
                            )
                          }
                        />
                        <span>Dep.: {other.title}</span>
                      </label>
                    ))}
                </div>
              )}
              <textarea
                rows={2}
                value={editCriteria}
                onChange={(e) => setEditCriteria(e.target.value)}
                className="w-full rounded border border-[var(--border-strong)] bg-[var(--bg-canvas)] px-2 py-1 text-xs text-[var(--text-primary)]"
              />
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setEditing(false)}
                  className="rounded border border-[var(--border-hairline)] px-2 py-1 text-xs text-[var(--text-secondary)]"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  className="rounded bg-[var(--accent)] px-2 py-1 text-xs font-semibold text-[var(--accent-contrast)]"
                >
                  Salvar alterações
                </button>
              </div>
            </form>
          )}

          {(expanded || selected) && !editing && (
            <div className="mt-2.5 space-y-2.5 text-xs">
              <p className="leading-relaxed text-[var(--text-secondary)]">
                {task.description}
              </p>

              {reviewer && !auditCheck.independent && (
                <div className="rounded-md border border-[var(--status-warning)]/40 bg-[var(--status-warning-soft)] px-2.5 py-1.5 text-[11px] text-[var(--status-warning)]">
                  Parecer combinado: {auditCheck.reason}
                </div>
              )}

              <div className="flex flex-wrap items-center gap-2 text-[11px] text-[var(--text-secondary)] tabular-nums">
                <span>
                  Reprovações:{' '}
                  <strong className="text-[var(--status-warning)]">
                    {task.qualityRejectionCount}
                  </strong>
                </span>
                <span aria-hidden="true">·</span>
                <span>
                  Falhas operacionais:{' '}
                  <strong className="text-[var(--status-danger)]">
                    {task.operationalFailureCount}
                  </strong>
                </span>
              </div>

              {staleContext && latestRevision && (
                <div className="flex items-start gap-2 rounded-md bg-[var(--status-warning-soft)] px-2.5 py-2 text-[11px] text-[var(--status-warning)]">
                  <AlertTriangle
                    className="mt-0.5 h-3.5 w-3.5 shrink-0"
                    aria-hidden="true"
                  />
                  <span>
                    Contexto v{latestRevision.versionNumber} pendente para a
                    próxima tentativa.
                  </span>
                </div>
              )}

              {task.dependencyTaskIds.length > 0 && (
                <p className="text-[11px] text-[var(--text-muted)]">
                  Dependências:{' '}
                  <span className="font-mono">
                    {task.dependencyTaskIds.join(', ')}
                  </span>
                </p>
              )}

              <div>
                <div className="text-[11px] font-medium text-[var(--text-primary)]">
                  Critérios de aceitação
                </div>
                <ul className="mt-1 space-y-1 text-[11px] text-[var(--text-secondary)]">
                  {task.acceptanceCriteria.map((c, idx) => (
                    <li key={idx} className="flex items-start gap-1.5">
                      <span aria-hidden="true">•</span>
                      <span>{c}</span>
                    </li>
                  ))}
                </ul>
              </div>

              {task.attempts.length > 0 && (
                <div className="space-y-1.5">
                  <div className="text-[11px] font-medium text-[var(--text-primary)]">
                    Tentativas ({task.attempts.length})
                  </div>
                  {task.attempts.map((att) => (
                    <div
                      key={att.id}
                      className="rounded-md border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2.5 py-2 text-[11px]"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-1">
                        <span className="tabular-nums font-medium text-[var(--text-primary)]">
                          Tentativa #{att.attemptNumber} · Contexto v
                          {att.contextRevisionNumber}
                        </span>
                        <span className="text-[var(--text-muted)]">
                          {att.modelRefUsed?.displayName ??
                            PT_BR.modelTierLabels[att.modelTierUsed]}
                        </span>
                      </div>
                      {att.deliverySummary && (
                        <p className="mt-1 text-[var(--text-secondary)]">
                          {att.deliverySummary}
                        </p>
                      )}
                      <div className="mt-1 flex items-center justify-between text-[var(--text-muted)]">
                        <span>{att.status}</span>
                        {att.sourceEventIds[0] && (
                          <button
                            type="button"
                            onClick={() =>
                              onJumpToEvent(
                                att.executorParticipantId,
                                att.sourceEventIds[0],
                              )
                            }
                            className="font-medium text-[var(--accent)] hover:underline"
                          >
                            Ver execução
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {task.reviews.length > 0 && (
                <div className="space-y-1.5">
                  <div className="text-[11px] font-medium text-[var(--text-primary)]">
                    Revisões ({task.reviews.length})
                  </div>
                  {task.reviews.map((rev) => (
                    <div
                      key={rev.id}
                      className="rounded-md border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2.5 py-1.5 text-[11px]"
                    >
                      <strong
                        className={
                          rev.decision === 'approved'
                            ? 'text-[var(--status-success)]'
                            : 'text-[var(--status-warning)]'
                        }
                      >
                        {rev.decision === 'approved' ? 'Aprovada' : 'Reprovada'}
                      </strong>
                      <p className="mt-0.5 text-[var(--text-secondary)]">
                        {rev.rationale}
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {onDispatchTask &&
            task.status !== 'completed' &&
            task.status !== 'cancelled' && (
              <div className="mt-2.5 flex flex-wrap items-center gap-2 border-t border-[var(--border-hairline)] pt-2">
                <button
                  type="button"
                  onClick={() => void onDispatchTask(task.id)}
                  className="inline-flex items-center gap-1 rounded border border-[var(--border-strong)] bg-[var(--bg-surface)] px-2.5 py-1 text-xs font-medium text-[var(--accent)] hover:bg-[var(--bg-elevated)]"
                >
                  <Play className="h-3 w-3" aria-hidden="true" />
                  <span>
                    {task.status === 'awaiting_review'
                      ? 'Solicitar auditoria no Core'
                      : 'Despachar / Retomar no Core'}
                  </span>
                </button>
              </div>
            )}

          {task.status === 'awaiting_review' && latestAttempt && reviewer && (
            <div className="mt-2.5 border-t border-[var(--border-hairline)] pt-2">
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() =>
                    void onRegisterReview({
                      taskId: task.id,
                      attemptId: latestAttempt.id,
                      reviewerParticipantId: reviewer.id,
                      decision: 'approved',
                      rationale:
                        'Aprovado manualmente após inspeção no painel de trabalho.',
                      unmetCriteria: [],
                    })
                  }
                  className="rounded bg-[var(--accent)] px-2.5 py-1 text-xs font-semibold text-[var(--accent-contrast)] hover:bg-[var(--accent-hover)]"
                >
                  Aprovar entrega
                </button>
                <button
                  type="button"
                  onClick={() => setShowRejectBox((s) => !s)}
                  className="rounded border border-[var(--border-strong)] bg-[var(--bg-surface)] px-2.5 py-1 text-xs font-medium text-[var(--text-primary)]"
                >
                  Reprovar qualidade
                </button>
              </div>
              {showRejectBox && (
                <div className="mt-2 space-y-2">
                  <input
                    type="text"
                    value={rejectNote}
                    onChange={(e) => setRejectNote(e.target.value)}
                    placeholder="Motivo da reprovação de qualidade..."
                    className="w-full rounded border border-[var(--border-strong)] bg-[var(--bg-canvas)] px-2.5 py-1.5 text-xs text-[var(--text-primary)]"
                  />
                  <button
                    type="button"
                    disabled={!rejectNote.trim()}
                    onClick={() => {
                      void onRegisterReview({
                        taskId: task.id,
                        attemptId: latestAttempt.id,
                        reviewerParticipantId: reviewer.id,
                        decision: 'rejected',
                        rationale: rejectNote.trim(),
                        unmetCriteria: [
                          'Critério apontado manualmente pelo revisor',
                        ],
                      });
                      setRejectNote('');
                      setShowRejectBox(false);
                    }}
                    className="rounded bg-[var(--status-warning)] px-2.5 py-1 text-xs font-semibold text-white disabled:opacity-50"
                  >
                    Confirmar reprovação
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </article>
  );
}
