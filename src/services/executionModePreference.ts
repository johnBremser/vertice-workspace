import type { ExecutionMode, WorkspaceStoreState } from '../domain/types';
import {
  isDemoSeedOnlyState,
  isDemoWorkspaceState,
} from './demoScenario';

const MODE_PREF_KEY = 'aion_desk_mode_pref_v1';

/**
 * Default operating mode for a fresh workspace.
 *
 * The workspace opens directly in "AionCore local" mode (real HTTP/WS against the
 * local Core) instead of the deterministic simulation. The simulation remains fully
 * available through Settings -> "Modo de operação do workspace"; an explicit choice
 * made there is persisted and always wins over this default.
 */
export const DEFAULT_EXECUTION_MODE: ExecutionMode = 'aion_core';

/**
 * Reads the explicit operating-mode preference saved by the user.
 *
 * Returns `null` when the user never chose a mode, so callers can distinguish
 * "no explicit choice" from "explicitly chose the simulation".
 */
export function loadExecutionModePreference(): ExecutionMode | null {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null;
    const raw = window.localStorage.getItem(MODE_PREF_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { mode?: string };
    return parsed.mode === 'aion_core' || parsed.mode === 'demo'
      ? parsed.mode
      : null;
  } catch {
    return null;
  }
}

/**
 * Persists the operating-mode preference chosen in Settings. Non-critical write
 * failures never interrupt the workspace flow.
 */
export function saveExecutionModePreference(mode: ExecutionMode): void {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return;
    window.localStorage.setItem(
      MODE_PREF_KEY,
      JSON.stringify({ mode, savedAt: new Date().toISOString() }),
    );
  } catch {
    // Non-critical preference write failure does not interrupt the workspace flow.
  }
}

/**
 * Resolves the operating mode used to bootstrap the workspace.
 *
 * 1. an explicit preference chosen in Settings always wins;
 * 2. a workspace holding only the seeded demonstration scenario is not an explicit
 *    choice, so it follows the default (AionCore local);
 * 3. any other persisted workspace keeps its own mode, so legacy simulations are
 *    never hijacked.
 */
export function resolveBootstrapExecutionMode(input: {
  explicitPreference: ExecutionMode | null;
  loaded: WorkspaceStoreState;
}): ExecutionMode {
  if (input.explicitPreference) return input.explicitPreference;
  if (isDemoSeedOnlyState(input.loaded)) return DEFAULT_EXECUTION_MODE;
  if (isDemoWorkspaceState(input.loaded)) return 'demo';
  return input.loaded.executionMode;
}
