# Arquitetura do Vértice Workspace

Este documento descreve a organização técnica do **Vértice Workspace** (*Powered by AionCore*), a separação entre interface, domínio, gateways, transportes e persistência, além dos pontos exatos para estender ou validar a integração com o **AionCore**. Os identificadores internos de persistência e protocolo (`aion-desk-db`, `aion-desk/v1`, `aion-desk-json`) são preservados por retrocompatibilidade.

---

## 1. Visão em camadas

```text
┌─────────────────────────────────────────────────────────────────────────┐
│ UI React (`src/features/*`, `src/components/*`)                         │
│ - Consome apenas o contrato público `AgentWorkspaceGateway`             │
│ - Nunca importa Core/CLIs diretamente                                   │
└───────────────────────────────┬─────────────────────────────────────────┘
                                │ AgentWorkspaceGateway (`src/services/gateway.ts`)
         ┌──────────────────────┴──────────────────────┐
         ▼                                             ▼
┌─────────────────────────────┐         ┌─────────────────────────────────┐
│ `MockWorkspaceGateway`      │         │ `AionCoreAdapter`               │
│ (`src/services/mockGateway`)│         │ (`src/services/aionCoreAdapter`)│
│ - Modo `demo` determinístico│         │ - Modo `aion_core` real         │
│ - Usa `collaborationEngine` │         │ - Usa `aionCoreTransport` + DTOs│
└──────────────┬──────────────┘         └────────────────┬────────────────┘
               │                                         │
               ▼                                         ▼
┌─────────────────────────────┐         ┌─────────────────────────────────┐
│ Domínio puro (`src/domain/`)│         │ Transporte HTTP/WS isolado      │
│ - `types.ts` (schema v2)    │         │ (`src/services/aionCoreTransport`)│
│ - `reducer.ts` incremental  │         │ (`src/services/aionCoreDtos.ts`)  │
│ - `teamValidation.ts`       │         │                                 │
│ - `taskRules.ts`            │         └─────────────────────────────────┘
│ - `internalProtocol.ts`     │
│ - `migration.ts` (v1 → v2)  │
└──────────────┬──────────────┘
               │
               ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ Persistência & Backup (`src/services/storage.ts`, `exportService.ts`)   │
│ - IndexedDB (`aion-desk-db`) serializado por mutex + debounce           │
│ - Fallback transparente para memória (`Somente nesta sessão`)           │
│ - Exportação Markdown + JSON versionado restaurável (sem credenciais)   │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Separação de entidades no domínio (`src/domain/types.ts`)

1. **`ConnectionAdapterConfig` (Conexão / Adaptador)**:
   - Representa um provedor/assistente disponível em modo `demo` ou `aion_core`.
   - Mantém seis estados distintos e explícitos:
     1. `configured` (configurada localmente)
     2. `coreReachability` (`unknown` | `reachable` | `unreachable`)
     3. `executableStatus` (`verified` | `missing` | `unknown_in_browser` | `unknown`)
     4. `authStatus` (`simulated` | `authenticated` | `unauthenticated` | `expired` | `unknown`)
     5. `catalogLoaded` + `availableModels`
     6. `sessionStatus` (`inactive` | `active` | `disconnected` | `error`)
   - Capacidades operacionais usam `CapabilityFlag = boolean | 'unknown'`.

2. **`ModelRef` (Modelo)**:
   - Separa `externalId` (quando conhecido do catálogo/sessão), `displayName`, `source` (`demo_tier` | `core_catalog` | `core_session` | `user_preference`) e `confirmation` (`confirmed` | `simulated` | `unverified_preference`).
   - Preferências locais como `Terra 6.1`, `Sol 6.1` ou `Gemini Hydrogen` podem ser salvas sem afirmar disponibilidade real até resolução em catálogo/sessão do Core.

3. **`Participant` & `SessionRef` (Participante e Sessão)**:
   - `Participant` pertence a uma conversa específica, tem `displayName` editável, `connectionId`, `modelRef`, `instructions`, `roles: ParticipantRole[]` (`coordinator` | `planner` | `executor` | `reviewer`) e `tabOrder`.
   - Dois participantes conectados ao mesmo backend/conexão (ex.: duas sessões Codex) recebem `Participant.id` e `SessionRef` independentes, preservando histórico, rascunho de aba e posição de leitura isolados.
   - Alterações de coordenador (`coordinator_changed`) e de modelo/papel/instruções (`participant_configured`) são registradas em log auditável e aplicam-se apenas a **novas tarefas/próximas tentativas**, sem reescrever tentativas passadas (`modelRefUsed`, `rolesSnapshot`, `instructionsSnapshot`).

4. **Fluxo de tarefas, plano, contexto e permissões**:
   - **`PlanRevision`** (`v1`, `v2`, ...): revisões imutáveis vinculadas às tarefas publicadas.
   - **`Task`**: dependências verificadas contra referências inválidas e ciclos (`validateTaskInput`), critérios de aceitação, `assigneeParticipantId`, `reviewerParticipantId`, contagem separada de `qualityRejectionCount` e `operationalFailureCount`, e flag `independentReview` calculada por `checkAuditIndependence`.
   - **`SharedContextRevision`** + **`ContextReceipt`**: cada participante recebe status individual (`pending_send`, `sent`, `received`, `applied`, `failed_needs_action`).
   - **`PermissionRequest`**: escopo estrito por `(participantId, actionKey, scopeKey, taskId)` e suporte explícito a `supersedesRequestId` (`isPermissionStillBlocked`).
   - **Protocolo estruturado interno (`src/domain/internalProtocol.ts`)**: envelope `aion-desk/v1` em blocos `aion-desk-json` para propostas de plano, relatórios de entrega e pareceres de auditoria, mantendo saída bruta acessível e marcando saídas incompletas/inválidas como pendentes de revisão manual.

---

## 3. Processamento de eventos e reconciliação (`src/domain/reducer.ts`)

- **Processamento incremental**: `applyEventIncrementally` atualiza apenas os registros da conversa afetada (`messagesByTab`, `generalFeed`, `tasks`, `participants`, `contextRevisions`, `planRevisions`, `permissions`, `escalations`).
- **Deduplicação e ordenação por conversa**:
  - `seenEventIds` impede reaplicação do mesmo `event.id`.
  - Se `event.seq === lastAppliedSeq + 1`, aplica imediatamente e drena `pendingOutOfOrder` contíguos.
  - Se `event.seq > lastAppliedSeq + 1`, coloca no buffer `pendingOutOfOrder` e sinaliza `syncState: 'gap_detected'`.
- **Reconciliação**:
  - `missing_events`: mescla eventos faltantes ao buffer e drena a sequência contígua sem descartar eventos posteriores já recebidos.
  - `snapshot`: preserva obrigatoriamente eventos com `seq > snapshotSeq` (inclusive recebidos durante a consulta) e reaplica-os em ordem sobre o snapshot.
- **Limitação explícita de paginação**: `MessageStream` pagina blocos de mensagens sem montar todas as abas ocultas simultaneamente, preservando posição de leitura e rascunhos por aba.

---

## 4. Persistência, migração e backup (`src/services/storage.ts`, `src/domain/migration.ts`, `src/services/exportService.ts`)

- **Schema v2** com migração automática a partir do schema v1 (`migrateWorkspaceState`): preserva projetos, conversas, IDs de participantes e histórico, criando `ConnectionAdapterConfig[]`, `SessionRef`, `ModelRef` e os presets padrão sem perda de dados. Versões futuras desconhecidas lançam `IncompatibleSchemaError` sem apagar os dados atuais.
- **Durabilidade honesta**: gravações no IndexedDB são serializadas por mutex e debounce; erros de cota (`QuotaExceededError`) ou indisponibilidade alteram o indicador para `Somente nesta sessão` (`session_only`) e preservam o estado em memória com opção imediata de exportar backup JSON.
- **Backup JSON (`exportSchemaVersion: "2.0.0"`)**:
  - Nunca inclui senhas, cookies, tokens JWT/CSRF ou `authStatus: 'authenticated'` reaproveitável.
  - `parseAndValidateWorkspaceBackup` valida o arquivo antes de alterar o workspace; o usuário escolhe explicitamente entre **Importar como cópia** (com remapeamento consistente de IDs) ou **Substituir workspace atual**.
- **Reinício de demonstração (`resetDemo`)**: recria apenas o cenário demonstrativo, preservando projetos e conversas em modo `aion_core`.

---

## 5. Onde trocar ou estender a integração

- **Contrato principal**: `src/services/gateway.ts` (`AgentWorkspaceGateway`).
- **Fábrica de modo**: `src/features/workspace/WorkspaceContext.tsx` instancia `MockWorkspaceGateway` (`demo`) ou `AionCoreAdapter` (`aion_core`) via `WorkspaceGatewayFactory`, mantendo o modo `aion_core` isolado de timers de simulação.
- **Transporte HTTP/CSRF/WS**: `src/services/aionCoreTransport.ts` e `src/services/aionCoreDtos.ts`.
