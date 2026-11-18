import { APP_BRAND } from '../config/brand';
import {
  IncompatibleSchemaError,
  migrateWorkspaceState,
} from '../domain/migration';
import {
  DEFAULT_CONNECTIONS,
  DEFAULT_PARTICIPANT_PROFILES,
  DEFAULT_TEAM_PRESETS,
} from '../domain/presets';
import { getParticipantRoles } from '../domain/teamValidation';
import type {
  ConnectionAdapterConfig,
  ConversationProjection,
  ExecutionEvent,
  ExecutionMode,
  ModelPolicy,
  ParticipantProfile,
  Project,
  TeamPreset,
  WorkspaceStoreState,
} from '../domain/types';
import { PT_BR } from '../i18n/ptBR';
import { sanitizeLoadedStateAfterReload } from './storage';

export interface VersionedWorkspaceExport {
  exportSchemaVersion: string;
  schemaVersion: number;
  appName: string;
  exportedAt: string;
  executionMode: ExecutionMode;
  isSimulated: boolean;
  note: string;
  connections?: ConnectionAdapterConfig[];
  participantProfiles?: ParticipantProfile[];
  teamPresets?: TeamPreset[];
  modelPolicy: ModelPolicy;
  projects: Project[];
  conversations: ConversationProjection[];
}

export interface BackupValidationPreview {
  schemaVersion: number;
  exportSchemaVersion: string;
  projectCount: number;
  conversationCount: number;
  presetCount: number;
  profileCount: number;
  executionModes: ExecutionMode[];
  externalTeamRefsCount: number;
  externalSessionRefsCount: number;
}

export type BackupValidationResult =
  | {
    valid: true;
    preview: BackupValidationPreview;
    migratedState: WorkspaceStoreState;
  }
  | {
    valid: false;
    error: string;
  };

function sanitizeConnectionForExport(
  conn: ConnectionAdapterConfig,
): ConnectionAdapterConfig {
  return {
    ...conn,
    // Never export active auth/session claims that could look valid after reload.
    authStatus: conn.mode === 'aion_core' ? 'unknown' : conn.authStatus,
    coreAgentStatus: conn.mode === 'aion_core' ? undefined : conn.coreAgentStatus,
    sessionStatus: conn.mode === 'aion_core' ? 'inactive' : conn.sessionStatus,
    coreReachability: conn.mode === 'aion_core' ? 'unknown' : conn.coreReachability,
    catalogLoaded: conn.mode === 'aion_core' ? false : conn.catalogLoaded,
  };
}

function sanitizeConnectionForImport(
  conn: ConnectionAdapterConfig,
): ConnectionAdapterConfig {
  if (conn.mode !== 'aion_core') {
    return { ...conn };
  }
  return {
    ...conn,
    coreAgentId: undefined,
    coreAssistantId: undefined,
    coreAgentStatus: undefined,
    coreReachability: 'unknown',
    catalogLoaded: false,
    authStatus: 'unknown',
    sessionStatus: 'inactive',
  };
}

function detachExternalBindingsFromProjection(
  proj: ConversationProjection,
): ConversationProjection {
  const hasTeamRef = Boolean(proj.conversation.externalTeamId);
  const nextParticipants = proj.participants.map((p) => {
    const hasSessionRef = Boolean(
      p.sessionRef.externalTeamId ||
      p.sessionRef.externalSlotId ||
      p.sessionRef.externalConversationId ||
      p.sessionRef.nativeSessionId,
    );
    const preservedRef = hasSessionRef
      ? {
        externalTeamId: p.sessionRef.externalTeamId,
        externalSlotId: p.sessionRef.externalSlotId,
        externalConversationId: p.sessionRef.externalConversationId,
        nativeSessionId: p.sessionRef.nativeSessionId,
      }
      : p.sessionRef.importedExternalRef;
    const isActiveRuntimeStatus =
      p.status === 'running' ||
      p.status === 'preparing' ||
      p.status === 'awaiting_permission' ||
      p.status === 'awaiting_review';
    return {
      ...p,
      status: isActiveRuntimeStatus ? ('idle' as const) : p.status,
      sessionRef: {
        ...p.sessionRef,
        externalTeamId: undefined,
        externalSlotId: undefined,
        externalConversationId: undefined,
        nativeSessionId: undefined,
        importedExternalRef: preservedRef,
        status:
          proj.conversation.executionMode === 'aion_core' || hasSessionRef
            ? ('inactive' as const)
            : p.sessionRef.status,
      },
    };
  });

  return {
    ...proj,
    conversation: {
      ...proj.conversation,
      externalTeamId: undefined,
      importedExternalTeamId: hasTeamRef
        ? proj.conversation.externalTeamId
        : proj.conversation.importedExternalTeamId,
      autoPlayWasRunning: false,
    },
    participants: nextParticipants,
  };
}

