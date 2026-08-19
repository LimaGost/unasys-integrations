# unasys-integrations

Camada fina de integracoes externas para o **Unasys Tickets**. Este servico Node.js/Express
fica fora do Base44 (que hospeda o frontend, banco de dados e autenticacao do sistema) e
concentra webhooks/endpoints de integracao com sistemas de terceiros, falando com o Base44
atraves do SDK oficial (`@base44/sdk`).

## Arquitetura

```
Gmail / Unasys Flow
              |  (HTTP + token secreto no header x-webhook-token)
              v
      unasys-integrations (Express)
              |  (Base44 SDK, autenticado como usuario de servico)
              v
        Base44 (Unasys Tickets)
   frontend + banco de dados + auth
```

Este projeto **nao** reimplementa banco de dados, autenticacao de usuarios finais nem UI —
essas responsabilidades continuam no Base44. O papel deste servico e:

1. Expor endpoints HTTP publicos para sistemas externos (Gmail, Unasys Flow).
2. Autenticar cada chamada externa por token secreto (webhook token), independente da
   autenticacao de usuarios do Base44.
3. Traduzir/encaminhar esses eventos para o Base44 via `@base44/sdk`.

### Como este servico se autentica no Base44

O SDK do Base44 (`@base44/sdk`) oferece permissoes elevadas ("service role", que ignoram regras
de acesso das entities) **apenas** dentro de backend functions hospedadas no proprio Base44
(`createClientFromRequest`). Como o `unasys-integrations` roda fora do Base44 (nesta VPS), ele
nao pode usar "service role" — em vez disso, autentica como um **usuario comum dedicado a
integracao**, criado no app Unasys Tickets, usando `base44.auth.loginViaEmailPassword()`
([src/services/base44Client.ts](src/services/base44Client.ts)). O SDK guarda o token JWT
resultante e o usa automaticamente nas chamadas seguintes a `base44.entities`/`base44.functions`.
As permissoes desse servico ficam limitadas ao role atribuido a essa conta dentro do Base44 —
configure o role com o menor acesso necessario para cada integracao.

### Estrutura de pastas

```
src/
  index.ts                     servidor Express (bootstrap, middlewares globais, rotas, health check)
  config/env.ts                 carrega e valida variaveis de ambiente (dotenv)
  middleware/
    auth.ts                     middleware de autenticacao por token para webhooks
    asyncHandler.ts              encaminha erros de rotas assincronas ao error handler do Express
    activityLogger.ts             registra toda requisicao no log de atividade em memoria
    dashboardAuth.ts              HTTP Basic Auth do painel (GET /dashboard)
    dashboardConfirm.ts            exige a senha do painel de novo em mudancas sensiveis
  services/
    base44Client.ts              autentica e expoe o client do SDK Base44 (getBase44Client/callBase44)
    base44Entities.ts            acesso tipado as entities do Base44 usadas por esta integracao
    gmailClient.ts                envio (SMTP/nodemailer) e leitura (IMAP/imapflow) do Gmail
    gmailStatus.ts                 guarda o resultado da ultima verificacao da caixa de entrada
    activityLog.ts                 buffer em memoria com as ultimas requisicoes (para o painel)
    dashboardHtml.ts               HTML/CSS/JS do painel (auto-contido, sem dependencias externas)
    configStore.ts                 config editavel em tempo real (Gmail, tokens, integracoes) - ver abaixo
  routes/
    gmail.ts                     POST /send (envia email), POST /poll (forca verificacao da caixa de entrada)
    salesData.ts                  POST /receive (dados de venda do Unasys Flow)
    customIntegrations.ts          POST /webhooks/custom/:slug (captura generica p/ integracoes novas)
    dashboard.ts                   GET /dashboard e as APIs de status/eventos que ele consome
    dashboardActions.ts             botoes de teste do painel (criar ticket teste, forcar poll, etc)
    dashboardSettings.ts            APIs de configuracao do painel (Gmail, tokens, integracoes)
  types/                        tipos TypeScript compartilhados (entities, payloads externos)
```

### Entities do Base44 usadas

Esta integracao le/escreve diretamente nas entities do app Unasys Tickets via
`base44.entities.*` (ver [src/types/entities.ts](src/types/entities.ts) para os campos
completos assumidos de cada uma):

