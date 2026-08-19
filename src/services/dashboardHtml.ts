export const DASHBOARD_HTML = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>unasys-integrations · painel</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #f5f6f8;
    --surface: #ffffff;
    --surface-2: #eceef2;
    --ink: #10151f;
    --ink-muted: #5b6472;
    --border: #dbdfe6;
    --accent: #256b7a;
    --ok: #1f8a4c;
    --ok-soft: #e4f5ea;
    --pending: #b9791a;
    --pending-soft: #fbf0dd;
    --crit: #c1392b;
    --crit-soft: #fbe7e4;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0a0f16;
      --surface: #111826;
      --surface-2: #17202e;
      --ink: #e7ecf3;
      --ink-muted: #93a1b4;
      --border: #253044;
      --accent: #5fb9cb;
      --ok: #4cc787;
      --ok-soft: #123322;
      --pending: #e3a63d;
      --pending-soft: #3a2c10;
      --crit: #e8695d;
      --crit-soft: #3a1714;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--ink);
    font-family: "Segoe UI", -apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, sans-serif;
    line-height: 1.5;
  }
  .page { max-width: 980px; margin: 0 auto; padding: 32px 20px 56px; display: flex; flex-direction: column; gap: 24px; }
  header { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; border-bottom: 1px solid var(--border); padding-bottom: 16px; }
  h1 { margin: 0; font-size: 22px; font-weight: 700; }
  .sub { font-size: 12.5px; color: var(--ink-muted); font-family: ui-monospace, "Cascadia Code", Consolas, monospace; }
  .pill { display: inline-flex; align-items: center; gap: 6px; padding: 4px 11px; border-radius: 999px; font-size: 11.5px; font-weight: 700; letter-spacing: .03em; text-transform: uppercase; white-space: nowrap; }
  .pill::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
  .pill.ok { background: var(--ok-soft); color: var(--ok); }
  .pill.pending { background: var(--pending-soft); color: var(--pending); }
  .pill.crit { background: var(--crit-soft); color: var(--crit); }
  .header-actions { display: flex; align-items: center; gap: 10px; }
  .refresh-btn {
    width: 30px; height: 30px; border-radius: 50%; border: 1px solid var(--border);
    background: var(--surface); color: var(--ink-muted); cursor: pointer;
    display: inline-flex; align-items: center; justify-content: center;
    font-size: 15px; line-height: 1; padding: 0;
  }
  .refresh-btn:hover { border-color: var(--accent); color: var(--accent); }
  .refresh-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .refresh-btn.spinning { animation: spin .7s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .refresh-btn.spinning { animation: none; } }
  .stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; }
  .stat { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 14px; display: flex; flex-direction: column; gap: 5px; }
  .stat-label { font-size: 10.5px; font-weight: 600; letter-spacing: .05em; text-transform: uppercase; color: var(--ink-muted); }
  .stat-value { font-size: 15px; font-weight: 700; }
  .stat-sub { font-size: 11.5px; color: var(--ink-muted); font-family: ui-monospace, "Cascadia Code", Consolas, monospace; }
  h2 { font-size: 12.5px; font-weight: 700; letter-spacing: .05em; text-transform: uppercase; color: var(--ink-muted); margin: 0 0 10px; }
  .table-wrap { overflow-x: auto; border: 1px solid var(--border); border-radius: 10px; background: var(--surface); }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid var(--border); white-space: nowrap; }
  th { font-size: 10.5px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; color: var(--ink-muted); background: var(--surface-2); position: sticky; top: 0; }
  tr:last-child td { border-bottom: none; }
  td.mono { font-family: ui-monospace, "Cascadia Code", Consolas, monospace; }
  td.summary { white-space: normal; color: var(--ink-muted); font-family: ui-monospace, "Cascadia Code", Consolas, monospace; font-size: 12px; }
  .status-code { font-weight: 700; }
  .status-code.ok-text { color: var(--ok); }
  .status-code.err-text { color: var(--crit); }
  .empty { padding: 24px; text-align: center; color: var(--ink-muted); font-size: 13px; }
  .refresh-note { font-size: 11.5px; color: var(--ink-muted); }
  .actions { display: flex; flex-wrap: wrap; gap: 10px; }
  button.action {
    font: inherit; font-size: 13px; font-weight: 600; cursor: pointer;
    padding: 9px 16px; border-radius: 8px; border: 1px solid var(--border);
    background: var(--surface); color: var(--ink);
  }
  button.action:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); }
  button.action:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  button.action:disabled { opacity: .45; cursor: not-allowed; }
  .action-result { font-size: 12.5px; font-family: ui-monospace, "Cascadia Code", Consolas, monospace; min-height: 1.2em; }
  .action-result.ok-text { color: var(--ok); }
  .action-result.err-text { color: var(--crit); }
  #eventsBody tr.flash { animation: flash 1.2s ease-out; }
  @keyframes flash { from { background: var(--accent); opacity: .18; } to { background: transparent; } }
  @media (prefers-reduced-motion: reduce) { #eventsBody tr.flash { animation: none; } }

  input[type="text"], input[type="password"] {
    font: inherit; font-size: 13px; padding: 8px 10px; border-radius: 8px;
    border: 1px solid var(--border); background: var(--surface); color: var(--ink);
    min-width: 0;
  }
  input[type="text"]:focus-visible, input[type="password"]:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  input[readonly] { color: var(--ink-muted); font-family: ui-monospace, "Cascadia Code", Consolas, monospace; font-size: 12px; }
  label { font-size: 11.5px; color: var(--ink-muted); }

  .settings-confirm {
    display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
    background: var(--pending-soft); border: 1px solid var(--pending); border-radius: 10px;
    padding: 10px 14px;
  }
  .settings-confirm input { flex: 1; min-width: 180px; }
  .settings-block {
    background: var(--surface); border: 1px solid var(--border); border-radius: 10px;
    padding: 16px; display: flex; flex-direction: column; gap: 10px;
  }
  .settings-block h3 { margin: 0; font-size: 13px; font-weight: 700; }
  .settings-block-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
  .settings-desc { margin: 0; font-size: 12.5px; color: var(--ink-muted); max-width: 68ch; }
  .settings-desc a { color: var(--accent); }
  .settings-divider { border: none; border-top: 1px solid var(--border); margin: 2px 0; }
  .field { display: flex; flex-direction: column; gap: 4px; flex: 1; min-width: 160px; }
  .field span { font-size: 11px; font-weight: 600; letter-spacing: .03em; text-transform: uppercase; color: var(--ink-muted); }
  .settings-row { display: flex; gap: 10px; flex-wrap: wrap; align-items: flex-end; }
  .settings-row input { min-width: 160px; }
  .token-row { display: flex; align-items: center; gap: 8px; }
  .token-label { font-size: 12.5px; color: var(--ink-muted); width: 110px; flex: none; }
  .token-row input { flex: 1; }
  button.action.small { padding: 6px 12px; font-size: 12px; }
  button.action.danger:hover:not(:disabled) { border-color: var(--crit); color: var(--crit); }
  .integration-item {
    display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
    padding: 8px 0; border-bottom: 1px solid var(--border);
  }
  .integration-item:last-child { border-bottom: none; }
  .integration-item .name { font-weight: 600; font-size: 13px; width: 140px; flex: none; }
  .integration-item input { flex: 1; min-width: 140px; }
  .empty-note { font-size: 12.5px; color: var(--ink-muted); }
</style>
</head>
<body>
<div class="page">
  <header>
    <div>
      <h1>unasys-integrations</h1>
      <div class="sub" id="subline">carregando...</div>
    </div>
    <div class="header-actions">
      <button class="refresh-btn" id="btnRefresh" type="button" title="Atualizar agora" aria-label="Atualizar status e requisicoes agora">⟳</button>
      <span class="pill" id="overallPill">verificando</span>
    </div>
  </header>

  <section class="stats" id="stats" aria-label="Status"></section>

  <section aria-label="Acoes">
    <h2>Acoes</h2>
    <div class="actions">
      <button class="action" id="btnTestSales" type="button">Criar ticket de teste (vendas)</button>
      <button class="action" id="btnGmailPoll" type="button" disabled>Verificar caixa de entrada agora</button>
      <button class="action" id="btnTestGmailSend" type="button" disabled>Enviar email de teste</button>
    </div>
    <div class="action-result" id="actionResult"></div>
  </section>

  <section aria-label="Requisicoes recentes">
    <h2>Requisicoes recentes</h2>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Hora</th>
            <th>Metodo</th>
            <th>Rota</th>
            <th>Status</th>
            <th>Duracao</th>
            <th>Resumo</th>
          </tr>
        </thead>
        <tbody id="eventsBody"></tbody>
      </table>
      <div class="empty" id="emptyState" style="display:none;">Nenhuma requisicao registrada ainda.</div>
    </div>
    <div class="refresh-note">Atualiza sozinho a cada 5s.</div>
  </section>

  <section aria-label="Configuracoes">
    <h2>Configuracoes</h2>

    <div class="settings-confirm">
      <label for="confirmPassword">Senha do painel, para confirmar qualquer mudanca abaixo:</label>
      <input type="password" id="confirmPassword" autocomplete="off" placeholder="senha do painel">
    </div>

    <div class="settings-block">
      <div class="settings-block-head">
        <h3>Vendas · Unasys Flow</h3>
        <span class="pill" id="salesDataStatusPill">verificando</span>
      </div>
      <p class="settings-desc">
        Recebe os dados de uma venda e cria (ou atualiza, se o pedido ja existir) um Ticket de
        implantacao no Base44. O Unasys Flow chama
        <code>POST /webhooks/sales-data/receive</code> com o token abaixo no header
        <code>x-webhook-token</code>.
      </p>
      <div class="token-row">
        <span class="token-label">URL</span>
        <input type="text" id="urlSalesData" readonly>
      </div>
      <div class="token-row">
        <span class="token-label">Token</span>
        <input type="text" id="tokenSalesData" readonly>
        <button class="action small" type="button" data-integration="salesData">Gerar novo</button>
      </div>
      <div class="token-row">
        <span class="token-label">Cadastrado em</span>
        <input type="text" id="noteSalesData" placeholder="ex: Base44 &gt; Unasys Flow &gt; Secrets &gt; UNASYS_INTEGRATIONS_SALES_TOKEN">
        <button class="action small" type="button" data-note-integration="salesData">Salvar</button>
      </div>
      <div class="action-result" id="salesDataTokenResult"></div>
    </div>

    <div class="settings-block">
      <div class="settings-block-head">
        <h3>Email · enviar e receber</h3>
        <span class="pill" id="gmailStatusPill">verificando</span>
      </div>
      <p class="settings-desc">
        Uma unica credencial e usada nas duas direcoes: <strong>enviar</strong> email
        (<code>POST /webhooks/gmail/send</code>) e <strong>ler</strong> a caixa de entrada
        sozinho a cada poucos minutos. Funciona com qualquer caixa de email por SMTP/IMAP — Gmail
        (com <a href="https://myaccount.google.com/apppasswords" target="_blank" rel="noopener">senha de app</a>,
        exige verificacao em duas etapas) ou um email de hospedagem tipo Hostinger (senha normal da
        caixa). Se o servidor abaixo ficar em branco, assume Gmail.
      </p>
      <div class="settings-row">
        <label class="field"><span>Usuario</span>
          <input type="text" id="gmailUserInput" placeholder="usuario@dominio.com" autocomplete="off">
        </label>
        <label class="field"><span>Senha</span>
          <input type="password" id="gmailAppPasswordInput" placeholder="senha de app (Gmail) ou senha normal (outros)" autocomplete="off">
        </label>
        <button class="action" id="btnSaveGmail" type="button">Salvar credenciais</button>
      </div>
      <div class="settings-row">
        <label class="field"><span>Servidor SMTP (envio)</span>
          <input type="text" id="smtpHostInput" placeholder="smtp.gmail.com (padrao)" autocomplete="off">
        </label>
        <label class="field"><span>Porta SMTP</span>
          <input type="text" id="smtpPortInput" placeholder="465" autocomplete="off">
        </label>
        <label class="field"><span>Servidor IMAP (recebimento)</span>
          <input type="text" id="imapHostInput" placeholder="imap.gmail.com (padrao)" autocomplete="off">
        </label>
        <label class="field"><span>Porta IMAP</span>
          <input type="text" id="imapPortInput" placeholder="993" autocomplete="off">
        </label>
      </div>
      <div class="action-result" id="gmailSettingsResult"></div>

      <hr class="settings-divider">

      <p class="settings-desc">
        Token que o botao "Enviar email de teste" e qualquer sistema externo que precise chamar
        <code>POST /webhooks/gmail/send</code> devem usar no header <code>x-webhook-token</code>.
      </p>
      <div class="token-row">
        <span class="token-label">URL</span>
        <input type="text" id="urlGmail" readonly>
      </div>
      <div class="token-row">
        <span class="token-label">Token</span>
        <input type="text" id="tokenGmail" readonly>
        <button class="action small" type="button" data-integration="gmail">Gerar novo</button>
      </div>
      <div class="token-row">
        <span class="token-label">Cadastrado em</span>
        <input type="text" id="noteGmail" placeholder="ex: quem dispara este webhook e onde">
        <button class="action small" type="button" data-note-integration="gmail">Salvar</button>
      </div>
      <div class="action-result" id="gmailTokenResult"></div>
    </div>

    <div class="settings-block">
      <div class="settings-block-head">
        <h3>Botao "Enviar E-mail" do Ticket (Base44)</h3>
        <span class="pill" id="emailButtonStatusPill">verificando</span>
      </div>
      <p class="settings-desc">
        Token exclusivo usado pelo botao "Enviar E-mail" dentro do Ticket, no proprio Base44 — ele
        chama <code>POST /public/email/send</code> direto do navegador do usuario (sem passar por
        nenhuma function do Base44, para nao gastar credito de integracao la). Por ficar visivel no
        codigo-fonte do frontend do Base44, esse token e separado dos outros e a rota so aceita
        chamadas vindas do dominio do app.
      </p>
      <div class="token-row">
        <span class="token-label">URL</span>
        <input type="text" id="urlEmailButton" readonly>
      </div>
      <div class="token-row">
        <span class="token-label">Token</span>
        <input type="text" id="tokenEmailButton" readonly>
        <button class="action small" type="button" data-integration="emailButton">Gerar novo</button>
      </div>
      <div class="token-row">
        <span class="token-label">Cadastrado em</span>
        <input type="text" id="noteEmailButton" placeholder="ex: Base44 &gt; EmailComposerPanel.jsx / ActivityPanel.jsx / EmailComposer.jsx">
        <button class="action small" type="button" data-note-integration="emailButton">Salvar</button>
      </div>
      <div class="action-result" id="emailButtonTokenResult"></div>
    </div>

    <div class="settings-block">
      <div class="settings-block-head">
        <h3>Diretorio de usuarios (Etapa 2 - ainda sem uso)</h3>
        <span class="pill" id="userDirectoryStatusPill">verificando</span>
      </div>
      <p class="settings-desc">
        Preparo para tirar <code>listInternalUsers</code> do Base44 (rota <code>GET /public/users/list</code>).
        Ainda nao esta ligado a nenhum lugar do Base44 - gerar o token aqui so deixa pronto pra quando
        migrarmos os pontos do frontend que hoje chamam a function la.
      </p>
      <div class="token-row">
        <span class="token-label">URL</span>
        <input type="text" id="urlUserDirectory" readonly>
      </div>
      <div class="token-row">
        <span class="token-label">Token</span>
        <input type="text" id="tokenUserDirectory" readonly>
        <button class="action small" type="button" data-integration="userDirectory">Gerar novo</button>
      </div>
      <div class="token-row">
        <span class="token-label">Cadastrado em</span>
        <input type="text" id="noteUserDirectory" placeholder="ex: ainda nao usado em produção">
        <button class="action small" type="button" data-note-integration="userDirectory">Salvar</button>
      </div>
      <div class="action-result" id="userDirectoryTokenResult"></div>
    </div>

    <div class="settings-block">
      <div class="settings-block-head">
        <h3>Anexos do Ticket (Base44)</h3>
        <span class="pill" id="attachmentsStatusPill">verificando</span>
      </div>
      <p class="settings-desc">
        Token exclusivo usado para anexar arquivos no Ticket (Novo Registro, Anexos, composer de
        email) e colar imagens no editor — chama <code>POST /public/uploads/upload</code> direto
        do navegador do usuario (sem passar por <code>base44.integrations.Core.UploadFile</code>,
        para nao gastar credito de integracao no Base44). Por ficar visivel no codigo-fonte do
        frontend do Base44, esse token e separado dos outros e a rota so aceita chamadas vindas do
        dominio do app. Arquivos ficam salvos em <code>data/uploads</code> nesta VPS.
      </p>
      <div class="token-row">
        <span class="token-label">URL</span>
        <input type="text" id="urlAttachments" readonly>
      </div>
      <div class="token-row">
        <span class="token-label">Token</span>
        <input type="text" id="tokenAttachments" readonly>
        <button class="action small" type="button" data-integration="attachments">Gerar novo</button>
      </div>
      <div class="token-row">
        <span class="token-label">Cadastrado em</span>
        <input type="text" id="noteAttachments" placeholder="ex: Base44 &gt; ActivityPanel.jsx / TicketDetail.jsx / EmailComposerPanel.jsx">
        <button class="action small" type="button" data-note-integration="attachments">Salvar</button>
      </div>
      <div class="action-result" id="attachmentsTokenResult"></div>
    </div>

    <div class="settings-block">
      <h3>Outras integracoes</h3>
      <p class="settings-desc">
        Cadastre um nome para gerar na hora um endpoint novo (<code>/webhooks/custom/&lt;nome&gt;</code>)
        e um token, antes mesmo de existir logica de negocio dedicada para essa integracao. Por
        enquanto ela so autentica pelo token e mostra o payload recebido no log de "Requisicoes
        recentes" — util para ver o formato real de um sistema novo antes de pedir a
        implementacao de verdade.
      </p>
      <div id="customIntegrationsList"></div>
      <div class="settings-row">
        <input type="text" id="newIntegrationName" placeholder="Nome da integracao (ex: Metabot)" autocomplete="off">
        <button class="action" id="btnAddIntegration" type="button">Adicionar</button>
      </div>
      <div class="action-result" id="integrationsResult"></div>
    </div>
  </section>
</div>

<script>
(function () {
  var lastSeenId = 0;

  function fmtTime(iso) {
    var d = new Date(iso);
    return d.toLocaleTimeString("pt-BR", { hour12: false });
  }

  function fmtAgo(iso) {
    if (!iso) return "nunca";
    var diffMs = Date.now() - new Date(iso).getTime();
    var mins = Math.floor(diffMs / 60000);
    if (mins < 1) return "agora ha pouco";
    if (mins < 60) return mins + " min atras";
    var hours = Math.floor(mins / 60);
    return hours + "h atras";
  }

  function renderStatus(data) {
    document.getElementById("subline").textContent =
      data.env + " · node " + data.nodeVersion + " · uptime " + Math.floor(data.uptimeSeconds / 60) + " min · " + data.memoryMb + " MB";

    document.getElementById("btnGmailPoll").disabled = !data.gmail.configured;
    document.getElementById("btnTestGmailSend").disabled = !data.gmail.configured;

    var base44Ok = data.base44.authenticated;
    var gmailOk = !data.gmail.configured || !data.gmail.lastError;
    var pill = document.getElementById("overallPill");
    if (base44Ok && gmailOk) {
      pill.className = "pill ok";
      pill.textContent = "operacional";
    } else if (!base44Ok) {
      pill.className = "pill crit";
      pill.textContent = "base44 desconectado";
    } else {
      pill.className = "pill pending";
      pill.textContent = "atencao";
    }

    var stats = [];
    stats.push({
      label: "Base44",
      value: base44Ok ? "Conectado" : "Desconectado",
      sub: data.base44.serviceEmail,
      cls: base44Ok ? "ok-text" : "err-text"
    });
    stats.push({
      label: "Gmail",
      value: data.gmail.configured ? "Configurado" : "Nao configurado",
      sub: data.gmail.configured
        ? (data.gmail.lastError ? ("erro: " + String(data.gmail.lastError).slice(0, 60)) : ("ultima verificacao " + fmtAgo(data.gmail.lastRunAt)))
        : "aguardando GMAIL_APP_PASSWORD",
      cls: data.gmail.configured ? (data.gmail.lastError ? "err-text" : "ok-text") : ""
    });
    stats.push({ label: "Uptime", value: Math.floor(data.uptimeSeconds / 60) + " min", sub: "desde o ultimo restart" });
    stats.push({ label: "Memoria", value: data.memoryMb + " MB", sub: "node " + data.nodeVersion });

    var statsEl = document.getElementById("stats");
    statsEl.innerHTML = "";
    stats.forEach(function (s) {
      var el = document.createElement("div");
      el.className = "stat";
      el.innerHTML =
        '<div class="stat-label">' + s.label + '</div>' +
        '<div class="stat-value ' + (s.cls || "") + '">' + s.value + '</div>' +
        '<div class="stat-sub">' + s.sub + '</div>';
      statsEl.appendChild(el);
    });
  }

  function renderEvents(events) {
    var body = document.getElementById("eventsBody");
    var empty = document.getElementById("emptyState");
    if (!events.length) {
      empty.style.display = "block";
      return;
    }
    empty.style.display = "none";

    var newOnes = events.filter(function (ev) { return ev.id > lastSeenId; });
    newOnes.reverse(); // events chegam mais-novo-primeiro; insere do mais antigo pro mais novo no topo
    newOnes.forEach(function (ev) {
      var tr = document.createElement("tr");
      tr.className = "flash";
      tr.innerHTML =
        '<td class="mono">' + fmtTime(ev.timestamp) + '</td>' +
        '<td class="mono">' + ev.method + '</td>' +
        '<td class="mono">' + ev.path + '</td>' +
        '<td class="status-code ' + (ev.outcome === "error" ? "err-text" : "ok-text") + '">' + ev.statusCode + '</td>' +
        '<td class="mono">' + ev.durationMs + 'ms</td>' +
        '<td class="summary">' + (ev.summary || "") + '</td>';
      body.insertBefore(tr, body.firstChild);
    });
    lastSeenId = Math.max.apply(null, events.map(function (e) { return e.id; }).concat([lastSeenId]));

    while (body.children.length > 150) {
      body.removeChild(body.lastChild);
    }
  }

  function tick() {
    var statusP = fetch("/dashboard/api/status").then(function (r) { return r.json(); }).then(renderStatus).catch(function () {});
    var eventsP = fetch("/dashboard/api/events?limit=150").then(function (r) { return r.json(); }).then(function (data) { renderEvents(data.events); }).catch(function () {});
    return Promise.all([statusP, eventsP]);
  }

  function runAction(button, path) {
    var resultEl = document.getElementById("actionResult");
    var originalText = button.textContent;
    button.disabled = true;
    button.textContent = "Executando...";
    resultEl.className = "action-result";
    resultEl.textContent = "";

    fetch(path, { method: "POST" })
      .then(function (r) { return r.json().then(function (body) { return { ok: r.ok, body: body }; }); })
      .then(function (res) {
        resultEl.className = "action-result " + (res.ok ? "ok-text" : "err-text");
        resultEl.textContent = res.body.message || res.body.error || (res.ok ? "OK" : "Falhou.");
        tick();
      })
      .catch(function () {
        resultEl.className = "action-result err-text";
        resultEl.textContent = "Falha de rede ao chamar a acao.";
      })
      .then(function () {
        button.disabled = false;
        button.textContent = originalText;
      });
  }

  document.getElementById("btnTestSales").addEventListener("click", function (e) {
    runAction(e.target, "/dashboard/api/actions/test-sales-data");
  });
  document.getElementById("btnGmailPoll").addEventListener("click", function (e) {
    runAction(e.target, "/dashboard/api/actions/gmail-poll");
  });
  document.getElementById("btnTestGmailSend").addEventListener("click", function (e) {
    runAction(e.target, "/dashboard/api/actions/test-gmail-send");
  });

  document.getElementById("btnRefresh").addEventListener("click", function (e) {
    var btn = e.currentTarget;
    if (btn.classList.contains("spinning")) return;
    btn.classList.add("spinning");
    tick().then(function () {
      setTimeout(function () { btn.classList.remove("spinning"); }, 250);
    });
  });

  // ---------- Configuracoes ----------

  function escapeHtml(str) {
    var div = document.createElement("div");
    div.textContent = String(str);
    return div.innerHTML;
  }

  function apiCall(url, method, body) {
    return fetch(url, {
      method: method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {})
    }).then(function (r) {
      return r.json().then(function (data) { return { ok: r.ok, data: data }; });
    });
  }

  function showResult(el, ok, text) {
    el.className = "action-result " + (ok ? "ok-text" : "err-text");
    el.textContent = text;
  }

  function getConfirmPassword() {
    return document.getElementById("confirmPassword").value;
  }

  function deleteIntegration(slug) {
    var resultEl = document.getElementById("integrationsResult");
    apiCall("/dashboard/api/settings/integrations/" + encodeURIComponent(slug), "DELETE", { confirmPassword: getConfirmPassword() })
      .then(function (res) {
        showResult(resultEl, res.ok, res.data.message || res.data.error || "Falhou.");
        if (res.ok) loadSettings();
      });
  }

  function renderIntegrations(list) {
    var container = document.getElementById("customIntegrationsList");
    container.innerHTML = "";
    if (!list.length) {
      var empty = document.createElement("div");
      empty.className = "empty-note";
      empty.textContent = "Nenhuma integracao cadastrada ainda.";
      container.appendChild(empty);
      return;
    }
    list.forEach(function (integration) {
      var row = document.createElement("div");
      row.className = "integration-item";
      var fullUrl = window.location.origin + integration.url;
      row.innerHTML =
        '<span class="name">' + escapeHtml(integration.name) + '</span>' +
        '<input type="text" readonly value="' + escapeHtml(fullUrl) + '">' +
        '<input type="text" readonly value="' + escapeHtml(integration.token) + '">' +
        '<button class="action small danger" type="button">Remover</button>';
      row.querySelector("button").addEventListener("click", function () {
        deleteIntegration(integration.slug);
      });
      container.appendChild(row);
    });
  }

  function setStatusPill(elId, ok, okText, pendingText) {
    var el = document.getElementById(elId);
    el.className = "pill " + (ok ? "ok" : "pending");
    el.textContent = ok ? okText : pendingText;
  }

  function loadSettings() {
    fetch("/dashboard/api/settings").then(function (r) { return r.json(); }).then(function (data) {
      var origin = window.location.origin;

      document.getElementById("gmailUserInput").value = data.gmail.user || "";
      document.getElementById("smtpHostInput").value = data.gmail.smtpHost || "";
      document.getElementById("smtpPortInput").value = data.gmail.smtpPort || "";
      document.getElementById("imapHostInput").value = data.gmail.imapHost || "";
      document.getElementById("imapPortInput").value = data.gmail.imapPort || "";

      document.getElementById("urlSalesData").value = origin + "/webhooks/sales-data/receive";
      document.getElementById("tokenSalesData").value = data.webhookTokens.salesData.token || "(nao configurado)";
      document.getElementById("noteSalesData").value = data.webhookTokens.salesData.note || "";

      document.getElementById("urlGmail").value = origin + "/webhooks/gmail/send";
      document.getElementById("tokenGmail").value = data.webhookTokens.gmail.token || "(nao configurado)";
      document.getElementById("noteGmail").value = data.webhookTokens.gmail.note || "";

      document.getElementById("urlEmailButton").value = origin + "/public/email/send";
      document.getElementById("tokenEmailButton").value = data.webhookTokens.emailButton.token || "(nao configurado)";
      document.getElementById("noteEmailButton").value = data.webhookTokens.emailButton.note || "";

      document.getElementById("urlUserDirectory").value = origin + "/public/users/list";
      document.getElementById("tokenUserDirectory").value = data.webhookTokens.userDirectory.token || "(nao configurado)";
      document.getElementById("noteUserDirectory").value = data.webhookTokens.userDirectory.note || "";

      document.getElementById("urlAttachments").value = origin + "/public/uploads/upload";
      document.getElementById("tokenAttachments").value = data.webhookTokens.attachments.token || "(nao configurado)";
      document.getElementById("noteAttachments").value = data.webhookTokens.attachments.note || "";

      renderIntegrations(data.customIntegrations);

      setStatusPill("salesDataStatusPill", Boolean(data.webhookTokens.salesData.token), "token configurado", "sem token");
      setStatusPill("gmailStatusPill", data.gmail.configured, "pronto", "credenciais pendentes");
      setStatusPill("emailButtonStatusPill", Boolean(data.webhookTokens.emailButton.token), "token configurado", "sem token");
      setStatusPill("userDirectoryStatusPill", Boolean(data.webhookTokens.userDirectory.token), "token configurado", "sem token");
      setStatusPill("attachmentsStatusPill", Boolean(data.webhookTokens.attachments.token), "token configurado", "sem token");
    }).catch(function () {});
  }

  document.getElementById("btnSaveGmail").addEventListener("click", function () {
    var resultEl = document.getElementById("gmailSettingsResult");
    var user = document.getElementById("gmailUserInput").value.trim();
    var appPassword = document.getElementById("gmailAppPasswordInput").value.trim();
    var smtpHost = document.getElementById("smtpHostInput").value.trim();
    var smtpPort = document.getElementById("smtpPortInput").value.trim();
    var imapHost = document.getElementById("imapHostInput").value.trim();
    var imapPort = document.getElementById("imapPortInput").value.trim();
    apiCall("/dashboard/api/settings/gmail", "POST", {
      user: user, appPassword: appPassword, confirmPassword: getConfirmPassword(),
      smtpHost: smtpHost, smtpPort: smtpPort, imapHost: imapHost, imapPort: imapPort
    })
      .then(function (res) {
        showResult(resultEl, res.ok, res.data.message || res.data.error || "Falhou.");
        if (res.ok) {
          document.getElementById("gmailAppPasswordInput").value = "";
          tick();
        }
      });
  });

  var WEBHOOK_INTEGRATION_IDS = {
    salesData: { token: "tokenSalesData", note: "noteSalesData", result: "salesDataTokenResult", pill: "salesDataStatusPill" },
    gmail: { token: "tokenGmail", note: "noteGmail", result: "gmailTokenResult", pill: null },
    emailButton: { token: "tokenEmailButton", note: "noteEmailButton", result: "emailButtonTokenResult", pill: "emailButtonStatusPill" },
    userDirectory: { token: "tokenUserDirectory", note: "noteUserDirectory", result: "userDirectoryTokenResult", pill: "userDirectoryStatusPill" },
    attachments: { token: "tokenAttachments", note: "noteAttachments", result: "attachmentsTokenResult", pill: "attachmentsStatusPill" }
  };

  [].forEach.call(document.querySelectorAll("[data-integration]"), function (btn) {
    btn.addEventListener("click", function () {
      var integration = btn.getAttribute("data-integration");
      var ids = WEBHOOK_INTEGRATION_IDS[integration];
      var resultEl = document.getElementById(ids.result);
      apiCall("/dashboard/api/settings/webhook-tokens/" + integration + "/regenerate", "POST", { confirmPassword: getConfirmPassword() })
        .then(function (res) {
          showResult(resultEl, res.ok, res.data.message || res.data.error || "Falhou.");
          if (res.ok) {
            document.getElementById(ids.token).value = res.data.token;
            if (ids.pill) {
              setStatusPill(ids.pill, true, "token configurado", "sem token");
            }
          }
        });
    });
  });

  [].forEach.call(document.querySelectorAll("[data-note-integration]"), function (btn) {
    btn.addEventListener("click", function () {
      var integration = btn.getAttribute("data-note-integration");
      var ids = WEBHOOK_INTEGRATION_IDS[integration];
      var resultEl = document.getElementById(ids.result);
      var note = document.getElementById(ids.note).value.trim();
      apiCall("/dashboard/api/settings/webhook-tokens/" + integration + "/note", "POST", { note: note, confirmPassword: getConfirmPassword() })
        .then(function (res) {
          showResult(resultEl, res.ok, res.data.message || res.data.error || "Falhou.");
        });
    });
  });

  document.getElementById("btnAddIntegration").addEventListener("click", function () {
    var resultEl = document.getElementById("integrationsResult");
    var name = document.getElementById("newIntegrationName").value.trim();
    if (!name) {
      showResult(resultEl, false, "Informe um nome.");
      return;
    }
    apiCall("/dashboard/api/settings/integrations", "POST", { name: name, confirmPassword: getConfirmPassword() })
      .then(function (res) {
        showResult(resultEl, res.ok, res.data.message || res.data.error || "Falhou.");
        if (res.ok) {
          document.getElementById("newIntegrationName").value = "";
          loadSettings();
        }
      });
  });

  tick();
  loadSettings();
  setInterval(tick, 5000);
})();
</script>
</body>
</html>
`;
