# Vértice Workspace — plano v6 de conclusão local

Data: 17/11/2026. Executor: agente local no Antigravity. Pasta ativa: `C:\llm\vertice-workspace`.

## 1. Mandato e precedência

Encerrar o ciclo do AI Studio e continuar o fonte atual localmente até uma v1 web local utilizável com Core e agentes reais. Este plano substitui as instruções operacionais v5 onde houver divergência. Planos anteriores e relatos do executor são histórico, não comprovação de execução nesta máquina. Não recomeçar a aplicação nem produzir outra rodada de planejamento em lugar da implementação.

Executar por marcos, testar e continuar autonomamente dentro do escopo. Pedir apenas informações/intervenções indispensáveis, como login interativo, escolha entre modelos realmente disponíveis ou metadados do remoto. Enquanto aguarda, avançar no trabalho independente. Não substituir provedor, flexibilizar permissões, modificar ferramentas globais ou expor serviços na rede por suposição.

## 2. Decisões consolidadas

- **Nome:** Vértice Workspace.
- **Slogan:** Seu time de agentes, do plano à entrega.
- **Assinatura:** Powered by AionCore.
- **Produto v1:** interface web local; Core e CLIs executam na máquina do workspace. Sem dependência do Electron ou da interface do AionUi.
- **Motor:** AionCore oficial completo, como processo separado e inicialmente sem modificações. Não importar seus monorepos para o frontend.
- **Visual:** aprovado como base. Somente os refinamentos de V6-07; não abrir outro redesenho.
- **Minimal-core:** exclusivamente futuro, conforme `docs/future-minimal-core.md`; não estudar redução ou criar fork nesta entrega.

Preservar React, TypeScript, Tailwind, pt-BR, componentes, limites UI/domínio/gateway/transporte, isolamento de sessões, contexto versionado, persistência/migração, backups e rastreabilidade. Marca e diretório novos não justificam renomear banco IndexedDB, IDs, schemas ou protocolo `aion-desk/v1`/bloco `aion-desk-json`.

Não acrescentar SaaS multiusuário, cobrança, marketplace, acesso público, sincronização entre computadores, IDE completo ou CLIs hospedados na nuvem. Coordenação autônoma contínua com o navegador fechado não é uma promessa da v1; exigiria avaliação própria de execução durável no backend.

## 3. Baseline verdadeiro

O diretório extraído não possui `.git`; não há GitHub/publicação verificados. Não atribuir a esta pasta os hashes citados pelo executor. Isso não impede o desenvolvimento local.

A revisão independente está em `docs/revisao-local-v5-2026-11-17.md`:

1. `npm ci` conclui, mas faltam dependências nativas Windows no lockfile; tipos/build/testes falham antes de validar código.
2. Launcher aceita PID vivo como identidade e pode encerrar processo alheio após reutilização do PID.
3. `GET /%ZZ` derruba o servidor por erro de decoding não tratado.
4. Job E2E da CI não prepara `dist/` no próprio runner.

Numa cópia temporária com pacotes nativos suplementados, tipos/build, Vitest 40/40, Playwright 1/1 e ciclo normal do launcher Windows passaram. Isso demonstra uma base aproveitável, mas não corrige a instalação recebida nem comprova a integração real. V5-02 a V5-05 continuam pendentes de Core/CLIs reais.

Não executar o produto a partir da cópia temporária da revisão ou da pasta antiga `C:\llm\aion-desk`. Preservar uma cópia identificada do fonte recebido, sem caches/segredos, antes das alterações. Não exigir Git/publicação como condição para começar as correções.

## 4. Método e evidências

Usar Node compatível existente, preferencialmente 24, e npm/package-lock. Não alterar globalmente o ambiente sem necessidade. Não reaproveitar um `node_modules` suplementado como evidência de instalação limpa.

Atualizar `docs/v6-progress.md` por marco: alteração, arquivos, comandos/resultados, evidências, limitações e próximo passo. Separar implementado, testado com fixtures, observado no navegador, comprovado com Core/CLIs e publicado. Não concluir marcos reais apenas porque o mock passou.

Aproveitar a observabilidade existente; acrescentar logs estruturados somente onde faltarem correlação e diagnóstico. Em integração, correlacionar conversa/equipe/participante/sessão/tarefa/tentativa/turno e instância do processo quando disponíveis. Não registrar senhas, cookies, tokens ou prompts completos por padrão. Ajustes visuais não precisam de novos logs.

