import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { buildGenericSnapshot, writeGenericSnapshot } from "./generic-snapshot.js";
import { buildSlackNotificationSnapshot, renderSlackNotificationMarkdown } from "./slack.js";

export const DEFAULT_MSDEV_CDP_PORT = 9224;
export const DEFAULT_MSDEV_PWSH = "/mnt/c/Program Files/PowerShell/7/pwsh.exe";
export const DEFAULT_MSDEV_REMOTE_SCRIPT = "/tmp/agent-utils-msdev-cdp-refresh.ps1";
export const DEFAULT_MSDEV_SSH_CONNECT_TIMEOUT_SECONDS = 10;

export const DEFAULT_MSDEV_CDP_TARGETS = [
  {
    app: "calendar",
    action: "events.snapshot",
    url: "https://calendar.google.com/calendar/u/0/r",
    includePatterns: ["meeting", "event", "calendar", "today", "tomorrow", "starts", "join", "busy", "free", "\\d{1,2}:\\d{2}", "\\bby\\b"],
  },
  {
    app: "outlook",
    action: "notifications.snapshot",
    url: "https://outlook.office.com/mail/",
    includePatterns: ["unread", "mention", "flag", "important", "from", "sender", "subject", "inbox", "mail", "message", "meeting", "calendar", "invite"],
  },
  {
    app: "outlook",
    action: "calendar.snapshot",
    url: "https://outlook.office.com/calendar/",
    includePatterns: ["meeting", "calendar", "event", "today", "tomorrow", "starts", "join", "organizer", "organiser", "accepted", "tentative", "busy", "free", "\\d{1,2}:\\d{2}", "\\bby\\b"],
  },
  {
    app: "teams",
    action: "notifications.snapshot",
    url: "https://teams.microsoft.com/v2/",
    includePatterns: ["unread", "mention", "chat", "message", "notification", "author", "meeting", "call", "reply", "activity"],
  },
  {
    app: "teams",
    action: "calendar.snapshot",
    url: "https://teams.microsoft.com/v2/calendar",
    includePatterns: ["meeting", "calendar", "event", "starts", "join", "organizer", "organiser", "today", "tomorrow", "busy", "free", "\\d{1,2}:\\d{2}", "\\bby\\b"],
  },
  {
    app: "slack",
    action: "notifications.snapshot",
    url: "https://app.slack.com/client",
    includePatterns: ["unread", "mention", "dm", "direct message", "channel", "new message", "slack"],
  },
];

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function compact(value, limit = 180) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return null;
  return text.length > limit ? `${text.slice(0, limit - 3)}...` : text;
}

function classifyBridgeError(error) {
  const text = String(error || "").toLowerCase();
  if (!text) return null;
  if (/connection timed out|operation timed out|connect to host .* timed out/.test(text)) return "connect_timeout";
  if (/command timed out|process timed out|timeout exceeded|\betimedout\b|\bsigterm\b|\bsigkill\b|killed=true|timedout=true/.test(text)) return "command_timeout";
  if (/connection refused/.test(text)) return "connection_refused";
  if (/no route to host|network is unreachable|host is down/.test(text)) return "host_unreachable";
  if (/could not resolve hostname|name or service not known|temporary failure in name resolution/.test(text)) return "name_resolution_failed";
  if (/permission denied|publickey|authentication failed/.test(text)) return "auth_failed";
  return null;
}

function sanitizeBridgeFailureText(value) {
  let text = compact(value, 500);
  if (!text) return null;
  if (/^command failed:/i.test(text)) text = "command failed";
  text = text.replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+(?=[:\s]|$)/g, "[ssh-target]");
  text = text.replace(/\/home\/[^\s]+/g, "[local-path]");
  text = text.replace(/\/tmp\/[^\s]+/g, "[remote-path]");
  text = text.replace(/[A-Za-z]:\\[^\s]+/g, "[windows-path]");
  return compact(text, 500);
}

function execFailureText(result = {}, fallback = "command failed") {
  if (typeof result === "string") return sanitizeBridgeFailureText(result) || fallback;
  const parts = [];
  for (const field of ["stderr", "stdout", "error", "message"]) {
    const value = sanitizeBridgeFailureText(result?.[field]);
    if (value) parts.push(value);
  }
  for (const field of ["code", "signal"]) {
    if (result?.[field] !== undefined && result?.[field] !== null && result?.[field] !== "") parts.push(`${field}=${result[field]}`);
  }
  if (result?.killed !== undefined) parts.push(`killed=${Boolean(result.killed)}`);
  if (result?.timedOut !== undefined) parts.push(`timedOut=${Boolean(result.timedOut)}`);
  if (result?.timeout !== undefined) parts.push(`timeout=${result.timeout}`);
  if (result?.timeoutMs !== undefined) parts.push(`timeoutMs=${result.timeoutMs}`);
  return compact(parts.join(" "), 1000) || fallback;
}

