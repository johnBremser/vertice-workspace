# Matriz de Compatibilidade — Vértice Workspace

Registro técnico das versões testadas, contratos fixados do **AionCore** e limites conhecidos antes da declaração da release `v1.0.0`.

---

## 1. Runtime e Ambiente Local

| Componente | Versão / Suporte | Evidência atual | Observação |
| :--- | :--- | :--- | :--- |
| **Node.js** | `^22.12.0 \|\| ^24.0.0 \|\| >=26.0.0` (recomendado `24.x`) | Validado em `Node v22.23.2` neste sandbox; CI configurado para `22` e `24` | `engines.node` no `package.json` |
| **npm / Lockfile** | `npm` (`10.x+`, canônico com `package-lock.json`) | Validado com `npm 10.9.8` (`npm ci` / `npm uninstall --offline`) | Evitar gerenciadores paralelos |
| **Sistemas Operacionais** | Windows 10/11 (PowerShell), Linux, macOS | Executado em Linux neste ambiente; correção ESM `pathToFileURL` e launcher `windowsHide` preparados para Windows | Confirmar execução nativa no Windows local do usuário |
| **Navegadores** | Chromium / Edge / Chrome recentes (Playwright `1.65.1`) | Verificado em Chromium headless (`1440×900`, `1024×768`, `390×844`, claro e escuro) | Requer suporte a IndexedDB para persistência durável |

---

## 2. Backend e CLIs externos (AionCore + Agentes)

| Alvo de integração | Versão / Referência fixada | Estado no código | Estado em execução real |
| :--- | :--- | :--- | :--- |
| **AionCore Local** | `v0.2.2` (`commit 503a87199eb978790ca77675b39c84b241535bf3`, Apache-2.0) | DTOs, auth/CSRF, refresh single-flight, WS `[ws_token]` e catch-up (`/run-state`, `/mailbox`, `/tasks`, `/activity`) implementados e testados com mocks fiéis | **Pendente local** (binário não presente neste ambiente headless) |
| **Codex CLI** | Descoberto dinamicamente via `/api/agents/management` e `/api/assistants` | Suporte a múltiplas sessões independentes na mesma conexão (`slot_id` + `externalConversationId` próprios) | **Pendente local** (CLI não instalado/autenticado neste ambiente) |
| **Antigravity CLI** | Descoberto dinamicamente via `/api/agents/management` e `/api/assistants` | Tratado sem confirmação fictícia; capacidades desconhecidas bloqueiam com motivo claro | **Pendente local** (CLI não instalado/autenticado neste ambiente) |
| **AionUi (referência)** | `2.2.2` (`commit e108b6b56b1a6eb99a00904878d0582f657b2908`, Apache-2.0) | Referência de `httpBridge.ts` e `sessionRefresh.ts` com atribuição preservada | Não é dependência de runtime |

---

## 3. Dependências e Chunks do Bundle (`dist/`)

### Dependências ativas de produção e desenvolvimento
- **Frontend**: `react` (`^19.0.1`), `react-dom` (`^19.0.1`), `lucide-react` (`^0.546.0`), `react-markdown` (`^10.1.0`, sob demanda via `React.lazy`).
- **Toolchain e testes**: `vite` (`^8.3.0`), `@vitejs/plugin-react` (`^6.1.1`), `@tailwindcss/vite` (`^4.3.3`), `tailwindcss` (`^4.3.3`), `autoprefixer`, `esbuild`, `typescript` (`^7.0.2`), `vitest` (`^5.1.0`), `@playwright/test` (`^1.65.1`).
- **Servidor local reproduzível (`V5-07`)**: utiliza exclusivamente módulos nativos do Node.js (`node:http`, `node:https`, `node:net`, `node:tls`, `node:fs`, `node:path`, `node:url`, `node:child_process`), com **zero pacotes extras**.
- **Limpeza medida**: removidos 121 pacotes herdados sem qualquer importação em `src/`, `e2e/` ou configuração (`@google/genai`, `express`, `dotenv`, `motion`, `tsx`, `@types/express`).

### Particionamento medido em `vite build` (`dist/assets/`)
- CSS principal: `~29,7 kB` (`gzip ~6,4 kB`)
- `index` (app/domínio/UI): `~179,4 kB` (`gzip ~35,6 kB`)
- `react-vendor`: `~431,3 kB` (`gzip ~129,6 kB`)
- `aion-core-gateway`: `~146,7 kB` (`gzip ~37,0 kB`)
- `react-markdown`: `~145,7 kB` (`gzip ~43,2 kB`, sob demanda)
- `demo-gateway`: `~67,5 kB` (`gzip ~15,3 kB`)
- `SettingsView`: `~62,7 kB` (`gzip ~11,4 kB`, sob demanda)
- `ExportDialog`: `~23,6 kB` (`gzip ~6,7 kB`, sob demanda)
- **Avisos de chunk (> 500 kB)**: `0` (zero).

---

## 4. Persistência, Segurança Local e Limitações Conhecidas

- **Diretórios e armazenamento local**:
  - Navegador: IndexedDB (`aion_desk_storage`), preferências de UI (`localStorage` sob chave `aion_desk_ui_prefs_v1`). Credenciais, cookies e tokens CSRF/WS **nunca** são persistidos nem incluídos em exportações JSON (`exportSchemaVersion: "2.0.0"`).
  - Servidor local (`scripts/vertice-ctl.mjs`): estado e logs apenas em `.vertice/server.json` e `.vertice/logs/` (ignorados no `.gitignore`).
- **Exposição de rede (v1)**: servidor local vincula-se exclusivamente a endereços de loopback (`127.0.0.1`, `localhost`, `::1`) por padrão; acesso em rede local/LAN, TLS e autenticação multiusuário ficam fora do escopo da v1.
- **Execução com aba fechada (v1)**: fechar todas as abas interrompe a coordenação no navegador; ao reabrir, o histórico aceito pelo Core é reconstruído via catch-up sem reenviar pedidos concluídos.
- **Instalação de CLIs**: os binários do `AionCore v0.2.2`, `codex` e `antigravity` precisam ser instalados e autenticados separadamente na máquina onde os arquivos do workspace residem.
