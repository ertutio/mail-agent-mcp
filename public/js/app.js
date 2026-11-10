'use strict';
let setupSession = '';
try {
  const token = new URLSearchParams(window.location.hash.slice(1)).get('session');
  if (token) {
    setupSession = token;
    window.history.replaceState(null, '', window.location.pathname);
    sessionStorage.setItem('mail-agent-setup-session', token);
  } else setupSession = sessionStorage.getItem('mail-agent-setup-session') || '';
} catch { /* The initial fragment still works when browser storage is disabled. */ }
const $ = id => document.getElementById(id);
let busy = false;
let sessionExpired = false;
let secureAvailable = true;
let pendingJob = '';
let oauthConfig;
let selectedRemoval;
async function setupFetch(url, options = {}) {
  const response = await fetch(url, { ...options, headers: {
    'content-type': 'application/json', ...options.headers, 'x-mail-agent-session': setupSession,
  }, cache: 'no-store' });
  if (response.status === 403) {
    sessionExpired = true;
    try { sessionStorage.removeItem('mail-agent-setup-session'); } catch { /* optional storage */ }
    throw new Error('配置会话已失效。请重新打开本机新增邮箱入口。');
  }
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || '操作失败，请重试。');
  return body;
}
function feedback(message, kind = 'info') {
  $('feedback').textContent = message;
  $('feedback').dataset.kind = kind;
  $('feedback').hidden = false;
}
function clearSecrets() {
  $('authorization-code').value = '';
  $('authorization-code').type = 'password';
  $('show-secret').textContent = '显示';
  $('show-secret').setAttribute('aria-pressed', 'false');
  $('show-secret').setAttribute('aria-label', '显示授权码');
  $('client-id').value = '';
  $('client-secret').value = '';
  $('oauth-file').value = '';
  $('file-label').textContent = '选择桌面应用 JSON 文件';
  oauthConfig = undefined;
}
function updateProvider() {
  clearSecrets();
  const provider = $('provider').value;
  const gmail = provider === 'gmail';
  const other = provider === 'other';
  $('gmail-fields').hidden = !gmail;
  $('password-fields').hidden = gmail;
  $('generic-fields').hidden = !other;
  // Hidden containers still run constraint validation — disable the fields
  // that are not in play so a stale invalid port can never block submit.
  for (const id of ['imap-host', 'imap-port', 'imap-encryption']) $(id).disabled = !other;
  // R4: the SMTP host input itself stays EDITABLE while the generic provider
  // is selected — disabling it while empty made the server field impossible
  // to fill. Only the advanced port/encryption fields gate on the host.
  $('smtp-host').disabled = !other;
  for (const id of ['smtp-port', 'smtp-encryption']) $(id).disabled = !other || !$('smtp-host').value.trim();
  $('smtp-advanced').hidden = !other || !$('smtp-host').value.trim();
  $('enterprise-hint').hidden = provider !== 'netease-enterprise';
  $('authorization-code').required = !gmail;
  $('imap-host').required = other;
  $('email').placeholder = { qq: 'name@qq.com', '163': 'name@163.com', '126': 'name@126.com', yeah: 'name@yeah.net', gmail: 'name@gmail.com' }[provider] || 'name@company.com';
  $('submit-label').textContent = gmail ? '继续 Google 授权' : '验证并添加';
  $('privacy-text').textContent = other ? '密码加密保存在本机账号目录，不发送给聊天模型。' : '凭据保存在本机系统凭据库，不发送给聊天模型。';
  $('password-hint').textContent = other ? '填写服务商提供的应用密码或客户端授权码。' : '在邮箱设置中开启 IMAP，并生成客户端授权码。';
  $('submit-button').disabled = !secureAvailable && !other;
}