export function buildConversationMarkdownExport(
  project: Project | undefined,
  projection: ConversationProjection,
  modelPolicy: ModelPolicy,
): string {
  const lines: string[] = [];
  const {
    conversation,
    participants,
    planRevisions,
    contextRevisions,
    generalFeed,
    tasks,
    escalations,
    permissions,
    configChanges,
  } = projection;

  lines.push(`# ${APP_BRAND.name} — Exportação de Histórico`);
  lines.push('');
  lines.push(
    conversation.executionMode === 'aion_core'
      ? '> **Modo**: AionCore local (inclui metadados de coordenação mantidos pelo Aion Desk).'
      : `> **Aviso**: ${PT_BR.simulationNotice}`,
  );
  lines.push('');
  lines.push(`- **Projeto**: ${project?.name ?? conversation.projectId}`);
  if (project?.workspacePathInfo) {
    lines.push(
      `- **Workspace informado (apenas textual)**: \`${project.workspacePathInfo}\``,
    );
  }
  lines.push(`- **Conversa**: ${conversation.title} (\`${conversation.id}\`)`);
  lines.push(`- **Modo de execução**: ${conversation.executionMode}`);
  if (conversation.externalTeamId) {
    lines.push(`- **Equipe no Core**: \`${conversation.externalTeamId}\``);
  }
  lines.push(`- **Estado da execução**: ${conversation.executionStatus}`);
  lines.push(`- **Cursor de sequência aplicado**: ${conversation.lastAppliedSeq}`);
  lines.push(
    `- **Política de escalonamento**: ${modelPolicy.qualityRejectionsBeforeSuggest} reprovações → ${PT_BR.modelTierLabels[modelPolicy.escalationTargetTier]}`,
  );
  lines.push('');

  lines.push('## Participantes');
  for (const p of participants) {
    const rolesText = getParticipantRoles(p)
      .map((r) => PT_BR.roleLabels[r])
      .join(' + ');
    lines.push(
      `- **${p.displayName}** (${rolesText}) — Conexão: \`${p.connectionId}\` · Modelo: ${p.modelRef.displayName} (\`${p.modelRef.confirmation}\`) · Sessão: \`${p.sessionRef.id}\`${p.sessionRef.externalSlotId ? ` · Slot Core: \`${p.sessionRef.externalSlotId}\`` : ''}${p.sessionRef.externalConversationId ? ` · Conversa Core: \`${p.sessionRef.externalConversationId}\`` : ''}${p.sessionRef.nativeSessionId ? ` · Sessão CLI: \`${p.sessionRef.nativeSessionId}\`` : ''} · Estado: ${PT_BR.participantStatusLabels[p.status]}${p.isSimulated ? ' [simulado]' : ''}`,
    );
    if (p.instructions) {
      lines.push(`  - Instruções: ${p.instructions}`);
    }
  }
  lines.push('');

  if (planRevisions.length > 0) {
    lines.push('## Revisões de Plano');
    for (const plan of planRevisions) {
      lines.push(
        `- **Plano v${plan.versionNumber}** (\`${plan.id}\`) por ${plan.authorLabel} em \`${plan.createdAt}\`: ${plan.summary}`,
      );
    }
    lines.push('');
  }

  lines.push('## Contexto Comum e Revisões');
  if (contextRevisions.length === 0) {
    lines.push('_Nenhuma revisão de contexto registrada._');
  } else {
    for (const rev of contextRevisions) {
      lines.push(
        `### Revisão v${rev.versionNumber} (\`${rev.id}\`) — ${rev.createdAt}`,
      );
      lines.push(`- **Autor**: ${rev.authorLabel}`);
      lines.push(`- **Resumo da alteração**: ${rev.summaryOfChange}`);
      lines.push(`- **Objetivo**: ${rev.objective}`);
      if (rev.constraints.length > 0) {
        lines.push('- **Restrições**:');
        for (const c of rev.constraints) {
          lines.push(`  - ${c}`);
        }
      }
      if (rev.acceptanceCriteria.length > 0) {
        lines.push('- **Critérios de aceitação**:');
        for (const a of rev.acceptanceCriteria) {
          lines.push(`  - ${a}`);
        }
      }
      lines.push('- **Recibos por participante**:');
      for (const p of participants) {
        const receipt = rev.receipts[p.id];
        if (receipt) {
          lines.push(
            `  - ${p.displayName}: **${PT_BR.receiptStatusLabels[receipt.status]}** (${receipt.mechanismNote})`,
          );
        } else {
          lines.push(`  - ${p.displayName}: Pendente de envio`);
        }
      }
      lines.push('');
    }
  }

  lines.push('## Linha do Tempo (Geral)');
  for (const item of generalFeed) {
    lines.push(
      `- \`[${item.timestamp}]\` **${item.actorLabel}**${item.actorRoleLabel ? ` (${item.actorRoleLabel})` : ''}: ${item.summary} _(evento: \`${item.sourceEventId}\`)_`,
    );
  }
  lines.push('');

  lines.push('## Tarefas, Tentativas e Revisões');
  for (const task of tasks) {
    lines.push(
      `### ${task.title} (\`${task.id}\`) — ${PT_BR.taskStatusLabels[task.status]}`,
    );
    lines.push(`- **Pedido de origem**: \`${task.sourceRequestEventId}\``);
    lines.push(
      `- **Contadores**: Reprovações de qualidade: ${task.qualityRejectionCount} · Falhas operacionais: ${task.operationalFailureCount}`,
    );
    if (task.acceptanceCriteria.length > 0) {
      lines.push('- **Critérios**:');
      for (const crit of task.acceptanceCriteria) {
        lines.push(`  - ${crit}`);
      }
    }
    for (const attempt of task.attempts) {
      const modelLabel =
        attempt.modelRefUsed?.displayName ??
        PT_BR.modelTierLabels[attempt.modelTierUsed];
      lines.push(
        `- **Tentativa #${attempt.attemptNumber}** (\`${attempt.id}\`): modelo ${modelLabel}, contexto v${attempt.contextRevisionNumber} (\`${attempt.contextRevisionId}\`), estado: \`${attempt.status}\``,
      );
      if (attempt.deliverySummary) {
        lines.push(`  - Entrega: ${attempt.deliverySummary}`);
      }
    }
    for (const review of task.reviews) {
      const independenceNote =
        review.independentReview === false
          ? ' [parecer combinado — planejamento e auditoria na mesma sessão]'
          : '';
      lines.push(
        `- **Revisão (\`${review.id}\`)**: ${review.decision === 'approved' ? 'Aprovada' : 'Reprovada'}${independenceNote} — ${review.rationale} _(evento: \`${review.sourceEventId}\`)_`,
      );
    }
    lines.push('');
  }

  if (configChanges.length > 0) {
    lines.push('## Alterações de Configuração');
    for (const cfg of configChanges) {
      lines.push(
        `- \`[${cfg.decidedAt}]\` (${cfg.changeKind}): ${cfg.previousSummary} → ${cfg.nextSummary} (${cfg.reason})`,
      );
    }
    lines.push('');
  }

  if (escalations.length > 0 || permissions.length > 0) {
    lines.push('## Decisões de Escalonamento e Permissões');
    for (const esc of escalations) {
      lines.push(
        `- **Escalonamento (\`${esc.id}\`)**: ${esc.fromModelRef?.displayName ?? PT_BR.modelTierLabels[esc.fromTier]} → ${esc.toModelRef?.displayName ?? PT_BR.modelTierLabels[esc.toTier]} (${esc.status}) — ${esc.reason}`,
      );
    }
    for (const perm of permissions) {
      lines.push(
        `- **Permissão (\`${perm.id}\`)**: ${perm.actionTitle} [ação: \`${perm.actionKey}\`, escopo: \`${perm.scopeKey}\`] (\`${perm.commandSimulated}\`) — estado: \`${perm.status}\``,
      );
    }
    lines.push('');
  }

  lines.push('## Conversas Detalhadas por Aba');
  for (const [tabId, messages] of Object.entries(projection.messagesByTab)) {
    const participant = participants.find((p) => p.id === tabId);
    const tabTitle =
      tabId === 'general' ? 'Geral' : participant?.displayName ?? tabId;
    lines.push(`### Aba: ${tabTitle}`);
    if (messages.length === 0) {
      lines.push('_Sem mensagens registradas._');
    } else {
      for (const msg of messages) {
        lines.push(
          `- \`[${msg.timestamp}]\` **${msg.authorLabel}**${msg.originSource ? ` [${msg.originSource}]` : ''} _(evento: \`${msg.sourceEventId}\`)_:`,
        );
        lines.push('');
        lines.push(msg.bodyMarkdown);
        lines.push('');
      }
    }
  }

  return lines.join('\n');
}

