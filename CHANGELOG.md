# Changelog — Vértice Workspace

Este arquivo registra a evolução técnica do **Vértice Workspace** (*Powered by AionCore*), mantendo distinção rigorosa entre o que foi validado por fixtures/navegador e o que ainda depende de comprovação contra o `AionCore v0.2.2` e CLIs locais reais.

---

## [Não lançado — V6 Local (V6-00 a V6-10 aprovados; V6-11 a BL-03 entregues localmente)]

### Política de aprovação de ferramentas, arquivos/diff e ambiente reproduzível (`BL-01`, `BL-02`, `BL-03` — 27/11/2026)

- **BL-01 — Política de aprovação automática de ferramentas por conversa (`acp_permission`)**:
  - Campo opcional `toolApprovalPolicy` (`'manual' | 'allow_read_edit' | 'allow_all_in_conversation'`) em `WorkspaceConversation` (`src/domain/types.ts`) e `canAllowAlways` em `PermissionRequest`.
  - Classificação *fail-closed* (`classifyToolPermissionKind`), validação estrita de destino dentro do workspace (`extractPermissionTargetPaths`, `isTargetPathWithinWorkspace`), avaliação de política (`shouldAutoApprovePermission`) e proteção contra recusa prévia vinculada ao `scopeKey` (`hasBlockingDenialForAutoApproval`) em `src/domain/taskRules.ts`.
  - Reversão obrigatória de `allow_all_in_conversation` para `'manual'` no reload (`sanitizeLoadedStateAfterReload` em `src/services/storage.ts`), na exportação JSON e na importação de backup (`copy` e `replace` em `src/services/exportService.ts`).
  - Auto-aprovação auditável (`permission_requested` + `permission_decided` por `'Política automática da conversa'`) e suporte a `alwaysAllow` em `src/services/aionCoreAdapter.ts`, utilizando o diretório efetivo da equipe (`coreTeamWorkspace`) + confirmação real no sistema de arquivos via `GET /__vertice_workspace/verify-path` (*fail-closed* quando o destino real for incerto), mantendo o **Assistente Vértice** isolado em modo somente leitura.
  - Controle de política por conversa com modal de confirmação explícita em `src/features/workspace/Composer.tsx` e botão secundário em `src/components/PermissionCard.tsx`.
- **BL-02 — Lista de arquivos alterados e visualizador de diff do workspace**:
  - Módulo somente leitura `scripts/vertice-workspace-diff.mjs` integrado a `scripts/vertice-server.mjs` e `vite.config.ts` expondo `GET /__vertice_workspace/changes`, `GET /__vertice_workspace/diff` e `GET /__vertice_workspace/verify-path` (loopback-only, restrição via `allowedWorkspaces` / `VERTICE_ALLOWED_WORKSPACES` documentada no `README.md`, anti-path-traversal, verificação de destino real de symlinks contra escape e lista de arquivos sensíveis com HTTP `403`, pathspecs literais `--literal-pathspecs` no Git, suporte a subdiretórios Git via `--show-prefix`, detecção de binários, limite seguro de 1.500 linhas / 200 KB e fallback honesto `filesystem_recent` fora de repositórios Git).
  - Cliente `src/services/workspaceDiffClient.ts` e nova aba **Arquivos** na gaveta **Trabalho** (`src/features/inspector/FilesPanel.tsx` e `InspectorDrawer.tsx`) com atualização automática em entregas/revisões, badges de status, contagem `+`/`-` e visualização de diff em tema claro/escuro.
