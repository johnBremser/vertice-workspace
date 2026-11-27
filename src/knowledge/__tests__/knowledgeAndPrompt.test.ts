import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createInitialWorkspaceState } from '../../domain/presets';
import {
  buildGroundedAssistantPrompt,
  buildLiveRuntimeSnapshot,
} from '../assistantPromptBuilder';
import { searchKnowledgeArticles } from '../knowledgeSearch';
import { VERTICE_KNOWLEDGE_BASE } from '../verticeKnowledgeBase';

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../..',
);

describe('Vertice Knowledge Base & Grounded Assistant Prompt Builder', () => {
  it('has unique article IDs and valid relatedFiles pointing to real repository files', () => {
    const ids = new Set<string>();
    expect(VERTICE_KNOWLEDGE_BASE.length).toBeGreaterThanOrEqual(6);

    for (const article of VERTICE_KNOWLEDGE_BASE) {
      expect(ids.has(article.id)).toBe(false);
      ids.add(article.id);
      expect(article.title.trim().length).toBeGreaterThan(0);
      expect(article.bodyMarkdown.trim().length).toBeGreaterThan(50);

      for (const relPath of article.relatedFiles) {
        const absPath = path.join(REPO_ROOT, relPath);
        expect(fs.existsSync(absPath)).toBe(true);
      }
    }
  });

  it('searches articles accurately ignoring accents and matching categories', () => {
    const csrfHits = searchKnowledgeArticles('autenticação csrf');
    expect(csrfHits.length).toBeGreaterThan(0);
    expect(csrfHits[0]?.article.category).toBe('troubleshooting');

    const archHits = searchKnowledgeArticles('camadas gateway', 'arquitetura');
    expect(archHits.length).toBeGreaterThan(0);
    expect(archHits.every((h) => h.article.category === 'arquitetura')).toBe(
      true,
    );
  });

  it('redacts sensitive tokens/cookies in buildLiveRuntimeSnapshot and grounds prompt with KB + source excerpts', () => {
    const state = createInitialWorkspaceState();
    state.coreRuntimeStatus = 'reachable';
    state.coreSessionAuthenticated = true;

    const snapshot = buildLiveRuntimeSnapshot(state, undefined, undefined, [
      {
        timestamp: '2026-11-25T11:00:00.000Z',
        operation: 'core.login',
        status: 'error',
        code: 'AUTH_REQUIRED',
        httpStatus: 401,
        detail: 'Bearer super_secret_jwt_123 cookie=aionui-session=abc password=secret',
      },
    ]);

    const serializedSnapshot = JSON.stringify(snapshot);
    expect(serializedSnapshot).not.toContain('super_secret_jwt_123');
    expect(serializedSnapshot).not.toContain('aionui-session=abc');
    expect(serializedSnapshot).not.toContain('password=secret');
    expect(snapshot.recentDiagnostics[0]?.detail).toContain('[redacted]');

    const built = buildGroundedAssistantPrompt({
      userQuestion: 'Como resolver erro 403 CSRF no Vértice?',
      liveSnapshot: snapshot,
      sourceExcerpts: [
        {
          path: 'src/services/aionCoreTransport.ts',
          startLine: 20,
          endLine: 30,
          content: "22: export const CSRF_COOKIE_NAME = 'aionui-csrf-token';",
        },
      ],
    });

    expect(built.prompt).toContain('MODO SOMENTE LEITURA');
    expect(built.prompt).toContain('Base de Conhecimento Relevante do Vértice');
    expect(built.prompt).toContain('src/services/aionCoreTransport.ts');
    expect(built.sourcesCited).toContain('src/services/aionCoreTransport.ts');
    expect(built.sourcesCited.some((s) => s.startsWith('kb:'))).toBe(true);
  });

  it('includes attached scope documents, image filenames, and team recommendation guidance in prompt', () => {
    const built = buildGroundedAssistantPrompt({
      userQuestion: 'Com base neste escopo, qual equipe devo configurar?',
      attachedTextFiles: [
        {
          name: 'escopo-crm.md',
          mimeType: 'text/markdown',
          content: '# Escopo CRM\nBackend Node + Frontend React com auditoria separada.',
        },
      ],
      attachedImageNames: ['wireframe-tela.png'],
    });

    expect(built.prompt).toContain('[Arquivos Anexados pelo Usuário]');
    expect(built.prompt).toContain('escopo-crm.md');
    expect(built.prompt).toContain('# Escopo CRM');
    expect(built.prompt).toContain('[Imagens / Capturas de Tela Anexadas]');
    expect(built.prompt).toContain('wireframe-tela.png');
    expect(built.prompt).toContain('ANEXOS, ESCOPOS E RECOMENDAÇÃO DE EQUIPE');
  });

  it('keeps prompt compact under Windows CLI argv limits when many source excerpts and diagnostics are present', () => {
    const state = createInitialWorkspaceState();
    state.coreRuntimeStatus = 'reachable';
    const bigLine = 'x'.repeat(120);
    const largeDiagnostics = Array.from({ length: 12 }, (_, idx) => ({
      timestamp: `2026-11-27T10:00:0${idx % 10}.000Z`,
      operation: `op.${idx}`,
      status: 'error' as const,
      detail: `detalhe-${idx} ${bigLine}`,
    }));
    const snapshot = buildLiveRuntimeSnapshot(
      state,
      undefined,
      undefined,
      largeDiagnostics,
    );
    const largeExcerpts = [1, 2, 3].map((n) => ({
      path: `src/file${n}.ts`,
      startLine: 1,
      endLine: 65,
      content: `${n}: ${'code '.repeat(600)}`,
    }));

    const built = buildGroundedAssistantPrompt({
      userQuestion: 'Erro csrf e autenticacao e retomada no Core',
      liveSnapshot: snapshot,
      sourceExcerpts: largeExcerpts,
    });

    expect(built.prompt.length).toBeLessThan(7000);
    expect(built.sourcesCited.filter((s) => s.startsWith('src/'))).toHaveLength(2);
  });
});
