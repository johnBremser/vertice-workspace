import { getTaskSummaryCounts } from '../domain/selectors';
import type {
  ConversationProjection,
  Project,
  VerticeAssistantMessage,
  WorkspaceStoreState,
} from '../domain/types';
import type { CoreDiagnosticEntry } from '../services/gateway';
import { searchKnowledgeArticles } from './knowledgeSearch';

export interface SourceExcerptInput {
  path: string;
  startLine: number;
  endLine: number;
  content: string;
}

export interface LiveRuntimeSnapshot {
  executionMode: WorkspaceStoreState['executionMode'];
  coreRuntimeStatus: WorkspaceStoreState['coreRuntimeStatus'];
  coreSessionAuthenticated: boolean;
  coreBaseUrlConfigured: boolean;
  globalCoreWorkspacePath?: string;
  activeProjectWorkspacePath?: string;
  effectiveTeamWorkspacePath?: string;
  workspacePathConfigured: boolean;
  assistantSessionWorkspace?: string;
  sourceReaderAvailable: boolean;
  setupCompletedSteps: string[];
  setupPendingSteps: string[];
  connections: Array<{
    displayName: string;
    backendId: string;
    reachability: string;
    executableStatus: string;
    coreAgentStatus?: string;
    authStatus: string;
    catalogLoaded: boolean;
    confirmedModels: string[];
    lastTestResult?: string;
  }>;
  activeProject?: {
    name: string;
    workspacePathInfo: string;
  };
  activeConversation?: {
    title: string;
    executionStatus: string;
    syncState: string;
    syncErrorNote?: string;
    hasExternalTeam: boolean;
    participantsCount: number;
    taskSummary: ReturnType<typeof getTaskSummaryCounts>;
    pendingPermissionsCount: number;
    pendingEscalationsCount: number;
  };
  recentDiagnostics: Array<{
    timestamp: string;
    operation: string;
    status: 'ok' | 'error';
    code?: string;
    httpStatus?: number;
    detail: string;
  }>;
}

function redactSensitiveText(input: string): string {
  return input
    .replace(/Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, 'Bearer [redacted]')
    .replace(/(password|token|cookie|secret|csrf)=([^\s&;]+)/gi, '$1=[redacted]')
    .slice(0, 240);
}

