#!/usr/bin/env node
// ============================================================================
// workbench-ecs — 把 dsh-workbench-ecs (v0.9.0) 的 ECS 工具移植到 WorkBuddy
// ----------------------------------------------------------------------------
// 移植来源: C:\Users\ASUS\.dsh\node_modules\dsh-workbench-ecs (github.com/nishuoyang/dsh-workbench-ecs)
// 运行方式: 零依赖 MCP stdio 服务器 (JSON-RPC 2.0, newline-delimited)。
//          包装同一本机 Workbench CLI (~/.workbench/config.json 凭据复用)。
// 移植范围 (v1): ecs_list / ecs_find / ecs_exec / ecs_log / ecs_upload /
//          ecs_download / ecs_diagnose / ecs_session。
//          保留原插件关键语义: 破坏性命令守卫(fail-closed)、read_only 护栏、
//          远端超时结算 exit_code=124、上传 sha256 校验、ANSI/进度帧清洗、
//          上传自动重试(仅瞬时网络失败)。
// 未移植 (后续): ecs_deploy / ecs_runbook / ecs_snapshot 编排引擎、伪会话、
//          detach 长任务、批量实例、可视化设置面板(dsh 专属)。
// ============================================================================

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, statSync, mkdtempSync, rmSync, createReadStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { createInterface } from 'node:readline';

const SERVER_NAME = 'workbench-ecs';
const SERVER_VERSION = '1.0.0';
const REMOTE_TIMEOUT_EXIT_CODE = 124;
const STDOUT_CAP_BYTES = 8 * 1024 * 1024;

// workbench 可执行文件解析: 先 PATH, 失败回退常见安装位置 (原插件 WORKBENCH_CANDIDATES)
const WORKBENCH_CANDIDATES = [
  'workbench',
  'C:\\Program Files\\workbench\\workbench.exe',
  'C:\\Program Files (x86)\\workbench\\workbench.exe',
];
let resolvedCli = null;

function resolveWorkbenchCli() {
  if (resolvedCli !== null) return resolvedCli;
  for (const cand of WORKBENCH_CANDIDATES) {
    try {
      const probe = spawnSync(cand, ['version'], { timeout: 8000, windowsHide: true });
      if (probe.status === 0 || (probe.stdout && String(probe.stdout).includes('workbench'))) {
        resolvedCli = cand;
        return resolvedCli;
      }
    } catch {
      // 继续尝试下一个候选
    }
  }
  throw new Error(
    'workbench CLI 不可用。请先安装: ' +
      'PowerShell: irm https://workbench-cli.oss-cn-hangzhou.aliyuncs.com/install.ps1 | iex\n' +
      '并配置凭据 ~/.workbench/config.json (AK 模式)。',
  );
}

// 子进程执行: 捕获 stdout/stderr (上限截断), 本地超时可配
function runWorkbench(argv, opts = {}) {
  const cli = resolveWorkbenchCli();
  const localTimeoutMs = (opts.localTimeoutMs ?? 180_000);
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(cli, argv, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      reject(new Error('启动 workbench 失败: ' + err.message));
      return;
    }
    const outChunks = [];
    const errChunks = [];
    let outLen = 0;
    let truncated = false;
    child.stdout.on('data', (c) => {
      outLen += c.length;
      if (outLen <= STDOUT_CAP_BYTES) outChunks.push(c);
      else truncated = true;
    });
    child.stderr.on('data', (c) => errChunks.push(c));
    const timer = setTimeout(() => {
      truncated = true;
      child.kill('SIGKILL');
    }, localTimeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error('workbench 进程错误: ' + err.message));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        stdout: Buffer.concat(outChunks).toString('utf8'),
        stderr: Buffer.concat(errChunks).toString('utf8'),
        exitCode: code ?? -1,
        stdoutTruncated: truncated,
      });
    });
  });
}

// 输出清洗 (原插件 cleanOutput): CRLF->LF, 去 ANSI/控制字符
const ANSI_RE = /\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b\][^\x07]*(\x07|\x1b\\)|\x1b[()][A-Za-z0-9]|\x1b[@-Z\\-_]/g;
const CONTROL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

// 进度帧折叠: workbench 上传/下载会输出 "⠋ Preparing...\r⠙ Preparing...\rUpload complete..."
// 这类同帧内用 \r 覆盖的画面。终端里 \r 把光标拉回行首、后写的内容覆盖前面的,
// 因此每行只保留最后一个非空片段, 正好得到最后那帧的真实结果。
function collapseCarriageReturns(text) {
  if (text.indexOf('\r') === -1) return text;
  return text
    .split('\n')
    .map((line) => {
      if (line.indexOf('\r') === -1) return line;
      const parts = line.split('\r');
      for (let i = parts.length - 1; i >= 0; i -= 1) {
        if (parts[i].trim().length > 0) return parts[i];
      }
      return '';
    })
    .join('\n');
}

function cleanOutput(text, stripAnsiFlag = true) {
  const raw = String(text ?? '').replace(/\r\n/g, '\n');
  if (stripAnsiFlag !== true) return raw;
  return collapseCarriageReturns(raw.replace(ANSI_RE, '').replace(CONTROL_RE, ''));
}

function asCliError(data) {
  if (data !== null && typeof data === 'object' && !Array.isArray(data) &&
      typeof data.code === 'number' && typeof data.message === 'string') {
    return data;
  }
  return undefined;
}

function parseCliErrorJson(text) {
  const trimmed = String(text ?? '').trim();
  if (trimmed.length === 0) return undefined;
  try { return JSON.parse(trimmed); } catch { return undefined; }
}

function parseJsonOrThrow(text, label) {
  let data;
  try { data = JSON.parse(text); } catch {
    throw new Error(label + ': 未能把 workbench 输出解析为 JSON: ' + String(text).slice(0, 500));
  }
  const cliError = asCliError(data);
  if (cliError !== undefined) {
    throw new Error(label + ': workbench CLI 错误 (code ' + cliError.code + '): ' + cliError.message);
  }
  return data;
}

function decodeCliOutput(r, label) {
  const outText = r.stdout.trim();
  const errText = r.stderr.trim();
  if (outText.length > 0) return parseJsonOrThrow(outText, label);
  const errData = asCliError(parseCliErrorJson(errText));
  if (errData !== undefined) {
    throw new Error(label + ': workbench CLI 错误 (code ' + errData.code + '): ' + errData.message);
  }
  throw new Error(label + ': workbench 无输出 (exit ' + r.exitCode + '): ' + errText.slice(0, 300));
}

