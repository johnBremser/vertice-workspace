# Plano v5 — do protótipo validado ao produto web local v1

> Histórico: a conclusão local agora segue `docs/implementation_plan_v6_local.md`, na pasta `C:\llm\vertice-workspace`. O v6 prevalece nos caminhos, baseline e instruções operacionais atuais.

Data: 17/11/2026. Destinatário: Hydrogen, executando localmente no Antigravity. Diretório atual: `C:\llm\aion-desk`.

## 1. Objetivo do produto

Entregar um workspace web para coordenar agentes de programação reais: o usuário escolhe projeto, participantes, conexões, modelos e papéis; apresenta um objetivo; acompanha plano, execução, auditoria, correções e resultado, com decisões e evidências rastreáveis.

O primeiro produto final é uma **v1 web de uso local**, para um usuário operando seus CLIs autenticados. A interface abre no navegador; o AionCore e os CLIs executam na máquina que contém o workspace. Ser web não elimina o runtime local nem permite ao JavaScript do navegador executar CLIs ou acessar caminhos arbitrários do Windows.

Não incluir nesta v1 SaaS multiusuário, cobrança, acesso público, hospedagem de CLIs na nuvem, sincronização entre computadores, marketplace, editor/terminal completos ou um substituto integral do AionUi. Esses itens exigem outro escopo.

## 2. Estado de partida e limites da evidência

A v4 está pronta para validação local. Na revalidação independente de 17/11: TypeScript e build aprovados; Playwright 1/1; Vitest 36/37 no Windows pela portabilidade de um import ESM no teste do proxy. Os dois grupos finais de erros de contrato foram corrigidos nas reproduções independentes. Ainda não existe comprovação de colaboração com Core e CLIs reais.

Preservar: separação UI/gateway/domínio/transporte, configurações por participante, histórico e rascunho por sessão, papéis configuráveis, protocolo interno estruturado, contexto versionado, permissões e escalonamento, deduplicação, catch-up, backup e distinção explícita entre simulação e execução real.

Os contratos de referência são AionCore v0.2.2, commit `503a87199eb978790ca77675b39c84b241535bf3`. Essa referência não prova que qualquer binário com o mesmo rótulo de versão tenha exatamente o mesmo conteúdo: registrar também procedência e hash do binário usado.

## 3. Arquitetura e responsabilidade do AionCore

Fluxo de execução: navegador React → HTTP/WebSocket de mesma origem → AionCore → sessões/CLIs → workspace local.

- **Nosso produto:** experiência web, configuração de equipe e papéis, objetivos, plano/tarefas/auditoria, contexto compartilhado, decisões humanas e apresentação das evidências.
- **AionCore:** runtime externo responsável pelas capacidades que efetivamente expõe: autenticação, catálogo, equipes, sessões, transporte de execução, mensagens e estado dos agentes. Confirmar cada capacidade em runtime.
- **CLIs:** mecanismos de agente autenticados, com os modelos e capacidades realmente disponíveis naquela máquina/conta.
- **AionUi:** referência de integração; sua interface não é dependência de execução deste produto.

Começar com o **backend oficial completo, sem fork ou redução de crates**, como processo separado. Consumir somente as APIs necessárias. Não incorporar os monorepos ao bundle, não copiar todo o AionUi, não recriar autenticação e não implementar um segundo lançador de CLIs no frontend.

Usar o Core integral como runtime não significa expor todos os seus recursos no produto. Uma lacuna comprovada pode justificar adaptação isolada ou extensão futura, com decisão registrada; não modificar o upstream preventivamente.

Definir uma única autoridade para despachar cada trabalho. O Core possui mecanismos próprios de equipes e o adaptador já interpreta planos/entregas. Verificar que não existam dois planejamentos ou despachos concorrentes para a mesma tarefa. Não presumir que exista uma opção para desligar a coordenação nativa: verificar o contrato real e escolher o fluxo compatível.

## 4. Marca e identidade

Identidade aprovada pelo usuário em 17/11/2026: **Vértice Workspace**. Slogan: **Seu time de agentes, do plano à entrega.** Assinatura técnica: **Powered by AionCore**. O produto tem identidade própria e utiliza o Core como motor; não se apresentar como produto oficial desenvolvido pela equipe do Aion.

