import { ArrowUpRight } from 'lucide-react';
import type { EscalationDecision, Participant } from '../domain/types';
import { PT_BR } from '../i18n/ptBR';

interface EscalationBannerProps {
  escalation: EscalationDecision;
  participant?: Participant;
  onApprove: (escalationId: string) => void;
  onDismiss: (escalationId: string) => void;
}

export function EscalationBanner({
  escalation,
  participant,
  onApprove,
  onDismiss,
}: EscalationBannerProps) {
  if (escalation.status !== 'suggested') return null;

  const fromLabel =
    escalation.fromModelRef?.displayName ??
    PT_BR.modelTierLabels[escalation.fromTier];
  const toLabel =
    escalation.toModelRef?.displayName ??
    PT_BR.modelTierLabels[escalation.toTier];

  return (
    <section
      aria-label="Sugestão de escalonamento de perfil"
      className="rounded-lg border border-[var(--border-strong)] bg-[var(--bg-surface)] p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-xs font-semibold text-[var(--accent)]">
          <ArrowUpRight className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span>Escalonamento sugerido pela política de qualidade</span>
        </div>
        <span className="tabular-nums text-xs text-[var(--text-secondary)]">
          {participant?.displayName ?? escalation.participantId} · {fromLabel} → {toLabel}
        </span>
      </div>

      <p className="mt-2 text-xs leading-relaxed text-[var(--text-primary)]">
        <strong>Motivo:</strong> {escalation.reason}
      </p>
      <p className="mt-1 text-xs leading-relaxed text-[var(--text-secondary)]">
        <strong>Efeito esperado:</strong> {escalation.expectedEffect}
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => onApprove(escalation.id)}
          className="whitespace-nowrap rounded-md bg-[var(--accent)] px-3 py-1.5 text-xs font-medium text-[var(--accent-contrast)] transition-colors hover:bg-[var(--accent-hover)]"
        >
          Aprovar promoção para {toLabel}
        </button>
        <button
          type="button"
          onClick={() => onDismiss(escalation.id)}
          className="whitespace-nowrap rounded-md border border-[var(--border-strong)] bg-[var(--bg-elevated)] px-3 py-1.5 text-xs font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-subtle)]"
        >
          {PT_BR.actions.dismiss}
        </button>
      </div>
    </section>
  );
}