- **Ticket** — chamados de implantacao/suporte.
- **TicketEmail** — emails associados a um ticket (enviados/recebidos via Gmail).
- **TicketEvent** — log de eventos automaticos (ex: "ticket criado via Unasys Flow").
- **SyncState** — cursor de sincronizacao (usado para o ultimo UID de IMAP processado,
  `key="gmail_last_uid"`).

### Autenticacao dos webhooks

Toda rota sob `/webhooks/*` passa primeiro pelo middleware `requireWebhookToken`
([src/middleware/auth.ts](src/middleware/auth.ts)) **antes** de qualquer logica de negocio.
Ele exige um header `x-webhook-token` com o valor exato configurado para aquela integracao.
Requisicoes sem o header, ou com token invalido, recebem `401 Unauthorized`; se o token dessa
integracao ainda nao foi configurado (nem no `.env` nem pelo painel), recebem `503`.

Cada integracao tem seu proprio token para que a rotacao/revogacao de uma nao afete as outras.
Os tokens **nao ficam fixos no `.env`** — ficam em `data/integrations-config.json`
(ver "Configuracoes pelo painel" abaixo) e podem ser vistos/regerados a qualquer momento pelo
painel, sem reiniciar o servico.

### Rotas

Todas as rotas abaixo (exceto `/health`) exigem o header `x-webhook-token` (ver secao anterior).
Erros de chamadas ao Base44/Gmail sao capturados por um error handler central
([src/index.ts](src/index.ts)) e retornados como JSON estruturado — nunca derrubam o processo.

| Metodo | Rota                            | Descricao                                                          |
|--------|----------------------------------|----------------------------------------------------------------------|
| GET    | `/health`                        | health check (nao requer token)                                      |
| POST   | `/webhooks/sales-data/receive`   | cria/atualiza um Ticket a partir de dados de venda do Unasys Flow    |
| POST   | `/webhooks/gmail/send`           | envia um email via SMTP e registra um TicketEmail (`sent`)           |
| POST   | `/webhooks/gmail/poll`           | forca uma verificacao imediata da caixa de entrada (ver abaixo)      |
| POST   | `/webhooks/custom/:slug`         | captura generica de integracoes cadastradas pelo painel (ver abaixo) |
| GET    | `/dashboard`                     | painel web (usuario/senha HTTP Basic, ver abaixo)                    |

`gmail/send` e `gmail/poll` respondem `503 Service Unavailable` enquanto o Gmail nao estiver
configurado (`.env` na primeira vez, ou painel a qualquer momento).

### Painel de acompanhamento (GET /dashboard)

Uma pagina web simples, servida pelo proprio processo (sem build separado, sem framework de
frontend), para ver em tempo real:

- **Status** — se o servico esta autenticado no Base44, se o Gmail esta configurado e quando foi
  a ultima verificacao da caixa de entrada, uptime e memoria do processo.
- **Requisicoes recentes** — as ultimas 150 chamadas em `/webhooks/*` (metodo, rota, status HTTP,
  duracao e um resumo da resposta, ex: `ticket_id=...` ou a mensagem de erro). Atualiza sozinha a
  cada 5 segundos (ou na hora, clicando no botao ⟳ no cabecalho).
- **Acoes** — botoes para criar um Ticket de teste, forcar uma verificacao do Gmail, e mandar um
  email de teste, sem precisar de curl/Postman.
- **Configuracoes** — ver secao dedicada abaixo.

Acesse `https://SEU_DOMINIO/dashboard` — pede usuario/senha (HTTP Basic Auth) configurados em
`DASHBOARD_USER`/`DASHBOARD_PASSWORD`. Sem essas variaveis, a rota responde `503`.

O log de requisicoes fica **em memoria** (nao usa banco de dados) — reiniciar o processo
(`pm2 restart`) limpa o historico, mas nao afeta nada gravado no Base44 nem a configuracao
(essa fica salva em disco, ver abaixo).

### Configuracoes pelo painel (Gmail, tokens, novas integracoes)

A partir da secao "Configuracoes" do painel, sem precisar editar `.env` nem reiniciar o
processo, da para:

- **Trocar as credenciais do Gmail** (usuario + senha de app).
- **Ver e regerar os tokens de webhook** de cada integracao (o token antigo para de funcionar
  na hora que um novo e gerado).