// 远端结果归一: timed_out 优先结算为 124 (原插件 D14 语义)
function remoteResultOf(data, run) {
  const obj = data !== null && typeof data === 'object' && !Array.isArray(data) ? data : {};
  const r = run ?? {};
  const processExit = r.exitCode ?? undefined;
  const jsonExit = typeof obj.exit_code === 'number' ? obj.exit_code : undefined;
  const timedOut = obj.timed_out === true || (processExit === REMOTE_TIMEOUT_EXIT_CODE && jsonExit === 0);
  let exitCode;
  if (timedOut) exitCode = REMOTE_TIMEOUT_EXIT_CODE;
  else if (jsonExit !== undefined) exitCode = jsonExit;
  else if (processExit !== undefined) exitCode = processExit;
  else exitCode = 0;
  const stderrText = String(r.stderr ?? '');
  const cliError = asCliError(parseCliErrorJson(stderrText));
  const jsonStderr = String(obj.stderr ?? '');
  return {
    exit_code: exitCode,
    timed_out: timedOut ? true : undefined,
    duration: obj.duration != null ? String(obj.duration) : undefined,
    output: obj.output != null ? String(obj.output) : (obj.stdout != null ? String(obj.stdout) : ''),
    stderr: jsonStderr.length > 0 ? jsonStderr : stderrText,
    request_id: obj.request_id != null ? String(obj.request_id) : undefined,
    cli_session_id: obj.session_id != null ? String(obj.session_id) : undefined,
    timeout_message: timedOut && cliError !== undefined ? cliError.message : undefined,
  };
}

// upload/download 宽松判定 (原插件 looseOutcomeOf): 失败时 stdout 仍可能有 "完成" 行,
// 真错误在 stderr 的 {code,message}, 退出码与 stderr 都要看
function looseOutcomeOf(r, label) {
  const exitCode = r?.exitCode ?? 0;
  const stderrText = String(r?.stderr ?? '');
  const stdoutText = String(r?.stdout ?? '');
  const cliError = asCliError(parseCliErrorJson(stderrText));
  const message = stdoutText.trim().length > 0 ? stdoutText : stderrText;
  const cleaned = cleanOutput(message, true);
  const failureText = [
    cliError !== undefined ? cliError.message : '',
    cleanOutput(stderrText, true),
    cleaned,
  ].filter((p) => String(p).trim().length > 0).join('\n');
  return {
    exit_code: exitCode,
    ok: exitCode === 0 && cliError === undefined,
    message: cleaned,
    error_message: cliError !== undefined ? cliError.message : undefined,
    failure_text: failureText,
    stdout: cleanOutput(stdoutText, true),
  };
}

// 护栏模式表 (原插件 DANGEROUS_PATTERNS / WRITE_PATTERNS 逐条移植)
const DANGEROUS_PATTERNS = [
  { source: 'rm -rf / -fr', test: /(^|[;&|]\s*)rm\s+-[a-zA-Z]*(?:r[a-zA-Z]*f|f[a-zA-Z]*r)/ },
  { source: 'shutdown', test: /(^|[;&|]\s*|\b)(shutdown|poweroff|reboot|halt)\b/ },
  { source: 'mkfs', test: /\bmkfs(\.[a-z0-9]+)?\s/ },
  { source: 'dd', test: /\bdd\b\s+if=|\bdd\b\s+of=\/dev\// },
  { source: 'init 0/6', test: /\binit\s+[06]\b/ },
  { source: 'systemctl stop/disable/mask', test: /\bsystemctl\s+(stop|disable|mask)\b/ },
  { source: 'service stop', test: /\bservice\s+[a-z0-9_.-]+\s+stop\b/ },
  { source: 'iptables -F/-X', test: /\biptables\s+-[FX]\b/ },
  { source: 'userdel/groupdel', test: /\b(userdel|groupdel)\b/ },
];

const WRITE_PATTERNS = [
  { source: '输出重定向(非 /dev/null)', test: /(^|[^0-9&>])>>?\s*(?!&)(?!\/dev\/null(\s|$|;|\)|\||&))/ },
  { source: '文件增删改(rm/mv/cp/mkdir/rmdir/touch/ln/install/truncate)', test: /(?<![.\w\/-])(rm|mv|cp|mkdir|rmdir|touch|ln|install|truncate)\b/ },
  { source: '权限/属主变更(chmod/chown/chgrp/chattr)', test: /(?<![.\w\/-])(chmod|chown|chgrp|chattr)\b/ },
  { source: 'tee', test: /(?<![.\w\/-])tee\b/ },
  { source: 'sed 就地修改(-i/--in-place)', test: /\bsed\b[^;&|]*(-[a-zA-Z]*i[a-zA-Z]*\b|--in-place)/ },
  { source: '磁盘写(dd/mkfs/mkswap/mount/umount/swapoff)', test: /(?<![.\w\/-])(dd|mkswap|mount|umount|swapoff)\b|\bmkfs(\.[a-z0-9]+)?\s/ },
  { source: '服务状态变更(systemctl/service)', test: /\b(systemctl|service)\s+[^;&|]*\b(start|stop|restart|reload|enable|disable|mask|unmask|daemon-reload)\b/ },
  { source: '容器/镜像变更(docker)', test: /\bdocker\s+(run|create|start|stop|restart|kill|rm|rmi|build|push|pull|exec|cp|commit|tag|load|import|prune|pause|unpause|update)\b/ },
  { source: 'docker compose 变更', test: /\bdocker\s+compose\s+(up|down|restart|build|rm|kill|pull|push|create|start|stop)\b/ },
  { source: '包管理安装/卸载', test: /(?<![.\w\/-])(apt|apt-get|yum|dnf|apk|zypper)\s+[^;&|]*\b(install|remove|purge|upgrade|update|dist-upgrade)\b/ },
  { source: '语言包管理器写操作', test: /(?<![.\w\/-])(npm|pnpm|yarn|pip|pip3|gem|go|cargo)\s+[^;&|]*\b(install|add|ci|uninstall|remove|upgrade|update)\b/ },
  { source: 'git 写操作', test: /\bgit\s+[^;&|]*\b(pull|push|fetch|checkout|reset|clean|commit|merge|rebase|stash|apply|init|clone|tag\s+-d|branch\s+-D|remote\s+(add|set-url))\b/ },
  { source: '进程信号(kill/pkill/killall)', test: /(?<![.\w\/-])(kill|pkill|killall)\b/ },
  { source: '下载落盘(curl -o / wget -O)', test: /\b(curl|wget)\b[^;&|]*(\s-o\s|\s--output\s|\s-O\b|\s--output-document\s)/ },
  { source: '后台启动(nohup / & 后台任务)', test: /(?<![.\w\/-])nohup\b|(^|[;&|]\s*)[^;&|]*&\s*$/ },
  { source: '计划任务/用户/内核参数(crontab/useradd/usermod/passwd/sysctl -w)', test: /(?<![.\w\/-])(crontab|useradd|usermod|groupadd|passwd)\b|\bsysctl\s+-w\b/ },
  { source: 'find 写动作(-delete/-exec)', test: /\bfind\b[^;&|]*\s(-delete|-exec|-execdir|-ok)\b/ },
];

