# Verificação independente — V6-05 — terceira rodada

Data: 18/11/2026. Fonte: `C:\llm\vertice-workspace`. Snapshot auditado: `aionCoreAdapter.ts` 09:13:31, `internalProtocol.ts` 09:06:15, `reducer.ts` 08:56:32 (18/11/2026).

**Parecer: a última entrega do executor está tecnicamente correta e aprovada.** Os dois achados da revalidação de 18/11 (P1 — correlação por omissão de `attemptId` após retentativas; P2 — `attemptId` com tipo/valor inválido) estão corrigidos nos fontes atuais, e a correção se sustenta sob reprodução independente, incluindo variantes não cobertas pela suíte do executor. Não identifiquei defeito residual que impeça a liberação de `V6-06`. Registro abaixo riscos residuais de operação, que são de degradação segura (revisão manual), não de falsa conclusão de negócio.

Este parecer é uma verificação independente e adicional à `auditoria-v6-05-2026-11-18-rodada2.md`, que já aprovou a mesma entrega.

## Escopo e método

- Li o retorno do executor (`docs/retorno-executor-v6-05.txt`), as três auditorias anteriores, `docs/v6-progress.md` e os fontes modificados (`aionCoreAdapter.ts`, `internalProtocol.ts`, `reducer.ts`, `taskRules.ts`, `internalProtocol.ts`).
- Inspecionei `correlateDeliveryReport()` (`:3568`), `correlateReviewDecision()` (`:3784`), `parseOptionalAttemptId()` (`:3521`), `isTurnPrecedingAttemptStage()` (`:3541`), `expectedDispatchByParticipant`/`consumedTurnBindings` (`:499`, `:508`) e o fluxo de `finalizeCoreAgentMessage()` (`:3115`).
- Escrevi probes próprios, fora do repositório, que exercitam o caminho real de finalização/parsing do adaptador (WebSocket simulado, `fetch` bloqueado, fila de despacho substituída por contador, persistência em memória) e o `ingestEvent` real do reducer. **Não reexecutei os probes do executor nem reexecutei cenários pagos a Core/CLI/modelos.**

## Validação independente

Runtime: **Node v24.11.0** (`C:\Users\joao.gonzales\AppData\Roaming\AionUi-Dev\aionui\runtime\node\node-v24.11.0-win-x64`). O Node padrão do terminal (`v20.18.1`) não atende ao `engines` do projeto e não foi usado.

- `npm run lint` (`tsc --noEmit`): **aprovado**, 0 erros.
- `npm test` (`vitest run`): **aprovado — 8 arquivos, 58/58 testes** (5,85s).
- `npm run build` (`vite build`): **aprovado** em 1,26s, 0 avisos de chunk > 500 kB.
- `npm run test:e2e` (Chrome instalado, `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`): **aprovado — 1/1** (9,7s). Modo Demonstração; não comprova integração real com provedores.

### Probes próprios — 30 verificações, todas aprovadas

**Correlação de entrega/parecer (21 verificações, `probe1.mts` + `probe2.mts`):**

| Cenário | Resultado esperado | Observado |
|---|---|---|
| Entrega da 1ª tentativa sem `attemptId` | aceita (compatibilidade) | `awaiting_review`, tentativa `delivered` |
| Parecer `rejected` da 1ª tentativa sem `attemptId` | cria tentativa 2 | 2 tentativas, `running`, `qualityRejectionCount = 1` |
| Reentrega antiga sem `attemptId` no turno antigo | não entrega a tentativa 2 | `invalid`, sem mutação, sem despacho |
| Reentrega antiga sem `attemptId` e sem turno | ambígua → manual | `invalid`, sem mutação |
| Reentrega antiga com `attemptId` explícito da tentativa 1 | rejeitada | `invalid`, sem mutação |
| Parecer `rejected` antigo sem `attemptId` | não penaliza | contador em 1, 1 parecer, 0 escalonamento, 0 despacho |
| Parecer `rejected` antigo sem `attemptId`/turno | não penaliza | idem |
| Parecer `approved` antigo sem `attemptId` | não conclui | `running`, 1 parecer |
| Entrega válida da tentativa 2 com `attemptId` | aceita + despacha auditoria | `delivered`, +1 despacho |
| Parecer sem `attemptId` sem vínculo de turno (2 tentativas) | ambíguo → manual | `invalid`, sem mutação |
| Parecer sem `attemptId` em turno divergente | rejeitado | `invalid`, sem mutação |
| Parecer sem `attemptId` com turno comprovado (`team.childTurnStarted`) | conclui a tarefa | `completed`, tentativa `approved` |
| Reentrega do mesmo parecer | idempotente | 2 pareceres, 0 despacho novo |
| Parecer conflitante (`rejected`) sobre tentativa já aprovada | rejeitado | `invalid`, revisão preservada |
| `attemptId` inválido: `123`, `{}`, `[]`, `null`, `""`, `"   "` (entrega e parecer) | sem exceção, `invalid`, sem mutação | 12/12 aprovados; estado de negócio idêntico antes/depois |

**Agregação de estado no reducer (9 verificações, `probe3.mts`):**

