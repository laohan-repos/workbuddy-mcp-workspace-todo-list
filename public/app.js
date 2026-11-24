/* ---------------- 状态 ---------------- */
const state = {
  todos: [],
  filter: 'all', // all | active | done
  busy: false,
};

const CIRCUMFERENCE = 2 * Math.PI * 18; // 进度环周长 ≈ 113.1
// 每个标签页一个 id：只忽略「自己」触发的推送，其他标签页的改动照常同步
const CLIENT_ID = Math.random().toString(36).slice(2, 10);

const $ = (id) => document.getElementById(id);
const els = {
  list: $('list'),
  empty: $('empty'),
  emptyText: $('emptyText'),
  input: $('input'),
  composer: $('composer'),
  addBtn: $('addBtn'),
  filters: $('filters'),
  countAll: $('countAll'),
  countActive: $('countActive'),
  countDone: $('countDone'),
  summary: $('summary'),
  clearDone: $('clearDone'),
  ring: $('ring'),
  percent: $('percent'),
  today: $('today'),
  toast: $('toast'),
  live: $('live'),
  liveText: $('liveText'),
};

/* ---------------- 工具 ---------------- */
const checkIcon = `<svg viewBox="0 0 24 24"><path d="M20 6L9 17l-5-5" fill="none" stroke="#fff" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const trashIcon = `<svg viewBox="0 0 24 24" width="16" height="16"><path d="M4 7h16M9 7V5a1 1 0 011-1h4a1 1 0 011 1v2m-9 0l1 13h10l1-13" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: {
      'Content-Type': 'application/json',
      'X-Client': 'ui',
      'X-Client-Id': CLIENT_ID,
    },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `请求失败 (${res.status})`);
  return data;
}

let toastTimer;
function toast(msg) {
  els.toast.textContent = msg;
  els.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove('show'), 1800);
}

/* ---------------- 渲染 ---------------- */
function visibleTodos() {
  if (state.filter === 'active') return state.todos.filter((t) => !t.done);
  if (state.filter === 'done') return state.todos.filter((t) => t.done);
  return state.todos;
}

function createItem(todo) {
  const li = document.createElement('li');
  li.className = 'item' + (todo.done ? ' done' : '');
  li.dataset.id = todo.id;

  // 勾选框
  const check = document.createElement('button');
  check.className = 'check';
  check.type = 'button';
  check.setAttribute('aria-label', todo.done ? '标记为未完成' : '标记为已完成');
  check.innerHTML = checkIcon;
  check.addEventListener('click', () => toggleTodo(todo));

  // 文本（双击可编辑）
  const text = document.createElement('div');
  text.className = 'text';
  text.textContent = todo.title;
  text.title = '双击编辑';
  text.addEventListener('dblclick', () => startEdit(li, text, todo));

  // 删除
  const del = document.createElement('button');
  del.className = 'del';
  del.type = 'button';
  del.setAttribute('aria-label', '删除');
  del.innerHTML = trashIcon;
  del.addEventListener('click', () => removeTodo(li, todo));

  li.append(check, text, del);
  return li;
}

function render() {
  const list = visibleTodos();
  els.list.replaceChildren(...list.map(createItem));

  const total = state.todos.length;
  const done = state.todos.filter((t) => t.done).length;
  const active = total - done;

  // 空态
  els.list.hidden = list.length === 0;
  els.empty.hidden = list.length > 0;
  els.emptyText.textContent =
    total === 0
      ? '还没有待办，添加第一条吧'
      : state.filter === 'done'
        ? '还没有已完成的待办'
        : '全部完成，休息一下 🍵';

  // 计数与进度
  els.countAll.textContent = total;
  els.countActive.textContent = active;
  els.countDone.textContent = done;

  const ratio = total === 0 ? 0 : done / total;
  els.ring.style.strokeDashoffset = CIRCUMFERENCE * (1 - ratio);
  els.ring.style.strokeLinecap = ratio === 0 ? 'butt' : 'round'; // 0% 时避免留下一个小圆点
  els.percent.textContent = `${Math.round(ratio * 100)}%`;

  els.summary.textContent =
    total === 0 ? '暂无任务' : `共 ${total} 项 · 未完成 ${active} 项`;

  els.clearDone.disabled = done === 0;
}

/* ---------------- 操作 ---------------- */
async function loadTodos() {
  try {
    state.todos = await api('/api/todos');
    render();
  } catch (err) {
    toast(err.message);
  }
}

async function addTodo(title) {
  try {
    const todo = await api('/api/todos', {
      method: 'POST',
      body: JSON.stringify({ title }),
    });
    state.todos.unshift(todo);
    if (state.filter === 'done') state.filter = 'all';
    syncFilterUI();
    render();
  } catch (err) {
    toast(err.message);
  }
}

