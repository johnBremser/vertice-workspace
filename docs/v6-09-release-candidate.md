# Validação Integrada e Candidata Funcional — Vértice Workspace (`V6-09`)

Data: 18/11/2026 · Base: commits `40f39f8` (`V6-00..V6-06`), `68dfb73` (`V6-07`), `a1f7dd4` (`V6-08`) + endurecimentos finais de candidata V6-09.

---

## 1. Versões e ambiente observados

| Componente | Versão / Identificador | Papel na candidata |
| :--- | :--- | :--- |
| **Aplicação** | `aion-desk@0.4.0` (marca **Vértice Workspace**) | Frontend React 19 + TypeScript + Tailwind v4 |
| **Node.js** | `v24.11.0` (`^22.12.0 \|\| ^24.0.0 \|\| >=26.0.0`) | Runtime do build, `vertice-server.mjs` e `vertice-ctl.mjs` |
| **AionCore Local** | `v0.2.2` (`aioncore.exe`, commit ref. `503a8719`) | Gateway WebUI local HTTP/CSRF/WebSocket (`127.0.0.1:25828`) |
| **Codex CLI** | `0.169.0-alpha.11.1` (modelo confirmado `gpt-5.6-luna`) | Provedor principal aprovado para múltiplas sessões e coordenação |
| **Cursor CLI** | `cursor-agent` (`composer-2.5`) | Provedor validado em ciclo real multi-agente + auditoria (`V6-04`/`V6-05`) |
| **Antigravity CLI** | `agy.exe 1.5.9` (`gemini-3.8-flash-low`) | Validado em continuidade pós-reinício (`V6-02`); ciclo completo de 3 tarefas opcional pendente |
| **Navegador** | Google Chrome real (Playwright `1.65.1`) | Desktop (`1440×900`, `1024×768`), mobile (`390×844`), claro/escuro |

---

## 2. Verificações executadas na candidata final (`Node v24.11.0`)

| Verificação | Comando | Resultado | Escopo |
| :--- | :--- | :--- | :--- |
| **Tipos TypeScript** | `npm run lint` (`tsc --noEmit`) | **0 erros** | Todo o projeto (`src/`, `e2e/`, scripts tipados) |
| **Suíte unitária / contrato / benchmark / launcher** | `npm test` (`vitest run`) | **8 arquivos / 70/70 testes aprovados** (8,91s) | Inclui payloads reais sanitizados `coreV022RealPayloads.ts`, ACL NTFS Windows via `icacls`, `ECONNRESET`/symlink/proxy e 2.000 eventos |
| **Build de produção** | `npm run build` (`vite build`) | **OK (1,82s)** | Bundle em chunks em `dist/` (`0` alertas > 500 kB) |
| **Playwright E2E** | `npm run test:e2e` | **1/1 aprovado (12,4s)** | Chrome real (`e2e/aion-desk.spec.ts`, modo Demonstração) |
| **Status do launcher** | `node scripts/vertice-ctl.mjs status` | **Parado (sem PID rastreado)** | Pós-execução com ambiente limpo |

---

## 3. Roteiro obrigatório V6-09 (itens 1 a 10 com evidências)

1. **Instalação limpa Windows e início pelo servidor de produção local**:
   - Extraído pacote limpo sem `node_modules/` e `dist/` (`npm ci --offline` com cache aquecido; rede documentada para máquina limpa em `README.md`), `.env.local` configurado para `http://127.0.0.1:25828`, `npm run build`, `npm run server:doctor` e `npm run server:start` em `127.0.0.1:4173`.
   - Evidência: `docs/screenshots/v6-08/v608_dist_report.json` (`V6-08`), `src/services/__tests__/verticeLauncher.test.ts` (5/5, incluindo ACL `icacls /inheritance:r` no `.vertice/server.json`) e `src/services/__tests__/localServerProxy.test.ts` (6/6).
2. **Core / autenticação / modelos reais**:
   - WebUI `aioncore.exe v0.2.2` com login real (`/login`, cookie `HttpOnly` + CSRF), descoberta real em `/api/agents/management` e `/api/assistants` (`gpt-5.6-luna`, `composer-2.5`, `gemini-3.8-flash-low`) e alteração/promoção real via `PATCH /api/teams/:id/agents/:slot_id/model`.
   - Evidência: `docs/v6-progress.md` (`V6-01`, `V6-03`, `V6-07`, `V6-08`), `src/services/__tests__/fixtures/coreV022RealPayloads.ts` e teste `V6-09` em `aionCoreAdapter.test.ts`.
3. **Duas sessões do mesmo CLI e envio `Geral` / individual isolados**:
   - Equipes com múltiplos slots Codex independentes (`slot_id`, `externalConversationId` e `nativeSessionId` próprios), envio isolado pela `Geral` e por aba individual.
   - Evidência: `docs/v6-progress.md` (`V6-02`, `V6-04`, `V6-06`: cadeias reais de IDs de 3 slots Codex) e asserções multi-conversa/slot em `aionCoreAdapter.test.ts`.
4. **Três tarefas com dependência, diff real e auditoria**:
   - Ciclo completo de 3 tarefas dependentes no repositório sandbox real (`v6-04-sandbox-repo`, Codex + Cursor) com `git diff` real e auditoria independente por `Sol Auditor`.
   - Evidência: `docs/v6-progress.md` (`V6-04`) e logs do Core (`2026-11-18.aioncore.log`).
