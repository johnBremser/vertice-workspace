import {
  ArrowLeft,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  Info,
  Palette,
  Server,
} from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { APP_BRAND } from '../../config/brand';
import { PT_BR } from '../../i18n/ptBR';
import { useWorkspace } from '../workspace/WorkspaceContext';
import { AgentCatalogSection } from './AgentCatalogSection';
import { ModelPolicySection } from './ModelPolicySection';
import { ParticipantsSection } from './ParticipantsSection';

export function SettingsView() {
  const {
    store,
    activeConversation,
    setMainSurface,
    themePreference,
    setThemePreference,
    setExecutionMode,
    updateCoreSettings,
    hasCoreOperations,
    coreCheckHealth,
    coreCheckAuthStatus,
    coreLogin,
    coreLogout,
    coreRefreshCatalog,
    coreSyncTeams,
    coreCreateTeamForActiveConversation,
    coreConnectWs,
    coreDisconnectWs,
    coreGetDiagnostics,
  } = useWorkspace();

  const [baseUrl, setBaseUrl] = useState(store?.coreSettings.baseUrl ?? '');
  const [workspacePath, setWorkspacePath] = useState(
    store?.coreSettings.workspacePath ?? '',
  );
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showDiagnostics, setShowDiagnostics] = useState(false);

  useEffect(() => {
    if (store?.coreSettings) {
      setBaseUrl(store.coreSettings.baseUrl);
      setWorkspacePath(store.coreSettings.workspacePath);
    }
  }, [store?.coreSettings]);

  const mode = store?.executionMode ?? 'demo';
  const diagnostics = hasCoreOperations ? coreGetDiagnostics() : [];

  const coreConnections = (store?.connections ?? []).filter(
    (c) => c.mode === 'aion_core',
  );
  const isCoreModeActive = mode === 'aion_core';
  const hasReachableCore =
    isCoreModeActive &&
    (store?.coreRuntimeStatus === 'reachable' ||
      coreConnections.some((c) => c.coreReachability === 'reachable'));
  const hasConfirmedCatalogModels =
    isCoreModeActive &&
    coreConnections.some(
      (c) => c.catalogLoaded && c.availableModels.some((m) => m.confirmed),
    );
  const hasUnreachableError =
    isCoreModeActive &&
    (store?.coreRuntimeStatus === 'unreachable' ||
      coreConnections.some((c) => c.coreReachability === 'unreachable'));
  const catalogSyncedEmpty =
    isCoreModeActive &&
    coreConnections.some((c) => c.catalogLoaded) &&
    !hasConfirmedCatalogModels;
  const hasMissingExecutables =
    isCoreModeActive &&
    coreConnections.some((c) => c.catalogLoaded && c.executableStatus === 'verified') === false &&
    coreConnections.some((c) => c.catalogLoaded && c.executableStatus === 'missing');

  const setupSteps = [
    {
      id: 'health',
      label: '1. Conectar runtime local',
      done: hasReachableCore,
      detail: 'Confirma que o AionCore local responde nesta sessão.',
    },
    {
      id: 'auth',
      label: '2. Autenticar sessão local',
      done: isCoreModeActive && Boolean(store?.coreSessionAuthenticated),
      detail: 'Sessão WebUI confirmada no navegador (sem credenciais salvas).',
    },
    {
      id: 'catalog',
      label: '3. Verificar agentes e modelos',
      done: hasConfirmedCatalogModels,
      detail: 'Identifica assistentes e modelos realmente disponíveis no Core.',
    },
    {
      id: 'team',
      label: '4. Escolher workspace e criar equipe',
      done:
        isCoreModeActive &&
        Boolean(store?.coreSettings.workspacePath.trim()) &&
        Boolean(
          activeConversation?.conversation.executionMode === 'aion_core' &&
          activeConversation.conversation.externalTeamId,
        ),
      detail: 'Vincula a pasta local e os papéis dos participantes no Core.',
    },
    {
      id: 'first_order',
      label: '5. Enviar primeiro pedido',
      done: Boolean(
        isCoreModeActive &&
        activeConversation &&
        activeConversation.conversation.executionMode === 'aion_core' &&
        activeConversation.conversation.externalTeamId &&
        activeConversation.generalFeed.some((g) => g.kind === 'user_request'),
      ),
      detail: 'Inicia coordenação real a partir da aba Geral.',
    },
  ];

  const nextPendingStep = setupSteps.find((s) => !s.done);

  const handleSaveCoreSettings = async (e: FormEvent) => {
    e.preventDefault();
    await updateCoreSettings({
      baseUrl: baseUrl.trim(),
      workspacePath: workspacePath.trim(),
      authMode: store?.coreSettings.authMode ?? 'cookie_or_bearer',
    });
  };

  const handleLogin = async (e: FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !password) return;
    const u = username.trim();
    const p = password;
    setUsername('');
    setPassword('');
    await coreLogin(u, p);
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-[var(--bg-canvas)] px-4 py-6 sm:px-8">
      <div className="mx-auto max-w-4xl space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border-hairline)] pb-4">
          <div>
            <h2 className="text-lg font-semibold tracking-tight text-[var(--text-primary)]">
              Configurações e runtime
            </h2>
            <p className="mt-1 text-xs text-[var(--text-secondary)]">
              Conexão com AionCore, equipe configurável por conversa, política de qualidade, aparência e atribuição técnica.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setMainSurface('conversation')}
            className="inline-flex h-9 items-center gap-1.5 rounded-md border border-[var(--border-strong)] bg-[var(--bg-surface)] px-3.5 text-xs font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-elevated)]"
          >
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
            <span>{PT_BR.actions.backToWorkspace}</span>
          </button>
        </div>

        {/* 1. Runtime & Connection */}
        <section
          aria-labelledby="settings-mode-title"
          className="rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-5"
        >
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="max-w-xl">
              <h3
                id="settings-mode-title"
                className="text-sm font-semibold text-[var(--text-primary)]"
              >
                Modo de operação do workspace
              </h3>
              <p className="mt-1 text-xs leading-relaxed text-[var(--text-secondary)]">
                No modo Demonstração, eventos e timers são determinísticos no navegador. No modo AionCore local, toda simulação é desativada e nenhuma operação recorre silenciosamente ao modo demo.
              </p>
            </div>
            <select
              aria-label="Modo de operação"
              value={mode}
              onChange={(e) =>
                void setExecutionMode(
                  e.target.value as 'demo' | 'aion_core',
                )
              }
              className="rounded-md border border-[var(--border-strong)] bg-[var(--bg-elevated)] px-3 py-2 text-xs text-[var(--text-primary)]"
            >
              <option value="demo">Simulação determinística local</option>
              <option value="aion_core">Modo AionCore local (HTTP + WS)</option>
            </select>
          </div>

          {(mode === 'aion_core' || hasCoreOperations) && (
            <div className="mt-5 border-t border-[var(--border-hairline)] pt-5">
              <div className="flex items-center gap-2">
                <Server
                  className="h-4 w-4 text-[var(--accent)]"
                  aria-hidden="true"
                />
                <h4
                  id="settings-core-title"
                  className="text-sm font-semibold text-[var(--text-primary)]"
                >
                  Conexão AionCore Local (WebUI v0.2.2)
                </h4>
              </div>
              <p className="mt-1 text-xs text-[var(--text-secondary)]">
                Credenciais e cookies nunca são salvos em IndexedDB, localStorage ou exportações.
              </p>

              {/* V5-06.1 Guided Onboarding Checklist (live-derived, never faked) */}
              <div className="mt-4 rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-canvas)] p-3.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-xs font-semibold text-[var(--text-primary)]">
                    Preparação guiada para operação real
                  </span>
                  <span className="tabular-nums text-[11px] text-[var(--text-muted)]">
                    {setupSteps.filter((s) => s.done).length}/{setupSteps.length} etapas confirmadas
                  </span>
                </div>
                <p className="mt-1 text-[11px] text-[var(--text-muted)]">
                  Sinais ao vivo (/health, sessão e catálogo) são revalidados automaticamente ao recarregar neste modo, sem custo de modelo.
                </p>
                <ol className="mt-2.5 grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {setupSteps.map((step) => (
                    <li
                      key={step.id}
                      className="flex items-start gap-2 text-xs"
                    >
                      {step.done ? (
                        <CheckCircle2
                          className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--status-success)]"
                          aria-hidden="true"
                        />
                      ) : (
                        <Circle
                          className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]"
                          aria-hidden="true"
                        />
                      )}
                      <div className="min-w-0">
                        <div
                          className={
                            step.done
                              ? 'font-medium text-[var(--text-primary)]'
                              : 'text-[var(--text-secondary)]'
                          }
                        >
                          {step.label}
                        </div>
                        <div className="text-[11px] text-[var(--text-muted)]">
                          {step.detail}
                        </div>
                      </div>
                    </li>
                  ))}
                </ol>

                {/* Objective next-step & empty/error/no-agent guidance */}
                <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-[var(--border-hairline)] pt-2.5 text-xs">
                  {hasUnreachableError ? (
                    <span className="text-[var(--status-danger)]">
                      Runtime local inacessível no endereço configurado. Inicie o AionCore ou teste o endereço com <strong>Verificar /health</strong>.
                    </span>
                  ) : catalogSyncedEmpty || hasMissingExecutables ? (
                    <span className="text-[var(--status-warning)]">
                      Nenhum agente ou modelo confirmado foi encontrado no catálogo atual. Verifique os CLIs locais (<code>aioncore doctor</code> / login do provedor) ou altere acima para o <strong>Modo Demonstração (simulação)</strong>.
                    </span>
                  ) : nextPendingStep ? (
                    <span className="text-[var(--text-secondary)]">
                      <strong className="font-medium text-[var(--text-primary)]">
                        Próximo passo:
                      </strong>{' '}
                      {nextPendingStep.label} — {nextPendingStep.detail}
                    </span>
                  ) : (
                    <span className="font-medium text-[var(--status-success)]">
                      Todas as 5 etapas reais confirmadas nesta sessão.
                    </span>
                  )}

                  {isCoreModeActive && nextPendingStep && (
                    <div className="flex flex-wrap items-center gap-2">
                      {nextPendingStep.id === 'health' && (
                        <button
                          type="button"
                          onClick={() => void coreCheckHealth()}
                          className="rounded-md bg-[var(--accent)] px-2.5 py-1 text-[11px] font-semibold text-[var(--accent-contrast)] hover:bg-[var(--accent-hover)]"
                        >
                          Verificar /health agora
                        </button>
                      )}
                      {nextPendingStep.id === 'auth' && (
                        <button
                          type="button"
                          onClick={() => void coreCheckAuthStatus()}
                          className="rounded-md border border-[var(--border-strong)] bg-[var(--bg-surface)] px-2.5 py-1 text-[11px] font-medium text-[var(--text-primary)] hover:bg-[var(--bg-elevated)]"
                        >
                          Checar sessão (/api/auth/status)
                        </button>
                      )}
                      {nextPendingStep.id === 'catalog' && (
                        <button
                          type="button"
                          onClick={() => void coreRefreshCatalog()}
                          className="rounded-md bg-[var(--accent)] px-2.5 py-1 text-[11px] font-semibold text-[var(--accent-contrast)] hover:bg-[var(--accent-hover)]"
                        >
                          Sincronizar catálogo agora
                        </button>
                      )}
                      {nextPendingStep.id === 'team' && (
                        <button
                          type="button"
                          disabled={!activeConversation}
                          onClick={() => void coreCreateTeamForActiveConversation()}
                          className="rounded-md bg-[var(--accent)] px-2.5 py-1 text-[11px] font-semibold text-[var(--accent-contrast)] hover:bg-[var(--accent-hover)] disabled:opacity-50"
                        >
                          Criar time no Core
                        </button>
                      )}
                      {nextPendingStep.id === 'first_order' && (
                        <button
                          type="button"
                          onClick={() => setMainSurface('conversation')}
                          className="rounded-md bg-[var(--accent)] px-2.5 py-1 text-[11px] font-semibold text-[var(--accent-contrast)] hover:bg-[var(--accent-hover)]"
                        >
                          Ir para a conversa
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </div>

              {/* V5-05.4 Browser Tab Close Policy */}
              <p className="mt-3 rounded-md border border-[var(--border-hairline)] bg-[var(--bg-elevated)] px-3 py-2 text-[11px] leading-relaxed text-[var(--text-secondary)]">
                <strong className="font-semibold text-[var(--text-primary)]">
                  Política ao fechar a aba (v1):
                </strong>{' '}
                o {APP_BRAND.name} não roda como serviço em segundo plano no navegador. Fechar todas as abas interrompe novas coordenações pela UI; ao reabrir, o histórico e tarefas já aceitas pelo Core são reconstruídos por catch-up sem reenviar pedidos concluídos.
              </p>

              <form
                onSubmit={(e) => void handleSaveCoreSettings(e)}
                className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2"
              >
                <label className="block text-xs font-medium text-[var(--text-primary)]">
                  Base URL do AionCore (opcional se mesma origem/proxy)
                  <input
                    type="text"
                    value={baseUrl}
                    onChange={(e) => setBaseUrl(e.target.value)}
                    placeholder="Ex.: http://127.0.0.1:25808 ou vazio para proxy"
                    className="mt-1 w-full rounded-md border border-[var(--border-strong)] bg-[var(--bg-elevated)] px-3 py-2 font-mono text-xs text-[var(--text-primary)]"
                  />
                </label>

                <label className="block text-xs font-medium text-[var(--text-primary)]">
                  Caminho de workspace no Core
                  <input
                    type="text"
                    value={workspacePath}
                    onChange={(e) => setWorkspacePath(e.target.value)}
                    placeholder="Ex.: C:/projetos/meu-app"
                    className="mt-1 w-full rounded-md border border-[var(--border-strong)] bg-[var(--bg-elevated)] px-3 py-2 font-mono text-xs text-[var(--text-primary)]"
                  />
                </label>

                <div className="sm:col-span-2 flex flex-wrap items-center gap-2 pt-1">
                  <button
                    type="submit"
                    className="rounded-md bg-[var(--accent)] px-3.5 py-2 text-xs font-semibold text-[var(--accent-contrast)] hover:bg-[var(--accent-hover)]"
                  >
                    Salvar endereço do Core
                  </button>
                  <button
                    type="button"
                    onClick={() => void coreCheckHealth()}
                    className="rounded-md border border-[var(--border-strong)] bg-[var(--bg-elevated)] px-3 py-2 text-xs font-medium text-[var(--text-primary)] hover:bg-[var(--bg-subtle)]"
                  >
                    Verificar /health
                  </button>
                  <button
                    type="button"
                    onClick={() => void coreCheckAuthStatus()}
                    className="rounded-md border border-[var(--border-strong)] bg-[var(--bg-elevated)] px-3 py-2 text-xs font-medium text-[var(--text-primary)] hover:bg-[var(--bg-subtle)]"
                  >
                    Verificar autenticação
                  </button>
                  <button
                    type="button"
                    onClick={() => void coreRefreshCatalog()}
                    className="rounded-md border border-[var(--border-strong)] bg-[var(--bg-elevated)] px-3 py-2 text-xs font-medium text-[var(--text-primary)] hover:bg-[var(--bg-subtle)]"
                  >
                    Sincronizar catálogo
                  </button>
                  <button
                    type="button"
                    onClick={() => void coreSyncTeams()}
                    className="rounded-md border border-[var(--border-strong)] bg-[var(--bg-elevated)] px-3 py-2 text-xs font-medium text-[var(--text-primary)] hover:bg-[var(--bg-subtle)]"
                  >
                    Listar times (/api/teams)
                  </button>
                  <button
                    type="button"
                    onClick={() => void coreCreateTeamForActiveConversation()}
                    className="rounded-md border border-[var(--border-strong)] bg-[var(--bg-elevated)] px-3 py-2 text-xs font-medium text-[var(--text-primary)] hover:bg-[var(--bg-subtle)]"
                  >
                    Criar time da conversa no Core
                  </button>
                  <button
                    type="button"
                    onClick={() => void coreConnectWs()}
                    className="rounded-md border border-[var(--border-strong)] bg-[var(--bg-elevated)] px-3 py-2 text-xs font-medium text-[var(--text-primary)] hover:bg-[var(--bg-subtle)]"
                  >
                    Conectar WebSocket
                  </button>
                  <button
                    type="button"
                    onClick={() => coreDisconnectWs()}
                    className="rounded-md border border-[var(--border-hairline)] bg-[var(--bg-canvas)] px-3 py-2 text-xs text-[var(--text-secondary)]"
                  >
                    Desconectar WS
                  </button>
                </div>
              </form>

              <form
                onSubmit={(e) => void handleLogin(e)}
                className="mt-4 flex flex-wrap items-end gap-2 border-t border-[var(--border-hairline)] pt-4"
              >
                <label className="min-w-[160px] flex-1 text-xs text-[var(--text-secondary)]">
                  Usuário WebUI
                  <input
                    type="text"
                    autoComplete="username"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    className="mt-1 w-full rounded-md border border-[var(--border-strong)] bg-[var(--bg-elevated)] px-2.5 py-2 text-xs text-[var(--text-primary)]"
                  />
                </label>
                <label className="min-w-[160px] flex-1 text-xs text-[var(--text-secondary)]">
                  Senha (não persistida)
                  <input
                    type="password"
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="mt-1 w-full rounded-md border border-[var(--border-strong)] bg-[var(--bg-elevated)] px-2.5 py-2 text-xs text-[var(--text-primary)]"
                  />
                </label>
                <button
                  type="submit"
                  className="rounded-md bg-[var(--accent)] px-3.5 py-2 text-xs font-semibold text-[var(--accent-contrast)] hover:bg-[var(--accent-hover)]"
                >
                  Autenticar (/login)
                </button>
                <button
                  type="button"
                  onClick={() => void coreLogout()}
                  className="rounded-md border border-[var(--border-hairline)] bg-[var(--bg-elevated)] px-3 py-2 text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                >
                  Encerrar sessão
                </button>
              </form>

              <div className="mt-4 border-t border-[var(--border-hairline)] pt-3">
                <button
                  type="button"
                  onClick={() => setShowDiagnostics((s) => !s)}
                  className="inline-flex items-center gap-1.5 text-xs font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                >
                  {showDiagnostics ? (
                    <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
                  ) : (
                    <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
                  )}
                  <span>Diagnóstico técnico HTTP/WS ({diagnostics.length})</span>
                </button>

                {showDiagnostics && (
                  <div className="mt-2 max-h-48 overflow-y-auto rounded-md border border-[var(--border-hairline)] bg-[var(--bg-canvas)] p-2.5 font-mono text-[11px]">
                    {diagnostics.length === 0 ? (
                      <span className="text-[var(--text-muted)]">
                        Nenhuma chamada registrada ao AionCore ainda.
                      </span>
                    ) : (
                      <ul className="space-y-1">
                        {diagnostics
                          .slice()
                          .reverse()
                          .map((entry, idx) => (
                            <li
                              key={`${entry.timestamp}-${idx}`}
                              className={
                                entry.status === 'error'
                                  ? 'text-[var(--status-danger)]'
                                  : 'text-[var(--text-secondary)]'
                              }
                            >
                              [{entry.timestamp.slice(11, 19)}] {entry.operation}{' '}
                              {entry.code ? `(${entry.code}) ` : ''}
                              — {entry.detail}
                            </li>
                          ))}
                      </ul>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}
        </section>

        {/* 2. Team & Roles */}
        <ParticipantsSection />

        {/* 3. Policy */}
        <ModelPolicySection />

        {/* 4. Catalog & Capabilities */}
        <AgentCatalogSection />

        {/* 5. Appearance & About */}
        <section className="rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-5 space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-start gap-2.5">
              <Palette
                className="mt-0.5 h-4 w-4 shrink-0 text-[var(--accent)]"
                aria-hidden="true"
              />
              <div>
                <h3 className="text-sm font-semibold text-[var(--text-primary)]">
                  Aparência e tema
                </h3>
                <p className="mt-0.5 text-xs text-[var(--text-secondary)]">
                  Segue o sistema operacional na primeira abertura ou mantém sua preferência em localStorage.
                </p>
              </div>
            </div>
            <select
              aria-label="Preferência de tema"
              value={themePreference}
              onChange={(e) =>
                setThemePreference(
                  e.target.value as 'system' | 'dark' | 'light',
                )
              }
              className="rounded-md border border-[var(--border-strong)] bg-[var(--bg-elevated)] px-3 py-2 text-xs text-[var(--text-primary)]"
            >
              <option value="system">Seguir sistema</option>
              <option value="dark">Escuro (Grafite)</option>
              <option value="light">Claro (Papel grafite)</option>
            </select>
          </div>

          <div className="border-t border-[var(--border-hairline)] pt-4">
            <div className="flex items-start gap-2.5">
              <Info
                className="mt-0.5 h-4 w-4 shrink-0 text-[var(--text-muted)]"
                aria-hidden="true"
              />
              <div className="space-y-1.5 text-xs leading-relaxed text-[var(--text-secondary)]">
                <div className="font-semibold text-[var(--text-primary)]">
                  Sobre o {APP_BRAND.name}
                </div>
                <p>
                  <strong>{APP_BRAND.name}</strong> — {APP_BRAND.slogan}
                </p>
                <p>
                  <strong>{APP_BRAND.technicalSignature}</strong> · Interface web local independente integrada aos contratos HTTP/WS do AionCore v0.2.2 (licença Apache-2.0 no runtime de referência; este projeto não é desenvolvido oficialmente pela equipe do Aion).
                </p>
                <p className="text-[11px] text-[var(--text-muted)]">
                  Compatibilidade preservada: IndexedDB{' '}
                  <code className="font-mono">aion_desk_storage</code>, backups{' '}
                  <code className="font-mono">exportSchemaVersion 2.0.0</code> e envelope interno{' '}
                  <code className="font-mono">aion-desk/v1</code>.
                </p>
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