- **Cadastrar uma integracao nova** (nome livre, ex: "Metabot") — o painel gera um endpoint
  (`/webhooks/custom/<slug>`) e um token na hora. Como ainda nao existe logica de negocio
  especifica para essa integracao nova, o endpoint so autentica pelo token e registra o payload
  recebido no log de atividade — util para ver o formato real que o sistema externo manda antes
  de pedir a implementacao de verdade (criar Ticket, etc). Depois disso vira uma rota dedicada,
  igual `gmail.ts`/`salesData.ts`.
- **Remover** uma integracao cadastrada.

**Onde isso fica salvo:** em `data/integrations-config.json`, dentro da pasta do projeto na VPS
— nao no Base44 nem no `.env`. Esse arquivo e criado sozinho na primeira vez que o servico sobe,
semeado a partir das variaveis `WEBHOOK_TOKEN_*`/`GMAIL_*` do `.env` (se existirem). Depois disso,
o `.env` deixa de ser lido para esses valores — o arquivo passa a ser a fonte da verdade. Ele
**nunca** deve ir para o Git (ja esta no `.gitignore`).

**Confirmacao de senha:** qualquer mudanca nesta secao (salvar credenciais do Gmail, regerar um
token, criar/remover uma integracao) exige digitar a senha do painel de novo no campo no topo da
secao, mesmo voce ja estando logado — e uma segunda confirmacao para acoes que mexem em
credenciais de producao, nao so a autenticacao HTTP Basic da pagina.

### Como o recebimento de email funciona (poller, nao webhook)

Diferente do Gmail API (que suporta push notifications via Pub/Sub), a integracao via
SMTP/IMAP com senha de app **nao recebe notificacoes empurradas pelo Google** — o servico
precisa verificar a caixa de entrada periodicamente. Por isso, quando `GMAIL_USER`/
`GMAIL_APP_PASSWORD` estao configurados, o processo mantem um timer interno
([src/index.ts](src/index.ts), `startGmailPoller`) que chama a mesma logica de
`POST /webhooks/gmail/poll` a cada `GMAIL_POLL_INTERVAL_MINUTES` (default 2 minutos),
usando `SyncState` (`key="gmail_last_uid"`) para lembrar o ultimo email ja processado e so
buscar mensagens novas. A rota `POST /webhooks/gmail/poll` continua disponivel para forcar
uma verificacao manual/imediata (util para testar).

### Configurando o Gmail (senha de app - gratis, sem OAuth)

Como `unasysintegracoes@gmail.com` e uma conta Gmail pessoal (nao Google Workspace), esta
integracao usa SMTP/IMAP com uma **"senha de app"** em vez da Gmail API/OAuth2 — evita ter que
criar um projeto no Google Cloud Console e, principalmente, evita a limitacao do OAuth em modo
"Testing" para apps pessoais nao verificados: o refresh token expiraria a cada 7 dias. Senha de
app nao expira e nao exige verificacao do Google.

1. Ative a **verificacao em duas etapas** na conta Google (`myaccount.google.com/security` →
   "Verificacao em duas etapas"). E pre-requisito para gerar senha de app.
2. Gere uma senha de app em `myaccount.google.com/apppasswords` (nome sugerido: "unasys-integrations").
   O Google mostra uma senha de 16 caracteres (ex: `abcd efgh ijkl mnop`) — copie sem espacos.
3. Preencha usuario + senha de app na secao **Configuracoes → Gmail** do painel
   (`https://SEU_DOMINIO/dashboard`) e clique em salvar — nao precisa editar `.env` nem reiniciar
   o servico, o poller comeca a rodar sozinho no proximo ciclo. Alternativa (so vale para a
   primeira execucao do servico, antes de existir `data/integrations-config.json`): preencher
   `GMAIL_USER`/`GMAIL_APP_PASSWORD` no `.env`.

### Decisoes pendentes / TODOs conhecidos

Alguns pontos foram implementados com um valor padrao razoavel, documentado em comentario
`TODO` no codigo, ate a regra de negocio real ser confirmada:

- **Payload real do Unasys Flow** — os campos assumidos em
  [src/types/salesData.ts](src/types/salesData.ts) sao uma hipotese razoavel; ajuste-os assim
  que o formato real for confirmado.
- **`Ticket.urgency`** — o payload de vendas do Unasys Flow nao informa urgencia; o Ticket e
  criado com `urgency: "media"` por padrao (`src/routes/salesData.ts`).
- **`Ticket.client_id`** — assumido como igual a `customer_code` do payload do Unasys Flow, na
  falta de um ID de cliente explicito.