function compactCounts(entries = [], field = "errorKind") {
  const counts = {};
  for (const entry of entries || []) {
    const key = compact(entry?.[field], 80);
    if (!key) continue;
    counts[key] = (counts[key] || 0) + 1;
  }
  return Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)).map(([key, count]) => `${key}=${count}`).join(",");
}

function sshOptions(connectTimeoutSeconds = DEFAULT_MSDEV_SSH_CONNECT_TIMEOUT_SECONDS) {
  const timeout = Math.max(1, Number.parseInt(String(connectTimeoutSeconds || DEFAULT_MSDEV_SSH_CONNECT_TIMEOUT_SECONDS), 10) || DEFAULT_MSDEV_SSH_CONNECT_TIMEOUT_SECONDS);
  return ["-o", "BatchMode=yes", "-o", `ConnectTimeout=${timeout}`];
}

function selectedTargets({ apps, actions, targets = DEFAULT_MSDEV_CDP_TARGETS } = {}) {
  const wantedApps = new Set((apps || []).map((value) => String(value)));
  const wantedActions = new Set((actions || []).map((value) => String(value)));
  return targets.filter((target) => (
    (!wantedApps.size || wantedApps.has(target.app))
    && (!wantedActions.size || wantedActions.has(target.action))
  ));
}

export function msDevCdpConfig(env = process.env) {
  return {
    sshTarget: env.APP_AUTOMATION_MSDEV_SSH_TARGET || env.AGENT_UTILS_MSDEV_SSH_TARGET || "",
    pwshPath: env.APP_AUTOMATION_MSDEV_PWSH || DEFAULT_MSDEV_PWSH,
    cdpPort: Number.parseInt(String(env.APP_AUTOMATION_MSDEV_CDP_PORT || DEFAULT_MSDEV_CDP_PORT), 10) || DEFAULT_MSDEV_CDP_PORT,
    remoteScriptPath: env.APP_AUTOMATION_MSDEV_REMOTE_SCRIPT || DEFAULT_MSDEV_REMOTE_SCRIPT,
    sshConnectTimeoutSeconds: Number.parseInt(String(env.APP_AUTOMATION_MSDEV_SSH_CONNECT_TIMEOUT_SECONDS || DEFAULT_MSDEV_SSH_CONNECT_TIMEOUT_SECONDS), 10) || DEFAULT_MSDEV_SSH_CONNECT_TIMEOUT_SECONDS,
  };
}

export function msDevCdpCommandSummary(config = msDevCdpConfig()) {
  return {
    sshTargetConfigured: Boolean(config.sshTarget),
    sshTarget: config.sshTarget || null,
    pwshPath: config.pwshPath,
    cdpPort: config.cdpPort,
    remoteScriptPath: config.remoteScriptPath,
    sshConnectTimeoutSeconds: config.sshConnectTimeoutSeconds || DEFAULT_MSDEV_SSH_CONNECT_TIMEOUT_SECONDS,
  };
}

