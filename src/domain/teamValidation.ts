import type {
  ConnectionAdapterConfig,
  ConversationProjection,
  Participant,
  ParticipantRole,
  Task,
} from './types';

export function getParticipantRoles(
  participant: Pick<Participant, 'role' | 'roles'>,
): ParticipantRole[] {
  if (Array.isArray(participant.roles) && participant.roles.length > 0) {
    return participant.roles;
  }
  return [participant.role];
}

export function hasRole(
  participant: Pick<Participant, 'role' | 'roles'> | undefined,
  role: ParticipantRole,
): boolean {
  if (!participant) return false;
  return getParticipantRoles(participant).includes(role);
}

export function getPrimaryRole(roles: ParticipantRole[]): ParticipantRole {
  if (roles.includes('coordinator')) return 'coordinator';
  if (roles.includes('executor')) return 'executor';
  if (roles.includes('planner')) return 'planner';
  if (roles.includes('reviewer')) return 'reviewer';
  return 'executor';
}

/**
 * Connections that can be bound to a participant in the current operating mode.
 *
 * In AionCore local mode only Core-backed connections are offered (plus the
 * current one, so the control keeps a valid value while it is being changed).
 * Without this, a participant still bound to a seeded demo connection could
 * never be migrated to a real assistant from the Core catalog.
 */
export function selectableConnectionsForMode<
  T extends { id: string; mode: 'demo' | 'aion_core'; executableStatus?: string },
>(
  connections: T[],
  currentConnectionId: string,
  currentConnectionMode: 'demo' | 'aion_core',
  workspaceMode: 'demo' | 'aion_core',
): T[] {
  return connections.filter((conn) => {
    if (conn.id === currentConnectionId) return true;
    if (conn.executableStatus === 'missing') return false;
    if (workspaceMode === 'aion_core') return conn.mode === 'aion_core';
    return conn.mode === currentConnectionMode;
  });
}

export function sortParticipantsByTabOrder(
  participants: Participant[],
): Participant[] {
  return [...participants]
    .filter((p) => !p.archived)
    .sort((a, b) => a.tabOrder - b.tabOrder);
}