const READ_ONLY_ADVICE = [
  '不需要落盘的: 直接把结果写到 stdout(echo/printf, 不要 > 文件), 护栏放行;',
  '确实需要写入: 显式传 read_only=false(写操作必须显式声明, 不会静默放行);',
  '若是误伤(命令本身只读): 同样用 read_only=false, 并把该写法反馈给维护者以收紧规则。',
];

const WRITE_HIT_TEXT_LIMIT = 80;
const WRITE_HIT_PER_RULE_LIMIT = 3;

function collectRuleMatches(pattern, cmd) {
  const source = pattern.test.source;
  const flags = pattern.test.flags.includes('g') ? pattern.test.flags : pattern.test.flags + 'g';
  let re;
  try { re = new RegExp(source, flags); } catch { re = pattern.test; }
  const matches = [];
  let match = re.exec(cmd);
  let guard = 0;
  while (match !== null && guard < 64) {
    matches.push(match);
    guard += 1;
    if (match[0].length === 0) re.lastIndex += 1;
    match = re.exec(cmd);
  }
  return matches;
}

function describeMatch(rule, cmd, match, occurrences) {
  const raw = match[0];
  const trimmed = raw.trim();
  const offset = match.index + (raw.length - raw.replace(/^[\s;&|]+/, '').length);
  const shown = trimmed.length > WRITE_HIT_TEXT_LIMIT ? trimmed.slice(0, WRITE_HIT_TEXT_LIMIT) + '…' : trimmed;
  return { rule, matched_text: shown.length > 0 ? shown : raw, span: { start: offset, end: match.index + raw.length }, occurrences: occurrences ?? 1 };
}

function scanPatterns(patterns, text) {
  const cmd = String(text ?? '');
  const hits = [];
  for (const pattern of patterns) {
    const matches = collectRuleMatches(pattern, cmd);
    for (let i = 0; i < Math.min(matches.length, WRITE_HIT_PER_RULE_LIMIT); i++) {
      hits.push(describeMatch(pattern.source, cmd, matches[i], matches.length));
    }
  }
  return hits;
}

const scanWriteCommands = (text) => scanPatterns(WRITE_PATTERNS, text);
const scanDangerousCommands = (text) => scanPatterns(DANGEROUS_PATTERNS, text);

function renderCommandHits(hits, indent = '  ') {
  return hits.map((hit, index) => indent + '[' + (index + 1) + '] ' + hit.rule +
    ' → 命中 ' + JSON.stringify(hit.matched_text) + ' (位置 ' + hit.span.start + ')' +
    (hit.occurrences > 1 ? '(该规则共 ' + hit.occurrences + ' 处)' : '')).join('\n');
}

// 破坏性命令守卫: WorkBuddy 侧无 dsh 审批服务, 改为 fail-closed 拒绝,
// 显式传 allow_destructive=true (会出现在 WorkBuddy 权限提示里)才放行
function guardDestructiveCommand(command, label) {
  const hits = scanDangerousCommands(command);
  if (hits.length === 0) return;
  const prefix = label ? label + ': ' : '';
  const excerpt = String(command).slice(0, 300);
  throw new Error(prefix + '检测到破坏性命令模式, 已拒绝执行 (fail-closed):\n' +
    renderCommandHits(hits) + '\n  命令: ' + excerpt + '\n' +
    '  原因: 未显式声明 allow_destructive=true。这不是命令语法错误, 重试同一条命令不会有不同结果。\n' +
    '  下一步: 与用户确认后, 传 allow_destructive=true 重新调用; 或改写成更小的等价动作。');
}

function guardReadOnly(text, label) {
  const hits = scanWriteCommands(text);
  if (hits.length === 0) return;
  const excerpt = String(text).slice(0, 300);
  throw new Error((label ? label + ': ' : '') +
    'read_only=true 下检测到 ' + hits.length + ' 条写操作模式, 已拒绝执行:\n' +
    renderCommandHits(hits) + '\n  命令: ' + excerpt + '\n' +
    '  只读等价写法建议:\n' + READ_ONLY_ADVICE.map((l) => '    - ' + l).join('\n'));
}

function resolveTimeout(explicit, fallback) {
  const n = Number(explicit);
  if (Number.isFinite(n) && n > 0) return Math.floor(n);
  return fallback;
}

