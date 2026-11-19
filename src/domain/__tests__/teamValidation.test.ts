import { describe, expect, it } from 'vitest';
import { selectableConnectionsForMode } from '../teamValidation';

const connections = [
  { id: 'conn_codex_demo', displayName: 'Codex (Demonstração)', mode: 'demo' as const },
  { id: 'conn_claude_demo', displayName: 'Claude (Demonstração)', mode: 'demo' as const },
  { id: 'conn_codex_core', displayName: 'Codex CLI', mode: 'aion_core' as const },
  { id: 'conn_cursor_core', displayName: 'Cursor', mode: 'aion_core' as const },
];

describe('selectableConnectionsForMode (V6-12)', () => {
  it('oferece apenas conexões reais do Core no modo AionCore local', () => {
    const result = selectableConnectionsForMode(
      connections,
      'conn_codex_demo',
      'demo',
      'aion_core',
    );
    expect(result.map((c) => c.id)).toEqual([
      'conn_codex_demo',
      'conn_codex_core',
      'conn_cursor_core',
    ]);
  });

  it('permite migrar um participante preso na conexão de demonstração', () => {
    const result = selectableConnectionsForMode(
      connections,
      'conn_codex_demo',
      'demo',
      'aion_core',
    );
    expect(result.some((c) => c.id === 'conn_codex_core')).toBe(true);
    expect(result.some((c) => c.id === 'conn_claude_demo')).toBe(false);
  });

  it('preserva o comportamento do modo de simulação', () => {
    const result = selectableConnectionsForMode(
      connections,
      'conn_codex_demo',
      'demo',
      'demo',
    );
    expect(result.map((c) => c.id)).toEqual([
      'conn_codex_demo',
      'conn_claude_demo',
    ]);
  });

  it('mantém sempre a conexão atual do participante na lista', () => {
    const result = selectableConnectionsForMode(
      connections,
      'conn_claude_demo',
      'demo',
      'aion_core',
    );
    expect(result.some((c) => c.id === 'conn_claude_demo')).toBe(true);
  });
});