export function buildWorkspaceJsonExport(
  state: WorkspaceStoreState,
  onlyConversationId?: string,
): string {
  const conversations = onlyConversationId
    ? Object.values(state.conversations).filter(
      (c) => c.conversation.id === onlyConversationId,
    )
    : Object.values(state.conversations);

  const projectIds = new Set(
    conversations.map((c) => c.conversation.projectId),
  );
  const projects = onlyConversationId
    ? state.projects.filter((p) => projectIds.has(p.id))
    : state.projects;

  const isSimulated = conversations.every(
    (c) => c.conversation.executionMode !== 'aion_core',
  );

  const payload: VersionedWorkspaceExport = {
    exportSchemaVersion: APP_BRAND.exportSchemaVersion,
    schemaVersion: state.schemaVersion,
    appName: APP_BRAND.name,
    exportedAt: new Date().toISOString(),
    executionMode: state.executionMode,
    isSimulated,
    note: 'Backup versionado do Aion Desk. Nenhuma credencial, token de sessão ou cookie é incluído na exportação.',
    connections: state.connections.map(sanitizeConnectionForExport),
    participantProfiles: state.participantProfiles,
    teamPresets: state.teamPresets,
    modelPolicy: state.modelPolicy,
    projects,
    conversations,
  };

  return JSON.stringify(payload, null, 2);
}