## V6-00 — Corrigir instalação, launcher, servidor e CI

### Lockfile multiplataforma

Reparar `package-lock.json` para resolução dos opcionais corretos em Windows e Linux. Faltaram na revisão: `@typescript/typescript-win32-x64`, `@rolldown/binding-win32-x64-msvc`, `@tailwindcss/oxide-win32-x64-msvc`, `lightningcss-win32-x64-msvc` e `@esbuild/win32-x64`.

Não torná-los dependências obrigatórias específicas de Windows para todas as plataformas. Não usar `--force`, excluir testes ou documentar instalação manual por fora do lock como solução final. Revisar as alterações e validar `npm ci` em diretório limpo, preservando versões pretendidas sempre que possível.

### Identidade da instância

Corrigir `scripts/vertice-ctl.mjs`: marcador salvo no JSON e existência do PID não provam identidade. Verificar a instância antes de encerrar ou anunciar como ativa, por mecanismo compatível com Windows/Linux, como controle autenticado da instância ou metadados confiáveis do processo. Recusar encerramento quando não houver comprovação. Não matar por nome, porta ou PID antigo isoladamente.

Cobrir registro ausente/inválido/morto, registro antigo apontando para processo alheio, porta ocupada, start duplicado e ciclo normal. Testes devem criar processos descartáveis próprios. Rever `start`, `status` e `doctor`, não somente `stop`.

### Requisições inválidas

Em `scripts/vertice-server.mjs`, tratar decoding no limite HTTP: `GET /%ZZ` retorna 400 e uma requisição válida posterior continua funcionando. Preservar contenção em `dist/`, GET/HEAD, 404 de assets e fallback SPA. Não servir fontes ou dados fora do build para contornar o erro.

### CI E2E

Em `.github/workflows/ci.yml`, gerar `dist/` no job E2E ou recebê-lo por artefato. `needs: verify` não compartilha filesystem entre runners. Conferir a sequência sem `dist/` prévio. Nenhuma credencial/CLI autenticado no CI.

**Aceite:** instalação limpa Windows sem suplementação; tipos/build/testes verdes; regressões de PID/URL cobertas; launcher atua somente na instância própria; E2E com build preparado. Registrar Linux como pendente se não houver execução disponível e não declarar CI remota verde antes de observá-la. Quantidade de testes não é a meta; cada teste deve cobrir comportamento útil.

## V6-01 — Preparar Core dedicado, origem e autenticação

Contratos de referência: AionCore v0.2.2, fonte `503a87199eb978790ca77675b39c84b241535bf3`.

1. Inventariar processos/portas e não interferir em serviços existentes. Escolher uma origem local estável; armazenamento do navegador depende de esquema, host e porta.
2. Verificar novamente o binário encontrado anteriormente em `C:\llm\AionUi\docs\superpowers\local-run\tools\core\aioncore.exe`: existência, versão, ajuda e procedência. Esse caminho é referência da máquina, não layout obrigatório da distribuição.
3. Registrar SHA-256 do executável; identificar separadamente qualquer hash do ZIP. A versão nominal não prova sozinha o commit exato da compilação.
4. Usar diretório de dados/configuração próprio do Core do Vértice, separado do banco do AionUi existente, com opções confirmadas por ajuda/código. Documentar logs, workspace, início e encerramento.
5. Considerar runtime gerenciado e adaptadores: o ZIP com um executável não significa ambiente completo offline.
6. Configurar `.env.local` com endereço real, manter autenticação/CSRF oficiais e proxy de mesma origem. Nenhum segredo em variável VITE, IndexedDB ou backup.
7. Comprovar `/health`, autenticação e WebSocket reais pelo caminho de distribuição (`npm start`/launcher), não apenas por Vite dev.

**Aceite:** Vértice em loopback, Core dedicado acessível pelo proxy e sessão HTTP/WS observada, sem mock ou janela do AionUi. Indisponibilidade não causa fallback para demonstração.

## V6-02 — Primeira sessão real e continuidade

Descobrir um assistente utilizável no Core. Verificar executável, autenticação e modelo no ambiente real do processo; não presumir pelo PATH de outro terminal. Usar ajuda/schema da versão instalada, documentação oficial ou captura real, sem inventar flags/capacidades.

Criar sessão pela interface e enviar pedido simples, inicialmente sem escrita no projeto. Confirmar stream, aba correta e conclusão. Registrar a cadeia de IDs do Vértice, Core e sessão nativa quando exposta; identificadores de camadas diferentes não são intercambiáveis.