export interface TeamValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export function validateTeamConfiguration(
  participants: Participant[],
  connections: ConnectionAdapterConfig[],
): TeamValidationResult {
  const active = participants.filter((p) => !p.archived);
  const errors: string[] = [];
  const warnings: string[] = [];

  if (active.length === 0) {
    errors.push('A conversa precisa de pelo menos um participante ativo.');
    return { valid: false, errors, warnings };
  }

  const coordinators = active.filter((p) => hasRole(p, 'coordinator'));
  if (coordinators.length === 0) {
    errors.push(
      'Nenhum coordenador ativo definido. Atribua exatamente um participante com papel de Coordenador.',
    );
  } else if (coordinators.length > 1) {
    errors.push(
      `Há ${coordinators.length} coordenadores ativos (${coordinators.map((c) => c.displayName).join(', ')}). A equipe executável deve ter exatamente um coordenador.`,
    );
  }

  const executors = active.filter((p) => hasRole(p, 'executor'));
  if (executors.length === 0) {
    errors.push(
      'Nenhum executor atribuído. Pelo menos um participante precisa atuar como Executor.',
    );
  }

  const reviewers = active.filter((p) => hasRole(p, 'reviewer'));
  if (reviewers.length === 0) {
    warnings.push(
      'Nenhum Auditor/Revisor configurado; revisões manuais permanecerão disponíveis na gaveta de tarefas.',
    );
  }

  const participantIds = new Set<string>();
  const sessionIds = new Set<string>();
  const connMap = new Map(connections.map((c) => [c.id, c]));

  for (const p of active) {
    if (participantIds.has(p.id)) {
      errors.push(`ID de participante duplicado na conversa: ${p.id}.`);
    }
    participantIds.add(p.id);

    if (!p.sessionRef?.id) {
      errors.push(`Participante "${p.displayName}" não possui vínculo de sessão individual.`);
    } else if (sessionIds.has(p.sessionRef.id)) {
      errors.push(
        `Conflito de sessão detectado: "${p.displayName}" compartilha o mesmo ID de sessão (${p.sessionRef.id}) com outro participante.`,
      );
    } else {
      sessionIds.add(p.sessionRef.id);
    }

    const conn = connMap.get(p.connectionId);
    if (!conn) {
      errors.push(
        `Conexão "${p.connectionId}" configurada em "${p.displayName}" não existe no catálogo.`,
      );
    } else if (conn.mode === 'aion_core' && !conn.coreAssistantId) {
      errors.push(
        `Conexão Core "${conn.displayName}" usada por "${p.displayName}" ainda não possui assistant_id resolvido do catálogo.`,
      );
    }
  }

  const planners = active.filter(
    (p) => hasRole(p, 'planner') || hasRole(p, 'coordinator'),
  );
  const sharedPlannerReviewer = reviewers.some((rev) =>
    planners.some(
      (pl) =>
        pl.id === rev.id ||
        (pl.sessionRef?.id && pl.sessionRef.id === rev.sessionRef?.id),
    ),
  );
  if (sharedPlannerReviewer) {
    warnings.push(
      'Planejamento e auditoria compartilham o mesmo participante ou sessão; pareceres não serão classificados como auditoria independente.',
    );
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

export interface ResolvedTeamRoles {
  coordinator?: Participant;
  planner?: Participant;
  executor?: Participant;
  reviewer?: Participant;
}

export function resolveTeamRoles(
  participants: Participant[],
  coordinatorParticipantId?: string,
): ResolvedTeamRoles {
  const active = sortParticipantsByTabOrder(participants);
  const coordinator =
    active.find((p) => p.id === coordinatorParticipantId) ??
    active.find((p) => hasRole(p, 'coordinator')) ??
    active[0];

  const planner =
    active.find((p) => hasRole(p, 'planner') && p.id !== coordinator?.id) ??
    active.find((p) => hasRole(p, 'planner')) ??
    coordinator;

  const executor =
    active.find((p) => hasRole(p, 'executor') && p.id !== coordinator?.id) ??
    active.find((p) => hasRole(p, 'executor')) ??
    active.find((p) => p.id !== coordinator?.id) ??
    coordinator;

  const reviewer =
    active.find(
      (p) =>
        hasRole(p, 'reviewer') &&
        p.id !== executor?.id,
    ) ??
    active.find((p) => hasRole(p, 'reviewer')) ??
    coordinator;

  return { coordinator, planner, executor, reviewer };
}

export interface AuditIndependenceCheck {
  independent: boolean;
  reason?: string;
}

export function checkAuditIndependence(
  participants: Participant[],
  task: Pick<Task, 'assigneeParticipantId' | 'reviewerParticipantId'>,
  explicitReviewerId?: string,
): AuditIndependenceCheck {
  const reviewerId = explicitReviewerId ?? task.reviewerParticipantId;
  if (!reviewerId) {
    return { independent: false, reason: 'Nenhum auditor atribuído à tarefa.' };
  }
  const assignee = participants.find((p) => p.id === task.assigneeParticipantId);
  const reviewer = participants.find((p) => p.id === reviewerId);
  if (!reviewer) {
    return { independent: false, reason: 'Auditor não encontrado na equipe ativa.' };
  }
  if (assignee && assignee.id === reviewer.id) {
    return {
      independent: false,
      reason: `${reviewer.displayName} acumulou execução e auditoria na mesma tarefa.`,
    };
  }
  if (
    assignee?.sessionRef?.id &&
    reviewer.sessionRef?.id &&
    assignee.sessionRef.id === reviewer.sessionRef.id
  ) {
    return {
      independent: false,
      reason: `${reviewer.displayName} compartilha a mesma sessão do executor.`,
    };
  }
  if (hasRole(reviewer, 'planner')) {
    return {
      independent: false,
      reason: `Planejamento e auditoria usam o mesmo participante/sessão (${reviewer.displayName}); parecer combinado, não auditoria independente.`,
    };
  }
  return { independent: true };
}

export interface CoreTeamSyncStatus {
  hasExternalTeam: boolean;
  needsResync: boolean;
  unmappedParticipants: Participant[];
  archivedBoundParticipants: Participant[];
  coordinatorChanged: boolean;
  reasons: string[];
}

/**
 * Detects structural divergences between the active local conversation team
 * configuration and the currently linked AionCore team (`externalTeamId`).
 * Structural edits (adding/archiving participants, swapping CLI connections,
 * changing Coordinator/lead, or applying another preset) require recreating
 * the team in Core because Core assigns fixed `slot_id` and `lead` per team.
 */
export function getCoreTeamSyncStatus(
  projection: Pick<ConversationProjection, 'conversation' | 'participants'>,
): CoreTeamSyncStatus {
  const teamId = projection.conversation.externalTeamId?.trim();
  if (!teamId) {
    return {
      hasExternalTeam: false,
      needsResync: false,
      unmappedParticipants: [],
      archivedBoundParticipants: [],
      coordinatorChanged: false,
      reasons: [],
    };
  }

  const hasAnyBoundSlotForTeam = projection.participants.some(
    (p) =>
      p.sessionRef?.externalTeamId === teamId &&
      Boolean(p.sessionRef?.externalSlotId),
  );
  const needsExplicitResync = Boolean(
    projection.conversation.coreTeamNeedsResync,
  );
  const unmappedParticipants = projection.participants.filter((p) => {
    if (p.archived) return false;
    const isBoundToCurrentTeam =
      Boolean(p.sessionRef?.externalSlotId) &&
      p.sessionRef?.externalTeamId === teamId;
    if (isBoundToCurrentTeam) return false;
    // Flag unmapped coordinator on a team that already has bound slots (handles legacy pre-fix state)
    // or any unmapped active participant when an explicit local structural edit occurred.
    return (
      needsExplicitResync ||
      (hasAnyBoundSlotForTeam &&
        (hasRole(p, 'coordinator') ||
          p.id === projection.conversation.coordinatorParticipantId))
    );
  });
  const archivedBoundParticipants = projection.participants.filter(
    (p) =>
      Boolean(p.archived) &&
      p.sessionRef?.externalTeamId === teamId &&
      Boolean(p.sessionRef.externalSlotId),
  );
  const coordinatorChanged = Boolean(
    projection.conversation.coreLeadParticipantId &&
      projection.conversation.coordinatorParticipantId &&
      projection.conversation.coreLeadParticipantId !==
        projection.conversation.coordinatorParticipantId,
  );

  const reasons: string[] = [];
  if (unmappedParticipants.length > 0) {
    reasons.push(
      `Participante(s) sem vínculo ativo de slot no Core: ${unmappedParticipants
        .map((p) => p.displayName)
        .join(', ')}.`,
    );
  }
  if (archivedBoundParticipants.length > 0) {
    reasons.push(
      `Participante(s) arquivado(s) ainda presente(s) no time antigo do Core: ${archivedBoundParticipants
        .map((p) => p.displayName)
        .join(', ')}.`,
    );
  }
  if (coordinatorChanged) {
    const coord = projection.participants.find(
      (p) => p.id === projection.conversation.coordinatorParticipantId,
    );
    reasons.push(
      `Coordenador (lead no Core) alterado para ${coord?.displayName ?? projection.conversation.coordinatorParticipantId}.`,
    );
  }
  if (reasons.length === 0 && projection.conversation.coreTeamNeedsResync) {
    reasons.push(
      'Composição da equipe alterada localmente; o time no AionCore precisa ser recriado.',
    );
  }

  return {
    hasExternalTeam: true,
    needsResync:
      Boolean(projection.conversation.coreTeamNeedsResync) ||
      unmappedParticipants.length > 0 ||
      archivedBoundParticipants.length > 0 ||
      coordinatorChanged,
    unmappedParticipants,
    archivedBoundParticipants,
    coordinatorChanged,
    reasons,
  };
}