export function parseAndValidateWorkspaceBackup(
  rawJson: string,
): BackupValidationResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return {
      valid: false,
      error: 'O arquivo não contém JSON válido.',
    };
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {
      valid: false,
      error: 'Estrutura raiz do backup inválida (esperado objeto JSON).',
    };
  }

  const record = parsed as Record<string, unknown>;
  if (
    !Array.isArray(record.projects) ||
    !Array.isArray(record.conversations)
  ) {
    return {
      valid: false,
      error:
        'Backup incompleto: campos obrigatórios "projects" e "conversations" ausentes.',
    };
  }

  const rawSchema =
    typeof record.schemaVersion === 'number'
      ? record.schemaVersion
      : typeof record.exportSchemaVersion === 'string' &&
        record.exportSchemaVersion.startsWith('2.')
        ? 2
        : 1;

  if (rawSchema > APP_BRAND.storageSchemaVersion) {
    return {
      valid: false,
      error: `Backup incompatível: schemaVersion ${rawSchema} é mais recente do que a versão suportada (${APP_BRAND.storageSchemaVersion}).`,
    };
  }

  const conversationsMap: Record<string, ConversationProjection> = {};
  for (const item of record.conversations) {
    if (
      typeof item !== 'object' ||
      item === null ||
      !('conversation' in item) ||
      typeof (item as ConversationProjection).conversation?.id !== 'string'
    ) {
      return {
        valid: false,
        error:
          'Backup contém conversa malformada sem identificador válido.',
      };
    }
    const proj = item as ConversationProjection;
    conversationsMap[proj.conversation.id] = proj;
  }

  const projects = record.projects as Project[];
  const firstProjectId = projects[0]?.id ?? '';
  const firstConvId = Object.keys(conversationsMap)[0] ?? '';

  const candidateRaw: Record<string, unknown> = {
    schemaVersion: rawSchema,
    executionMode:
      record.executionMode === 'aion_core' ? 'aion_core' : 'demo',
    coreSettings: {
      baseUrl: '',
      workspacePath: '',
      authMode: 'cookie_or_bearer',
    },
    projects,
    connections: Array.isArray(record.connections)
      ? record.connections
      : DEFAULT_CONNECTIONS,
    participantProfiles: Array.isArray(record.participantProfiles)
      ? record.participantProfiles
      : DEFAULT_PARTICIPANT_PROFILES,
    teamPresets: Array.isArray(record.teamPresets)
      ? record.teamPresets
      : DEFAULT_TEAM_PRESETS,
    modelPolicy: record.modelPolicy,
    conversations: conversationsMap,
    activeProjectId: firstProjectId,
    activeConversationId: firstConvId,
  };

  try {
    const migrated = sanitizeLoadedStateAfterReload(
      migrateWorkspaceState(candidateRaw),
    );
    const executionModes = Array.from(
      new Set(
        Object.values(migrated.conversations).map(
          (c) => c.conversation.executionMode,
        ),
      ),
    );
    const externalTeamRefsCount = Object.values(migrated.conversations).filter(
      (c) => Boolean(c.conversation.externalTeamId),
    ).length;
    const externalSessionRefsCount = Object.values(
      migrated.conversations,
    ).reduce(
      (acc, c) =>
        acc +
        c.participants.filter(
          (p) =>
            Boolean(p.sessionRef.externalTeamId) ||
            Boolean(p.sessionRef.externalSlotId) ||
            Boolean(p.sessionRef.externalConversationId) ||
            Boolean(p.sessionRef.nativeSessionId),
        ).length,
      0,
    );

    return {
      valid: true,
      preview: {
        schemaVersion: rawSchema,
        exportSchemaVersion:
          typeof record.exportSchemaVersion === 'string'
            ? record.exportSchemaVersion
            : `${rawSchema}.0.0`,
        projectCount: migrated.projects.length,
        conversationCount: Object.keys(migrated.conversations).length,
        presetCount: migrated.teamPresets.length,
        profileCount: migrated.participantProfiles.length,
        executionModes,
        externalTeamRefsCount,
        externalSessionRefsCount,
      },
      migratedState: migrated,
    };
  } catch (err) {
    if (err instanceof IncompatibleSchemaError) {
      return { valid: false, error: err.message };
    }
    return {
      valid: false,
      error:
        err instanceof Error
          ? err.message
          : 'Falha ao validar e migrar o backup selecionado.',
    };
  }
}

