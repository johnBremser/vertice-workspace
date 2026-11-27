import { X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import {
  getLatestContextRevision,
  getTaskSummaryCounts,
} from '../../domain/selectors';
import { PT_BR } from '../../i18n/ptBR';
import { useWorkspace } from '../workspace/WorkspaceContext';
import { ContextPanel } from './ContextPanel';
import { FilesPanel } from './FilesPanel';
import { TasksPanel } from './TasksPanel';

export function InspectorDrawer() {
  const { drawerOpen, drawerTab, openDrawer, closeDrawer, activeConversation } =
    useWorkspace();
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const wasOpenRef = useRef(drawerOpen);
  const [filesCount, setFilesCount] = useState<number | null>(null);
  const projectId = activeConversation?.conversation.projectId ?? '';

  useEffect(() => {
    setFilesCount(null);
  }, [projectId]);

  useEffect(() => {
    const isNarrowViewport =
      typeof window !== 'undefined' && window.innerWidth < 1280;
    if (drawerOpen && !wasOpenRef.current && isNarrowViewport) {
      closeButtonRef.current?.focus();
    }
    wasOpenRef.current = drawerOpen;
  }, [drawerOpen]);

  useEffect(() => {
    if (!drawerOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && typeof window !== 'undefined' && window.innerWidth < 1280) {
        closeDrawer();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [drawerOpen, closeDrawer]);

  if (!drawerOpen || !activeConversation) return null;

  const taskCounts = getTaskSummaryCounts(activeConversation.tasks);
  const latestRev = getLatestContextRevision(activeConversation);

  return (
    <>
      <div
        className="fixed inset-0 z-30 bg-black/50 xl:hidden"
        aria-hidden="true"
        onClick={closeDrawer}
      />

      <aside
        aria-label="Painel auxiliar de tarefas, contexto e arquivos"
        className={`fixed inset-y-0 right-0 z-40 flex w-full max-w-full flex-col border-l border-[var(--border-hairline)] bg-[var(--bg-sidebar)] shadow-xl sm:w-[360px] xl:static xl:z-auto xl:shrink-0 xl:shadow-none ${drawerTab === 'files'
            ? 'xl:w-[440px] 2xl:w-[500px]'
            : 'xl:w-[320px] 2xl:w-[340px]'
          }`}
      >
        <div className="flex items-center justify-between border-b border-[var(--border-hairline)] px-4 py-3">
          <div>
            <div className="text-[13px] font-semibold text-[var(--text-primary)]">
              Trabalho
            </div>
            <div className="tabular-nums text-[11px] text-[var(--text-muted)]">
              {taskCounts.completed} de {taskCounts.total} concluídas
              {latestRev ? ` · Contexto v${latestRev.versionNumber}` : ''}
            </div>
          </div>

          <button
            ref={closeButtonRef}
            type="button"
            onClick={closeDrawer}
            aria-label="Fechar painel lateral"
            className="flex h-8 w-8 items-center justify-center rounded-md text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-elevated)] hover:text-[var(--text-primary)]"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        <div
          className="flex items-center gap-1 border-b border-[var(--border-hairline)] px-3 py-2"
          role="tablist"
          aria-label="Painéis do inspetor"
        >
          <button
            type="button"
            role="tab"
            aria-selected={drawerTab === 'tasks'}
            onClick={() => openDrawer('tasks')}
            className={`flex-1 whitespace-nowrap rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors ${drawerTab === 'tasks'
                ? 'bg-[var(--accent-soft)] text-[var(--accent)]'
                : 'text-[var(--text-secondary)] hover:bg-[var(--bg-elevated)] hover:text-[var(--text-primary)]'
              }`}
          >
            {PT_BR.drawerTabs.tasks}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={drawerTab === 'context'}
            onClick={() => openDrawer('context')}
            className={`flex-1 whitespace-nowrap rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors ${drawerTab === 'context'
                ? 'bg-[var(--accent-soft)] text-[var(--accent)]'
                : 'text-[var(--text-secondary)] hover:bg-[var(--bg-elevated)] hover:text-[var(--text-primary)]'
              }`}
          >
            {PT_BR.drawerTabs.context}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={drawerTab === 'files'}
            onClick={() => openDrawer('files')}
            className={`flex-1 whitespace-nowrap rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors ${drawerTab === 'files'
                ? 'bg-[var(--accent-soft)] text-[var(--accent)]'
                : 'text-[var(--text-secondary)] hover:bg-[var(--bg-elevated)] hover:text-[var(--text-primary)]'
              }`}
          >
            {PT_BR.drawerTabs.files}
            {filesCount !== null ? ` (${filesCount})` : ''}
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {drawerTab === 'tasks' ? (
            <TasksPanel />
          ) : drawerTab === 'context' ? (
            <ContextPanel />
          ) : (
            <FilesPanel onCountChange={setFilesCount} />
          )}
        </div>
      </aside>
    </>
  );
}