export function buildLiveRuntimeSnapshot(
  store: WorkspaceStoreState,
  activeProject: Project | undefined,
  activeConversation: ConversationProjection | undefined,
  diagnostics: CoreDiagnosticEntry[],
  assistantRuntimeInfo?: {
    assistantSessionWorkspace?: string;
    sourceReaderAvailable?: boolean;
  },
): LiveRuntimeSnapshot {
  const coreConnections = store.connections.filter((c) => c.mode === 'aion_core');
  const hasReachableCore =
    store.coreRuntimeStatus === 'reachable' ||
    coreConnections.some((c) => c.coreReachability === 'reachable');
  const hasConfirmedCatalog = coreConnections.some(
    (c) => c.catalogLoaded && c.availableModels.some((m) => m.confirmed),
  );
  const globalCoreWorkspacePath = store.coreSettings.workspacePath.trim();
  const activeProjectWorkspacePath = activeProject?.workspacePathInfo.trim() ?? '';
  const effectiveTeamWorkspacePath =
    globalCoreWorkspacePath || activeProjectWorkspacePath;
  const hasTeamBound = Boolean(
    activeConversation?.conversation.executionMode === 'aion_core' &&
      activeConversation.conversation.externalTeamId &&
      effectiveTeamWorkspacePath,
  );
  const hasFirstOrder = Boolean(
    hasTeamBound &&
      activeConversation?.generalFeed.some((g) => g.kind === 'user_request'),
  );

  const steps: Array<{ label: string; done: boolean }> = [
    { label: '1. Conectar runtime local (/health)', done: hasReachableCore },
    {
      label: '2. Autenticar sessão WebUI (/login)',
      done: Boolean(store.coreSessionAuthenticated),
    },
    { label: '3. Sincronizar catálogo e modelos', done: hasConfirmedCatalog },
    { label: '4. Escolher workspace e criar equipe', done: hasTeamBound },
    { label: '5. Enviar primeiro pedido na Geral', done: hasFirstOrder },
  ];

  return {
    executionMode: store.executionMode,
    coreRuntimeStatus: store.coreRuntimeStatus ?? 'unknown',
    coreSessionAuthenticated: Boolean(store.coreSessionAuthenticated),
    coreBaseUrlConfigured: Boolean(store.coreSettings.baseUrl.trim()),
    globalCoreWorkspacePath: globalCoreWorkspacePath || undefined,
    activeProjectWorkspacePath: activeProjectWorkspacePath || undefined,
    effectiveTeamWorkspacePath: effectiveTeamWorkspacePath || undefined,
    workspacePathConfigured: Boolean(effectiveTeamWorkspacePath),
    assistantSessionWorkspace:
      assistantRuntimeInfo?.assistantSessionWorkspace || undefined,
    sourceReaderAvailable: Boolean(assistantRuntimeInfo?.sourceReaderAvailable),
    setupCompletedSteps: steps.filter((s) => s.done).map((s) => s.label),
    setupPendingSteps: steps.filter((s) => !s.done).map((s) => s.label),
    connections: coreConnections.map((c) => ({
      displayName: c.displayName,
      backendId: c.backendId,
      reachability: c.coreReachability,
      executableStatus: c.executableStatus,
      coreAgentStatus: c.coreAgentStatus,
      authStatus: c.authStatus,
      catalogLoaded: c.catalogLoaded,
      confirmedModels: c.availableModels
        .filter((m) => m.confirmed)
        .map((m) => m.externalId),
      lastTestResult: c.lastConnectionTestResult
        ? redactSensitiveText(c.lastConnectionTestResult)
        : undefined,
    })),
    activeProject: activeProject
      ? {
          name: activeProject.name,
          workspacePathInfo: activeProject.workspacePathInfo,
        }
      : undefined,
    activeConversation: activeConversation
      ? {
          title: activeConversation.conversation.title,
          executionStatus: activeConversation.conversation.executionStatus,
          syncState: activeConversation.conversation.syncState,
          syncErrorNote: activeConversation.syncErrorNote
            ? redactSensitiveText(activeConversation.syncErrorNote)
            : undefined,
          hasExternalTeam: Boolean(activeConversation.conversation.externalTeamId),
          participantsCount: activeConversation.participants.filter(
            (p) => !p.archived,
          ).length,
          taskSummary: getTaskSummaryCounts(activeConversation.tasks),
          pendingPermissionsCount: activeConversation.permissions.filter(
            (p) => p.status === 'pending',
          ).length,
          pendingEscalationsCount: activeConversation.escalations.filter(
            (e) => e.status === 'suggested',
          ).length,
        }
      : undefined,
    recentDiagnostics: diagnostics.slice(0, 10).map((d) => ({
      timestamp: d.timestamp,
      operation: d.operation,
      status: d.status,
      code: d.code,
      httpStatus: d.httpStatus,
      detail: redactSensitiveText(d.detail),
    })),
  };
}

export interface AttachedTextFilePromptInput {
  name: string;
  mimeType: string;
  content: string;
  truncated?: boolean;
}