- **Vertical de tickets de suporte criados via email** — nao ha como inferir o vertical correto
  apenas pelo remetente; usa-se o padrao configuravel `GMAIL_DEFAULT_SUPPORT_VERTICAL`
  (`src/routes/gmail.ts`). Uma regra futura poderia mapear por dominio do remetente, por exemplo.
- **Vinculo de email a ticket existente** — o poller tenta achar o ticket certo nesta ordem:
  (1) `TicketEmail.gmail_thread_id` igual ao thread ID do Gmail (extensao IMAP, funciona sem a
  Gmail API), (2) `TicketEmail.rfc_message_id` igual ao header `In-Reply-To` do email recebido,
  (3) `Ticket.client_email` igual ao remetente. Se nada bater, cria um Ticket novo. Ajuste essa
  ordem se a regra de negocio real for diferente (`src/routes/gmail.ts`, funcao `runGmailPoll`).

## Rodando localmente

Pre-requisitos: Node.js 18+.

```bash
npm install
cp .env.example .env
# preencha .env com os valores reais (ver secao abaixo)
npm run dev
```

O servidor sobe em `http://localhost:3000` por padrao (`PORT` no `.env`). Teste com:

```bash
curl http://localhost:3000/health
```

### Variaveis de ambiente

Veja [.env.example](.env.example) para a lista completa. As obrigatorias sao:

- `BASE44_APP_ID` — ID do app Base44, encontrado na URL do editor.
- `BASE44_SERVICE_ACCOUNT_EMAIL` / `BASE44_SERVICE_ACCOUNT_PASSWORD` — credenciais de um
  usuario dedicado a esta integracao, criado dentro do app Unasys Tickets (ver secao acima).
- `DASHBOARD_USER` / `DASHBOARD_PASSWORD` — login do painel em `/dashboard`. Sem essas variaveis,
  o painel responde `503`. Essas **nao** ficam no `data/integrations-config.json` (continuam so
  no `.env`) — sao a "chave mestra" para acessar e editar todo o resto.

As variaveis abaixo sao lidas **so na primeira execucao**, para semear
`data/integrations-config.json` (ver "Configuracoes pelo painel" acima). Depois disso, edite
tudo pelo painel — nao precisa mais mexer no `.env` nem reiniciar o servico:

- `WEBHOOK_TOKEN_GMAIL`, `WEBHOOK_TOKEN_SALES_DATA` — tokens secretos aleatorios (ex:
  `openssl rand -hex 32`) exigidos no header `x-webhook-token` de cada integracao. Pode deixar
  em branco e configurar direto pelo painel na primeira vez que acessar.
- `GMAIL_USER` — endereco Gmail usado para enviar/ler email (ex: `unasysintegracoes@gmail.com`).
- `GMAIL_APP_PASSWORD` — senha de app de 16 caracteres gerada em
  `myaccount.google.com/apppasswords` (ver secao "Configurando o Gmail" acima). Requer
  verificacao em duas etapas ativada na conta.

As variaveis abaixo continuam sendo lidas do `.env` normalmente (nao fazem parte da config
editavel pelo painel):

- `GMAIL_DEFAULT_SUPPORT_VERTICAL` — vertical padrao para tickets de suporte criados a partir de
  email (default `"geral"` se omitida).
- `GMAIL_POLL_INTERVAL_MINUTES` — intervalo entre verificacoes automaticas da caixa de entrada
  (default `2` se omitida).

### Scripts disponiveis

- `npm run dev` — inicia o servidor em modo desenvolvimento com hot-reload (`tsx watch`).
- `npm run build` — compila o TypeScript para `dist/` (`tsc`).
- `npm start` — roda a versao compilada (`node dist/index.js`). Use apos `npm run build`.
- `npm run typecheck` — checagem de tipos sem gerar arquivos.

### Testando as rotas localmente (curl)

Com o servidor rodando (`npm run dev`) e os tokens configurados no `.env`, substitua
`SEU_TOKEN_*` pelos valores reais de `WEBHOOK_TOKEN_*`:

**Unasys Flow — dados de venda**

```bash
curl -X POST http://localhost:3000/webhooks/sales-data/receive \
  -H "Content-Type: application/json" \
  -H "x-webhook-token: SEU_TOKEN_SALES_DATA" \
  -d '{
    "order_number": "PED-001",
    "customer_code": "CLI-001",
    "client_name": "Cliente Teste",
    "client_email": "cliente@teste.com",
    "vertical": "varejo",
    "modulos": ["financeiro", "estoque"],
    "observacoes": "Implantacao prioritaria"
  }'
```

