import type {
  ConnectionAdapterConfig,
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
