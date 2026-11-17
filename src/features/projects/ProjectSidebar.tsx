import {
  Archive,
  ArchiveRestore,
  FolderOpen,
  MessageSquarePlus,
  Pencil,
  Plus,
  Settings,
  X,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { EmptyState } from '../../components/EmptyState';
import { APP_BRAND } from '../../config/brand';
import { PT_BR } from '../../i18n/ptBR';
import { useWorkspace } from '../workspace/WorkspaceContext';
import { ProjectDialog, type ProjectModalMode } from './ProjectDialog';

function VerticeBrandMark() {
  return (
    <svg
      className="h-7 w-7 shrink-0 text-[var(--accent)]"
      viewBox="0 0 32 32"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M6 9 16 25 26 9" />
      <path d="M11 16h10" />
    </svg>
  );
}

export function ProjectSidebar() {
  const {
    store,
    sidebarCollapsed,
    mobileSidebarOpen,
    toggleSidebar,
    closeMobileSidebar,
    selectConversation,
    createProject,
    renameProject,
    setProjectArchived,
    createConversation,
    renameConversation,
    setConversationArchived,
    mainSurface,
    setMainSurface,
  } = useWorkspace();

  const [showArchived, setShowArchived] = useState(false);
  const [modalMode, setModalMode] = useState<ProjectModalMode>(null);

  useEffect(() => {
    if (!mobileSidebarOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        closeMobileSidebar();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [mobileSidebarOpen, closeMobileSidebar]);

  if (!store) {
    return null;
  }

  const projects = store.projects.filter(
    (p) => showArchived || p.status === 'active',
  );
  const allConversations = Object.values(store.conversations);
  const isCoreMode = store.executionMode === 'aion_core';

  const asideClasses = [
    'flex flex-col border-r border-[var(--border-hairline)] bg-[var(--bg-sidebar)] transition-transform duration-150',
    mobileSidebarOpen
      ? 'fixed inset-y-0 left-0 z-40 w-72 shadow-xl lg:static lg:z-auto lg:shadow-none'
      : 'hidden',
    !sidebarCollapsed ? 'lg:flex lg:w-[240px] lg:shrink-0' : 'lg:hidden',
  ].join(' ');

  return (
    <>
      {mobileSidebarOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/50 lg:hidden"
          aria-hidden="true"
          onClick={closeMobileSidebar}
        />
      )}

      <aside aria-label={PT_BR.sidebarTitle} className={asideClasses}>
        {/* Brand header */}
        <div className="px-4 pt-5 pb-3">
          <div className="flex items-start justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2.5">
              <VerticeBrandMark />
              <div className="min-w-0">
                <div className="truncate text-[15px] font-semibold tracking-tight text-[var(--text-primary)]">
                  {APP_BRAND.name}
                </div>
              </div>
            </div>
            <button
              type="button"
              onClick={closeMobileSidebar}
              aria-label="Fechar barra lateral"
              className="flex h-10 w-10 items-center justify-center rounded-md text-[var(--text-secondary)] hover:bg-[var(--bg-elevated)] hover:text-[var(--text-primary)] lg:hidden"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
          <p className="mt-1.5 text-[11px] leading-snug text-[var(--text-muted)]">
            {APP_BRAND.slogan}
          </p>
        </div>

        {/* Workspace section caption */}
        <div className="mt-2 flex items-center justify-between px-4 pb-2">
          <span className="text-[11px] font-medium tracking-wider text-[var(--text-muted)] uppercase">
            {PT_BR.sidebarTitle}
          </span>
          <button
            type="button"
            onClick={() => setModalMode({ kind: 'create_project' })}
            className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs font-medium text-[var(--accent)] transition-colors hover:bg-[var(--accent-soft)]"
          >
            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
            <span>{PT_BR.newProject}</span>
          </button>
        </div>

        {/* Projects & conversations */}
        <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
          {projects.length === 0 ? (
            <EmptyState
              title={PT_BR.emptyProjectsTitle}
              description={PT_BR.emptyProjectsBody}
              action={
                <button
                  type="button"
                  onClick={() => setModalMode({ kind: 'create_project' })}
                  className="rounded-md bg-[var(--accent)] px-3 py-1.5 text-xs font-semibold text-[var(--accent-contrast)] hover:bg-[var(--accent-hover)]"
                >
                  {PT_BR.newProject}
                </button>
              }
            />
          ) : (
            <div className="space-y-4">
              {projects.map((project) => {
                const projectConvs = allConversations.filter(
                  (c) =>
                    c.conversation.projectId === project.id &&
                    (showArchived || c.conversation.status === 'active'),
                );
                const isArchived = project.status === 'archived';

                return (
                  <section key={project.id} aria-label={project.name}>
                    <div className="group flex items-center justify-between gap-1 rounded-lg bg-[var(--bg-elevated)] px-2.5 py-2">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 text-[13px] font-medium text-[var(--text-primary)]">
                          <FolderOpen
                            className="h-4 w-4 shrink-0 text-[var(--accent)]"
                            aria-hidden="true"
                          />
                          <span className="truncate">{project.name}</span>
                        </div>
                        {project.workspacePathInfo && (
                          <div
                            title={PT_BR.previewWorkspaceDisclaimer}
                            className="mt-0.5 truncate pl-6 font-mono text-[10px] text-[var(--text-muted)]"
                          >
                            {project.workspacePathInfo}
                          </div>
                        )}
                      </div>

                      <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                        <button
                          type="button"
                          title={PT_BR.rename}
                          aria-label={`Renomear projeto ${project.name}`}
                          onClick={() =>
                            setModalMode({
                              kind: 'rename_project',
                              projectId: project.id,
                              currentName: project.name,
                            })
                          }
                          className="rounded p-1 text-[var(--text-secondary)] hover:bg-[var(--bg-subtle)] hover:text-[var(--text-primary)]"
                        >
                          <Pencil className="h-3 w-3" aria-hidden="true" />
                        </button>
                        <button
                          type="button"
                          title={isArchived ? PT_BR.restore : PT_BR.archive}
                          aria-label={
                            isArchived
                              ? `Restaurar projeto ${project.name}`
                              : `Arquivar projeto ${project.name}`
                          }
                          onClick={() =>
                            void setProjectArchived(project.id, !isArchived)
                          }
                          className="rounded p-1 text-[var(--text-secondary)] hover:bg-[var(--bg-subtle)] hover:text-[var(--text-primary)]"
                        >
                          {isArchived ? (
                            <ArchiveRestore className="h-3 w-3" aria-hidden="true" />
                          ) : (
                            <Archive className="h-3 w-3" aria-hidden="true" />
                          )}
                        </button>
                      </div>
                    </div>

                    <ul className="mt-1.5 ml-2.5 space-y-0.5 border-l border-[var(--border-hairline)] pl-2.5">
                      {projectConvs.map((item) => {
                        const conv = item.conversation;
                        const isSelected =
                          store.activeConversationId === conv.id &&
                          mainSurface === 'conversation';
                        const convArchived = conv.status === 'archived';
                        return (
                          <li
                            key={conv.id}
                            className={`group flex items-center justify-between gap-1 rounded-md px-2.5 py-2 text-xs transition-colors ${
                              isSelected
                                ? 'bg-[var(--accent-soft)] font-medium text-[var(--text-primary)]'
                                : 'text-[var(--text-secondary)] hover:bg-[var(--bg-elevated)] hover:text-[var(--text-primary)]'
                            }`}
                          >
                            <button
                              type="button"
                              onClick={() =>
                                selectConversation(project.id, conv.id)
                              }
                              className="min-w-0 flex-1 truncate text-left"
                            >
                              {conv.title}
                              {conv.executionMode === 'aion_core' && ' · Core'}
                              {convArchived && ' (arquivada)'}
                            </button>

                            <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                              <button
                                type="button"
                                aria-label={`Renomear conversa ${conv.title}`}
                                onClick={() =>
                                  setModalMode({
                                    kind: 'rename_conversation',
                                    conversationId: conv.id,
                                    currentTitle: conv.title,
                                  })
                                }
                                className="rounded p-1 hover:bg-[var(--bg-subtle)]"
                              >
                                <Pencil className="h-3 w-3" aria-hidden="true" />
                              </button>
                              <button
                                type="button"
                                aria-label={
                                  convArchived
                                    ? `Restaurar conversa ${conv.title}`
                                    : `Arquivar conversa ${conv.title}`
                                }
                                onClick={() =>
                                  void setConversationArchived(
                                    conv.id,
                                    !convArchived,
                                  )
                                }
                                className="rounded p-1 hover:bg-[var(--bg-subtle)]"
                              >
                                {convArchived ? (
                                  <ArchiveRestore className="h-3 w-3" aria-hidden="true" />
                                ) : (
                                  <Archive className="h-3 w-3" aria-hidden="true" />
                                )}
                              </button>
                            </div>
                          </li>
                        );
                      })}
                    </ul>

                    <button
                      type="button"
                      aria-label={`${PT_BR.newConversation} em ${project.name}`}
                      onClick={() =>
                        setModalMode({
                          kind: 'create_conversation',
                          projectId: project.id,
                          projectName: project.name,
                        })
                      }
                      className="mt-1.5 flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-xs text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-elevated)] hover:text-[var(--text-primary)]"
                    >
                      <MessageSquarePlus className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                      <span>{PT_BR.newConversation}</span>
                    </button>
                  </section>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer: honest runtime + Settings + archive filter */}
        <div className="mt-auto border-t border-[var(--border-hairline)] px-3 py-3 space-y-2">
          <div className="flex items-start gap-2.5 px-2 py-1">
            <span
              className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${
                isCoreMode
                  ? 'bg-[var(--accent)]'
                  : 'bg-[var(--status-warning)]'
              }`}
              aria-hidden="true"
            />
            <div className="min-w-0">
              <div className="truncate text-xs font-medium text-[var(--text-secondary)]">
                {isCoreMode
                  ? APP_BRAND.coreBadgeLabel
                  : APP_BRAND.demoBadgeLabel}
              </div>
              <div className="truncate text-[10px] text-[var(--text-muted)]">
                {isCoreMode
                  ? 'Conexão HTTP/WS com Core local'
                  : 'Simulação determinística no navegador'}
              </div>
            </div>
          </div>

          <button
            type="button"
            aria-pressed={mainSurface === 'settings'}
            onClick={() =>
              setMainSurface(
                mainSurface === 'settings' ? 'conversation' : 'settings',
              )
            }
            className={`flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-xs font-medium transition-colors ${
              mainSurface === 'settings'
                ? 'bg-[var(--accent-soft)] text-[var(--accent)]'
                : 'text-[var(--text-secondary)] hover:bg-[var(--bg-elevated)] hover:text-[var(--text-primary)]'
            }`}
          >
            <Settings className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span>{PT_BR.actions.openSettings}</span>
          </button>

          <div className="flex items-center justify-between px-2.5 pt-0.5">
            <button
              type="button"
              onClick={() => setShowArchived((s) => !s)}
              className="text-[11px] text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)]"
            >
              {showArchived ? PT_BR.hideArchived : PT_BR.showArchived}
            </button>
            <button
              type="button"
              onClick={toggleSidebar}
              aria-label="Recolher barra lateral"
              className="hidden text-[11px] text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)] lg:inline"
            >
              Recolher
            </button>
          </div>
        </div>
      </aside>

      <ProjectDialog
        mode={modalMode}
        teamPresets={store.teamPresets}
        onClose={() => setModalMode(null)}
        onCreateProject={createProject}
        onRenameProject={renameProject}
        onCreateConversation={createConversation}
        onRenameConversation={renameConversation}
      />
    </>
  );
}