5. **Reprovação/correção, permissão recusada e saída inválida**:
   - Recusa real de permissão (`POST .../confirm` com `reject` não criando o arquivo recusado em disco), reprovação → correção → reauditoria aprovada, saída sem bloco `aion-desk-json` encaminhada para revisão manual sem auto-conclusão.
   - Evidência: `docs/screenshots/v6-05/` (13 PNGs + `v605_live_report.json`), `docs/auditoria-v6-05-2026-11-18-rodada2.md` e `aionCoreAdapter.test.ts`.
6. **Interrupção suportada, falha operacional e limites de tentativa**:
   - Interrupção real via `POST .../cancel` confirmada por `team.childTurnCancelled`, separação entre falha operacional e qualidade, e teto `MAX_CORE_TASK_ATTEMPTS=3` + desbloqueio/bloqueio consistente de dependências.
   - Evidência: `docs/v6-progress.md` (`V6-05`) e regressões P1/P2 em `aionCoreAdapter.test.ts`.
7. **Reconexão/reload, catch-up parcial e retomada sem duplicação**:
   - Reload durante execução → `paused_queue` (`postsDeltaOnReload: 0`) → `Reconciliar agora` (`afterReconcilePostsDelta: 0`) → `Retomar fluxo` (`1` único POST sem repetir pedido), além de queda `HTTP 502` e reconexão ao Core sem perder dados e revalidação silenciosa no reload (`probeCoreSessionOnStartup`).
   - Evidência: `docs/screenshots/v6-06/` (`v606_paused_after_reload.png`, `v606_reconciled_before_resume.png`, `v606_resumed_completed.png`), `docs/screenshots/v6-08/v608-upstream-outage-502.png` e `workspace.test.ts`.
8. **Contexto versionado e recibos com evidência correspondente**:
   - Semântica monotônica estrita (`pending_send` → `sent` → `received` → `applied` / `failed_needs_action`), preservação de revisão `v2` em `pending_send`, e comprovação real em disco (`ctx.txt`).
   - Evidência: `docs/screenshots/v6-06/v606_live_report.json` e `aionCoreAdapter.test.ts`.
9. **Backup/restauração e reinício preservando dados**:
   - Exportação JSON sem credenciais (`coreSessionAuthenticated`/cookies ausentes), importação `copy` preservando sessão viva (`[P1]` V6-07 corrigido) e `replace` desconectando vínculos externos, além de `server:stop → rebuild → server:start` preservando IndexedDB e banco do Core (`5/5` pós-reinício).
   - Evidência: `docs/screenshots/v6-06/v606_backup_import_preview.png`, `docs/screenshots/v6-08/v608-after-restart-5of5.png` e `v4DomainAndMigration.test.ts`.
10. **Desktop/mobile, claro/escuro e teclado**:
    - Sem overflow horizontal (`overflow: false`) em `1440×900`, `1024×768` e `390×844` (claro e escuro), abas por teclado (`ArrowRight`/`Home`), `Esc` no drawer/modal, menus agrupados (`Simulação`) e IDs técnicos em `<details>`.
    - Evidência: `docs/screenshots/v6-07/` (11 PNGs + `v607_report.json`) e `e2e/aion-desk.spec.ts`.

---

## 4. Distinção explícita: prontidão funcional × publicação × release `v1.0.0`

- **Prontidão funcional local (aprovada na combinação suportada)**: a combinação **`AionCore v0.2.2` + `Codex CLI (gpt-5.6-luna)` multi-sessão + `Cursor (composer-2.5)` em Windows 11 (`Node v24.11.0`)** opera ponta a ponta via servidor loopback estático (`127.0.0.1:4173`), com todos os 10 casos essenciais comprovados e sem defeitos abertos que causem perda de dados, encerramento de processo alheio, quebra de isolamento, despacho duplicado ou conclusão falsa.
- **Limitações conhecidas aceitas na matriz**:
  1. **Antigravity (`agy.exe`)**: continuidade pós-reinício comprovada (`V6-02`), enquanto a repetição completa de 3 tarefas dependentes com esse provedor opcional permanece pendente (documentado em `docs/compatibility-matrix.md`).
  2. **ACL de `.vertice/server.json` no Windows**: `restrictPrivateFileAcl()` remove permissões herdadas via `icacls /inheritance:r` deixando acesso apenas ao usuário proprietário; processos locais do *mesmo* usuário do Windows permanecem na mesma fronteira de confiança na v1 sem conta de serviço dedicada ou DPAPI.
  3. **`ConfirmRequest.always_allow`**: mantido conservadoramente em `always_allow: false` por segurança na v1.
  4. **Execução interativa nativa em Linux**: coberta pela suíte Vitest multiplataforma e workflow CI (`ubuntu-latest`); validação contra binário Core em host Linux real fora deste desktop Windows depende de ambiente Linux correspondente.
- **Publicação (`V6-10`) e release `v1.0.0`**: **ainda não publicadas / não declaradas**. A etapa **V6-10** tratará da preparação/publicação em repositório GitHub remoto, revisão final de documentação e checagem da CI remota antes de qualquer tag ou declaração de release.