export function buildGroundedAssistantPrompt(input: {
  userQuestion: string;
  liveSnapshot?: LiveRuntimeSnapshot;
  sourceExcerpts?: SourceExcerptInput[];
  sourceReaderAvailable?: boolean;
  recentHistory?: VerticeAssistantMessage[];
  attachedTextFiles?: AttachedTextFilePromptInput[];
  attachedImageNames?: string[];
}): {
  prompt: string;
  sourcesCited: string[];
} {
  const kbSearchSeed = [
    input.userQuestion,
    ...(input.attachedTextFiles ?? []).map((f) => `${f.name} ${f.content.slice(0, 800)}`),
  ]
    .filter(Boolean)
    .join('\n');
  const kbHits = searchKnowledgeArticles(kbSearchSeed).slice(0, 3);
  const citedSet = new Set<string>();

  const sections: string[] = [
    [
      '[Assistente Técnico do Vértice Workspace — Modo Estritamente Somente Leitura]',
      'Você é o Assistente especialista integrado ao Vértice Workspace (Powered by AionCore v0.2.2).',
      'Regras obrigatórias:',
      '1. Responda em Português (pt-BR), de forma clara, objetiva e tecnicamente precisa.',
      '2. MODO SOMENTE LEITURA: nunca modifique, crie ou apague arquivos do projeto nem execute comandos destrutivos. Você deve apenas ler/analisar código, explicar arquitetura, orientar configurações e diagnosticar problemas.',
      '3. TRANSPARÊNCIA SOBRE ACESSO AO FONTE: informe com honestidade apenas o que estiver comprovado abaixo. Se `sourceReaderAvailable` for false ou não houver `[Trechos Lidos do Código-Fonte Local]` anexados, NÃO afirme que leu ou verificou o código-fonte diretamente; oriente o usuário a reiniciar o servidor local caso `/__vertice_assistant/*` não esteja respondendo.',
      '4. Cite exatamente os caminhos de arquivos e símbolos que você observou nos trechos fornecidos ou leu no workspace. Nunca invente rotas, configurações ou comportamento não comprovado.',
      '5. Não gere blocos ```aion-desk-json``` — você está respondendo diretamente ao usuário no chat do Assistente.',
      '6. ANEXOS, ESCOPOS E RECOMENDAÇÃO DE EQUIPE: se o usuário anexar um documento de escopo, planejamento, requisitos, arquivo de texto ou captura de tela, analise-o e recomende configurações concretas do projeto/conversa no Vértice (papéis Coordenador, Planejador, Executor e Auditor/Revisor, múltiplas sessões do mesmo CLI quando útil, presets de equipe, Contexto Compartilhado e política de revisão/escalonamento).',
    ].join('\n'),
  ];

  if (input.liveSnapshot) {
    sections.push(
      `[Diagnóstico ao Vivo do Vértice (sanitizado, sem segredos)]\n\`\`\`json\n${JSON.stringify(
        input.liveSnapshot,
        null,
        2,
      )}\n\`\`\``,
    );
  }

  if (kbHits.length > 0) {
    const kbBlocks = kbHits.map(({ article }) => {
      citedSet.add(`kb:${article.id}`);
      return `### [KB] ${article.title} (${article.id})\nArquivos relacionados: ${article.relatedFiles.join(', ')}\n${article.bodyMarkdown}`;
    });
    sections.push(
      `[Base de Conhecimento Relevante do Vértice]\n${kbBlocks.join('\n\n')}`,
    );
  }

  if (input.sourceExcerpts && input.sourceExcerpts.length > 0) {
    const sourceBlocks = input.sourceExcerpts.map((ex) => {
      citedSet.add(ex.path);
      return `### [Fonte] ${ex.path} (linhas ${ex.startLine}-${ex.endLine})\n\`\`\`\n${ex.content}\n\`\`\``;
    });
    sections.push(
      `[Trechos Lidos do Código-Fonte Local]\n${sourceBlocks.join('\n\n')}`,
    );
  }

  if (input.attachedTextFiles && input.attachedTextFiles.length > 0) {
    const fileBlocks = input.attachedTextFiles.map(
      (file) =>
        `### [Anexo de Texto] ${file.name} (${file.mimeType})${file.truncated ? ' [conteúdo truncado]' : ''}\n\`\`\`\n${file.content}\n\`\`\``,
    );
    sections.push(`[Arquivos Anexados pelo Usuário]\n${fileBlocks.join('\n\n')}`);
  }

  if (input.attachedImageNames && input.attachedImageNames.length > 0) {
    sections.push(
      `[Imagens / Capturas de Tela Anexadas]\nOs seguintes arquivos de imagem foram enviados junto com esta mensagem via AionCore Files: ${input.attachedImageNames.join(', ')}`,
    );
  }

  const completedHistory = (input.recentHistory ?? [])
    .filter((m) => m.role !== 'system' && m.status !== 'streaming')
    .slice(-4);
  if (completedHistory.length > 0) {
    const historyText = completedHistory
      .map(
        (m) =>
          `${m.role === 'user' ? 'Usuário' : 'Assistente'}: ${m.contentMarkdown.slice(0, 600)}`,
      )
      .join('\n');
    sections.push(`[Contexto Recente da Conversa com o Assistente]\n${historyText}`);
  }

  sections.push(`[Pergunta do Usuário]\n${input.userQuestion.trim()}`);

  return {
    prompt: sections.join('\n\n'),
    sourcesCited: Array.from(citedSet),
  };
}
