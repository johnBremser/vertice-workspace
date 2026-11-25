# Melhoria futura — migração da persistência do Vértice de IndexedDB para SQLite

Status: proposta planejada no backlog, sem implementação nesta etapa.  
Data: 25/11/2026.

## Objetivo

Substituir o armazenamento principal do Vértice Workspace no navegador (**IndexedDB**, banco `aion_desk_storage`) por um arquivo **SQLite dedicado no servidor local Node** (ex.: `vertice-workspace.db`), mantendo separação total do banco próprio do AionCore (`aionui-backend.db`).

Com isso, projetos, conversas, perfis de participantes, presets de equipe, tarefas, contexto compartilhado e histórico deixam de depender do cache/perfil de um navegador específico e passam a residir em disco local sob controle do usuário.

---

## Contexto técnico atual (estado observado no código)

- **`src/services/storage.ts`**:
  - Define a abstração `StorageDriver` (`load()`, `save(state)`, `clear()`).
  - Implementa `IndexedDbStorageDriver`, gravando todo o `WorkspaceStoreState` serializado em uma única entrada (`DB_NAME = 'aion_desk_storage'`, `STORE_NAME = 'workspace'`, `ROOT_KEY = 'root_state'`).
  - Gerencia fila de escrita com debounce (`180ms`) e status (`loading`, `saving`, `saved`, `session_only`) via `WorkspacePersistenceManager`.
  - Preferências leves de interface (`theme`, `sidebarCollapsed`, `drawerOpen`, `drawerTab`) ficam em `window.localStorage` (`PREFS_KEY = 'aion_desk_ui_prefs_v1'`).
- **`scripts/vertice-server.mjs` e `vite.config.ts`**:
  - O Vértice já opera com servidor HTTP Node local em produção/launcher (`scripts/vertice-server.mjs`) e middleware equivalente no `vite dev` (`vite.config.ts`), hospedando rotas internas seguras como `vertice-source-reader.mjs` e `vertice-folder-picker.mjs`.
  - Por padrão, aceita apenas loopback (`127.0.0.1`, `localhost`, `::1` via `isLoopbackHost`).
- **`scripts/vertice-ctl.mjs`**:
  - Exige runtime Node `>= 22.12` / `24` / `>= 26` (`isSupportedNodeVersion`), versões que já incluem módulo nativo de SQLite (`node:sqlite`) sem necessidade de compilação nativa C++ em Windows, caso adotado após validação da flag/estabilidade na versão alvo.

---

## Por que migrar (benefícios práticos)

1. **Durabilidade independente do navegador:** limpar dados de navegação, usar janela anônima ou alternar entre Chrome/Edge/Firefox não apaga o workspace nem obriga a reimportar backup manual.
2. **Arquivo único portátil para backup:** um `.sqlite` no diretório de dados local do usuário facilita cópia de segurança, inspeção e suporte, complementando o botão `Exportar / Backup` JSON já existente.
3. **Caminho evolutivo para escalabilidade:** permite sair do modelo de blob único (`root_state`) para persistência incremental por conversa/evento quando o volume de projetos e histórico crescer.
4. **Visibilidade única de estado:** múltiplas abas no mesmo computador enxergam a mesma fonte de verdade no servidor local, desde que protegidas por controle de concorrência.

---

## Arquitetura proposta

### 1. Localização do banco e isolamento

- Arquivo sugerido por padrão (Windows):  
  `%LOCALAPPDATA%\VerticeWorkspace\vertice-data\vertice-workspace.db`  
  (ou variável de ambiente explícita `VERTICE_DB_PATH` / `VERTICE_DATA_DIR`, mantendo padrão compatível em Linux/macOS via XDG/home).
- **Não** armazenar dentro da pasta do repositório (`.git`) nem misturar com `aionui-backend.db` do AionCore.
- Aplicar restrição de ACL de arquivo privado para o usuário atual no Windows (reaproveitando o padrão de `restrictPrivateFileAcl` em `scripts/vertice-ctl.mjs`).
- Configurar SQLite para acesso local seguro:
  - `PRAGMA journal_mode = WAL;`
  - `PRAGMA synchronous = NORMAL;`
  - `PRAGMA busy_timeout = 5000;`
  - `PRAGMA foreign_keys = ON;`

### 2. Estratégia em duas fases

#### Fase 1 — `StorageDriver` HTTP + Snapshot versionado no SQLite (menor risco)

Mantém o contrato atual de `WorkspaceStoreState` na UI e troca o backend de persistência sem reescrever de imediato todos os seletores e o reducer:

