# Changelog — Vértice Workspace

Este arquivo registra a evolução técnica do **Vértice Workspace** (*Powered by AionCore*), mantendo distinção rigorosa entre o que foi validado por fixtures/navegador e o que ainda depende de comprovação contra o `AionCore v0.2.2` e CLIs locais reais.

---

## [Não lançado — V6 Local (V6-00 a V6-06 aprovados)]

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
