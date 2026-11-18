# Vértice Workspace

Plano ativo de conclusão local: [Plano v6](docs/implementation_plan_v6_local.md). Instrução ao executor: [hydrogen-local-v6.txt](docs/hydrogen-local-v6.txt). Progresso: [v6-progress.md](docs/v6-progress.md). O ciclo do AI Studio foi encerrado; a base atual ainda requer as correções e validações reais registradas nesses documentos.

> **Seu time de agentes, do plano à entrega.**  
> *Powered by AionCore*

Interface em React, TypeScript e Tailwind CSS v4 para **coordenação observável entre agentes de programação**, com conversa principal **Geral**, abas individuais configuráveis por participante, **Contexto Compartilhado** versionado com recibos granulares, fluxo formal de planejamento/tarefas/tentativas/revisões, persistência versionada com backup JSON restaurável e transporte desacoplado para o **AionCore Local (`v0.2.2`)**.

> **Transparência sobre execução**:  
> - Em **Modo Demonstração** (`MockWorkspaceGateway`), respostas, comandos, testes e testes de conexão são simulados deterministicamente no navegador, sem terminal nem APIs externas.  
> - Em **Modo AionCore Local** (`AionCoreAdapter`), o aplicativo comunica via HTTP/WebSocket com uma instância real do AionCore (`v0.2.2`), sem nunca recorrer silenciosamente ao mock quando o Core está inacessível.
> - **Compatibilidade preservada**: o produto adota a marca **Vértice Workspace**, preservando identificadores técnicos internos (`aion-desk/v1`, `aion-desk-json`, banco IndexedDB e formato de backup `2.0.0`).

---

## Pré-requisitos locais

- **Node.js**: `24.x` recomendado (compatível com `^22.12.0 || ^24.0.0 || >=26.0.0`, conforme `engines.node` no `package.json`).
- **Gerenciador canônico**: `npm` (utilize sempre `npm ci` com o `package-lock.json` entregue).
- **Playwright (opcional para E2E no navegador)**: Chromium instalado via `npm run test:e2e:install`.

---

## Início rápido (Windows / PowerShell e Linux / macOS)

### PowerShell (Windows)

```powershell
# 1. Instalar dependências exatamente conforme package-lock.json
npm ci

# 2. Verificar tipos TypeScript, suíte unitária/integração e build de produção
npm run lint
npm test
npm run build

# 3. Subir em desenvolvimento (porta 3000) ou preview (build dist/)
npm run dev
# ou:
npm run preview
```

### Linux / macOS

```bash
npm ci
npm run lint && npm test && npm run build
npm run dev
```

### Scripts disponíveis (`package.json`)

| Script | Função |
| :--- | :--- |
| `npm run dev` | Sobe Vite em desenvolvimento na porta `3000` (`--host=0.0.0.0`). |
| `npm run build` | Gera o bundle de produção em `dist/` (com chunks separados, sem alertas de tamanho). |
| `npm start` | Sobe o servidor local reproduzível (`scripts/vertice-server.mjs`) em `127.0.0.1:4173` servindo `dist/` e encaminhando `/api`, `/health`, `/login`, `/logout` e `/ws`. |
| `npm run server:doctor` | Diagnostica Node, `dist/`, `.env.local`, porta loopback e conectividade com `/health` do Core. |
| `npm run server:start` | Inicia o servidor local em segundo plano (`windowsHide: true`), grava PID próprio em `.vertice/server.json` e logs em `.vertice/logs/`. |
| `npm run server:status` | Verifica se o processo iniciado pelo launcher permanece ativo. |
| `npm run server:stop` | Encerra exclusivamente o PID registrado em `.vertice/server.json` (nunca mata processos alheios por nome). |
| `npm run preview` | Sobe `vite preview` apenas para inspeção estática ou E2E (não aplica proxy reverso do Core; use `npm start` / `server:start`). |
| `npm run lint` | Executa checagem estrita de tipos (`tsc --noEmit`). |
| `npm test` | Executa a suíte Vitest (`vitest run`, incluindo testes do proxy Vite e do servidor local). |
| `npm run test:e2e:install` | Instala o navegador Chromium gerenciado pelo Playwright. |
| `npm run test:e2e` | Executa `e2e/aion-desk.spec.ts` contra `npm run preview` na porta `4173`. |
| `npm run clean` | Remove `dist/`, `server.js`, `test-results/` e `playwright-report/` de forma multiplataforma via `node -e`. |

---

## Execução local reproduzível, atualização e retorno (sem Vite dev server)

Para operar o **Vértice Workspace** fora do modo de desenvolvimento, mantendo **mesma origem**, proteção **CSRF** e **loopback seguro por padrão**:

```powershell
npm ci
npm run build
npm run server:doctor
npm run server:start
```

### Separação de camadas, pré-requisitos e requisito de rede

