import { PlugZap } from 'lucide-react';
import type { CapabilityFlag, ConnectionAdapterConfig } from '../../domain/types';
import { PT_BR } from '../../i18n/ptBR';
import { useWorkspace } from '../workspace/WorkspaceContext';

function capabilityLabel(label: string, flag: CapabilityFlag): string {
  if (flag === true) return `${label}: suportada`;
  if (flag === false) return `${label}: não suportada`;
  return `${label}: desconhecida`;
}

function executableLabel(conn: ConnectionAdapterConfig): string {
  const base = (() => {
    switch (conn.executableStatus) {
      case 'verified':
        return 'Verificado no Core';
      case 'missing':
        return 'Não encontrado no ambiente local';
      case 'unknown_in_browser':
        return 'Não verificável no navegador';
      default:
        return 'Desconhecido';
    }
  })();
  if (conn.mode === 'aion_core' && conn.coreAgentStatus) {
    return `${base} (${conn.coreAgentStatus})`;
  }
  return base;
}

function authLabel(conn: ConnectionAdapterConfig): string {
  switch (conn.authStatus) {
    case 'simulated':
      return 'Simulada no preview';
    case 'authenticated':
      return 'Autenticada no Core';
    case 'unauthenticated':
      return 'Não autenticada';
    case 'expired':
      return 'Expirada';
    default:
      if (conn.mode === 'aion_core' && conn.coreAgentStatus === 'online') {
        return 'Validada ao usar CLI (health-check online)';
      }
      if (conn.mode === 'aion_core' && conn.coreAgentStatus === 'unchecked') {
        return 'Aguardando verificação / 1º turno CLI';
      }
      return 'Desconhecida';
  }
}

