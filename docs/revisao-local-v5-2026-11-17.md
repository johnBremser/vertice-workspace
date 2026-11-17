# Revalidação da extração local v5 — 17/11/2026

Diretório examinado: `C:\llm\vertice-workspace`.

## Parecer

A base progrediu e está adequada para continuar o desenvolvimento local. O visual, a marca e a separação entre simulação e execução real estão coerentes com o plano. Há quatro correções locais antes de considerar instalação/distribuição/CI prontas; não é necessário voltar ao AI Studio ou recomeçar o projeto.

O diretório extraído não contém `.git` e não há repositório local reconhecido. Isso não é erro da aplicação nem evidência de publicação. Os hashes presentes no relato/documentação do executor não foram verificados nesta extração; não interpretar esses hashes como histórico local disponível.

## P1 — Instalação pelo lockfile não entrega os pacotes nativos Windows

`npm ci --no-audit --no-fund`, executado com Node 24.22.3 na pasta recebida, concluiu com 151 pacotes. Entretanto, os comandos seguintes falharam antes de validar o código:

- TypeScript: ausência de `@typescript/typescript-win32-x64`.
- Vite e Vitest: ausência de `@rolldown/binding-win32-x64-msvc`.

O `package-lock.json` contém entradas nativas Linux para TypeScript, Rolldown, esbuild e Tailwind, mas não as correspondentes Windows necessárias. A configuração local de npm não estava omitindo opcionais. Assim, o sucesso Linux relatado não comprova instalação reproduzível no Windows.

Correção: reparar o lockfile com resolução das dependências opcionais suportadas e confirmar instalação limpa Windows/Linux pela matriz pretendida. Não excluir testes, adicionar pacotes de outra arquitetura como dependências obrigatórias ou usar `--force` para ocultar inconsistência.

Para continuar a revisão sem alterar manifests/lockfile do fonte recebido, foi criada uma cópia temporária em `C:\Users\JOAO~1.GON\AppData\Local\Temp\vertice-validation-787c28e82d334652a20c81f8d283cd68`. Nessa cópia foram adicionados explicitamente, sem salvar manifests ou lockfile:

- `@typescript/typescript-win32-x64@7.0.2`
- `@rolldown/binding-win32-x64-msvc@1.2.19`
- `@tailwindcss/oxide-win32-x64-msvc@4.3.5`
- `lightningcss-win32-x64-msvc@1.33.0`
- `@esbuild/win32-x64@0.28.2`

Essa suplementação é um recurso de diagnóstico, não uma correção entregue do lockfile.

## P1 — Launcher confunde PID vivo com identidade do servidor

`scripts/vertice-ctl.mjs:15` aceita o marcador do arquivo JSON e `:34` verifica apenas se o PID existe. Em `:250`, envia SIGTERM ao PID sem verificar se ainda pertence ao servidor iniciado anteriormente. Um PID pode ser reutilizado pelo sistema após a saída do servidor.

Reprodução controlada: cópia isolada dos scripts, processo Node descartável criado pelo próprio teste e registro antigo apontando para seu PID, com o marcador esperado. `stop` encerrou esse processo alheio ao servidor e anunciou sucesso. Nenhum processo do usuário foi usado nessa reprodução.

Correção: verificar identidade da instância, não apenas liveness/valor de marcador salvo. Usar mecanismo comprovável de identificação (por exemplo, metadados do processo com instante de criação e comando esperado, ou controle autenticado da própria instância) e recusar encerramento quando não houver comprovação. Cobrir registro antigo/reutilização de PID com processo de teste descartável. O mesmo cuidado se aplica a `start`, `status` e diagnóstico.

## P2 — URL malformada encerra todo o servidor

`scripts/vertice-server.mjs:98` executa `decodeURIComponent` sem tratamento de erro; a chamada ocorre no callback HTTP em `:279`.

Reprodução em processo filho isolado: `GET /%ZZ` causou `URIError: URI malformed` e término do processo com código 1. Um erro de requisição deve retornar 400 e manter o serviço disponível.

Correção: validar/tratar o decoding no limite da requisição, responder erro apropriado e acrescentar regressão que envie em seguida uma requisição válida e confira que o servidor continua atendendo.

## P2 — Job E2E da CI não prepara dist

`.github/workflows/ci.yml:75` executa o Playwright após checkout, instalação e Chromium. Não há build nem download de artefato nesse job. `playwright.config.ts` inicia `vite preview`, que depende de `dist/`.

O build no job `verify` não compartilha automaticamente seu filesystem com `e2e-browser`. Adicionar build nesse job ou transferência explícita do artefato antes do Playwright. Não foi executada pipeline remota nesta revisão.

## Verificações que passaram na cópia temporária

Com os pacotes nativos suplementados e sem mudar fontes de aplicação:

- TypeScript: aprovado.
- Build Vite: aprovado, sem aviso de chunk maior que 500 kB.
- Vitest: 7 arquivos, 40/40 aprovados.
- Playwright com Chrome instalado: 1/1 aprovado em 11,5 segundos.
- Launcher Windows no caminho normal: `doctor → start → status → GET / (200) → stop → status`, porta 45125. O processo criado foi encerrado. Esse sucesso não invalida o problema de identidade de PID reproduzido separadamente.
- Inspeção das mudanças de tokens/marca/componentes e da captura desktop entregue: evolução coerente com o briefing. As 12 capturas antes/depois vieram na extração.

## Encaminhamento

Tratar as quatro correções aqui, sem nova rodada de funcionalidades ou redesenho. Em seguida, configurar Core oficial já disponível, proxy, autenticação e primeira sessão real; depois equipe e colaboração. V5-02 a V5-05 continuam sem validação real nesta revisão.

Não foram alterados fontes da aplicação, manifests, lockfile, CI ou scripts recebidos; apenas este relatório foi acrescentado. `node_modules` foi instalado na pasta recebida para reproduzir o problema. Nenhum Git foi inicializado e nenhum remoto foi criado. Nenhum Core ou CLI autenticado foi iniciado.

Probe independente dos dois casos de runtime: `C:\Users\joao.gonzales\.codex\visualizations\2026\11\16\01a1e5b9-442a-7c63-83db-da4629b6a0d2\verify-vertice-v5-runtime.mjs`.