export function buildMsDevCdpPowerShell({ cdpPort = DEFAULT_MSDEV_CDP_PORT, targets = DEFAULT_MSDEV_CDP_TARGETS } = {}) {
  const targetJson = JSON.stringify(targets.map((target) => ({ app: target.app, action: target.action, url: target.url })));
  return `$ErrorActionPreference = 'SilentlyContinue'
$CdpPort = ${Number.parseInt(String(cdpPort), 10) || DEFAULT_MSDEV_CDP_PORT}
$TargetsJson = @'
${targetJson}
'@
$Targets = $TargetsJson | ConvertFrom-Json
function Invoke-CdpJson($Path, $Method = 'Get') {
  $uri = "http://127.0.0.1:$CdpPort$Path"
  try { return Invoke-RestMethod -Method $Method -Uri $uri -TimeoutSec 8 } catch { return $null }
}
function New-CdpTarget($Url) {
  $encoded = [System.Uri]::EscapeDataString($Url)
  $target = Invoke-CdpJson "/json/new?$encoded" 'Put'
  if ($null -eq $target) { return $null }
  Start-Sleep -Seconds 8
  return $target
}
function Receive-CdpMessage($Socket, $WantedId) {
  $buffer = New-Object byte[] 1048576
  $deadline = (Get-Date).AddSeconds(12)
  while ((Get-Date) -lt $deadline) {
    $segment = [ArraySegment[byte]]::new($buffer)
    $task = $Socket.ReceiveAsync($segment, [Threading.CancellationToken]::None)
    if (-not $task.Wait(12000)) { return $null }
    $count = $task.Result.Count
    if ($count -le 0) { continue }
    $text = [Text.Encoding]::UTF8.GetString($buffer, 0, $count)
    try { $messages = $text | ConvertFrom-Json -Depth 80 } catch { continue }
    foreach ($msg in @($messages)) {
      if ($msg.id -eq $WantedId) { return $msg }
    }
  }
  return $null
}
function Eval-Cdp($WsUrl, $Expression) {
  Add-Type -AssemblyName System.Net.WebSockets.Client
  $socket = [System.Net.WebSockets.ClientWebSocket]::new()
  $socket.ConnectAsync([Uri]$WsUrl, [Threading.CancellationToken]::None).Wait(10000) | Out-Null
  $id = 1
  $payload = @{ id = $id; method = 'Runtime.evaluate'; params = @{ expression = $Expression; returnByValue = $true; awaitPromise = $false } } | ConvertTo-Json -Compress -Depth 20
  $bytes = [Text.Encoding]::UTF8.GetBytes($payload)
  $socket.SendAsync([ArraySegment[byte]]::new($bytes), [System.Net.WebSockets.WebSocketMessageType]::Text, $true, [Threading.CancellationToken]::None).Wait(10000) | Out-Null
  $msg = Receive-CdpMessage $socket $id
  $socket.Dispose()
  if ($null -eq $msg) { return $null }
  if ($msg.exceptionDetails) { return [pscustomobject]@{ __cdpError = ($msg.exceptionDetails.text | Out-String).Trim() } }
  if ($msg.result.exceptionDetails) { return [pscustomobject]@{ __cdpError = (($msg.result.exceptionDetails.text, $msg.result.exceptionDetails.exception.description) -join ' ').Trim() } }
  return $msg.result.result.value
}
function Get-SlackDesktopObservation {
  $windows = @(Get-Process | Where-Object { $_.MainWindowTitle -and ($_.ProcessName -match 'Slack' -or $_.MainWindowTitle -match 'Slack') } | Select-Object -First 10 ProcessName,MainWindowTitle)
  $items = @()
  foreach ($window in $windows) {
    $title = [string]$window.MainWindowTitle
    $match = [regex]::Match($title, '(?i)(\\d{1,4})\\s+new\\s+items?')
    if ($match.Success) {
      $count = [int]$match.Groups[1].Value
      $label = if ($count -eq 1) { 'Slack desktop reports 1 new item' } else { "Slack desktop reports $count new items" }
      $items += [pscustomobject]@{ text=$label; source='Slack Desktop'; unreadCount=$count; hrefs=@() }
    }
  }
  if ($items.Count -gt 0) { return [pscustomobject]@{ title='Slack Desktop'; source='Slack Desktop'; authRequired=$false; itemCount=$items.Count; items=$items } }
  return $null
}
$extractor = @'
(() => {
  const compact = (value, max = 180) => {
    const text = String(value || '').replace(/\\s+/g, ' ').trim();
    if (!text) return null;
    return text.length > max ? text.slice(0, max - 3) + '...' : text;
  };
  const sanitize = (href) => {
    try {
      const parsed = new URL(href, location.href);
      if (!['http:', 'https:'].includes(parsed.protocol)) return null;
      parsed.username = ''; parsed.password = ''; parsed.search = ''; parsed.hash = '';
      return parsed.toString();
    } catch (_) { return null; }
  };
  const bodyText = compact(document.body?.innerText || '', 1200);
  const title = compact(document.title, 180);
  const source = location.hostname.includes('outlook') ? (location.href.includes('/calendar') ? 'Outlook Calendar' : 'Outlook Mail') : location.hostname.includes('teams') ? (location.href.includes('/calendar') ? 'Teams Calendar' : 'Teams') : location.hostname.includes('slack') ? 'Slack Web' : title;
  const patterns = [/unread/i, /important/i, /flag/i, /mention/i, /meeting/i, /calendar/i, /today/i, /tomorrow/i, /join/i, /chat/i, /message/i, /from/i, /sender/i, /organizer/i, /organiser/i, /starts/i, /accepted/i, /tentative/i, /channel/i, /direct message/i, /busy/i, /free/i];
  const ignore = [/^search\\b/i, /^(mail|calendar|people|files|teams chat|to do|onedrive)$/i, /^(new mail|new event|new message)$/i, /^(navigation|navigation pane|app launcher|settings|help|feedback|filter|filter applied|share|print|quick steps?|flag|unflag|flag [/] unflag|expand to see flag options)$/i, /keyboard shortcuts/i, /favorite|sent item|draft|github ci/i, /^add-ins?\\b/i, /enhance outlook with apps/i, /viva insights/i, /you can take multiple actions? on a message/i, /apply or remove calendar event filters/i, /share a calendar|print a copy of your calendar/i, /^ribbon\\b/i, /^move [&] delete\\b/i, /^respond\\b/i, /create a new email message/i, /move this message to your archive folder/i, /this message as phishing/i, /go to today/i, /my calendars/i, /deselect all calendars/i, /loading calendar actions/i, /add a new calendar instruction/i, /switch to calendar/i, /add other calendars/i, /tasks are currently not shown on your grid/i];
  const selectors = ['[aria-label]', '[role="treeitem"]', '[role="listitem"]', '[data-testid]', '[data-tid]', '[title]', 'a[href]'];
  const seen = new Set();
  const items = [];
  const metadata = (el) => [el.getAttribute?.('aria-label'), el.getAttribute?.('title'), el.innerText || el.textContent || ''].map(v => compact(v, 180)).filter(Boolean).join(' | ');
  const timeFor = (el) => [el.getAttribute?.('datetime'), el.getAttribute?.('data-start'), el.getAttribute?.('data-start-time'), el.getAttribute?.('data-date'), el.querySelector?.('time')?.getAttribute?.('datetime'), el.querySelector?.('time')?.textContent, el.closest?.('time')?.getAttribute?.('datetime'), el.closest?.('time')?.textContent].map(v => compact(v, 80)).find(Boolean) || null;
  const fromFor = (text) => {
    const match = text.match(/\\b(?:from|sender|organizer|organiser|author)\\s*:?\\s*([^,;|•]{2,80})/i);
    return match ? compact(match[1], 80) : null;
  };
  for (const selector of selectors) {
    for (const el of document.querySelectorAll(selector)) {
      const text = metadata(el);
      if (!text || ignore.some(p => p.test(text)) || !patterns.some(p => p.test(text))) continue;
      const hrefs = [];
      const add = href => { const url = sanitize(href); if (url && !hrefs.includes(url) && hrefs.length < 8) hrefs.push(url); };
      const addLinksFrom = (root, maxAnchors = 12) => {
        let scanned = 0;
        for (const a of root?.querySelectorAll?.('a[href]') || []) {
          add(a.getAttribute('href'));
          scanned += 1;
          if (hrefs.length >= 8 || scanned >= maxAnchors) break;
        }
      };
      const own = el.closest?.('a[href]'); if (own) add(own.getAttribute('href'));
      addLinksFrom(el, 8);
      if (!hrefs.length) {
        const containers = ['[role="row"]', '[role="listitem"]', '[role="article"]']
          .map(selector => el.closest?.(selector))
          .filter(Boolean);
        for (const container of containers.slice(0, 2)) {
          const textLength = (container.innerText || container.textContent || '').length;
          if (textLength > 2500) continue;
          addLinksFrom(container, 12);
          if (hrefs.length) break;
        }
      }
      const key = text.toLowerCase() + '|' + hrefs.join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({ text, source, from: fromFor(text), time: timeFor(el), hrefs });
      if (items.length >= 40) break;
    }
    if (items.length >= 40) break;
  }
  const authRequired = /sign in|signin|log in|login|password|authenticate/i.test(bodyText || title || '');
  return { title, url: sanitize(location.href), source, authRequired, itemCount: items.length, items };
})()
'@
$results = @()
foreach ($targetSpec in $Targets) {
  $target = New-CdpTarget $targetSpec.url
  if ($null -eq $target -or -not $target.webSocketDebuggerUrl) {
    $results += [pscustomobject]@{ app=$targetSpec.app; action=$targetSpec.action; status='cdp_unavailable'; url=$targetSpec.url }
    continue
  }
  $value = Eval-Cdp $target.webSocketDebuggerUrl $extractor
  if ($targetSpec.app -eq 'slack' -and $targetSpec.action -eq 'notifications.snapshot') {
    $desktop = Get-SlackDesktopObservation
    if ($null -ne $desktop) {
      $results += [pscustomobject]@{ app=$targetSpec.app; action=$targetSpec.action; status='ok'; result=$desktop; fallback='slack-desktop-window' }
      continue
    }
  }
  if ($null -eq $value) {
    $results += [pscustomobject]@{ app=$targetSpec.app; action=$targetSpec.action; status='extract_failed'; url=$targetSpec.url }
  } elseif ($value.__cdpError) {
    $results += [pscustomobject]@{ app=$targetSpec.app; action=$targetSpec.action; status='extract_failed'; url=$targetSpec.url; error=$value.__cdpError }
  } else {
    $results += [pscustomobject]@{ app=$targetSpec.app; action=$targetSpec.action; status='ok'; result=$value }
  }
}
[pscustomobject]@{ capturedAt=(Get-Date).ToUniversalTime().ToString('o'); source='ms-dev-chrome-cdp'; cdpPort=$CdpPort; results=$results } | ConvertTo-Json -Depth 80 -Compress
`;
}

