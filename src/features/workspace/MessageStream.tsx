import {
  AlertTriangle,
  ArrowDown,
  ArrowUpRight,
  ChevronUp,
  Clock,
  FileText,
  GitBranch,
  Pause,
  Play,
  RefreshCw,
  Square,
  StopCircle,
  Terminal,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { EmptyState } from '../../components/EmptyState';
import { EscalationBanner } from '../../components/EscalationBanner';
import { PermissionCard } from '../../components/PermissionCard';
import { StatusBadge } from '../../components/StatusBadge';
import {
  getPendingEscalations,
  getPendingPermissions,
} from '../../domain/selectors';
import { getParticipantRoles } from '../../domain/teamValidation';
import type { CapabilityFlag, GeneralFeedItem, Message } from '../../domain/types';
import { PT_BR } from '../../i18n/ptBR';
import { MarkdownView } from './MarkdownView';
import { useWorkspace } from './WorkspaceContext';

const PAGE_SIZE = 40;

function formatClock(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString('pt-BR', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return iso;
  }
}

function getInitials(name: string): string {
  const cleaned = name.trim();
  if (!cleaned) return '?';
  const parts = cleaned.split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 1).toUpperCase();
  return `${parts[0][0] ?? ''}${parts[1][0] ?? ''}`.toUpperCase();
}

function capabilityDisabledReason(
  cap: CapabilityFlag | undefined,
  actionLabel: string,
): string | undefined {
  if (cap === true) return undefined;
  if (cap === false) {
    return `${actionLabel} indisponível: capacidade não suportada pela conexão configurada.`;
  }
  return `${actionLabel} indisponível: capacidade desconhecida no catálogo atual.`;
}

function isRoutineActivityItem(item: GeneralFeedItem): boolean {
  if (
    item.kind === 'status_change' &&
    (item.actorLabel === 'Operação' ||
      /falha operacional|erro operacional|indispon|recusad|bloquead/i.test(
        item.summary,
      ))
  ) {
    return false;
  }
  return (
    item.kind === 'task_delegated' ||
    item.kind === 'task_progress' ||
    item.kind === 'context_revision' ||
    item.kind === 'status_change'
  );
}

