# Vértice Workspace — acompanhamento local v6

Plano ativo: `docs/implementation_plan_v6_local.md`. Instrução: `docs/hydrogen-local-v6.txt`.

## Baseline — 17/11/2026

Pasta ativa: `C:\llm\vertice-workspace`. Sem Git/publicação comprovados na extração. Visual aprovado como base, com refinamentos. Core oficial completo mantido; minimal-core futuro.

Cópia preservada do fonte recebido (sem `node_modules`, `.vertice`, `dist`, `test-results`, `.aistudio`, `.env.local` e logs): `C:\llm\vertice-workspace-baseline-20261117`.

Revisão inicial (`docs/revisao-local-v5-2026-11-17.md`): instalação original Windows não reproduzível; PID antigo podia encerrar processo alheio; URL malformada derrubava servidor; CI E2E não preparava `dist/`. Na cópia de diagnóstico com nativos suplementados: tipos/build, 40 testes e 1 E2E passaram, sem comprovar correções na pasta recebida nem integração real.

---

## V6-00 — Instalação, launcher, servidor e CI

**Estado**: Concluído em Windows (`Node v24.11.0`, `npm 11.6.1`); execução remota em Linux/CI pendente de publicação/execução em runner Linux.

### O que mudou

1. **Lockfile multiplataforma (`package-lock.json`)**:
   - Regenerado `package-lock.json` via `npm install --package-lock-only --no-audit --no-fund` mantendo `package.json` inalterado e preservando as versões originais dos pacotes principais, agora com `resolved`, `integrity` (SHA-512) e opcionais nativos para Windows e Linux (`@typescript/typescript-win32-x64` / `-linux-x64`, `@rolldown/binding-win32-x64-msvc` / `-linux-x64-gnu`, `@tailwindcss/oxide-win32-x64-msvc` / `-linux-x64-gnu`, `lightningcss-win32-x64-msvc` / `-linux-x64-gnu`, `@esbuild/win32-x64` / `-linux-x64`).
   - Removido `node_modules` recebido e validado `npm ci --no-audit --no-fund` limpo no Windows sem suplementação manual.
2. **Identidade verificável da instância no launcher e servidor (`scripts/vertice-ctl.mjs`, `scripts/vertice-server.mjs`)**:
   - `vertice-ctl.mjs start` gera `instanceId` (UUID) e `controlToken` aleatório de 32 bytes (armazenados em `.vertice/server.json` `schemaVersion: 2` com `mode: 0o600`), repassa via ambiente para o filho e só aceita prontidão após confirmação em `GET /__vertice_ctl/identity` com header `x-vertice-control-token` (`crypto.timingSafeEqual`).
   - `status`, `doctor` e `stop` verificam liveness do PID **e** identidade autenticada da instância antes de anunciar servidor ativo ou encerrar processo.
   - Registros ausentes, inválidos/corrompidos, legados sem `instanceId`/`controlToken`, mortos ou com PID vivo pertencente a outro processo/servidor alheio **recusam encerramento** (exit `1` em `stop`, sem `process.kill`).
   - `doctor` passa a validar a faixa exata de `engines.node` (`^22.12.0 || ^24.0.0 || >=26.0.0`) via `isSupportedNodeVersion` e nunca anuncia processo alheio como servidor identificado.
   - `stop` usa `POST /__vertice_ctl/shutdown` autenticado para encerramento gracioso e só recorre a `SIGTERM` após reconfirmar identidade da própria instância.
3. **Resiliência a URL malformada e validação de rota (`scripts/vertice-server.mjs`)**:
   - Adicionado `safeDecodePathname` no limite HTTP/WS (tratando `URIError` e bytes nulos `\0`), retornando `400 Bad Request` em `GET /%ZZ` ou `/%00` sem derrubar o servidor, mantendo requisições subsequentes válidas (`200 OK`), contenção em `dist/`, 404 de assets e fallback SPA.
   - Endurecido `resolveUpstreamTargetUrl` no proxy HTTP/WS para exigir origem relativa (`/`) e impedir resolução fora da origem do alvo configurado.
4. **Preparo de `dist/` no job E2E da CI (`.github/workflows/ci.yml`)**:
   - Adicionada etapa `npm run build` no job `e2e-browser` antes de `npm run test:e2e`.
5. **Regressões automatizadas (`src/services/__tests__/localServerProxy.test.ts`, `src/services/__tests__/verticeLauncher.test.ts`)**:
   - Cobertura para `GET /%ZZ` (`400`) + `GET /` (`200`) em processo filho real, proteção do endpoint `/__vertice_ctl/*`, verificação de faixa Node, registro ausente/inválido/legado/morto, PID reutilizado por processo descartável ou servidor HTTP alheio, porta ocupada, start duplicado e ciclo completo `doctor → start → status → GET → stop → status`.

### Comandos e resultados observados (sem mocks no ambiente de instalação/servidor)

- Ambiente utilizado: `C:\Users\joao.gonzales\AppData\Roaming\AionUi-Dev\aionui\runtime\node\node-v24.11.0-win-x64` (`Node v24.11.0`, `npm 11.6.1`).
- `Remove-Item -Recurse -Force node_modules; npm ci --no-audit --no-fund`: **aprovado** (`added 241 packages`, opcionais `win32-x64` presentes).
- `npm run lint` (`tsc --noEmit`): **aprovado** (`0` erros).
- `npm test` (`vitest run` — testes unitários, fixtures e subprocessos locais reais): **aprovado** — **8 arquivos, 46/46 testes** (6,04s).
- `npm run clean && npm run build`: **aprovado** em 964ms (0 avisos de chunk > 500 kB).
- `npm run server:doctor`: **aprovado** (Node `v24.11.0` compatível, `dist/` encontrado, porta `4173` livre).
- `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH="C:\Program Files\Google\Chrome\Application\chrome.exe" npm run test:e2e`: **aprovado** — **1/1 E2E** no navegador Chrome real em modo Demonstração (8,7s).

### Limitações e próximo passo

- `npm ci` e execução em **Linux** (incluindo pipeline remota GitHub Actions) ficam pendentes de execução em ambiente Linux/remoto após publicação.
- **Próximo marco**: `V6-01` — Preparar Core dedicado (`aioncore.exe v0.2.2`), origem estável, proxy e autenticação real.

---

## V6-01 — Core dedicado, origem e autenticação reais

**Estado**: Concluído (Core oficial `v0.2.2` dedicado em execução via proxy de mesma origem e caminho de distribuição `scripts/vertice-ctl.mjs`).

### O que mudou e ambiente dedicado preparado

1. **Verificação de binário e procedência (`aioncore.exe`)**:
   - Executável utilizado: `C:\llm\AionUi\docs\superpowers\local-run\tools\core\aioncore.exe` (`aioncore 0.2.2`, 99.193.856 bytes).
   - SHA-256 do `aioncore.exe`: `67EB02774BAB3855B759EC9756C2E540CD17B64B850407FA4B8BAD07FD8A0892`.
   - SHA-256 do ZIP de origem (`aioncore-v0.2.2-x86_64-pc-windows-msvc.zip`): `D1ED8D1DA869230C18701747D07E8F068DB5B8C9442E65261304AEB4C27EACF6`.
   - Checkout de referência de contratos: `C:\llm\AionCore` em `503a87199eb978790ca77675b39c84b241535bf3` (sem alterações no fonte do Core).
2. **Isolamento completo de dados, logs e origem local**:
   - Portas verificadas livres previamente (`25828` e `4173`), sem interferir nas portas/banco do `AionUi-Dev` (`%APPDATA%\AionUi-Dev`).
   - Origem estável do Vértice Workspace: `http://127.0.0.1:4173`.
   - Core dedicado em `http://127.0.0.1:25828` com `--identity-mode webui` (autenticação + CSRF habilitados; `--local` não utilizado):
     - `--data-dir`: `C:\Users\joao.gonzales\AppData\Local\VerticeWorkspace\core-data`
     - `--work-dir`: `C:\Users\joao.gonzales\AppData\Local\VerticeWorkspace\core-work`
     - `--log-dir`: `C:\Users\joao.gonzales\AppData\Local\VerticeWorkspace\core-logs`
   - Segredo de criptografia provisionado (`secret generate`, fingerprint `64678487f2d1`) e senha local da conta `admin` (`system_default_user`) gravada via `user set-password --password-stdin` (credencial mantida fora do repositório e fora de variáveis `VITE_`, IndexedDB ou backups).
   - Runtime gerenciado baixado automaticamente pelo próprio Core na primeira partida em `core-data\runtime\node\node-v24.11.0-win-x64` (`prepare_elapsed_ms=14915`).
3. **Configuração local de proxy (`.env.local`, ignorado no Git)**:
   - `VITE_AIONCORE_BASE_URL=""` (mesma origem) e `VITE_AIONCORE_PROXY_TARGET="http://127.0.0.1:25828"`, `VERTICE_HOST="127.0.0.1"`, `VERTICE_PORT="4173"`.
4. **Sondagem de CLIs no ambiente do Core (`aioncore.exe doctor`)**:
   - `antigravity` (`agy.exe` `1.5.9`): detectado em `C:\Users\joao.gonzales\AppData\Local\agy\bin\agy.exe`.
   - `codex` (`codex-cli 0.169.0-alpha.11.1`): presente em `C:\Program Files\WindowsApps\OpenAI.Codex_26.1111.2228.0_x64__2p2nqsd0c76g0\app\resources\codex.exe` (`Logged in using ChatGPT`), ausente do `PATH` padrão da máquina e disponibilizado exclusivamente no `PATH` da sessão do processo do Core dedicado sem alterar variáveis globais do Windows.

### Evidências e resultados reais observados (via `http://127.0.0.1:4173` / `scripts/vertice-ctl.mjs`)

- `npm run server:doctor`: confirmou `dist/index.html`, `.env.local`, loopback `127.0.0.1:4173` e `/health` alcançável (`HTTP 200` em `http://127.0.0.1:25828/health`).
- Sessão HTTP/CSRF/WS real pelo proxy de distribuição (`http://127.0.0.1:4173`):
  - `GET /` → `200` (`Vértice Workspace`); `GET /health` → `200` (`version: "0.2.2"`).
  - `GET /api/teams` sem sessão → `401`; `GET /api/auth/status` → `needs_setup: false`, `user_count: 1`, `is_authenticated: false`.
  - `POST /login` → `200` com cookies `aionui-csrf-token`, `aionui-session`, `aionui-refresh`.
  - `GET /api/ws-token` → `200` e conexão real `ws://127.0.0.1:4173/ws` com subprotocolo `[ws_token]` aberta (`101` registrado no Core como `conn_id=conn-1 user_id=system_default_user`).
  - `POST /logout` sem `x-csrf-token` → `403` (`CSRF_INVALID`); com `x-csrf-token` → `200`.
- **Observado no navegador Chrome via `http://127.0.0.1:4173`**:
  - Modo `aion_core` → `Verificar /health` → `Verificar autenticação` → `Autenticar (/login)` → `Conectar WebSocket` → `Sincronizar catálogo` concluídos com 9/9 registros `ok` em `Diagnóstico técnico HTTP/WS`.
  - Core inacessível (`http://127.0.0.1:25899`) gerou erro explícito `NOT_CONNECTED_LOCAL_CORE` mantendo modo `aion_core`, sem fallback para simulação.
- **Divergências de contrato real já detectadas para correção em V6-02/V6-03**:
  1. `AgentManagementStatus` real no Core v0.2.2 usa `online | offline | missing | unchecked` (não `ready`/`unauthenticated`); por isso `refreshCoreCatalog()` sobrescreveu o estado autenticado da sessão WebUI no checklist (exibindo `1/5` em vez de `2/5`) e `testAgentConnection()` trataria `online` como não pronto.
  2. `/api/agents/management` e `/api/assistants` retornam `available_models` ausente antes de um primeiro handshake de sessão (e `agy`/`codex` iniciam como `status: "unchecked"` até `POST /api/agents/{id}/health-check`).

### Próximo passo

- **V6-02**: Corrigir mapeamento real de status de sessão WebUI vs status CLI (`online`/`unchecked`), descobrir modelos/sessão reais no Core, criar e comprovar a primeira sessão real (pedido simples + 2º pedido dependente + reconexão/retomada) registrando a cadeia completa de IDs.