A escolha de identidade está aprovada para esta implementação; não foi realizada validação de disponibilidade comercial. Aplicar a apresentação em `src/config/brand.ts`, título da página, interface, README e documentação de produto vigente, preservando documentos históricos como registro das etapas anteriores. A assinatura técnica pode aparecer em Sobre/Configurações e na documentação, sem competir com a marca principal.

Manter por enquanto diretório, nomes de banco IndexedDB, IDs, schema de exportação e envelope `aion-desk/v1`/bloco `aion-desk-json`. Trocar o texto da marca não justifica quebrar backups ou protocolos. Qualquer futura mudança técnica exige compatibilidade ou migração explícita.

Preservar atribuição ao Core e verificar os avisos de licença ao distribuir componentes. O Core consultado declara Apache-2.0; a seção 6 dessa licença distingue o uso do software do uso da marca. O nome do frontend não precisa reproduzir o nome do motor.

## 5. Sequência de implementação

### V5-00 — Baseline local e portabilidade

1. Ler os planos v3/v4 disponíveis, `docs/architecture.md`, `docs/aioncore-integration.md`, `docs/local-handoff.md` e este plano. Inspecionar arquivos existentes antes de alterar.
2. Preservar uma cópia identificável do estado de entrada. Como o diretório atualmente não é repositório Git, preparar baseline Git local com `.gitignore` revisado antes de mudanças relevantes. Não criar remoto ou publicar automaticamente nesta fase.
3. Usar uma instalação compatível existente de Node, preferencialmente 24, sem alterar globalmente o ambiente. npm e package-lock são canônicos.
4. Corrigir o import ESM do processo filho em `src/services/__tests__/viteProxyConfig.test.ts:106` com `pathToFileURL(...).href`. Não mascarar o problema excluindo o teste.
5. Registrar instalação, tipos, testes, build e E2E em `docs/v5-progress.md`. Não aumentar a quantidade de testes como objetivo em si.

Aceite: baseline recuperável e suíte atual verde no Windows, ou impedimento externo descrito com comando e erro exatos. A correção do teste não altera o comportamento do proxy.

### V5-01 — Atualização visual, antes da integração

Aplicar `docs/design/visual-refresh-v1.md` e usar `docs/design/workspace-reference.html` como referência de composição, não como código pronto para substituir o React.

Trabalhar em tokens e componentes existentes: `src/index.css`, `WorkspaceHeader`, `ProjectSidebar`, `AgentTabs`, `MessageStream`, `Composer`, `InspectorDrawer`, painéis de tarefas/contexto e Configurações. Não refatorar o domínio ou o adaptador junto com a mudança visual.

Prioridades: retirar a aparência de formulário administrativo; simplificar toolbar; dar protagonismo à conversa; separar mensagens de eventos; apresentar participantes com nome/papel/status legíveis; painel de trabalho contextual; temas claro/escuro completos; responsividade e teclado. Controles de demonstração vão para uma área secundária claramente identificada.

Aceite: screenshots reais claro/escuro em 1440×900, 1024×768 e 390×844; nenhuma ação existente perdida; permissão, falha, execução simulada/real e risco de perda de dados permanecem perceptíveis; Playwright existente verde. Acrescentar verificações apenas para comportamentos novos como abertura de painel no mobile.

Entregar este marco visual separadamente, com resumo e imagens comparáveis, antes de iniciar alterações de integração. Aplicar a identidade aprovada Vértice Workspace. Separar os marcos no histórico e nas evidências, mas continuar as etapas seguintes sem exigir nova autorização para o trabalho já descrito neste plano.

### V5-02 — Core real, ambiente e primeiro agente