Enviar um segundo pedido dependente de informação explícita do primeiro. Depois testar reconexão e reinício controlados para verificar retomada efetiva. Histórico renderizado não prova contexto restaurado no modelo. Se a integração exigir nova sessão, informar e oferecer recuperação explícita com contexto selecionado, sem anunciar a sessão nova como antiga.

**Aceite:** uma sessão real comprovada com eventos/IDs sanitizados e continuidade verificada. Não ampliar para toda a equipe enquanto esse caminho estiver fictício.

## V6-03 — Equipe, papéis, modelos e capacidades

Equipe preferida: Terra 6.1 coordenador via Codex; Sol 6.1 planejador/auditor em outra sessão Codex; Gemini Hydrogen executor via Antigravity. Oferecer também planejamento e auditoria em duas sessões Sol distintas.

Esses nomes são preferências até confirmação dos IDs efetivos na conta. Não inventar modelos, nem substituir provedor silenciosamente. Quando faltar disponibilidade, apresentar alternativas reais e pedir a escolha necessária, seguindo o trabalho independente.

Validar Codex e Antigravity separadamente. Aplicativo instalado não comprova integração utilizável pelo Core. Cursor e provedores adicionais podem ser representados conforme suporte real, mas suporte a todos não é um novo requisito obrigatório da v1.

Comprovar duas sessões independentes pela mesma conexão Codex: IDs, destinatários, rascunhos e históricos separados. Papéis não são posições fixas por fornecedor. Mudança futura de papel/modelo não reescreve tentativas anteriores.

Registrar matriz observada de mensagens/stream, retomada, seleção de modelo, permissões, pausa e interrupção. Capacidade desconhecida permanece desconhecida; controles indisponíveis explicam o motivo. Health check não comprova login do CLI.

**Aceite:** equipe configurada pela UI, slots/sessões distintos e reload sem perda; Geral chega ao coordenador, aba individual à sessão correta. Uma integração essencial indisponível permanece como bloqueio explícito da combinação pretendida.

## V6-04 — Autoridade de coordenação e ciclo real completo

Documentar quem publica plano, despacha tarefa, inicia tentativa e conclui trabalho. O Core tem fluxo próprio de equipes e o Vértice interpreta planos/entregas: verificar que não haja dupla coordenação ou execução da mesma tarefa. Não presumir uma opção inexistente para desligar o fluxo nativo.

Usar repositório pequeno de teste, separado dos fontes do produto, com estado inicial e diff revisáveis. Executar objetivo → plano → decisão conforme política → três tarefas com dependência → tentativa → entrega → auditoria → correção ou conclusão.

Verificar o protocolo interno `aion-desk/v1` em saídas reais; correlacionar tarefa, tentativa e revisão, mantendo saída original. Conteúdo incompleto/inválido vira revisão manual, não aprovação por heurística ou loop infinito.

Para timeout, resposta perdida ou reconexão, reconciliar antes de repetir ação que pode ter sido aceita. Registrar o despacho de modo recuperável e usar idempotência nativa somente se comprovada pelo contrato. Resultado incerto não autoriza reenvio cego.

No mesmo diretório, serializar tarefas que escrevem arquivos. Paralelismo exige isolamento comprovado; infraestrutura de worktrees não é requisito novo desta v1. Auditor deve ter sessão distinta do executor, mesmo usando o mesmo provedor/modelo.

Auditar arquivos, diff e testes observados. Distinguir afirmação do executor de verificação independente. Cada tentativa preserva agente, modelo, instruções, contexto e resultado efetivos.

**Aceite:** três tarefas realmente tratadas, alteração verificável, auditoria de critérios e ausência de conclusão prematura. Demonstrar um despacho lógico por tentativa nos cenários exercitados.

## V6-05 — Permissões, correção, falhas e limites

Mapear permissões nativas Core/CLI quando suportadas. Aprovação de etapa no Vértice não equivale à autorização nativa de ferramenta. Comprovar permitir/recusar em operação pequena e controlada; recusa impede a operação correspondente. Não desativar políticas para obter teste verde.

Comprovar reprovação por qualidade → nova tentativa → auditoria, além de saída inválida e falha operacional. Infraestrutura não incrementa rejeição de qualidade. Verificar limites de tentativas/tempo/escalonamento existentes e fechar caminhos infinitos essenciais; troca de modelo segue política e decisão humana aplicáveis.