1. **Vértice Workspace (código, build e controle web)**: código em `src/`/`scripts/`, bundle estático em `dist/` (`npm run build`), estado/logs do launcher em `.vertice/server.json` e `.vertice/logs/server.{out,err}.log`. Em runtime após o build, `scripts/vertice-server.mjs` utiliza exclusivamente módulos nativos do Node.js (`0` pacotes externos em execução).
2. **AionCore Local (`v0.2.2`, `aioncore.exe`)**: binário separado executado em processo próprio com `--identity-mode webui --host 127.0.0.1 --port <PORTA> --data-dir ... --work-dir ... --log-dir ...`, mantendo banco SQLite, workspaces e logs **fora** da pasta do repositório. O launcher `vertice-ctl` nunca gerencia nem encerra processos externos que não comprovem sua identidade autenticada.
3. **Runtime gerenciado e rede no primeiro preparo**: exige `Node.js` `^22.12.0 || ^24.0.0 || >=26.0.0` (recomendado `24.x`). **Possuir o código ou build estático não torna a operação 100% offline**: o primeiro `npm ci` (sem cache local aquecido), `npm run test:e2e:install` (Chromium do Playwright), instalação/login de CLIs e chamadas reais a modelos requerem acesso à rede.
4. **CLIs locais e autenticação**: `codex`, `antigravity` e `cursor-agent` são instalados e autenticados separadamente no ambiente local; sessões WebUI do AionCore usam apenas cookies `HttpOnly` + CSRF no navegador (nunca salvos em IndexedDB ou backups).

### Segurança de rede e política de atualização/rollback

- **Loopback obrigatório por padrão**: `scripts/vertice-server.mjs` vincula-se exclusivamente a `127.0.0.1:4173` (aceita apenas loopback; ajuste a porta com `VERTICE_PORT` ou `PORT` em `.env.local`). Sem abertura de firewall, bind público, acesso remoto ou relaxamento de CORS/CSRF/autenticação.
- **Dados preservados na atualização**: execute `npm run server:stop`, atualize o código, rode `npm ci && npm run build`, confira `npm run server:doctor` e suba com `npm run server:start`. Essa rotina **não apaga** o histórico do navegador (IndexedDB `aion_desk_storage`), backups JSON exportados, nem `core-data`, `core-work`, `core-logs` ou credenciais dos CLIs/WebUI.
- **Retorno à versão anterior (rollback)**: utilize exclusivamente commits ou tags reais do histórico Git (`git log --oneline`, por exemplo os checkpoints `40f39f8` ou `68dfb73`), reconstrua `dist/` (`npm ci && npm run build`) e reinicie (`server:stop` / `server:start`). Se houver alteração de esquema local, importe o backup JSON prévio pelo botão **Exportar / Backup** (sem credenciais).
- Fechar todas as abas do navegador interrompe a coordenação pela UI (a v1 web não roda como daemon em segundo plano); ao reabrir, sinais ao vivo (`/health`, sessão e catálogo) são revalidados automaticamente e o trabalho aceito pelo Core é reconstruído via catch-up.

---

## Configurando conexão com o AionCore local (`v0.2.2`)

1. Instale e autentique separadamente o binário **AionCore (`v0.2.2`)** e os CLIs locais desejados (`codex`, `antigravity`).
2. Copie `.env.example` para `.env.local` (nunca versione `.env.local`).
3. Para desenvolvimento ou servidor local com cookies e CSRF na **mesma origem**, defina o alvo do Core no `.env.local`:

```env
VITE_AIONCORE_BASE_URL=""
VITE_AIONCORE_PROXY_TARGET="http://127.0.0.1:<PORTA_DO_SEU_CORE>"
```

4. Inicie `npm run build && npm run server:start` (ou `npm run dev` em desenvolvimento). Tanto o proxy do Vite quanto `scripts/vertice-server.mjs` encaminham `/api`, `/health`, `/login`, `/logout` e `/ws` preservando cookies e tokens CSRF na mesma origem.
5. Na interface, acesse **Configurações → Modo de operação → Modo AionCore local** e siga a lista de 5 etapas (**Preparação guiada para operação real**).

Consulte os guias detalhados em `docs/`:
- `docs/architecture.md` — Entidades, fluxos, fronteiras e persistência.
- `docs/aioncore-integration.md` — Contratos `v0.2.2`, mapa de IDs, auth/CSRF/WS e pendências.
- `docs/compatibility-matrix.md` — Versões suportadas, auditoria de dependências/bundle e limitações da v1.
- `docs/local-validation.md` — Roteiro passo a passo para testes reais com Codex, Antigravity e preset Terra/Sol/Gemini.
- `docs/local-handoff.md` — Pendências exclusivamente locais com evidência exigida e teste de fechamento.
- `docs/v5-progress.md` — Registro atualizado dos marcos `V5-00` a `V5-08` (e `docs/v4-progress.md` como registro histórico).

---

## Inventário de dependências

| Pacote | Função | Motivo |
| :--- | :--- | :--- |
| `react` / `react-dom` | UI e árvore de componentes | Base da aplicação |
| `lucide-react` | Ícones de interface | Conjunto único, leve e importado sob demanda |
| `react-markdown` | Renderização segura de Markdown | Carregado sob demanda via `React.lazy` sem plugins inseguros |
| `tailwindcss` / `@tailwindcss/vite` | Estilização e tokens semânticos | Suporte nativo a temas grafite claro/escuro com destaque azul-petróleo |
| `vite` / `@vitejs/plugin-react` | Bundler e dev server | Desenvolvimento em porta `3000` e build estático em chunks |
| `vitest` | Testes unitários, integração e benchmark | Validação determinística do domínio, adaptador Core, servidor local e carga de 2.000 eventos |
| `@playwright/test` | Testes E2E de navegador | Verificação dos fluxos críticos da interface e responsividade |

*(O servidor local em `scripts/vertice-server.mjs` e o launcher `scripts/vertice-ctl.mjs` utilizam apenas módulos nativos do Node.js. Pacotes herdados de template sem uso medido — `@google/genai`, `express`, `dotenv`, `motion`, `tsx` e `@types/express` — foram removidos na etapa V5-07.)*
