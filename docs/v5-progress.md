# Progresso do Plano v5 — Vértice Workspace

Registro por marcos do Plano v5 (`docs/implementation_plan_v5.md`), distinguindo explicitamente:
- **Implementado no código**
- **Testado com fixtures / unitário**
- **Observado no navegador (Playwright / Chromium)**
- **Comprovado com AionCore e CLIs reais**

---

## V5-00 — Baseline local, documentação v5 e portabilidade Windows

**Estado**: Concluído (ambiente Linux headless; portabilidade Windows corrigida no código e aguardando confirmação local em Windows).

### O que mudou
1. **Baseline Git preservado**: repositório inicializado localmente em `main`, preservando o snapshot de entrada v4 (`7fac7bd`) antes de qualquer alteração do Plano v5.
2. **Documentação de referência v5 sincronizada em `docs/`**:
   - `docs/implementation_plan_v5.md`
   - `docs/design/visual-refresh-v1.md`
   - `docs/design/workspace-reference.html`
   - `docs/future-minimal-core.md` (registrado apenas como avaliação futura, fora do escopo da v1)
3. **Portabilidade Windows do teste de proxy (`src/services/__tests__/viteProxyConfig.test.ts:106`)**:
   - Corrigido o import ESM dinâmico do processo filho usando `pathToFileURL(path.join(repoRoot, 'node_modules/vite/dist/node/index.js')).href`, evitando erro `ERR_UNSUPPORTED_ESM_URL_SCHEME` para caminhos `C:\...` no Windows sem alterar o comportamento do proxy.
4. **`.gitignore` revisado**: incluídas regras para `.aistudio/`, `.vertice/`, `.eslintcache` e `server.js` gerado.
5. **Capturas "Antes" (`V5-01`) geradas sobre o baseline visual v4** em `docs/screenshots/v5-01/before-{1440x900,1024x768,390x844}-{dark,light}.png` para a conversa `"Busca por nome na listagem"`.

### Comandos e resultados observados (Linux sandbox Node v22.23.2 / npm 10.9.8)
- `npm run lint` (`tsc --noEmit`): **aprovado** (0 erros).
- `npm test` (`vitest run`): **aprovado** — 6 arquivos, **37/37 testes** (fixtures/unitários, incluindo `viteProxyConfig.test.ts`).
- `npm run build` (`vite build`): **aprovado** em 1,17s.
- `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/ms-playwright/chromium_headless_shell-1247/chrome-headless-shell-linux64/chrome-headless-shell npx playwright test --reporter=line`: **aprovado** — **1/1 E2E completo** (8,1s) observado no navegador Chromium headless.

### Limitações e próximo passo
- Execução confirmada neste ambiente Linux (`Node v22.23.2`); reconfirmação de `viteProxyConfig.test.ts` em PowerShell/Windows nativo pendente na máquina local do usuário.
- **Próximo marco**: `V5-01` — Atualização visual e aplicação da identidade **Vértice Workspace** (sem misturar alterações em `aionCoreAdapter`, domínio ou contratos).

---

## V5-01 — Atualização visual e aplicação da identidade Vértice Workspace

**Estado**: Concluído (entregue e registrado separadamente antes de qualquer alteração de integração/distribuição).

### O que mudou
1. **Identidade aprovada aplicada sem quebrar compatibilidade**:
   - Marca **Vértice Workspace**, slogan **Seu time de agentes, do plano à entrega.** e assinatura técnica **Powered by AionCore** em `src/config/brand.ts`, `index.html` (`<title>` e meta tags OG/description), UI (`ProjectSidebar`, `Composer`, `ExportDialog`, `SettingsView`), `README.md` e `docs/architecture.md`.
   - Preservados identificadores internos (`aion_desk_storage`, `aion-desk/v1`, `aion-desk-json`, `exportSchemaVersion: "2.0.0"`) e `metadata.json`.
2. **Tokens, contraste e temas claro/escuro completos (`src/index.css`)**:
   - Tema escuro grafite (`#101216` / `#14171c` / `#191d24`) e claro papel grafite (`#f5f7fa` / `#edf1f5` / `#ffffff`) com destaque azul-petróleo (`#6dd8c5` no escuro, `#126f63` no claro) e `--accent-contrast` calibrado para leitura confortável.