const SNAPSHOT_CHROME_PATTERNS = [
  /^calendar(?:\s*[|].*)?$/i,
  /^today(?:,|\s|$)/i,
  /^switch to calendar$/i,
  /^add other calendars$/i,
  /^other calendars\b/i,
  /^my calendars\b/i,
  /^delete\b/i,
  /^archive\b/i,
  /^reply(?: all)?\b/i,
  /^forward\b/i,
  /^report(?: message)?\b/i,
  /^message list\b/i,
  /^add-ins?\b/i,
  /enhance outlook with apps/i,
  /viva insights/i,
  /^chat\s*\(ctrl[+]shift[+]1\)$/i,
  /^inbox\s+-\s+[\d,]+\s+items\b/i,
  /^deleted items\s+-\s+[\d,]+\s+items\b/i,
  /^drafts?\s+-\s+[\d,]+\s+items\b/i,
  /^sent items\s+-\s+[\d,]+\s+items\b/i,
  /^tags\b/i,
  /^mark all as read\b/i,
  /^flag [/] unflag\b/i,
  /^expand to see flag options\b/i,
  /^snooze\b/i,
  /^ribbon\b/i,
  /^move [&] delete\b/i,
  /^respond\b/i,
  /^\d{4}\s+[a-z]+, selected date\b/i,
  /^\d{1,2},\s*[a-z]+,\s*today\b/i,
  /^[a-z]+,\s*\d{1,2}\s+[a-z]+,\s*today\b/i,
  /^calendar view,\s*current time\b/i,
  /^view details\b/i,
  /^calendar actions\b/i,
  /^loading calendar actions\b/i,
  /^go to today\b/i,
  /tasks are currently not shown on your grid/i,
  /create a new email message/i,
  /tell microsoft about issues related to a message/i,
  /^flag this message\b/i,
  /^keep this message at the top of your folder\b/i,
];