Testar interrupção e pausa disponíveis. Pedido enviado e controle confirmado são estados diferentes. Cancelamento não publica entrega parcial como sucesso. Ausência de suporte deve aparecer explicitamente.

Não exibir custos/tokens exatos se a integração não os fornecer. Preservar rastreabilidade de evidências e critérios não atendidos.

**Aceite:** aprovação/recusa, reprovação/correção e falha/cancelamento comprovados conforme capacidade suportada, sem decisões simuladas no modo real ou loops ilimitados.

## V6-06 — Contexto, sessões, persistência e recuperação

### Contexto e identidade

Publicar contexto versionado e verificar recibos por participante. `sent`, `received` e `applied` exigem evidências distintas; não inferir aplicação pelo simples envio. Fonte de verdade do projeto não é sinônimo da janela de contexto do modelo.

Preservar vínculos de sessão quando o backend suportar. Não importar automaticamente chats manuais existentes. Histórico do Vértice, sessão nativa e chat visível no aplicativo original são coisas diferentes: testar e documentar listar/retomar/visibilidade por fornecedor sem prometer sincronização universal. O aplicativo original aberto não deve ser requisito para operar o Vértice.

### Falhas e fechamento de aba

Testar queda WS, reentrega, duas conversas, Core reiniciado, sessão expirada, tarefa concluída enquanto aba fechada, página de catch-up com falha e evento concorrente durante recuperação. Conferir autoria, estado de tarefa, dependências e paginação contra payloads reais. Pendência implica sincronização incompleta.

O Core pode continuar trabalho já aceito quando a aba fecha; o navegador não despacha novas etapas enquanto fechado. Ao reabrir, distinguir retomar fluxo de repetir pedido. Comprovar esse comportamento, não apenas inserir aviso na UI.

### Dados e backups

Validar backup/restauração reais sem credenciais. Importar cópia não inicia execução, presume login ou retoma silenciosamente sessões de outro ambiente. Rever referências externas e exigir vinculação explícita quando necessária.

Testar falha IndexedDB, aviso de sessão temporária, fila de gravação e migração dos dados atuais. Documentar exportação antes de trocar origem/porta. Não copiar bancos manualmente como substituto de migração.

**Aceite:** recuperação sem perda/duplicação nos cenários exercitados, semântica honesta de contexto/sessão e importação sem execução automática. Retomada após reload comprovada com Core real.

## V6-07 — Acabamento e primeiro uso

Preservar o visual aprovado e fazer somente:

- Agrupar controles de demonstração no menu secundário, mantendo marcador de simulação visível.
- Mover IDs técnicos para detalhes acessíveis, mantendo links de rastreabilidade.
- Compactar cabeçalho/composer mobile para liberar conversa, sem perder destinatário, contexto e envio.
- Preservar teclado, foco, novidades, permissões e avisos relevantes; não esconder perda de persistência ou recuperação incompleta.

Validar a preparação guiada com estado real: runtime, autenticação, catálogo, workspace/equipe e primeiro pedido aceito. Conexão demo ou estado antigo de outro runtime não pode confirmar etapa real. Diagnóstico técnico continua acessível, sem dominar o primeiro uso.

Em origem limpa, permitir configurar a combinação suportada pela UI, sem editar JSON ou usar DevTools. Conferir vazios/carregamento/erro/sem agente e oferecer próximo passo objetivo. Demonstração é opção identificada.

**Aceite:** screenshots claro/escuro em 1440×900, 1024×768 e 390×844, sem overflow da página, com abas/drawer/modal/foco utilizáveis e E2E preservado. Primeiro uso real observado.

## V6-08 — Distribuição e operação local

Concluir o servidor/launcher já criados sem trocar framework:

1. Servir `dist/` e proxy HTTP/WS pelo caminho de distribuição. Validar cookies, CSRF, subprotocolos, indisponibilidade upstream e reconexão com Core real. Diagnóstico não expõe segredo ou arquivo arbitrário.
2. Simplificar início/encerramento. Se integrar início do Core, distinguir processo próprio de serviço externo e encerrar somente instância comprovadamente própria. Auxiliares Windows usam janelas ocultas quando não interativos.
3. `doctor` verifica faixa Node real, build, configuração, portas e estado comprovado. Não anunciar processo vivo como servidor identificado. Explicar os passos de recuperação.
4. Loopback por padrão; sem firewall, bind público, acesso remoto ou redução de autenticação/CORS/CSRF para facilitar uso.
5. Documentar Core, runtime gerenciado, CLIs e autenticação separadamente. Binário não equivale a pacote totalmente offline. Verificar recursos extras ou informar necessidade de rede no primeiro preparo.
6. Separar código/build, runtime, dados e logs. Atualização não apaga dados/credenciais; backup e retorno à versão anterior não dependem de hashes inexistentes.
7. Repetir extração/instalação limpa e início pelo build estático, com configuração real. Vite dev ou dist antigo não bastam.

