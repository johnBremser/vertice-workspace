# Revalidação do novo ZIP — Aion Desk / plano v3

Data: 16/11/2026. Código examinado: `C:\llm\aion-desk`, arquivos do ZIP atualizados por volta de 16:16.

## Parecer

As correções descritas pelo Hydrogen estão presentes e corrigem as reproduções originais. A instalação deixou de exigir o contorno `--legacy-peer-deps`, a suíte passou com 18 testes, o TypeScript passou e o build foi produzido.

Ainda há quatro falhas nos limites desses mesmos fluxos. Duas foram reproduzidas também na interface do navegador. Recomendo corrigir os itens 1 e 2 antes do aceite funcional e incluir os demais na mesma rodada, sem reestruturar o projeto.

## Verificações concluídas

- Instalação: `npm exec --yes --package=node@24 -- node "C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js" install --ignore-scripts --no-audit --no-fund --package-lock=false`. Passou sem `ERESOLVE` e sem `--legacy-peer-deps`. Foi executada no diretório que já continha `node_modules` da primeira revisão; não foi um teste de instalação em pasta inteiramente vazia.
- Suíte entregue: dois arquivos, **18/18 testes passaram**, usando Node 24.
- TypeScript: `tsc --noEmit`, passou usando Node 24.
- Build Vite: passou usando Node 24. Persistiu apenas o aviso do Vite sobre uso de `__dirname` com um futuro carregador de configuração.
- Reproduções adicionais: [script](./aion-desk-revalidation.mts) e [resultados JSON](./aion-desk-revalidation-results.json). Foram feitas 16 verificações observacionais; as 12 repetições dos problemas originais passaram, quatro verificações adicionais falharam.
- Navegador Chrome: validada a estabilidade da seleção de conversa após envio, novidades zeradas na aba aberta, navegação para o registro de execução `evt_007` e bloqueio da permissão principal pendente. Também reproduzidos os itens 1 e 2 abaixo.

## Correções anteriores confirmadas

- A seleção passa pelo gateway e não é revertida após enviar mensagem.
- A resposta na aba ativa do participante não volta a incrementar seu contador.
- A permissão `perm_test_suite_1` pendente ou recusada bloqueia o passo correspondente.
- Escalonamento manual pendente bloqueia; dispensar a promoção mantém o perfil `fast`; limiar cinco não sugere promoção após duas reprovações.
- Avançar com lacuna não consome o índice do cenário. Reconciliar antes do reload recupera os eventos retidos e permite continuar.
- Snapshot antigo preserva eventos posteriores já aplicados.
- Contexto manual v2 seguido do roteiro gera versões `[1, 2, 3]`.
- Links de origem do cenário completo encontram registros renderizáveis nas abas de destino.
- Duas chamadas concorrentes de flush preservam a versão mais recente e terminam como `saved` no caso exercitado.

## Falhas restantes

### 1. P1 — A permissão do menu continua sendo ignorada pelo avanço

Fontes: [demoScenario.ts:655](C:/llm/aion-desk/src/services/demoScenario.ts:655), [demoScenario.ts:824](C:/llm/aion-desk/src/services/demoScenario.ts:824), [mockGateway.ts:1175](C:/llm/aion-desk/src/services/mockGateway.ts:1175).

O bloqueio adicionado verifica especificamente `perm_test_suite_1` no passo sete. O menu “Solicitar permissão simulada” produz outro pedido, com ID dinâmico. Sua recusa marca a conversa/participante como bloqueados, mas os passos seguintes do roteiro não consultam esse impedimento.

Reprodução na interface:

1. Avançar até a permissão principal, aprová-la e avançar até a primeira reprovação de qualidade.
2. Abrir “Mais controles de simulação” → “Solicitar permissão simulada”.
3. Recusar. O histórico registra execução bloqueada.
4. Clicar em “Avançar cenário”. A tentativa dois inicia mesmo com a recusa vigente.

Também reproduzido pelo gateway: `stepScenario` retorna sem `blocked` após recusar esse pedido.

Correção esperada: centralizar a verificação das permissões relevantes para a tarefa/tentativa antes de produzir eventos de execução. Aplicar a mesma regra ao avanço manual e automático, incluindo pedidos criados pelo menu. Não usar o ID fixo do roteiro como a regra de autorização.

### 2. P1 — Lacuna salva não pode ser reconciliada após reload

Fontes: [mockGateway.ts:56](C:/llm/aion-desk/src/services/mockGateway.ts:56), [mockGateway.ts:975](C:/llm/aion-desk/src/services/mockGateway.ts:975), [mockGateway.ts:1258](C:/llm/aion-desk/src/services/mockGateway.ts:1258), [WorkspaceContext.tsx:530](C:/llm/aion-desk/src/features/workspace/WorkspaceContext.tsx:530).