function isSnapshotChrome(item = {}, target = {}) {
  const text = compact(item.text, 260) || "";
  if (!text) return true;
  if (SNAPSHOT_CHROME_PATTERNS.some((pattern) => pattern.test(text))) return true;
  if (target.app === "outlook" && target.action === "notifications.snapshot") {
    if (/^[?□�\s]*today\b/i.test(text)) return true;
  }
  if (target.app === "teams" && target.action === "notifications.snapshot") {
    if (/^chat\b(?:\s*\(ctrl\+shift\+\d+\))?$/i.test(text)) return true;
    if (/^activity\b(?:\s*\(ctrl\+shift\+\d+\))?$/i.test(text)) return true;
    if (/^actions for new message\b/i.test(text)) return true;
    if (/\bhas context menu\b/i.test(text) && !/\bteams reports \d{1,4} new notifications?\b/i.test(text)) return true;
  }
  if (target.action === "calendar.snapshot" || target.action === "events.snapshot") {
    const hasEventSignal = /\b(\d{1,2}:\d{2}\s+to\s+\d{1,2}:\d{2}|all day event|\bby\s+[^,]{2,}|tentative|accepted|free|busy|join|meeting|standup|sync)\b/i.test(text);
    const isDateOnly = /^[a-z]+,?\s+\d{1,2}\s+[a-z]+,?\s+(today\s*)?(?:[|].*)?$/i.test(text);
    if (isDateOnly && !hasEventSignal) return true;
  }
  return false;
}

function rawItems(liveResult = {}) {
  return Array.isArray(liveResult.result?.items) ? liveResult.result.items : [];
}

async function existingSnapshotSummary(root, target = {}) {
  const snapshotPath = path.join(root, "snapshots", target.app, `${target.action.replace(/[^a-zA-Z0-9._-]+/g, "-")}.json`);
  const raw = await readFile(snapshotPath, "utf8").catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!raw) return { path: snapshotPath, count: 0 };
  try {
    const snapshot = JSON.parse(raw);
    const count = Number.isFinite(snapshot.count) ? snapshot.count : (Array.isArray(snapshot.items) ? snapshot.items.length : 0);
    return { path: snapshotPath, count, status: snapshot.status || null, capturedAt: snapshot.capturedAt || null };
  } catch {
    return { path: snapshotPath, count: 0 };
  }
}

function cleanInferredFrom(value) {
  const text = compact(value, 120);
  if (!text) return null;
  const placeholderCount = (text.match(/[?□�]/g) || []).length;
  if (placeholderCount >= 3) return null;
  return text;
}