export function applyImportedWorkspaceBackup(
  currentState: WorkspaceStoreState,
  importedState: WorkspaceStoreState,
  mode: 'copy' | 'replace',
): WorkspaceStoreState {
  if (mode === 'replace') {
    const detachedConversations: Record<string, ConversationProjection> = {};
    for (const [cid, proj] of Object.entries(importedState.conversations)) {
      detachedConversations[cid] = detachExternalBindingsFromProjection(proj);
    }
    return sanitizeLoadedStateAfterReload({
      ...importedState,
      coreSettings: currentState.coreSettings,
      coreSessionAuthenticated: false,
      connections: importedState.connections.map(sanitizeConnectionForImport),
      conversations: detachedConversations,
    });
  }

  const stamp = Date.now().toString(36);
  const projectMap = new Map<string, string>();
  const convMap = new Map<string, string>();
  const partMap = new Map<string, string>();
  const taskMap = new Map<string, string>();
  const attemptMap = new Map<string, string>();
  const revMap = new Map<string, string>();
  const planMap = new Map<string, string>();
  const permMap = new Map<string, string>();
  const escMap = new Map<string, string>();
  const evtMap = new Map<string, string>();

  const existingProjectIds = new Set(currentState.projects.map((p) => p.id));
  const copiedProjects: Project[] = importedState.projects.map((p, idx) => {
    const newId = existingProjectIds.has(p.id)
      ? `${p.id}_copia_${stamp}_${idx}`
      : p.id;
    projectMap.set(p.id, newId);
    return {
      ...p,
      id: newId,
      name: existingProjectIds.has(p.id) ? `${p.name} (cópia)` : p.name,
    };
  });

  const existingConvIds = new Set(Object.keys(currentState.conversations));
  const nextConversations: Record<string, ConversationProjection> = {
    ...currentState.conversations,
  };

  let convIndex = 0;
  for (const proj of Object.values(importedState.conversations)) {
    convIndex += 1;
    const oldConvId = proj.conversation.id;
    const newConvId = existingConvIds.has(oldConvId)
      ? `${oldConvId}_copia_${stamp}_${convIndex}`
      : oldConvId;
    convMap.set(oldConvId, newConvId);

    const newProjectId =
      projectMap.get(proj.conversation.projectId) ??
      copiedProjects[0]?.id ??
      currentState.activeProjectId;

    proj.participants.forEach((p, idx) => {
      partMap.set(p.id, `${p.id}_copia_${stamp}_${convIndex}_${idx}`);
    });
    proj.tasks.forEach((t, idx) => {
      taskMap.set(t.id, `${t.id}_copia_${stamp}_${convIndex}_${idx}`);
      t.attempts.forEach((a, aIdx) => {
        attemptMap.set(a.id, `${a.id}_copia_${stamp}_${convIndex}_${aIdx}`);
      });
    });
    proj.contextRevisions.forEach((r, idx) => {
      revMap.set(r.id, `${r.id}_copia_${stamp}_${convIndex}_${idx}`);
    });
    proj.planRevisions.forEach((pl, idx) => {
      planMap.set(pl.id, `${pl.id}_copia_${stamp}_${convIndex}_${idx}`);
    });
    proj.permissions.forEach((pm, idx) => {
      permMap.set(pm.id, `${pm.id}_copia_${stamp}_${convIndex}_${idx}`);
    });
    proj.escalations.forEach((es, idx) => {
      escMap.set(es.id, `${es.id}_copia_${stamp}_${convIndex}_${idx}`);
    });
    proj.eventLog.forEach((ev, idx) => {
      evtMap.set(ev.id, `${ev.id}_copia_${stamp}_${convIndex}_${idx}`);
    });

    const remapPart = (id?: string) => (id ? (partMap.get(id) ?? id) : undefined);
    const remapTask = (id?: string) => (id ? (taskMap.get(id) ?? id) : undefined);
    const remapAttempt = (id?: string) =>
      id ? (attemptMap.get(id) ?? id) : undefined;
    const remapRev = (id?: string) => (id ? (revMap.get(id) ?? id) : undefined);
    const remapEvt = (id: string) => evtMap.get(id) ?? id;

    const remappedParticipants = proj.participants.map((p) => {
      const newPartId = partMap.get(p.id) ?? p.id;
      return {
        ...p,
        id: newPartId,
        conversationId: newConvId,
        currentTaskId: remapTask(p.currentTaskId),
        sessionRef: {
          ...p.sessionRef,
          id: `${p.sessionRef.id}_copia_${stamp}_${convIndex}`,
          conversationId: newConvId,
          participantId: newPartId,
        },
      };
    });

    const remappedMessagesByTab: ConversationProjection['messagesByTab'] = {};
    for (const [tabId, msgs] of Object.entries(proj.messagesByTab)) {
      const newTabId = tabId === 'general' ? 'general' : (partMap.get(tabId) ?? tabId);
      remappedMessagesByTab[newTabId] = msgs.map((m) => ({
        ...m,
        id: `${m.id}_copia_${stamp}`,
        conversationId: newConvId,
        sourceEventId: remapEvt(m.sourceEventId),
        authorParticipantId: remapPart(m.authorParticipantId),
        targetTab: newTabId,
      }));
    }

    const remappedEventLog: ExecutionEvent[] = proj.eventLog.map((ev) => ({
      ...ev,
      id: remapEvt(ev.id),
      conversationId: newConvId,
      participantId: remapPart(ev.participantId),
      taskId: remapTask(ev.taskId),
      attemptId: remapAttempt(ev.attemptId),
    }));

    const remappedProjection: ConversationProjection = {
      ...proj,
      conversation: {
        ...proj.conversation,
        id: newConvId,
        projectId: newProjectId,
        title: existingConvIds.has(oldConvId)
          ? `${proj.conversation.title} (cópia)`
          : proj.conversation.title,
        coordinatorParticipantId:
          partMap.get(proj.conversation.coordinatorParticipantId) ??
          proj.conversation.coordinatorParticipantId,
      },
      participants: remappedParticipants,
      messagesByTab: remappedMessagesByTab,
      generalFeed: proj.generalFeed.map((g) => ({
        ...g,
        id: `${g.id}_copia_${stamp}`,
        conversationId: newConvId,
        sourceEventId: remapEvt(g.sourceEventId),
        targetTabId:
          g.targetTabId === 'general'
            ? 'general'
            : remapPart(g.targetTabId),
        targetEventId: g.targetEventId ? remapEvt(g.targetEventId) : undefined,
        targetTaskId: remapTask(g.targetTaskId),
      })),
      planRevisions: proj.planRevisions.map((pl) => ({
        ...pl,
        id: planMap.get(pl.id) ?? pl.id,
        conversationId: newConvId,
        taskIds: pl.taskIds.map((tId) => taskMap.get(tId) ?? tId),
        sourceEventId: remapEvt(pl.sourceEventId),
      })),
      tasks: proj.tasks.map((t) => ({
        ...t,
        id: taskMap.get(t.id) ?? t.id,
        conversationId: newConvId,
        planRevisionId: t.planRevisionId
          ? (planMap.get(t.planRevisionId) ?? t.planRevisionId)
          : undefined,
        assigneeParticipantId:
          partMap.get(t.assigneeParticipantId) ?? t.assigneeParticipantId,
        reviewerParticipantId: remapPart(t.reviewerParticipantId),
        dependencyTaskIds: t.dependencyTaskIds.map(
          (depId) => taskMap.get(depId) ?? depId,
        ),
        activeContextRevisionId: remapRev(t.activeContextRevisionId),
        attempts: t.attempts.map((a) => ({
          ...a,
          id: attemptMap.get(a.id) ?? a.id,
          taskId: taskMap.get(a.taskId) ?? a.taskId,
          executorParticipantId:
            partMap.get(a.executorParticipantId) ?? a.executorParticipantId,
          contextRevisionId: remapRev(a.contextRevisionId) ?? a.contextRevisionId,
          sourceEventIds: a.sourceEventIds.map(remapEvt),
        })),
        reviews: t.reviews.map((rv) => ({
          ...rv,
          id: `${rv.id}_copia_${stamp}`,
          taskId: taskMap.get(rv.taskId) ?? rv.taskId,
          attemptId: attemptMap.get(rv.attemptId) ?? rv.attemptId,
          reviewerParticipantId:
            partMap.get(rv.reviewerParticipantId) ?? rv.reviewerParticipantId,
          sourceEventId: remapEvt(rv.sourceEventId),
        })),
      })),
      contextRevisions: proj.contextRevisions.map((rev) => {
        const newRevId = revMap.get(rev.id) ?? rev.id;
        const nextReceipts: typeof rev.receipts = {};
        for (const [pKey, rc] of Object.entries(rev.receipts)) {
          const newPKey = partMap.get(pKey) ?? pKey;
          nextReceipts[newPKey] = {
            ...rc,
            participantId: newPKey,
            revisionId: newRevId,
          };
        }
        return {
          ...rev,
          id: newRevId,
          conversationId: newConvId,
          receipts: nextReceipts,
        };
      }),
      permissions: proj.permissions.map((pm) => ({
        ...pm,
        id: permMap.get(pm.id) ?? pm.id,
        conversationId: newConvId,
        participantId: partMap.get(pm.participantId) ?? pm.participantId,
        taskId: remapTask(pm.taskId),
        attemptId: remapAttempt(pm.attemptId),
        supersedesRequestId: pm.supersedesRequestId
          ? (permMap.get(pm.supersedesRequestId) ?? pm.supersedesRequestId)
          : undefined,
        sourceEventId: remapEvt(pm.sourceEventId),
      })),
      escalations: proj.escalations.map((es) => ({
        ...es,
        id: escMap.get(es.id) ?? es.id,
        conversationId: newConvId,
        taskId: taskMap.get(es.taskId) ?? es.taskId,
        attemptId: attemptMap.get(es.attemptId) ?? es.attemptId,
        participantId: partMap.get(es.participantId) ?? es.participantId,
        sourceEventId: remapEvt(es.sourceEventId),
      })),
      coordinatorHistory: proj.coordinatorHistory.map((ch) => ({
        ...ch,
        id: `${ch.id}_copia_${stamp}`,
        conversationId: newConvId,
        previousParticipantId: remapPart(ch.previousParticipantId),
        nextParticipantId:
          partMap.get(ch.nextParticipantId) ?? ch.nextParticipantId,
        sourceEventId: remapEvt(ch.sourceEventId),
      })),
      configChanges: proj.configChanges.map((cc) => ({
        ...cc,
        id: `${cc.id}_copia_${stamp}`,
        conversationId: newConvId,
        participantId: partMap.get(cc.participantId) ?? cc.participantId,
        sourceEventId: remapEvt(cc.sourceEventId),
      })),
      seenEventIds: proj.seenEventIds.map(remapEvt),
      pendingOutOfOrder: {},
      eventLog: remappedEventLog,
    };

    nextConversations[newConvId] =
      detachExternalBindingsFromProjection(remappedProjection);
  }

  const existingProfileIds = new Set(
    currentState.participantProfiles.map((p) => p.id),
  );
  const mergedProfiles = [
    ...currentState.participantProfiles,
    ...importedState.participantProfiles.filter(
      (p) => !existingProfileIds.has(p.id),
    ),
  ];

  const existingPresetIds = new Set(currentState.teamPresets.map((p) => p.id));
  const mergedPresets = [
    ...currentState.teamPresets,
    ...importedState.teamPresets.filter((p) => !existingPresetIds.has(p.id)),
  ];

  return sanitizeLoadedStateAfterReload({
    ...currentState,
    projects: [...currentState.projects, ...copiedProjects],
    participantProfiles: mergedProfiles,
    teamPresets: mergedPresets,
    conversations: nextConversations,
  });
}

export function triggerFileDownload(
  filename: string,
  content: string,
  mimeType: string,
): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}