3. **Hierarquia visual e redução de ruído operacional (`workspace-reference.html` / `visual-refresh-v1.md`)**:
   - **Sidebar (`ProjectSidebar.tsx`)**: marca geométrica Vértice discreta, lista limpa de projetos com fio guia na coluna de conversas e rodapé com estado resumido + Configurações + Recolher. Em mobile (`< 1024px`), inicia recolhida como drawer sob demanda, evitando cobrir a conversa no primeiro carregamento.
   - **Header (`WorkspaceHeader.tsx` + `DemoControlsMenu.tsx`)**: dois níveis limpos (breadcrumb + modo explícito `Modo Demonstração` / `Modo AionCore local` no topo; título `<h1>` + status único + controles de simulação secundários + `Trabalho` + `Exportar` + tema no segundo nível), corrigido para evitar truncamento em `1024px`.
   - **Abas (`AgentTabs.tsx`)**: duas linhas legíveis por participante (avatar `30×30px`, nome + não lidas, papel + status semântico) mantendo navegação por teclado.
   - **Fluxo de mensagens (`MessageStream.tsx`)**: coluna centrada (`max-w-[820px]`), destaque editorial para pedidos de `Você`, grade de participantes + tabela inline `Plano de trabalho` para `coordinator_plan`, eventos rotineiros (`task_delegated`, `task_progress`, `context_revision`, `status_change` comum) como linhas leves de timeline, e bordas/fundos dedicados apenas para permissões, falhas operacionais e escalonamentos.
   - **Inspector contextual (`InspectorDrawer.tsx`, `TasksPanel.tsx`, `TaskDetailCard.tsx`, `ContextPanel.tsx`)**: painel direito `Trabalho` contextual em telas `>= 1280px` e slide-over com foco e backdrop em viewports menores.
   - **Configurações (`SettingsView.tsx`)**: blocos organizados para modo/conexão Core (com diagnóstico HTTP/WS expansível), equipe, política, catálogo e seção Sobre com atribuição técnica ao AionCore.
4. **Arquivos principais alterados**:
   - `index.html`, `src/index.css`, `src/config/brand.ts`, `src/i18n/ptBR.ts`, `src/App.tsx`, `src/components/ExportDialog.tsx`
   - `src/features/workspace/{WorkspaceContext,WorkspaceHeader,AgentTabs,MessageStream,Composer,DemoControlsMenu}.tsx`
   - `src/features/projects/ProjectSidebar.tsx`, `src/features/inspector/{InspectorDrawer,TasksPanel,TaskDetailCard,ContextPanel}.tsx`, `src/features/settings/SettingsView.tsx`
   - `e2e/aion-desk.spec.ts`, `README.md`, `docs/architecture.md`

### Comandos, resultados e evidências visuais
- `npm run lint` (`tsc --noEmit`): **aprovado** (0 erros).
- `npm test` (`vitest run`): **aprovado** — 6 arquivos, **37/37 testes**.
- `npm run build` (`vite build`): **aprovado** em 1,16s.
- `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/ms-playwright/chromium_headless_shell-1247/chrome-headless-shell-linux64/chrome-headless-shell npx playwright test --reporter=line`: **aprovado** — **1/1 E2E completo** (8,0s), incluindo abertura/fechamento de drawer `Trabalho` e sidebar no viewport mobile `390×844` sem overflow horizontal.
- **Capturas comparáveis "Depois" inspecionadas**: `docs/screenshots/v5-01/after-{1440x900,1024x768,390x844}-{dark,light}.png` sobre a conversa `"Busca por nome na listagem"`.

### Limitações e próximo passo
- Validação visual automatizada e por inspeção feita neste ambiente em modo Demonstração; nenhuma alteração em domínio ou `aionCoreAdapter` foi misturada neste marco. Entregue no commit `180f309`.

---

## V5-02 a V5-05 — Core real, catálogo/equipe, colaboração e retomada com CLIs reais

**Estado**: **Bloqueado por ambiente externo** (comprovado sem `AionCore v0.2.2`, `codex` ou `antigravity` neste sandbox); **política de fechamento de aba (V5-05.4) implementada na UI e documentação**.

### Verificação exata do ambiente (17/11/2026)
Comandos executados neste sandbox Linux:
- `command -v aioncore` → não encontrado (`exit 1`)
- `command -v aionui` → não encontrado (`exit 1`)
- `command -v codex` → não encontrado (`exit 1`)
- `command -v antigravity` → não encontrado (`exit 1`)
- `.env.local` → `false` (ausente)
- `fetch('http://127.0.0.1:25808/health')`, `fetch('http://127.0.0.1:25818/health')`, `fetch('http://127.0.0.1:25808/api/health')` → todos `ECONNREFUSED`.

### O que foi entregue no trabalho independente (`V5-05.4`)
- Registrada na UI (**Configurações → Conexão AionCore Local → Política ao fechar a aba (v1)**) e na documentação (`README.md`, `docs/compatibility-matrix.md`) a regra transparente de que o navegador não executa daemon em segundo plano quando todas as abas fecham e que o estado já aceito pelo Core é reconstruído via catch-up sem reenviar pedidos concluídos.
- Mantidos intactos os contratos implementados em `src/services/aionCoreAdapter.ts` (`commit 503a8719`) e `4/4` testes com mocks fiéis; **nenhuma execução real foi simulada como comprovada**.

