import { useState, type FormEvent } from 'react';
import type { SharedContextRevision } from '../../domain/types';

interface ContextRevisionFormProps {
  latestRevision?: SharedContextRevision;
  onPublish: (input: {
    summaryOfChange: string;
    objective: string;
    permanentInstructions: string[];
    constraints: string[];
    acceptanceCriteria: string[];
    confirmedDecisions: string[];
  }) => Promise<void>;
  onCancel: () => void;
}

function splitLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

export function ContextRevisionForm({
  latestRevision,
  onPublish,
  onCancel,
}: ContextRevisionFormProps) {
  const [summaryOfChange, setSummaryOfChange] = useState('');
  const [objective, setObjective] = useState(
    latestRevision?.objective ??
      'Adicionar uma busca por nome em uma listagem, preservando a estrutura existente.',
  );
  const [instructionsText, setInstructionsText] = useState(
    (latestRevision?.permanentInstructions ?? []).join('\n'),
  );
  const [constraintsText, setConstraintsText] = useState(
    (latestRevision?.constraints ?? []).join('\n'),
  );
  const [criteriaText, setCriteriaText] = useState(
    (latestRevision?.acceptanceCriteria ?? []).join('\n'),
  );
  const [decisionsText, setDecisionsText] = useState(
    (latestRevision?.confirmedDecisions ?? []).join('\n'),
  );

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    await onPublish({
      summaryOfChange:
        summaryOfChange.trim() || 'Atualização de contexto compartilhado',
      objective: objective.trim(),
      permanentInstructions: splitLines(instructionsText),
      constraints: splitLines(constraintsText),
      acceptanceCriteria: splitLines(criteriaText),
      confirmedDecisions: splitLines(decisionsText),
    });
    onCancel();
  };

  return (
    <form
      onSubmit={(e) => void handleSubmit(e)}
      className="space-y-3 rounded-lg border border-[var(--border-strong)] bg-[var(--bg-elevated)] p-3"
    >
      <div className="text-xs font-semibold text-[var(--text-primary)]">
        Publicar nova revisão imutável (v{(latestRevision?.versionNumber ?? 0) + 1})
      </div>

      <div>
        <label
          htmlFor="ctx-summary"
          className="block text-xs font-medium text-[var(--text-secondary)]"
        >
          Resumo da alteração
        </label>
        <input
          id="ctx-summary"
          type="text"
          required
          value={summaryOfChange}
          onChange={(e) => setSummaryOfChange(e.target.value)}
          placeholder="Ex.: Nova restrição de cobertura de testes"
          className="mt-1 w-full rounded border border-[var(--border-strong)] bg-[var(--bg-canvas)] px-2.5 py-1.5 text-xs text-[var(--text-primary)]"
        />
      </div>

      <div>
        <label
          htmlFor="ctx-objective"
          className="block text-xs font-medium text-[var(--text-secondary)]"
        >
          Objetivo do projeto/conversa
        </label>
        <textarea
          id="ctx-objective"
          rows={2}
          value={objective}
          onChange={(e) => setObjective(e.target.value)}
          className="mt-1 w-full rounded border border-[var(--border-strong)] bg-[var(--bg-canvas)] px-2.5 py-1.5 text-xs text-[var(--text-primary)]"
        />
      </div>

      <div>
        <label
          htmlFor="ctx-constraints"
          className="block text-xs font-medium text-[var(--text-secondary)]"
        >
          Restrições (uma por linha)
        </label>
        <textarea
          id="ctx-constraints"
          rows={3}
          value={constraintsText}
          onChange={(e) => setConstraintsText(e.target.value)}
          className="mt-1 w-full rounded border border-[var(--border-strong)] bg-[var(--bg-canvas)] px-2.5 py-1.5 text-xs text-[var(--text-primary)]"
        />
      </div>

      <div>
        <label
          htmlFor="ctx-criteria"
          className="block text-xs font-medium text-[var(--text-secondary)]"
        >
          Critérios de aceitação (um por linha)
        </label>
        <textarea
          id="ctx-criteria"
          rows={3}
          value={criteriaText}
          onChange={(e) => setCriteriaText(e.target.value)}
          className="mt-1 w-full rounded border border-[var(--border-strong)] bg-[var(--bg-canvas)] px-2.5 py-1.5 text-xs text-[var(--text-primary)]"
        />
      </div>

      <div>
        <label
          htmlFor="ctx-instructions"
          className="block text-xs font-medium text-[var(--text-secondary)]"
        >
          Instruções permanentes (uma por linha)
        </label>
        <textarea
          id="ctx-instructions"
          rows={2}
          value={instructionsText}
          onChange={(e) => setInstructionsText(e.target.value)}
          className="mt-1 w-full rounded border border-[var(--border-strong)] bg-[var(--bg-canvas)] px-2.5 py-1.5 text-xs text-[var(--text-primary)]"
        />
      </div>

      <div>
        <label
          htmlFor="ctx-decisions"
          className="block text-xs font-medium text-[var(--text-secondary)]"
        >
          Decisões confirmadas (uma por linha)
        </label>
        <textarea
          id="ctx-decisions"
          rows={2}
          value={decisionsText}
          onChange={(e) => setDecisionsText(e.target.value)}
          className="mt-1 w-full rounded border border-[var(--border-strong)] bg-[var(--bg-canvas)] px-2.5 py-1.5 text-xs text-[var(--text-primary)]"
        />
      </div>

      <div className="flex justify-end gap-2 pt-1">
        <button
          type="button"
          onClick={onCancel}
          className="rounded border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-3 py-1.5 text-xs text-[var(--text-primary)]"
        >
          Cancelar
        </button>
        <button
          type="submit"
          className="rounded bg-[var(--accent)] px-3 py-1.5 text-xs font-medium text-[var(--accent-contrast)] hover:bg-[var(--accent-hover)]"
        >
          Publicar revisão
        </button>
      </div>
    </form>
  );
}