function shellQuote(text) {
  return "'" + String(text).replace(/'/g, "'\\''") + "'";
}

// 内置地域清单 (原插件 ECS_PUBLIC_REGIONS)
const ECS_PUBLIC_REGIONS = [
  'cn-shanghai', 'cn-hangzhou', 'cn-beijing', 'cn-shenzhen', 'cn-guangzhou',
  'cn-zhangjiakou', 'cn-qingdao', 'cn-chengdu', 'cn-wulanchabu', 'cn-hongkong',
  'ap-southeast-1', 'ap-southeast-2', 'ap-southeast-3', 'ap-southeast-5',
  'ap-northeast-1', 'ap-northeast-2', 'ap-south-1',
  'eu-central-1', 'eu-west-1', 'us-west-1', 'us-east-1', 'me-east-1',
];

function normalizeRegion(value) {
  return String(value ?? '').trim().toLowerCase();
}

function parseRegionSpec(region) {
  const raw = normalizeRegion(region);
  if (raw.length === 0 || raw === 'all' || raw === '*') {
    return { mode: 'all', regions: ECS_PUBLIC_REGIONS.slice() };
  }
  const parts = raw.split(/[\s,;]+/).map((r) => r.trim()).filter((r) => r.length > 0);
  const unique = [...new Set(parts)];
  return { mode: unique.length > 1 ? 'list' : 'single', regions: unique };
}

function normalizeInstanceRow(it) {
  const src = (it !== null && typeof it === 'object') ? it : {};
  return {
    instance_id: src.instance_id != null ? String(src.instance_id) : '',
    instance_name: src.instance_name != null ? String(src.instance_name) : '',
    instance_type: src.instance_type != null ? String(src.instance_type) : '',
    region_id: src.region_id != null ? String(src.region_id) : '',
    status: src.status != null ? String(src.status) : '',
    private_ip: src.private_ip != null ? String(src.private_ip) : '',
    public_ip: src.public_ip != null ? String(src.public_ip) : '',
    os_type: src.os_type != null ? String(src.os_type) : '',
    image_id: src.image_id != null ? String(src.image_id) : '',
    tags: src.tags != null ? src.tags : {},
  };
}

function instancesOf(data) {
  if (Array.isArray(data)) return data;
  if (data !== null && typeof data === 'object' && Array.isArray(data.instances)) return data.instances;
  return undefined;
}

function matchInstanceKeyword(instance, keyword) {
  const kw = String(keyword ?? '').trim().toLowerCase();
  if (kw.length === 0) return true;
  const row = normalizeInstanceRow(instance);
  const haystack = [
    row.instance_id, row.instance_name, row.instance_type, row.private_ip, row.public_ip,
    row.image_id, row.region_id, row.status,
    Object.keys(row.tags).join(' '), Object.values(row.tags).map((v) => String(v)).join(' '),
  ].join(' ').toLowerCase();
  return haystack.includes(kw);
}

function buildListEcsArgv(opts = {}) {
  const argv = ['list', 'ecs', '--region', String(opts.region), '--output', 'json'];
  if (opts.status) argv.push('--status', String(opts.status));
  if (Array.isArray(opts.tag)) for (const t of opts.tag) argv.push('--tag', String(t));
  if (opts.instance_type) argv.push('--instance-type', String(opts.instance_type));
  if (opts.instance_name) argv.push('--instance-name', String(opts.instance_name));
  if (opts.vpc_id) argv.push('--vpc-id', String(opts.vpc_id));
  if (opts.zone_id) argv.push('--zone-id', String(opts.zone_id));
  if (opts.limit) argv.push('--limit', String(opts.limit));
  return argv;
}

function normalizeLimit(value, fallback = 50) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 10) return fallback;
  return Math.min(Math.floor(n), 100);
}

async function runWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let idx = 0;
  const runners = [];
  for (let i = 0; i < Math.min(limit, items.length); i++) {
    runners.push((async () => {
      while (idx < items.length) {
        const my = idx++;
        results[my] = await worker(items[my], my);
      }
    })());
  }
  await Promise.all(runners);
  return results;
}

// 本机 sha256 (crypto) / 远端 sha256 (sha256sum)
function localSha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (c) => hash.update(c));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

async function remoteSha256(instanceId, remotePath, region) {
  const argv = ['exec', '--instance-id', instanceId, '--command', 'sha256sum ' + shellQuote(remotePath) + " | cut -d' ' -f1", '--timeout', '60', '--output', 'json'];
  if (region) argv.push('--region', region);
  const r = await runWorkbench(argv);
  const data = decodeCliOutput(r, 'ecs_upload sha256');
  const remote = remoteResultOf(data, r);
  const m = /[0-9a-fA-F]{64}/.exec(String(remote.output).replace(/\s+/g, ''));
  return m ? m[0].toLowerCase() : undefined;
}

// ecs_exec 单实例前台执行
async function execOne(instanceId, remoteCommand, args) {
  const argv = ['exec', '--instance-id', instanceId, '--command', remoteCommand, '--output', 'json',
    '--timeout', String(resolveTimeout(args.timeout, 60))];
  if (args.region) argv.push('--region', String(args.region));
  const r = await runWorkbench(argv, { localTimeoutMs: (resolveTimeout(args.timeout, 60) + 90) * 1000 });
  const data = decodeCliOutput(r, 'ecs_exec');
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('ecs_exec: 意外的输出结构: ' + r.stdout.slice(0, 300));
  }
  const remote = remoteResultOf(data, r);
  return {
    instance_id: instanceId,
    exit_code: remote.exit_code,
    output: cleanOutput(remote.output, args.strip_ansi !== false),
    stderr: cleanOutput(remote.stderr, args.strip_ansi !== false),
    request_id: remote.request_id,
    cli_session_id: remote.cli_session_id,
    timed_out: remote.timed_out,
    duration: remote.duration,
    timeout_message: remote.timeout_message,
    stdout_truncated: r.stdoutTruncated === true,
  };
}

// 脚本 base64 直送 (原插件 script 语义简化): 内容不经过 shell 引用层
function buildScriptDelivery(script, shell = 'bash') {
  const b64 = Buffer.from(script, 'utf8').toString('base64');
  if (b64.length > 200_000) {
    throw new Error('ecs_exec: script 过大 (' + b64.length + ' chars base64), 请拆分后执行');
  }
  const tmp = '/tmp/wb-ecs-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8) + '.sh';
  return "echo '" + b64 + "' | base64 -d > " + tmp + ' && ' + shell + ' ' + tmp + '; rc=$?; rm -f ' + tmp + '; exit $rc';
}

// ecs_log: 字节游标读远端文件
const LOG_MARKER = '__WB_ECS_LOG__';

async function readRemoteLog(instanceId, path, offset, maxBytes, region) {
  const off = Math.max(0, Math.floor(Number(offset) || 0));
  const max = Math.min(Math.max(1, Math.floor(Number(maxBytes) || 65536)), 1024 * 1024);
  const q = shellQuote(path);
  const cmd =
    'f=' + q + '; if [ ! -e "$f" ]; then echo "' + LOG_MARKER + ' MISSING"; else ' +
    'sz=$(wc -c <"$f" | tr -d " "); echo "' + LOG_MARKER + ' SIZE $sz"; ' +
    'tail -c +' + (off + 1) + ' "$f" | head -c ' + max + '; echo; echo "' + LOG_MARKER + ' END"; fi';
  const result = await execOne(instanceId, cmd, { region, timeout: 60, strip_ansi: true });
  const text = result.output;
  const sizeM = new RegExp(LOG_MARKER + ' SIZE (\\d+)').exec(text);
  if (text.includes(LOG_MARKER + ' MISSING')) {
    return { path, exists: false, message: '远端文件不存在: ' + path };
  }
  const size = sizeM ? Number(sizeM[1]) : undefined;
  let body = text.split('\n').filter((l) => !l.startsWith(LOG_MARKER)).join('\n');
  if (body.endsWith('\n')) body = body.slice(0, -1);
  const bytesRead = Buffer.byteLength(body, 'utf8');
  return {
    path,
    exists: true,
    size,
    offset: off,
    next_offset: Math.min(off + bytesRead, size ?? off + bytesRead),
    eof: size !== undefined ? off + bytesRead >= size : undefined,
    content: body,
  };
}

