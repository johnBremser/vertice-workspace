# Arquitetura do Vértice Workspace

Este documento descreve a organização técnica atual do **Vértice Workspace** (*Powered by AionCore*), a separação entre interface, domínio, adaptador Core, transportes, servidor local e persistência, além dos identificadores legados preservados por compatibilidade.

---

## 1. Visão em camadas

```text
┌─────────────────────────────────────────────────────────────────────────┐
│ UI React (`src/features/*`, `src/components/*`)                         │
│ - Consome apenas `WorkspaceContext` → contrato `AgentWorkspaceGateway`  │
│ - Inclui aba `Arquivos` (`FilesPanel`) e Assistente Vértice isolado     │
│ - Nunca importa Core/CLIs diretamente                                   │
└───────────────────────────────┬─────────────────────────────────────────┘
                                │ AgentWorkspaceGateway (`src/services/gateway.ts`)
                                ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ `AionCoreAdapter` (`src/services/aionCoreAdapter.ts`)                   │
│ - Operação exclusiva em Modo AionCore local (`aion_core`)               │
│ - Orquestra equipes, tarefas, entregas/pareceres, permissões e catch-up │
│ - Usa `aionCoreTransport.ts` (HTTP/CSRF/WS) + `aionCoreDtos.ts`         │
└──────────────┬─────────────────────────────────────────┬────────────────┘
               │                                         │
               ▼                                         ▼
┌─────────────────────────────┐         ┌─────────────────────────────────┐
│ Domínio puro (`src/domain/`)│         │ Serviços auxiliares locais      │
│ - `types.ts` (schema v2)    │         │ (`scripts/vertice-server.mjs`   │
│ - `reducer.ts` incremental  │         │  e middlewares dev no Vite)     │
│ - `teamValidation.ts`       │         │ - `vertice-source-reader.mjs`   │
│ - `taskRules.ts`            │         │ - `vertice-folder-picker.mjs`   │
│ - `internalProtocol.ts`     │         │ - `vertice-workspace-diff.mjs`  │
│ - `migration.ts` (v1 → v2)  │         │ - `node-compat.mjs`             │
└──────────────┬──────────────┘         └─────────────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ Persistência & Backup (`src/services/storage.ts`, `exportService.ts`)   │
│ - IndexedDB (`aion_desk_storage`, store `workspace`, chave `root_state`)│
│ - Preferências leves em `localStorage` (`aion_desk_ui_prefs_v1`)        │
│ - Fallback transparente para memória (`Somente nesta sessão`)           │
│ - Exportação Markdown + JSON versionado (`2.0.0`, sem credenciais)      │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Separação de entidades no domínio (`src/domain/types.ts`)

1. **`ConnectionAdapterConfig` (Conexão / Adaptador)**:
   - Representa um provedor/assistente descoberto no **AionCore Local**.
   - Mantém estados explícitos de alcançabilidade e autenticação:
     1. `configured` (configurada localmente)
     2. `coreReachability` (`unknown` | `reachable` | `unreachable`)
     3. `executableStatus` (`verified` | `missing` | `unknown_in_browser` | `unknown`)
     4. `authStatus` (`simulated` | `authenticated` | `unauthenticated` | `expired` | `unknown`)
     5. `catalogLoaded` + `availableModels` (incluindo `reasoningEfforts` e `reasoningOptionId`)
     6. `sessionStatus` (`inactive` | `active` | `disconnected` | `terminated` | `unknown`)
   - Capacidades operacionais usam `CapabilityFlag = boolean | 'unknown'`.

2. **`ModelRef` (Modelo)**:
   - Separa `externalId` (quando resolvido no catálogo/sessão do Core), `displayName`, `source` (`demo_tier` | `core_catalog` | `core_session` | `user_preference`), `confirmation` (`confirmed` | `simulated` | `unverified_preference`) e `reasoningEffort`.

3. **`Participant` & `SessionRef` (Participante e Sessão)**:
   - `Participant` pertence a uma conversa específica, com `displayName` editável, `connectionId`, `modelRef`, `instructions`, `roles: ParticipantRole[]` (`coordinator` | `planner` | `executor` | `reviewer`) e `tabOrder`.
   - Múltiplos participantes vinculados ao mesmo provedor/CLI recebem `Participant.id` e `SessionRef` (`externalTeamId`, `externalSlotId`, `externalConversationId`, `nativeSessionId`) independentes, preservando histórico, rascunho de aba e posição de rolagem isolados.
   - Alterações de coordenador (`coordinator_changed`) e de modelo/papel/instruções (`participant_configured`) ficam registradas em histórico auditável e aplicam-se apenas a **novas tarefas/próximas tentativas**, sem reescrever snapshots passados (`modelRefUsed`, `rolesSnapshot`, `instructionsSnapshot`).

4. **Fluxo de tarefas, plano, contexto e permissões**:
   - **`PlanRevision`** (`v1`, `v2`, ...): revisões imutáveis vinculadas às tarefas publicadas.
   - **`Task`**: dependências verificadas contra referências inexistentes e ciclos (`validateTaskInput`), critérios de aceitação, `assigneeParticipantId`, `reviewerParticipantId`, separação entre `qualityRejectionCount` e `operationalFailureCount`, e `independentReview` calculado via `checkAuditIndependence`.
   - **`SharedContextRevision`** + **`ContextReceipt`**: recibos individuais monotônicos por participante (`pending_send` → `sent` → `received` → `applied` / `failed_needs_action`).
   - **`PermissionRequest` e política por conversa (`toolApprovalPolicy`)**:
     - `WorkspaceConversation.toolApprovalPolicy` suporta `'manual'` (padrão), `'allow_read_edit'` (classificação *fail-closed* via `classifyToolPermissionKind` em `taskRules.ts`) e `'allow_all_in_conversation'` (sessão atual, revertido automaticamente para `'manual'` no reload em `sanitizeLoadedStateAfterReload()` e em exportações/importações de backup).
     - Recusas prévias não superadas (`isPermissionStillBlocked` e `hasBlockingDenialForAutoApproval`) bloqueiam auto-aprovação, mantendo trilha auditável (`permission_requested` + `permission_decided`).
     - O **Assistente Vértice** (`VerticeAssistantWidget`) opera em sessão isolada e estritamente somente leitura (`accessMode: 'read_only'`), sem herdar políticas de auto-aprovação.
   - **Protocolo estruturado interno (`src/domain/internalProtocol.ts`)**: envelope `aion-desk/v1` em blocos `aion-desk-json` para `plan_proposal`, `delivery_report` e `review_decision`, validado com correlação estrita de tarefa/tentativa/autor e preservação de saídas inválidas/incompletas para revisão manual.

---

## 3. Processamento de eventos, recuperação e paginação (`src/domain/reducer.ts`)

- **Processamento incremental**: `applyEventIncrementally` atualiza apenas a projeção da conversa afetada (`messagesByTab`, `generalFeed`, `tasks`, `participants`, `contextRevisions`, `planRevisions`, `permissions`, `escalations`).
- **Deduplicação e ordenação por conversa**:
  - `seenEventIds` impede reaplicação de eventos duplicados.
  - Eventos contíguos (`event.seq === lastAppliedSeq + 1`) são aplicados imediatamente e drenam `pendingOutOfOrder`.
  - Lacunas (`event.seq > lastAppliedSeq + 1`) ficam em `pendingOutOfOrder` e marcam `syncState: 'gap_detected'`.
- **Recuperação após recarga ou reconexão**:
  - Ao recarregar a página, `sanitizeLoadedStateAfterReload()` move conversas que estavam `running` para `paused_queue`, invalida flags voláteis de sessão/alcance e reverte `allow_all_in_conversation` para `'manual'`.
  - Na abertura, `probeCoreSessionOnStartup()` verifica `/health`, `/api/auth/status`, catálogo e WebSocket silenciosamente.
  - Em reconexões WS (`catchUpBoundConversationsAfterReconnect()`), o adaptador consulta `/run-state`, `/mailbox`, `/tasks` e `/activity` paginado, preservando eventos simultâneos sem autodespachar novas etapas em `paused_queue`.
- **Paginação visual em memória**:
  - O histórico carregado da conversa fica em memória na projeção ativa (`WorkspaceStoreState`); `MessageStream` renderiza inicialmente uma janela de 40 itens (`PAGE_SIZE = 40`) e expande sob demanda ao clicar em *"Carregar eventos anteriores"*, preservando rascunhos e posição de rolagem por aba. `getPaginatedEvents` no gateway opera sobre essa projeção em memória (não há paginação em disco/IndexedDB na v1).

---

## 4. Persistência, migração e backup (`src/services/storage.ts`, `src/domain/migration.ts`, `src/services/exportService.ts`)

- **Schema v2** com migração automática a partir do schema v1 (`migrateWorkspaceState`): preserva projetos, conversas, IDs de participantes e histórico, preenchendo `ConnectionAdapterConfig[]`, `SessionRef`, `ModelRef` e presets padrão. Versões futuras desconhecidas lançam `IncompatibleSchemaError` sem sobrescrever os dados existentes.
- **Durabilidade honesta**: gravações no IndexedDB (`aion_desk_storage`, store `workspace`, chave `root_state`) são serializadas por fila/mutex e debounce (`180ms`); erros de cota (`QuotaExceededError`) ou indisponibilidade mudam o estado para `Somente nesta sessão` (`session_only`) mantendo os dados em memória e oferecendo exportação imediata.
- **Backup JSON (`exportSchemaVersion: "2.0.0"`)**:
  - Nunca inclui senhas, cookies, tokens JWT/CSRF ou sessões ativas no Core.
  - `parseAndValidateWorkspaceBackup` valida o arquivo antes de alterar o workspace; `applyImportedWorkspaceBackup` permite **Importar como cópia** (remapeando IDs e preservando a sessão viva do Core) ou **Substituir workspace atual**, sempre desconectando vínculos externos e revertendo `allow_all_in_conversation` para `'manual'`.

---

## 5. Pontos de extensão, servidor local e diagnóstico

- **Contrato principal**: `src/services/gateway.ts` (`AgentWorkspaceGateway` e `CoreGatewayOperations`).
- **Fábrica na UI**: `src/features/workspace/WorkspaceContext.tsx` instancia `AionCoreAdapter` via `defaultGatewayFactory`, sem simulador interno nem fallback fictício.
- **Transporte HTTP/CSRF/WS**: `src/services/aionCoreTransport.ts` e `src/services/aionCoreDtos.ts`.
- **Servidor estático e serviços locais loopback (`scripts/`)**:
  - `scripts/node-compat.mjs`: fonte única da regra `^22.12.0 || ^24.0.0 || >=26.0.0` (`engines.node`), reutilizada por `package.json` (`pre*` hooks e `npm run node:check`), `vertice-ctl.mjs`, `vertice-server.mjs` e scripts PowerShell (`install.ps1`, `start-vertice.ps1`, `stop-vertice.ps1`).
  - `scripts/vertice-server.mjs`: servidor Node puro em loopback (`127.0.0.1:4173`), proxy de mesma origem (`/api`, `/health`, `/login`, `/logout`, `/ws`), stripping de `x-vertice-control-token` e proteção `realpathSync` contra escape em `dist/`.
  - `scripts/vertice-ctl.mjs`: controle de ciclo de vida autenticado (`doctor`, `start`, `status`, `stop`) com ACL restritiva no Windows em `.vertice/server.json`.
  - `scripts/vertice-source-reader.mjs`: leitura segura somente leitura de código-fonte do Vértice para o Assistente (`/__vertice_assistant/*`).
  - `scripts/vertice-folder-picker.mjs`: navegação local segura de diretórios (`/__vertice_local/picker/*`).
  - `scripts/vertice-workspace-diff.mjs`: listagem de arquivos alterados e diff Git (ou fallback `filesystem_recent`) restrita ao workspace ativo (`/__vertice_workspace/*`), consumida pela aba **Arquivos** (`src/features/inspector/FilesPanel.tsx` / `InspectorDrawer.tsx`).

---

## 6. Identificadores legados preservados por compatibilidade

Para evitar quebra de instalações, backups e contratos existentes após a adoção da marca **Vértice Workspace**, os identificadores técnicos abaixo são mantidos propositalmente:

| Camada | Nome / Identificador atual | Motivo da preservação |
| :--- | :--- | :--- |
| Marca do produto | **Vértice Workspace** (*Powered by AionCore*) | Identidade visual, interface, docs e launchers. |
| Pacote npm | `aion-desk` (`package.json`) | Identificador do pacote de workspace/CI. |
| Protocolo interno | `aion-desk/v1`, blocos `aion-desk-json` | Compatibilidade com prompts, parsers e histórico persistido. |
| IndexedDB | Banco `aion_desk_storage`, store `workspace`, chave `root_state` | Preservar dados locais já gravados no navegador dos usuários. |
| Preferências UI | `aion_desk_ui_prefs_v1`, `aion_desk_mode_pref_v1` (`localStorage`) | Manter tema, estado da gaveta/barra e preferência salva. |
| Backup JSON | `exportSchemaVersion: "2.0.0"` | Garantir restauração de backups entre versões. |
| Runtime Core externo | `aioncore.exe`, `aionui-backend.db`, rotas `/api/*`, `/ws` | Contratos externos definidos pelo binário oficial **AionCore**. |
