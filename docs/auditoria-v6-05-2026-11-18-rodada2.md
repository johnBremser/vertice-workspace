# Revalidação independente — V6-05 — segunda rodada

Data: 18/11/2026. Fonte: `C:\llm\vertice-workspace`.

**Parecer: ajustes aprovados no escopo desta revisão; liberado o início do V6-06.** Não identifiquei impedimento remanescente nos dois achados da revalidação anterior. Este parecer sucede a orientação de pausa de `auditoria-v6-05-2026-11-18.md`.

## Correções conferidas

- **P1 — saída antiga sem attemptId:** os correlacionadores agora recebem o turno, consultam vínculos consumidos e histórico de eventos e, em retentativas, exigem vínculo com o despacho esperado. Repeti as três reproduções que falharam: entrega antiga, reprovação antiga e aprovação antiga. Nenhuma alterou a tentativa nova, os contadores, os escalonamentos ou a fila de despacho. Mensagens incompatíveis foram registradas como `invalid` e projetadas para revisão manual.
- **P2 — attemptId inválido:** o parser rejeita número, objeto, array, `null`, string vazia e espaços. Repeti todos esses valores em entrega e parecer: nenhuma exceção, mensagem final preservada como `invalid`, tarefa e fila de despacho preservadas. Os correlacionadores também possuem proteção defensiva antes de usar métodos de string.
- **Compatibilidade:** primeira tentativa sem ID continua funcionando. Conferi entrega e aprovação da segunda tentativa sem ID quando vinculadas a `team.childTurnStarted`, além da idempotência das duplicatas desses dois resultados. Os caminhos válidos com ID explícito permanecem cobertos pela suíte.
- **Correções anteriores:** reexecutei as seis reproduções da primeira auditoria. IDs explícitos inexistentes e parecer de tentativa antiga permanecem rejeitados; bloqueio com dependente `queued` mantém a conversa em `blocked`.

## Validação independente

Runtime: **Node v24.22.1**, dentro das versões exigidas pelo projeto.

- `npm run lint`: aprovado.
- `npm test`: **8 arquivos, 58/58 testes aprovados**, 7,12s.
- `npm run build`: aprovado, 1,39s.
- `npm run test:e2e`, usando o Chrome instalado: **1/1 aprovado**, 12,3s.
- Probe externo adicional: **23 verificações aprovadas** — nove combinações de saída antiga com turno antigo/desconhecido/ausente, 12 combinações de tipo/valor inválido, um fluxo positivo de entrega/revisão com turno vinculado e suas duplicatas, e uma verificação histórica sem o mapa de turnos consumidos.

As verificações adicionais usam estado descartável, persistência isolada, rede proibida e contagem da fila em background. As saídas passam pelo parsing e pela finalização normal do adaptador; os eventos de início de tentativa reproduzem os campos emitidos pelo despacho da aplicação. O teste histórico sem o mapa de turnos consumidos é uma verificação isolada da proteção pelo log, não um teste completo de recuperação após reinício.

## Evidências reproduzíveis

- Probe: `C:\Users\joao.gonzales\.codex\visualizations\2026\11\18\01a1ee85-3b5d-7880-b445-1634458321b9\revalidacao-v605-rodada2.mts`.
- Resultados: `C:\Users\joao.gonzales\.codex\visualizations\2026\11\18\01a1ee85-3b5d-7880-b445-1634458321b9\revalidacao-v605-rodada2-resultados.json`.
- Probe original também reexecutado: `C:\Users\joao.gonzales\.codex\visualizations\2026\11\16\01a1e5b9-442a-7c63-83db-da4629b6a0d2\audit-v605-correlation.mts`.
- Execução com Node 24 e carregador existente `C:\llm\aion-desk\node_modules\tsx\dist\cli.mjs`, passando o caminho do probe. Os imports examinam os fontes atuais de `vertice-workspace`.

## Encaminhamento e limites

Os achados pendentes desta revisão estão encerrados. O executor pode registrar a aprovação no progresso e seguir para V6-06. Não iniciei essa etapa nem alterei os fontes da aplicação.

Esta aprovação é das correções e regressões locais examinadas. O E2E executado usa Demonstração; não repeti chamadas reais a Core, CLIs ou modelos. A validação completa da combinação pretendida com Gemini e as demais limitações já documentadas permanecem no escopo do produto; não são dadas como concluídas por esta revisão.