// F3: the generic-mailbox form exposes IMAP/SMTP ports and encryption.
// Validation mirrors the backend candidate rules (integer 1..65535); the
// encryption selects fill the standard port only when the field still
// holds a standard or empty value, so a provider-specific port survives.
const STANDARD_PORTS = { imap: [993, 143], smtp: [465, 587] };
function parsePortField(input, label) {
  const raw = String(input.value).trim();
  if (!/^\d{1,5}$/.test(raw)) throw new Error(label + '端口必须是 1-65535 的整数。');
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(label + '端口必须是 1-65535 的整数。');
  return port;
}
function syncStandardPort(kind) {
  const portInput = $(kind + '-port');
  const current = Number(portInput.value);
  if (portInput.value.trim() === '' || STANDARD_PORTS[kind].includes(current)) {
    portInput.value = $(kind + '-encryption').value === 'tls'
      ? (kind === 'imap' ? 993 : 465)
      : (kind === 'imap' ? 143 : 587);
  }
}
async function viewAccounts() {
  const accounts = await setupFetch('/api/accounts');
  const list = $('account-list');
  list.replaceChildren();
  $('account-count').textContent = String(accounts.length);
  if (!accounts.length) {
    const empty = document.createElement('p'); empty.className = 'empty';
    empty.textContent = '还没有添加邮箱。\n从左侧开始连接第一个账号。'; list.append(empty);
    return;
  }
  for (const account of accounts) {
    const row = document.createElement('div'); row.className = 'account-row';
    const avatar = document.createElement('span'); avatar.className = 'account-avatar'; avatar.setAttribute('aria-hidden', 'true');
    avatar.textContent = account.auth?.provider === 'gmail' ? 'G' : account.host?.includes('qq.com') ? 'QQ' : account.auth?.provider === 'netease' ? 'N' : '@';
    const copy = document.createElement('div'); copy.className = 'account-copy';
    const name = document.createElement('p'); name.className = 'account-name'; name.textContent = account.name; name.title = account.name;
    const email = document.createElement('p'); email.className = 'account-email'; email.textContent = account.email || account.user; email.title = email.textContent;
    const diagnose = document.createElement('button'); diagnose.type = 'button'; diagnose.className = 'remove-account';
    diagnose.textContent = '诊断'; diagnose.setAttribute('aria-label', '诊断邮箱连接：' + account.name);
    diagnose.disabled = busy || sessionExpired;
    diagnose.addEventListener('click', () => showDiagnostics(account));
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'remove-account';
    remove.textContent = '移除'; remove.setAttribute('aria-label', '移除邮箱连接：' + account.name);
    remove.disabled = busy || sessionExpired;
    remove.addEventListener('click', () => showRemoval(account));
    copy.append(name, email); row.append(avatar, copy, diagnose, remove); list.append(row);
  }
}

