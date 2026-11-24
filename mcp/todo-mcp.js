#!/usr/bin/env node
/**
 * Todo MCP Server
 * 让 WorkBuddy 通过 MCP 增删改查 todo-app 的数据。
 *
 * 传输：stdio（JSON-RPC 2.0，按行分隔）
 * 数据通道：走 todo-app 的 HTTP API（默认 http://127.0.0.1:3000），
 *          这样所有变更都会被应用广播到浏览器，实现 UI 实时联动。
 */
'use strict';

const readline = require('readline');

const API_BASE = (process.env.TODO_API_BASE || 'http://127.0.0.1:3000').replace(/\/$/, '');
const SERVER_INFO = { name: 'todo-app', version: '1.0.0' };
const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05', '2024-10-07'];

/* ---------------------- HTTP 客户端 ---------------------- */

class ApiError extends Error {}

async function api(path, options = {}) {
  let res;
  try {
    res = await fetch(API_BASE + path, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        'X-Client': 'mcp', // 服务端据此标记变更来源，前端才会提示“来自 MCP”
        ...(options.headers || {}),
      },
      signal: AbortSignal.timeout(8000),
    });
  } catch (err) {
    if (err.name === 'TimeoutError') {
      throw new ApiError(`请求 ${API_BASE} 超时：应用似乎卡住了`);
    }
    throw new ApiError(
      `连接不到 todo 应用（${API_BASE}）。请先在 todo-app 目录执行 \`node server.js\` 启动应用后重试。`
    );
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new ApiError((data && data.error) || `接口返回 ${res.status}`);
  }
  return data;
}

/* ---------------------- 业务逻辑 ---------------------- */

const FILTERS = new Set(['all', 'active', 'done']);

function shortId(id) {
  return String(id).slice(0, 8);
}

function stats(todos) {
  const done = todos.filter((t) => t.done).length;
  return { total: todos.length, active: todos.length - done, done };
}

function formatList(todos, filter) {
  const visible = todos.filter((t) =>
    filter === 'active' ? !t.done : filter === 'done' ? t.done : true
  );
  const s = stats(todos);

  const head = `共 ${s.total} 项待办（未完成 ${s.active} / 已完成 ${s.done}）`;
  if (visible.length === 0) {
    const hint =
      filter === 'done' ? '暂无已完成的待办。' : filter === 'active' ? '没有未完成项，全部搞定了 🎉' : '清单是空的。';
    return `${head}\n${hint}`;
  }

  const lines = visible.map((t, i) => {
    const flag = t.done ? '[x]' : '[ ]';
    return `${String(i + 1).padStart(2, ' ')}. ${flag} ${t.title}   (id: ${shortId(t.id)})`;
  });
  return [head, '', ...lines].join('\n');
}

/** 支持 8 位短 id 前缀匹配，避免模型复制完整 UUID */
async function resolveTodo(idInput) {
  if (!idInput || typeof idInput !== 'string') {
    throw new ApiError('缺少 id 参数。可用 todo_list 查看每条的 id。');
  }
  const key = idInput.trim().toLowerCase();
  const todos = await api('/api/todos');

  const exact = todos.find((t) => t.id.toLowerCase() === key);
  if (exact) return exact;

  const matches = todos.filter((t) => t.id.toLowerCase().startsWith(key));
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) throw new ApiError(`找不到 id 以 "${idInput}" 开头的待办。`);
  throw new ApiError(
    `id "${idInput}" 匹配到 ${matches.length} 条，请给出更长的前缀：\n` +
      matches.map((t) => `- ${shortId(t.id)}  ${t.title}`).join('\n')
  );
}

/* ---------------------- 工具定义与实现 ---------------------- */