1. Identificar binário instalado, versão, procedência, hash, configuração, dados, porta e diretório de trabalho do Core. Reutilizar a instalação compatível existente. Não atualizar o upstream durante o diagnóstico inicial.
2. Preparar início e encerramento reproduzíveis, sem depender do Electron/AionUi. Capturar `/health`, autenticação e conexão WebSocket reais pelo mecanismo oficial.
3. Configurar proxy de mesma origem em `.env.local`; nenhum segredo em variáveis VITE, IndexedDB ou backup. Registrar a URL estável usada pelo navegador, pois a persistência é vinculada à origem.
4. Descobrir agentes/assistants no Core e testar um único agente com uma mensagem simples. Registrar executável, autenticação efetiva e sessão criada; um health check do Core não valida autenticação do CLI.
5. Usar os contratos e comandos efetivamente observados. Para qualquer integração com o Codex, consultar fontes/documentação oficial ou instalação local, sem deduzir flags ou modelos pelo nome exibido.

Aceite: um agente real recebe pedido pela aplicação e responde na aba correta, com stream e conclusão observados, sem mock e sem editar manualmente o estado para aparentar conexão.

### V5-03 — Catálogo e equipe configurável reais

1. Validar separadamente Codex e Antigravity. A presença do Antigravity na máquina não prova que o Core o exponha como CLI/assistente utilizável. Se não houver contrato funcional, registrar o bloqueio específico; não criar um conector fictício ou substituir o executor sem explicitar a mudança.
2. Resolver IDs reais de assistentes e modelos por catálogo/configuração de sessão. Terra 6.1, Sol 6.1 e Gemini Hydrogen são preferências até confirmação efetiva.
3. Criar dois ou mais participantes pela mesma conexão Codex, comprovando sessões, IDs, histórico e destinatários independentes.
4. Validar equipe preferida: coordenador Terra, planejador/auditor Sol e executor Gemini pelo Antigravity. Também validar a variação com planejamento e auditoria em sessões distintas.
5. Mostrar capacidade desconhecida ou indisponível com motivo útil; não exibir controles operacionais que apenas simulam suporte.

Aceite: configuração pela interface, reload sem perda, conversa Geral roteada ao coordenador e mensagens individuais chegando exclusivamente à sessão esperada. A configuração suporta outros nomes, modelos e provedores.

### V5-04 — Colaboração real do pedido à entrega

1. Usar um pequeno repositório de teste, separado dos fontes do produto. Registrar estado inicial e permitir revisão das alterações antes de qualquer commit.
2. Executar objetivo → plano estruturado → tarefas/dependências → tentativa → entrega → auditoria → correção ou conclusão. Comprovar o envelope interno `aion-desk/v1` em saídas reais, sem transformar texto arbitrário em aprovação.
3. Testar três tarefas, incluindo duas relacionadas por dependência. No mesmo diretório de trabalho, serializar tarefas com escrita até existir isolamento comprovado. Não anunciar execução paralela segura só porque o domínio representa paralelismo.
4. Confirmar uma única cadeia de despacho por tarefa, sem dupla execução entre coordenação nativa do Core e pipeline do Desk. Registrar a responsabilidade efetiva num documento de decisão.
5. Validar auditoria real contra diff, arquivos e testes observados; não aceitar somente a afirmação do executor de que terminou. Preservar saída bruta e evidências correlacionadas.
6. Comprovar reprovação → nova tentativa → nova auditoria, saída estruturada inválida/incompleta → revisão manual, limites de tentativas e escalonamento por decisão humana. Não criar loops ilimitados.
7. Verificar que o recibo de contexto corresponde à etapa real: envio não prova recebimento nem aplicação pelo agente.

Aceite: alteração real verificável no repositório de teste, critérios atendidos e revisão rastreável, sem conclusão prematura ou decisões fabricadas. Cada tentativa preserva executor, modelo, contexto e resultado efetivamente utilizados.

### V5-05 — Permissões, controles e retomada