**Aceite:** instalação documentada inicia, executa pedido real, encerra de forma controlada e preserva dados após reinício. Pré-requisitos e componentes obtidos na preparação são explícitos.

## V6-09 — Validação integrada e release

Na candidata final, executar tipos, testes relevantes, build e Playwright. Repetir verificações adicionais apenas quando mudanças, falhas ou dúvidas concretas justificarem. Incorporar payloads reais sanitizados às fixtures; elas não podem ser uma especificação inventada independente do produtor.

Roteiro obrigatório com versões, comandos, resultados e evidências:

1. Instalação limpa Windows e início pelo servidor de produção local.
2. Core/autenticação/modelos reais.
3. Duas sessões do mesmo CLI e envio Geral/individual isolados.
4. Três tarefas com dependência, diff real e auditoria.
5. Reprovação/correção, permissão recusada e saída inválida.
6. Interrupção suportada, falha operacional e limites de tentativa.
7. Reconexão/reload, catch-up parcial e retomada sem duplicação.
8. Contexto versionado e recibos com evidência correspondente.
9. Backup/restauração e reinício preservando dados.
10. Desktop/mobile, claro/escuro e teclado.

**Produto funcionalmente pronto:** combinação aprovada operando de verdade; instalação reproduzível; casos essenciais acima aprovados; nenhum defeito conhecido causando perda de dados, encerramento de processo alheio, quebra de isolamento, despacho duplicado ou conclusão falsa no fluxo suportado.

Limitação de um provedor opcional pode constar da matriz. Integração essencial indisponível é bloqueio, não detalhe cosmético. Distinguir prontidão funcional, publicação e release lançada. Não declarar v1.0.0 antes de cumprir os critérios essenciais.

## V6-10 — Versionamento, GitHub e documentação

Depois da primeira integração real comprovada, organizar versionamento local com baseline e mudanças reais. Não inventar hashes retroativos ou misturar outros projetos. A inexistência de Git no início é normal e não é defeito a corrigir antes de qualquer trabalho.

Preparar remoto e CI usando conta/organização, nome e visibilidade definidos pelo usuário. Se faltarem dados, deixar publicação pronta e pedir somente o necessário; não presumir repositório público nem bloquear desenvolvimento independente.

Versionar fonte, lock, scripts, testes e docs. Excluir `.env.local`, credenciais, cookies, bancos, logs, caches, node_modules, binários de runtime e dados pessoais. Após publicar, observar a CI Windows/Linux e E2E; configuração presente não equivale a pipeline verde.

Atualizar README, changelog, matriz de compatibilidade, arquitetura, integração, roteiro local e limitações. Docs ativos usam a pasta atual quando necessário; históricos preservam caminhos antigos identificados. Preservar licenças/atribuições dos componentes distribuídos.

**Aceite:** instalação/checkout reproduzível, histórico verdadeiro, CI observada quando remoto disponível e instruções de diagnóstico/uso coerentes. Pendência administrativa de publicação é distinta de falha do produto.

## 5. Entregáveis e encerramento

- Código/scripts/lock corrigidos e testes de regressão relevantes.
- Progresso por marco e evidências sanitizadas, com nível de validação explícito.
- Matriz real Core/CLIs/modelos/capacidades e cadeia de IDs de sessão.
- Decisão sobre autoridade de coordenação e ações com resultado incerto.
- Screenshots do acabamento e roteiro do ciclo real.
- Instalação, início, diagnóstico, backup, atualização, retomada e encerramento documentados.
- Limitações e intervenções externas pendentes com impacto claro.
- Resumo final separando implementação, fixtures, navegador, Core/CLIs reais e publicação.

Ler também `docs/architecture.md`, `docs/aioncore-integration.md`, `docs/local-validation.md`, `docs/local-handoff.md` e `docs/compatibility-matrix.md`. Referências locais: `C:\llm\AionCore` e `C:\llm\AionUi`; ler instruções aplicáveis desses projetos antes de inspecioná-los/alterá-los. São referências de contratos, não módulos a importar no frontend.