- **BL-03 — Ambiente reproduzível, diagnóstico de Node e documentação atual**:
  - Regra única de compatibilidade (`^22.12.0 || ^24.0.0 || >=26.0.0`, rejeitando pré-lançamentos como `-rc.1` / `-alpha.1`) centralizada em `scripts/node-compat.mjs` e reutilizada em `scripts/vertice-ctl.mjs` (inclusive no início de `cmdStart` antes de encerrar instância ativa), `scripts/vertice-server.mjs`, `package.json` (`npm run node:check` e hooks `predev`/`prebuild`/`prestart`/`prepreview`/`prelint`/`pretest`) e scripts PowerShell (`scripts/install.ps1`, `scripts/start-vertice.ps1`, `scripts/stop-vertice.ps1`), sem alterar variáveis globais do usuário.
  - Documentação vigente alinhada à operação exclusiva com AionCore local (`docs/architecture.md`, `README.md`), corrigindo referência do IndexedDB (`aion_desk_storage`), documentando recuperação pós-reconexão, paginação em memória e tabela explícita de identificadores legados preservados por compatibilidade.
- **Referência de verificação (baseline 27/11/2026 — Node `v24.11.0`, npm `11.6.1`, Windows 11)**:
  - Verificação negativa em runtime incompatível (`node v20.18.1` via `node scripts/node-compat.mjs --check test`): saída `1` com diagnóstico claro em pt-BR antes de invocar ferramentas.
  - `npm run lint` (`tsc --noEmit`): **aprovado** (`0` erros).
  - `npm test` (`vitest run`): **aprovado** — **18 arquivos, 104/104 testes** (23,38s), cobrindo unitários de domínio, fixtures de contrato do Core, sincronização de workspace de equipes legadas, revalidação pós-verificação em disco, isolamento estrito de diff por arquivo único (com ou sem primeiro commit), rejeição de diretórios/pathspecs literais e subdiretórios Git no servidor local. *(Nota: testes automatizados validam contratos locais e fixtures; validação ao vivo com CLIs/modelos reais permanece separada.)*
  - `npm run build` (`vite build`): **aprovado** em 1,04s (`1868` módulos, sem avisos de chunk).
  - `npm run server:doctor`: **aprovado** (Node `v24.11.0`, `dist/` presente, loopback `127.0.0.1:4173` verificado).

### Instalação, launcher e servidor (`V6-00`, `V6-01`)

- `package-lock.json` multiplataforma atualizado para `npm ci` limpo no Windows e Linux com opcionais nativos.
- Identidade autenticada da instância em `scripts/vertice-ctl.mjs` e `scripts/vertice-server.mjs` (`instanceId`, `controlToken`, `/__vertice_ctl/identity`, `/__vertice_ctl/shutdown`) impedindo atuação sobre PIDs reutilizados.
- Validação de rota HTTP/WS com `safeDecodePathname` (`GET /%ZZ` → `400 Bad Request` sem derrubar o servidor) e build prévio de `dist/` no job E2E da CI.
- Integração real em loopback (`http://127.0.0.1:4173`) via proxy de mesma origem contra `aioncore.exe v0.2.2` com autenticação WebUI, cookies `HttpOnly`, double-submit CSRF e subprotocolo WS `[ws_token]`.

### Sessões reais, equipe, coordenação e segurança operacional (`V6-02` a `V6-05` — aprovado)

- Descoberta real de modelos em `snake_case`/`config_options`, captura de `nativeSessionId`, suporte a `Cursor` (`cursor-agent`), `Codex` e `Antigravity` sem Claude, e ciclos multi-agente de 3 tarefas dependentes com auditoria independente (`Sol Auditor`).
- Correlação estrita `aion-desk/v1` (`correlateDeliveryReport`, `correlateReviewDecision`, vínculo despacho ↔ `turn_id` em `team.childTurnStarted` e validação rígida de `attemptId`) impedindo conclusões/penalizações falsas por entregas tardias ou malformadas.
- Permissões nativas comprovadas (`Recusar` não executa operação; `Aprovar` executa), reprovação → correção → reauditoria, teto de 3 tentativas + escalonamento manual, saída inválida preservada para revisão manual, falha operacional separada de qualidade e interrupção `POST .../cancel` separando pedido enviado de confirmação `team.childTurnCancelled`.
- Agregação de `conversation.executionStatus` considerando dependências (`areTaskDependenciesSatisfied`) e capturas preservadas em `docs/screenshots/v6-05/`.

### Contexto versionado, recuperação pós-reload e backups (`V6-06` — aprovado)