O evento futuro e o estado `gap_detected` são persistidos, mas o evento faltante fica exclusivamente no mapa em memória `heldBackMissingEvents`. Recarregar recria o gateway e perde esse mapa. Reconciliar devolve zero eventos, mantém a lacuna e deixa o cenário bloqueado.

Reprodução em Chrome: criar lacuna pelo menu, aguardar “Salvo”, recarregar e clicar em “Reconciliar agora”. O resultado mantém a lacuna esperando seq 25, enquanto a interface exibe em verde “Reconciliação concluída (0 evento(s) faltante(s) ...)”.

O teste com storage em memória compartilhado entre dois gateways reproduziu o mesmo resultado, sem depender do navegador.

Correção esperada: persistir o histórico autoritativo da simulação ou permitir reconstruir deterministicamente os eventos faltantes após recarga. A resposta de reconciliação e a mensagem da interface precisam refletir se `syncState` ficou efetivamente `synced`. Manter os eventos existentes e evitar exigir reinício completo como recuperação normal.

### 3. P2 — Aba lembrada de conversa oculta suprime novidades

Fontes: [mockGateway.ts:158](C:/llm/aion-desk/src/services/mockGateway.ts:158), [mockGateway.ts:978](C:/llm/aion-desk/src/services/mockGateway.ts:978).

`activeTabByConversation` registra a última aba visitada em cada conversa. O gateway a trata como visível ao ingerir eventos, inclusive quando outra conversa está ativa.

Reprodução pelo serviço: abrir Claude na conversa A, criar/selecionar B e entregar uma mensagem/resposta para Claude em A. O contador em A continua zero, embora a mensagem tenha chegado fora da visão ativa.

Correção esperada: considerar uma aba ativa para leitura somente quando sua conversa também for `state.activeConversationId`. Aplicar a verificação à ingestão, reconciliação e cenário de carga.

### 4. P2 — A fila pode terminar gravada, mas continuar indicando “Salvando”

Fonte: [storage.ts:266](C:/llm/aion-desk/src/services/storage.ts:266), [storage.ts:280](C:/llm/aion-desk/src/services/storage.ts:280), [storage.ts:287](C:/llm/aion-desk/src/services/storage.ts:287).

A serialização corrige a sobreposição, porém o loop consome a escrita nova antes de expirar seu debounce. Como `saveTimer` ainda existe, o teste de conclusão não emite `saved`. Quando o timer finalmente chama `flushSave`, não existe escrita na fila e a função retorna sem atualizar o status.

Reprodução com `StorageDriver` controlado: iniciar gravação A lenta; chamar `scheduleSave(B)` durante A; concluir A e deixar o loop gravar B; chamar flush para simular o disparo do timer. O estado mais recente está gravado, mas `getInfo().status` permanece `saving`.

O teste novo da entrega usa debounce zero e não cobre esse encadeamento. Esta reprodução verifica a máquina de estados do gerenciador com driver controlado; não é uma medição de concorrência do IndexedDB real.

Correção esperada: ao consumir a fila dentro do loop, cancelar/conciliar o debounce pendente e concluir a geração mais recente como salva quando não houver trabalho pendente. Preservar a proteção contra gravações antigas.

## Ajuste adicional de requisitos

[package.json:40](C:/llm/aion-desk/package.json:40) e o README aceitam Node 20.19, mas o `vitest@5.1.0` instalado declara `engines.node: ^22.12.0 || ^24.0.0 || >=26.0.0` em `node_modules/vitest/package.json`.

O conflito esbuild/Vite está corrigido. Ainda convém alinhar a versão de Node documentada à cadeia completa de ferramentas e ao lockfile adotado. Toda a validação positiva desta revisão usou Node 24; Node 20.19 não foi executado nesta rodada.

## Escopo funcional posterior

Esta rodada corrige o protótipo. Ela não implementa o catálogo de participantes configuráveis, modelos reais ou a equipe Terra/Sol/Gemini discutida na conversa: `DemoModelTier` continua `fast | review | advanced`, e `ParticipantRole` continua `coordinator | executor | reviewer`, em [types.ts:1](C:/llm/aion-desk/src/domain/types.ts:1). A integração com o AionCore continua desconectada, conforme o escopo original do v3.

Nenhum arquivo-fonte, manifesto ou lockfile foi alterado durante a revisão. Foram atualizados `node_modules` e `dist`, criados dados de teste na origem local do preview e gravados os artefatos desta pasta.
