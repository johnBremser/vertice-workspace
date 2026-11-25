import { Bot, Sparkles } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { useWorkspace } from '../workspace/WorkspaceContext';

export function AssistantSettingsSection() {
  const {
    assistantState,
    assistantEligibleConnections,
    configureVerticeAssistant,
    updateVerticeAssistantPreferences,
    clearVerticeAssistantHistory,
    setAssistantOpen,
    setAssistantTab,
  } = useWorkspace();

  const [connId, setConnId] = useState(
    assistantState.config?.connectionId ?? assistantEligibleConnections[0]?.id ?? '',
  );
  const [modelId, setModelId] = useState(
    assistantState.config?.modelExternalId ?? '',
  );
  const [includeDiagnostics, setIncludeDiagnostics] = useState(
    assistantState.config?.includeLiveDiagnostics ?? true,
  );
  const [includeSource, setIncludeSource] = useState(
    assistantState.config?.includeSourceContext ?? true,
  );

  useEffect(() => {
    if (assistantEligibleConnections.length === 0) return;
    const cfg = assistantState.config;
    const targetConn =
      (cfg && assistantEligibleConnections.find((c) => c.id === cfg.connectionId)) ??
      assistantEligibleConnections.find((c) => c.id === connId) ??
      assistantEligibleConnections[0];
    if (!targetConn) return;

    if (connId !== targetConn.id) {
      setConnId(targetConn.id);
    }
    const confirmed = targetConn.availableModels.filter((m) => m.confirmed);
    const targetModel =
      (cfg && confirmed.find((m) => m.externalId === cfg.modelExternalId)) ??
      confirmed.find((m) => m.externalId === modelId) ??
      confirmed[0];
    if (targetModel && modelId !== targetModel.externalId) {
      setModelId(targetModel.externalId);
    }
    if (cfg) {
      setIncludeDiagnostics(cfg.includeLiveDiagnostics);
      setIncludeSource(cfg.includeSourceContext);
    }
  }, [assistantEligibleConnections, assistantState.config]);

  const currentConn = assistantEligibleConnections.find((c) => c.id === connId);
  const models = (currentConn?.availableModels ?? []).filter((m) => m.confirmed);
  const hasConfig = Boolean(assistantState.config?.connectionId);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!currentConn || !modelId) return;
    const model = models.find((m) => m.externalId === modelId);
    await configureVerticeAssistant({
      connectionId: currentConn.id,
      modelExternalId: modelId,
      modelDisplayName: model?.displayName ?? modelId,
      includeLiveDiagnostics: includeDiagnostics,
      includeSourceContext: includeSource,
    });
  };

  return (
    <section
      aria-labelledby="settings-assistant-title"
      className="rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-5"
    >
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-[var(--border-hairline)] pb-3">
        <div>
          <div className="flex items-center gap-2">
            <Bot className="h-4 w-4 text-[var(--accent)]" aria-hidden="true" />
            <h2
              id="settings-assistant-title"
              className="text-sm font-semibold text-[var(--text-primary)]"
            >
              Assistente Flutuante &amp; Base de Conhecimento
            </h2>
          </div>
          <p className="mt-1 text-xs leading-relaxed text-[var(--text-secondary)]">
            Selecione um provedor conectado e modelo confirmado para atuar como chatbot especialista no Vértice (sessão isolada em modo somente leitura, com Base de Conhecimento e leitura do fonte local).
          </p>
        </div>

        <button
          type="button"
          onClick={() => {
            setAssistantTab(
              assistantEligibleConnections.length > 0 ? 'chat' : 'kb',
            );
            setAssistantOpen(true);
          }}
          className="inline-flex items-center gap-1.5 rounded-md border border-[var(--border-strong)] bg-[var(--bg-elevated)] px-3 py-1.5 text-xs font-medium text-[var(--text-primary)] hover:bg-[var(--bg-subtle)]"
        >
          <Sparkles className="h-3.5 w-3.5 text-[var(--accent)]" aria-hidden="true" />
          <span>Abrir Assistente Flutuante</span>
        </button>
      </div>

      {assistantEligibleConnections.length === 0 ? (
        <div className="mt-4 rounded-md border border-[var(--border-hairline)] bg-[var(--bg-canvas)] p-3 text-xs text-[var(--text-secondary)]">
          Nenhum provedor autenticado com modelos confirmados ainda. Conclua as etapas <strong>1 a 3</strong> acima (<code>/health</code>, login e <strong>Sincronizar catálogo</strong>) para liberar a escolha do Assistente. A Base de Conhecimento offline já pode ser consultada no botão flutuante.
        </div>
      ) : (
        <form
          onSubmit={(e) => void handleSubmit(e)}
          className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2"
        >
          <label className="block text-xs text-[var(--text-secondary)]">
            Conexão do Assistente
            <select
              value={connId}
              onChange={(e) => {
                const nextId = e.target.value;
                setConnId(nextId);
                const nextConn = assistantEligibleConnections.find(
                  (c) => c.id === nextId,
                );
                const firstModel = nextConn?.availableModels.find((m) => m.confirmed);
                setModelId(firstModel?.externalId ?? '');
              }}
              className="mt-1 w-full rounded-md border border-[var(--border-strong)] bg-[var(--bg-elevated)] px-2.5 py-2 text-xs text-[var(--text-primary)]"
            >
              {assistantEligibleConnections.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.displayName}
                </option>
              ))}
            </select>
          </label>

          <label className="block text-xs text-[var(--text-secondary)]">
            Modelo do Assistente
            <select
              value={modelId}
              onChange={(e) => setModelId(e.target.value)}
              className="mt-1 w-full rounded-md border border-[var(--border-strong)] bg-[var(--bg-elevated)] px-2.5 py-2 text-xs text-[var(--text-primary)]"
            >
              {models.map((m) => (
                <option key={m.externalId} value={m.externalId}>
                  {m.displayName}
                </option>
              ))}
            </select>
          </label>

          <div className="sm:col-span-2 flex flex-wrap gap-4 text-xs text-[var(--text-primary)]">
            <label className="inline-flex items-center gap-2">
              <input
                type="checkbox"
                checked={includeDiagnostics}
                onChange={(e) => {
                  setIncludeDiagnostics(e.target.checked);
                  if (hasConfig) {
                    updateVerticeAssistantPreferences({
                      includeLiveDiagnostics: e.target.checked,
                    });
                  }
                }}
                className="accent-[var(--accent)]"
              />
              <span>Incluir diagnóstico ao vivo (sem segredos)</span>
            </label>

            <label className="inline-flex items-center gap-2">
              <input
                type="checkbox"
                checked={includeSource}
                onChange={(e) => {
                  setIncludeSource(e.target.checked);
                  if (hasConfig) {
                    updateVerticeAssistantPreferences({
                      includeSourceContext: e.target.checked,
                    });
                  }
                }}
                className="accent-[var(--accent)]"
              />
              <span>Incluir trechos do código-fonte local (somente leitura)</span>
            </label>
          </div>

          <div className="sm:col-span-2 flex flex-wrap items-center justify-between gap-2 pt-1">
            <span className="text-[11px] text-[var(--text-muted)]">
              {assistantState.config
                ? `Ativo: ${assistantState.config.modelDisplayName}${assistantState.config.externalTeamId ? ` (team=${assistantState.config.externalTeamId})` : ''}`
                : 'Nenhum modelo selecionado como Assistente ainda.'}
            </span>

            <div className="flex items-center gap-2">
              {assistantState.messages.length > 0 && (
                <button
                  type="button"
                  onClick={() => void clearVerticeAssistantHistory()}
                  className="rounded-md border border-[var(--border-hairline)] bg-[var(--bg-canvas)] px-3 py-1.5 text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                >
                  Limpar histórico
                </button>
              )}
              <button
                type="submit"
                disabled={!connId || !modelId || assistantState.status === 'configuring'}
                className="rounded-md bg-[var(--accent)] px-3.5 py-1.5 text-xs font-semibold text-[var(--accent-contrast)] hover:bg-[var(--accent-hover)] disabled:opacity-50"
              >
                {assistantState.status === 'configuring'
                  ? 'Configurando...'
                  : hasConfig
                    ? 'Atualizar Assistente'
                    : 'Selecionar como Assistente'}
              </button>
            </div>
          </div>
        </form>
      )}
    </section>
  );
}