export function AgentCatalogSection() {
  const { store, testAgentConnection } = useWorkspace();
  if (!store) return null;

  const availableConnections = store.connections.filter(
    (c) => c.executableStatus !== 'missing',
  );
  const missingConnections = store.connections.filter(
    (c) => c.executableStatus === 'missing',
  );

  const renderConnectionCard = (conn: ConnectionAdapterConfig) => (
    <div key={conn.id} className="py-4 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-[var(--text-primary)]">
              {conn.displayName}
            </span>
            <span className="rounded border border-[var(--border-hairline)] bg-[var(--bg-elevated)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--text-secondary)]">
              {conn.mode === 'aion_core' ? 'Core' : 'Demo'} · {conn.backendId}
            </span>
          </div>
          <div className="text-xs text-[var(--text-secondary)]">
            {conn.vendorLabel}
            {conn.coreAssistantId
              ? ` · assistant_id: ${conn.coreAssistantId}`
              : ''}
          </div>
        </div>

        <button
          type="button"
          onClick={() => void testAgentConnection(conn.id)}
          className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-md border border-[var(--border-strong)] bg-[var(--bg-elevated)] px-3 py-1.5 text-xs font-medium text-[var(--text-primary)] hover:bg-[var(--bg-subtle)]"
        >
          <PlugZap className="h-3.5 w-3.5 text-[var(--accent)]" aria-hidden="true" />
          <span>{PT_BR.actions.testConnection}</span>
        </button>
      </div>

      <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-2 text-xs sm:grid-cols-2 lg:grid-cols-3">
        <div>
          <dt className="text-[var(--text-muted)]">1. Configurada</dt>
          <dd className="font-medium text-[var(--text-primary)]">
            {conn.configured ? 'Sim' : 'Não'}
          </dd>
        </div>
        <div>
          <dt className="text-[var(--text-muted)]">2. Core alcançável</dt>
          <dd className="font-medium text-[var(--text-primary)]">
            {conn.coreReachability === 'reachable'
              ? 'Alcançável'
              : conn.coreReachability === 'unreachable'
                ? 'Inalcançável'
                : 'Desconhecida / Não testada'}
          </dd>
        </div>
        <div>
          <dt className="text-[var(--text-muted)]">3. Executável</dt>
          <dd className="font-medium text-[var(--text-secondary)]">
            {executableLabel(conn)}
          </dd>
        </div>
        <div>
          <dt className="text-[var(--text-muted)]">4. Autenticação</dt>
          <dd className="font-medium text-[var(--text-primary)]">
            {authLabel(conn)}
          </dd>
        </div>
        <div>
          <dt className="text-[var(--text-muted)]">5. Catálogo e modelos</dt>
          <dd className="font-medium text-[var(--text-primary)]">
            {conn.catalogLoaded
              ? `Carregado (${conn.availableModels.length})`
              : `Não carregado (${conn.availableModels.length} perfil(is) demo)`}
          </dd>
        </div>
        <div>
          <dt className="text-[var(--text-muted)]">6. Sessão</dt>
          <dd className="font-medium text-[var(--text-primary)]">
            {conn.sessionStatus}
          </dd>
        </div>
        <div className="sm:col-span-2 lg:col-span-3">
          <dt className="text-[var(--text-muted)]">
            Matriz de capacidades do adaptador
          </dt>
          <dd className="mt-1 flex flex-wrap gap-1.5 text-[11px] text-[var(--text-primary)]">
            <span>
              {capabilityLabel(
                'Pausar fila',
                conn.capabilities.supportsPauseQueue,
              )}
            </span>
            <span>·</span>
            <span>
              {capabilityLabel(
                'Interrupção em execução',
                conn.capabilities.supportsInterrupt,
              )}
            </span>
            <span>·</span>
            <span>
              {capabilityLabel(
                'Injeção de contexto em curso',
                conn.capabilities.supportsMidRunContextInjection,
              )}
            </span>
            <span>·</span>
            <span>
              {capabilityLabel(
                'Troca de modelo na sessão',
                conn.capabilities.supportsModelSwitchInSession,
              )}
            </span>
            <span>·</span>
            <span>
              {capabilityLabel(
                'Encerrar sessão',
                conn.capabilities.supportsSessionTerminate,
              )}
            </span>
          </dd>
        </div>
      </dl>

      {conn.lastConnectionTestResult && (
        <p className="mt-2 text-xs text-[var(--text-secondary)]">
          Último teste (
          {conn.lastConnectionTestAt
            ? new Date(conn.lastConnectionTestAt).toLocaleTimeString('pt-BR')
            : '—'}
          ): {conn.lastConnectionTestResult}
        </p>
      )}
    </div>
  );

  return (
    <section
      aria-labelledby="settings-agents-title"
      className="rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-5"
    >
      <div className="border-b border-[var(--border-hairline)] pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2
            id="settings-agents-title"
            className="text-sm font-semibold text-[var(--text-primary)]"
          >
            Catálogo de conexões e adaptadores
          </h2>
          {store.connections.length > 0 && (
            <span className="text-[11px] text-[var(--text-muted)]">
              {availableConnections.length} verificada(s) no ambiente · {missingConnections.length} sem CLI instalada
            </span>
          )}
        </div>
        <p className="mt-1 text-xs leading-relaxed text-[var(--text-secondary)]">
          O AionCore lista tanto CLIs instaladas nesta máquina quanto adaptadores do catálogo padrão. Adaptadores marcados como &quot;Não encontrado no ambiente local&quot; não executam até que a respectiva CLI seja instalada e autenticada.
        </p>
      </div>

      {store.connections.length === 0 ? (
        <p className="mt-4 text-xs text-[var(--text-muted)]">
          Nenhuma conexão sincronizada ainda. Autentique no AionCore acima e clique em <strong>Sincronizar catálogo</strong>.
        </p>
      ) : (
        <>
          <div className="mt-4 divide-y divide-[var(--border-hairline)]">
            {availableConnections.map(renderConnectionCard)}
          </div>

          {missingConnections.length > 0 && (
            <details className="mt-4 rounded-md border border-[var(--border-hairline)] bg-[var(--bg-canvas)] p-3">
              <summary className="cursor-pointer select-none text-xs font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)]">
                Outros adaptadores do catálogo sem CLI instalada neste ambiente ({missingConnections.length})
              </summary>
              <div className="mt-3 divide-y divide-[var(--border-hairline)]">
                {missingConnections.map(renderConnectionCard)}
              </div>
            </details>
          )}
        </>
      )}
    </section>
  );
}