---

## V5-06 — Experiência de primeiro uso e operação diária

**Estado**: Concluído (interface e acessibilidade verificadas por TypeScript, testes unitários e E2E Chromium).

### O que mudou
1. **Guia inicial em 5 passos reais (`src/features/settings/SettingsView.tsx`)**:
   - Checklist **Preparação guiada para operação real** derivado exclusivamente do estado vivo do workspace (`coreReachability === 'reachable'`, `authStatus === 'authenticated'`, `catalogLoaded && availableModels.some(m => m.confirmed)`, `workspacePath && externalTeamId`, e primeiro `user_request` em modo Core), sem pré-preencher confirmação fictícia.
2. **Estados vazios acionáveis (`src/features/workspace/MessageStream.tsx`)**:
   - Em modo `aion_core` sem equipe vinculada (`!externalTeamId`), exibe orientação direta e botão **Configurar conexão e equipe**; com equipe vinculada, orienta o envio do primeiro pedido.
3. **Acessibilidade e detalhes técnicos preservados**:
   - Diagnósticos HTTP/WS mantidos em bloco expansível; blocos de código Markdown com rolagem horizontal (`MarkdownView.tsx`); modais com captura e restauração de foco (`Modal.tsx`); rascunhos/scroll preservados por conversa e aba (`WorkspaceContext.tsx`).

---

## V5-07 — Distribuição web local reproduzível

**Estado**: Concluído e testado em Linux (`Node v22.23.2`); confirmação nativa em PowerShell/Windows pendente localmente (CI Windows configurado em `V5-08`).

### O que mudou
1. **Servidor loopback independente (`scripts/vertice-server.mjs`, `npm start`)**:
   - Serve `dist/` com fallback SPA seguro sem `vite dev` nem `vite preview`.
   - Encaminha HTTP (`/health`, `/api/*`, `/login`, `/logout`, preservando cookies e `x-csrf-token`) e WebSocket (`Upgrade` em `/ws` com subprotocolos `Sec-WebSocket-Protocol` e troca de frames) para `VITE_AIONCORE_PROXY_TARGET`.
   - Recusa por padrão qualquer host não-loopback (`isLoopbackHost`, aceitando apenas `127.0.0.1`, `localhost`, `::1`).
2. **Launcher de ciclo de vida multiplataforma (`scripts/vertice-ctl.mjs`)**:
   - Comandos `npm run server:doctor`, `server:start`, `server:status` e `server:stop`.
   - Usa `detached: true` + `windowsHide: true`, logs em `.vertice/logs/`, e encerra **exclusivamente** o PID próprio gravado em `.vertice/server.json` (com verificação de porta via bind TCP real sem matar processos alheios).
3. **Auditoria de dependências e bundle (`package.json`, `vite.config.ts`)**:
   - Removidos offline 121 pacotes de template comprovadamente sem uso (`@google/genai`, `express`, `dotenv`, `motion`, `tsx`, `@types/express`).
   - Adicionado particionamento de chunks em `vite.config.ts` (`react-vendor`, `aion-core-gateway`, `demo-gateway`), eliminando todos os avisos de chunk `> 500 kB`.
4. **Integração testada (`src/services/__tests__/localServerProxy.test.ts`)**:
   - Recusa de host `0.0.0.0`, serviço estático + SPA fallback, proxy HTTP com `Set-Cookie`/`X-CSRF-Token`, túnel WS `/ws` real e spawn do processo filho `scripts/vertice-server.mjs` contra `dist/`.
   - Ciclo vivo executado na porta `45123`: `server:doctor` → `server:start` → `server:status` → HTTP `GET /` → `server:stop` → `server:status`.

---

## V5-08 — CI, documentação, changelog, matriz e preparo GitHub

**Estado**: Concluído para revisão/publicação pelo usuário; **release `v1.0.0` NÃO declarada** enquanto `V5-02` a `V5-05` aguardam validação com Core/CLIs reais.

### O que mudou
- Criado `.github/workflows/ci.yml` (Ubuntu Node 22/24 + Windows Node 24 para `lint`, `build`, `test` e `server:doctor`, mais job E2E Playwright em Ubuntu — explicitamente rotulado como CI de fixtures/navegador).
- Criados `CHANGELOG.md` e `docs/compatibility-matrix.md`.
- Atualizados `README.md`, `.env.example`, `docs/local-validation.md`, `docs/local-handoff.md` e este `docs/v5-progress.md`.
- Nenhum repositório remoto foi criado automaticamente; conta, nome do repositório e visibilidade serão definidos pelo usuário.
