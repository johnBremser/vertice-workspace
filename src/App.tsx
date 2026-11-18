import { AlertTriangle, Play, RefreshCw, Server, X } from 'lucide-react';
import { lazy, Suspense, useState } from 'react';
import { InspectorDrawer } from './features/inspector/InspectorDrawer';
import { ProjectSidebar } from './features/projects/ProjectSidebar';
import { AgentTabs } from './features/workspace/AgentTabs';
import { Composer } from './features/workspace/Composer';
import { MessageStream } from './features/workspace/MessageStream';
import {
  WorkspaceProvider,
  useWorkspace,
} from './features/workspace/WorkspaceContext';
import { WorkspaceHeader } from './features/workspace/WorkspaceHeader';
import { PT_BR } from './i18n/ptBR';

const LazyExportDialog = lazy(() =>
  import('./components/ExportDialog').then((m) => ({
    default: m.ExportDialog,
  })),
);
const LazySettingsView = lazy(() =>
  import('./features/settings/SettingsView').then((m) => ({
    default: m.SettingsView,
  })),
);

function WorkspaceShell() {
  const {
    loading,
    store,
    activeProject,
    activeConversation,
    storageStatus,
    storageErrorMessage,
    mainSurface,
    setMainSurface,
    actionBanner,
    dismissBanner,
    reconcileConversation,
    controlExecution,
    resumePausedDemo,
    importWorkspaceState,
  } = useWorkspace();

  const [exportOpen, setExportOpen] = useState(false);

  const conv = activeConversation?.conversation;
  const hasGap =
    conv?.syncState === 'gap_detected' || conv?.syncState === 'incomplete';
  const isPausedDemo = conv?.executionStatus === 'paused_demo';
  const isPausedCoreQueue =
    conv?.executionMode === 'aion_core' &&
    conv?.executionStatus === 'paused_queue';
  const needsCoreTeamSetup =
    store?.executionMode === 'aion_core' &&
    conv &&
    !conv.externalTeamId &&
    mainSurface === 'conversation';

  return (
    <div className="flex h-screen w-full overflow-hidden bg-[var(--bg-canvas)] text-[var(--text-primary)]">
      <ProjectSidebar />

      <div className="flex min-w-0 flex-1 flex-col">
        <WorkspaceHeader onOpenExport={() => setExportOpen(true)} />

        {/* Honest Storage Session-Only Warning */}
        {storageStatus === 'session_only' && (
          <div
            role="status"
            className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border-hairline)] bg-[var(--status-warning-soft)] px-4 py-2 text-xs text-[var(--status-warning)] sm:px-6"
          >
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
              <span>
                {storageErrorMessage ?? PT_BR.storageSessionOnlyWarning}
              </span>
            </div>
            <button
              type="button"
              onClick={() => setExportOpen(true)}
              className="whitespace-nowrap rounded border border-current px-2.5 py-1 text-xs font-medium hover:opacity-85"
            >
              Exportar agora
            </button>
          </div>
        )}

        {/* Core setup guidance banner when in Core mode without team binding */}
        {needsCoreTeamSetup && (
          <div
            role="status"
            className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border-hairline)] bg-[var(--bg-elevated)] px-4 py-2 text-xs text-[var(--text-primary)] sm:px-6"
          >
            <div className="flex items-center gap-2">
              <Server
                className="h-4 w-4 shrink-0 text-[var(--accent)]"
                aria-hidden="true"
              />
              <span>
                Modo AionCore local ativo: conecte ao servidor, sincronize o catálogo e crie a equipe no Core para habilitar envios reais.
              </span>
            </div>
            <button
              type="button"
              onClick={() => setMainSurface('settings')}
              className="whitespace-nowrap rounded-md bg-[var(--accent)] px-3 py-1.5 text-xs font-semibold text-[var(--accent-contrast)] hover:bg-[var(--accent-hover)]"
            >
              Abrir Configurações Core
            </button>
          </div>
        )}

        {/* Gap / Reconciliation Notice */}
        {hasGap && (
          <div
            role="alert"
            className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border-hairline)] bg-[var(--status-warning-soft)] px-4 py-2 text-xs text-[var(--status-warning)] sm:px-6"
          >
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
              <span>
                {activeConversation?.syncErrorNote ?? PT_BR.reconcileBannerTitle}
              </span>
            </div>
            <button
              type="button"
              onClick={() => void reconcileConversation()}
              className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-md bg-[var(--accent)] px-3 py-1.5 text-xs font-semibold text-[var(--accent-contrast)] hover:bg-[var(--accent-hover)]"
            >
              <RefreshCw className="h-3 w-3" aria-hidden="true" />
              <span>{PT_BR.reconcileAction}</span>
            </button>
          </div>
        )}

        {/* Paused After Reload Banner (Core) */}
        {isPausedCoreQueue && (
          <div
            role="status"
            className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border-hairline)] bg-[var(--bg-elevated)] px-4 py-2 text-xs text-[var(--text-primary)] sm:px-6"
          >
            <span>{PT_BR.pausedCoreAfterReloadLabel}</span>
            <div className="flex flex-wrap items-center gap-2">
              {conv?.externalTeamId && (
                <button
                  type="button"
                  onClick={() => void reconcileConversation()}
                  className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-md border border-[var(--border-strong)] bg-[var(--bg-surface)] px-3 py-1.5 text-xs font-medium text-[var(--text-primary)] hover:bg-[var(--bg-subtle)]"
                >
                  <RefreshCw className="h-3 w-3" aria-hidden="true" />
                  <span>{PT_BR.reconcileAction}</span>
                </button>
              )}
              <button
                type="button"
                disabled={!conv?.externalTeamId}
                title={
                  !conv?.externalTeamId
                    ? 'Vincule ou crie uma equipe no Core antes de retomar o fluxo.'
                    : 'Reconcilia com o Core e retoma apenas as próximas etapas pendentes, sem repetir o pedido original.'
                }
                onClick={() => void controlExecution('resume_queue')}
                className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-md bg-[var(--accent)] px-3 py-1.5 text-xs font-semibold text-[var(--accent-contrast)] hover:bg-[var(--accent-hover)] disabled:opacity-50"
              >
                <Play className="h-3 w-3" aria-hidden="true" />
                <span>{PT_BR.resumeCoreQueueAction}</span>
              </button>
            </div>
          </div>
        )}

        {/* Paused After Reload Banner */}
        {isPausedDemo && (
          <div
            role="status"
            className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border-hairline)] bg-[var(--bg-elevated)] px-4 py-2 text-xs text-[var(--text-primary)] sm:px-6"
          >
            <span>
              {PT_BR.pausedAfterReloadLabel}: os timers anteriores não foram reiniciados automaticamente.
            </span>
            <button
              type="button"
              onClick={resumePausedDemo}
              className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-md bg-[var(--accent)] px-3 py-1.5 text-xs font-semibold text-[var(--accent-contrast)] hover:bg-[var(--accent-hover)]"
            >
              <Play className="h-3 w-3" aria-hidden="true" />
              <span>{PT_BR.resumeDemoAction}</span>
            </button>
          </div>
        )}

        {/* Action Feedback Banner */}
        {actionBanner && (
          <div
            role="status"
            aria-live="polite"
            className={`flex items-center justify-between gap-3 border-b border-[var(--border-hairline)] px-4 py-2 text-xs sm:px-6 ${
              actionBanner.tone === 'danger'
                ? 'bg-[var(--status-danger-soft)] text-[var(--status-danger)]'
                : actionBanner.tone === 'warning'
                  ? 'bg-[var(--status-warning-soft)] text-[var(--status-warning)]'
                  : actionBanner.tone === 'success'
                    ? 'bg-[var(--status-success-soft)] text-[var(--status-success)]'
                    : 'bg-[var(--accent-soft)] text-[var(--text-primary)]'
            }`}
          >
            <span>{actionBanner.message}</span>
            <button
              type="button"
              onClick={dismissBanner}
              aria-label="Dispensar aviso"
              className="rounded p-1 hover:opacity-75"
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </div>
        )}

        {/* Early Structural Loading Skeleton (never blank white screen) */}
        {loading ? (
          <div
            className="flex-1 p-6"
            aria-busy="true"
            aria-label="Carregando histórico"
          >
            <div className="mx-auto max-w-[820px] space-y-3">
              <div className="h-10 w-2/3 rounded-lg bg-[var(--bg-elevated)]" />
              <div className="h-24 w-full rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-surface)]" />
              <div className="h-24 w-full rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-surface)]" />
            </div>
          </div>
        ) : mainSurface === 'settings' ? (
          <Suspense
            fallback={
              <div className="flex-1 p-6 text-xs text-[var(--text-secondary)]">
                Carregando configurações...
              </div>
            }
          >
            <LazySettingsView />
          </Suspense>
        ) : (
          <div className="flex min-h-0 flex-1">
            <main className="flex min-w-0 flex-1 flex-col">
              <AgentTabs />
              <MessageStream />
              <Composer />
            </main>
            <InspectorDrawer />
          </div>
        )}
      </div>

      {store && exportOpen && (
        <Suspense fallback={null}>
          <LazyExportDialog
            open={exportOpen}
            onClose={() => setExportOpen(false)}
            state={store}
            activeProject={activeProject}
            activeConversation={activeConversation}
            modelPolicy={store.modelPolicy}
            onImportState={importWorkspaceState}
          />
        </Suspense>
      )}
    </div>
  );
}

export default function App() {
  return (
    <WorkspaceProvider>
      <WorkspaceShell />
    </WorkspaceProvider>
  );
}
