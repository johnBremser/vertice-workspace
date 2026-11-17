import {
  ChevronDown,
  FastForward,
  Pause,
  Play,
  RotateCcw,
  SlidersHorizontal,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { hasRole } from '../../domain/teamValidation';
import { PT_BR } from '../../i18n/ptBR';
import { useWorkspace } from './WorkspaceContext';

export function DemoControlsMenu() {
  const {
    autoPlaying,
    activeConversation,
    hasDemoControls,
    stepScenario,
    toggleAutoPlay,
    resetDemo,
    triggerDisconnectResume,
    triggerPermission,
    triggerDuplicateEvent,
    triggerOutOfOrderGap,
    triggerOperationalFailure,
    triggerStress2000,
  } = useWorkspace();

  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
      }
    };
    window.addEventListener('mousedown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  if (!hasDemoControls || activeConversation?.conversation.executionMode === 'aion_core') {
    return null;
  }

  const isCompleted =
    (activeConversation?.conversation.scenarioStepIndex ?? 0) >= 12 ||
    activeConversation?.conversation.executionStatus === 'completed';

  const activeExecutor = activeConversation?.participants.find(
    (p) => !p.archived && hasRole(p, 'executor'),
  );

  return (
    <div ref={containerRef} className="relative">
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={stepScenario}
          disabled={!activeConversation || isCompleted}
          aria-label={
            isCompleted
              ? 'Cenário demonstrativo concluído'
              : PT_BR.demoControls.stepForward
          }
          title={
            isCompleted
              ? 'Cenário demonstrativo concluído'
              : PT_BR.demoControls.stepForward
          }
          className="inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-md border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2.5 text-xs font-medium text-[var(--text-secondary)] transition-colors hover:border-[var(--border-strong)] hover:bg-[var(--bg-elevated)] hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-45"
        >
          <FastForward
            className="h-3.5 w-3.5 text-[var(--accent)]"
            aria-hidden="true"
          />
          <span className="hidden sm:inline">{PT_BR.demoControls.stepForward}</span>
        </button>

        <button
          type="button"
          onClick={toggleAutoPlay}
          disabled={!activeConversation || (isCompleted && !autoPlaying)}
          aria-pressed={autoPlaying}
          aria-label={
            autoPlaying
              ? PT_BR.demoControls.pauseAuto
              : PT_BR.demoControls.autoPlay
          }
          className="inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-md border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2.5 text-xs font-medium text-[var(--text-secondary)] transition-colors hover:border-[var(--border-strong)] hover:bg-[var(--bg-elevated)] hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-45"
        >
          {autoPlaying ? (
            <>
              <Pause
                className="h-3.5 w-3.5 text-[var(--status-warning)]"
                aria-hidden="true"
              />
              <span className="hidden md:inline">{PT_BR.demoControls.pauseAuto}</span>
            </>
          ) : (
            <>
              <Play
                className="h-3.5 w-3.5 text-[var(--accent)]"
                aria-hidden="true"
              />
              <span className="hidden 2xl:inline">
                {PT_BR.demoControls.autoPlay}
              </span>
            </>
          )}
        </button>

        <button
          type="button"
          aria-expanded={open}
          aria-haspopup="menu"
          onClick={() => setOpen((o) => !o)}
          className="inline-flex h-8 items-center gap-1 whitespace-nowrap rounded-md border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2 text-xs font-medium text-[var(--text-secondary)] transition-colors hover:border-[var(--border-strong)] hover:bg-[var(--bg-elevated)] hover:text-[var(--text-primary)]"
          aria-label="Mais controles de simulação"
        >
          <SlidersHorizontal className="h-3.5 w-3.5" aria-hidden="true" />
          <ChevronDown className="h-3 w-3" aria-hidden="true" />
        </button>
      </div>

      {open && (
        <div
          role="menu"
          aria-label="Cenários de demonstração"
          className="absolute right-0 z-40 mt-2 w-80 max-w-[calc(100vw-2rem)] rounded-lg border border-[var(--border-strong)] bg-[var(--bg-surface)] p-2 shadow-lg"
        >
          <div className="px-2 py-1.5 text-[11px] font-semibold tracking-wide text-[var(--text-muted)] uppercase">
            {PT_BR.demoControls.edgeScenariosTitle}
          </div>

          <button
            type="button"
            role="menuitem"
            onClick={() => {
              triggerDisconnectResume(activeExecutor?.id);
              setOpen(false);
            }}
            className="flex w-full items-center justify-between rounded-md px-2.5 py-2 text-left text-xs text-[var(--text-primary)] hover:bg-[var(--bg-elevated)]"
          >
            <span>{PT_BR.demoControls.disconnectResume}</span>
          </button>

          <button
            type="button"
            role="menuitem"
            onClick={() => {
              triggerPermission();
              setOpen(false);
            }}
            className="flex w-full items-center justify-between rounded-md px-2.5 py-2 text-left text-xs text-[var(--text-primary)] hover:bg-[var(--bg-elevated)]"
          >
            <span>{PT_BR.demoControls.requestPermission}</span>
          </button>

          <button
            type="button"
            role="menuitem"
            onClick={() => {
              triggerDuplicateEvent();
              setOpen(false);
            }}
            className="flex w-full items-center justify-between rounded-md px-2.5 py-2 text-left text-xs text-[var(--text-primary)] hover:bg-[var(--bg-elevated)]"
          >
            <span>{PT_BR.demoControls.duplicateEvent}</span>
          </button>

          <button
            type="button"
            role="menuitem"
            onClick={() => {
              triggerOutOfOrderGap();
              setOpen(false);
            }}
            className="flex w-full items-center justify-between rounded-md px-2.5 py-2 text-left text-xs text-[var(--text-primary)] hover:bg-[var(--bg-elevated)]"
          >
            <span>{PT_BR.demoControls.outOfOrderGap}</span>
          </button>

          <button
            type="button"
            role="menuitem"
            onClick={() => {
              triggerOperationalFailure();
              setOpen(false);
            }}
            className="flex w-full items-center justify-between rounded-md px-2.5 py-2 text-left text-xs text-[var(--text-primary)] hover:bg-[var(--bg-elevated)]"
          >
            <span>{PT_BR.demoControls.operationalFailure}</span>
          </button>

          <button
            type="button"
            role="menuitem"
            onClick={() => {
              triggerStress2000();
              setOpen(false);
            }}
            className="flex w-full items-center justify-between rounded-md px-2.5 py-2 text-left text-xs text-[var(--text-primary)] hover:bg-[var(--bg-elevated)]"
          >
            <span>{PT_BR.demoControls.stress2000}</span>
          </button>

          <div className="my-1.5 border-t border-[var(--border-hairline)]" />

          <button
            type="button"
            role="menuitem"
            onClick={() => {
              void resetDemo();
              setOpen(false);
            }}
            className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-xs font-medium text-[var(--status-warning)] hover:bg-[var(--bg-elevated)]"
          >
            <RotateCcw className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span>{PT_BR.demoControls.resetDemo}</span>
          </button>
        </div>
      )}
    </div>
  );
}
