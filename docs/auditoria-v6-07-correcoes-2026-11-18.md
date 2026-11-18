# Auditoria independente — V6-07 (conferência das correções) e liberação do V6-08

Data: 18/11/2026. Fonte: `C:\llm\vertice-workspace`. Commit auditado: `68dfb73` ("complete UI finishing, guided first-use setup, copy-mode fix, and startup revalidation", 33 arquivos). Árvore de trabalho limpa (`git status -s` vazio).

**Parecer: os três achados da auditoria do V6-07 estão corrigidos e verificados de forma independente. O V6-08 está liberado.** Não identifiquei defeito nesta rodada. Fica um item de higiene de evidência ([P3]) e uma limitação de verificação declarada no fim.

## Conferência dos achados anteriores

| Achado | Situação | Verificação independente |
|---|---|---|
| [P1] `Importar como cópia` derrubava a sessão Core viva | **Corrigido** | O ramo `copy` deixou de chamar `sanitizeLoadedStateAfterReload()` sobre `currentState` (`exportService.ts:837-843`) e `detachExternalBindingsFromProjection()` passou a converter conversas `running` em `paused_queue`/`paused_demo` com `autoPlayWasRunning: false` (`:139-150`). Probe próprio: **8/8 verificações** de importação aprovadas (demo e aion_core). |
| [P2] Checklist reiniciava a cada reload sem re-verificação | **Corrigido** | `probeCoreSessionOnStartup()` (`WorkspaceContext.tsx:66-83`) revalida `/health` → `/api/auth/status` → catálogo (somente se autenticado) no carregamento em modo `aion_core`, com guarda `shouldContinue()` entre etapas e falha silenciosa. Probe próprio: **5/5 verificações** de comportamento aprovadas. Nota na UI presente (`SettingsView.tsx:233-235`). |
| [P3] Entrega sem commit | **Corrigido** | Commit `68dfb73` com código, testes, pareceres e as 11 capturas + `v607_report.json` de `docs/screenshots/v6-07/`. Árvore limpa. |

## Verificação independente

Runtime: **Node v24.11.0**.

- `npm run lint` (`tsc --noEmit`): **aprovado**, 0 erros.
- `npm test`: **8 arquivos, 67/67 testes**, **5/5 execuções com código de saída 0** (determinismo mantido).
- `npm run build`: **aprovado** em 1,49s.
- `npm run test:e2e` (Chrome real, modo Demonstração): **aprovado — 1/1** (15,3s).
- Probe próprio das correções (`probe-v607-v3.mts`): **13/13 aprovados** — cópia preserva sessão viva, catálogo, `coreRuntimeStatus` e a conversa original; conversa importada desvinculada, pausada e sem autoexecução; `replace` continua forçando `coreSessionAuthenticated: false`; startup revalida na ordem correta, **não** sincroniza catálogo sem sessão autenticada, falha em silêncio com o Core fora do ar, aborta quando `shouldContinue()` vira falso e não faz nada sem `gateway.core`.
- Reexecução dos probes do V6-06 (33 verificações de reciprocidade, Receipts, `paused_queue`, `resume_queue` e poda FIFO): **todas verdes**, inclusive a que havia falhado (`copy` preservando a sessão viva) — a regressão do [P1] está sanada e nenhum invariante anterior foi quebrado.

## [P3] Evidência do repositório ficou desatualizada em relação ao comportamento entregue

O `docs/screenshots/v6-07/v607_report.json` commitado é o da rodada **anterior** à correção: ele registra `"afterReloadSteps": "2/5 etapas confirmadas"` e não contém a rodada de revalidação silenciosa. Quem ler o repositório conclude que o checklist ainda regride a 2/5, ao passo que o shipped behavior é 3/5 após reload — a própria nota de progresso (`docs/v6-progress.md:434`) declara essa defasagem de forma transparente, mas o artefato continua no repositório.

Recomendação: anexar o relatório JSON da rodada de revalidação silenciosa (ou uma nota de defasagem dentro do próprio `v607_report.json`), para que a evidência versionada corresponda ao código entregue.

## Limites desta verificação

Não alterei fontes da aplicação, configurações, dados de execução ou estado do Core. Não chamei Core, CLIs nem modelos; o E2E é o modo Demonstração. **Não reproduzi de forma independente a rodada real de revalidação silenciosa** (exige `aioncore.exe` + Chrome e já foi executada pelo executor): o comportamento foi verificado por probe unitário da função real (`probeCoreSessionOnStartup`) e por leitura do diff, o que cobre a lógica, mas não a integração com o Core real. As verificações automatizadas regeneraram artefatos locais de build/teste (`dist/`, `test-results/`, `.vitest/`, já ignorados pelo Git).

## Encaminhamento

- **V6-08 liberado.** Nenhum item bloqueante.
- Anexar ou versionar a evidência da rodada de revalidação silenciosa ([P3]).
- Permanecem no escopo do produto, sem reflexo sobre esta entrega: ciclo completo com Gemini/Antigravity, `Allow always` e promoção de modelo via `PATCH /model` aprovada ao vivo, e a validação do vínculo `team.childTurnStarted` ↔ `message.stream` em ambiente real.