- Semântica estrita e monotônica de recibos (`pending_send` → `sent` → `received` → `applied` / `failed_needs_action`) no reducer e adaptador, protegida contra corrida `team.childTurnStarted` vs ACK HTTP e mantendo revisões intermediárias `v2` em `pending_send`.
- Fluxo de retomada após fechamento/reload de aba (`paused_queue` persistido, bloqueio de auto-despacho, **`Reconciliar agora`** e **`Retomar fluxo`** explícitos via `controlExecution('resume_queue')` sem repetir pedido nem duplicar turno em curso), sinalização de `syncState: 'incomplete'` para pendências/401/404 e drenagem de `flushSave` no IndexedDB.
- Importação de backups JSON (`copy` e `replace`) desconectando vínculos externos Core (`importedExternalTeamId`/`importedExternalRef`), sem iniciar execução nem presumir login; capturas e relatório preservados em `docs/screenshots/v6-06/`.
- Estabilização determinística do fixture WebSocket em `viteProxyConfig.test.ts` e `localServerProxy.test.ts` tratando `ECONNRESET`.

### Acabamento visual e primeiro uso guiado (`V6-07` — aprovado)

- Controles de demonstração agrupados no menu secundário **`Simulação`** (`DemoControlsMenu.tsx`) preservando o marcador discreto `Modo Demonstração` e movendo IDs técnicos (`externalTeamId`, `sourceEventId`, IDs de revisão/permissão) para blocos `<details>` sem perder links de rastreabilidade.
- Compactação responsiva mobile do cabeçalho, abas e compositor (`WorkspaceHeader.tsx`, `AgentTabs.tsx`, `Composer.tsx`) + fechamento automático do `InspectorDrawer` ao reduzir abaixo de `xl` (`WorkspaceContext.tsx`).
- Rastreamento real de `coreRuntimeStatus` e invalidação pós-reload (`storage.ts`, `exportService.ts`, `aionCoreAdapter.ts`) com revalidação silenciosa automática de `/health`, `/api/auth/status` e catálogo ao recarregar em modo Core (`WorkspaceContext.tsx`), preservação da sessão viva ao importar backup em modo `copy` (`[P1]`), barra **`Próximo passo`**, tratamento de Core inacessível/sem agentes e filtro de banner residual (`src/App.tsx`); capturas e relatório em `docs/screenshots/v6-07/`.

### Distribuição local, diagnóstico e atualização segura (`V6-08` — aprovado)

- Endurecimento em `scripts/vertice-server.mjs`: validação `realpathSync` em `resolveDistFile()` bloqueando fuga por symlinks dentro de `dist/` e remoção de `x-vertice-control-token` antes do proxy HTTP/WS para o upstream.
- Expansão de `doctor` em `scripts/vertice-ctl.mjs` com validação de URL/porta, separação explícita entre URL inválida vs Core `inacessível`, aviso para `VITE_AIONCORE_BASE_URL` não vazio junto ao proxy, inventário de separação de diretórios e bloco `Ações e recuperação` sem vazar `controlToken` nem encerrar PIDs alheios.
- Documentação operacional separando Vértice Workspace, AionCore Local, runtime/requisitos de rede e CLIs/autenticação (`README.md`, `docs/compatibility-matrix.md`), além de guia de atualização/rollback seguro e evidências reais de extração limpa em `docs/screenshots/v6-08/`.

### Validação integrada e candidata funcional (`V6-09` — aprovado)

- Hardening de ACL no Windows em `.vertice/server.json` via `restrictPrivateFileAcl()` (`scripts/vertice-ctl.mjs`, removendo permissões herdadas com `icacls /inheritance:r`) + verificação em `verticeLauncher.test.ts` (`[P3]` do parecer V6-08).
- Incorporação de payloads reais sanitizados do `AionCore v0.2.2` em `src/services/__tests__/fixtures/coreV022RealPayloads.ts` e regressão integrada em `aionCoreAdapter.test.ts` (`team.childTurnStarted` ↔ `message.stream`, `tips`, `ConfirmRequest`, `PATCH .../model` e isolamento entre abas).
- Relatório consolidado dos 10 itens do roteiro de validação em `docs/v6-09-release-candidate.md` distinguindo prontidão funcional local de publicação e declaração futura de `v1.0.0`.

