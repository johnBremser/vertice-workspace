import type { ParticipantRole } from './types';

/**
 * Contrato INTERNO de mensagem estruturada do Aion Desk (`aion-desk/v1`).
 *
 * IMPORTANTE: Este formato NÃO é protocolo nativo do AionCore, Codex CLI ou
 * Antigravity. É um envelope textual interno usado nas instruções do Aion Desk
 * para correlacionar respostas de agentes a planos, entregas e pareceres com
 * fallback seguro quando a saída vier em texto livre ou incompleta.
 */
export const INTERNAL_PROTOCOL_VERSION = 'aion-desk/v1' as const;

export type StructuredEnvelopeKind =
  | 'plan_proposal'
  | 'delivery_report'
  | 'review_decision';

export interface StructuredPlanTaskInput {
  title: string;
  description: string;
  assigneeRole?: ParticipantRole;
  dependencies?: string[];
  acceptanceCriteria: string[];
}

export interface PlanProposalPayload {
  kind: 'plan_proposal';
  protocol: typeof INTERNAL_PROTOCOL_VERSION;
  conversationId: string;
  summary: string;
  tasks: StructuredPlanTaskInput[];
}

export interface DeliveryReportPayload {
  kind: 'delivery_report';
  protocol: typeof INTERNAL_PROTOCOL_VERSION;
  conversationId: string;
  taskId: string;
  attemptId?: string;
  deliverySummary: string;
  evidenceNotes: string[];
}

export interface ReviewDecisionPayload {
  kind: 'review_decision';
  protocol: typeof INTERNAL_PROTOCOL_VERSION;
  conversationId: string;
  taskId: string;
  attemptId?: string;
  decision: 'approved' | 'rejected';
  rationale: string;
  unmetCriteria: string[];
}

export type StructuredAgentEnvelope =
  | PlanProposalPayload
  | DeliveryReportPayload
  | ReviewDecisionPayload;

export interface ParsedAgentOutput {
  valid: boolean;
  parseStatus: 'valid' | 'incomplete' | 'invalid';
  parsed?: StructuredAgentEnvelope;
  rawBody: string;
  errorReason?: string;
  requiresManualReview: boolean;
}

export function buildRoleInstructionPrompt(input: {
  roleLabel: string;
  participantName: string;
  customInstructions: string;
  expectedKind?: StructuredEnvelopeKind;
  conversationId: string;
  taskId?: string;
  attemptId?: string;
}): string {
  const baseLines = [
    `[Contrato interno ${INTERNAL_PROTOCOL_VERSION} — exclusivo do Aion Desk; não é protocolo nativo do Core/CLI]`,
    `Participante: ${input.participantName} · Papel atribuído: ${input.roleLabel}`,
  ];
  if (input.customInstructions.trim()) {
    baseLines.push(`Instruções permanentes: ${input.customInstructions.trim()}`);
  }
  if (input.expectedKind) {
    baseLines.push(
      `Quando finalizar, inclua um bloco JSON delimitado por \`\`\`aion-desk-json ... \`\`\` com kind="${input.expectedKind}", protocol="${INTERNAL_PROTOCOL_VERSION}", conversationId="${input.conversationId}"${input.taskId ? `, taskId="${input.taskId}"` : ''}${input.attemptId ? `, attemptId="${input.attemptId}"` : ''}.`,
    );
    if (input.expectedKind === 'plan_proposal') {
      baseLines.push(
        `Estrutura obrigatória do JSON plan_proposal: { "protocol": "${INTERNAL_PROTOCOL_VERSION}", "kind": "plan_proposal", "conversationId": "${input.conversationId}", "summary": "...", "tasks": [{ "title": "...", "description": "...", "assigneeRole": "executor", "dependencies": [], "acceptanceCriteria": ["..."] }] } (dependencies pode usar títulos exatos ou "task_1", "task_2"...).`,
      );
    } else if (input.expectedKind === 'delivery_report') {
      baseLines.push(
        `Estrutura obrigatória do JSON delivery_report: { "protocol": "${INTERNAL_PROTOCOL_VERSION}", "kind": "delivery_report", "conversationId": "${input.conversationId}", "taskId": "${input.taskId ?? ''}", "attemptId": "${input.attemptId ?? ''}", "deliverySummary": "...", "evidenceNotes": ["..."] }.`,
      );
    } else if (input.expectedKind === 'review_decision') {
      baseLines.push(
        `Estrutura obrigatória do JSON review_decision: { "protocol": "${INTERNAL_PROTOCOL_VERSION}", "kind": "review_decision", "conversationId": "${input.conversationId}", "taskId": "${input.taskId ?? ''}", "attemptId": "${input.attemptId ?? ''}", "decision": "approved" | "rejected", "rationale": "...", "unmetCriteria": [] }.`,
      );
    }
  }
  return baseLines.join('\n');
}

