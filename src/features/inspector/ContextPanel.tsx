import { FileCheck2, Info, Plus } from 'lucide-react';
import { useState } from 'react';
import { EmptyState } from '../../components/EmptyState';
import type { ContextReceiptStatus } from '../../domain/types';
import { PT_BR } from '../../i18n/ptBR';
import { useWorkspace } from '../workspace/WorkspaceContext';
import { ContextRevisionForm } from './ContextRevisionForm';

function receiptColorClass(status: ContextReceiptStatus): string {
  switch (status) {
    case 'applied':
      return 'text-[var(--status-success)]';
    case 'received':
    case 'sent':
      return 'text-[var(--accent)]';
    case 'failed_needs_action':
      return 'text-[var(--status-danger)]';
    default:
      return 'text-[var(--status-warning)]';
  }
}

export function ContextPanel() {
  const { activeConversation, publishContextRevision } = useWorkspace();
  const [editing, setEditing] = useState(false);
  const [selectedRevId, setSelectedRevId] = useState<string | null>(null);

  if (!activeConversation) return null;

  const revisions = activeConversation.contextRevisions;
  const latestRev = revisions[revisions.length - 1];
  const inspectedRev =
    revisions.find((r) => r.id === selectedRevId) ?? latestRev;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <div className="text-xs text-[var(--text-muted)]">
          {revisions.length > 0
            ? `${revisions.length} revisão(ões)`
            : 'Sem revisões publicadas'}
        </div>
        {!editing && (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="inline-flex h-8 items-center gap-1 rounded-md bg-[var(--accent)] px-2.5 text-xs font-semibold text-[var(--accent-contrast)] hover:bg-[var(--accent-hover)]"
          >
            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
            <span>Nova revisão</span>
          </button>
        )}
      </div>

      {editing && (
        <ContextRevisionForm
          latestRevision={latestRev}
          onPublish={publishContextRevision}
          onCancel={() => setEditing(false)}
        />
      )}

      {!inspectedRev ? (
        <EmptyState
          icon={<FileCheck2 className="h-6 w-6" />}
          title="Nenhuma revisão de contexto"
          description="Publique uma revisão com objetivo, restrições e critérios para acompanhar entrega e aplicação por participante."
        />
      ) : (
        <>
          {revisions.length > 1 && (
            <div className="flex flex-wrap gap-1.5">
              {revisions.map((rev) => {
                const isSelected = rev.id === inspectedRev.id;
                return (
                  <button
                    key={rev.id}
                    type="button"
                    onClick={() => setSelectedRevId(rev.id)}
                    className={`tabular-nums rounded border px-2.5 py-1 text-xs font-medium ${isSelected
                        ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]'
                        : 'border-[var(--border-hairline)] bg-[var(--bg-surface)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                      }`}
                  >
                    v{rev.versionNumber}
                  </button>
                );
              })}
            </div>
          )}

          <div className="space-y-3 border-b border-[var(--border-hairline)] pb-4 text-xs">
            <div className="flex items-center justify-between gap-2">
              <span className="tabular-nums font-semibold text-[var(--text-primary)]">
                Revisão v{inspectedRev.versionNumber}{' '}
                {inspectedRev.id === latestRev?.id ? '(Atual)' : '(Histórico)'}
              </span>
              <details className="text-right text-[10px] text-[var(--text-muted)]">
                <summary className="cursor-pointer select-none hover:text-[var(--text-secondary)]">
                  ID técnico
                </summary>
                <span className="font-mono text-[10px] text-[var(--text-secondary)]">
                  {inspectedRev.id}
                </span>
              </details>
            </div>

            <div className="text-[var(--text-secondary)]">
              <strong className="font-medium text-[var(--text-primary)]">
                Alteração:
              </strong>{' '}
              {inspectedRev.summaryOfChange}
              <div className="mt-0.5 text-[11px] text-[var(--text-muted)]">
                Por {inspectedRev.authorLabel} ·{' '}
                {new Date(inspectedRev.createdAt).toLocaleTimeString('pt-BR')}
              </div>
            </div>

            <div>
              <div className="text-[11px] font-semibold text-[var(--text-primary)]">
                Objetivo
              </div>
              <p className="mt-0.5 leading-relaxed text-[var(--text-secondary)]">
                {inspectedRev.objective}
              </p>
            </div>

            {inspectedRev.constraints.length > 0 && (
              <div>
                <div className="text-[11px] font-semibold text-[var(--text-primary)]">
                  Restrições
                </div>
                <ul className="mt-1 space-y-1 text-[var(--text-secondary)]">
                  {inspectedRev.constraints.map((c, idx) => (
                    <li key={idx}>• {c}</li>
                  ))}
                </ul>
              </div>
            )}

            {inspectedRev.acceptanceCriteria.length > 0 && (
              <div>
                <div className="text-[11px] font-semibold text-[var(--text-primary)]">
                  Critérios de aceitação
                </div>
                <ul className="mt-1 space-y-1 text-[var(--text-secondary)]">
                  {inspectedRev.acceptanceCriteria.map((a, idx) => (
                    <li key={idx}>• {a}</li>
                  ))}
                </ul>
              </div>
            )}

            {inspectedRev.permanentInstructions.length > 0 && (
              <div>
                <div className="text-[11px] font-semibold text-[var(--text-primary)]">
                  Instruções permanentes
                </div>
                <ul className="mt-1 space-y-1 text-[var(--text-secondary)]">
                  {inspectedRev.permanentInstructions.map((i, idx) => (
                    <li key={idx}>• {i}</li>
                  ))}
                </ul>
              </div>
            )}

            {inspectedRev.confirmedDecisions.length > 0 && (
              <div>
                <div className="text-[11px] font-semibold text-[var(--text-primary)]">
                  Decisões confirmadas
                </div>
                <ul className="mt-1 space-y-1 text-[var(--text-secondary)]">
                  {inspectedRev.confirmedDecisions.map((d, idx) => (
                    <li key={idx}>• {d}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          <div className="space-y-2.5 text-xs">
            <div className="text-[11px] font-semibold tracking-wider text-[var(--text-muted)] uppercase">
              Recibos por participante (v{inspectedRev.versionNumber})
            </div>

            <div className="divide-y divide-[var(--border-hairline)]">
              {activeConversation.participants.map((p) => {
                const receipt = inspectedRev.receipts[p.id];
                const status = receipt?.status ?? 'pending_send';
                return (
                  <div key={p.id} className="py-2 first:pt-0 last:pb-0">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium text-[var(--text-primary)]">
                        {p.displayName}
                      </span>
                      <span
                        className={`text-[11px] font-medium ${receiptColorClass(
                          status,
                        )}`}
                      >
                        {PT_BR.receiptStatusLabels[status]}
                      </span>
                    </div>
                    {receipt && (
                      <p className="mt-0.5 text-[11px] leading-relaxed text-[var(--text-muted)]">
                        {receipt.mechanismNote}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>

            <div className="flex items-start gap-2 rounded-md bg-[var(--bg-elevated)] p-2.5 text-[11px] leading-relaxed text-[var(--text-muted)]">
              <Info
                className="mt-0.5 h-3.5 w-3.5 shrink-0"
                aria-hidden="true"
              />
              <span>{PT_BR.receiptHonestyNote}</span>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