### Versionamento, higiene de repositório e documentação final (`V6-10` — pronto para publicação)

- Correção em `restrictPrivateFileAcl()` (`scripts/vertice-ctl.mjs`) concedendo permissão completa `:F` exclusivamente ao proprietário (evitando `EPERM` ao excluir `.vertice/server.json` fora de `%TEMP%`), verificada ao vivo no repositório.
- Desversionado `data/aionui-backend.db` e `data/aionui-backend.db.migrate.lock` do índice Git (`git rm --cached`) e adicionadas exclusões `data/`, `*.db` e `*.db.*` em `.gitignore`.
- Adicionados `THIRD_PARTY_NOTICES.md` (atribuições Apache-2.0 de `AionUi` e `AionCore`) e evidências da candidata em `docs/screenshots/v6-09/` (`v609-candidate-live-settings.png`, `v609_candidate_report.json`).
- Revisão e alinhamento completo de `README.md`, `docs/architecture.md`, `docs/aioncore-integration.md`, `docs/local-validation.md`, `docs/local-handoff.md` e `docs/v6-progress.md` para entrada pública sem declarar `v1.0.0`.

---

### Modo AionCore local como padrão de abertura (`V6-11`)

- O workspace passa a abrir em **Modo AionCore local** (HTTP/WS real contra o `aioncore.exe v0.2.2`) em vez da simulação determinística. A escolha explícita feita em **Configurações → Modo de operação do workspace** é memorizada (`aion_desk_mode_pref_v1`) e sempre prevalece sobre o padrão.
- Em modo Core o workspace começa **limpo**, sem o cenário de demonstração semeado; a simulação continua disponível e volta a semear o cenário determinístico quando selecionada.
- Resolução de modo no arranque coberta por regressão (`executionModePreference.test.ts` e `workspace.test.ts`): preferência explícita → workspace apenas semeado (segue o padrão) → workspaces de simulação legados preservados.
- A suíte Playwright agora **opta explicitamente** pelo modo de simulação (`addInitScript`), sem depender do padrão do produto.

### Ligação da equipe com assistentes reais do Core (`V6-12`)

- **Correção**: o seletor "Conexão / adaptador" filtrava as conexões pelo modo da conexão **atual** do participante. Um participante semeado na conexão de demonstração ficava preso nela e **não conseguia listar as conexões reais do Core** — impeditivo para sair da demonstração.
- Em **Modo AionCore local** o seletor agora oferece apenas as conexões reais do Core (mais a conexão atual, para o controle manter valor válido), e a lista de perfis salvos no formulário de novo participante só apresenta perfis vinculados ao Core.
- Aviso explícito no formulário quando ainda não há nenhuma conexão real do Core disponível (falta autenticar a sessão e sincronizar o catálogo).
- Regressão coberta por `src/domain/__tests__/teamValidation.test.ts` (`selectableConnectionsForMode`).

### Correção da resolução de modo no arranque (`V6-13`)

- **Correção**: a regra que mantinha workspaces de simulação legados no modo demo durante o arranque podia divergir do modo gravado no estado. Resultado: o badge anunciava **"Modo AionCore local"** enquanto o gateway de simulação era o ativo, e **"Verificar /health"** respondia "Alterne para o Modo AionCore local para executar operações do servidor Core".
- O modo gravado no estado passou a ser a fonte autoritativa (é ele que registra a última escolha explícita do usuário); apenas o workspace **apenas semeado** segue o padrão. A escolha explícita em Configurações continua prevalecendo sobre ambos.
- Trava adicional: após a troca de gateway, o modo persistido é alinhado ao gateway em uso, de modo que badge e capacidades reais nunca divirjam.
- Regressão coberta por `src/services/__tests__/executionModePreference.test.ts` (caso "respeita o modo gravado no estado mesmo com conversas de demonstração").

