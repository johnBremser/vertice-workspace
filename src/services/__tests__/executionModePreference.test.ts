import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConversationProjection, WorkspaceStoreState } from '../../domain/types';
import {
  createInitialWorkspaceState,
  DEMO_CONVERSATION_ID,
} from '../demoScenario';
import {
  DEFAULT_EXECUTION_MODE,
  loadExecutionModePreference,
  resolveBootstrapExecutionMode,
  saveExecutionModePreference,
} from '../executionModePreference';

function stubLocalStorage(initial: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initial));
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
      removeItem: (key: string) => {
        store.delete(key);
      },
      clear: () => store.clear(),
    },
  });
  return store;
}

function withConversation(
  state: WorkspaceStoreState,
  id: string,
  executionMode: 'demo' | 'aion_core',
): WorkspaceStoreState {
  const base = state.conversations[DEMO_CONVERSATION_ID];
  const projection = structuredClone(base) as ConversationProjection;
  projection.conversation = {
    ...projection.conversation,
    id,
    executionMode,
  };
  return {
    ...state,
    conversations: { ...state.conversations, [id]: projection },
  };
}

describe('Preferência de modo de operação (V6-11)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('usa AionCore local como modo padrão de abertura', () => {
    expect(DEFAULT_EXECUTION_MODE).toBe('aion_core');
  });

  it('não registra preferência quando o usuário nunca escolheu um modo', () => {
    stubLocalStorage();
    expect(loadExecutionModePreference()).toBeNull();
  });

  it('persiste e lê a preferência explícita escolhida em Configurações', () => {
    stubLocalStorage();
    saveExecutionModePreference('demo');
    expect(loadExecutionModePreference()).toBe('demo');
    saveExecutionModePreference('aion_core');
    expect(loadExecutionModePreference()).toBe('aion_core');
  });

  it('ignora preferência corrompida ou inválida', () => {
    stubLocalStorage({
      aion_desk_mode_pref_v1: '{nao é json',
    });
    expect(loadExecutionModePreference()).toBeNull();
    stubLocalStorage({
      aion_desk_mode_pref_v1: JSON.stringify({ mode: 'outro_modo' }),
    });
    expect(loadExecutionModePreference()).toBeNull();
  });

  it('aplica a preferência explícita acima de qualquer estado persistido', () => {
    const seeded = createInitialWorkspaceState();
    expect(
      resolveBootstrapExecutionMode({ explicitPreference: 'demo', loaded: seeded }),
    ).toBe('demo');
    expect(
      resolveBootstrapExecutionMode({
        explicitPreference: 'aion_core',
        loaded: seeded,
      }),
    ).toBe('aion_core');
  });

  it('segue o modo padrão quando o workspace só tem o cenário de demonstração semeado', () => {
    const seeded = createInitialWorkspaceState();
    expect(resolveBootstrapExecutionMode({ explicitPreference: null, loaded: seeded })).toBe(
      'aion_core',
    );
  });

  it('preserva o modo de workspaces de simulação criados pelo usuário', () => {
    const seeded = createInitialWorkspaceState();
    const legacyDemo = withConversation(seeded, 'conv_meu_demo', 'demo');
    expect(
      resolveBootstrapExecutionMode({ explicitPreference: null, loaded: legacyDemo }),
    ).toBe('demo');
  });

  it('preserva o modo Core de workspaces reais', () => {
    const seeded = createInitialWorkspaceState();
    const coreConversation = withConversation(seeded, 'conv_core_real', 'aion_core')
      .conversations['conv_core_real'];
    const coreWorkspace: WorkspaceStoreState = {
      ...seeded,
      executionMode: 'aion_core',
      conversations: { conv_core_real: coreConversation },
    };
    expect(
      resolveBootstrapExecutionMode({ explicitPreference: null, loaded: coreWorkspace }),
    ).toBe('aion_core');
  });

  it('usa o modo do estado carregado quando não há conversas persistidas', () => {
    const seeded = createInitialWorkspaceState();
    const empty: WorkspaceStoreState = {
      ...seeded,
      executionMode: 'aion_core',
      conversations: {},
    };
    expect(resolveBootstrapExecutionMode({ explicitPreference: null, loaded: empty })).toBe(
      'aion_core',
    );
  });
});
