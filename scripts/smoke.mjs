#!/usr/bin/env node
// 冒烟测试: 拉起 MCP stdio 服务器, 完成 initialize + tools/list 握手并校验工具清单。
// 不访问远端 ECS, 只验证进程可启动、协议可应答、工具未丢失。
// 用法: npm test   (或 node scripts/smoke.mjs)

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const entry = join(here, '..', 'src', 'server.mjs');

const EXPECTED = [
  'ecs_list',
  'ecs_find',
  'ecs_exec',
  'ecs_log',
  'ecs_upload',
  'ecs_download',
  'ecs_diagnose',
  'ecs_session',
];

const TIMEOUT_MS = 20_000;

const child = spawn(process.execPath, [entry], {
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
});

let stdout = '';
let stderr = '';

child.stdout.on('data', (c) => {
  stdout += c.toString('utf8');
});
child.stderr.on('data', (c) => {
  stderr += c.toString('utf8');
});

child.stdin.write(
  JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } },
  }) + '\n',
);
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
child.stdin.end();

const timer = setTimeout(() => {
  console.error('[smoke] 超时: 服务器未在 ' + TIMEOUT_MS + 'ms 内退出');
  child.kill('SIGKILL');
  process.exit(1);
}, TIMEOUT_MS);

child.on('close', (code) => {
  clearTimeout(timer);
  const lines = stdout.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const responses = [];
  for (const line of lines) {
    try {
      responses.push(JSON.parse(line));
    } catch {
      console.error('[smoke] 无法解析的响应行: ' + line.slice(0, 200));
      process.exit(1);
    }
  }

  const init = responses.find((r) => r.id === 1);
  const list = responses.find((r) => r.id === 2);

  if (!init || init.error) {
    console.error('[smoke] initialize 失败: ' + JSON.stringify(init?.error ?? null));
    console.error(stderr.trim());
    process.exit(1);
  }
  if (!list || list.error || !Array.isArray(list.result?.tools)) {
    console.error('[smoke] tools/list 失败: ' + JSON.stringify(list?.error ?? null));
    process.exit(1);
  }

  const names = list.result.tools.map((t) => t.name);
  const missing = EXPECTED.filter((n) => !names.includes(n));
  const extra = names.filter((n) => !EXPECTED.includes(n));

  console.log('[smoke] 服务器: ' + init.result.serverInfo.name + ' v' + init.result.serverInfo.version);
  console.log('[smoke] 协议版本: ' + init.result.protocolVersion);
  console.log('[smoke] 工具数量: ' + names.length + ' -> ' + names.join(', '));

  if (missing.length > 0 || extra.length > 0) {
    if (missing.length) console.error('[smoke] 缺失工具: ' + missing.join(', '));
    if (extra.length) console.error('[smoke] 多出工具: ' + extra.join(', '));
    process.exit(1);
  }

  if (code !== 0) {
    console.error('[smoke] 进程退出码非 0: ' + code);
    console.error(stderr.trim());
    process.exit(1);
  }

  // 启动自检 (workbench CLI 可用性) 只会写 stderr, 不阻塞协议
  const warn = stderr.split(/\r?\n/).find((l) => l.includes('警告'));
  if (warn) console.log('[smoke] 环境提示: ' + warn.trim());

  console.log('[smoke] PASS');
});
