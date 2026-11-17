import { ArrowUp } from 'lucide-react';
import { useState, type KeyboardEvent } from 'react';
import { APP_BRAND } from '../../config/brand';
import { getParticipantRoles } from '../../domain/teamValidation';
import { PT_BR } from '../../i18n/ptBR';
import { useWorkspace } from './WorkspaceContext';

export function Composer() {
  const {
    store,
    activeConversation,
    activeTabId,
    getDraft,
    setDraft,
    sendMessage,
  } = useWorkspace();

  const [promoteToContext, setPromoteToContext] = useState(false);
  const [sending, setSending] = useState(false);

  if (!activeConversation) return null;

  const convId = activeConversation.conversation.id;
  const draft = getDraft(convId, activeTabId);
  const isGeneral = activeTabId === 'general';
  const isCoreMode = store?.executionMode === 'aion_core';

  const targetParticipant = isGeneral
    ? activeConversation.participants.find(
        (p) =>
          p.id === activeConversation.conversation.coordinatorParticipantId,
      )
    : activeConversation.participants.find((p) => p.id === activeTabId);

  const handleSubmit = async () => {
    const trimmed = draft.trim();
    if (!trimmed || sending) return;
    setSending(true);
    try {
      await sendMessage(trimmed, isGeneral ? promoteToContext : false);
      if (isGeneral) {
        setPromoteToContext(false);
      }
    } finally {
      setSending(false);
    }
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleSubmit();
    }
  };

  const placeholder = isGeneral
    ? PT_BR.composerPlaceholderGeneral
    : PT_BR.composerPlaceholderAgent(
        targetParticipant?.displayName ?? activeTabId,
      );

  const targetRolesLabel = targetParticipant
    ? getParticipantRoles(targetParticipant)
        .map((r) => PT_BR.roleLabels[r])
        .join(' + ')
    : 'Participante';

  return (
    <div className="shrink-0 bg-[var(--bg-canvas)] px-4 pt-2 pb-4 sm:px-8">
      <div className="mx-auto max-w-[820px]">
        <div className="rounded-[14px] border border-[var(--border-strong)] bg-[var(--bg-surface)] px-4 py-3 transition-colors focus-within:border-[var(--accent)]">
          <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-[var(--text-muted)]">
            <span>
              {isGeneral ? (
                <>
                  {PT_BR.composerTargetGeneral} ·{' '}
                  <strong className="font-medium text-[var(--text-secondary)]">
                    {targetParticipant?.displayName ?? 'não definido'}
                  </strong>
                </>
              ) : (
                <span className="font-medium text-[var(--text-secondary)]">
                  {PT_BR.composerTargetAgent(
                    targetParticipant?.displayName ?? activeTabId,
                    targetRolesLabel,
                  )}
                </span>
              )}
            </span>
            <span className="hidden sm:inline">
              Rascunho preservado por aba
            </span>
          </div>

          <label htmlFor="aion-composer-input" className="sr-only">
            {placeholder}
          </label>
          <textarea
            id="aion-composer-input"
            rows={2}
            value={draft}
            onChange={(e) => setDraft(convId, activeTabId, e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            className="mt-2 block min-h-[50px] max-h-40 w-full resize-y bg-transparent text-[14px] leading-relaxed text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none"
          />

          <div className="mt-2 flex flex-wrap items-center justify-between gap-3 pt-1">
            <div className="min-w-0">
              {isGeneral && (
                <label className="inline-flex cursor-pointer items-center gap-2 text-xs text-[var(--text-secondary)]">
                  <input
                    type="checkbox"
                    checked={promoteToContext}
                    onChange={(e) => setPromoteToContext(e.target.checked)}
                    className="h-3.5 w-3.5 rounded border-[var(--border-strong)] accent-[var(--accent)]"
                  />
                  <span>{PT_BR.promoteToContextLabel}</span>
                </label>
              )}
            </div>

            <div className="flex items-center gap-3">
              <span className="hidden text-[11px] text-[var(--text-muted)] md:inline">
                Shift + Enter para nova linha
              </span>
              <button
                type="button"
                disabled={!draft.trim() || sending}
                onClick={() => void handleSubmit()}
                aria-label={PT_BR.sendButton}
                className="inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg bg-[var(--accent)] px-3.5 text-xs font-semibold text-[var(--accent-contrast)] transition-colors hover:bg-[var(--accent-hover)] disabled:cursor-not-allowed disabled:opacity-45"
              >
                <span>{PT_BR.sendButton}</span>
                <ArrowUp className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </div>
          </div>
        </div>

        <div className="mt-2 text-center text-[10px] text-[var(--text-muted)]">
          {APP_BRAND.technicalSignature} ·{' '}
          {isCoreMode
            ? 'Conexão local HTTP/WS'
            : 'Simulação determinística no navegador'}
        </div>
      </div>
    </div>
  );
}
