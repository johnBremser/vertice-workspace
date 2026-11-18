import { MessageSquare } from 'lucide-react';
import { useRef, type KeyboardEvent } from 'react';
import {
  getParticipantRoles,
  sortParticipantsByTabOrder,
} from '../../domain/teamValidation';
import type { ParticipantRuntimeStatus } from '../../domain/types';
import { PT_BR } from '../../i18n/ptBR';
import { useWorkspace } from './WorkspaceContext';

function statusTextTone(status: ParticipantRuntimeStatus): string {
  switch (status) {
    case 'running':
      return 'text-[var(--accent)]';
    case 'completed':
      return 'text-[var(--status-success)]';
    case 'awaiting_permission':
    case 'awaiting_review':
    case 'preparing':
      return 'text-[var(--status-warning)]';
    case 'blocked':
    case 'disconnected':
    case 'failed':
      return 'text-[var(--status-danger)]';
    default:
      return 'text-[var(--text-muted)]';
  }
}

function getParticipantInitials(name: string): string {
  const cleaned = name.trim();
  if (!cleaned) return '?';
  const parts = cleaned.split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 1).toUpperCase();
  return `${parts[0][0] ?? ''}${parts[1][0] ?? ''}`.toUpperCase();
}

export function AgentTabs() {
  const { activeConversation, activeTabId, selectTab, mainSurface } =
    useWorkspace();
  const tabListRef = useRef<HTMLDivElement>(null);

  if (!activeConversation || mainSurface === 'settings') {
    return null;
  }

  const participants = sortParticipantsByTabOrder(
    activeConversation.participants.filter((p) => !p.archived),
  );
  const tabIds = ['general', ...participants.map((p) => p.id)];

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const idx = tabIds.indexOf(activeTabId);
    if (idx === -1) return;

    let nextIdx = idx;
    if (e.key === 'ArrowRight') {
      nextIdx = (idx + 1) % tabIds.length;
    } else if (e.key === 'ArrowLeft') {
      nextIdx = (idx - 1 + tabIds.length) % tabIds.length;
    } else if (e.key === 'Home') {
      nextIdx = 0;
    } else if (e.key === 'End') {
      nextIdx = tabIds.length - 1;
    } else {
      return;
    }

    e.preventDefault();
    const nextTabId = tabIds[nextIdx];
    selectTab(nextTabId);
    const btn = tabListRef.current?.querySelector<HTMLButtonElement>(
      `[data-tab-id="${nextTabId}"]`,
    );
    btn?.focus();
  };

  return (
    <div
      ref={tabListRef}
      role="tablist"
      aria-label="Conversas da equipe"
      onKeyDown={handleKeyDown}
      className="flex shrink-0 items-stretch gap-1 overflow-x-auto border-b border-[var(--border-hairline)] bg-[var(--bg-canvas)] px-3 sm:px-6"
    >
      <button
        type="button"
        role="tab"
        data-tab-id="general"
        aria-selected={activeTabId === 'general'}
        tabIndex={activeTabId === 'general' ? 0 : -1}
        onClick={() => selectTab('general')}
        className={`group flex shrink-0 items-center gap-2.5 border-b-2 px-3 py-2 text-left transition-colors sm:py-3 ${
          activeTabId === 'general'
            ? 'border-[var(--accent)] text-[var(--text-primary)]'
            : 'border-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
        }`}
      >
        <span
          className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${
            activeTabId === 'general'
              ? 'bg-[var(--accent-soft)] text-[var(--accent)]'
              : 'bg-[var(--bg-elevated)] text-[var(--text-secondary)]'
          }`}
          aria-hidden="true"
        >
          <MessageSquare className="h-3.5 w-3.5" />
        </span>
        <span className="min-w-0">
          <span className="flex items-center gap-1.5 text-xs font-semibold whitespace-nowrap">
            <span>{PT_BR.generalTabLabel}</span>
            <span className="tabular-nums text-[11px] font-normal text-[var(--text-muted)]">
              {activeConversation.generalFeed.length}
            </span>
          </span>
          <span className="block truncate text-[11px] text-[var(--text-muted)]">
            {PT_BR.generalTabSubtitle}
          </span>
        </span>
      </button>

      {participants.map((p) => {
        const isActive = activeTabId === p.id;
        const roles = getParticipantRoles(p);
        const primaryRole = PT_BR.roleLabels[roles[0]];
        const roleExtra = roles.length > 1 ? ` +${roles.length - 1}` : '';
        const statusText = PT_BR.participantStatusLabels[p.status];

        return (
          <button
            key={p.id}
            type="button"
            role="tab"
            data-tab-id={p.id}
            aria-selected={isActive}
            tabIndex={isActive ? 0 : -1}
            onClick={() => selectTab(p.id)}
            className={`group flex shrink-0 items-center gap-2.5 border-b-2 px-3 py-2 text-left transition-colors sm:py-3 ${
              isActive
                ? 'border-[var(--accent)] text-[var(--text-primary)]'
                : 'border-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
            }`}
          >
            <span
              className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-[11px] font-semibold ${
                isActive
                  ? 'bg-[var(--accent-soft)] text-[var(--accent)]'
                  : 'bg-[var(--bg-elevated)] text-[var(--text-secondary)]'
              }`}
              aria-hidden="true"
            >
              {getParticipantInitials(p.displayName)}
            </span>

            <span className="min-w-0">
              <span className="flex items-center gap-1.5 text-xs font-semibold whitespace-nowrap">
                <span>{p.displayName}</span>
                {p.unreadCount > 0 && (
                  <span
                    aria-label={`${p.unreadCount} novidade(s)`}
                    className="tabular-nums rounded bg-[var(--bg-elevated)] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--accent)]"
                  >
                    +{p.unreadCount}
                  </span>
                )}
              </span>
              <span className="flex items-center gap-1 truncate text-[11px] whitespace-nowrap">
                <span className="text-[var(--text-muted)]">
                  {primaryRole}
                  {roleExtra}
                </span>
                <span aria-hidden="true" className="text-[var(--text-muted)]">
                  ·
                </span>
                <span className={statusTextTone(p.status)}>{statusText}</span>
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