1. Capturar o comportamento real dos pedidos de autorização do Core/CLI. Separar aprovação de fluxo na aplicação de autorização nativa de ferramenta. Uma aprovação na UI não concede silenciosamente permissões adicionais no CLI.
2. Validar permitir/recusar, falha operacional, interrupção e pausa apenas onde houver suporte real. Pedido enviado e controle confirmado são estados diferentes. Recusa precisa produzir bloqueio efetivo no caminho que pretende controlar.
3. Testar queda de WebSocket, reload durante execução, expiração de sessão, Core indisponível/reiniciado e falha parcial de catch-up. Preservar eventos concorrentes e histórico, sem duplicar mensagens/tarefas.
4. Definir a política de fechamento da aba: na v1 o navegador não é um serviço persistente. Identificar o trabalho já aceito pelo Core e reconstruir o pipeline ao reabrir, sem reenviar etapas concluídas nem prometer que o navegador fechado continuará coordenando. Informar a limitação de forma clara. Execução autônoma contínua sem navegador exige avaliação de coordenação durável no backend em outro marco.
5. Validar backup/importação com dados reais sem credenciais e migração dos dados existentes. Não perder dados por mudança de marca, porta ou host sem orientação e recuperação.

Aceite: falhas deixam o sistema num estado compreensível e recuperável; o usuário consegue saber o que aconteceu, o que ainda executa e qual decisão é necessária. Reiniciar não equivale a disparar novamente a mesma tarefa.

### V5-06 — Experiência de primeiro uso e operação diária

1. Criar uma configuração inicial curta com passos reais: conectar runtime → verificar agentes → escolher workspace → montar equipe → primeiro pedido. Reutilizar componentes e serviços existentes, sem uma segunda configuração paralela.
2. Tirar endpoints, payloads e terminologia interna do fluxo principal; mantê-los em diagnóstico expansível. Exibir estado resumido do runtime e de cada sessão com ação de recuperação.
3. Projeto novo não deve parecer o cenário demonstrativo. Demonstração é opcional e claramente distinta. Não pré-preencher identidade de modelo como confirmada.
4. Revisar estados vazio, carregando, erro, permissão, revisão manual, sem conexão e conclusão. Dar ao usuário um próximo passo objetivo em cada caso.
5. Confirmar navegação por teclado, foco de modais/drawers, contraste, zoom, scroll de código, rascunhos e alternância de conversas. Manter funcionalidades úteis sem construir um IDE completo.

Aceite: numa origem limpa, realizar o primeiro pedido real seguindo a própria interface/documentação, sem editar JSON, abrir DevTools ou executar comandos não documentados.

### V5-07 — Distribuição web local reproduzível

1. A v1 precisa iniciar sem depender do servidor de desenvolvimento do Vite. Definir como servir `dist/` e encaminhar `/api`, `/health`, rotas de sessão e `/ws` para o Core numa origem estável. Verificar se o Core admite frontend externo antes de acrescentar um servidor/proxy mínimo separado. Não supor que `vite preview` aplique o proxy de desenvolvimento.
2. Fornecer comandos/scripts locais de diagnóstico, iniciar e encerrar com verificação de portas, processos e arquivos de configuração. Não encerrar processos alheios por nome; guardar e verificar os PIDs iniciados pelo próprio launcher. No Windows, auxiliares em background não devem abrir janelas visíveis sem necessidade.
3. Registrar versões suportadas, diretórios persistentes, logs, backup, atualização e rollback. Não incluir cookies, tokens, contas de teste ou dados pessoais no pacote.
4. Escutar em loopback por padrão. Acesso LAN/público, TLS e isolamento entre usuários são outro marco; não expor o Core na internet como efeito colateral da distribuição local.
5. Avaliar dependências herdadas e avisos do bundle com base em uso medido. Remover somente o que estiver comprovadamente sem uso; não transformar isso numa reescrita.

Aceite: instalação/extração limpa com comandos documentados inicia o build web e o Core, permite autenticação e um fluxo real, e encerra de forma controlada. Reinício preserva dados esperados. Registrar se o usuário precisa instalar/autenticar algum CLI separadamente.

### V5-08 — GitHub, qualidade contínua e release v1

Após comprovar o primeiro fluxo colaborativo real, publicar o repositório conforme conta/nome/visibilidade definidos pelo usuário. Não presumir repositório público. Preservar o histórico local do baseline, da atualização visual e dos marcos de integração.