export function MessageStream() {
  const {
    store,
    activeConversation,
    activeTabId,
    setMainSurface,
    highlightedEvent,
    navigateToOrigin,
    getSavedScrollTop,
    saveScrollTop,
    controlExecution,
    respondPermission,
    resolveEscalation,
    coreConnectWs,
  } = useWorkspace();

  const scrollRef = useRef<HTMLDivElement>(null);
  const [visibleLimit, setVisibleLimit] = useState(PAGE_SIZE);
  const [hasNewWhileScrolledUp, setHasNewWhileScrolledUp] = useState(false);
  const isAtBottomRef = useRef(true);
  const prevCountRef = useRef(0);

  const convId = activeConversation?.conversation.id ?? '';
  const isGeneral = activeTabId === 'general';

  const generalItems: GeneralFeedItem[] = useMemo(
    () => (activeConversation && isGeneral ? activeConversation.generalFeed : []),
    [activeConversation, isGeneral],
  );

  const tabMessages: Message[] = useMemo(
    () =>
      activeConversation && !isGeneral
        ? activeConversation.messagesByTab[activeTabId] ?? []
        : [],
    [activeConversation, activeTabId, isGeneral],
  );

  const totalItems = isGeneral ? generalItems.length : tabMessages.length;

  useEffect(() => {
    setVisibleLimit(PAGE_SIZE);
    setHasNewWhileScrolledUp(false);
    prevCountRef.current = totalItems;

    const el = scrollRef.current;
    if (!el || !convId) return;
    const saved = getSavedScrollTop(convId, activeTabId);
    if (saved !== undefined) {
      el.scrollTop = saved;
      isAtBottomRef.current =
        el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    } else {
      el.scrollTop = el.scrollHeight;
      isAtBottomRef.current = true;
    }
  }, [convId, activeTabId]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (totalItems > prevCountRef.current) {
      if (isAtBottomRef.current) {
        el.scrollTop = el.scrollHeight;
      } else {
        setHasNewWhileScrolledUp(true);
      }
    }
    prevCountRef.current = totalItems;
  }, [totalItems]);

  useEffect(() => {
    if (!highlightedEvent || !activeConversation) return;
    const targetId = highlightedEvent.eventId;

    if (isGeneral) {
      const idx = generalItems.findIndex(
        (item) => item.sourceEventId === targetId,
      );
      if (idx !== -1 && totalItems - idx > visibleLimit) {
        setVisibleLimit(totalItems - idx + 5);
      }
    } else {
      const idx = tabMessages.findIndex((m) => m.sourceEventId === targetId);
      if (idx !== -1 && totalItems - idx > visibleLimit) {
        setVisibleLimit(totalItems - idx + 5);
      }
    }

    const timer = window.setTimeout(() => {
      const escapedId =
        typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
          ? CSS.escape(targetId)
          : targetId;
      const targetEl = scrollRef.current?.querySelector<HTMLElement>(
        `[data-event-id="${escapedId}"]`,
      );
      targetEl?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 80);

    return () => window.clearTimeout(timer);
  }, [highlightedEvent, isGeneral, generalItems, tabMessages, totalItems]);

  if (!activeConversation || !store) {
    const coreConns = (store?.connections ?? []).filter((c) => c.mode === 'aion_core');
    const confirmedModelsCount = coreConns.reduce(
      (acc, c) => acc + c.availableModels.filter((m) => m.confirmed).length,
      0,
    );
    return (
      <div className="flex flex-1 items-center justify-center p-6">
        <div className="w-full max-w-lg rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-6 text-center shadow-sm">
          <h2 className="text-base font-semibold text-[var(--text-primary)]">
            Pronto para operar com seus agentes locais
          </h2>
          <p className="mt-2 text-xs leading-relaxed text-[var(--text-secondary)]">
            {store?.coreRuntimeStatus === 'unreachable'
              ? 'O servidor AionCore local não respondeu ainda. Inicie o aioncore.exe ou confira o endereço em Configurações.'
              : !store?.coreSessionAuthenticated
                ? 'O AionCore local exige autenticação WebUI uma vez no navegador para listar e controlar seus CLIs locais.'
                : coreConns.length > 0
                  ? `${coreConns.length} assistente(s) e ${confirmedModelsCount} modelo(s) real(is) carregado(s) do AionCore. Clique em "+ Novo projeto" na barra lateral para iniciar sua primeira conversa.`
                  : 'Sessão autenticada no AionCore. Sincronize o catálogo em Configurações para carregar seus CLIs e modelos disponíveis.'}
          </p>
          <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
            <button
              type="button"
              onClick={() => setMainSurface('settings')}
              className="rounded-md bg-[var(--accent)] px-4 py-2 text-xs font-semibold text-[var(--accent-contrast)] hover:bg-[var(--accent-hover)]"
            >
              {!store?.coreSessionAuthenticated
                ? 'Conectar e autenticar em Configurações'
                : 'Abrir Configurações e catálogo'}
            </button>
          </div>
        </div>
      </div>
    );
  }

  const activeParticipant = !isGeneral
    ? activeConversation.participants.find((p) => p.id === activeTabId)
    : undefined;
  const activeConnection = activeParticipant
    ? store.connections.find((c) => c.id === activeParticipant.connectionId) ??
      store.connections[0]
    : undefined;

  const currentTask = activeParticipant?.currentTaskId
    ? activeConversation.tasks.find(
        (t) => t.id === activeParticipant.currentTaskId,
      )
    : undefined;

  const pendingPermissions = getPendingPermissions(activeConversation).filter(
    (p) => isGeneral || p.participantId === activeTabId,
  );
  const pendingEscalations = getPendingEscalations(activeConversation).filter(
    (e) => isGeneral || e.participantId === activeTabId,
  );

  const startIndex = Math.max(0, totalItems - visibleLimit);
  const hasOlder = startIndex > 0;
  const visibleGeneral = isGeneral ? generalItems.slice(startIndex) : [];
  const visibleMessages = !isGeneral ? tabMessages.slice(startIndex) : [];
  const coordinatorId = activeConversation.conversation.coordinatorParticipantId;

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el || !convId) return;
    saveScrollTop(convId, activeTabId, el.scrollTop);
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    isAtBottomRef.current = nearBottom;
    if (nearBottom && hasNewWhileScrolledUp) {
      setHasNewWhileScrolledUp(false);
    }
  };

  const scrollToLatest = () => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    isAtBottomRef.current = true;
    setHasNewWhileScrolledUp(false);
  };

  const pauseDisabledReason = capabilityDisabledReason(
    activeConnection?.capabilities.supportsPauseQueue,
    'Pausar fila',
  );
  const interruptDisabledReason = capabilityDisabledReason(
    activeConnection?.capabilities.supportsInterrupt,
    'Interrupção',
  );
  const terminateDisabledReason = capabilityDisabledReason(
    activeConnection?.capabilities.supportsSessionTerminate,
    'Encerrar sessão',
  );

  return (
    <div className="relative flex min-h-0 flex-1 flex-col bg-[var(--bg-canvas)]">
      {/* Participant status & capability-gated controls bar */}
      {!isGeneral && activeParticipant && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border-hairline)] bg-[var(--bg-sidebar)] px-4 py-2 sm:px-6">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-[var(--text-secondary)]">
            <span className="font-semibold text-[var(--text-primary)]">
              {activeParticipant.displayName}
            </span>
            <span aria-hidden="true">·</span>
            <span>
              {getParticipantRoles(activeParticipant)
                .map((r) => PT_BR.roleLabels[r])
                .join(' + ')}
            </span>
            <span aria-hidden="true">·</span>
            <span>
              {activeParticipant.modelRef.displayName}
              {activeParticipant.modelRef.confirmation ===
                'unverified_preference' && ' (não verificado)'}
            </span>
            <span aria-hidden="true">·</span>
            <StatusBadge
              label={PT_BR.participantStatusLabels[activeParticipant.status]}
              tone={
                activeParticipant.status === 'running'
                  ? 'accent'
                  : activeParticipant.status === 'disconnected' ||
                      activeParticipant.status === 'failed'
                    ? 'danger'
                    : activeParticipant.status === 'completed'
                      ? 'success'
                      : 'neutral'
              }
              iconKind={
                activeParticipant.status === 'disconnected'
                  ? 'disconnected'
                  : activeParticipant.status === 'running'
                    ? 'running'
                    : activeParticipant.status === 'completed'
                      ? 'success'
                      : 'idle'
              }
            />
            {currentTask && (
              <>
                <span aria-hidden="true">·</span>
                <button
                  type="button"
                  onClick={() => navigateToOrigin({ taskId: currentTask.id })}
                  className="truncate underline decoration-[var(--border-strong)] underline-offset-2 hover:text-[var(--text-primary)]"
                >
                  Tarefa: {currentTask.title}
                </button>
              </>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              disabled={Boolean(pauseDisabledReason)}
              title={pauseDisabledReason}
              onClick={() =>
                void controlExecution(
                  activeConversation.conversation.executionStatus ===
                    'paused_queue'
                    ? 'resume_queue'
                    : 'pause_queue',
                )
              }
              className="inline-flex h-7 items-center gap-1 whitespace-nowrap rounded-md border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2.5 text-xs text-[var(--text-primary)] hover:border-[var(--border-strong)] disabled:cursor-not-allowed disabled:opacity-45"
            >
              {activeConversation.conversation.executionStatus ===
              'paused_queue' ? (
                <>
                  <Play className="h-3 w-3" aria-hidden="true" />
                  <span>{PT_BR.actions.resumeQueue}</span>
                </>
              ) : (
                <>
                  <Pause className="h-3 w-3" aria-hidden="true" />
                  <span>{PT_BR.actions.pauseQueue}</span>
                </>
              )}
            </button>

            {activeParticipant.status === 'running' && (
              <button
                type="button"
                disabled={Boolean(interruptDisabledReason)}
                title={interruptDisabledReason}
                onClick={() =>
                  void controlExecution(
                    'request_interrupt',
                    activeParticipant.id,
                  )
                }
                className="inline-flex h-7 items-center gap-1 whitespace-nowrap rounded-md border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2.5 text-xs text-[var(--status-warning)] hover:border-[var(--border-strong)] disabled:cursor-not-allowed disabled:opacity-45"
              >
                <StopCircle className="h-3 w-3" aria-hidden="true" />
                <span>{PT_BR.actions.requestInterrupt}</span>
              </button>
            )}

            {activeParticipant.status === 'disconnected' &&
              activeConversation.conversation.executionMode === 'demo' && (
                <button
                  type="button"
                  onClick={() => void coreConnectWs()}
                  className="inline-flex h-7 items-center gap-1 whitespace-nowrap rounded-md bg-[var(--accent)] px-2.5 text-xs font-semibold text-[var(--accent-contrast)] hover:bg-[var(--accent-hover)]"
                >
                  <RefreshCw className="h-3 w-3" aria-hidden="true" />
                  <span>{PT_BR.actions.reconnectAgent}</span>
                </button>
              )}

            {activeParticipant.status !== 'disconnected' && (
              <button
                type="button"
                disabled={Boolean(terminateDisabledReason)}
                title={terminateDisabledReason}
                onClick={() =>
                  void controlExecution(
                    'terminate_session',
                    activeParticipant.id,
                  )
                }
                className="inline-flex h-7 items-center gap-1 whitespace-nowrap rounded-md border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2.5 text-xs text-[var(--status-danger)] hover:border-[var(--border-strong)] disabled:cursor-not-allowed disabled:opacity-45"
              >
                <Square className="h-3 w-3" aria-hidden="true" />
                <span>{PT_BR.actions.terminateSession}</span>
              </button>
            )}
          </div>
        </div>
      )}

      {/* Scrollable conversation stream */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="min-h-0 flex-1 overflow-y-auto px-4 py-6 sm:px-8"
      >
        <div className="mx-auto max-w-[820px] space-y-5">
          {hasOlder && (
            <div className="flex justify-center pb-2">
              <button
                type="button"
                onClick={() => setVisibleLimit((v) => v + PAGE_SIZE)}
                className="inline-flex items-center gap-1.5 rounded-md border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-3 py-1.5 text-xs font-medium text-[var(--text-secondary)] hover:border-[var(--border-strong)] hover:text-[var(--text-primary)]"
              >
                <ChevronUp className="h-3.5 w-3.5" aria-hidden="true" />
                <span>
                  {PT_BR.loadOlderEvents} ({startIndex} restante(s))
                </span>
              </button>
            </div>
          )}

          {totalItems === 0 && (
            <EmptyState
              title={
                activeConversation.conversation.executionMode === 'aion_core' &&
                !activeConversation.conversation.externalTeamId
                  ? 'Equipe ainda não vinculada ao AionCore'
                  : PT_BR.emptyMessagesTitle
              }
              description={
                activeConversation.conversation.executionMode === 'aion_core'
                  ? activeConversation.conversation.externalTeamId
                    ? 'Equipe conectada ao AionCore local. Envie seu pedido no campo abaixo para iniciar o plano e a execução.'
                    : 'Conecte o runtime local, verifique os agentes disponíveis e crie a equipe desta conversa em Configurações.'
                  : PT_BR.emptyMessagesBody
              }
              action={
                activeConversation.conversation.executionMode === 'aion_core' &&
                !activeConversation.conversation.externalTeamId ? (
                  <button
                    type="button"
                    onClick={() => setMainSurface('settings')}
                    className="rounded-md bg-[var(--accent)] px-3.5 py-2 text-xs font-semibold text-[var(--accent-contrast)] hover:bg-[var(--accent-hover)]"
                  >
                    Configurar conexão e equipe
                  </button>
                ) : undefined
              }
            />
          )}

          {totalItems > 0 && (
            <div className="flex items-center gap-3 text-[11px] text-[var(--text-muted)]">
              <span className="h-px flex-1 bg-[var(--border-hairline)]" />
              <span>
                {activeConversation.conversation.executionMode === 'aion_core'
                  ? 'Histórico da execução · AionCore'
                  : 'Sessão demonstrativa local'}
              </span>
              <span className="h-px flex-1 bg-[var(--border-hairline)]" />
            </div>
          )}

          {isGeneral &&
            visibleGeneral.map((item) => {
              const isHighlighted =
                highlightedEvent?.eventId === item.sourceEventId;
              const isUser = item.kind === 'user_request';
              const isRoutine = isRoutineActivityItem(item);
              const isOpFailure =
                item.kind === 'status_change' &&
                (item.actorLabel === 'Operação' ||
                  /falha operacional|erro operacional|indispon/i.test(
                    item.summary,
                  ));

              if (isUser) {
                return (
                  <article
                    key={item.id}
                    data-event-id={item.sourceEventId}
                    className={`rounded-xl border px-5 py-4 transition-colors sm:ml-8 ${
                      isHighlighted
                        ? 'border-[var(--accent)] bg-[var(--accent-soft)]'
                        : 'border-[var(--border-strong)] bg-[var(--bg-surface)]'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2 text-xs">
                      <span className="font-semibold text-[var(--text-primary)]">
                        {item.actorLabel}
                      </span>
                      <time className="tabular-nums text-[11px] text-[var(--text-muted)]">
                        {formatClock(item.timestamp)}
                      </time>
                    </div>
                    <p className="mt-2 text-[14px] leading-[1.7] text-[var(--text-primary)]">
                      {item.summary}
                    </p>
                  </article>
                );
              }

              if (isRoutine && !isHighlighted) {
                const TimelineIcon =
                  item.kind === 'context_revision'
                    ? FileText
                    : item.kind === 'task_delegated'
                      ? GitBranch
                      : item.kind === 'task_progress'
                        ? Play
                        : Clock;
                return (
                  <div
                    key={item.id}
                    data-event-id={item.sourceEventId}
                    className="flex flex-wrap items-center gap-x-2.5 gap-y-1 py-0.5 text-xs text-[var(--text-secondary)] sm:ml-10"
                  >
                    <TimelineIcon
                      className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]"
                      aria-hidden="true"
                    />
                    <span className="min-w-0 flex-1 leading-relaxed">
                      <strong className="font-medium text-[var(--text-primary)]">
                        {item.actorLabel}:
                      </strong>{' '}
                      {item.summary}
                    </span>
                    <div className="flex items-center gap-2.5">
                      {item.targetTabId && item.targetTabId !== 'general' && (
                        <button
                          type="button"
                          onClick={() =>
                            navigateToOrigin({
                              tabId: item.targetTabId,
                              eventId: item.targetEventId,
                            })
                          }
                          className="inline-flex items-center gap-0.5 font-medium text-[var(--accent)] hover:underline"
                        >
                          <span>{item.detailLinkLabel ?? 'Ver execução'}</span>
                          <ArrowUpRight className="h-3 w-3" aria-hidden="true" />
                        </button>
                      )}
                      {item.targetTaskId && (
                        <button
                          type="button"
                          onClick={() =>
                            navigateToOrigin({ taskId: item.targetTaskId })
                          }
                          className="inline-flex items-center gap-0.5 font-medium text-[var(--accent)] hover:underline"
                        >
                          <span>Abrir tarefa</span>
                          <ArrowUpRight className="h-3 w-3" aria-hidden="true" />
                        </button>
                      )}
                      {item.targetContextVersion !== undefined && (
                        <button
                          type="button"
                          onClick={() =>
                            navigateToOrigin({
                              contextVersion: item.targetContextVersion,
                            })
                          }
                          className="inline-flex items-center gap-0.5 font-medium text-[var(--accent)] hover:underline"
                        >
                          <span>
                            Abrir Contexto v{item.targetContextVersion}
                          </span>
                          <ArrowUpRight className="h-3 w-3" aria-hidden="true" />
                        </button>
                      )}
                      <time className="tabular-nums text-[11px] text-[var(--text-muted)]">
                        {formatClock(item.timestamp)}
                      </time>
                    </div>
                  </div>
                );
              }

              const isCoordinatorActor =
                item.targetTabId === coordinatorId ||
                item.actorRoleLabel?.toLowerCase().includes('coordenador');

              return (
                <article
                  key={item.id}
                  data-event-id={item.sourceEventId}
                  className={`grid grid-cols-[30px_minmax(0,1fr)] gap-3 rounded-xl px-1 py-1 transition-colors ${
                    isHighlighted
                      ? 'border border-[var(--accent)] bg-[var(--accent-soft)] p-3.5'
                      : isOpFailure
                        ? 'border border-[var(--status-danger)]/40 bg-[var(--status-danger-soft)] p-3.5'
                        : ''
                  }`}
                >
                  <div
                    className={`flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-lg text-[11px] font-semibold ${
                      isCoordinatorActor
                        ? 'bg-[var(--accent-soft)] text-[var(--accent)]'
                        : 'bg-[var(--bg-elevated)] text-[var(--text-secondary)]'
                    }`}
                    aria-hidden="true"
                  >
                    {getInitials(item.actorLabel)}
                  </div>

                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-semibold text-[var(--text-primary)]">
                          {item.actorLabel}
                        </span>
                        {item.actorRoleLabel && (
                          <span className="text-[11px] text-[var(--text-muted)]">
                            {item.actorRoleLabel}
                          </span>
                        )}
                      </div>
                      <time className="tabular-nums text-[11px] text-[var(--text-muted)]">
                        {formatClock(item.timestamp)}
                      </time>
                    </div>

                    <p className="mt-1.5 text-[14px] leading-[1.7] text-[var(--text-primary)]">
                      {item.summary}
                    </p>

                    <details className="mt-1 text-[11px] text-[var(--text-muted)]">
                      <summary className="cursor-pointer select-none hover:text-[var(--text-secondary)]">
                        Detalhes técnicos
                      </summary>
                      <div className="mt-0.5 flex flex-wrap gap-x-2 font-mono text-[10px] text-[var(--text-secondary)]">
                        <span>evento={item.sourceEventId}</span>
                        {item.targetTaskId && <span>tarefa={item.targetTaskId}</span>}
                      </div>
                    </details>

                    {item.kind === 'coordinator_plan' &&
                      activeConversation.tasks.length > 0 && (
                        <div className="mt-3 overflow-hidden rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-surface)]">
                          <div className="flex items-center justify-between border-b border-[var(--border-hairline)] px-3.5 py-2 text-xs font-semibold text-[var(--text-primary)]">
                            <span>Plano de trabalho</span>
                            <span className="tabular-nums text-[11px] font-normal text-[var(--text-muted)]">
                              {activeConversation.tasks.length} tarefa(s)
                            </span>
                          </div>
                          {activeConversation.tasks.map((task, idx) => (
                            <div
                              key={task.id}
                              className="flex items-center gap-3 border-t border-[var(--border-hairline)] px-3.5 py-2 text-xs first:border-t-0"
                            >
                              <span className="tabular-nums text-[11px] text-[var(--text-muted)]">
                                {String(idx + 1).padStart(2, '0')}
                              </span>
                              <button
                                type="button"
                                onClick={() =>
                                  navigateToOrigin({ taskId: task.id })
                                }
                                className="min-w-0 flex-1 truncate text-left text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                              >
                                {task.title}
                              </button>
                              <span
                                className={`shrink-0 text-[11px] font-medium ${
                                  task.status === 'completed'
                                    ? 'text-[var(--status-success)]'
                                    : task.status === 'running'
                                      ? 'text-[var(--accent)]'
                                      : task.status === 'failed' ||
                                          task.status === 'changes_requested'
                                        ? 'text-[var(--status-warning)]'
                                        : 'text-[var(--text-muted)]'
                                }`}
                              >
                                {PT_BR.taskStatusLabels[task.status]}
                              </span>
                            </div>
                          ))}
                        </div>
                      )}

                    {(item.targetTabId ||
                      item.targetTaskId ||
                      item.targetContextVersion !== undefined) && (
                      <div className="mt-2 flex flex-wrap items-center gap-3 text-xs">
                        {item.targetTabId && item.targetTabId !== 'general' && (
                          <button
                            type="button"
                            onClick={() =>
                              navigateToOrigin({
                                tabId: item.targetTabId,
                                eventId: item.targetEventId,
                              })
                            }
                            className="inline-flex items-center gap-1 font-medium text-[var(--accent)] hover:underline"
                          >
                            <span>{item.detailLinkLabel ?? 'Ver execução'}</span>
                            <ArrowUpRight className="h-3 w-3" aria-hidden="true" />
                          </button>
                        )}
                        {item.targetTaskId && (
                          <button
                            type="button"
                            onClick={() =>
                              navigateToOrigin({ taskId: item.targetTaskId })
                            }
                            className="inline-flex items-center gap-1 font-medium text-[var(--accent)] hover:underline"
                          >
                            <span>Abrir tarefa</span>
                            <ArrowUpRight className="h-3 w-3" aria-hidden="true" />
                          </button>
                        )}
                        {item.targetContextVersion !== undefined && (
                          <button
                            type="button"
                            onClick={() =>
                              navigateToOrigin({
                                contextVersion: item.targetContextVersion,
                              })
                            }
                            className="inline-flex items-center gap-1 font-medium text-[var(--accent)] hover:underline"
                          >
                            <span>
                              Abrir Contexto v{item.targetContextVersion}
                            </span>
                            <ArrowUpRight className="h-3 w-3" aria-hidden="true" />
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                </article>
              );
            })}

          {!isGeneral &&
            visibleMessages.map((msg) => {
              const isHighlighted =
                highlightedEvent?.eventId === msg.sourceEventId;
              const isSystemRecord = msg.authorType === 'system';
              const isUserMsg = msg.authorType === 'user';
              const hasParseWarning =
                msg.parseStatus === 'incomplete' ||
                msg.parseStatus === 'invalid';

              if (isUserMsg) {
                return (
                  <article
                    key={msg.id}
                    data-event-id={msg.sourceEventId}
                    className={`rounded-xl border px-5 py-4 transition-colors sm:ml-8 ${
                      isHighlighted
                        ? 'border-[var(--accent)] bg-[var(--accent-soft)]'
                        : 'border-[var(--border-strong)] bg-[var(--bg-surface)]'
                    }`}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                      <span className="font-semibold text-[var(--text-primary)]">
                        {msg.authorLabel}
                      </span>
                      <time className="tabular-nums text-[11px] text-[var(--text-muted)]">
                        {formatClock(msg.timestamp)}
                      </time>
                    </div>
                    <div className="mt-2">
                      <MarkdownView content={msg.bodyMarkdown} />
                    </div>
                  </article>
                );
              }

              if (isSystemRecord && !hasParseWarning) {
                return (
                  <article
                    key={msg.id}
                    data-event-id={msg.sourceEventId}
                    className={`flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 rounded-lg px-2 py-1.5 text-xs transition-colors sm:ml-10 ${
                      isHighlighted
                        ? 'border border-[var(--accent)] bg-[var(--accent-soft)]'
                        : 'text-[var(--text-secondary)]'
                    }`}
                  >
                    <div className="min-w-0 flex-1">
                      <span className="font-medium text-[var(--text-primary)]">
                        {msg.authorLabel}
                      </span>
                      <span className="mx-1.5 text-[var(--text-muted)]">·</span>
                      <span>Registro de execução</span>
                      {msg.delivery?.note && (
                        <>
                          <span className="mx-1.5 text-[var(--text-muted)]">
                            ·
                          </span>
                          <span>{msg.delivery.note}</span>
                        </>
                      )}
                      <div className="mt-1">
                        <MarkdownView content={msg.bodyMarkdown} />
                      </div>
                    </div>
                    <time className="tabular-nums shrink-0 text-[11px] text-[var(--text-muted)]">
                      {formatClock(msg.timestamp)}
                    </time>
                  </article>
                );
              }

              return (
                <article
                  key={msg.id}
                  data-event-id={msg.sourceEventId}
                  className={`grid grid-cols-[30px_minmax(0,1fr)] gap-3 rounded-xl px-1 py-1 transition-colors ${
                    isHighlighted
                      ? 'border border-[var(--accent)] bg-[var(--accent-soft)] p-3.5'
                      : ''
                  }`}
                >
                  <div
                    className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-lg bg-[var(--bg-elevated)] text-[11px] font-semibold text-[var(--text-secondary)]"
                    aria-hidden="true"
                  >
                    {getInitials(msg.authorLabel)}
                  </div>

                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-semibold text-[var(--text-primary)]">
                          {msg.authorLabel}
                        </span>
                        {msg.delivery?.note && (
                          <span className="text-[11px] text-[var(--text-secondary)]">
                            {msg.delivery.note}
                          </span>
                        )}
                        {msg.originSource && (
                          <span className="text-[11px] text-[var(--text-muted)]">
                            {msg.originSource === 'aion_core'
                              ? 'Core'
                              : msg.originSource === 'demo_simulation'
                                ? 'Simulação'
                                : msg.originSource === 'user'
                                  ? 'Usuário'
                                  : 'Local'}
                          </span>
                        )}
                      </div>
                      <time className="tabular-nums text-[11px] text-[var(--text-muted)]">
                        {formatClock(msg.timestamp)}
                      </time>
                    </div>

                    <details className="mt-1 text-[11px] text-[var(--text-muted)]">
                      <summary className="cursor-pointer select-none hover:text-[var(--text-secondary)]">
                        Detalhes técnicos
                      </summary>
                      <div className="mt-0.5 flex flex-wrap gap-x-2 font-mono text-[10px] text-[var(--text-secondary)]">
                        <span>evento={msg.sourceEventId}</span>
                        {msg.externalMessageId && (
                          <span>extMsg={msg.externalMessageId}</span>
                        )}
                      </div>
                    </details>

                    {hasParseWarning && (
                      <div className="mt-2 flex items-center gap-1.5 rounded-md bg-[var(--status-warning-soft)] px-3 py-2 text-xs text-[var(--status-warning)]">
                        <AlertTriangle
                          className="h-3.5 w-3.5 shrink-0"
                          aria-hidden="true"
                        />
                        <span>
                          Saída estruturada ({msg.parseStatus}) — revisão manual
                          necessária
                          {msg.parseReason ? `: ${msg.parseReason}` : '.'}
                        </span>
                      </div>
                    )}

                    <div className="mt-2">
                      <MarkdownView content={msg.bodyMarkdown} />
                    </div>

                    {msg.toolOutputs && msg.toolOutputs.length > 0 && (
                      <div className="mt-3 space-y-2 border-t border-[var(--border-hairline)] pt-2.5">
                        {msg.toolOutputs.map((tool) => (
                          <div
                            key={tool.id}
                            className="rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-3.5 py-2.5 text-xs"
                          >
                            <div className="flex flex-wrap items-center justify-between gap-2 font-medium text-[var(--text-primary)]">
                              <span className="inline-flex items-center gap-1.5">
                                <Terminal
                                  className="h-3.5 w-3.5 text-[var(--accent)]"
                                  aria-hidden="true"
                                />
                                <span>{tool.label}</span>
                              </span>
                              <span className="text-[11px] text-[var(--text-muted)]">
                                {tool.isSimulated ? 'Simulado' : 'Core'}
                              </span>
                            </div>
                            {tool.commandSimulated && (
                              <div className="mt-1 overflow-x-auto font-mono text-[11px] text-[var(--text-secondary)]">
                                $ {tool.commandSimulated}
                              </div>
                            )}
                            <p className="mt-1 text-[var(--text-secondary)]">
                              {tool.summary}
                            </p>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </article>
              );
            })}

          {pendingPermissions.map((req) => (
            <PermissionCard
              key={req.id}
              request={req}
              participant={activeConversation.participants.find(
                (p) => p.id === req.participantId,
              )}
              taskTitle={
                req.taskId
                  ? activeConversation.tasks.find((t) => t.id === req.taskId)?.title
                  : undefined
              }
              onApprove={(id) => void respondPermission(id, 'approved')}
              onDeny={(id) => void respondPermission(id, 'denied')}
            />
          ))}

          {pendingEscalations.map((esc) => (
            <EscalationBanner
              key={esc.id}
              escalation={esc}
              participant={activeConversation.participants.find(
                (p) => p.id === esc.participantId,
              )}
              onApprove={(id) => void resolveEscalation(id, 'approved')}
              onDismiss={(id) => void resolveEscalation(id, 'dismissed')}
            />
          ))}
        </div>
      </div>

      {hasNewWhileScrolledUp && (
        <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
          <button
            type="button"
            onClick={scrollToLatest}
            className="pointer-events-auto inline-flex items-center gap-1.5 rounded-md border border-[var(--accent)] bg-[var(--bg-surface)] px-3 py-1.5 text-xs font-medium text-[var(--accent)] shadow-md hover:bg-[var(--bg-elevated)]"
          >
            <ArrowDown className="h-3.5 w-3.5" aria-hidden="true" />
            <span>{PT_BR.newMessagesButton}</span>
          </button>
        </div>
      )}
    </div>
  );
}
