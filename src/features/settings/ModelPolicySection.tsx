import { useEffect, useState, type FormEvent } from 'react';
import type { DemoModelTier, ModelPolicy } from '../../domain/types';
import { PT_BR } from '../../i18n/ptBR';
import { useWorkspace } from '../workspace/WorkspaceContext';

export function ModelPolicySection() {
  const { store, updateModelPolicy } = useWorkspace();
  const [draft, setDraft] = useState<ModelPolicy | null>(null);

  useEffect(() => {
    if (store) {
      setDraft({ ...store.modelPolicy });
    }
  }, [store?.modelPolicy]);

  if (!draft) return null;

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    await updateModelPolicy(draft);
  };

  return (
    <section
      aria-labelledby="settings-policy-title"
      className="rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-5"
    >
      <div className="border-b border-[var(--border-hairline)] pb-3">
        <h2
          id="settings-policy-title"
          className="text-sm font-semibold text-[var(--text-primary)]"
        >
          Política de perfis e escalonamento por qualidade
        </h2>
        <p className="mt-1 text-xs leading-relaxed text-[var(--text-secondary)]">
          Perfis de referência para escalonamento automático (sem medições fictícias de custo, tokens ou saldo). Somente reprovações de qualidade contam para sugerir escalonamento; falhas operacionais não consomem tentativas.
        </p>
      </div>

      <form
        onSubmit={(e) => void handleSubmit(e)}
        className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2"
      >
        <div>
          <label
            htmlFor="pol-exec"
            className="block text-xs font-medium text-[var(--text-primary)]"
          >
            Perfil padrão para tarefas básicas
          </label>
          <select
            id="pol-exec"
            value={draft.defaultExecutorTier}
            onChange={(e) =>
              setDraft({
                ...draft,
                defaultExecutorTier: e.target.value as DemoModelTier,
              })
            }
            className="mt-1 w-full rounded-md border border-[var(--border-strong)] bg-[var(--bg-elevated)] px-3 py-2 text-xs text-[var(--text-primary)]"
          >
            <option value="fast">{PT_BR.modelTierLabels.fast}</option>
            <option value="review">{PT_BR.modelTierLabels.review}</option>
            <option value="advanced">{PT_BR.modelTierLabels.advanced}</option>
          </select>
        </div>

        <div>
          <label
            htmlFor="pol-rev"
            className="block text-xs font-medium text-[var(--text-primary)]"
          >
            Perfil para revisão
          </label>
          <select
            id="pol-rev"
            value={draft.reviewerTier}
            onChange={(e) =>
              setDraft({
                ...draft,
                reviewerTier: e.target.value as DemoModelTier,
              })
            }
            className="mt-1 w-full rounded-md border border-[var(--border-strong)] bg-[var(--bg-elevated)] px-3 py-2 text-xs text-[var(--text-primary)]"
          >
            <option value="review">{PT_BR.modelTierLabels.review}</option>
            <option value="advanced">{PT_BR.modelTierLabels.advanced}</option>
            <option value="fast">{PT_BR.modelTierLabels.fast}</option>
          </select>
        </div>

        <div>
          <label
            htmlFor="pol-esc"
            className="block text-xs font-medium text-[var(--text-primary)]"
          >
            Perfil avançado para escalonamento
          </label>
          <select
            id="pol-esc"
            value={draft.escalationTargetTier}
            onChange={(e) =>
              setDraft({
                ...draft,
                escalationTargetTier: e.target.value as DemoModelTier,
              })
            }
            className="mt-1 w-full rounded-md border border-[var(--border-strong)] bg-[var(--bg-elevated)] px-3 py-2 text-xs text-[var(--text-primary)]"
          >
            <option value="advanced">{PT_BR.modelTierLabels.advanced}</option>
            <option value="review">{PT_BR.modelTierLabels.review}</option>
          </select>
        </div>

        <div>
          <label
            htmlFor="pol-threshold"
            className="block text-xs font-medium text-[var(--text-primary)]"
          >
            Reprovações de qualidade antes de sugerir promoção
          </label>
          <input
            id="pol-threshold"
            type="number"
            min={1}
            max={5}
            value={draft.qualityRejectionsBeforeSuggest}
            onChange={(e) =>
              setDraft({
                ...draft,
                qualityRejectionsBeforeSuggest: Math.max(
                  1,
                  Math.min(5, Number(e.target.value) || 2),
                ),
              })
            }
            className="tabular-nums mt-1 w-full rounded-md border border-[var(--border-strong)] bg-[var(--bg-elevated)] px-3 py-2 text-xs text-[var(--text-primary)]"
          />
        </div>

        <div className="sm:col-span-2">
          <label
            htmlFor="pol-approval"
            className="block text-xs font-medium text-[var(--text-primary)]"
          >
            Política de aprovação da promoção
          </label>
          <select
            id="pol-approval"
            value={draft.approvalMode}
            onChange={(e) =>
              setDraft({
                ...draft,
                approvalMode: e.target.value as ModelPolicy['approvalMode'],
              })
            }
            className="mt-1 w-full rounded-md border border-[var(--border-strong)] bg-[var(--bg-elevated)] px-3 py-2 text-xs text-[var(--text-primary)]"
          >
            <option value="manual">
              Exigir aprovação explícita do usuário antes de promover
            </option>
            <option value="auto_policy">
              Aplicar automaticamente quando atingir o limite (registrando decisão)
            </option>
          </select>
        </div>

        <div className="sm:col-span-2">
          <div className="text-xs font-medium text-[var(--text-primary)]">
            Preferências declaradas por papel (opcional — exibidas como não verificadas até confirmação do Core)
          </div>
          <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2">
            {(
              [
                ['coordinator', PT_BR.roleLabels.coordinator],
                ['planner', PT_BR.roleLabels.planner],
                ['executor', PT_BR.roleLabels.executor],
                ['reviewer', PT_BR.roleLabels.reviewer],
              ] as const
            ).map(([roleKey, roleLabel]) => (
              <label
                key={roleKey}
                className="block text-xs text-[var(--text-secondary)]"
              >
                {roleLabel}
                <input
                  type="text"
                  value={draft.rolePreferences?.[roleKey] ?? ''}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      rolePreferences: {
                        ...(draft.rolePreferences ?? {}),
                        [roleKey]: e.target.value,
                      },
                    })
                  }
                  placeholder="Ex.: Terra 6.1, Sol 6.1, Gemini Hydrogen"
                  className="mt-1 w-full rounded-md border border-[var(--border-strong)] bg-[var(--bg-elevated)] px-2.5 py-1.5 text-xs text-[var(--text-primary)]"
                />
              </label>
            ))}
          </div>
        </div>

        <div className="sm:col-span-2 flex justify-end">
          <button
            type="submit"
            className="rounded-md bg-[var(--accent)] px-4 py-2 text-xs font-medium text-[var(--accent-contrast)] hover:bg-[var(--accent-hover)]"
          >
            Salvar política
          </button>
        </div>
      </form>
    </section>
  );
}
