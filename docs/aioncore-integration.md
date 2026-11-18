# Integração Aion Desk ↔ AionCore (`v0.2.2`)

Este documento registra exatamente **o que foi implementado com base nos contratos verificados**, a **proveniência dos DTOs e transportes**, o **mapa de identificadores** e as **operações que dependem de validação local contra o binário AionCore em execução**.

---

## 1. Proveniência dos contratos consultados

- **AionCore `v0.2.2`**: commit `503a87199eb978790ca77675b39c84b241535bf3` (`crates/aionui-app`, `crates/aionui-api-types`, `crates/aionui-team`, `crates/aionui-ai-agent`, `crates/aionui-assistant`, `crates/aionui-auth`, `crates/aionui-realtime`).
- **AionUi `2.2.2`**: commit `e108b6b56b1a6eb99a00904878d0582f657b2908` (`packages/desktop/src/common/adapter/httpBridge.ts` e `sessionRefresh.ts`), sob licença **Apache-2.0** (atribuição preservada no cabeçalho de `src/services/aionCoreTransport.ts` e em `THIRD_PARTY_NOTICES.md`).
- **Fixtures e validação real (`V6-01` a `V6-09`)**: `src/services/__tests__/fixtures/coreV022RealPayloads.ts` incorpora payloads reais sanitizados capturados do `aioncore.exe v0.2.2` no Windows 11 (além das fixtures contratuais em `aionCoreAdapter.test.ts`); a integração real ponta a ponta foi comprovada localmente com `Codex` (`gpt-5.6-luna`), `Cursor` (`composer-2.5`) e continuidade pós-reinício no `Antigravity` (`agy.exe 1.5.9`), conforme `docs/v6-progress.md` e `docs/v6-09-release-candidate.md`.

---

## 2. Operações implementadas no `AionCoreAdapter` (`src/services/aionCoreAdapter.ts`)

| Operação | Método / Rota Core | DTO / Envelope usado | Estado na entrega |
| :--- | :--- | :--- | :--- |
| Saúde do Core | `GET /health` | `HealthResponse` (`status`, `version`, `build_time`) | Implementado e testado por fixture (`assertHealthResponse`). |
| Status de autenticação | `GET /api/auth/status` | `AuthStatusResponse` (`success`, `needs_setup`, `user_count`, `is_authenticated`) | Implementado e testado por fixture. |
| Login e logout | `POST /login`, `POST /logout` | `LoginRequest` / `LoginResponse` (`user`, `token` opcional além de cookies HttpOnly) | Implementado; credenciais nunca são persistidas em IndexedDB/JSON. |
| Renovação single-flight | `POST /api/auth/refresh` | `RefreshResponse` coalescido por `refreshPromise` em `AionCoreHttpClient` | Implementado e testado contra múltiplos `401` simultâneos. |
| Proteção CSRF double-submit | Cookie `aionui-csrf-token` → header `x-csrf-token` | Aplicado automaticamente em `POST`, `PUT`, `PATCH`, `DELETE` | Implementado e testado com `403` CSRF. |
| Token WebSocket | `GET /api/ws-token` | `WsTokenResponse` (`success`, `ws_token`, `expires_in`) | Implementado e testado por fixture. |
| Catálogo de agentes e assistentes | `GET /api/agents/management`, `GET /api/assistants` | `ApiResponse<AgentManagementRow[]>` e `ApiResponse<AssistantResponse[]>` | Implementado; popula `connections` com estados separados (`configured`, `coreReachability`, `executableStatus`, `authStatus`, `catalogLoaded`). |
| Listar / criar equipes | `GET /api/teams`, `POST /api/teams` | `CreateTeamRequest` com `TeamAgentInputCompat` (`assistant_id`, `name`, `role: 'lead' | 'teammate'`, `model`, **sem** campo `backend`) | Implementado e testado; preserva `deny_unknown_fields`. |
| Envio ao líder (Geral) | `POST /api/teams/{id}/messages` | `{ content, files? }` → `ApiResponse<TeamRunAckResponse>` | Implementado; ACK marca entrega como `enqueued_core` sem marcar tarefa concluída. |
| Envio ao participante (aba) | `POST /api/teams/{id}/agents/{slot_id}/messages` | `{ content, files? }` → `ApiResponse<TeamRunAckResponse>` | Implementado e validado via rota por `slot_id`. |
| Canal WebSocket | `/ws` com subprotocolo único `[ws_token]` (`Sec-WebSocket-Protocol`) | Normaliza `CORE_WS_EVENTS` (`crates/aionui-team/src/events.rs`): `team.slotWorkChanged`, `message.stream` (`data.content` + `msg_id`/`turn_id`), `team.childTurnStarted`, `team.childTurnCompleted` (`status: 'completed' \| 'failed' \| 'cancelled'`), `team.childTurnCancelled`, `team.runFailed` (`TeamRunPayload` com `team_id` + `target_slot_id` + `slot_work[]`), `team.runCancelled`, `team.taskChanged` e `team.mailboxChanged`; isola por `externalConversationId`/`team_id`/`slot_id` e deduplica reentregas | Implementado e testado contra fixtures baseadas nos fontes Rust (`503a8719`). |
| Pipeline colaborativo (`aion-desk/v1`) | `composeCoreOutgoingContent` + `finalizeCoreAgentMessage` em `AionCoreAdapter` | Compõe papel, instruções, equipe, `SharedContextRevision` (recibos `sent` → `received` → `applied`) e feedback de auditoria; interpreta `plan_proposal`, `delivery_report` e `review_decision` com revisão manual em saída inválida | Implementado e validado em ciclos reais com `Codex` (`gpt-5.6-luna`) e `Cursor` (`composer-2.5`), além de permissões (`allow`/`reject`), cancelamento (`POST .../cancel`) e revisão manual em saída inválida (`V6-04`/`V6-05`/`V6-06`). |
| Catch-up de histórico e reconexão | `GET /api/teams/{id}/run-state`, `/mailbox`, `/tasks`, `/activity` | Consome `TeamRunStateResponse`, `TeamMailboxMessageResponse[]` (`from_agent_id`/`to_agent_id`), `TeamTaskResponse[]` (`subject`/`owner`/`blocked_by`/`updated_at` com atualização idempotente) e `TeamActivityPageResponse` paginado com `cursor_ts` + `cursor_id` (`TeamActivityItemResponse` aninhado); rejeita identidades não resolvidas sem fallback silencioso ao coordenador, protege mutações WS concorrentes e snapshots antigos, marca `syncState: 'incomplete'` em falha parcial e dispara catch-up ao reconectar WS | Implementado e validado contra fixtures sanitizadas e contra `aioncore.exe v0.2.2` real (`paused_queue`, `Reconciliar agora`, `Retomar fluxo` e reinício de servidor/Core em `V6-06`/`V6-08`). |