| Cenário | Esperado | Observado |
|---|---|---|
| A bloqueada (teto) + B `queued` dependente | `blocked` | `blocked` |
| A bloqueada + B `queued` independente | `running` | `running` |
| A isolada bloqueada | `blocked` | `blocked` |
| Cancelamento isolado | `idle` (tentativa `interrupted`) | `idle` |
| Cancelamento com dependente `queued` | `blocked` | `blocked` |
| Cancelamento com independente `queued` | `running` | `running` |
| Falha operacional com dependente `queued` | `failed` (`operationalFailureCount = 1`) | `failed` |
| Cadeia A→B→C com A bloqueada | `blocked` | `blocked` |
| B com escalonamento pendente + A bloqueada | `blocked` | `blocked` |

## Riscos residuais (não bloqueiam)

1. **Degradação segura em caminhos sem `turn_id`.** `finalizeCoreAgentMessage()` é chamado sem `turnId` em dois caminhos reais: caixa de entrada/mailbox (`aionCoreAdapter.ts:1655`) e recuperação `catchup.slot_messages` (`:6408`). Em tarefa com histórico de retentativas, uma entrega/parecer chegando por esses caminhos e sem `attemptId` explícito é tratada como ambígua e vai a revisão manual — o fluxo para, mas **não conclui, não reprova e não penaliza**. Impacto prático limitado, porque o despacho instrui o agente a incluir `attemptId` (`internalProtocol.ts:95` e `:99`, alimentado por `composeCoreOutgoingContent()`), tornando o caminho explícito o padrão.
2. **O caminho "positivo comprovado" depende do Core.** A aceitação de omissão em retentativas exige `expectedDispatch.turnId === turnId`, e o `turnId` esperado é vinculado apenas em `team.childTurnStarted` (`:2668`), usando o `turn_id` do Core. Se o Core não emitir esse evento, ou se o identificador de `message.stream` divergir do de `childTurnStarted`, a prova de vínculo nunca se forma e toda omissão em retentativa cai em revisão manual. Falha no sentido seguro; convém confirmar esse vínculo em um ciclo real quando o V6-06 puder executar cenários pagos.
3. **Um despacho pendente por participante e conversa.** `expectedDispatchByParticipant` guarda um único despacho por par conversa/participante. Um `team.childTurnStarted` fora de contexto pode vincular um turno irrelevante ao despacho pendente e produzir rejeição por "turno divergente" de uma entrega legítima — falso negativo seguro, sem mutação de negócio.
4. **Crescimento sem poda.** `consumedTurnBindings` (`:508`) registra todo turno consumido e não tem expiração; cresce durante a vida do adaptador. Impacto de memória, não de correção.
5. **Impossibilidade de detectar obsolescência de conteúdo.** Com o ID explícito, a correlação é exata; com omissão, a prova disponível é o turno. Um envelope antigo reemitido dentro do turno de despacho corrente seria aceito como pertencente à tentativa atual. É o limite aceito pela orientação de "prova de pertencimento ao despacho/tentativa esperados".
6. **Higiene da entrega.** Todo o V6-05 permanece **não commitado**: o repositório tem apenas o commit inicial (`1229ebb`) e as correções existem na árvore de trabalho. Não há checkpoint entre as rodadas de auditoria e o `CHANGELOG.md` não foi atualizado para o V6-05. Recomendo commit da entrega aprovada antes de iniciar o `V6-06`, para que a base aprovada seja rastreável.
7. **Duas cadeias de auditoria ativas em paralelo.** Durante esta verificação, outra sessão escreveu `docs/auditoria-v6-05-2026-11-18-rodada2.md` (09:22) e acrescentou uma nota histórica ao parecer anterior. Os **fontes não mudaram** durante a auditoria (última alteração 09:13:31), portanto esta verificação vale para o mesmo snapshot aprovado. Recomendo uma única cadeia de auditoria a partir daqui para evitar pareceres concorrentes sobre snapshots diferentes.

## Encaminhamento

- Os dois achados da revalidação de 18/11 estão encerrados, com evidência independente.
- **V6-06 pode ser iniciado** com a entrega atual.
- Itens recomendados antes ou durante o `V6-06`: (a) commit da entrega aprovada; (b) confirmar em um ciclo real o vínculo `team.childTurnStarted` ↔ `message.stream` (`turn_id`) para sustentar o caminho de omissão em retentativas; (c) atualizar `CHANGELOG.md`; (d) decidir a poda de `consumedTurnBindings`.
- Permanece no escopo do produto, sem reflexo sobre esta entrega: validação completa do ciclo com Gemini/Antigravity, exercício de `Allow always` e a promoção de modelo com `PATCH /model` aprovada ao vivo.

## Limites desta verificação

Não alterei fontes da aplicação, configurações, dados de execução ou estado do Core. Não chamei Core, CLIs nem modelos; o E2E executado é o modo Demonstração. As verificações automatizadas regeneraram artefatos locais de build/teste (`dist/`, `test-results/`, `.vitest/`, já ignorados pelo Git). Os probes próprios permanecem fora do repositório, em `C:\Users\joao.gonzales\AppData\Local\Temp\v605-audit` (`probe1.mts`, `probe2.mts`, `probe3.mts`), e são reexecutáveis com Node 24 + `C:\llm\aion-desk\node_modules\tsx\dist\cli.mjs`.