// 诊断预置脚本 (原插件 DIAGNOSE_SECTIONS 逐条移植)
const DIAGNOSE_SECTIONS = [
  { id: 'host', title: '1/7 主机信息', command: 'hostname; uname -a; cat /etc/os-release 2>/dev/null | head -3' },
  { id: 'load', title: '2/7 负载与运行时长', command: 'uptime' },
  { id: 'mem', title: '3/7 内存', command: 'free -m' },
  { id: 'disk', title: '4/7 磁盘', command: 'df -h' },
  { id: 'services', title: '5/7 运行服务与容器', command: 'systemctl --no-pager list-units --type=service --state=running 2>/dev/null | head -25; docker ps --format "table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}" 2>/dev/null' },
  { id: 'processes', title: '6/7 内存 TOP 进程', command: 'ps aux --sort=-%mem 2>/dev/null | head -15' },
  { id: 'ports', title: '7/7 监听端口', command: 'ss -tlnp 2>/dev/null | head -30' },
];
const DIAGNOSE_SECTION_IDS = DIAGNOSE_SECTIONS.map((s) => s.id).concat(['extra']);

function buildDiagnoseScript(extra, sections) {
  const wantedIds = Array.isArray(sections) && sections.length > 0
    ? sections.map((s) => String(s).trim().toLowerCase())
    : DIAGNOSE_SECTIONS.map((s) => s.id);
  const unknown = wantedIds.filter((id) => !DIAGNOSE_SECTION_IDS.includes(id));
  if (unknown.length > 0) {
    throw new Error('ecs_diagnose: 未知段落 ' + unknown.join('/') + '; 可选值: ' + DIAGNOSE_SECTION_IDS.join(' / '));
  }
  const includeExtra = wantedIds.includes('extra');
  const bodyIds = wantedIds.filter((id) => id !== 'extra');
  const parts = [];
  for (const section of DIAGNOSE_SECTIONS) {
    if (!bodyIds.includes(section.id)) continue;
    parts.push('echo "==== ' + section.title + ' ===="');
    parts.push('(' + section.command + ') 2>/dev/null');
  }
  if (extra != null && String(extra).trim().length > 0 && (includeExtra || !Array.isArray(sections))) {
    parts.push('echo "==== 自定义 ===="');
    parts.push('(' + String(extra).trim() + ') 2>/dev/null');
  }
  return parts.join('; ');
}

// 工具实现: ecs_list / ecs_find
async function toolEcsList(args) {
  const region = normalizeRegion(args.region);
  if (region.length === 0) throw new Error('ecs_list: region 必填 (跨地域查找用 ecs_find)');
  const limit = normalizeLimit(args.limit);
  const argv = buildListEcsArgv({
    region,
    status: args.status,
    tag: args.tag,
    instance_type: args.instance_type,
    instance_name: args.instance_name,
    vpc_id: args.vpc_id,
    zone_id: args.zone_id,
    limit,
  });
  const r = await runWorkbench(argv);
  const data = decodeCliOutput(r, 'ecs_list');
  const raw = instancesOf(data);
  if (raw === undefined) throw new Error('ecs_list: 意外的输出结构: ' + r.stdout.slice(0, 300));
  const instances = raw.map(normalizeInstanceRow);
  const value = { region, count: instances.length, instances, command: 'workbench ' + argv.join(' ') };
  if (instances.length === 0) {
    value.empty_hint = '该地域返回 0 台; 可用 ecs_find 跨地域检索(无需猜地域), 或放宽过滤条件';
  }
  const lines = [];
  lines.push('ECS 实例列表 — 地域: ' + region + ', 共 ' + instances.length + ' 台');
  if (instances.length > 0) {
    const cols = [
      ['instance_id', '实例ID', 22], ['instance_name', '名称', 18], ['instance_type', '规格', 16],
      ['status', '状态', 10], ['private_ip', '私网IP', 16], ['public_ip', '公网IP', 16],
    ];
    lines.push(cols.map((c) => c[1].padEnd(c[2])).join('  '));
    for (const inst of instances) {
      lines.push(cols.map((c) => String(inst[c[0]] ?? '').padEnd(c[2])).join('  '));
    }
  } else {
    lines.push('(没有符合条件的实例)');
    lines.push('[提示: ' + value.empty_hint + ']');
  }
  return { text: lines.join('\n'), json: value };
}

async function toolEcsFind(args) {
  const spec = parseRegionSpec(args.region);
  const keyword = args.keyword != null ? String(args.keyword) : '';
  const status = args.status;
  const perRegion = [];
  await runWithConcurrency(spec.regions, 4, async (region) => {
    try {
      const argv = buildListEcsArgv({ region, status, limit: 100 });
      const r = await runWorkbench(argv);
      const data = decodeCliOutput(r, 'ecs_find ' + region);
      const raw = instancesOf(data) ?? [];
      const hits = raw.map(normalizeInstanceRow).filter((row) => {
        if (status && row.status !== status) return false;
        return matchInstanceKeyword(row, keyword);
      });
      perRegion.push({ region, ok: true, count: hits.length, instances: hits });
    } catch (err) {
      perRegion.push({ region, ok: false, error: String(err.message ?? err) });
    }
  });
  perRegion.sort((a, b) => (b.count ?? 0) - (a.count ?? 0));
  const total = perRegion.reduce((n, g) => n + (g.count ?? 0), 0);
  const value = {
    keyword,
    regions_tried: spec.regions.length,
    regions_ok: perRegion.filter((g) => g.ok).length,
    regions_failed: perRegion.filter((g) => !g.ok).map((g) => ({ region: g.region, error: g.error })),
    total_matches: total,
    matches: perRegion.filter((g) => g.ok && g.count > 0),
  };
  const lines = [];
  lines.push('ecs_find 关键字=' + JSON.stringify(keyword) + ' — 命中 ' + total + ' 台 (检索 ' +
    value.regions_ok + '/' + value.regions_tried + ' 个地域)');
  for (const g of value.matches) {
    lines.push('[' + g.region + '] ' + g.count + ' 台:');
    for (const inst of g.instances) {
      lines.push('  ' + inst.instance_id + '  ' + inst.instance_name + '  [' + inst.status + ']  ' +
        (inst.public_ip || inst.private_ip || ''));
    }
  }
  if (value.regions_failed.length > 0) {
    lines.push('失败地域: ' + value.regions_failed.map((f) => f.region + '(' + f.error + ')').join('; '));
  }
  if (total === 0) lines.push('(无命中; 可换关键字或用 ecs_list 指定地域全量列出)');
  return { text: lines.join('\n'), json: value };
}