---

## [Histórico v5 — Prévia local]

> **Nota de estado**: A versão `v1.0.0` **ainda não está declarada pronta**. Os marcos `V5-02` a `V5-05` dependem de execução local com `AionCore v0.2.2` e CLIs autenticados (`codex`, `antigravity`).

### Identidade e Visual (`V5-01`)

- Aplicação da marca **Vértice Workspace**, slogan *"Seu time de agentes, do plano à entrega."* e assinatura técnica *"Powered by AionCore"* na interface, HTML, `brand.ts` e documentação vigente, preservando retrocompatibilidade integral com `aion_desk_storage`, `aion-desk/v1`, `aion-desk-json` e backups `2.0.0`.
- Novo sistema visual grafite e azul-petróleo (`--bg-canvas`, `--bg-sidebar`, `--bg-surface`, `--accent`, `--accent-contrast`) completo nos temas **Escuro** e **Claro** (`src/index.css`).
- Hierarquia editorial do workspace: sidebar colapsável com fechamento automático no mobile (`< 1024px`), header em dois níveis sem truncamento em `1024px`, abas em duas linhas, feed `Geral` distinguindo pedidos/decisões de eventos rotineiros de timeline e inspector contextual `Trabalho`.
- Capturas comparativas Antes/Depois documentadas em `docs/screenshots/v5-01/`.

### Experiência guiada e política v1 (`V5-05.4`, `V5-06`)

- Guia real de 5 passos em **Configurações → Preparação guiada para operação real**, derivado estritamente do estado vivo (nunca pré-marcado sem comprovação).
- Política explícita de fechamento de abas no navegador registrada na UI Core e na documentação: a v1 web não coordena em segundo plano sem abas abertas e reconstrói trabalho aceito via catch-up ao reabrir.
- Estados vazios em modo Core com ação direta para configurar conexão/equipe quando o vínculo `externalTeamId` ainda não existe.

### Distribuição local reproduzível (`V5-07`)

- Servidor loopback independente em Node puro (`scripts/vertice-server.mjs`, `npm start`) que serve `dist/` com fallback SPA e encaminha `/health`, `/api/*`, `/login`, `/logout` e `/ws` (via túnel TCP mantendo `Sec-WebSocket-Protocol` e cookies) para `VITE_AIONCORE_PROXY_TARGET`.
- Launcher multiplataforma (`scripts/vertice-ctl.mjs`: `server:doctor`, `server:start`, `server:status`, `server:stop`) com `windowsHide: true`, escuta restrita a loopback por padrão e controle estrito apenas do PID próprio gravado em `.vertice/server.json`.
- Remoção offline de 121 pacotes de dependências herdadas comprovadamente sem uso (`@google/genai`, `express`, `dotenv`, `motion`, `tsx`, `@types/express`) e particionamento de chunks no Vite (`index` em `179 kB` sem avisos de limite de 500 kB).
- Testes integrados em `src/services/__tests__/localServerProxy.test.ts` (40/40 testes Vitest + `viteProxyConfig.test.ts` com `pathToFileURL` para portabilidade Windows).

### Engenharia contínua e documentação (`V5-08`)

- Workflow de CI em `.github/workflows/ci.yml` cobrindo Linux (Node 22/24) e Windows (Node 24) com fixtures e Chromium Playwright E2E.
- Matriz de compatibilidade (`docs/compatibility-matrix.md`), roteiro de validação local (`docs/local-validation.md`) e registro contínuo em `docs/v5-progress.md`.

---

## [0.4.0] · Baseline v4 (entrada do Plano v5)

- Arquitetura React + TypeScript + Tailwind CSS v4 com `MockWorkspaceGateway` e `AionCoreAdapter` alinhado aos contratos do `AionCore v0.2.2` (commit `503a87199eb978790ca77675b39c84b241535bf3`), pipeline `aion-desk/v1`, catch-up paginado, deduplicação por `seq`/`seenEventIds`, persistência IndexedDB com fallback honesto e exportação/importação JSON restaurável (`2.0.0`).