export function parseStructuredAgentOutput(
  rawBody: string,
  expectedKind?: StructuredEnvelopeKind,
): ParsedAgentOutput {
  const trimmed = rawBody.trim();
  if (!trimmed) {
    return {
      valid: false,
      parseStatus: 'incomplete',
      rawBody,
      errorReason: 'Resposta vazia do participante; aguardando revisão manual.',
      requiresManualReview: true,
    };
  }

  const blockMatch = /```aion-desk-json\s*([\s\S]*?)```/i.exec(trimmed);
  if (!blockMatch) {
    return {
      valid: false,
      parseStatus: 'incomplete',
      rawBody,
      errorReason:
        'Bloco estruturado interno aion-desk-json ausente; mantido como saída original para revisão manual (sem conclusão automática).',
      requiresManualReview: true,
    };
  }

  let data: unknown;
  try {
    data = JSON.parse(blockMatch[1].trim());
  } catch {
    return {
      valid: false,
      parseStatus: 'invalid',
      rawBody,
      errorReason:
        'JSON interno aion-desk-json malformado; mantido como pendência de interpretação.',
      requiresManualReview: true,
    };
  }

  if (!data || typeof data !== 'object') {
    return {
      valid: false,
      parseStatus: 'invalid',
      rawBody,
      errorReason: 'Estrutura JSON deve ser um objeto válido.',
      requiresManualReview: true,
    };
  }

  const obj = data as Record<string, unknown>;
  if (obj.protocol !== INTERNAL_PROTOCOL_VERSION) {
    return {
      valid: false,
      parseStatus: 'invalid',
      rawBody,
      errorReason: `Versão de contrato interno incompatível ou ausente (esperado ${INTERNAL_PROTOCOL_VERSION}).`,
      requiresManualReview: true,
    };
  }

  if (expectedKind && obj.kind !== expectedKind) {
    return {
      valid: false,
      parseStatus: 'invalid',
      rawBody,
      errorReason: `Tipo de mensagem divergente: esperado "${expectedKind}", recebido "${String(obj.kind ?? '')}".`,
      requiresManualReview: true,
    };
  }

  if (typeof obj.conversationId !== 'string' || !obj.conversationId.trim()) {
    return {
      valid: false,
      parseStatus: 'incomplete',
      rawBody,
      errorReason: 'Campo conversationId ausente no bloco estruturado.',
      requiresManualReview: true,
    };
  }

  if (obj.kind === 'plan_proposal') {
    if (
      typeof obj.summary !== 'string' ||
      !obj.summary.trim() ||
      !Array.isArray(obj.tasks) ||
      obj.tasks.length === 0
    ) {
      return {
        valid: false,
        parseStatus: 'incomplete',
        rawBody,
        errorReason: 'Proposta de plano incompleta: summary ou tasks ausentes.',
        requiresManualReview: true,
      };
    }
    const validTasks = obj.tasks.every(
      (t) =>
        t &&
        typeof t === 'object' &&
        typeof (t as Record<string, unknown>).title === 'string' &&
        typeof (t as Record<string, unknown>).description === 'string' &&
        Array.isArray((t as Record<string, unknown>).acceptanceCriteria),
    );
    if (!validTasks) {
      return {
        valid: false,
        parseStatus: 'invalid',
        rawBody,
        errorReason: 'Uma ou mais tarefas do plano estão sem título, descrição ou critérios.',
        requiresManualReview: true,
      };
    }
    return {
      valid: true,
      parseStatus: 'valid',
      parsed: obj as unknown as PlanProposalPayload,
      rawBody,
      requiresManualReview: false,
    };
  }

  if (obj.kind === 'delivery_report') {
    if (
      Object.prototype.hasOwnProperty.call(obj, 'attemptId') &&
      obj.attemptId !== undefined &&
      (typeof obj.attemptId !== 'string' || !obj.attemptId.trim())
    ) {
      return {
        valid: false,
        parseStatus: 'invalid',
        rawBody,
        errorReason:
          'Campo attemptId inválido em delivery_report: quando presente, deve ser uma string não vazia.',
        requiresManualReview: true,
      };
    }
    if (
      typeof obj.taskId !== 'string' ||
      !obj.taskId.trim() ||
      typeof obj.deliverySummary !== 'string' ||
      !obj.deliverySummary.trim() ||
      !Array.isArray(obj.evidenceNotes)
    ) {
      return {
        valid: false,
        parseStatus: 'incomplete',
        rawBody,
        errorReason:
          'Relatório de entrega incompleto: taskId, deliverySummary ou evidenceNotes ausentes.',
        requiresManualReview: true,
      };
    }
    return {
      valid: true,
      parseStatus: 'valid',
      parsed: obj as unknown as DeliveryReportPayload,
      rawBody,
      requiresManualReview: false,
    };
  }

  if (obj.kind === 'review_decision') {
    if (
      Object.prototype.hasOwnProperty.call(obj, 'attemptId') &&
      obj.attemptId !== undefined &&
      (typeof obj.attemptId !== 'string' || !obj.attemptId.trim())
    ) {
      return {
        valid: false,
        parseStatus: 'invalid',
        rawBody,
        errorReason:
          'Campo attemptId inválido em review_decision: quando presente, deve ser uma string não vazia.',
        requiresManualReview: true,
      };
    }
    if (
      typeof obj.taskId !== 'string' ||
      !obj.taskId.trim() ||
      (obj.decision !== 'approved' && obj.decision !== 'rejected') ||
      typeof obj.rationale !== 'string' ||
      !obj.rationale.trim() ||
      !Array.isArray(obj.unmetCriteria)
    ) {
      return {
        valid: false,
        parseStatus: 'incomplete',
        rawBody,
        errorReason:
          'Parecer de revisão incompleto: taskId, decision ("approved"|"rejected"), rationale ou unmetCriteria inválidos.',
        requiresManualReview: true,
      };
    }
    return {
      valid: true,
      parseStatus: 'valid',
      parsed: obj as unknown as ReviewDecisionPayload,
      rawBody,
      requiresManualReview: false,
    };
  }

  return {
    valid: false,
    parseStatus: 'invalid',
    rawBody,
    errorReason: `Tipo desconhecido no contrato interno: "${String(obj.kind ?? '')}".`,
    requiresManualReview: true,
  };
}
