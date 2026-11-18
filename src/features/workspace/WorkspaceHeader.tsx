import {
  Database,
  Download,
  ListTodo,
  Moon,
  PanelLeft,
  Settings,
  Sun,
} from 'lucide-react';
import { StatusBadge } from '../../components/StatusBadge';
import { APP_BRAND } from '../../config/brand';
import {
  getLatestContextRevision,
  getTaskSummaryCounts,
} from '../../domain/selectors';
import { PT_BR } from '../../i18n/ptBR';
import { DemoControlsMenu } from './DemoControlsMenu';
import { useWorkspace } from './WorkspaceContext';

interface WorkspaceHeaderProps {
  onOpenExport: () => void;
}

export function WorkspaceHeader({ onOpenExport }: WorkspaceHeaderProps) {
  const {
    store,
    activeProject,
    activeConversation,
    storageStatus,
    resolvedTheme,
    setThemePreference,
    toggleSidebar,
    drawerOpen,
    openDrawer,
    closeDrawer,
    sidebarCollapsed,
    mainSurface,
    setMainSurface,
    hasDemoControls,
  } = useWorkspace();

  const conv = activeConversation?.conversation;
  const isCoreMode = store?.executionMode === 'aion_core';
  const coordinator = activeConversation?.participants.find(
    (p) => p.id === conv?.coordinatorParticipantId,
  );
  const taskCounts = activeConversation
    ? getTaskSummaryCounts(activeConversation.tasks)
    : null;
  const latestRev = activeConversation
    ? getLatestContextRevision(activeConversation)
    : undefined;

  const execBadge = (() => {
    switch (conv?.executionStatus) {
      case 'running':
        return (
          <StatusBadge
            label={
              conv.executionMode === 'aion_core'
                ? 'Em execução (Core)'
                : 'Em execução · simulação'
            }
            tone="accent"
            iconKind="running"
          />
        );
      case 'paused_demo':
        return (
          <StatusBadge
            label="Demonstração pausada"
            tone="warning"
            iconKind="paused"
          />
        );
      case 'paused_queue':
        return (
          <StatusBadge
            label="Fila pausada"
            tone="warning"
            iconKind="paused"
          />
        );
      case 'blocked':
        return (
          <StatusBadge
            label="Aguardando ação"
            tone="warning"
            iconKind="permission"
          />
        );
      case 'completed':
        return (
          <StatusBadge label="Concluída" tone="success" iconKind="success" />
        );
      case 'failed':
        return (
          <StatusBadge label="Com falha" tone="danger" iconKind="danger" />
        );
      default:
        return <StatusBadge label="Pronta" tone="neutral" iconKind="idle" />;
    }
  })();

  const storageTone =
    storageStatus === 'saved'
      ? 'text-[var(--text-muted)]'
      : storageStatus === 'session_only'
        ? 'text-[var(--status-warning)] font-medium'
        : 'text-[var(--text-secondary)]';

  return (
    <header className="shrink-0 border-b border-[var(--border-hairline)] bg-[var(--bg-canvas)] px-3 py-2 sm:px-6 sm:py-2.5">
      {/* Tier 1: Breadcrumb + Honest Runtime Marker */}
      <div className="flex items-center justify-between gap-2 text-[11px] text-[var(--text-muted)]">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={toggleSidebar}
            aria-label="Alternar barra lateral de projetos"
            className="-ml-1.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-elevated)] hover:text-[var(--text-primary)]"
          >
            <PanelLeft className="h-4 w-4" aria-hidden="true" />
          </button>

          <span className="max-w-[140px] truncate font-medium text-[var(--text-secondary)] sm:max-w-none">
            {activeProject?.name ?? 'Sem projeto'}
          </span>
          <span aria-hidden="true" className="hidden sm:inline">/</span>
          <span className="hidden sm:inline">Conversas</span>

          {coordinator && (
            <>
              <span aria-hidden="true" className="hidden sm:inline">
                ·
              </span>
              <span className="hidden sm:inline">
                Coordenador:{' '}
                <strong className="font-medium text-[var(--text-secondary)]">
                  {coordinator.displayName}
                </strong>
              </span>
            </>
          )}

          {isCoreMode && conv && (
            <>
              <span aria-hidden="true" className="hidden sm:inline">·</span>
              <span className="hidden items-center gap-1.5 sm:inline-flex">
                <span>
                  {conv.externalTeamId
                    ? 'Equipe Core vinculada'
                    : 'Sem equipe criada no Core'}
                </span>
                {conv.externalTeamId && (
                  <details className="inline-block">
                    <summary className="cursor-pointer select-none text-[10px] text-[var(--text-muted)] hover:text-[var(--text-secondary)]">
                      ID
                    </summary>
                    <span className="ml-1 font-mono text-[10px] text-[var(--text-secondary)]">
                      {conv.externalTeamId}
                    </span>
                  </details>
                )}
              </span>
            </>
          )}

          <span aria-hidden="true">·</span>
          <span
            className={`inline-flex items-center gap-1 whitespace-nowrap ${storageTone}`}
          >
            <Database className="h-3 w-3 shrink-0" aria-hidden="true" />
            <span>{PT_BR.storageStatusLabel[storageStatus]}</span>
          </span>
        </div>

        <span
          className={`inline-flex shrink-0 items-center whitespace-nowrap rounded border px-2 py-0.5 text-[10px] font-medium ${
            isCoreMode
              ? 'border-[var(--border-strong)] bg-[var(--bg-surface)] text-[var(--accent)]'
              : 'border-[var(--border-hairline)] bg-[var(--bg-surface)] text-[var(--status-warning)]'
          }`}
        >
          {isCoreMode ? APP_BRAND.coreBadgeLabel : APP_BRAND.demoBadgeLabel}
        </span>
      </div>

      {/* Tier 2: Conversation Title + Uncluttered Action Cluster */}
      <div className="mt-1 flex items-center justify-between gap-2 sm:mt-1.5 sm:flex-wrap sm:gap-x-3 sm:gap-y-2">
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-base font-semibold tracking-tight text-[var(--text-primary)] sm:text-[21px]">
            {mainSurface === 'settings'
              ? 'Configurações do workspace'
              : (conv?.title ?? 'Nenhuma conversa selecionada')}
          </h1>
        </div>

        <div className="flex shrink-0 items-center gap-1.5 sm:gap-2">
          {mainSurface === 'conversation' && (
            <>
              <div className="mr-1 hidden sm:block">{execBadge}</div>

              {hasDemoControls && <DemoControlsMenu />}

              <button
                type="button"
                aria-pressed={drawerOpen}
                title="Alternar painel de trabalho e contexto"
                onClick={() => {
                  if (drawerOpen) {
                    closeDrawer();
                  } else {
                    openDrawer('tasks');
                  }
                }}
                className={`inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-md border px-2.5 text-xs font-medium transition-colors ${
                  drawerOpen
                    ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]'
                    : 'border-[var(--border-hairline)] bg-[var(--bg-surface)] text-[var(--text-secondary)] hover:border-[var(--border-strong)] hover:text-[var(--text-primary)]'
                }`}
              >
                <ListTodo className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span>Trabalho</span>
                {taskCounts && (
                  <span className="tabular-nums text-[var(--text-muted)]">
                    {taskCounts.completed}/{taskCounts.total}
                    {latestRev ? ` · v${latestRev.versionNumber}` : ''}
                  </span>
                )}
              </button>
            </>
          )}

          <button
            type="button"
            onClick={onOpenExport}
            aria-label={PT_BR.actions.exportHistory}
            title={PT_BR.actions.exportHistory}
            className="inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-md border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2.5 text-xs font-medium text-[var(--text-secondary)] transition-colors hover:border-[var(--border-strong)] hover:text-[var(--text-primary)]"
          >
            <Download className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span className="hidden xl:inline">
              {PT_BR.actions.exportHistory}
            </span>
          </button>

          {(sidebarCollapsed || mainSurface === 'settings') && (
            <button
              type="button"
              aria-pressed={mainSurface === 'settings'}
              onClick={() =>
                setMainSurface(
                  mainSurface === 'settings' ? 'conversation' : 'settings',
                )
              }
              aria-label={PT_BR.actions.openSettings}
              className={`inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-md border px-2.5 text-xs font-medium transition-colors ${
                mainSurface === 'settings'
                  ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]'
                  : 'border-[var(--border-hairline)] bg-[var(--bg-surface)] text-[var(--text-secondary)] hover:border-[var(--border-strong)] hover:text-[var(--text-primary)]'
              }`}
            >
              <Settings className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span className="hidden lg:inline">
                {PT_BR.actions.openSettings}
              </span>
            </button>
          )}

          <button
            type="button"
            onClick={() =>
              setThemePreference(resolvedTheme === 'dark' ? 'light' : 'dark')
            }
            aria-label={
              resolvedTheme === 'dark'
                ? 'Mudar para tema claro'
                : 'Mudar para tema escuro'
            }
            title={
              resolvedTheme === 'dark'
                ? 'Mudar para tema claro'
                : 'Mudar para tema escuro'
            }
            className="flex h-8 w-8 items-center justify-center rounded-md border border-[var(--border-hairline)] bg-[var(--bg-surface)] text-[var(--text-secondary)] transition-colors hover:border-[var(--border-strong)] hover:text-[var(--text-primary)]"
          >
            {resolvedTheme === 'dark' ? (
              <Sun className="h-4 w-4" aria-hidden="true" />
            ) : (
              <Moon className="h-4 w-4" aria-hidden="true" />
            )}
          </button>
        </div>
      </div>

      {/* Mobile execution status line */}
      {mainSurface === 'conversation' && (
        <div className="mt-1 flex items-center justify-between gap-2 sm:hidden">
          {execBadge}
          {isCoreMode && conv && (
            <span className="truncate text-[11px] text-[var(--text-muted)]">
              {conv.externalTeamId ? 'Equipe Core vinculada' : 'Sem equipe Core'}
            </span>
          )}
        </div>
      )}
    </header>
  );
}