- Revisar `.gitignore`, exemplos de configuração, dados locais, arquivos gerados e atribuições. Não incluir binários/caches/históricos desnecessários.
- Configurar CI para tipos, testes e build no Node suportado, com verificação Windows do teste de portabilidade e E2E conforme viabilidade do runner. CI usa fixtures; testes com CLIs autenticados ficam identificados como validação local, sem segredos no repositório.
- Documentar instalação, uso, arquitetura, contratos fixados, diagnóstico, limitações, contribuição e atualização do Core. Criar changelog e matriz de compatibilidade das versões efetivamente testadas.
- Preparar release v1.0.0 somente depois dos critérios abaixo, ou identificar claramente uma prévia caso ainda exista bloqueio no fluxo essencial.

Aceite: checkout limpo reproduz verificações automatizadas; documentação reproduz a execução local; há evidência do fluxo real na combinação suportada de Core/CLIs/modelos.

## 6. Definição de produto v1 pronto

- Interface visualmente consistente, acessível e responsiva, com tema claro e escuro, sem regressão dos fluxos atuais.
- Instalação e início locais documentados e reproduzíveis; build servido sem dependência do Vite dev server.
- Pelo menos a combinação de agentes aprovada pelo usuário funciona de verdade; limitações de outros provedores não são ocultadas.
- Projeto, equipe e papéis são configuráveis; duas sessões do mesmo CLI ficam isoladas.
- Um objetivo produz plano, três tarefas, alterações reais, evidências e auditoria; há demonstração de uma reprovação e correção.
- Permissões e controles têm semântica comprovada; indisponibilidade e capacidades desconhecidas aparecem honestamente.
- Reconexão/reload e repetição não duplicam execução; backup/restauração preservam trabalho.
- Não há aprovação, autenticação, modelo disponível, custo, teste aprovado ou conclusão real fabricados por mock ou heurística textual.
- Não há defeito conhecido que cause perda de dados, despacho duplicado, quebra de isolamento ou conclusão falsa no fluxo suportado.
- Repositório versionado, CI verde, documentação e limitações coerentes com a entrega.

## 7. Forma de trabalho e evidências

Executar os marcos na ordem e registrar progresso em `docs/v5-progress.md`. O marco visual é uma entrega separada; os marcos seguintes dependem de validação real, não de aprovação de mocks. Resolver escolhas rotineiras dentro do escopo; não substituir tecnologias/provedores, mudar política de permissões ou publicar recursos externos por suposição.

Para cada marco: o que mudou, arquivos principais, comandos/resultados, evidências observadas, limitações e próximo passo. Separar implementado, testado com fixtures, observado no navegador e observado com Core/CLIs reais. Capturas reais devem omitir segredos.

Não programar todas as fases de uma vez antes de testar o primeiro agente. Primeiro obter uma integração mínima comprovada; depois ampliar para a equipe e para a colaboração. Não aumentar escopo por uma limitação sem antes registrar causa e alternativa concreta.

## 8. Avaliação futura fora do escopo da v1

Está registrada a possibilidade de estudar um **minimal-core** após a validação e estabilização do produto. O estudo deverá confrontar uso real e roadmap com capacidades/dependências do Core, medir ganhos e avaliar o custo de manutenção antes de propor uma versão reduzida. Não iniciar esse trabalho durante os marcos V5-00 a V5-08; continuar com o Core oficial completo. Ver `docs/future-minimal-core.md`.

## Referências

- Planos e contratos locais: `docs/implementation_plan_v4.md`, `docs/aioncore-integration.md`, `docs/local-validation.md`.
- [Core fixado](https://github.com/iOfficeAI/AionCore/tree/503a87199eb978790ca77675b39c84b241535bf3).
- [Licença do Core fixado](https://github.com/iOfficeAI/AionCore/blob/503a87199eb978790ca77675b39c84b241535bf3/LICENSE) e [Apache-2.0, seções 4 e 6](https://www.apache.org/licenses/LICENSE-2.0.html).
- Pesquisa preliminar de nome: [Aion Studio existente](https://www.aionstudio.de/) e [AION com AION-Flow](https://github.com/ingenium-software/aion). Não constitui verificação de disponibilidade de marca/domínio.