// 工具实现: ecs_exec / ecs_log
async function toolEcsExec(args) {
  const instanceId = String(args.instance_id ?? '').trim();
  if (!instanceId) throw new Error('ecs_exec: instance_id 必填');
  const hasCommand = args.command != null && String(args.command).length > 0;
  const hasScript = args.script != null && String(args.script).length > 0;
  if (hasCommand === hasScript) throw new Error('ecs_exec: command 与 script 必须且只能提供一个');

  let payload;
  if (hasScript) {
    payload = buildScriptDelivery(String(args.script), args.shell === 'sh' ? 'sh' : 'bash');
  } else {
    payload = String(args.command);
  }

  if (args.read_only === true) guardReadOnly(payload, 'ecs_exec');
  if (args.allow_destructive !== true) guardDestructiveCommand(payload, 'ecs_exec');

  const result = await execOne(instanceId, payload, args);
  const lines = [];
  lines.push('[' + instanceId + '] exit_code=' + result.exit_code +
    (result.timed_out ? ' (timed_out → 124)' : '') +
    (result.duration ? ' duration=' + result.duration : ''));
  if (result.timeout_message) lines.push('超时信息: ' + result.timeout_message);
  if (result.output) lines.push('--- stdout ---\n' + result.output);
  if (result.stderr) lines.push('--- stderr ---\n' + result.stderr);
  if (result.stdout_truncated) lines.push('[注意: CLI 输出超过捕获上限已截断]');
  return {
    text: lines.join('\n'),
    json: { ...result },
    isError: result.exit_code !== 0,
  };
}

async function toolEcsLog(args) {
  const instanceId = String(args.instance_id ?? '').trim();
  const path = String(args.path ?? '').trim();
  if (!instanceId || !path) throw new Error('ecs_log: instance_id 与 path 必填');
  const value = await readRemoteLog(instanceId, path, args.offset ?? 0, args.max_bytes ?? 65536, args.region);
  const lines = [];
  if (!value.exists) {
    lines.push('ecs_log: ' + value.message);
  } else {
    lines.push('ecs_log: ' + path + '  size=' + value.size + '  offset=' + value.offset + ' → next_offset=' + value.next_offset + (value.eof ? ' (EOF)' : ''));
    lines.push('--- 内容 ---');
    lines.push(value.content);
  }
  return { text: lines.join('\n'), json: value };
}

// 工具实现: ecs_upload / ecs_download
function isTransientFailure(failureText) {
  return /timeout|timed out|network|connection|reset|unavailable|ECONN|ETIMEDOUT|EPIPE|socket|502|503|504|OSS/i.test(failureText);
}

async function uploadSingleFile(instanceId, localFile, remotePath, args) {
  const verify = args.verify_sha256 !== false;
  const retries = Number.isFinite(Number(args.retries)) ? Math.max(0, Math.floor(Number(args.retries))) : 2;
  const argv = ['upload', localFile, remotePath, '--instance-id', instanceId, '--output', 'json'];
  if (args.region) argv.push('--region', String(args.region));
  if (args.force === true) argv.push('--force');

  let last;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const r = await runWorkbench(argv, { localTimeoutMs: 600_000 });
    const outcome = looseOutcomeOf(r, 'ecs_upload');
    last = outcome;
    if (outcome.ok) break;
    if (attempt < retries && isTransientFailure(outcome.failure_text)) {
      await new Promise((res) => setTimeout(res, 1000 * Math.pow(2, attempt)));
      continue;
    }
    break;
  }
  if (!last.ok) {
    throw new Error('ecs_upload 失败 (问题在 本机 → OSS 中继 段, 非目标实例; 上传幂等可稍后重跑):\n' +
      (last.error_message ? 'CLI: ' + last.error_message + '\n' : '') + last.failure_text.slice(0, 800));
  }

  let sha;
  if (verify) {
    const localHash = await localSha256(localFile);
    const remoteHash = await remoteSha256(instanceId, remotePath, args.region);
    sha = { local: localHash, remote: remoteHash, verified: localHash === remoteHash };
    if (remoteHash !== undefined && localHash !== remoteHash) {
      throw new Error('ecs_upload: sha256 校验不一致, 已中止 (local=' + localHash + ' remote=' + remoteHash + ')');
    }
  }
  return { uploaded: localFile, remote_path: remotePath, message: last.message, sha256: sha };
}

async function toolEcsUpload(args) {
  const instanceId = String(args.instance_id ?? '').trim();
  const localPath = String(args.local_file ?? args.local_dir ?? '').trim();
  const remotePath = String(args.remote_path ?? '').trim();
  if (!instanceId || !localPath || !remotePath) {
    throw new Error('ecs_upload: instance_id 与 local_file/local_dir 与 remote_path 必填');
  }
  if (!existsSync(localPath)) throw new Error('ecs_upload: 本地路径不存在: ' + localPath);
  const isDir = statSync(localPath).isDirectory();

  if (!isDir) {
    const value = await uploadSingleFile(instanceId, localPath, remotePath, args);
    return { text: 'ecs_upload OK: ' + localPath + ' → ' + remotePath + (value.sha256?.verified ? ' (sha256 已核对)' : ''), json: value };
  }

  // 目录递归: 本地 tar → 上传 → 校验 → 远端解包 (原插件 v0.5.1 语义)
  const tmp = mkdtempSync(join(tmpdir(), 'wb-ecs-'));
  const archive = join(tmp, basename(localPath) + '.tgz');
  try {
    await new Promise((resolve, reject) => {
      const t = spawn('tar', ['-czf', archive, '-C', localPath, '.'], { windowsHide: true });
      t.on('error', reject);
      t.on('close', (code) => (code === 0 ? resolve() : reject(new Error('本地 tar 打包失败 exit=' + code))));
    });
    const remoteArchive = remotePath.replace(/\/+$/, '') + '/.wb-upload-' + Date.now().toString(36) + '.tgz';
    const up = await uploadSingleFile(instanceId, archive, remoteArchive, args);
    const unpackCmd = 'mkdir -p ' + shellQuote(remotePath) + ' && tar -xzf ' + shellQuote(remoteArchive) +
      ' -C ' + shellQuote(remotePath) + ' && rm -f ' + shellQuote(remoteArchive);
    const result = await execOne(instanceId, unpackCmd, { region: args.region, timeout: 120, strip_ansi: true });
    if (result.exit_code !== 0) {
      throw new Error('ecs_upload: 远端解包失败 exit=' + result.exit_code + '\n' + result.output + result.stderr);
    }
    return {
      text: 'ecs_upload OK (目录): ' + localPath + ' → ' + remotePath + '/' + (up.sha256?.verified ? ' (归档 sha256 已核对)' : ''),
      json: { local_dir: localPath, remote_path: remotePath, archive_sha256: up.sha256, unpack_exit: result.exit_code },
    };
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* 清理失败忽略 */ }
  }
}