---

## 3. Mapa de identificadores e sequência

| Conceito no Aion Desk | Identificador interno | Vínculo externo no AionCore |
| :--- | :--- | :--- |
| Conversa do Desk | `conversation.id` | `conversation.externalTeamId` (`TeamResponse.id`) |
| Participante na conversa | `participant.id` | `participant.sessionRef.externalSlotId` (`TeamAgentResponse.slot_id`) |
| Sessão individual do participante | `participant.sessionRef.id` | `participant.sessionRef.externalConversationId` (`TeamAgentResponse.conversation_id`) |
| Conexão / Assistente | `connection.id` | `connection.coreAssistantId` (`AssistantResponse.id`) e `coreAgentId` (`AgentManagementRow.id`) |
| Papéis do Desk | `coordinator`, `planner`, `executor`, `reviewer` | Coordenador → `role: 'lead'`; demais → `role: 'teammate'`. Papéis internos seguem via instruções estruturadas `aion-desk/v1`. |
| Ordem contígua no reducer | `event.seq` (contrato interno do Aion Desk) | **Não** presumido nos eventos do Core. Eventos externos recebidos em tempo real recebem sequência local incremental na ingestão após deduplicação por ID externo quando disponível. |

---

## 4. Capacidades sem contrato completo ou dependentes de validação local

- **Execução real de `interrupt`, `pause_queue`, `terminate_session` e `setModel`/`config-options`**:
  - O Core expõe rotas de controle (`/agents/{slot_id}/interrupt`, `/runs/{team_run_id}/agents/{slot_id}/pause`, `/conversations/{conversation_id}/config-options/{option_id}`), porém o comportamento em curso por CLI específico (`codex` vs `antigravity`), formato exato dos nomes de eventos WebSocket emitidos por turno e confirmações `observed` / `pending_next_turn` / `command_ack` dependem da execução local real.
  - Por segurança e transparência, `AgentCatalogSection` marca `supportsInterrupt`, `supportsMidRunContextInjection`, `supportsModelSwitchInSession`, `supportsPauseQueue` e `supportsSessionTerminate` como **`desconhecida`** para conexões `aion_core` até confirmação local.
- **Camada local exclusiva do Aion Desk**:
  - `SharedContextRevision` + `ContextReceipt`, `PlanRevision`, `qualityRejectionCount` vs `operationalFailureCount` e política de `escalation` permanecem metadados locais persistidos e vinculados ao `externalTeamId`, já que o Core v0.2.2 não implementa revisão imutável com recibos nem escalonamento automático por qualidade nativamente.
- **Política de não-retry em POSTs não idempotentes**:
  - Requisições `POST /api/teams`, `POST /api/teams/{id}/messages` e `POST /api/teams/{id}/agents/{slot_id}/messages` nunca são reenviadas automaticamente em caso de timeout ou resposta ambígua.