// F2: per-account diagnostics — IMAP / SMTP / proxy / authorization status
// with the failing stage and an actionable next step. All content is
// rendered with textContent only; provider data never becomes markup.
const DIAGNOSIS_LABELS = {
  imap: 'IMAP 收信', smtp: 'SMTP 发信', proxy: '代理', auth: '授权',
};
function statusLine(label, status, detail) {
  const line = document.createElement('p'); line.className = 'diagnosis-line';
  const mark = document.createElement('span');
  mark.className = 'diagnosis-mark ' + (status === 'ok' ? 'ok' : status === 'skipped' || status === 'not_configured' ? 'muted' : 'bad');
  mark.textContent = status === 'ok' ? '✓' : status === 'failed' ? '✕' : '—';
  const text = document.createElement('span');
  text.textContent = label + '：' + ({ ok: '正常', failed: '失败', not_configured: '未配置', skipped: '未启用' }[status] || status);
  line.append(mark, text);
  if (detail) { const extra = document.createElement('span'); extra.className = 'diagnosis-detail'; extra.textContent = '（' + detail + '）'; line.append(extra); }
  return line;
}
const STAGE_LABELS = { proxy: '代理配置', tls: 'TLS/证书', authenticate: '登录验证', connect: '连接服务器', session: '邮箱会话', smtp_connect: '连接服务器' };
let diagnosticsAccount;
async function showDiagnostics(account) {
  if (busy || sessionExpired) return;
  diagnosticsAccount = account;
  $('diagnostics-name').textContent = account.name;
  $('diagnostics-email').textContent = account.email || account.user;
  const body = $('diagnostics-body'); body.replaceChildren();
  const steps = $('diagnostics-steps'); steps.hidden = true; steps.textContent = '';
  $('start-repair').hidden = true;
  $('diagnostics-dialog').showModal();
  try {
    const d = await setupFetch('/api/accounts/' + encodeURIComponent(account.id) + '/diagnostics');
    body.replaceChildren();
    const imap = d.imap || { status: 'unknown' };
    const smtp = d.smtp || { status: 'unknown' };
    const proxy = d.proxy || { applied: false };
    const auth = d.auth || {};
    body.append(statusLine(DIAGNOSIS_LABELS.imap, imap.status, imap.stage ? STAGE_LABELS[imap.stage] || imap.stage : undefined));
    body.append(statusLine(DIAGNOSIS_LABELS.smtp, smtp.status, smtp.stage ? STAGE_LABELS[smtp.stage] || smtp.stage : undefined));
    body.append(statusLine(DIAGNOSIS_LABELS.proxy, proxy.applied ? 'ok' : 'not_configured', proxy.applied ? (proxy.source === 'gmail-policy' ? 'Gmail 专用代理' : proxy.source === 'IMAP_MCP_MAIL_PROXY' ? '本机代理配置' : proxy.source === 'invalid-config' ? '配置无效' : '系统代理') : '直连'));
    body.append(statusLine(DIAGNOSIS_LABELS.auth, auth.kind === 'oauth' || auth.kind === 'vault' || auth.kind === 'password' ? 'ok' : 'failed',
      auth.kind === 'oauth' ? 'Google 授权' : auth.kind === 'vault' ? '系统凭据库' : auth.kind === 'password' ? '授权码' : '缺少凭据'));
    if (Array.isArray(d.nextSteps) && d.nextSteps.length) {
      steps.textContent = '下一步：' + d.nextSteps.join(' ');
      steps.hidden = false;
    }
    const repairable = (auth.kind === 'vault' || auth.kind === 'password') && (imap.status === 'failed' || smtp.status === 'failed' || smtp.status === 'not_configured');
    $('start-repair').hidden = !repairable;
    $('start-repair').setAttribute('aria-label', '修复邮箱凭据：' + account.name);
  } catch (error) {
    body.replaceChildren();
    const fail = document.createElement('p'); fail.className = 'hint'; fail.textContent = error.message;
    body.append(fail);
  }
}
function startRepair() {
  if (!diagnosticsAccount || busy) return;
  $('repair-code').value = '';
  $('repair-error').hidden = true;
  $('repair-dialog').showModal();
}
async function confirmRepair() {
  if (!diagnosticsAccount || busy) return;
  const code = $('repair-code').value;
  if (!code) { $('repair-error').textContent = '请填写新的客户端授权码。'; $('repair-error').hidden = false; return; }
  const account = diagnosticsAccount;
  busy = true; $('confirm-repair').textContent = '正在验证…';
  $('repair-error').hidden = true;
  try {
    await setupFetch('/api/accounts/' + encodeURIComponent(account.id) + '/repair', { method: 'POST', body: JSON.stringify({ authorizationCode: code }) });
    $('repair-dialog').close(); $('diagnostics-dialog').close(); diagnosticsAccount = undefined;
    feedback('凭据已验证并更新。旧授权码已失效，请在聊天中重新使用该邮箱。', 'success');
  } catch (error) {
    $('repair-error').textContent = error.message;
    $('repair-error').hidden = false;
  } finally { busy = false; $('confirm-repair').textContent = '验证并更新'; }
}
function showRemoval(account) {
  if (busy || sessionExpired) return;
  selectedRemoval = { id: account.id, name: account.name, email: account.email || account.user };
  $('remove-name').textContent = selectedRemoval.name;
  $('remove-email').textContent = selectedRemoval.email;
  $('remove-error').hidden = true;
  $('remove-dialog').showModal();
}
async function confirmRemoval() {
  if (busy || sessionExpired || !selectedRemoval) return;
  const account = selectedRemoval;
  setBusy(true);
  $('remove-error').hidden = true;
  $('confirm-remove').textContent = '正在移除…';
  try {
    await setupFetch('/api/accounts/' + encodeURIComponent(account.id), { method: 'DELETE', body: JSON.stringify({ confirmed: true, name: account.name, email: account.email }) });
    $('remove-dialog').close(); selectedRemoval = undefined;
    feedback('邮箱连接及对应凭据已移除，邮箱中的邮件未改动。', 'success');
    try { await viewAccounts(); } catch { feedback('邮箱连接已移除，但列表刷新失败。请重新打开配置入口。', 'success'); }
    ($('enrollment-form').hidden ? $('add-another') : $('provider')).focus();
  } catch (error) {
    $('remove-error').textContent = error.message === 'Failed to fetch' ? '无法连接本机服务，请重新打开配置入口。' : error.message;
    $('remove-error').hidden = false;
  } finally { setBusy(false); $('confirm-remove').textContent = '确认移除'; }
}
function setBusy(value) {
  busy = value;
  $('fields').disabled = value || sessionExpired;
  document.querySelectorAll('.remove-account').forEach(button => { button.disabled = value || sessionExpired; });
  $('add-another').disabled = value || sessionExpired;
  $('confirm-remove').disabled = value || sessionExpired;
  $('cancel-remove').disabled = value;
  $('enrollment-form').setAttribute('aria-busy', String(value));
  $('submit-label').textContent = value ? '正在验证…' : $('provider').value === 'gmail' ? '继续 Google 授权' : '验证并添加';
}
async function finishEnrollment() {
  clearSecrets();
  feedback('邮箱已验证并添加。现在可以在聊天中搜索这个邮箱。', 'success');
  $('enrollment-form').hidden = true;
  $('add-another').hidden = false;
  $('add-another').focus();
  try { await viewAccounts(); } catch { feedback('邮箱已添加，但账号列表刷新失败。请重新打开配置入口。', 'success'); }
}
async function pollGmail(id) {
  pendingJob = id;
  for (let attempt = 0; attempt < 240; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 1500));
    const job = await setupFetch('/api/enroll/gmail/' + encodeURIComponent(id));
    if (job.status === 'success') { pendingJob = ''; await finishEnrollment(); return; }
    if (job.status === 'error') { pendingJob = ''; throw new Error(job.message); }
    feedback(job.message);
  }
  pendingJob = '';
  throw new Error('等待授权超时，请完成 Google 授权后重新打开配置入口检查账号列表。');
}
async function submit(event) {
  event.preventDefault();
  if (busy || sessionExpired) return;
  $('feedback').hidden = true;
  const provider = $('provider').value;
  const identity = { email: $('email').value.trim(), ...($('name').value.trim() ? { name: $('name').value.trim() } : {}) };
  setBusy(true);
  try {
    if (provider === 'gmail') {
      const config = oauthConfig || { clientId: $('client-id').value.trim(), clientSecret: $('client-secret').value.trim() };
      if (!config.clientId || !config.clientSecret) throw new Error('请先选择 Google OAuth 桌面应用 JSON 文件，或手动填写配置。');
      const job = await setupFetch('/api/enroll/gmail/start', { method: 'POST', body: JSON.stringify({ ...identity, ...config }) });
      clearSecrets();
      feedback('请在 Google 页面完成授权，然后返回此页等待验证。');
      $('submit-label').textContent = '等待 Google 授权…';
      await pollGmail(job.id);
    } else if (provider === 'other') {
      const host = $('imap-host').value.trim();
      const smtpHost = $('smtp-host').value.trim();
      if (!host || /[\s/:]/.test(host) || (smtpHost && /[\s/:]/.test(smtpHost))) throw new Error('请填写服务器主机名，不包含协议、路径或端口。');
      // F3: ports and encryption come from the form; the integer 1..65535
      // rule mirrors the backend candidate validation.
      const imapPort = parsePortField($('imap-port'), 'IMAP');
      const imapTls = $('imap-encryption').value === 'tls';
      const account = { ...identity, name: identity.name || identity.email, host, port: imapPort, tls: imapTls, password: $('authorization-code').value };
      if (smtpHost) {
        const smtpPort = parsePortField($('smtp-port'), 'SMTP');
        account.smtp = { host: smtpHost, port: smtpPort, secure: $('smtp-encryption').value === 'tls', user: identity.email, password: $('authorization-code').value };
      }
      const test = await setupFetch('/api/test-connection', { method: 'POST', body: JSON.stringify({ ...account, user: identity.email }) });
      if (!test.success) throw new Error('连接验证失败，请检查服务器和应用密码。');
      await setupFetch('/api/accounts', { method: 'POST', body: JSON.stringify(account) });
      await finishEnrollment();
    } else {
      await setupFetch('/api/enroll', { method: 'POST', body: JSON.stringify({ ...identity, provider, authorizationCode: $('authorization-code').value }) });
      await finishEnrollment();
    }
  } catch (error) { feedback(error.message === 'Failed to fetch' ? '无法连接本机配置服务。请重新打开新增邮箱入口。' : error.message, 'error'); }
  finally { pendingJob = ''; setBusy(false); }
}
async function importOAuthFile(file) {
  oauthConfig = undefined;
  if (!file) return;
  if (file.size > 1024 * 1024) throw new Error('文件过大，请选择 Google Cloud 下载的 OAuth JSON 文件。');
  let config;
  try { config = JSON.parse(await file.text()).installed; }
  catch { throw new Error('无法读取 JSON 配置，请重新选择 Google Cloud 下载的文件。'); }
  if (!config || typeof config.client_id !== 'string' || typeof config.client_secret !== 'string') throw new Error('请选择“桌面应用”类型的 OAuth JSON 配置。');
  oauthConfig = { clientId: config.client_id, clientSecret: config.client_secret };
  $('file-label').textContent = file.name;
  $('client-id').value = ''; $('client-secret').value = '';
  $('feedback').hidden = true;
}
function manualOAuthChanged() { oauthConfig = undefined; $('oauth-file').value = ''; $('file-label').textContent = '选择桌面应用 JSON 文件'; }
document.addEventListener('DOMContentLoaded', async () => {
  $('confirm-remove').addEventListener('click', confirmRemoval);
  $('cancel-remove').addEventListener('click', () => { if (!busy) { $('remove-dialog').close(); selectedRemoval = undefined; } });
  $('remove-dialog').addEventListener('cancel', event => { if (busy) event.preventDefault(); else selectedRemoval = undefined; });
  $('close-diagnostics').addEventListener('click', () => { if (!busy) { $('diagnostics-dialog').close(); diagnosticsAccount = undefined; } });
  $('diagnostics-dialog').addEventListener('cancel', event => { if (busy) event.preventDefault(); else diagnosticsAccount = undefined; });
  $('start-repair').addEventListener('click', startRepair);
  $('confirm-repair').addEventListener('click', confirmRepair);
  $('cancel-repair').addEventListener('click', () => { if (!busy) $('repair-dialog').close(); });
  $('repair-dialog').addEventListener('cancel', event => { if (busy) event.preventDefault(); });
  $('show-repair-secret').addEventListener('click', () => {
    const visible = $('repair-code').type === 'password';
    $('repair-code').type = visible ? 'text' : 'password';
    $('show-repair-secret').textContent = visible ? '隐藏' : '显示';
    $('show-repair-secret').setAttribute('aria-label', visible ? '隐藏授权码' : '显示授权码');
    $('show-repair-secret').setAttribute('aria-pressed', String(visible));
  });
  $('provider').addEventListener('change', updateProvider);
  $('smtp-host').addEventListener('input', () => {
    $('smtp-advanced').hidden = !$('smtp-host').value.trim();
    for (const id of ['smtp-port', 'smtp-encryption']) $(id).disabled = !$('smtp-host').value.trim();
  });
  $('imap-encryption').addEventListener('change', () => syncStandardPort('imap'));
  $('smtp-encryption').addEventListener('change', () => syncStandardPort('smtp'));
  $('enrollment-form').addEventListener('submit', submit);
  $('client-id').addEventListener('input', manualOAuthChanged);
  $('client-secret').addEventListener('input', manualOAuthChanged);
  $('show-secret').addEventListener('click', () => {
    const visible = $('authorization-code').type === 'password';
    $('authorization-code').type = visible ? 'text' : 'password';
    $('show-secret').textContent = visible ? '隐藏' : '显示';
    $('show-secret').setAttribute('aria-label', visible ? '隐藏授权码' : '显示授权码');
    $('show-secret').setAttribute('aria-pressed', String(visible));
  });
  $('oauth-file').addEventListener('change', async () => {
    try { await importOAuthFile($('oauth-file').files[0]); }
    catch (error) { $('oauth-file').value = ''; $('file-label').textContent = '选择桌面应用 JSON 文件'; feedback(error.message, 'error'); }
  });
  $('add-another').addEventListener('click', () => {
    $('enrollment-form').reset(); clearSecrets(); updateProvider();
    $('enrollment-form').hidden = false; $('add-another').hidden = true; $('feedback').hidden = true; $('email').focus();
  });
  window.addEventListener('beforeunload', event => { if (busy || pendingJob) { event.preventDefault(); event.returnValue = ''; } });
  updateProvider();
  try {
    const info = await setupFetch('/api/setup-info'); secureAvailable = info.secureEnrollmentAvailable;
    updateProvider(); await viewAccounts();
    if (!secureAvailable) feedback('当前系统不支持安全凭据库注册。QQ、网易和 Gmail 请在 Windows 上配置。', 'error');
  } catch (error) { feedback(error.message, 'error'); $('fields').disabled = true; $('account-list').textContent = '账号列表暂不可用'; }
});
