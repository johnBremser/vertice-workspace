# Changelog — Vértice Workspace

Este arquivo registra a evolução técnica do **Vértice Workspace** (*Powered by AionCore*), mantendo distinção rigorosa entre o que foi validado por fixtures/navegador e o que ainda depende de comprovação contra o `AionCore v0.2.2` e CLIs locais reais.

---

## [Não lançado — Prévia v5] · Aguardando comprovação local (V5-02 a V5-05)

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