**Gmail — enviar email** (requer `GMAIL_USER`/`GMAIL_APP_PASSWORD` configurados no `.env`)

```bash
curl -X POST http://localhost:3000/webhooks/gmail/send \
  -H "Content-Type: application/json" \
  -H "x-webhook-token: SEU_TOKEN_GMAIL" \
  -d '{
    "ticket_id": "ID_DE_UM_TICKET_EXISTENTE",
    "to": ["destinatario@teste.com"],
    "subject": "Atualizacao do seu chamado",
    "body": "Ola, seu chamado foi atualizado."
  }'
```

**Gmail — forcar verificacao da caixa de entrada agora** (normalmente isso roda sozinho a cada
`GMAIL_POLL_INTERVAL_MINUTES`; use esta chamada so para testar sem esperar o timer):

```bash
curl -X POST http://localhost:3000/webhooks/gmail/poll \
  -H "x-webhook-token: SEU_TOKEN_GMAIL"
```

> Na primeira execucao, como ainda nao existe `SyncState` (`key="gmail_last_uid"`), esta chamada
> so grava o cursor inicial (UID mais recente da caixa de entrada) sem processar o historico
> existente — evita reprocessar a caixa toda de uma vez. A partir da segunda chamada (ou do
> proximo ciclo do timer), emails novos desde a ultima verificacao sao processados normalmente.

Em qualquer rota, omitir o header `x-webhook-token` (ou enviar um valor errado) deve retornar
`401 Unauthorized`; um payload com campos obrigatorios faltando deve retornar `400 Bad Request`.

## Deploy na VPS Hostinger (PM2)

Este servico e implantado como um processo PM2 chamado `unasys-api` em uma VPS Hostinger. Fluxo
sugerido a partir da sua maquina local:

### 1. Build local

```bash
npm run build
```

### 2. Empacotar e enviar para a VPS

```bash
tar --exclude=node_modules --exclude=.git -czf unasys-integrations.tar.gz \
  dist package.json package-lock.json .env.example README.md

scp unasys-integrations.tar.gz usuario@SEU_IP_VPS:/home/usuario/apps/
```

> Nao inclua o arquivo `.env` no tar. Configure as variaveis de ambiente diretamente na VPS
> (arquivo `.env` proprio do servidor, fora do controle de versao).

### 3. Na VPS: extrair e instalar dependencias de producao

```bash
ssh usuario@SEU_IP_VPS
cd /home/usuario/apps
mkdir -p unasys-integrations && tar -xzf unasys-integrations.tar.gz -C unasys-integrations
cd unasys-integrations
npm install --omit=dev
cp .env.example .env   # na primeira vez; depois so edite os valores
nano .env               # preencha com os valores reais de producao
```

### 4. Subir/atualizar o processo com PM2

Primeira vez:

```bash
pm2 start dist/index.js --name unasys-api
pm2 save
pm2 startup   # segue as instrucoes impressas para iniciar o PM2 no boot da VPS
```

Deploys seguintes (apos repetir os passos 1-3 com o codigo atualizado):

```bash
pm2 restart unasys-api
```

### 5. Verificar

```bash
pm2 status unasys-api
pm2 logs unasys-api
curl http://localhost:3000/health
```

Se a VPS tiver Nginx configurado como proxy reverso, aponte o `location` correspondente para
`http://localhost:3000` (ou a porta configurada em `PORT`) e mantenha o certificado TLS na
camada do Nginx.

## Proximos passos

- Confirmar o formato real do payload do Unasys Flow e ajustar
  [src/types/salesData.ts](src/types/salesData.ts).
- Definir a regra de negocio para `Ticket.urgency` (venda) e para o vertical de tickets de
  suporte criados via email (ver secao "Decisoes pendentes / TODOs conhecidos").
- Preencher a senha de app do Gmail pelo painel (ver secao "Configurando o Gmail") para ativar
  o envio e o poller automatico da caixa de entrada.
- Implementar a logica de negocio de verdade para integracoes cadastradas via painel como
  "genericas" (`/webhooks/custom/:slug`), depois de ver o formato real do payload no log.
- Validar os nomes exatos das entities/campos do Base44 em produtos reais antes do primeiro
  deploy (os schemas em [src/types/entities.ts](src/types/entities.ts) foram fornecidos pela
  especificacao da tarefa, mas nao foram conferidos contra o app Base44 real).