async function toolEcsDownload(args) {
  const instanceId = String(args.instance_id ?? '').trim();
  const remotePath = String(args.remote_path ?? '').trim();
  if (!instanceId || !remotePath) throw new Error('ecs_download: instance_id 与 remote_path 必填');
  const argv = ['download', remotePath, '--instance-id', instanceId, '--output', 'json'];
  if (args.local_path) argv.push(String(args.local_path));
  if (args.region) argv.push('--region', String(args.region));
  if (args.force === true) argv.push('--force');
  const r = await runWorkbench(argv, { localTimeoutMs: 600_000 });
  const outcome = looseOutcomeOf(r, 'ecs_download');
  if (!outcome.ok) {
    throw new Error('ecs_download 失败:\n' + (outcome.error_message ? 'CLI: ' + outcome.error_message + '\n' : '') + outcome.failure_text.slice(0, 800));
  }
  return {
    text: 'ecs_download OK: ' + remotePath + (args.local_path ? ' → ' + args.local_path : '') + '\n' + outcome.message,
    json: { remote_path: remotePath, local_path: args.local_path, message: outcome.message },
  };
}

// 工具实现: ecs_diagnose / ecs_session
async function toolEcsDiagnose(args) {
  const instanceId = String(args.instance_id ?? '').trim();
  if (!instanceId) throw new Error('ecs_diagnose: instance_id 必填');
  const script = buildDiagnoseScript(args.extra_command, args.sections);
  if (args.read_only !== false) guardReadOnly(script, 'ecs_diagnose');
  const result = await execOne(instanceId, script, { region: args.region, timeout: resolveTimeout(args.timeout, 120), strip_ansi: true });
  return {
    text: '[' + instanceId + '] 体检 exit_code=' + result.exit_code + '\n' + result.output + (result.stderr ? '\n--- stderr ---\n' + result.stderr : ''),
    json: { instance_id: instanceId, exit_code: result.exit_code, sections: args.sections ?? DIAGNOSE_SECTIONS.map((s) => s.id) },
    isError: result.exit_code !== 0,
  };
}

async function toolEcsSession(args) {
  const action = String(args.action ?? '').trim();
  let argv;
  if (action === 'list') argv = ['session', 'list', '--output', 'json'];
  else if (action === 'close') {
    argv = args.all === true ? ['session', 'close', '--all', '--output', 'json']
      : args.session_id ? ['session', 'close', String(args.session_id), '--output', 'json']
        : null;
    if (argv === null) throw new Error('ecs_session: close 需要 session_id 或 all=true');
  } else throw new Error("ecs_session: action 必须是 'list' 或 'close'");
  const r = await runWorkbench(argv);
  const raw = r.stdout.trim().length > 0 ? r.stdout : r.stderr;
  const text = cleanOutput(raw, true);
  const parsed = parseCliErrorJson(raw);

  // workbench session list 在没有活动会话时直接返回 null, 归一成空数组,
  // 否则调用方拿到的是字面量 "null", 既不是列表也无法判断条数。
  if (action === 'list') {
    const sessions = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed?.sessions) ? parsed.sessions : [];
    return {
      text: sessions.length === 0 ? '没有活动的 Workbench 会话' : text.slice(0, 20000),
      json: { sessions, count: sessions.length },
    };
  }

  return { text: text.slice(0, 20000), json: parsed ?? { raw: text.slice(0, 2000) } };
}

// MCP 工具清单 (前 4 个)
const TOOLS = [
  {
    name: 'ecs_list',
    description: '列出指定阿里云地域的 ECS 实例(单地域必填)。返回实例ID/名称/规格/状态/内网IP/公网IP。返回 0 台时提示改用 ecs_find 跨地域检索。',
    inputSchema: {
      type: 'object',
      properties: {
        region: { type: 'string', description: '地域, 如 cn-shanghai (必填; 跨地域查找用 ecs_find)' },
        status: { type: 'string', enum: ['Running', 'Stopped', 'Starting', 'Stopping'], description: '按状态过滤' },
        tag: { type: 'array', items: { type: 'string' }, description: '按标签过滤, 形如 key=value' },
        instance_name: { type: 'string', description: '按实例名称过滤, 支持 * 通配符' },
        instance_type: { type: 'string', description: '按规格过滤' },
        vpc_id: { type: 'string' },
        zone_id: { type: 'string' },
        limit: { type: 'number', description: '页大小 10-100, 默认 50' },
      },
      required: ['region'],
    },
    handler: toolEcsList,
  },
  {
    name: 'ecs_find',
    description: '跨地域关键字检索 ECS 实例(不知道实例在哪个地域时用)。关键字匹配 实例名/ID/内网·公网IP/规格/标签, 大小写不敏感; region 缺省即并发检索全部 22 个公共地域。',
    inputSchema: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: '子串匹配关键字; 空则列出全部' },
        region: { type: 'string', description: "缺省或 all = 全部地域; 也可单个或逗号分隔多个" },
        status: { type: 'string', enum: ['Running', 'Stopped', 'Starting', 'Stopping'] },
      },
    },
    handler: toolEcsFind,
  },
  {
    name: 'ecs_exec',
    description: '在指定 ECS 实例上执行远程命令或脚本(经阿里云 Workbench 通道, 无需公网IP)。command 与 script 二选一; script 走 base64 直送零转义。read_only=true 拒绝任何写操作; 破坏性命令(rm -rf/shutdown/dd 等)默认拒绝, 确认后传 allow_destructive=true 放行。远端超时结算为 exit_code=124。',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'ECS 实例 ID, 如 i-bp1xxxxxxxxxxxxxxxxx (必填)' },
        command: { type: 'string', description: '单条远程命令 (与 script 二选一)' },
        script: { type: 'string', description: '多行脚本正文, base64 直送远端落盘执行, 零转义' },
        shell: { type: 'string', enum: ['bash', 'sh'], description: 'script 的远端解释器, 默认 bash' },
        region: { type: 'string', description: '地域; 一般可从实例ID推断' },
        timeout: { type: 'number', description: '远端命令超时秒数, 默认 60' },
        read_only: { type: 'boolean', description: 'true=只读护栏, 拒绝重定向/rm/docker 变更等写操作' },
        allow_destructive: { type: 'boolean', description: '显式放行破坏性命令(rm -rf/shutdown/dd/systemctl stop 等); 与用户确认后才传 true' },
        strip_ansi: { type: 'boolean', description: '清洗 ANSI/控制字符, 默认 true' },
      },
      required: ['instance_id'],
    },
    handler: toolEcsExec,
  },
  {
    name: 'ecs_log',
    description: '按字节游标读取远端文件(日志续读)。offset=0 从头读, 返回 next_offset 供下次续读; 适合轮询长任务日志。',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: '实例 ID (必填)' },
        path: { type: 'string', description: '远端文件绝对路径 (必填)' },
        offset: { type: 'number', description: '字节偏移, 默认 0 (从头)' },
        max_bytes: { type: 'number', description: '本次最多读取字节数, 默认 65536, 上限 1MB' },
        region: { type: 'string' },
      },
      required: ['instance_id', 'path'],
    },
    handler: toolEcsLog,
  },
];