---

## V6-02 — Primeira sessão real e continuidade

**Estado**: Concluído (fluxo completo em navegador Chrome real via proxy `http://127.0.0.1:4173` + Core dedicado `aioncore.exe v0.2.2` + CLIs reais `codex` e `agy`).

### O que mudou

1. **Descoberta real de modelos e separação de status (`src/domain/types.ts`, `src/services/aionCoreDtos.ts`, `src/services/aionCoreAdapter.ts`, `src/features/settings/*`)**:
   - Expandido `AgentManagementStatus` para incluir os estados reais do Core `v0.2.2`: `online | offline | missing | unchecked` (preservando compatibilidade com fixtures `ready`).
   - Adicionado suporte a `available_models` em `snake_case` (`{ available_models: [...] }`) e `config_options` (`category === 'model'`, incluindo wrapper `{ config_options: [...] }` em eventos `acp_config_option`) via `extractAvailableModelOptions` e `extractModelsFromConfigOptions`.
   - Separada autenticação de sessão WebUI (`coreSessionAuthenticated` em `WorkspaceStoreState`, sanitizada na exportação em `src/services/exportService.ts`) do estado de saúde da CLI por agente (`coreAgentStatus`), permitindo que `Sincronizar catálogo` e `Testar conexão` (`POST /api/agents/{id}/health-check` retornando `online`) confirmem disponibilidade do executável sem apagar o estado autenticado do checklist (`3/5 etapas confirmadas`) nem fingir autenticação de provedor da CLI.
   - Corrigido `performRefresh()` em `src/services/aionCoreTransport.ts` para sempre enviar `Content-Type: application/json` e corpo JSON no `POST /api/auth/refresh` (evitando `415 UNSUPPORTED_MEDIA_TYPE` observado ao vivo no Core).