1. **Módulo Node compartilhado (`scripts/vertice-storage-sqlite.mjs`):**
   - Montado tanto em `scripts/vertice-server.mjs` (build/launcher) quanto em `vite.config.ts` (`npm run dev`).
   - Rotas locais sob `/_vertice/storage/*`:
     - `GET /_vertice/storage/status`: informa disponibilidade, caminho do `.sqlite`, tamanho do arquivo, `revision` atual e origem da última migração.
     - `GET /_vertice/storage/state`: retorna `{ exists, revision, schemaVersion, updatedAt, state }`.
     - `PUT /_vertice/storage/state`: recebe `{ baseRevision, state }`, valida integridade mínima/limite de tamanho e executa gravação transacional atômica incrementando `revision` (`UPDATE ... WHERE id = 'root' AND revision = ?`).
     - `DELETE /_vertice/storage/state`: limpa/reseta explicitamente quando acionado pelo usuário (opcionalmente gerando snapshot de backup prévio `.bak`).
2. **Schema mínimo inicial:**
   - `workspace_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)` — guarda `schema_version`, `migrated_from_indexeddb_at`, etc.
   - `workspace_snapshots (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, schema_version INTEGER NOT NULL, payload_json TEXT NOT NULL, updated_at TEXT NOT NULL)`.
   - `ui_preferences (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at TEXT NOT NULL)` — opcional para sincronizar também preferências de UI entre navegadores.
3. **Driver no frontend (`HttpSqliteStorageDriver` em `src/services/storage.ts`):**
   - Implementa `StorageDriver` com `load()`, `save(state)` e `clear()`.
   - Armazena em memória a `revision` carregada para enviá-la como `baseRevision` nos saves seguintes.

#### Fase 2 — Normalização incremental por entidades (escalabilidade)

Quando o tamanho único de `payload_json` começar a impactar latência de `JSON.stringify` / escrita em disco:

1. Criar tabelas relacionais dedicadas:
   - `projects`, `conversations`, `participants`, `team_presets`, `participant_profiles`,
   - `messages`, `tasks`, `task_attempts`, `task_reviews`,
   - `context_revisions`, `execution_events`,
   - `assistant_config`, `assistant_messages`.
2. Índices por `(conversation_id, seq)` e `(conversation_id, timestamp)`.
3. Trocar `PUT /state` (snapshot completo) por endpoints de mutação granular / append de eventos e carregamento sob demanda das conversas inativas (lazy loading de histórico antigo), mantendo `Exportar / Backup` gerando o JSON consolidado sob demanda.

---

## Controle de concorrência (múltiplas abas)

Ponto crítico identificado antes de implementar:

- Se duas abas abrirem o mesmo estado em `revision = 10` e ambas editarem conversas diferentes:
  - Sem controle de versão, a segunda escrita sobrescreve silenciosamente as mudanças da primeira (*lost update*).
- **Mitigação na Fase 1:**
  - Todo `PUT /_vertice/storage/state` exige `baseRevision`.
  - Se `baseRevision !== revision_atual` no SQLite, o servidor responde **`HTTP 409 Conflict`** com `{ currentRevision, updatedAt }`.
  - O cliente exibe aviso acionável (ex.: opção de **Recarregar do banco** mantendo cópia de segurança ou **Exportar estado atual** antes de mesclar), nunca sobrescrevendo em silêncio.
  - Complementar opcionalmente com `BroadcastChannel('vertice_storage_sync')` no navegador para avisar outras abas abertas na mesma origem quando uma nova `revision` for gravada.
- **Mitigação definitiva na Fase 2:** escritas por conversa/evento reduzem conflitos globais a nível de linha/entidade.

---

## Plano de migração automática (`IndexedDB -> SQLite`)

Executado de forma transparente no primeiro boot após habilitar o backend SQLite:

1. Frontend consulta `GET /_vertice/storage/state`.
2. **Caso A — SQLite já possui estado (`exists: true`):**
   - Carrega normalmente do SQLite (fonte de verdade única).
   - Se o navegador ainda tiver estado no IndexedDB local, não sobrescreve o SQLite automaticamente; registra apenas diagnóstico informativo caso haja divergência relevante.