const tools = [
  {
    name: 'todo_list',
    title: '查看待办清单',
    description:
      '列出当前所有待办事项，返回带编号、完成状态和短 id 的清单。执行修改类操作前建议先调用它拿到 id。',
    inputSchema: {
      type: 'object',
      properties: {
        filter: {
          type: 'string',
          enum: ['all', 'active', 'done'],
          description: '筛选：all 全部（默认）、active 未完成、done 已完成',
        },
      },
    },
    handler: async ({ filter = 'all' }) => {
      if (!FILTERS.has(filter)) throw new ApiError('filter 只能是 all / active / done');
      const todos = await api('/api/todos');
      return formatList(todos, filter);
    },
  },
  {
    name: 'todo_add',
    title: '新增待办',
    description: '新增一条待办事项，新增后界面会立即出现该条目。',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '待办内容，1~200 字符' },
      },
      required: ['title'],
    },
    handler: async ({ title }) => {
      if (typeof title !== 'string' || !title.trim()) throw new ApiError('title 不能为空');
      const todo = await api('/api/todos', {
        method: 'POST',
        body: JSON.stringify({ title }),
      });
      return `已新增：${todo.title}\nid: ${shortId(todo.id)}`;
    },
  },
  {
    name: 'todo_update',
    title: '修改待办',
    description:
      '修改待办的标题和/或完成状态。只传需要改的字段；done=true 表示标记完成，done=false 表示恢复未完成。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '待办 id 或前 8 位前缀（来自 todo_list）' },
        title: { type: 'string', description: '新标题，1~200 字符' },
        done: { type: 'boolean', description: '是否已完成' },
      },
      required: ['id'],
    },
    handler: async ({ id, title, done }) => {
      if (title === undefined && done === undefined) {
        throw new ApiError('至少提供 title 或 done 之一');
      }
      const target = await resolveTodo(id);
      const patch = {};
      if (title !== undefined) patch.title = title;
      if (done !== undefined) patch.done = Boolean(done);

      const todo = await api(`/api/todos/${target.id}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      });
      const changes = [];
      if (patch.title !== undefined) changes.push(`标题改为「${todo.title}」`);
      if (patch.done !== undefined) changes.push(todo.done ? '标记为已完成' : '恢复为未完成');
      return `已更新：${changes.join('，')}\nid: ${shortId(todo.id)}`;
    },
  },
  {
    name: 'todo_toggle',
    title: '切换完成状态',
    description: '把某条待办的完成状态取反（完成的变未完成，未完成的变完成）。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '待办 id 或前缀' },
      },
      required: ['id'],
    },
    handler: async ({ id }) => {
      const target = await resolveTodo(id);
      const todo = await api(`/api/todos/${target.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ done: !target.done }),
      });
      return `${todo.done ? '已完成' : '已恢复未完成'}：${todo.title}`;
    },
  },
  {
    name: 'todo_delete',
    title: '删除待办',
    description: '删除指定待办。删除前请确认 id 对应的是正确的那一条。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '待办 id 或前缀' },
      },
      required: ['id'],
    },
    handler: async ({ id }) => {
      const target = await resolveTodo(id);
      await api(`/api/todos/${target.id}`, { method: 'DELETE' });
      return `已删除：${target.title}\nid: ${shortId(target.id)}`;
    },
  },
  {
    name: 'todo_clear_completed',
    title: '清除已完成',
    description: '一次性删除所有已完成的待办，返回删除数量。',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      const result = await api('/api/todos?done=true', { method: 'DELETE' });
      return result.removed > 0 ? `已清除 ${result.removed} 项已完成待办` : '当前没有已完成的待办';
    },
  },
  {
    name: 'todo_stats',
    title: '统计概览',
    description: '返回待办总数、未完成数、已完成数和完成率。',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      const todos = await api('/api/todos');
      const s = stats(todos);
      const rate = s.total === 0 ? 0 : Math.round((s.done / s.total) * 100);
      return `总计 ${s.total} 项，未完成 ${s.active} 项，已完成 ${s.done} 项，完成率 ${rate}%`;
    },
  },
];

/* ---------------------- JSON-RPC 分发 ---------------------- */

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function replyError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

async function handleToolCall(id, params) {
  const name = params && params.name;
  const tool = tools.find((t) => t.name === name);
  if (!tool) return replyError(id, -32602, `未知工具：${name}`);

  try {
    const text = await tool.handler(params.arguments || {});
    reply(id, { content: [{ type: 'text', text }] });
  } catch (err) {
    // 业务错误回给模型（isError），让它自行纠错，而不是中断会话
    reply(id, {
      content: [{ type: 'text', text: err instanceof ApiError ? err.message : `执行失败：${err.message}` }],
      isError: true,
    });
  }
}

async function handle(msg) {
  const { id, method, params } = msg;
  const isRequest = id !== undefined && id !== null;

  switch (method) {
    case 'initialize': {
      const requested = params && params.protocolVersion;
      reply(id, {
        protocolVersion: SUPPORTED_PROTOCOLS.includes(requested) ? requested : SUPPORTED_PROTOCOLS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions:
          '这个服务器操作本地运行的 todo 待办应用（http://127.0.0.1:3000）。' +
          '任何写操作都会实时同步到浏览器界面。修改或删除前，先调用 todo_list 获取准确的 id。',
      });
      return;
    }
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return; // 通知无需响应

    case 'ping':
      return reply(id, {});

    case 'tools/list':
      return reply(id, {
        tools: tools.map(({ name, title, description, inputSchema }) => ({
          name,
          title,
          description,
          inputSchema,
        })),
      });

    case 'tools/call':
      return handleToolCall(id, params || {});

    case 'resources/list':
      return isRequest ? reply(id, { resources: [] }) : undefined;
    case 'resources/templates/list':
      return isRequest ? reply(id, { resourceTemplates: [] }) : undefined;
    case 'prompts/list':
      return isRequest ? reply(id, { prompts: [] }) : undefined;

    default:
      if (isRequest) replyError(id, -32601, `不支持的方法：${method}`);
  }
}

/* ---------------------- stdio 主循环 ---------------------- */

const rl = readline.createInterface({ input: process.stdin, terminal: false });

// 串行执行：多个请求同时到达时按顺序处理，避免「先清除再删除」这类竞态
let chain = Promise.resolve();
function enqueue(task) {
  chain = chain.then(task).catch((err) => {
    console.error('[todo-mcp]', err);
  });
  return chain;
}

rl.on('line', (line) => {
  const text = line.trim();
  if (!text) return;
  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    return replyError(null, -32700, 'JSON 解析失败');
  }
  if (Array.isArray(msg)) {
    msg.forEach((m) => enqueue(() => handle(m)));
    return;
  }
  enqueue(() => handle(msg));
});

rl.on('close', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