function normalizeExtractedItem(item = {}, target = {}) {
  let text = compact(item.text, 240);
  if (target.app === "outlook" && target.action === "notifications.snapshot") {
    text = compact(String(text || "").replace(/\s+No conversations selected\b.*$/i, ""), 240);
  }
  if (target.app === "teams" && target.action === "notifications.snapshot") {
    const match = String(text || "").match(/(?:^|[|])\s*(\d{1,4})(?:\s+\1)?\s+new\s+notifications?\b/i)
      || String(text || "").match(/\b(\d{1,4})\b(?=.{0,80}\bnew\s+notifications?\b)/i);
    if (match) {
      const count = Number.parseInt(match[1], 10);
      return {
        text: `Teams reports ${count} new notification${count === 1 ? "" : "s"}`,
        source: "Teams",
        from: cleanInferredFrom(item.from),
        time: compact(item.time),
        hrefs: Array.isArray(item.hrefs) ? item.hrefs : [],
      };
    }
  }
  return {
    text,
    source: compact(item.source),
    from: cleanInferredFrom(item.from),
    time: compact(item.time),
    hrefs: Array.isArray(item.hrefs) ? item.hrefs : [],
  };
}

function normalizedTextKey(value) {
  return String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function hrefSignature(item = {}) {
  return (Array.isArray(item.hrefs) ? item.hrefs : []).map((href) => String(href || "")).filter(Boolean).sort().join("|");
}

function dedupeNestedItems(items = [], target = {}) {
  if (!(target.app === "outlook" && target.action === "notifications.snapshot")) return items;
  return items.filter((item, index) => {
    const text = normalizedTextKey(item.text);
    if (text.length < 24) return true;
    const source = normalizedTextKey(item.source);
    const hrefs = hrefSignature(item);
    return !items.some((other, otherIndex) => {
      if (otherIndex === index) return false;
      const otherText = normalizedTextKey(other.text);
      if (otherText.length <= text.length) return false;
      if (!otherText.includes(text)) return false;
      if (source !== normalizedTextKey(other.source)) return false;
      return hrefs === hrefSignature(other);
    });
  });
}

function snapshotInputFromResult(liveResult = {}, target = {}) {
  const result = liveResult.result || {};
  const items = rawItems(liveResult).map((item) => normalizeExtractedItem(item, target)).filter((item) => item.text && !isSnapshotChrome(item, target));
  return {
    title: compact(result.title),
    url: result.url,
    items: dedupeNestedItems(items, target),
  };
}

function slackLooksAuthRequired(liveResult = {}) {
  const title = compact(liveResult.result?.title, 180) || "";
  const url = compact(liveResult.result?.url, 240) || "";
  return Boolean(liveResult.result?.authRequired) || /find your workspace|sign in|log in|login|authenticate/i.test(`${title} ${url}`);
}

function filteredEmptyResult({ target, input, liveResult, snapshotCount = 0 }) {
  const rawCount = rawItems(liveResult).length;
  if (snapshotCount > 0 || rawCount === 0 || liveResult.result?.authRequired || slackLooksAuthRequired(liveResult)) return null;
  return {
    app: target.app,
    action: target.action,
    status: "filtered_empty",
    count: 0,
    rawCount,
    filteredCount: input.items.length,
    skippedWrite: true,
    reason: "all extracted rows were filtered out or failed include-pattern matching; preserving previous snapshot",
  };
}

async function writeLiveSnapshot({ root, target, liveResult, capturedAt }) {
  const snapshotDir = path.join(root, "snapshots", target.app);
  await mkdir(snapshotDir, { recursive: true });
  const input = snapshotInputFromResult(liveResult, target);
  if (target.app === "slack" && target.action === "notifications.snapshot") {
    const snapshot = buildSlackNotificationSnapshot(input, { now: capturedAt ? new Date(capturedAt) : new Date() });
    snapshot.source = "ms-dev-chrome-cdp";
    if (liveResult.status !== "ok") {
      snapshot.status = liveResult.status || "error";
      snapshot.error = liveResult.status || "error";
    }
    if (slackLooksAuthRequired(liveResult)) {
      snapshot.status = "auth_required";
      snapshot.authRequired = true;
    }
    const jsonPath = path.join(snapshotDir, "notifications.snapshot.json");
    const legacyJsonPath = path.join(snapshotDir, "notifications.json");
    const markdownPath = path.join(snapshotDir, "notifications.snapshot.md");
    await writeFile(jsonPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
    await writeFile(legacyJsonPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
    await writeFile(markdownPath, renderSlackNotificationMarkdown(snapshot), "utf8");
    return { app: target.app, action: target.action, status: snapshot.status, count: snapshot.counts?.items || 0, authRequired: Boolean(snapshot.authRequired), outputs: { jsonPath, legacyJsonPath, markdownPath } };
  }
  const snapshot = buildGenericSnapshot({
    app: target.app,
    kind: target.action,
    input,
    includePatterns: target.includePatterns || [],
  });
  const filteredEmpty = filteredEmptyResult({ target, input, liveResult, snapshotCount: snapshot.count });
  if (filteredEmpty) return filteredEmpty;
  const previous = await existingSnapshotSummary(root, target);
  if (snapshot.count === 0 && rawItems(liveResult).length === 0 && previous.count > 0) {
    return {
      app: target.app,
      action: target.action,
      status: "raw_empty",
      count: 0,
      preservedCount: previous.count,
      preservedPath: previous.path,
      skippedWrite: true,
      reason: "refresh returned no extracted rows; preserving previous non-empty snapshot",
    };
  }
  snapshot.capturedAt = capturedAt || snapshot.capturedAt;
  snapshot.source = "ms-dev-chrome-cdp";
  if (liveResult.status !== "ok") {
    snapshot.status = liveResult.status || "error";
    snapshot.error = liveResult.status || "error";
  }
  if (liveResult.result?.authRequired) {
    snapshot.status = "auth_required";
    snapshot.authRequired = true;
  }
  const outputs = await writeGenericSnapshot(snapshotDir, snapshot);
  return { app: target.app, action: target.action, status: snapshot.status, count: snapshot.count, authRequired: Boolean(snapshot.authRequired), outputs };
}

function parseCdpJson(stdout = "") {
  const trimmed = String(stdout || "").trim();
  if (!trimmed) throw new Error("ms-dev CDP refresh produced no JSON output");
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first === -1 || last === -1 || last < first) throw new Error("ms-dev CDP refresh output did not contain a JSON object");
  return JSON.parse(trimmed.slice(first, last + 1));
}

async function writeBridgeFailureManifest({ bridgeDir, status, config, targets = [], error }) {
  const errorKind = classifyBridgeError(error);
  const manifest = {
    version: 1,
    status,
    capturedAt: new Date().toISOString(),
    source: "ms-dev-chrome-cdp",
    cdpPort: config.cdpPort,
    config: msDevCdpCommandSummary(config),
    snapshots: [],
    failed: targets.map((target) => ({
      app: target.app,
      action: target.action,
      status,
      ...(errorKind ? { errorKind } : {}),
      error: compact(error, 500),
    })),
  };
  const manifestPath = path.join(bridgeDir, "latest-ms-dev-cdp-refresh.json");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return { ...manifest, manifestPath };
}

export async function runMsDevCdpRefresh({
  root,
  apps,
  actions,
  sshTarget,
  pwshPath,
  cdpPort,
  remoteScriptPath,
  sshConnectTimeoutSeconds,
  exec,
  timeoutMs = 120_000,
  env = process.env,
} = {}) {
  const defaults = msDevCdpConfig(env);
  const config = {
    sshTarget: sshTarget ?? defaults.sshTarget,
    pwshPath: pwshPath ?? defaults.pwshPath,
    cdpPort: cdpPort ?? defaults.cdpPort,
    remoteScriptPath: remoteScriptPath ?? defaults.remoteScriptPath,
    sshConnectTimeoutSeconds: sshConnectTimeoutSeconds ?? defaults.sshConnectTimeoutSeconds,
  };
  config.sshTarget = config.sshTarget || "";
  config.pwshPath = config.pwshPath || DEFAULT_MSDEV_PWSH;
  config.cdpPort = Number.parseInt(String(config.cdpPort || DEFAULT_MSDEV_CDP_PORT), 10) || DEFAULT_MSDEV_CDP_PORT;
  config.remoteScriptPath = config.remoteScriptPath || DEFAULT_MSDEV_REMOTE_SCRIPT;
  config.sshConnectTimeoutSeconds = Number.parseInt(String(config.sshConnectTimeoutSeconds || DEFAULT_MSDEV_SSH_CONNECT_TIMEOUT_SECONDS), 10) || DEFAULT_MSDEV_SSH_CONNECT_TIMEOUT_SECONDS;
  if (!root) throw new Error("runMsDevCdpRefresh requires root");
  if (!exec) throw new Error("runMsDevCdpRefresh requires an exec(command, args, options) function");
  const targets = selectedTargets({ apps, actions });
  if (!config.sshTarget) {
    return { status: "not_configured", reason: "set APP_AUTOMATION_MSDEV_SSH_TARGET or pass sshTarget", config: msDevCdpCommandSummary(config), targets };
  }
  const bridgeDir = path.join(root, "bridge");
  await mkdir(bridgeDir, { recursive: true });
  const localScriptPath = path.join(bridgeDir, "ms-dev-cdp-refresh.ps1");
  await writeFile(localScriptPath, buildMsDevCdpPowerShell({ cdpPort: config.cdpPort, targets }), "utf8");
  const sshArgs = sshOptions(config.sshConnectTimeoutSeconds);
  const preflightTimeoutMs = Math.min(timeoutMs, Math.max(5000, (config.sshConnectTimeoutSeconds + 2) * 1000));
  const preflight = await exec("ssh", [...sshArgs, config.sshTarget, "true"], { timeout: preflightTimeoutMs });
  if (preflight.code !== 0) {
    return writeBridgeFailureManifest({ bridgeDir, status: "preflight_failed", config, targets, error: execFailureText(preflight, "ssh preflight failed") });
  }
  const copy = await exec("scp", [...sshArgs, localScriptPath, `${config.sshTarget}:${config.remoteScriptPath}`], { timeout: timeoutMs });
  if (copy.code !== 0) {
    return writeBridgeFailureManifest({ bridgeDir, status: "copy_failed", config, targets, error: execFailureText(copy, "scp failed") });
  }
  const remoteCommand = `${shellQuote(config.pwshPath)} -NoProfile -ExecutionPolicy Bypass -File ${shellQuote(config.remoteScriptPath)}`;
  const run = await exec("ssh", [...sshArgs, config.sshTarget, remoteCommand], { timeout: timeoutMs });
  if (run.code !== 0) {
    return writeBridgeFailureManifest({ bridgeDir, status: "run_failed", config, targets, error: execFailureText(run, "ssh command failed") });
  }
  let payload;
  try {
    payload = parseCdpJson(run.stdout);
  } catch (error) {
    return writeBridgeFailureManifest({ bridgeDir, status: "parse_failed", config, targets, error: error.message });
  }
  const byKey = new Map(targets.map((target) => [`${target.app}:${target.action}`, target]));
  const snapshots = [];
  const failed = [];
  for (const liveResult of payload.results || []) {
    const target = byKey.get(`${liveResult.app}:${liveResult.action}`);
    if (!target) continue;
    if (liveResult.status !== "ok") {
      const errorKind = classifyBridgeError(liveResult.error);
      failed.push({ app: target.app, action: target.action, status: liveResult.status || "error", ...(errorKind ? { errorKind } : {}), error: compact(liveResult.error, 500) });
      continue;
    }
    snapshots.push(await writeLiveSnapshot({ root, target, liveResult, capturedAt: payload.capturedAt }));
  }
  const status = failed.length && !snapshots.length ? "extract_failed" : "ok";
  const manifest = {
    version: 1,
    status,
    capturedAt: payload.capturedAt,
    source: payload.source || "ms-dev-chrome-cdp",
    cdpPort: payload.cdpPort || config.cdpPort,
    config: msDevCdpCommandSummary(config),
    snapshots,
    failed,
  };
  const manifestPath = path.join(bridgeDir, "latest-ms-dev-cdp-refresh.json");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return { ...manifest, manifestPath };
}

export function renderMsDevCdpRefresh(summary = {}) {
  if (summary.status === "not_configured") return `ms-dev CDP refresh not configured: ${summary.reason}`;
  if (summary.status && summary.status !== "ok" && !summary.failed?.length) return `ms-dev CDP refresh ${summary.status}: ${summary.error || summary.stderr || summary.reason || "unknown error"}`;
  const failureErrorKinds = compactCounts(summary.failed || [], "errorKind");
  const snapshotStatuses = compactCounts(summary.snapshots || [], "status");
  const skippedWrite = (summary.snapshots || []).filter((snapshot) => snapshot?.skippedWrite).length;
  const lines = [`ms-dev CDP refresh status=${summary.status || "unknown"} capturedAt=${summary.capturedAt || "unknown"} snapshots=${summary.snapshots?.length || 0}${snapshotStatuses ? ` snapshotStatuses=${snapshotStatuses}` : ""}${skippedWrite ? ` skippedWrite=${skippedWrite}` : ""}${summary.failed?.length ? ` failed=${summary.failed.length}` : ""}${failureErrorKinds ? ` failureErrorKinds=${failureErrorKinds}` : ""}`];
  if (summary.manifestPath) lines.push(`manifest=${sanitizeBridgeFailureText(summary.manifestPath) || "[local-path]"}`);
  for (const snapshot of summary.snapshots || []) {
    lines.push(`${snapshot.app}.${snapshot.action}: status=${snapshot.status} items=${snapshot.count || 0}${snapshot.skippedWrite ? " skippedWrite=true" : ""}${snapshot.authRequired ? " authRequired=true" : ""}`);
  }
  for (const failure of summary.failed || []) {
    lines.push(`${failure.app}.${failure.action}: status=${failure.status}${failure.errorKind ? ` errorKind=${failure.errorKind}` : ""}${failure.error ? ` error=${failure.error}` : ""}`);
  }
  return lines.join("\n");
}