TOOLS.push(
  {
    name: 'ecs_upload',
    description: '上传本地文件或目录到 ECS 实例(OSS 中继)。verify_sha256 默认开启(不一致即中止); 传 local_dir 时自动 tar 归档→上传→校验→远端解包; 瞬时网络失败自动重试(默认 2 次)。',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: '实例 ID (必填)' },
        local_file: { type: 'string', description: '本地文件路径 (与 local_dir 二选一)' },
        local_dir: { type: 'string', description: '本地目录路径, 递归上传 (与 local_file 二选一)' },
        remote_path: { type: 'string', description: '远端目标路径 (必填; 目录上传时为目标目录)' },
        region: { type: 'string' },
        force: { type: 'boolean', description: '覆盖远端已存在的同名文件' },
        verify_sha256: { type: 'boolean', description: '上传后校验 sha256, 默认 true' },
        retries: { type: 'number', description: '瞬时失败重试次数, 默认 2' },
      },
      required: ['instance_id', 'remote_path'],
    },
    handler: toolEcsUpload,
  },
  {
    name: 'ecs_download',
    description: '从 ECS 实例下载远端文件到本机。',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: '实例 ID (必填)' },
        remote_path: { type: 'string', description: '远端文件路径 (必填)' },
        local_path: { type: 'string', description: '本地保存路径; 缺省用 CLI 默认位置' },
        region: { type: 'string' },
        force: { type: 'boolean', description: '覆盖本地已存在的同名文件' },
      },
      required: ['instance_id', 'remote_path'],
    },
    handler: toolEcsDownload,
  },
  {
    name: 'ecs_diagnose',
    description: '对实例跑预置只读体检(主机/负载/内存/磁盘/服务容器/进程/端口 7 段)。默认 read_only, 可用 sections 选段、extra_command 附加自定义只读命令。',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: '实例 ID (必填)' },
        sections: { type: 'array', items: { type: 'string' }, description: '段落 id: host/load/mem/disk/services/processes/ports/extra; 缺省全部' },
        extra_command: { type: 'string', description: '附加自定义只读命令' },
        region: { type: 'string' },
        timeout: { type: 'number', description: '超时秒数, 默认 120' },
        read_only: { type: 'boolean', description: '只读护栏, 默认 true' },
      },
      required: ['instance_id'],
    },
    handler: toolEcsDiagnose,
  },
  {
    name: 'ecs_session',
    description: "管理 Workbench CLI 的 shell 会话: action='list' 查看活动会话; action='close' 关闭(需 session_id 或 all=true)。",
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'close'], description: 'list 或 close (必填)' },
        session_id: { type: 'string', description: 'close 时指定会话 ID' },
        all: { type: 'boolean', description: 'close 时关闭全部会话' },
      },
      required: ['action'],
    },
    handler: toolEcsSession,
  },
);

// MCP stdio 协议循环 (JSON-RPC 2.0, newline-delimited)
function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function replyError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

async function handleRequest(msg) {
  const { id, method, params } = msg;
  const isNotification = id === undefined || id === null;

  switch (method) {
    case 'initialize':
      reply(id, {
        protocolVersion: params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
      return;
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return;
    case 'ping':
      reply(id, {});
      return;
    case 'tools/list':
      reply(id, {
        tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
      });
      return;
    case 'tools/call': {
      const name = params?.name;
      const args = params?.arguments ?? {};
      const tool = TOOLS.find((t) => t.name === name);
      if (tool === undefined) {
        replyError(id, -32602, '未知工具: ' + name);
        return;
      }
      try {
        const result = await tool.handler(args);
        const content = [{ type: 'text', text: result.text }];
        if (result.json !== undefined) {
          content.push({ type: 'text', text: '```json\n' + JSON.stringify(result.json, null, 2) + '\n```' });
        }
        reply(id, { content, isError: result.isError === true ? true : undefined });
      } catch (err) {
        reply(id, { content: [{ type: 'text', text: String(err.message ?? err) }], isError: true });
      }
      return;
    }
    default:
      if (!isNotification) replyError(id, -32601, 'Method not found: ' + method);
  }
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
// 挂起中的请求: stdin 关闭(批量输入)时必须等它们完成, 否则工具调用会被 process.exit 掐断
const pending = new Set();
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (trimmed.length === 0) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return;
  }
  const p = handleRequest(msg).catch((err) => {
    if (msg.id !== undefined && msg.id !== null) {
      replyError(msg.id, -32603, String(err.message ?? err));
    }
  });
  pending.add(p);
  p.finally(() => pending.delete(p));
});
rl.on('close', async () => {
  await Promise.allSettled([...pending]);
  process.exit(0);
});

// 启动自检: CLI 可用性写 stderr (不影响 stdio 协议)
try {
  resolveWorkbenchCli();
  console.error('[' + SERVER_NAME + '] v' + SERVER_VERSION + ' ready, workbench CLI: ' + resolvedCli);
} catch (err) {
  console.error('[' + SERVER_NAME + '] 警告: ' + err.message);
}