2. **Parser de `message.stream`, anti-vazamento de mailbox e rastreio completo de sessão (`src/services/aionCoreAdapter.ts`)**:
   - Filtrados frames `position: 'right'` e `hidden: true` em `message.stream`.
   - Acúmulo de texto restrito estritamente a `content | text | delta` (isolando `tips` como `CLI_VERSION_NEWER` e `ACP_EMPTY_TURN_NEEDS_AUTH` em diagnósticos e tratando `start`, `available_commands`, `acp_context_usage`, `acp_session_info` sem poluir a resposta).
   - Captura automática do `session_id` nativo da CLI para `SessionRef.nativeSessionId`, exibido em detalhes técnicos de [ParticipantsSection.tsx](file:///c:/llm/vertice-workspace/src/features/settings/ParticipantsSection.tsx) e incluído na exportação Markdown.
   - Conversas com 1 participante ativo não exigem envelope multi-agente `plan_proposal`; corrida entre `team.mailboxChanged` e o ACK de `POST /api/teams/{id}/messages` corrigida com extração do texto original do usuário e deduplicação por `externalMessageId`.
3. **Regressões com fixtures (`src/services/__tests__/aionCoreAdapter.test.ts`)**:
   - Novo teste cobrindo `online`/`unchecked`, `available_models` em `snake_case`, `acp_config_option`, `position: 'right'`, `tips` com mesmo `msg_id`, captura de `nativeSessionId` e conversa single-agent.

### Evidências reais observadas (Core v0.2.2 + CLIs reais)

- **Correção de concorrência no adaptador (`src/services/aionCoreAdapter.ts`)**: `refreshCoreCatalog()`, `syncCoreTeams()`, `createCoreTeamForConversation()` e `testAgentConnection()` passaram a reler `this.state` após o `await` HTTP, impedindo que um `health-check` em voo sobrescrevesse conversas recém-criadas.
- **Testes automatizados (fixtures/contratos locais após última edição, Node `v24.11.0`)**: `npm run lint` (`0` erros), `npm test` (`8` arquivos, `48/48` testes), `npm run build` (`vite build`, `986ms`) e `npm run test:e2e` (`1/1` em Demonstração no Chrome, `11,1s`).
- **Execução real via HTTP/WS no Core dedicado (`codex.exe` e `agy.exe`) — Turnos 1, 2 e 3 após reinício do daemon `aioncore.exe`**:
  - **Codex** (`bare:8e1acf31`, modelo `gpt-6.1-terra`): equipe `01a1ea94-7123-7711-a472-1bd71caed278` / slot `01a1ea94-7123-7711-a472-1bebb0ca8fe6` / conversa `c5a32b98` / sessão CLI `01a1ea94-7b1e-7c01-86af-55c6a1cd3f64` — memorizou e recordou `CODIGO-ALFA-731` inclusive após encerrar e reiniciar o `aioncore.exe`.
  - **Antigravity** (`bare:a9f3c21e`, modelo `gemini-4-hydrogen-xhigh`): equipe `01a1ea95-5859-76a3-ab5b-3d92486d74d4` / slot `01a1ea95-5859-76a3-ab5b-3dae04aae40e` / conversa `416b2811` / sessão CLI `b6cdf0de-78d8-411c-8ef9-01aaccfd4243` — memorizou e recordou `CODIGO-BETA-842` após reiniciar o `aioncore.exe`.
- **Execução real ponta a ponta no navegador Chrome via `http://127.0.0.1:4173` (`scripts/vertice-ctl.mjs` + `Codex`, `gpt-6.1-terra`)**:
  - Fluxo completo: autenticação WebUI → `Sincronizar catálogo` (`3/5 etapas confirmadas`) → `Testar conexão` (`Agente ... online no AionCore`) → nova conversa com 1 participante (`Terra 6.1`, `Coordenador + Executor`) → `Conectar WebSocket` → `Criar time da conversa no Core` (`4/5 etapas confirmadas`).
  - **Turno #1 (`VORTEX-602-VERDE`)** e **Turno #2 dependente** responderam com sucesso na aba `Terra 6.1` sem vazamento de `[Contrato interno aion-desk/v1` nem de `CLI_VERSION_NEWER` (`tips`), levando o checklist a `5/5 etapas confirmadas`.
  - Cadeia completa de IDs verificada na UI: `team=01a1eac0-fcfa-7290-b010-5a27f7f3fa91` → `slot=01a1eac0-fcfa-7290-b010-5a336158249d` → `extConv=67e5667c` → `cliSession=01a1eac1-009f-7e50-902b-9e0a2e7a9438`.
  - Após `page.reload()`, ambos os turnos persistiram no IndexedDB (`0` `pageerror`).

---

## V6-03 — Equipe real, modelos, papéis e capacidades

**Estado**: Concluído (comprovado no Chrome via proxy `http://127.0.0.1:4173` contra `aioncore.exe v0.2.2`, Codex CLI e Antigravity CLI reais, utilizando modelos econômicos para testes de comportamento).

### O que mudou e foi verificado

1. **Resolução automática de presets para conexões reais (`src/services/aionCoreAdapter.ts`)**:
   - `resolvePresetMembersForCore()` + `CORE_PREFERENCE_MODEL_HINTS` vinculam `Terra 6.1` (`Codex`), `Sol 6.1` (`Codex`) e `Gemini Hydrogen` (`Antigravity`) às conexões e modelos confirmados no catálogo Core sem incluir Claude.
   - `syncCoreParticipantModel()` (`PATCH /api/teams/{id}/agents/{slot_id}/model` com `{ model_id }`) e `PATCH .../name` integrados em `configureParticipant()`.
   - Matriz `CORE_VERIFIED_CAPABILITIES` exposta com honestidade a partir dos contratos do Core v0.2.2: `supportsInterrupt: true`, `supportsModelSwitchInSession: true`, `supportsMidRunContextInjection: false`, `supportsPauseQueue: false`, `supportsSessionTerminate: false`.
2. **Testes automatizados (fixtures) e execução real Chrome + Core (`gpt-5.6-luna` / `gpt-6-luna` / `gemini-3.8-flash-low`)**:
   - **Vitest (`src/services/__tests__/aionCoreAdapter.test.ts`)**: teste dedicado validando preset sem Claude, `PATCH .../model`, matriz de capacidades e regra estrita anti-MCP.
   - **Chrome real (`http://127.0.0.1:4173`) — Equipe de 3 sessões (`team=01a1ead2-cf94-7f02-b9da-0c23f19efd18`)**:
     - `Terra 6.1` (Codex lead, `gpt-5.6-luna`): `slot=01a1ead2-cf94-7f02-b9da-0c3663356bdc` → `extConv=35f4f1db` → `cliSession=01a1ead2-d823-78b2-ba7f-c940ecf858f2`.
     - `Sol 6.1` (2ª sessão independente Codex, `gpt-5.6-luna`): `slot=01a1ead2-d063-7c72-acd7-92904278fe00` → `extConv=46f9ebbc` → `cliSession=01a1ead2-fb12-7130-b0e9-0cbc79b26120`.
     - `Gemini Hydrogen` (Antigravity executor, `gemini-3.8-flash-low`): `slot=01a1ead2-d0de-7b31-8c62-1a12414eb9bf` → `extConv=0c39b339` → `cliSession=d6d39337-3dec-454f-a428-8e9280adf311`.
     - Comprovados: roteamento `Geral → Terra 6.1`, abas diretas (`Sol 6.1` e `Gemini Hydrogen`) sem vazamento entre abas, rascunhos isolados por aba, `PATCH /agents/{slot_id}/model` (`200 OK` alterando Sol para `gpt-6-luna`) e preservação após `page.reload()` (`PAGE_ERRORS: 0`).
   - **Criação na UI do preset dividido de 4 sessões (`Terra 6.1`, `Sol Planejador`, `Sol Auditor`, `Gemini Hydrogen`)**: `POST /api/teams` `201 Created` (`team=01a1ead3-...`, 4 `slot_id` e `conversation_id` independentes).

---

## V6-04 — Autoridade única de coordenação e ciclo real completo (em andamento)

- Regra estrita anti-duplo-despacho já injetada em `composeCoreOutgoingContent()` quando há > 1 participante (impedindo `team_task_create`/`team_send_message`/`team_spawn_agent` via MCP pelo líder).
- Pendente: executar ciclo completo (objetivo → plano → 3 tarefas dependentes → execução com diff real + auditoria independente de arquivos/testes) em repositório sandbox separado, além dos cenários de `V6-05` (limites, reprovação/correção, falha e cancelamento).

### Complemento de 17/11/2026 (tarde) — achados e reexecuções reais

1. **Duplicação de `plan_proposal` (achado real)**: o Terra (coordenador) reemitia o mesmo `plan_proposal` a cada `idle_notification` dos colegas (3 tarefas viraram 18 na projeção). Correções em `aionCoreAdapter.ts`: (a) a regra anti-MCP agora pede resposta apenas `OK` em notificações internas sem pedido novo; (b) `finalizeCoreAgentMessage` ignora `plan_proposal` não solicitado quando já existe plano; (c) `applyStructuredPlanProposal` descarta plano com mesmo `sourceEventId` ou com todos os títulos já cadastrados e ativos. Teste de regressão com fixture adicionado.
2. **Resolução de buffer de stream**: frames do mesmo turno podem vir sem `turn_id` no `finish`; o buffer agora é resolvido por chave, por `msg_id` do buffer, por `turn_id` e, para `finish`, pelo buffer aberto do participante. Suíte: `8` arquivos, `51/51` testes, `npm run lint` e `npm run build` sem erros (execução imediatamente anterior às reexecuções reais abaixo).
3. **Cota do Antigravity (bloqueio externo, não defeito do produto)**: `gemini-3.8-flash-low` e `gemini-4-hydrogen-low` retornaram `USER_LLM_PROVIDER_RATE_LIMITED` ("Individual quota reached… Resets in 2h49m9s"). O Vértice registrou falha operacional (`exec=failed`) sem aprovar nada. A execução com Gemini deve ser repetida após a renovação da cota.
4. **Ciclo real com executor Codex** (repositório `v6-04-sandbox-repo`; Terra/Sol Planejador/Sol Auditor/`Sol Executor`, todos `gpt-5.6-luna`, sessões separadas): `exec=completed` em ~3m20s, 3 tarefas (sem duplicação), 1 tentativa cada, 3 auditorias `approved` com `independentReview: true`, `git diff` com `subtract` + teste + `README.md`, `node --test` com 2/2.
5. **Ciclo real com executor Cursor `composer-2.5`** (CLI `cursor-agent` logado; modelos descobertos pelo Core após a conexão): mesmo repositório e resultado (`exec=completed`, 3 tarefas aprovadas com `independentReview: true`, `node --test` 2/2). Log da execução preservado nos artefatos da sessão do agente (`v6_05_perm_run.log`).


## V6-05 — Permissões, correção, falhas e limites

**Estado**: Concluído (comprovado em navegador Chrome real via proxy `http://127.0.0.1:4173` contra `aioncore.exe v0.2.2` + CLIs reais `cursor-agent` `composer-2.5[fast=false]`, `codex` `gpt-5.6-luna` e `agy` Antigravity, acompanhado de testes automatizados com fixtures para regressão). Parado aqui para revisão do auditor antes de avançar ao `V6-06`.

### Alterações de código realizadas no V6-05

1. **Preservação da distinção "pedido enviado" vs "controle confirmado" em `request_interrupt` (`src/services/aionCoreAdapter.ts`)**:
   - Corrigido bug encontrado ao vivo em `controlExecution('request_interrupt')`: `proj` era capturado antes dos `await` HTTP (`GET /run-state` + `POST .../cancel`); quando o WS `team.childTurnCancelled` chegava antes do retorno do `POST`, o `seq` calculado a partir do `proj` obsoleto era descartado pelo buffer contíguo do reducer. Agora `latestProj` é relido após o `await`, garantindo registro separado do pedido enviado (`origin: 'user'`) e da confirmação recebida do Core (`origin: 'gateway'`, `team.childTurnCancelled`).
2. **Sincronização de `conversation.executionStatus` ao bloquear, cancelar ou falhar a última tarefa ativa (`src/domain/reducer.ts`)**:
   - Corrigido achado observado ao vivo nos cenários de teto de tentativas e interrupção: `task_status_changed` para `blocked` ou `cancelled` (quando não há outra tarefa em `running`/`awaiting_review`/`queued`) agora atualiza `conversation.executionStatus` para `'blocked'` ou `'idle'` respectivamente; `operational_failure_recorded` (sem outra tarefa ativa) atualiza `conversation.executionStatus` para `'failed'`.
3. **Regressões automatizadas com fixtures (`src/services/__tests__/aionCoreAdapter.test.ts`)**:
   - Adicionado teste `proves permission denial sends reject option to Core and does not execute the denied operation (V6-05 recusa)` validando envio de `reject_once_id_rm` em `POST .../confirmations/{callId}/confirm`, status `denied`, tarefa não concluída e `qualityRejectionCount === 0` / `operationalFailureCount === 0`.
   - Adicionado teste `does not auto-complete task when executor output lacks aion-desk-json block (invalid output fallback V6-05)` validando saída sem bloco (`incomplete`) e bloco com versão/JSON incompatível (`invalid`) sem conclusão automática nem auditoria indevida.
   - Reforçadas asserções nos testes de teto (`MAX_CORE_TASK_ATTEMPTS=3` → `conversation.executionStatus === 'blocked'`), falha operacional (`executionStatus === 'failed'`, `operationalFailureCount === 1`, `qualityRejectionCount === 0`) e interrupção (`origin: 'user'` separado de `team.childTurnCancelled`).


### Correções de auditoria V6-05 (18/11/2026 — P1 e P2, `docs/auditoria-v6-05-2026-11-17.md`)

1. **P1 — Correlação estrita de `delivery_report` e `review_decision` (`src/services/aionCoreAdapter.ts`)**:
   - Introduzidas validações estritas `correlateDeliveryReport()` e `correlateReviewDecision()` executadas em `finalizeCoreAgentMessage()` antes de emitir `agent_message_posted` (e reutilizadas como defesa em profundidade em `applyStructuredDeliveryReport()` / `applyStructuredReviewDecision()`).
   - Removidos todos os fallbacks por estado/última tentativa (`?? proj.tasks.find(...)`, `?? task.attempts[last]`) e a criação implícita de tentativa em `applyStructuredDeliveryReport()`.
   - Validados antes de qualquer alteração de negócio ou despacho: papel (`executor`/`reviewer`), autoria designada (`assigneeParticipantId`/`reviewerParticipantId`), existência exata de `taskId` e `attemptId` explícito, tentativa mais recente esperada e estado elegível (`running` para entrega; `awaiting_review` + tentativa `delivered` sem outra tentativa `running` para parecer).
   - Quando `attemptId` é omitido, só há aceitação mediante correlação inequívoca com a única tentativa elegível mais recente; ambiguidade ou incompatibilidade preserva a saída original com `parseStatus: 'invalid'`, `parseReason` explicativo e `projectToGeneral: true` para revisão manual (sem concluir, reprovar, apagar `expectedKindByParticipant` ou disparar despacho automático).
   - Reentregas duplicadas idênticas (mesmo `taskId`/`attemptId` e, em pareceres, mesma decisão já registrada em `seenEventIds`) são tratadas de forma idempotente sem reemitir eventos nem disparar novo despacho em background; pareceres com decisão conflitante ou tardios após nova tentativa/cancelamento/teto são rejeitados como `invalid`.
2. **P2 — Agregação de `conversation.executionStatus` considerando dependências e trabalho executável (`src/domain/reducer.ts`)**:
   - Introduzido helper `hasExecutableOrActiveWork(tasks, escalations)` usando `areTaskDependenciesSatisfied()` de `src/domain/taskRules.ts`.
   - Em `task_status_changed` (`blocked` e `cancelled`) e `operational_failure_recorded`, uma tarefa `queued`/`planned`/`changes_requested` só conta como trabalho executável quando suas dependências estão efetivamente satisfeitas (`completed`) e não há escalonamento manual pendente (`suggested`).
   - Com tarefa A bloqueada pelo teto e B (`queued`) dependente de A (ou cadeia A → B → C), a conversa agora transita para `blocked`; com B independente apta a avançar, preserva `running`; no cancelamento, tarefa isolada transita para `idle`, dependente travada transita para `blocked` e independente preserva `running`.
3. **Regressões determinísticas adicionadas (fixtures/unitários, sem chamadas a Core/CLI/modelos)**:
   - `src/domain/__tests__/reducer.test.ts`: novo teste cobrindo bloqueio com dependente/cadeia (`blocked`), bloqueio com independente (`running`), bloqueio isolado (`blocked`), cancelamento isolado (`idle`), cancelamento com dependente (`blocked`), cancelamento com independente (`running`) e falha operacional com dependente (`failed`).
   - `src/services/__tests__/aionCoreAdapter.test.ts`: dois novos testes cobrindo as 5 reproduções de P1 da auditoria (entrega com `taskId`/`attemptId` inexistente, parecer `approved` com `taskId`/`attemptId` inexistente, parecer tardio de tentativa antiga com tentativa nova `running`), autoria/papel incorretos, entrega sem `attemptId` inequívoca, reentregas duplicadas idempotentes de entrega/parecer, fluxo positivo completo, respostas tardias pós-cancelamento e pós-teto, e fluxo completo de teto de 3 tentativas com tarefa dependente `queued` levando `conversation.executionStatus` para `blocked`.

### Correções da revalidação V6-05 (18/11/2026 — 2ª rodada, `docs/auditoria-v6-05-2026-11-18.md`)

1. **[P1] Vínculo de turno/despacho e bloqueio de omissão ambígua de `attemptId` após retentativas (`src/services/aionCoreAdapter.ts`)**:
   - Adicionados `expectedDispatchByParticipant` (registrado em `dispatchTaskAttemptInCore()` e `dispatchReviewInCore()`, vinculado ao `turn_id` exclusivamente em `team.childTurnStarted` e limpo em cancelamento/falha/consumo) e `consumedTurnBindings` (registrando a tentativa/decisão associada a cada `turnId` consumido), além da checagem histórica `isTurnPrecedingAttemptStage()` contra `proj.eventLog`.
   - Quando `attemptId` é omitido:
     - Reaproveitamento de `turnId` já consumido por outra tentativa ou anterior ao início/entrega da tentativa atual é rejeitado como `invalid` para revisão manual.
     - Em tarefas com histórico de retentativas (`task.attempts.length > 1`), a omissão de `attemptId` só é aceita mediante prova positiva de vínculo do `turnId` recebido ao despacho ativo da tentativa atual (`expectedDispatch.turnId === turnId`); sem esse vínculo, é tratada como ambígua (`parseStatus: 'invalid'`, revisão manual), sem alterar tarefas, tentativas, `qualityRejectionCount`, escalonamento ou despachos.
     - Mantidos positivos o caminho com `attemptId` explícito, a 1ª tentativa sem `attemptId` e o caminho com `turnId` comprovadamente vinculado em retentativas.
2. **[P2] Validação estrita de tipo/valor de `attemptId` (`src/domain/internalProtocol.ts`, `src/services/aionCoreAdapter.ts`)**:
   - Em `parseStructuredAgentOutput()` (`delivery_report` e `review_decision`), sempre que `attemptId` estiver presente (`hasOwnProperty` e `!== undefined`), exige `typeof attemptId === 'string' && attemptId.trim().length > 0`; números (`123`), objetos (`{}`), arrays (`[]`), `null` e strings vazias/espaços retornam `parseStatus: 'invalid'` para revisão manual, sem cair na omissão nem lançar `TypeError`.
   - Adicionado helper defensivo `parseOptionalAttemptId()` e validação de tipo de `taskId` nos correlacionadores de `aionCoreAdapter.ts`.
3. **Regressões determinísticas adicionadas (`src/services/__tests__/aionCoreAdapter.test.ts`, sem chamadas a Core/CLI/modelos)**:
   - `rejects stale/unproven deliveries and reviews without attemptId after retries, and allows proven dispatch-turn correlation (V6-05 revalidação P1)`: cobre as 3 reproduções da revalidação (reentrega da tentativa 1 sem `attemptId` após início da tentativa 2; parecer `rejected` antigo sem `attemptId` sem elevar `qualityRejectionCount` nem disparar escalonamento; parecer `approved` antigo sem `attemptId` sem concluir tentativa 2), além da prova positiva via `team.childTurnStarted` na tentativa 2.
   - `rejects non-string or empty attemptId values without throwing and records manual review messages (V6-05 revalidação P2)`: cobre `123`, `{}`, `[]`, `null`, `""` e `"   "` em entrega e parecer, confirmando ausência de exceção, registro de mensagem final `invalid` e compatibilidade preservada quando `attemptId` está ausente.

### Testes automatizados (fixtures / contratos locais — Node `v24.11.0`, após correções da revalidação de 18/11)

- `npx tsc --noEmit` (`npm run lint`): **aprovado** (`0` erros).
- `npx vitest run` (`npm test` — unitários, fixtures de contrato Core e subprocessos locais do servidor/launcher): **aprovado** — **8 arquivos, 58/58 testes** (5,14s).
- `npm run build` (`vite build`): **aprovado** em 1,37s (`0` avisos de chunk > 500 kB).
- `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH="C:\Program Files\Google\Chrome\Application\chrome.exe" npm run test:e2e`: **aprovado** — **1/1 E2E** (modo Demonstração no Chrome real, 10,7s).
- Nenhuma chamada paga a Core/CLI/modelos foi repetida para estas correções, conforme orientação do auditor.

### Evidências reais observadas (Core `aioncore.exe v0.2.2` + CLIs reais + Chrome via `http://127.0.0.1:4173`)

Todos os cenários abaixo foram executados contra o repositório sandbox `C:\Users\joao.gonzales\AppData\Local\VerticeWorkspace\v6-04-sandbox-repo` (restaurado com `git checkout -- . && git clean -fd` antes de cada rodada e ao final), via build estático servido por `scripts/vertice-ctl.mjs` (`PAGE_ERRORS: 0` em todas as rodadas).

1. **Permissões nativas — comprovação de que a operação recusada NÃO executou e a aprovada executou (`Cursor composer-2.5[fast=false]`)**:
   - **Equipe real**: `team=01a1eb2e-a2ad-7a81-9236-7c0c2ed03bf3`, slot Cursor `01a1eb2e-a3a5-7c32-a66b-9c2921ffcec2` (`extConv=f70ddcdb`, `PATCH .../model` `200 OK` aplicando `composer-2.5[fast=false]`).
   - **Operação recusada**: cartão `Permissão solicitada (AionCore)` exibido para `node -e "import('node:fs').then(fs=>fs.writeFileSync('DENIED_SENTINEL.txt','EXECUTED'))"`. Clique em **Recusar** na UI enviou `POST /api/conversations/f70ddcdb/confirmations/.../confirm` (`200 OK`) com `{"msg_id":"30564172","data":"reject-once","always_allow":false}`. Verificação direta em disco: **`DENIED_SENTINEL.txt` ausente (`false`)**.
   - **Operação aprovada**: cartão exibido para `node -e "import('node:fs').then(fs=>fs.writeFileSync('APPROVED_SENTINEL.txt','OK'))"`. Clique em **Aprovar** enviou `POST .../confirm` (`200 OK`) com `{"data":"allow-once","always_allow":false}`. Verificação direta em disco: **`APPROVED_SENTINEL.txt` presente com conteúdo exato `"OK"`**.
   - Auditoria independente (`Sol Auditor`, Codex `gpt-5.6-luna`) confirmou em disco a ausência de `DENIED_SENTINEL.txt` e a presença de `APPROVED_SENTINEL.txt` (`independentReview: true`, `qualityRejectionCount: 0`, `operationalFailureCount: 0`). Capturas: `docs/screenshots/v6-05/v605_perm_deny_0.png`, `docs/screenshots/v6-05/v605_perm_approve_1.png` (além da rodada anterior de 3 tarefas com `docs/screenshots/v6-05/perm_0.png`..`perm_2.png`).
2. **Reprovação por qualidade → correção com feedback → nova auditoria → aprovação (`Cursor composer-2.5[fast=false]` + Auditor independente Codex `gpt-5.6-luna`)**:
   - **Equipe real**: `team=01a1eb30-f172-79b3-a58f-2973da4a6d47`, slot Cursor `01a1eb30-f28d-7c31-8346-f6736dbfa011` (`extConv=6e5a597e`, `composer-2.5[fast=false]`).
   - **Tentativa #1**: executor criou `rework.txt` com `"RASCUNHO_V1"`; `Sol Auditor` inspecionou o disco e **reprovou** (`decision: "rejected"`, `independentReview: true`, `unmetCriteria: ["O conteúdo de rework.txt deve ser exatamente CORRIGIDO_V2."]`).
   - **Tentativa #2**: Vértice contabilizou `qualityRejectionCount: 1`, injetou parecer e critérios não atendidos no despacho seguinte; executor corrigiu `rework.txt` para `"CORRIGIDO_V2"` e submeteu novo `delivery_report`; `Sol Auditor` reauditou em disco e **aprovou** (`decision: "approved"`, `independentReview: true`). Resultado final: `attempts: 2`, `reviews: [rejected, approved]`, `SANDBOX_rework.txt: "CORRIGIDO_V2"`, `EXECUTION_STATUS: completed`. Captura: `docs/screenshots/v6-05/v605_reject_correct.png`.
3. **Escalonamento manual e limite de tentativas (`MAX_CORE_TASK_ATTEMPTS = 3`) (`Codex gpt-5.6-luna`)**:
   - **Equipe real**: `team=01a1eb33-b9da-72d2-82f8-93ca5f65e5e7`.
   - **Tentativas #1 e #2**: ambas reprovadas em disco pelo auditor independente (`cap.txt` com `NAO_CONFORME` vs critério `TOKEN_IMPOSSIVEL_999`; `qualityRejectionCount: 2`).
   - **Política manual de escalonamento**: após a 2ª reprovação, a retentativa automática pausou e a UI exibiu o banner `Escalonamento sugerido pela política de qualidade` (`Sol Executor · GPT-5.6-Luna → GPT-6.2-Sol`, botões `Aprovar promoção para GPT-6.2-Sol` e `Manter perfil atual`). Clicado `Manter perfil atual` (`status: "dismissed"`), mantendo `gpt-5.6-luna` sem troca não autorizada e liberando a Tentativa #3. Captura: `docs/screenshots/v6-05/v605_escalation_banner.png`.
   - **Teto de 3 tentativas**: Tentativa #3 reprovada (`attemptsCount: 3`, `qualityRejectionCount: 3`, `operationalFailureCount: 0`); emitido evento `evt_core_limit_...` com `nextStatus: "blocked"` ("Limite de 3 tentativas/reprovações atingido... Retentativa automática interrompida; aguardando intervenção manual.") e **nenhuma Tentativa #4** foi disparada. Captura: `docs/screenshots/v6-05/v605_attempt_cap_blocked.png`.
4. **Saída inválida / incompleta (`Codex gpt-5.6-luna`)**:
   - **Equipe real**: `team=01a1eb36-b35b-7340-84ef-b91c5216b94f`.
   - Executor respondeu em texto livre sem bloco `aion-desk-json` (`"Concluí manualmente sem bloco JSON."`).
   - Vértice preservou a saída original com `parseStatus: "incomplete"` e `parseReason: "Bloco estruturado interno aion-desk-json ausente; mantido como saída original para revisão manual (sem conclusão automática)."`, exibiu o aviso na UI (`Saída estruturada (incomplete) — revisão manual necessária`), **não** concluiu nem enviou para aprovação heurística (`attempts: 1`, `reviews: 0`) e **não** entrou em loop infinito. Captura: `docs/screenshots/v6-05/v605_invalid_output.png`.
5. **Interrupção efetiva e ausência explícita de suporte (`Codex gpt-5.6-luna`)**:
   - **Equipe real (revalidação após correção)**: `team=01a1eb3b-dec8-77b0-9ba1-544c5920296d`.
   - **Controles sem suporte no Core v0.2.2**: verificados na UI `Pausar fila` (`disabled: true`, tooltip `"Pausar fila indisponível: capacidade não suportada pela conexão configurada."`) e `Encerrar sessão` (`disabled: true`, tooltip `"Encerrar sessão indisponível: capacidade não suportada pela conexão configurada."`).
   - **Interrupção suportada**: com `Sol Executor` em execução numa espera de 35s (`INTERRUPTED_SENTINEL.txt`), clique em `Solicitar interrupção` enviou `POST /api/teams/01a1eb3b-dec8-77b0-9ba1-544c5920296d/runs/01a1eb3c-49fc-7ff0-8d25-e45b67e4b3ed/agents/01a1eb3b-e041-7692-8830-f2a38abc1588/cancel` (`200 OK`, `{"success":true}`).
   - **Estados distintos confirmados**: registrados separadamente o pedido enviado (`origin: "user"`, `"Cancelamento do turno solicitado ao AionCore para Sol Executor."`) e a confirmação do Core (`origin: "gateway"`, `externalEventName: "team.childTurnCancelled"`, `"Turno de Sol Executor cancelado no Core (team.childTurnCancelled). Entrega não finalizada."`). Tarefa passou a `cancelled`, tentativa a `interrupted`, `EXECUTION_STATUS` a `idle`, e **`INTERRUPTED_SENTINEL.txt` não foi criado (`false`)**. Captura: `docs/screenshots/v6-05/v605_interrupt.png`.
6. **Falha operacional real sem penalizar qualidade (`Antigravity`)**:
   - **Equipe real**: `team=01a1eb41-d82d-7b32-8346-ac1e7640f08e` (executor Antigravity com `gemini-4-hydrogen-low` falhando no provedor com `"The configured model was not found by the provider"`, complementando os eventos reais de rate-limit HTTP 429 `RESOURCE_EXHAUSTED` registrados em `core-logs\2026\11\17\2026-11-17.aioncore.log`).
   - Resultado observado no Vértice: `operational_failure_recorded` (`message.stream`) + `team.runFailed` + `team.childTurnCompleted`; tarefa em `status: "failed"`, tentativa em `status: "failed_operational"`, **`operationalFailureCount: 1`**, **`qualityRejectionCount: 0`**, `EXECUTION_STATUS: "failed"`, sem aprovação falsa. Captura: `docs/screenshots/v6-05/v605_op_failure.png`.

### Limitações registradas no V6-05 (transparência para auditoria)

- **`Allow always` em permissões**: o componente `PermissionCard` atual expõe apenas `Aprovar` (uma vez, `always_allow: false`) e `Recusar` (`reject-once`); aprovação persistente `always_allow` não foi exercitada na UI.
- **`Pausar fila` e `Encerrar sessão`**: não suportados pelo protocolo do Core `v0.2.2`; aparecem explicitamente desabilitados com tooltip informativo (coerente com `CORE_VERIFIED_CAPABILITIES`).
- **Aprovação de escalonamento com `PATCH .../model`**: no cenário 3 real optou-se por `Manter perfil atual` (`dismissed`) para respeitar a orientação de evitar custo com `GPT-6.2-Sol`; o caminho de promoção automática/aprovada com `PATCH .../model` está coberto por fixture (`caps rework loops at MAX_CORE_TASK_ATTEMPTS=3 and escalates to a confirmed Core model via PATCH`), enquanto `PATCH .../model` real foi comprovado em V6-03 e nas sessões Cursor `composer-2.5[fast=false]`. A sincronização de `conversation.executionStatus = 'blocked'` no teto de 3 tentativas foi corrigida em `reducer.ts` logo após a captura do cenário 3 e coberta por fixture + build final (sem repetir outra rodada paga de 3 ciclos).
- **Variante `invalid` (JSON malformado) de saída estruturada**: comprovada ao vivo a variante `incomplete` (bloco `aion-desk-json` ausente); a variante `invalid` (JSON malformado / versão incompatível) é coberta pela suíte de fixtures (`aionCoreAdapter.test.ts` e `v4DomainAndMigration.test.ts`).
- **Comportamento de fallback de modelo nos CLIs**: observou-se ao vivo que tanto `codex` quanto `cursor-agent` aceitam `PATCH .../model` com nome inexistente mas fazem fallback silencioso para um modelo padrão no runtime da CLI, enquanto `agy` (Antigravity) retorna erro operacional explícito do provedor.
- **Métricas de custo/tokens**: não são exibidos valores exatos de custo/tokens porque o Core v0.2.2 não fornece esses campos neste fluxo.
- **Antigravity no V6-04**: após o reset parcial de cota, `gemini-3.8-flash-low` concluiu 1 tarefa real com aprovação em `team=01a1eb38-f1a4-7921-9d57-c4d317549e39`; isso comprova execução pontual mas **não** substitui a validação completa da combinação pretendida com Gemini (ciclo completo de 3 tarefas dependentes segue pendente no escopo do produto, enquanto o ciclo completo de 3 tarefas está comprovado em Codex e Cursor).

---

## V6-06 — Contexto, sessões, persistência e recuperação

**Estado**: Concluído (comprovado em navegador Chrome real via proxy `http://127.0.0.1:4173` contra `aioncore.exe v0.2.2` + `codex` `gpt-5.6-luna`, acompanhado de testes determinísticos com fixtures para todos os cenários de contexto, falhas, fechamento de aba, backups e IndexedDB). Parado aqui para revisão do auditor antes de avançar ao `V6-07`.

### Alterações de código realizadas no V6-06

1. **Semântica estrita e monotônica de recibos de contexto (`src/domain/reducer.ts`, `src/services/aionCoreAdapter.ts`, `src/i18n/ptBR.ts`)**:
   - Em `reducer.ts`, `context_receipt_updated` agora impõe progressão monotônica (`pending_send` → `sent` → `received` → `applied`, com `failed_needs_action` permitido a partir de `pending_send`/`sent` e recuperável para `sent`/`received`/`applied`, sem nunca rebaixar `applied` ou `received` de volta para `sent`/`pending_send`).
   - Em `aionCoreAdapter.ts`:
     - Adicionados `lastSentContextByParticipant`, `emitContextReceiptSent()`, `emitContextReceiptFailed()` e `emitContextReceiptApplied()`.
     - `finalizeCoreAgentMessage()` só promove para `received` quando existe evidência prévia de `sent` para o participante (nunca a partir de `pending_send` em mensagens espontâneas) e valida contra `sendInitiatedEventIndex` (capturado antes do `await POST .../messages`) + `context_revision_published`, protegendo simultaneamente contra turnos iniciados antes do envio e contra a corrida real observada no Core v0.2.2 em que WS `team.childTurnStarted` chega 1–2ms antes do ACK HTTP.
     - `applyStructuredDeliveryReport()` marca `applied` exatamente na revisão vinculada à tentativa (`attempt.contextRevisionId`), preservando uma revisão v2 publicada no meio da tentativa em `pending_send`.
     - Falhas de transporte no envio (`sendMessage`, `dispatchTaskAttemptInCore`, `dispatchReviewInCore`) registram `failed_needs_action` sem reenvio cego.
     - `PT_BR.receiptHonestyNote` explicita que a fonte de verdade do projeto (Contexto Compartilhado no Vértice) não equivale à janela de contexto interna do modelo e que `Enviada`, `Recebida` e `Aplicada à execução` exigem evidências distintas.
2. **Fechamento de aba, reconciliação e distinção `Retomar fluxo` vs repetir pedido (`src/services/aionCoreAdapter.ts`, `src/services/storage.ts`, `src/domain/reducer.ts`, `src/App.tsx`, `src/i18n/ptBR.ts`)**:
   - `storage.ts`: `loadInitial()` agora persiste de volta o estado sanitizado quando `sanitizeLoadedStateAfterReload()` transiciona conversas ativas para `paused_queue`/`paused_demo`, mantendo UI e IndexedDB alinhados imediatamente após reload; `flushSave()` drena gravações enfileiradas durante um `activeWritePromise` em voo.
   - `aionCoreAdapter.ts`:
     - Bloqueados despachos automáticos em segundo plano (`dispatchTaskAttemptInCore`, `dispatchReviewInCore`, `applyStructuredPlanProposal`, `applyStructuredReviewDecision`) enquanto `conversation.executionStatus === 'paused_queue'`, garantindo que `reconcileConversation()` apenas recupere o estado concluído no Core sem disparar etapas novas automaticamente.
     - Implementada retomada explícita de fluxo local em `controlExecution('resume_queue')` exclusivamente quando `executionStatus === 'paused_queue'`: reconcilia primeiro com o Core, recusa retomar se `synced === false`, recalcula `nextExecutionStatus` honesto com base em tarefas + `slot_work` ao vivo, registra `execution_control_applied` (`control: 'resume_queue'`) e despacha **apenas** a próxima etapa pendente (revisão de entrega já feita enquanto a aba esteve fechada, correção pendente ou próxima tarefa executável), sem repetir o pedido original nem duplicar turno já em execução no Core.
     - `reconcileConversation()` agora marca `synced: false` / `syncState: 'incomplete'` quando houver `pendingOutOfOrder` não vazio ("pendência implica sincronização incompleta"), classifica erros de `401 AUTH_REQUIRED` (chamando `markCoreSessionExpired()` → `coreSessionAuthenticated = false`, `authStatus = 'expired'`), `404` (equipe ausente após reinício com outro banco) e Core inacessível; amplia catch-up de `/api/conversations/{id}/messages` para turnos pausados sem resposta, filtrando `hidden !== true` e repassando `created_at` e `backend_turn_id`.
     - WS `1008` com refresh recusado também chama `markCoreSessionExpired()`. Adicionada poda FIFO de `consumedTurnBindings` (limite 500 entradas) e `clearRuntimeCaches()` em `dispose()`/`importWorkspaceState()`.
   - `reducer.ts`: `task_updated` agora sincroniza `conversation.executionStatus` quando ativo (ex.: todas as tarefas concluídas via `/tasks`) preservando `paused_queue`/`paused_demo` quando pausado.
   - `App.tsx`: novo banner explícito para `paused_queue` no modo Core com ações separadas **`Reconciliar agora`** e **`Retomar fluxo`**.
3. **Backups sem credenciais e desvinculação de referências externas Core (`src/domain/types.ts`, `src/services/exportService.ts`, `src/components/ExportDialog.tsx`, `src/features/workspace/WorkspaceContext.tsx`, `src/features/settings/ParticipantsSection.tsx`)**:
   - `applyImportedWorkspaceBackup()` desconecta todos os vínculos ativos de equipe/sessão Core na conversa importada em ambos os modos (`copy` e `replace`), movendo `externalTeamId`, `externalSlotId`, `externalConversationId` e `nativeSessionId` para `importedExternalTeamId` / `importedExternalRef` como referência histórica, definindo participantes ativos como `idle`/`inactive` e nunca iniciando execução automática.
   - Em modo **`replace`**, força ainda `coreSessionAuthenticated: false` e sanitiza conexões `aion_core` (`authStatus: 'unknown'`, `catalogLoaded: false`, `coreAgentId`/`coreAssistantId: undefined`); em modo **`copy`**, preserva a sessão autenticada viva da janela atual e mantém inalterada a conversa original (e seus vínculos Core já existentes), desconectando apenas a nova cópia importada.
   - Nota de arquitetura sobre recibos: a monotonicidade em `shouldAcceptReceiptTransition()` (`reducer.ts`) aceita transições diretas para `received`, cabendo estritamente ao adaptador (`finalizeCoreAgentMessage()` em `aionCoreAdapter.ts`) exigir evidência prévia de `sent` e ordem de turno antes de emitir `received`.
   - `BackupValidationPreview` e `ExportDialog.tsx` contabilizam e avisam sobre vínculos externos detectados antes da importação e documentam a exportação prévia antes de trocar origem/porta (`host:porta`), alertando para não copiar arquivos de banco do navegador manualmente.
   - `WorkspaceContext.tsx` troca o gateway ativo (`demo` ↔ `aion_core`) ao importar um backup `replace` de modo diferente, limpando rascunhos/abas em memória.
   - `ParticipantsSection.tsx` exibe `importedExternalRef` em detalhes recolhidos como referência histórica desvinculada.

### Testes automatizados (fixtures / contratos locais — Node `v24.11.0`, após última edição)

- `npx tsc --noEmit` (`npm run lint`): **aprovado** (`0` erros).
- `npx vitest run` (`npm test` — unitários, fixtures de contrato Core e subprocessos locais): **aprovado — 8 arquivos, 64/64 testes** (6,08s), incluindo 6 novos testes dedicados ao `V6-06`:
  - `reducer.test.ts`: progressão monotônica de recibos sem downgrade + sincronização de `executionStatus` em `task_updated` preservando `paused_queue`.
  - `v4DomainAndMigration.test.ts`: backup/restauração (`copy` e `replace`) sem credenciais, desconexão de referências externas Core com preservação histórica, sem login presumido nem auto-execução.
  - `workspace.test.ts`: falha na abertura do IndexedDB (`session_only`), preservação sem sobrescrita de schema futuro incompatível (`v99`), migração `v1 → v2` persistida e drenagem de `flushSave` concorrente.
  - `aionCoreAdapter.test.ts` (3 novos testes):
    1. Contexto versionado (`pending_send` → `failed_needs_action` → `sent` → `received` → `applied`, bloqueio de falso `received` sem envio ou em turno pré-envio, corrida real WS `childTurnStarted` antes do ACK HTTP, publicação de v2 no meio da tentativa mantendo v2 em `pending_send` e aplicando v1).
    2. Fechamento de aba/reload com tarefa concluída no Core (`paused_queue` sem despacho automático, recusa de `resume_queue` em catch-up incompleto, `reconcileConversation` recuperando entrega sem auto-despacho, `resume_queue` despachando apenas a revisão pendente sem repetir pedido, e `resume_queue` com slot ainda `running` no Core sem duplicar despacho).
    3. Sessão expirada (`401` + refresh falho e WS `1008`), Core reiniciado (`404`), `pendingOutOfOrder` forçando `syncState: 'incomplete'`, isolamento de duas conversas na reconexão WS e não-importação automática de equipes/chats manuais externos (`syncCoreTeams`).
- `npm run build` (`vite build`): **aprovado** em 1,31s (`0` avisos de chunk > 500 kB).
- `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH="C:\Program Files\Google\Chrome\Application\chrome.exe" npm run test:e2e`: **aprovado** — **1/1 E2E** (modo Demonstração no Chrome real, 12,7s).

### Evidências reais observadas (Core `aioncore.exe v0.2.2` + Codex `gpt-5.6-luna` + Chrome via `http://127.0.0.1:4173`)

Relatório JSON e capturas preservadas no repositório em `docs/screenshots/v6-06/` (`v606_live_report.json` e `v606_*.png`), obtidos sobre build estático servido por `scripts/vertice-ctl.mjs` no repositório sandbox `v6-04-sandbox-repo` (restaurado ao final), com **`PAGE_ERRORS: 0`** (o script temporário `verify_v6_06_live.mjs` e o arquivo bruto de backup ficaram fora do repositório, na pasta de artefatos da sessão):

1. **Contexto versionado real e recibos distintos (`team=01a1eec1-f666-7462-95f6-9e74b81ec562`)**:
   - Revisão `v1` publicada pela UI (`"Criar o arquivo ctx.txt na raiz do workspace contendo exatamente o texto V606_CTX_OK"`).
   - **Antes do envio**: `Terra 6.1: pending_send`, `Sol 6.1: pending_send`, `Sol Executor: pending_send`.
   - **No despacho da Tarefa #1**: `Terra 6.1: sent`, `Sol 6.1: pending_send`, `Sol Executor: sent` (achado real de corrida 2ms WS `childTurnStarted` antes do ACK HTTP diagnosticado ao vivo e corrigido em seguida com regressão em `aionCoreAdapter.test.ts`).
   - **Após `Reconciliar agora` da entrega concluída no Core**: `Sol Executor: applied` (`Aplicada à execução`), `Sol 6.1: pending_send` (ainda não acionado), arquivo `ctx.txt` verificado em disco com `"V606_CTX_OK"`.
   - **Após `Retomar fluxo` e aprovação independente**: `Terra 6.1: received`, `Sol 6.1: received`, `Sol Executor: applied`.
2. **Reload da aba durante execução no Core → `paused_queue` → `Reconciliar agora` → `Retomar fluxo` (sem repetir pedido)**:
   - Com a Tarefa #1 em execução real no Core (`slot=01a1eec1-f78a-7503-aa0e-2921a52177df`), executado `page.reload()`:
     - Estado imediato pós-reload: `executionStatus: "paused_queue"` (persistido no IndexedDB), banner exibido (`Reconciliar agora` + `Retomar fluxo`), **`postsDeltaOnReload: 0`**. Captura: `docs/screenshots/v6-06/v606_paused_after_reload.png`.
   - Core concluiu a Tarefa #1 enquanto a aba permanecia pausada (`ctx.txt` gravado em disco).
   - Clique em **`Reconciliar agora`**: recuperou a entrega (`taskStatus: "awaiting_review"`, `attemptsCount: 1`), manteve `executionStatus: "paused_queue"` e **`afterReconcilePostsDelta: 0`** (nenhum despacho automático). Captura: `docs/screenshots/v6-06/v606_reconciled_before_resume.png`.
   - Clique em **`Retomar fluxo`**: disparou **exatamente 1 POST** (`/api/teams/01a1eec1-f666-7462-95f6-9e74b81ec562/agents/01a1eec1-f726-7c81-9dfd-82834eb9b687/messages` — apenas a auditoria para `Sol 6.1`, sem repetir o pedido original nem a Tarefa #1); `Sol 6.1` auditou em disco e aprovou (`decision: "approved"`, `attempts: 1`, `reviews: 1`, `executionStatus: "completed"`). Captura: `docs/screenshots/v6-06/v606_resumed_completed.png`.
   - Cadeia de IDs preservada pós-reload: `Terra 6.1` (`slot=01a1eec1-f666-7462-95f6-9e86a478fde4`, `extConv=619640a3`, `cliSession=01a1eec2-047f-76f0-ab60-764abea10fcc`), `Sol 6.1` (`slot=01a1eec1-f726-7c81-9dfd-82834eb9b687`, `extConv=11dea282`, `cliSession=01a1eec3-34ff-7b93-af5a-8e9a708c4407`), `Sol Executor` (`slot=01a1eec1-f78a-7503-aa0e-2921a52177df`, `extConv=c6ed5379`).
3. **Backup JSON real exportado e importado pela UI**:
   - Exportação confirmada sem senha, cookies (`aionui-session`, `aionui-csrf-token`) ou flag `coreSessionAuthenticated`.
   - Pré-visualização de importação exibiu aviso explícito de 1 vínculo de equipe e 3 referências de sessão Core a desconectar. Captura: `docs/screenshots/v6-06/v606_backup_import_preview.png`.
   - `Importar como cópia` criou conversa `"V6-06 Contexto e Retomada (cópia)"` com `externalTeamId: undefined`, `importedExternalTeamId: "01a1eec1-f666-7462-95f6-9e74b81ec562"`, sessões `inactive` com `importedExternalRef` preservado, `executionStatus !== 'running'` e **`postsDeltaOnImport: 0`**.
4. **Reinício real do `aioncore.exe`**:
   - Com o Core parado, `Verificar /health` acusou indisponibilidade via proxy (`HTTP 502`) mantendo `executionMode: "aion_core"` sem fallback para Demonstração.
   - Após reiniciar `aioncore.exe`, `GET /api/teams` manteve a equipe `01a1eec1-f666-7462-95f6-9e74b81ec562` e `GET /api/conversations/c6ed5379/messages` preservou `14` itens persistidos.
5. **Falha real de IndexedDB no Chrome (`QuotaExceededError`)**:
   - Contexto Chrome com `indexedDB.open` falhando exibiu o aviso amarelo `Somente nesta sessão` + botão `Exportar agora` com **`0` `pageerror`**. Captura: `docs/screenshots/v6-06/v606_idb_session_only.png`.

### Matriz observada de sessões, retomada e visibilidade por fornecedor (V6-06)

- **Separação conceitual**: histórico do Vértice (IndexedDB + backup JSON) ≠ conversa/equipe no AionCore (`core-data` SQLite) ≠ sessão nativa da CLI (`nativeSessionId`) ≠ chat visível no aplicativo desktop do fornecedor. Nenhum aplicativo desktop original (Codex Desktop, Cursor IDE ou Antigravity GUI) precisou estar aberto para operar o Vértice.
- **Codex CLI (`codex.exe` `0.169.0-alpha.11.1`)**: expõe `session_id` nativo via ACP (`cliSession=01a1eec2-...`), suporta retomada entre turnos e após reinício do `aioncore.exe` (comprovado em V6-02 e V6-06) e possui comandos nativos `codex resume` / `codex agents` no CLI; o Vértice **não** importa chats manuais externos do Codex nem promete espelhamento no app desktop.
- **Antigravity CLI (`agy.exe` `1.5.9`)**: expõe `session_id` nativo via ACP e manteve continuidade após reinício do `aioncore.exe` em V6-02 (`CODIGO-BETA-842`), operando headless sem janela do app; listagem/visibilidade de sessões no app gráfico não é garantida nem importada automaticamente.
- **Cursor CLI (`cursor-agent`)**: executa sessões de equipe via AionCore headless (`V6-04`/`V6-05`) sem exigir IDE aberto; persistência de histórico da equipe ocorre no `aioncore.exe` e no IndexedDB do Vértice, sem sincronização garantida com a UI do editor Cursor.
- **Troca de origem/porta**: o IndexedDB do navegador é isolado por origem (`scheme://host:port`); antes de alterar porta/host, o usuário deve exportar um backup JSON completo em `Exportar / Backup` e nunca copiar arquivos internos do navegador manualmente.

### Limitações registradas no V6-06 (transparência para auditoria)

- **Corrida real WS `childTurnStarted` vs ACK HTTP no recibo `received` de `Terra 6.1`**: observada ao vivo na rodada real (`Terra 6.1` permaneceu em `sent` no momento do despacho e avançou para `received` no turno seguinte — registrado também no relatório `docs/screenshots/v6-06/v606_live_report.json`); corrigida imediatamente via `sendInitiatedEventIndex` e coberta por regressão determinística em `aionCoreAdapter.test.ts` sem repetir outra rodada paga de modelo.
- **Higiene de CI (`viteProxyConfig.test.ts` / `localServerProxy.test.ts`)**: adicionado tratamento de `'error'` nos sockets WS das fixtures para eliminar erro intermitente `ECONNRESET` no saída do Vitest.
- **Caminhos sem `turn_id` em tarefas com retentativas**: mantida a degradação segura de V6-05 (entrega recuperada via `catchup.slot_messages` com `attemptId` explícito é aceita normalmente; sem `attemptId` após retentativas vai para revisão manual).
- **Migração real `v1 → v2` e falha de escrita `QuotaExceededError` em mid-session**: cobertas por testes determinísticos em `workspace.test.ts` e `v4DomainAndMigration.test.ts`, além da falha real de abertura do IndexedDB comprovada no Chrome.

---

## Marcos — estado atualizado

- V6-00 — Instalação/launcher/servidor/CI: **concluído no Windows** (Linux/CI remota pendentes de runner).
- V6-01 — Core dedicado, origem e autenticação reais: **concluído**.
- V6-02 — Primeira sessão real e continuidade: **concluído**.
- V6-03 — Equipe/modelos/papéis/capacidades: **concluído**.
- V6-04 — Autoridade de coordenação/ciclo real: **concluído com Codex e Cursor** (repetição opcional de 3 tarefas com Antigravity/Gemini pendente).
- V6-05 — Permissões/correção/falhas/limites: **aprovado pelo auditor (18/11/2026)**.
- V6-06 — Contexto/sessões/dados/recuperação: **aprovado pelo auditor (18/11/2026)**, com higiene de CI (`viteProxyConfig.test.ts`) e correções documentais/evidências aplicadas em seguida.
- V6-07 — Acabamento/primeiro uso: **aprovado pelo auditor (18/11/2026)** (checkpoint `68dfb73`; adendo de defasagem registrado em `docs/screenshots/v6-07/v607_report.json`).
- V6-08 — Distribuição/operação: **aprovado pelo auditor (18/11/2026)** (`a1f7dd4`; `[P2]` de numeração do `README.md` corrigido e `[P3]` ACL Windows tratado no V6-09).
- V6-09 — Validação integrada/release: **aprovado pelo auditor (18/11/2026)** (`752deed`).
- V6-10 — Versionamento/GitHub/documentação: **aprovado com ressalvas pelo auditor (18/11/2026)** (`a52f2c9` já publicado em remoto privado `johnBremser/vertice-workspace.git`; reconciliação documental aplicada; pendências de decisão do usuário antes de abrir como público: `LICENSE`, CI remota, expurgo histórico de `data/` e `public/assets/aistudio/`).
- V6-11 — Modo de abertura padrão: **concluído e verificado em navegador real (19/11/2026)** — o workspace abre em Modo AionCore local, com workspace limpo e conexão real com o Core (`/health` confirmado, 1/5 etapas da preparação guiada).

---

## Etapa V6-07 — Acabamento e primeiro uso (concluída — aguardando revisão do auditor)

### Escopo e alterações implementadas

1. **Controles de simulação agrupados e marca visível sem dominar a conversa (`DemoControlsMenu.tsx`, `e2e/aion-desk.spec.ts`)**:
   - Todos os controles de simulação (`Avançar cenário`, `Executar automaticamente` / `Pausar`, cenários de borda como revisão/permissão/saída inválida e `Reiniciar demonstração`) foram agrupados no menu secundário **`Simulação`** (`aria-label="Controles de simulação"`).
   - O indicador discreto **`Modo Demonstração`** permanece visível na barra superior sempre que o modo ativo é Demonstração, distinguindo claramente simulação de operação real.

2. **IDs técnicos em blocos expansíveis preservando rastreabilidade (`WorkspaceHeader.tsx`, `MessageStream.tsx`, `ContextPanel.tsx`, `PermissionCard.tsx`)**:
   - `WorkspaceHeader.tsx`: `externalTeamId` bruto foi movido do breadcrumb inline para `"Equipe Core vinculada"` + `<details>ID</details>`.
   - `MessageStream.tsx`: `{item.sourceEventId}` e `{msg.sourceEventId}` passaram a residir em `<details>Detalhes técnicos</details>`, mantendo `data-event-id` e todos os links diretos de rastreabilidade (`timeline` ↔ tarefa ↔ contexto ↔ auditoria).
   - `ContextPanel.tsx` e `PermissionCard.tsx`: `inspectedRev.id`, `request.taskId` e `request.id` foram movidos para blocos `<details>`, mantendo o título legível da tarefa (`taskTitle`) visível inline.

3. **Compactação responsiva no mobile e fechamento seguro de drawer (`WorkspaceHeader.tsx`, `AgentTabs.tsx`, `Composer.tsx`, `WorkspaceContext.tsx`)**:
   - `WorkspaceHeader.tsx`: padding compacto no mobile (`px-3 py-2 sm:px-6 sm:py-2.5`).
   - `AgentTabs.tsx`: padding vertical reduzido no mobile (`py-2 ... sm:py-3`) preservando navegação por teclado (`ArrowRight`/`Home`) e unread/status.
   - `Composer.tsx`: altura compacta no mobile (`px-3 pt-1.5 pb-2`, `min-h-[38px]`, rótulo conciso `Para: ... (Geral)` + checkbox `Registrar no contexto` + botão `Enviar` sempre visíveis; rodapé de assinatura oculto em `< sm`).
   - `WorkspaceContext.tsx`: listener `matchMedia('(min-width: 1280px)')` fecha o `InspectorDrawer` auto-aberto no desktop caso a janela encolha para `< 1280px` (`xl:`), evitando sobreposição indesejada no mobile.

4. **Preparação guiada real sem falsos positivos (`types.ts`, `storage.ts`, `exportService.ts`, `aionCoreAdapter.ts`, `SettingsView.tsx`, `App.tsx`)**:
   - Adicionado `coreRuntimeStatus?: 'unknown' | 'reachable' | 'unreachable'` em `WorkspaceStoreState` (persistido em `storage.ts`, redefinido para `'unknown'` após `sanitizeLoadedStateAfterReload`, em importação `replace` no `exportService.ts` e na troca de `baseUrl` em `updateCoreSettings`).
   - `checkHealth()`, `checkAuthStatus()`, `login()` e `refreshCoreCatalog()` atualizam `coreRuntimeStatus` mesmo quando `store.connections` ainda não possui conexões `aion_core` (origem limpa antes de sincronizar o catálogo).
   - Corrigido `refreshCoreCatalog()` em `aionCoreAdapter.ts` (`Boolean(latestState.coreSessionAuthenticated)` em vez de `?? true`) para nunca assumir sessão autenticada sem comprovação.
   - Em `SettingsView.tsx`, as 5 etapas da **Preparação guiada para operação real** só confirmam progresso quando `mode === 'aion_core'` e o sinal correspondente foi comprovado nesta sessão; adicionada barra **`Próximo passo`** com ações diretas (`Verificar /health agora`, `Checar sessão`, `Sincronizar catálogo agora`, `Criar time no Core`, `Ir para a conversa`) e alertas explícitos para runtime inacessível ou catálogo sem agentes selecionáveis.
   - Em `src/App.tsx`, `isPausedDemo` restringe o banner `"Demonstração pausada após recarregar"` para `executionMode !== 'aion_core'` e `mainSurface === 'conversation'`, evitando banner residual ao inspecionar `Configurações` ou operar em modo `AionCore local`.
   - **Correção `[P1]` da auditoria (`exportService.ts`, `v4DomainAndMigration.test.ts`)**: `applyImportedWorkspaceBackup(..., 'copy')` deixou de invocar `sanitizeLoadedStateAfterReload()` sobre `currentState`, preservando `coreRuntimeStatus`, `coreSessionAuthenticated`, conexões/catálogo Core e conversas vivas; `detachExternalBindingsFromProjection()` passa a pausar conversas `running` copiadas/substituídas diretamente para `paused_queue`/`paused_demo` com `autoPlayWasRunning: false` e desvinculação completa.
   - **Endereçamento `[P2]` da auditoria (`WorkspaceContext.tsx`, `SettingsView.tsx`, `workspace.test.ts`)**: adicionado `probeCoreSessionOnStartup()` silencioso ao carregar em modo `aion_core` (revalida `/health`, `/api/auth/status` e, quando autenticado, `/api/agents/management` + `/api/assistants` sem custo de modelo nem alertas na abertura) + nota explicativa explícita na checklist de preparação em `SettingsView.tsx`.

### Verificações determinísticas (após a última edição)

- `npm run lint` (`tsc --noEmit`): **0 erros**.
- `npm test` (`vitest run`): **8 arquivos / 67 testes aprovados (67/67, exit 0)**, incluindo:
  - Novo teste em `src/services/__tests__/workspace.test.ts` validando invalidação de flags vivas (`coreRuntimeStatus`, `coreSessionAuthenticated`, conexões Core) após reload e comportamento de `probeCoreSessionOnStartup()` para sessão autenticada, não autenticada, Core inacessível e cancelamento.
  - Asserções estendidas em `src/domain/__tests__/v4DomainAndMigration.test.ts` provando que `applyImportedWorkspaceBackup(..., 'copy')` preserva `coreSessionAuthenticated: true`, `coreRuntimeStatus: 'reachable'`, conexões `aion_core` e conversa ativa em `running`, mantendo a cópia desvinculada e em `paused_queue`.
  - Novo teste em `src/services/__tests__/aionCoreAdapter.test.ts` (`V6-07`) validando rastreamento de `coreRuntimeStatus` com `0` conexões Core (`reachable`/`unreachable`), preservação de `coreSessionAuthenticated === false` em `refreshCoreCatalog()` e reset para `'unknown'` ao alterar `baseUrl` em `updateCoreSettings()`.
- `npm run build` (`vite build`): **OK (1,15s)**.
- `npm run test:e2e` (`playwright test`, Chrome real em modo Demonstração + menu `Simulação`): **1/1 aprovado (13,3s)**.
- Revalidação real pós-reload sem modelo (`aioncore.exe v0.2.2` + Chrome + `vertice-ctl`): após autenticar e sincronizar catálogo (`3/5 etapas confirmadas`), `page.reload()` revalidou silenciosamente `/health`, `/api/auth/status` e catálogo, restaurando **`afterReloadChecklist: 3/5 etapas confirmadas`** sem clique manual nem chamada a modelo; captura `docs/screenshots/v6-07/v607-error-core-unreachable.png` confirmada com `hasDemoPausedBanner: false`.
- Ambiente encerrado limpo (`vertice-ctl` e `aioncore.exe` finalizados).

### Evidências reais observadas com `aioncore.exe v0.2.2` + Chrome (origem limpa)

Registrado em `docs/screenshots/v6-07/v607_report.json` e capturas em `docs/screenshots/v6-07/`:

1. **Matriz responsiva e temas (Modo Demonstração + menu `Simulação` + IDs em `<details>` + teclado `ArrowRight`/`Home` + `Esc` no drawer/modal)**:
   - `1440×900` escuro (`v607-1440x900-dark.png`) e claro (`v607-1440x900-light.png`): `scrollWidth=1440`, `overflow=false`, `headerHeight=87`, `composerHeight=192`.
   - `1024×768` escuro (`v607-1024x768-dark.png`) e claro (`v607-1024x768-light.png`): `scrollWidth=1024`, `overflow=false`, `headerHeight=87`, `composerHeight=192`.
   - `390×844` escuro (`v607-390x844-dark.png`) e claro (`v607-390x844-light.png`): `scrollWidth=390`, `overflow=false`, `headerHeight=101`, `composerHeight=133`, com destinatário, `Registrar no contexto` e `Enviar` visíveis; `stepBtnOutsideMenuCount=0`, `hiddenTechDetailsCount=1`, `visibleRawEvtIds=false`, `pageErrors=[]`.
2. **Primeiro uso real guiado (`0/5 → 5/5`) sem editar JSON nem DevTools**:
   - Origem limpa em modo `aion_core` (com conexões Demo ignoradas): iniciou em **`0/5 etapas confirmadas`**.
   - Clique em `Verificar /health agora` → **`1/5 etapas confirmadas`**.
   - Autenticação WebUI (`admin`) → **`2/5 etapas confirmadas`**.
   - Clique em `Sincronizar catálogo agora` → **`3/5 etapas confirmadas`**.
   - Criação de projeto + conversa e time real no Core (`teamId=01a1ef22-a29f-7190-8c1f-687800235f84`, `Codex gpt-5.6-luna`) → **`4/5 etapas confirmadas`** (`v607-onboarding-4of5.png`).
   - Primeiro pedido real aceito e respondido (`v607-first-use-real-1440x900.png`) → **`5/5 etapas confirmadas`** (`v607-onboarding-5of5.png`), `pageErrors=[]`.
   - Após `page.reload()`: estado vivo foi invalidado com honestidade para **`2/5 etapas confirmadas`** (exigindo nova comprovação de runtime, autenticação e catálogo na sessão atual).

### Limitações registradas no V6-07 (transparência para auditoria)

- A matriz completa de 6 capturas e a rodada real completa `0/5 → 5/5` (`v607_report.json` e `v607-onboarding-*.png`) foram registradas antes da correção final do banner `isPausedDemo` e dos ajustes `[P1]`/`[P2]` da auditoria; após os ajustes finais, foram reexecutados `tsc --noEmit`, `npm test` (67/67), `npm run build`, `npm run test:e2e` (Chrome real) e a verificação real pós-reload (`3/5 etapas confirmadas` contra `aioncore.exe v0.2.2`), sem repetir chamada paga ao modelo apenas pelo ajuste de banner e importação/revalidação.
- Correções e evidências consolidadas em commit de checkpoint do V6-07 aguardando confirmação final do auditor antes de iniciar o V6-08.

---

## Etapa V6-08 — Distribuição e operação local (concluída — aguardando revisão do auditor)

### Escopo e alterações implementadas

1. **Endurecimento de distribuição e proteção contra exposição (`scripts/vertice-server.mjs`)**:
   - `resolveDistFile()` passa a validar também `fs.realpathSync()` contra `realDist`, bloqueando leitura de arquivos externos via symlinks além da checagem de travessia de caminho (`..`).
   - `forwardHttpRequest()` e `forwardWebSocketUpgrade()` removem o cabeçalho interno `x-vertice-control-token` antes de encaminhar requisições/upgrades ao AionCore upstream.
   - Mantidos bind estrito em loopback (`127.0.0.1` por padrão, bloqueio de bind não-loopback sem override explícito), redirecionamento de cookies `Set-Cookie`, CSRF, subprotocolo WS `[ws_token]` e tratamento HTTP `502` JSON / drop WS limpo quando upstream está indisponível.

2. **`doctor` com diagnósticos e passos objetivos de recuperação (`scripts/vertice-ctl.mjs`)**:
   - `cmdDoctor()` valida faixa de Node (`^22.12.0 || ^24.0.0 || >=26.0.0`), presença de `dist/index.html`, `.env.local`, aviso caso `VITE_AIONCORE_BASE_URL` esteja preenchido junto ao proxy, política de loopback em `VERTICE_HOST` e `VITE_AIONCORE_PROXY_TARGET`, validade da porta (`1..65535`), estado comprovado vs `unverified_pid` (sem nunca anunciar PID não comprovado como servidor identificado nem expor `controlToken`), separação clara de diretórios (`dist/`, `.vertice/`, IndexedDB, `--data-dir`/`--log-dir` externos) e seção **`Ações e recuperação`** com orientação prática para cada falha.
   - Corrigido bug real diagnosticado durante o roteiro de extração limpa: em Node.js, `fetch()` lança `TypeError: fetch failed` em `ECONNREFUSED`, que era confundido com `URL inválida em VITE_AIONCORE_PROXY_TARGET`. A validação sintática da URL foi isolada em bloco próprio antes do `fetch('/health')`, garantindo reporte exato de `inacessível (ECONNREFUSED)` com passos de recuperação para iniciar o Core.

3. **Documentação de camadas, pré-requisitos de rede, atualização e rollback (`README.md`, `docs/compatibility-matrix.md`, `docs/screenshots/v6-07/v607_report.json`)**:
   - Documentados separadamente: (1) Vértice Workspace (`src/`, `scripts/`, `dist/`, `.vertice/`), (2) AionCore Local (`aioncore.exe v0.2.2`, `--data-dir`/`--work-dir`/`--log-dir` externos), (3) pré-requisitos/rede (Node 24 recomendado, `npm ci`, Playwright Chromium opcional, aviso explícito de que pacote/binário local não é 100% offline na preparação inicial nem nas chamadas aos modelos) e (4) CLIs/autenticação separados (`codex`, `cursor-agent`, `antigravity`).
   - Documentados atualização segura sem apagar dados/credenciais e retorno à versão anterior usando apenas commits reais existentes no Git (`git log --oneline`, ex. `40f39f8`, `68dfb73`).
   - Adicionado `addendumNote` em `docs/screenshots/v6-07/v607_report.json` esclarecendo a defasagem do campo histórico `afterReloadSteps: "2/5"` antes do commit `68dfb73` (`[P3]` da auditoria anterior).

### Verificações determinísticas (após a última edição)

- `npm run lint` (`tsc --noEmit`): **0 erros**.
- `npm test` (`vitest run`): **8 arquivos / 69 testes aprovados (69/69, exit 0)**, incluindo:
  - Novo teste em `src/services/__tests__/localServerProxy.test.ts` (`V6-08`) validando múltiplos `Set-Cookie` (`aionui-session` + `aionui-csrf-token`), subprotocolo WS `Sec-WebSocket-Protocol`, remoção de `x-vertice-control-token` antes do upstream, queda HTTP `502` / WS sem derrubar `dist/`, reconexão após retorno do upstream na mesma porta e bloqueio de travessia/symlink.
  - Novo teste em `src/services/__tests__/verticeLauncher.test.ts` (`V6-08`) validando `doctor` com `dist/` ausente, `.env.local` inválido e válido-mas-inacessível (`inacessível`, nunca `URL inválida`), `unverified_pid` sem encerrar PID alheio, passos de recuperação explícitos e ausência de vazamento de `controlToken`.
- `npm run build` (`vite build`): **OK (1,50s)**.
- `npm run test:e2e` (`playwright test`, Chrome real): **1/1 aprovado (13,2s)**.
- `node scripts/vertice-ctl.mjs doctor` (com `VITE_AIONCORE_PROXY_TARGET=http://127.0.0.1:25828` e Core desligado): confirmou `/health: inacessível (ECONNREFUSED)`, separação de diretórios e passo de recuperação para iniciar o binário externo do Core; `node scripts/vertice-ctl.mjs status` confirmou servidor parado (`sem PID rastreado`).

### Evidências reais em extração limpa + build estático + `aioncore.exe v0.2.2` + Chrome

Registradas em `docs/screenshots/v6-08/v608_dist_report.json` e capturas em `docs/screenshots/v6-08/`:

1. **Extração limpa em diretório temporário isolado (`preInstallHasNodeModules: false`, `preBuildHasDist: false`)**:
   - Instalado com `npm ci --offline` (cache local aquecido; documentado que primeira máquina limpa requer rede), configurado `.env.local` (`VITE_AIONCORE_PROXY_TARGET="http://127.0.0.1:25828"`), construído `dist/` via `npm run build` (`built in`), verificado `doctor` antes do build (apontou `dist/` ausente + passos de recuperação) e com Core ativo (`alcançável (HTTP 200 ...)`), iniciado via `npm run server:start` (`ativo e verificado` em `http://127.0.0.1:4173`).
2. **Execução real via proxy estático `vertice-server.mjs` (cookies, CSRF, WS `[ws_token]`)**:
   - Chrome persistente autenticou no WebUI (`admin`), sincronizou catálogo, criou time `01a1ef60-f8b5-7543-b26e-c6e8dd203695` (`Codex gpt-5.6-luna`), conectou WS e executou pedido real com resposta observada **`V608_DIST_REAL_OK`** (`docs/screenshots/v6-08/v608-dist-real-order.png`), `pageErrors: []`.
3. **Queda e reconexão do Core upstream**:
   - Parando `aioncore.exe`, o proxy retornou **`HTTP 502`** (`outageHttpStatus: 502`) com mensagem honesta (`docs/screenshots/v6-08/v608-upstream-outage-502.png`) mantendo `vertice-server` ativo (`verticeServerStayedUp: true`); ao reiniciar `aioncore.exe`, reconectou até **`5/5 etapas confirmadas`** (cookie WebUI sobreviveu ao reinício do Core).
4. **Encerramento controlado, rebuild e reinício preservando dados**:
   - Fechamento controlado via `npm run server:stop` (`encerrado com segurança` / `status: parado`), rebuild estático simulando atualização (`npm run build`), reinício via `npm run server:start` e reabertura do perfil persistente do Chrome em `http://127.0.0.1:4173`: conversa `"Execucao Dist Real"` e resposta `V608_DIST_REAL_OK` integralmente preservadas, com revalidação silenciosa restaurando **`5/5 etapas confirmadas`** (`docs/screenshots/v6-08/v608-after-restart-5of5.png`) e logs gravados em `.vertice/logs/server.{out,err}.log`.

### Limitações registradas no V6-08 (transparência para auditoria)

- O script de extração limpa (`verify_v6_08_dist.mjs`) revelou `docCoreDownHasRecovery: false` em razão da captura de `TypeError` no `fetch` quando o Core estava desligado; o defeito foi corrigido imediatamente em `scripts/vertice-ctl.mjs` e coberto pelo teste determinístico em `verticeLauncher.test.ts` + execução direta de `vertice-ctl.mjs doctor` contra porta fechada (confirmando `inacessível` + ação de recuperação), sem repetir nova chamada paga ao Codex apenas para regenerar o campo boolean do JSON da rodada.
- Distribuição validada nativamente no Windows 11 (`Node v24.11.0`); validação real interativa do instalador/serviço em Linux segue coberta pela suíte Vitest multiplataforma e CI.

---

## Etapa V6-09 — Validação integrada e release (concluída — aguardando revisão do auditor)

### Escopo e alterações implementadas

1. **Correção do `[P2]` e fechamento do `[P3]` da auditoria do V6-08 (`README.md`, `scripts/vertice-ctl.mjs`, `verticeLauncher.test.ts`, `compatibility-matrix.md`)**:
   - Restaurada a numeração sequencial `1..5` em `README.md` (`git checkout -- README.md`) após formatação externa pós-`a1f7dd4`, e versionado `docs/auditoria-v6-08-2026-11-18.md`.
   - Adicionado `restrictPrivateFileAcl()` em `scripts/vertice-ctl.mjs` (`icacls <pidFile> /inheritance:r /grant:r "<usuario>:(R,W)"` com `windowsHide: true` no Windows) garantindo remoção de ACLs herdadas (`Everyone`/`BUILTIN\Users`) em `.vertice/server.json`, coberto por asserção em `src/services/__tests__/verticeLauncher.test.ts` e documentado com a devida fronteira de confiança de mesmo usuário em `docs/compatibility-matrix.md`.

2. **Fixtures baseadas em payloads reais sanitizados do produtor (`src/services/__tests__/fixtures/coreV022RealPayloads.ts`, `src/services/__tests__/aionCoreAdapter.test.ts`)**:
   - Extraídos e sanitizados payloads reais observados no `AionCore v0.2.2` (`health`, `auth/status`, `agents/management`, `assistants`, `team.slotWorkChanged` `runtime_starting`, `team.childTurnStarted` / `team.childTurnCompleted` conforme `TeamChildTurnPayload`, `message.stream` `tips`/`content`/`finish`/`acp_permission`, `ConfirmRequest` com `always_allow: false`, e `GET /api/conversations/:id/messages`).
   - Adicionado teste `V6-09` em `aionCoreAdapter.test.ts` validando o fluxo integrado completo contra esses contratos reais, incluindo promoção `PATCH .../model` (`GPT-5.6-Luna`) e isolamento entre abas.

3. **Relatório consolidado da candidata funcional (`docs/v6-09-release-candidate.md`)**:
   - Documentados versões reais, comandos executados, resultados da suíte candidata, mapeamento completo dos 10 itens obrigatórios do V6-09 e separação explícita entre **prontidão funcional** (atingida na combinação Windows 11 + `AionCore v0.2.2` + `Codex` / `Cursor`), **publicação** (`V6-10`) e **release `v1.0.0`** (ainda não declarada).

### Verificações na candidata final (`Node v24.11.0`, após a última edição de código)

- `npm run lint` (`tsc --noEmit`): **0 erros**.
- `npm test` (`vitest run`): **8 arquivos / 70 testes aprovados (70/70, exit 0, 8,91s)** — todos os arquivos aprovados sem falhas nem skips.
- `npm run build` (`vite build`): **OK (1,82s)**.
- `npm run test:e2e` (`playwright test`, Chrome real): **1/1 aprovado (12,4s)**.
- `node scripts/vertice-ctl.mjs status`: parado (`sem PID rastreado`).

### Limitações registradas no V6-09 (transparência para auditoria)

- Não foi executada nova rodada paga aos modelos nesta etapa porque as alterações de código do V6-09 restringiram-se à ACL Windows de `.vertice/server.json` e à incorporação dos payloads reais sanitizados nas fixtures/testes; os 10 casos do roteiro reúnem as execuções reais comprovadas de `V6-01`..`V6-08` combinadas à revalidação integral da suíte determinística na candidata atual.
- Permanecem documentados na matriz: ciclo completo de 3 tarefas no provedor opcional `Antigravity` (`agy.exe`), política conservadora `always_allow: false` e execução interativa direta em Linux.

---

## Etapa V6-10 — Versionamento, GitHub e documentação (concluída localmente)

### Escopo e alterações implementadas

1. **Higiene de rastreamento Git e exclusões obrigatórias (`.gitignore`, `git rm --cached`)**:
   - Removidos do índice Git os arquivos de banco legado `data/aionui-backend.db` (774 KB) e `data/aionui-backend.db.migrate.lock` (que estavam versionados desde o commit inicial `1229ebb`), adicionando `data/`, `*.db` e `*.db.*` ao `.gitignore`.
   - Sanitizado `"extractedDir"` em `docs/screenshots/v6-08/v608_dist_report.json` (`%TEMP%\vertice-v608-clean`) removendo referência a caminho curto pessoal.
   - Mantidos fora do controle de versão: `.env.local`, credenciais (`local-admin-password.txt`), cookies, `.vertice/`, `node_modules/`, `dist/`, `.vitest/`, `test-results/` e binários de runtime.

2. **Correção real de ACL no Windows descoberta durante captura da candidata (`scripts/vertice-ctl.mjs`, `verticeLauncher.test.ts`)**:
   - Ao executar a captura da candidata no diretório raiz (`docs/screenshots/v6-09/v609-candidate-live-settings.png`), `icacls /inheritance:r /grant:r "<usuario>:(R,W)"` causou `EPERM` no `fs.rmSync(.vertice/server.json)` porque `.vertice/` no diretório do repositório não concedia `DELETE_CHILD` herdado (diferente de `%TEMP%`).
   - Corrigido em `restrictPrivateFileAcl()` para `${principal}:F` (controle completo apenas ao proprietário, removendo todas as ACEs herdadas) e comprovado por `vertice-ctl start → icacls (.vertice\server.json -> STARS\joao.gonzales:(F)) → vertice-ctl stop → status (parado)` + asserção explícita em `verticeLauncher.test.ts`.

3. **Evidência da candidata V6-09/V6-10 (`docs/screenshots/v6-09/`)**:
   - Anexados `docs/screenshots/v6-09/v609-candidate-live-settings.png` (Chrome real conectado ao `aioncore.exe v0.2.2` via `vertice-server.mjs`, `3/5 etapas confirmadas`, 28 assistentes / 43 agentes no catálogo, sem chamadas pagas a modelo) e `docs/screenshots/v6-09/v609_candidate_report.json`.

4. **Licenças, atribuições e alinhamento integral de documentação**:
   - Criado `THIRD_PARTY_NOTICES.md` preservando atribuições **Apache-2.0** (`AionUi 2.2.2` `e108b6b5`, `AionCore v0.2.2` `503a8719`) e inventário de licenças npm/Node.
   - Atualizados `README.md`, `CHANGELOG.md`, `docs/architecture.md`, `docs/aioncore-integration.md`, `docs/compatibility-matrix.md`, `docs/local-validation.md` e `docs/local-handoff.md` alinhando com o estado real verificado (`0.4.0`, `v1.0.0` não declarada, `70/70` Vitest, `data/` excluído).

### Estado do remoto GitHub e reconciliação pós-auditoria (`18/11/2026`)

- Histórico Git local verificado e contínuo: `1229ebb` → `40f39f8` → `68dfb73` → `a1f7dd4` → `752deed` → `a52f2c9` (seguido do commit de reconciliação documental).
- Remoto configurado: `origin = https://johnBremser@github.com/johnBremser/vertice-workspace.git` (**repositório privado**, resposta 404 anônima). A auditoria confirmou que `origin/main` já foi atualizado para `a52f2c9` (sem exposição pública e sem segredos em nenhum dos 6 commits).
- **Decisões pendentes do usuário antes de tornar o repositório público ou emitir tag**:
  1. ~~Adicionar `LICENSE` do projeto~~ **Concluído**: `LICENSE` (**Apache-2.0**) adicionado na raiz e referenciado no `README.md`; `public/assets/aistudio/` (~1,98 MB sem uso) removido.
  2. Enviar os commits locais de ajuste (`git push origin main`) e acompanhar a execução verde do workflow `.github/workflows/ci.yml` no GitHub Actions (`ubuntu-latest` Node 22/24, `windows-latest` Node 24 e E2E), em especial o teste de ACL no runner Windows.
  3. Opcionalmente expurgar `data/aionui-backend.db` dos 5 commits históricos (`1229ebb`..`752deed` — blob único de 774 KB, `0` `INSERT`, sem credenciais/tokens) via `git filter-repo --path data/ --invert-paths` com force-push autorizado caso queira histórico limpo antes de tornar público.
  4. **Não declarar `v1.0.0`** enquanto permanecerem abertos: ciclo completo de 3 tarefas com `Antigravity`, política `Allow always` e promoção de modelo via `PATCH /model` aprovada ao vivo.

---

## Etapa V6-11 — Modo de abertura padrão em AionCore local (concluída)

**Pedido do usuário (19/11/2026)**: "quero um software pronto para meu uso" — o workspace abria em Modo Demonstração, sem qualquer conexão com o Core.

### O que mudou

1. **Padrão de abertura** (`src/services/executionModePreference.ts`):
   - `DEFAULT_EXECUTION_MODE = 'aion_core'`: um workspace novo abre em **Modo AionCore local** (HTTP/WS real), não na simulação.
   - A preferência explícita escolhida em **Configurações → Modo de operação do workspace** é persistida em `aion_desk_mode_pref_v1` (`localStorage`) e **sempre prevalece** sobre o padrão.
2. **Resolução de modo no arranque** (`resolveBootstrapExecutionMode` em `WorkspaceContext.tsx`): preferência explícita → workspace apenas com o cenário semeado (segue o padrão) → workspace de simulação legado (preservado) → modo do próprio estado.
3. **Workspace Core limpo** (`aionCoreAdapter.loadWorkspace`): o cenário de demonstração semeado é descartado e persistido como workspace Core vazio, evitando conteúdo simulado numa sessão real. A simulação continua disponível e **re-semeia** o cenário determinístico quando selecionada (`mockGateway.loadWorkspace`).
4. **Sem fallback silencioso**: o modo Core nunca degrada para o mock; se o Core estiver inacessível, a UI mostra o estado real de erro e a preparação guiada permanece em 1/5.

### Verificação independente

- `npm run lint`: **0 erros**.
- `npx vitest run`: **9 arquivos, 80/80 testes** (inclui `executionModePreference.test.ts` com 9 casos e a regressão de workspace limpo em `workspace.test.ts`).
- `npm run build`: **OK**; `npm run test:e2e`: **1/1** — a suíte Playwright agora **opta explicitamente** pelo modo de simulação via `addInitScript`, sem depender do padrão do produto.
- **Navegador real** (Chrome, proxy `http://127.0.0.1:4173` + `aioncore.exe v0.2.2` dedicado): abertura em **"Modo AionCore local"**, workspace vazio ("Nenhum projeto ativo"), Configurações com o painel **"Conexão AionCore Local (WebUI v0.2.2)"** e a preparação guiada em **1/5 etapas confirmadas** (passo 1 "Conectar runtime local" confirmado por `/health` real).
- `GET /api/auth/status` pelo proxy: `is_authenticated: false` antes do login e `true` após `POST /login` com a conta local `admin` — a autenticação real do Core foi exercitada no mesmo caminho usado pela UI.

### Nota operacional

O `codex` CLI **não está no PATH do sistema**; o Core o detecta apenas quando iniciado com `C:\Users\joao.gonzales\AppData\Local\OpenAI\Codex\bin\5449c1f0f26f1f98` somado ao PATH (idem `agy` e `cursor-agent`). Sem isso, `aioncore doctor` reporta `codex: missing` e a equipe real não forma.