3. **Caso B — SQLite está vazio (`exists: false`):**
   - Frontend tenta ler `IndexedDbStorageDriver.load()` no navegador atual.
   - Se encontrar dados válidos no IndexedDB:
     - Executa `migrateWorkspaceState(...)` do domínio.
     - Envia `PUT /_vertice/storage/state` com `baseRevision = 0` e flag `migrationSource: 'indexeddb'`.
     - Registra `migrated_from_indexeddb_at` em `workspace_meta`.
   - Se IndexedDB também estiver vazio, inicializa estado limpo (`createInitialWorkspaceState()`).
4. **Política de retenção do IndexedDB antigo:**
   - **Não apagar** `aion_desk_storage` imediatamente após a migração da primeira execução; mantê-lo congelado como cópia fria de segurança (ex.: oferecendo na tela de Configurações um botão para descartar o legado do navegador quando o usuário confirmar que está tudo íntegro).

---

## Segurança, limites e fallback

- **Loopback e validação de origem:**
  - As rotas `/_vertice/storage/*` devem obedecer estritamente ao modo loopback por padrão.
  - Caso `ALLOW_NON_LOOPBACK=true` venha a ser usado no futuro, exigirá autenticação explícita antes de aceitar leitura/escrita no banco (nunca expor dados locais sem sessão).
- **Validação de payload:**
  - Verificar `Content-Type: application/json`, limite máximo configurável de corpo (ex.: 50 MB na Fase 1 com aviso preventivo se aproximar do teto) e estrutura mínima válida de `WorkspaceStoreState` antes de confirmar `COMMIT`.
- **Fallback se a rota SQLite não existir (ex.: build estático puro sem Node):**
  - Documentar se deve cair com aviso claro para `IndexedDbStorageDriver` apenas quando o endpoint `/_vertice/storage/status` retornar `404` explícito, ou exigir servidor Vértice ativo (`session_only` em erro real de E/S) — **nunca** mascarar falha real de gravação em disco como sucesso.
- **Backup JSON preservado:**
  - `Exportar / Backup` e `Importar Backup` continuam idênticos na interface; importar backup apenas valida `schemaVersion`, gera uma nova revisão (`revision + 1`) no SQLite e preserva a rastreabilidade.

---

## Manutenção e observabilidade

- Exibir em **Configurações -> Armazenamento**:
  - Backend ativo (`SQLite local` vs `IndexedDB legado` vs `Somente sessão`).
  - Caminho do arquivo `.sqlite`, revisão atual, tamanho em disco (incluindo WAL) e data da última gravação.
  - Ação explícita de **Compactar banco (`VACUUM` / checkpoint WAL)** quando desejado e botão de **Exportar Backup JSON**.
- Em testes automatizados e E2E (`vitest` / `playwright`):
  - Sempre apontar `VERTICE_DB_PATH` para diretório temporário isolado (`os.tmpdir()`), garantindo que testes nunca toquem o banco real do usuário.

---

## Ordem sugerida de execução

1. Definir driver Node (`node:sqlite` na versão suportada pelo launcher, com verificação em `vertice-ctl doctor` e testes unitários no runtime oficial Node v24).
2. Implementar `scripts/vertice-storage-sqlite.mjs` + testes de contrato (CRUD, WAL, escrita concorrente/`409 Conflict`, escrita atômica e ACL no Windows).
3. Integrar rotas `/_vertice/storage/*` em `scripts/vertice-server.mjs` e `vite.config.ts`.
4. Implementar `HttpSqliteStorageDriver` e fluxo de migração única `IndexedDB -> SQLite` em `src/services/storage.ts` + banner de conflito de revisão na UI.
5. Atualizar `VerticeWorkspace` E2E e `localServerProxy.test.ts` usando `VERTICE_DB_PATH` temporário isolado.
6. Planejar Fase 2 (tabelas normalizadas + paginação de `execution_events`) apenas após estabilização da Fase 1 em uso real.

---

## Critérios de aceitação (para quando for implementado)

1. Projetos, conversas e histórico criados no Chrome aparecem intactos ao abrir o Vértice em outro navegador ou janela anônima na mesma máquina.
2. Limpar cache e site data no navegador não apaga nenhum projeto, conversa ou configuração persistida no Vértice.
3. No primeiro carregamento após atualização, dados pré-existentes no IndexedDB (`aion_desk_storage`) são migrados automaticamente para `vertice-workspace.db` sem perda nem duplicação.
4. Duas abas abertas tentando gravar a partir da mesma revisão antiga recebem conflito explícito (`409 Conflict`) em vez de sobrescrita silenciosa.
5. `Exportar / Backup` e `Importar Backup` funcionam sobre o estado salvo no SQLite sem regressão.
6. Nenhum teste automatizado lê ou escreve no arquivo real de produção do usuário.
