# Melhoria futura — worker local de orquestração

Status: proposta para avaliação futura, sem implementação nesta etapa.  
Data: 25/11/2026.

## Objetivo

Adicionar um worker local que permita acompanhar e dar continuidade aos fluxos autorizados do Vértice Workspace sem depender de uma aba do navegador aberta.

O worker deverá manter a execução coordenada entre planejamento, execução e revisão, respeitando dependências, pausas, permissões e intervenções do usuário.

A continuidade dependerá de o computador, o worker, o AionCore e as CLIs necessárias permanecerem disponíveis.

## Contexto técnico

Em `src/services/aionCoreAdapter.ts`, foram observados:

- `backgroundDispatchChain`: cadeia de promessas mantida em memória.
- `enqueueBackgroundWork`: encadeia operações e registra falhas de orquestração.
- `dispatchNextRunnableTaskInCore`: realiza o despacho de tarefas elegíveis.
- `applyStructuredDeliveryReport` e `applyStructuredReviewDecision`: processam entregas e decisões de revisão.

Esses elementos são pontos de partida para estudar a separação da orquestração. Sua existência não comprova continuidade quando a interface é encerrada.

A proposta é avaliar um processo local independente do navegador. A tecnologia, a persistência e os contratos desse processo ainda precisam ser definidos.

## Comportamento esperado

Depois que o usuário iniciar um fluxo autorizado, o worker deverá:

1. Acompanhar eventos e resultados do AionCore.
2. Registrar o progresso de forma durável.
3. Identificar tarefas com dependências atendidas.
4. Despachar trabalho elegível e encaminhar entregas para revisão.
5. Interromper o avanço quando houver pausa, bloqueio, permissão pendente ou necessidade de intervenção.
6. Disponibilizar o estado atualizado quando a interface for reaberta.

Fechar a aba deverá apenas desconectar a interface. Pausar ou cancelar uma execução deverá ser uma ação explícita, com resultado confirmado.

## Requisitos

### Responsabilidade pela orquestração

Definir uma única autoridade de despacho por conversa. Interface e worker não poderão iniciar simultaneamente a mesma tarefa.

Antes da implementação, mapear quais responsabilidades pertencem ao Vértice e quais já são executadas pelo AionCore.

### Persistência e recuperação

Persistir os vínculos necessários entre conversa, tarefa, tentativa, participante e execução no Core, além dos eventos processados e comandos pendentes.

Após reinício ou perda de conexão, reconciliar o estado com o Core antes de novos despachos. Preservar eventos recebidos durante a recuperação e rejeitar resultados antigos que não correspondam à tentativa atual.

### Proteção contra duplicação

Usar identificadores estáveis, deduplicação e controle de concorrência.

Se uma comunicação falhar após o envio de um comando, verificar se o Core já o recebeu antes de tentar novamente. Um timeout não deverá ser interpretado automaticamente como ausência de execução.

### Permissões e isolamento

Preservar as permissões, o workspace e os limites definidos para cada conversa.

O worker não deverá ampliar autorizações, mudar silenciosamente o diretório de trabalho nem continuar tarefas pausadas ou canceladas.

Credenciais e tokens não deverão aparecer em logs ou backups de usuário.

### Operação e diagnóstico

Exibir na interface:

- Disponibilidade do worker e do AionCore.
- Última comunicação confirmada.
- Execuções em andamento.
- Motivos de pausa, bloqueio ou falha.
- Situações que exigem intervenção do usuário.

Distinguir falha do worker, indisponibilidade do Core e erro da CLI ou do provedor.

O worker não deverá ser apresentado como correção automática para falhas do agente upstream.

## Escopo inicial proposto

- Uma instância local de worker por ambiente do Vértice.
- Continuidade de fluxos previamente autorizados com a aba fechada.
- Persistência e reconciliação após interrupções.
- Comandos explícitos de pausa, retomada e cancelamento.
- Inicialização e encerramento integrados à operação local.

Agendamento de novos trabalhos, execução distribuída e operação em nuvem ficam para avaliações posteriores.

## Critérios de aceitação

1. Fechar e reabrir a aba durante uma tarefa preserva o histórico e não duplica o despacho.
2. Uma entrega recebida com a aba fechada permite encaminhar a revisão quando autorizada.
3. Reiniciar o worker provoca reconciliação antes de qualquer novo despacho.
4. Uma confirmação de envio perdida não causa reexecução automática.
5. Duas abas abertas não geram concorrência de orquestração.
6. Pausas, dependências e permissões continuam impedindo avanço indevido.
7. Resultados de tentativas anteriores não alteram a tentativa atual.
8. A interface distingue estado confirmado, informação desatualizada e recuperação pendente.
9. O fluxo completo é validado com AionCore e CLIs reais, além dos testes locais.

## Etapas para avaliação futura

1. Mapear a orquestração atual e os contratos disponíveis no Core.
2. Definir autoridade de despacho, persistência e recuperação.
3. Prototipar uma conversa com execução e revisão.
4. Validar fechamento da aba, reinícios e falhas de comunicação.
5. Planejar a migração e a compatibilidade com conversas existentes.

A implementação dependerá de decisão posterior. Este documento registra a melhoria e os requisitos para avaliá-la.