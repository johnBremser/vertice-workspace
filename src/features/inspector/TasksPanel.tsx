import { ListTodo, Plus, ScrollText } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { EmptyState } from '../../components/EmptyState';
import { getLatestContextRevision } from '../../domain/selectors';
import { sortParticipantsByTabOrder } from '../../domain/teamValidation';
import { useWorkspace } from '../workspace/WorkspaceContext';
import { TaskDetailCard } from './TaskDetailCard';

export function TasksPanel() {
  const {
    activeConversation,
    selectedTaskId,
    createTask,
    updateTask,
    publishPlanRevision,
    registerTaskReview,
    navigateToOrigin,
  } = useWorkspace();

  const [showCreateForm, setShowCreateForm] = useState(false);
  const [showPlanForm, setShowPlanForm] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [assigneeId, setAssigneeId] = useState('');
  const [reviewerId, setReviewerId] = useState('');
  const [dependencyIds, setDependencyIds] = useState<string[]>([]);
  const [criteriaText, setCriteriaText] = useState(
    'Entregar implementação alinhada ao contexto compartilhado.',
  );
  const [planSummary, setPlanSummary] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  if (!activeConversation) return null;

  const { tasks, participants, planRevisions } = activeConversation;
  const activeParticipants = sortParticipantsByTabOrder(participants);
  const latestRev = getLatestContextRevision(activeConversation);

  const defaultAssigneeId =
    assigneeId ||
    activeParticipants.find((p) => p.roles.includes('executor'))?.id ||
    activeParticipants[0]?.id ||
    '';

  const handleCreateSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setFormError(null);
    if (!title.trim() || !defaultAssigneeId) {
      setFormError('Informe título e responsável.');
      return;
    }
    const criteria = criteriaText
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    try {
      await createTask({
        title: title.trim(),
        description: description.trim() || 'Tarefa registrada manualmente.',
        assigneeParticipantId: defaultAssigneeId,
        reviewerParticipantId: reviewerId || undefined,
        dependencyTaskIds: dependencyIds,
        acceptanceCriteria:
          criteria.length > 0
            ? criteria
            : ['Validar entrega contra critérios da conversa.'],
      });
      setTitle('');
      setDescription('');
      setDependencyIds([]);
      setShowCreateForm(false);
    } catch (err) {
      setFormError(
        err instanceof Error ? err.message : 'Falha ao criar tarefa.',
      );
    }
  };

  const handlePlanSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!planSummary.trim()) return;
    await publishPlanRevision(planSummary.trim());
    setPlanSummary('');
    setShowPlanForm(false);
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => {
            setShowCreateForm((s) => !s);
            setShowPlanForm(false);
          }}
          className="inline-flex h-8 items-center gap-1 rounded-md bg-[var(--accent)] px-2.5 text-xs font-semibold text-[var(--accent-contrast)] hover:bg-[var(--accent-hover)]"
        >
          <Plus className="h-3.5 w-3.5" aria-hidden="true" />
          <span>Nova tarefa</span>
        </button>

        <button
          type="button"
          onClick={() => {
            setShowPlanForm((s) => !s);
            setShowCreateForm(false);
          }}
          className="inline-flex h-8 items-center gap-1 rounded-md border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2.5 text-xs font-medium text-[var(--text-secondary)] hover:border-[var(--border-strong)] hover:text-[var(--text-primary)]"
        >
          <ScrollText className="h-3.5 w-3.5" aria-hidden="true" />
          <span>Revisão de plano</span>
        </button>
      </div>

      {showCreateForm && (
        <form
          onSubmit={(e) => void handleCreateSubmit(e)}
          className="space-y-2.5 rounded-lg border border-[var(--border-strong)] bg-[var(--bg-surface)] p-3 text-xs"
        >
          <div className="font-semibold text-[var(--text-primary)]">
            Criar tarefa na conversa
          </div>
          <div>
            <label className="block text-[var(--text-secondary)]">
              Título
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Ex.: Validar exportação CSV"
                className="mt-1 w-full rounded border border-[var(--border-strong)] bg-[var(--bg-canvas)] px-2.5 py-1.5 text-xs text-[var(--text-primary)]"
              />
            </label>
          </div>
          <div>
            <label className="block text-[var(--text-secondary)]">
              Descrição
              <textarea
                rows={2}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                className="mt-1 w-full rounded border border-[var(--border-strong)] bg-[var(--bg-canvas)] px-2.5 py-1.5 text-xs text-[var(--text-primary)]"
              />
            </label>
          </div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <label className="block text-[var(--text-secondary)]">
              Responsável
              <select
                value={defaultAssigneeId}
                onChange={(e) => setAssigneeId(e.target.value)}
                className="mt-1 w-full rounded border border-[var(--border-strong)] bg-[var(--bg-canvas)] px-2 py-1.5 text-xs text-[var(--text-primary)]"
              >
                {activeParticipants.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.displayName}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-[var(--text-secondary)]">
              Auditor / Revisor (opcional)
              <select
                value={reviewerId}
                onChange={(e) => setReviewerId(e.target.value)}
                className="mt-1 w-full rounded border border-[var(--border-strong)] bg-[var(--bg-canvas)] px-2 py-1.5 text-xs text-[var(--text-primary)]"
              >
                <option value="">Sem auditor definido</option>
                {activeParticipants.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.displayName}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {tasks.length > 0 && (
            <div>
              <span className="block text-[var(--text-secondary)]">
                Dependências
              </span>
              <div className="mt-1 flex flex-wrap gap-2">
                {tasks.map((t) => (
                  <label
                    key={t.id}
                    className="inline-flex items-center gap-1 text-[11px] text-[var(--text-primary)]"
                  >
                    <input
                      type="checkbox"
                      checked={dependencyIds.includes(t.id)}
                      onChange={(e) =>
                        setDependencyIds((prev) =>
                          e.target.checked
                            ? [...prev, t.id]
                            : prev.filter((id) => id !== t.id),
                        )
                      }
                    />
                    <span>{t.title}</span>
                  </label>
                ))}
              </div>
            </div>
          )}
          <div>
            <label className="block text-[var(--text-secondary)]">
              Critérios de aceitação (um por linha)
              <textarea
                rows={2}
                value={criteriaText}
                onChange={(e) => setCriteriaText(e.target.value)}
                className="mt-1 w-full rounded border border-[var(--border-strong)] bg-[var(--bg-canvas)] px-2.5 py-1.5 text-xs text-[var(--text-primary)]"
              />
            </label>
          </div>
          {formError && (
            <p className="text-xs text-[var(--status-danger)]">{formError}</p>
          )}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setShowCreateForm(false)}
              className="rounded border border-[var(--border-hairline)] px-2.5 py-1 text-xs text-[var(--text-secondary)]"
            >
              Cancelar
            </button>
            <button
              type="submit"
              className="rounded bg-[var(--accent)] px-2.5 py-1 text-xs font-semibold text-[var(--accent-contrast)]"
            >
              Criar tarefa
            </button>
          </div>
        </form>
      )}

      {showPlanForm && (
        <form
          onSubmit={(e) => void handlePlanSubmit(e)}
          className="space-y-2 rounded-lg border border-[var(--border-strong)] bg-[var(--bg-surface)] p-3 text-xs"
        >
          <label className="block font-medium text-[var(--text-primary)]">
            Resumo da revisão do plano de trabalho
            <textarea
              rows={2}
              value={planSummary}
              onChange={(e) => setPlanSummary(e.target.value)}
              placeholder="Ex.: Quebra em etapas de API, interface e auditoria independente."
              className="mt-1 w-full rounded border border-[var(--border-strong)] bg-[var(--bg-canvas)] px-2.5 py-1.5 text-xs text-[var(--text-primary)]"
            />
          </label>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setShowPlanForm(false)}
              className="rounded border border-[var(--border-hairline)] px-2.5 py-1 text-xs text-[var(--text-secondary)]"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={!planSummary.trim()}
              className="rounded bg-[var(--accent)] px-2.5 py-1 text-xs font-semibold text-[var(--accent-contrast)] disabled:opacity-50"
            >
              Publicar plano
            </button>
          </div>
        </form>
      )}

      {planRevisions.length > 0 && (
        <div className="border-b border-[var(--border-hairline)] pb-3 text-xs">
          <div className="text-[11px] font-semibold tracking-wider text-[var(--text-muted)] uppercase">
            Revisões de plano ({planRevisions.length})
          </div>
          <ul className="mt-1.5 space-y-1 text-[var(--text-secondary)]">
            {planRevisions
              .slice()
              .reverse()
              .slice(0, 3)
              .map((plan) => (
                <li key={plan.id} className="leading-snug">
                  <strong className="font-medium text-[var(--text-primary)]">
                    Plano #{plan.versionNumber}
                  </strong>{' '}
                  · {plan.authorLabel}: {plan.summary}
                </li>
              ))}
          </ul>
        </div>
      )}

      {tasks.length === 0 ? (
        <EmptyState
          icon={<ListTodo className="h-6 w-6" />}
          title="Nenhuma tarefa vinculada"
          description="Envie um pedido na Geral, crie uma tarefa acima ou avance o fluxo configurável para visualizar delegações, critérios e tentativas."
        />
      ) : (
        <div className="divide-y divide-[var(--border-hairline)]">
          {tasks.map((task) => (
            <TaskDetailCard
              key={task.id}
              task={task}
              allTasks={tasks}
              participants={participants}
              latestRevision={latestRev}
              selected={selectedTaskId === task.id}
              onRegisterReview={registerTaskReview}
              onUpdateTask={updateTask}
              onJumpToEvent={(tabId, eventId) =>
                navigateToOrigin({ tabId, eventId })
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}