async function toggleTodo(todo) {
  const next = !todo.done;
  todo.done = next; // 乐观更新
  render();
  try {
    await api(`/api/todos/${todo.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ done: next }),
    });
  } catch (err) {
    todo.done = !next; // 失败回滚
    render();
    toast(err.message);
  }
}

async function removeTodo(li, todo) {
  li.classList.add('leaving');
  try {
    await api(`/api/todos/${todo.id}`, { method: 'DELETE' });
    state.todos = state.todos.filter((t) => t.id !== todo.id);
    setTimeout(render, 160);
  } catch (err) {
    li.classList.remove('leaving');
    toast(err.message);
  }
}

async function clearCompleted() {
  try {
    const { removed, todos } = await api('/api/todos?done=true', { method: 'DELETE' });
    state.todos = todos;
    render();
    toast(`已清除 ${removed} 项已完成`);
  } catch (err) {
    toast(err.message);
  }
}

function startEdit(li, textEl, todo) {
  if (textEl.isContentEditable) return;
  const original = todo.title;
  textEl.contentEditable = 'true';
  textEl.focus();

  // 光标移到末尾
  const range = document.createRange();
  range.selectNodeContents(textEl);
  range.collapse(false);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);

  let finished = false;

  const finish = async (commit) => {
    if (finished) return;
    finished = true;
    textEl.contentEditable = 'false';
    const value = textEl.textContent.trim().replace(/\s+/g, ' ');

    if (!commit || !value || value === original) {
      textEl.textContent = original;
      return;
    }
    textEl.textContent = value;
    try {
      await api(`/api/todos/${todo.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ title: value }),
      });
      todo.title = value;
    } catch (err) {
      textEl.textContent = original;
      toast(err.message);
    }
  };

  textEl.addEventListener('blur', () => finish(true), { once: true });
  textEl.addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        textEl.blur();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        finish(false);
        textEl.blur();
      }
    },
    { once: false }
  );
}

/* ---------------- 实时同步：MCP / 其他窗口 → 当前页面 ---------------- */
const ACTION_LABEL = { add: '新增', update: '更新', delete: '删除', clear: '清除' };
let pendingEvent = null; // 编辑中被推迟的同步事件

function isEditing() {
  return !!document.querySelector('.text[contenteditable="true"]');
}

function setLive(on, text) {
  els.live.classList.toggle('on', on);
  els.liveText.textContent = text;
}

async function applyExternalChange(evt) {
  const targetId = evt.todo && evt.todo.id;
  await loadTodos();

  if (targetId) {
    const li = els.list.querySelector(`.item[data-id="${targetId}"]`);
    if (li) {
      li.classList.add('flash');
      setTimeout(() => li.classList.remove('flash'), 1300);
    }
  }

  const who = evt.source === 'mcp' ? 'MCP' : '其他窗口';
  const label = ACTION_LABEL[evt.action] || '变更';
  const detail =
    evt.action === 'clear'
      ? ` ${evt.removed || 0} 项已完成`
      : evt.todo
        ? `「${evt.todo.title}」`
        : '';
  toast(`🤖 ${who} ${label}${detail}`);
}

function initRealtime() {
  if (!('EventSource' in window)) {
    setLive(false, '浏览器不支持实时同步');
    return;
  }

  const es = new EventSource('/api/events');

  es.onopen = () => setLive(true, '实时同步中');
  es.onerror = () => setLive(false, '连接中断，重连中…');

  es.onmessage = (e) => {
    let evt;
    try {
      evt = JSON.parse(e.data);
    } catch {
      return;
    }
    if (evt.type !== 'todos:changed') return;
    if (evt.originId === CLIENT_ID) return; // 本页自己的操作已在本地更新，忽略回声

    if (isEditing()) {
      pendingEvent = evt; // 正在编辑：先不打断，编辑结束后补同步
      return;
    }
    applyExternalChange(evt);
  };
}

// 编辑结束（失焦）后补做被推迟的同步
document.addEventListener('focusout', () => {
  setTimeout(() => {
    if (pendingEvent && !isEditing()) {
      const evt = pendingEvent;
      pendingEvent = null;
      applyExternalChange(evt);
    }
  }, 150);
});

/* ---------------- 事件绑定 ---------------- */
function syncFilterUI() {
  els.filters.querySelectorAll('.filter').forEach((btn) => {
    const on = btn.dataset.filter === state.filter;
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-pressed', String(on));
  });
}

els.composer.addEventListener('submit', (e) => {
  e.preventDefault();
  const title = els.input.value.trim();
  if (!title) {
    els.input.focus();
    return;
  }
  els.input.value = '';
  els.addBtn.disabled = true;
  addTodo(title).finally(() => {
    els.addBtn.disabled = false;
    els.input.focus();
  });
});

els.filters.addEventListener('click', (e) => {
  const btn = e.target.closest('.filter');
  if (!btn) return;
  state.filter = btn.dataset.filter;
  syncFilterUI();
  render();
});

els.clearDone.addEventListener('click', clearCompleted);

// 按 "/" 快速聚焦输入框
document.addEventListener('keydown', (e) => {
  if (e.key === '/' && document.activeElement !== els.input && !document.activeElement.isContentEditable) {
    e.preventDefault();
    els.input.focus();
  }
});

/* ---------------- 初始化 ---------------- */
els.today.textContent = new Intl.DateTimeFormat('zh-CN', {
  month: 'long',
  day: 'numeric',
  weekday: 'long',
}).format(new Date());

syncFilterUI();
loadTodos();
initRealtime();
