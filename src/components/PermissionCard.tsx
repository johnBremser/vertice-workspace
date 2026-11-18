import { ShieldAlert, Terminal } from 'lucide-react';
import type { Participant, PermissionRequest } from '../domain/types';
import { PT_BR } from '../i18n/ptBR';

interface PermissionCardProps {
  request: PermissionRequest;
  participant?: Participant;
  taskTitle?: string;
  onApprove: (requestId: string) => void;
  onDeny: (requestId: string) => void;
}

export function PermissionCard({
  request,
  participant,
  taskTitle,
  onApprove,
  onDeny,
}: PermissionCardProps) {
  const isPending = request.status === 'pending';
  const suffix = request.isSimulated ? ' (simulação)' : ' (AionCore)';

  return (
    <section
      aria-label={
        request.isSimulated
          ? 'Solicitação de permissão simulada'
          : 'Solicitação de permissão'
      }
      className="rounded-lg border border-[var(--border-strong)] bg-[var(--bg-surface)] p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-xs font-semibold text-[var(--status-warning)]">
          <ShieldAlert className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span>
            {isPending
              ? `Permissão solicitada${suffix}`
              : request.status === 'approved'
                ? `Permissão aprovada${suffix}`
                : `Permissão recusada${suffix}`}
          </span>
        </div>
        <span className="tabular-nums text-xs text-[var(--text-secondary)]">
          {participant?.displayName ?? request.participantId}
          {taskTitle ? ` · ${taskTitle}` : ''}
        </span>
      </div>

      {request.taskId && (
        <details className="mt-1 text-[11px] text-[var(--text-muted)]">
          <summary className="cursor-pointer select-none hover:text-[var(--text-secondary)]">
            Detalhes técnicos da permissão
          </summary>
          <div className="mt-0.5 flex flex-wrap gap-x-3 font-mono text-[10px] text-[var(--text-secondary)]">
            <span>req={request.id}</span>
            <span>task={request.taskId}</span>
            {request.attemptId && <span>attempt={request.attemptId}</span>}
          </div>
        </details>
      )}

      <p className="mt-2 text-sm font-medium text-[var(--text-primary)]">
        {request.actionTitle}
      </p>

      <div className="mt-2 flex items-center gap-2 rounded-md border border-[var(--border-hairline)] bg-[var(--bg-canvas)] px-3 py-2 font-mono text-xs text-[var(--text-primary)]">
        <Terminal className="h-3.5 w-3.5 shrink-0 text-[var(--text-secondary)]" aria-hidden="true" />
        <span className="truncate">{request.commandSimulated}</span>
      </div>

      <p className="mt-2 text-xs text-[var(--text-secondary)]">
        {request.scopeDescription}
      </p>

      {isPending && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => onApprove(request.id)}
            className="whitespace-nowrap rounded-md bg-[var(--accent)] px-3 py-1.5 text-xs font-medium text-[var(--accent-contrast)] transition-colors hover:bg-[var(--accent-hover)]"
          >
            {PT_BR.actions.approve}
            {request.isSimulated ? ' no escopo simulado' : ' neste escopo'}
          </button>
          <button
            type="button"
            onClick={() => onDeny(request.id)}
            className="whitespace-nowrap rounded-md border border-[var(--border-strong)] bg-[var(--bg-elevated)] px-3 py-1.5 text-xs font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-subtle)]"
          >
            {PT_BR.actions.deny}
          </button>
        </div>
      )}
    </section>
  );
}
