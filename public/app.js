/* ============================================================
   app.js —— 一键宏配置工具前端逻辑
   职责：
     1. 加载 / 渲染配置（触发键、时序、操作序列）
     2. 操作步骤的增删改、拖拽排序
     3. 按键捕获（点击输入框后按任意键）
     4. 录制模式（WebSocket 接收全局事件 → 组装步骤）
     5. 运行控制（启动监听 / 停止 / 测试运行）
     6. 方案管理（新建 / 删除 / 导入 / 导出 / 保存）
     7. WebSocket 实时状态与日志
   ============================================================ */

'use strict';

// ---------- 工具 ----------

const $ = (id) => document.getElementById(id);

/** 通用 API 请求封装 */
async function api(method, url, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || data.errors?.join('；') || `HTTP ${res.status}`);
  return data;
}

/** 浏览器键盘事件 code → 配置键名（如 KeyW → W, Digit1 → 1, Numpad2 → Numpad2） */
function browserCodeToKeyName(code) {
  if (!code) return null;
  const m = code.match(/^Key([A-Z])$/); if (m) return m[1];
  const d = code.match(/^Digit([0-9])$/); if (d) return d[1];
  const n = code.match(/^Numpad([0-9])$/); if (n) return `Numpad${n[1]}`;
  const f = code.match(/^F([0-9]{1,2})$/); if (f && +f[1] >= 1 && +f[1] <= 24) return `F${f[1]}`;
  const map = {
    Space: 'Space', Enter: 'Enter', Tab: 'Tab', CapsLock: 'CapsLock',
    Escape: 'Escape', Backspace: 'Backspace',
    ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown', ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight',
    Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
    Insert: 'Insert', Delete: 'Delete',
    Semicolon: 'Semicolon', Comma: 'Comma', Period: 'Period', Slash: 'Slash',
    Backquote: 'Backquote', Minus: 'Minus', Equal: 'Equal',
    BracketLeft: 'BracketLeft', BracketRight: 'BracketRight',
    Backslash: 'Backslash', Quote: 'Quote',
    ControlLeft: 'Ctrl', ControlRight: 'Ctrl',
    ShiftLeft: 'Shift', ShiftRight: 'Shift',
    AltLeft: 'Alt', AltRight: 'Alt',
    MetaLeft: 'Meta', MetaRight: 'Meta',
    NumLock: 'NumLock', ScrollLock: 'ScrollLock', PrintScreen: 'PrintScreen',
    Pause: 'Pause', ContextMenu: 'Menu'
  };
  return map[code] || null;
}

/** 步骤摘要文本 */
function stepSummary(s) {
  const hold = (c) => {
    if (!c) return '';
    return c.mode === 'random' ? ` ${c.min}~${c.max}ms` : ` ${c.value}ms`;
  };
  switch (s.type) {
    case 'pressKey': {
      let t = s.hold ? `按住 ${s.key}` : `点按 ${s.key}`;
      const hc = s.holdDuration;
      if (hc && hc.mode) t += hold(hc);
      return t;
    }
    case 'releaseKey': return `松开 ${s.key}`;
    case 'mouseClick': return `鼠标${ {left:'左', right:'右', middle:'中'}[s.button] || s.button }键点击`;
    case 'mouseMove':
      return s.mode === 'relative'
        ? `鼠标相对移动 (${s.x > 0 ? '+' : ''}${s.x}, ${s.y > 0 ? '+' : ''}${s.y})`
        : `鼠标移动到 (${s.x}, ${s.y})`;
    case 'fixedDelay': return `固定延迟 ${s.ms}ms`;
    case 'randomDelay': return `随机延迟 ${s.min}~${s.max}ms`;
    default: return '未知步骤';
  }
}

/** 步骤间隔标签 */
function intervalTag(s) {
  const iv = s.interval || { mode: 'fixed', value: 0 };
  if (iv.mode === 'random') return `间隔 ${iv.min}~${iv.max}ms`;
  return `间隔 ${iv.value}ms`;
}

/** 步骤类型 → 徽章类别 */
function badgeClass(type) {
  if (type === 'fixedDelay' || type === 'randomDelay') return 't-delay';
  if (type === 'mouseClick') return 't-mouse';
  if (type === 'mouseMove') return 't-move';
  return '';
}
function badgeText(type) {
  return { pressKey: '按键', releaseKey: '松开', mouseClick: '鼠标', mouseMove: '移动', fixedDelay: '延迟', randomDelay: '随机' }[type] || type;
}

/** 时间戳 */
function nowTime() { return new Date().toLocaleTimeString('zh-CN', { hour12: false }); }

// ---------- 全局状态 ----------

const state = {
  config: null,          // 当前配置
  dirty: false,          // 是否有未保存修改
  capturing: null,       // 当前处于捕获状态的输入框 id
  ws: null,
  recording: false,      // 录制模式状态
  runningSchemes: new Set(), // 正在监听运行的方案名集合（多宏同时运行）
  nameModal: null,      // 方案名称表单状态：{ mode: 'rename'|'copy', from, oldName }
  recordedSteps: [],     // 本次录制的步骤缓冲
  pendingKeys: new Set() // 录制中已按下未松开的键
};

const KEY_OPTIONS = [];   // 全部键盘键（步骤用）
const HOTKEY_OPTIONS = []; // 触发/退出用（含鼠标侧键）

// ---------- 日志 ----------

function addLog(level, msg) {
  const list = $('logList');
  const empty = list.querySelector('.log-empty');
  if (empty) empty.remove();
  const line = document.createElement('div');
  line.className = 'log-line';
  const t = document.createElement('span');
  t.className = 't';
  t.textContent = nowTime();
  const m = document.createElement('span');
  m.className = `lv-${level}`;
  m.textContent = `[${level.toUpperCase()}] ${msg}`;
  line.append(t, m);
  list.appendChild(line);
  list.scrollTop = list.scrollHeight;
}

function clearLog() {
  const list = $('logList');
  list.innerHTML = '<div class="log-empty">暂无日志</div>';
}

// ---------- 渲染 ----------

function renderTrigger() {
  $('triggerKeyInput').value = state.config.trigger.key || '';
  $('triggerMode').value = state.config.trigger.mode || 'once';
  $('holdLoopInterval').value = state.config.trigger.holdLoopInterval ?? 300;
  // 鼠标侧键联动
  const tk = state.config.trigger.key;
  $('triggerMouseSelect').value = (tk === 'Mouse4' || tk === 'Mouse5') ? tk : '';
  $('exitKeyInput').value = state.config.exitKey || '';
  const ek = state.config.exitKey;
  $('exitMouseSelect').value = (ek === 'Mouse4' || ek === 'Mouse5') ? ek : '';
  $('loopIntervalField').style.display = state.config.trigger.mode === 'holdLoop' ? '' : 'none';
}

function renderTiming() {
  const t = state.config.timing || {};
  $('globalSpeed').value = t.globalSpeed ?? 1;
  $('globalSpeedOut').textContent = `${(Number(t.globalSpeed) || 1).toFixed(2)}×`;
  $('stepJitter').value = t.stepJitter ?? 0;
  const hd = t.holdDuration;
  if (hd && hd.mode === 'fixed') {
    $('holdMode').value = 'fixed';
    $('holdFixed').value = hd.value;
  } else if (hd && hd.mode === 'random') {
    $('holdMode').value = 'random';
    $('holdMin').value = hd.min;
    $('holdMax').value = hd.max;
  } else {
    $('holdMode').value = 'null';
  }
  updateHoldBoxes();
  $('disableNutAutoDelay').checked = t.disableNutAutoDelay !== false;
}

function updateHoldBoxes() {
  const mode = $('holdMode').value;
  $('holdFixedBox').style.display = mode === 'fixed' ? 'flex' : 'none';
  $('holdRandomBox').style.display = mode === 'random' ? 'flex' : 'none';
}

function renderSteps() {
  const list = $('stepList');
  list.innerHTML = '';
  const steps = state.config.steps || [];

  if (steps.length === 0) {
    list.innerHTML = '<div class="empty-state">暂无操作步骤。<br>点击「添加步骤」或「录制」开始构建流水线。</div>';
  } else {
    steps.forEach((s, i) => {
      const card = document.createElement('div');
      card.className = 'step-card';
      card.draggable = true;
      card.dataset.index = i;

      const idx = document.createElement('span');
      idx.className = 'step-index';
      idx.textContent = i + 1;

      const badge = document.createElement('span');
      badge.className = `step-badge ${badgeClass(s.type)}`;
      badge.textContent = badgeText(s.type);

      const summary = document.createElement('span');
      summary.className = 'step-summary';
      summary.textContent = stepSummary(s);
      const itag = document.createElement('span');
      itag.className = 'interval-tag';
      itag.textContent = intervalTag(s);
      summary.appendChild(itag);

      const actions = document.createElement('div');
      actions.className = 'step-actions';
      const btnEdit = document.createElement('button');
      btnEdit.textContent = '✎';
      btnEdit.title = '编辑';
      btnEdit.onclick = () => openStepEditor(i);
      const btnDel = document.createElement('button');
      btnDel.textContent = '✕';
      btnDel.title = '删除';
      btnDel.className = 'del';
      btnDel.onclick = () => {
        state.config.steps.splice(i, 1);
        renderSteps(); markDirty();
      };
      actions.append(btnEdit, btnDel);

      card.append(idx, badge, summary, actions);
      // 双击也可编辑
      card.addEventListener('dblclick', () => openStepEditor(i));
      attachDrag(card, i);
      list.appendChild(card);
    });
  }
  renderConflict();
}

/** 热键冲突检测（前端即时提示） */
function renderConflict() {
  const used = new Set();
  for (const s of state.config.steps || []) {
    if (s.type === 'pressKey' || s.type === 'releaseKey') used.add(s.key);
  }
  const conflicts = [];
  const tk = state.config.trigger?.key, ek = state.config.exitKey;
  if (tk && used.has(tk)) conflicts.push(`触发键 ${tk}`);
  if (ek && used.has(ek)) conflicts.push(`退出键 ${ek}`);
  const chip = $('conflictChip');
  if (conflicts.length) {
    chip.hidden = false;
    chip.textContent = `⚠ 热键冲突：${conflicts.join('、')} 与操作序列按键重复`;
  } else {
    chip.hidden = true;
  }
}

function renderAll() {
  renderTrigger();
  renderTiming();
  renderSteps();
  renderSchemeSelect();
  renderSaveState();
}

// ---------- 方案管理 ----------

let _schemesCache = [];   // 方案列表缓存（供 renderSchemeList 无参重渲染）
let _currentCache = 'default';

async function renderSchemeSelect() {
  const data = await api('GET', '/api/schemes');
  _schemesCache = data.schemes || [];
  _currentCache = data.current;
  const sel = $('schemeSelect');
  sel.innerHTML = '';
  for (const s of data.schemes) {
    const opt = document.createElement('option');
    opt.value = s.name;
    opt.textContent = s.name;
    if (s.name === data.current) opt.selected = true;
    sel.appendChild(opt);
  }
  renderSchemeList();
}

/** 渲染方案列表面板：每个方案一张卡片，可切换 / 运行(停止) / 复制 / 删除 */
function renderSchemeList() {
  const schemes = _schemesCache;
  const current = _currentCache;
  const list = $('schemeList');
  list.innerHTML = '';
  if (!schemes || schemes.length === 0) {
    list.innerHTML = '<div class="empty-state">暂无方案，点击「＋ 新建」创建。</div>';
    return;
  }
  for (const s of schemes) {
    const running = state.runningSchemes.has(s.name);
    const item = document.createElement('div');
    item.className = `scheme-item${s.name === current ? ' current' : ''}${running ? ' running' : ''}`;
    item.title = running ? `方案「${s.name}」正在监听（触发键生效中）` : `切换到方案「${s.name}」`;

    const top = document.createElement('div');
    top.className = 'si-top';
    const dot = document.createElement('span');
    dot.className = running ? 'si-dot running' : 'si-dot';
    const name = document.createElement('span');
    name.className = 'si-name';
    name.textContent = s.schemeName;
    const btnRename = document.createElement('button');
    btnRename.className = 'si-rename';
    btnRename.textContent = '✎';
    btnRename.title = `重命名方案「${s.schemeName}」`;
    btnRename.onclick = (e) => { e.stopPropagation(); renameScheme(s.name); };
    top.append(dot, name, btnRename);
    // 上移 / 下移按钮（default 固定置顶，不显示）
    if (s.name !== 'default') {
      const btnUp = document.createElement('button');
      btnUp.className = 'si-move';
      btnUp.textContent = '↑';
      btnUp.title = '上移';
      btnUp.onclick = (e) => { e.stopPropagation(); moveScheme(s.name, -1); };
      const btnDown = document.createElement('button');
      btnDown.className = 'si-move';
      btnDown.textContent = '↓';
      btnDown.title = '下移';
      btnDown.onclick = (e) => { e.stopPropagation(); moveScheme(s.name, 1); };
      top.append(btnUp, btnDown);
    }

    const meta = document.createElement('div');
    meta.className = 'si-meta';
    meta.textContent = `触发 ${s.triggerKey || '未设置'} · ${s.steps} 步${running ? ' · 运行中' : (s.name === current ? ' · 当前' : '')}`;

    const actions = document.createElement('div');
    actions.className = 'si-actions';
    const btnRun = document.createElement('button');
    btnRun.className = running ? 'run stop' : 'run';
    btnRun.textContent = running ? '⏹ 停止' : '▶ 运行';
    btnRun.title = running ? `停止方案「${s.name}」的监听` : `运行方案「${s.name}」（加入多宏监听）`;
    btnRun.onclick = (e) => { e.stopPropagation(); running ? stopScheme(s.name) : runScheme(s.name); };
    const btnCopy = document.createElement('button');
    btnCopy.className = 'copy';
    btnCopy.textContent = '⧉ 复制';
    btnCopy.title = `基于「${s.name}」复制一套新的`;
    btnCopy.onclick = (e) => { e.stopPropagation(); copyScheme(s.name); };
    actions.append(btnRun, btnCopy);
    if (s.name !== 'default') {
      const btnDel = document.createElement('button');
      btnDel.className = 'del';
      btnDel.textContent = '✕';
      btnDel.title = `删除方案「${s.name}」`;
      btnDel.onclick = (e) => { e.stopPropagation(); deleteScheme(s.name); };
      actions.appendChild(btnDel);
    }

    item.append(top, meta, actions);
    // 点击卡片 = 切换方案（运行中的方案仍可切换编辑焦点，不影响其监听）
    item.addEventListener('click', () => {
      if (s.name !== current) switchScheme(s.name);
    });
    list.appendChild(item);
  }
}

/** 上移/下移方案：与相邻方案交换位置并持久化（default 固定置顶不可移动） */
async function moveScheme(name, dir) {
  const list = [..._schemesCache];
  const idx = list.indexOf(name);
  if (idx < 0) return;
  const j = idx + dir;
  if (j < 1 || j >= list.length) return; // 不能越过 default（索引 0），也不能超出末尾
  [list[idx], list[j]] = [list[j], list[idx]];
  try {
    await api('POST', '/api/schemes/order', { order: list });
    await renderSchemeSelect();
    addLog('success', `方案顺序已更新：${list.join(' → ')}`);
  } catch (err) {
    addLog('error', `保存方案顺序失败：${err.message}`);
  }
}

/** 切换方案（保留未保存修改的确认） */
async function switchScheme(name) {
  if (state.dirty && !confirm('当前配置有未保存修改，切换方案将丢失这些修改。继续？')) return;
  try { await loadScheme(name); } catch (err) { addLog('error', err.message); }
}

/** 复制方案：打开表单模态框输入新方案名（不使用浏览器 prompt） */
function copyScheme(fromName) {
  const from = fromName || state.config?.schemeName;
  openNameModal('copy', from, `${from} - 副本`);
}

/** 打开方案名称表单模态框（新建 / 重命名 / 复制共用，不使用浏览器 prompt） */
function openNameModal(mode, from, currentName) {
  state.nameModal = { mode, from, oldName: currentName };
  $('nameModalTitle').textContent = mode === 'copy' ? '复制方案' : (mode === 'create' ? '新建方案' : '重命名方案');
  $('nameModalHint').textContent = mode === 'copy'
    ? '将基于所选方案复制一套新的；名称作为配置文件保存，不能与现有方案重名。'
    : '名称将作为配置文件保存；不能与现有方案重名，内置 default 不可重命名。';
  $('renameInput').value = currentName || '';
  $('renameError').hidden = true;
  $('renameModal').hidden = false;
  setTimeout(() => $('renameInput').focus(), 50);
}

/** 重命名方案：打开表单模态框 */
function renameScheme(name) {
  if (name === 'default') {
    addLog('warn', '内置 default 方案不允许重命名');
    return;
  }
  openNameModal('rename', name, name);
}

/** 提交名称表单（新建 / 复制 / 重命名按模式分发） */
async function confirmNameModal() {
  const m = state.nameModal;
  if (!m) return;
  const newName = $('renameInput').value.trim();
  if (!newName) {
    showRenameError('方案名不能为空');
    return;
  }
  if (m.mode === 'create') {
    try {
      const data = await api('POST', '/api/schemes', { name: newName });
      state.config = data.config;
      state.dirty = false;
      closeRenameModal();
      renderAll();
      await renderSchemeSelect();
      addLog('info', `已创建并切换到新方案「${newName}」`);
    } catch (err) {
      showRenameError(err.message || '新建失败');
    }
    return;
  }
  if (m.mode === 'copy') {
    try {
      const data = await api('POST', '/api/schemes/copy', { from: m.from, name: newName });
      addLog('success', `已复制新方案「${data.scheme}」`);
      closeRenameModal();
      await renderSchemeSelect();
    } catch (err) {
      showRenameError(err.message || '复制失败');
    }
    return;
  }
  // rename
  if (newName === m.oldName) { closeRenameModal(); return; }
  try {
    const data = await api('POST', `/api/schemes/${encodeURIComponent(m.oldName)}/rename`, { name: newName });
    addLog('success', `方案已重命名：「${m.oldName}」→「${data.scheme}」`);
    closeRenameModal();
    await renderSchemeSelect();
    if (state.config?.schemeName === data.scheme) {
      await loadScheme(data.scheme);
    }
  } catch (err) {
    showRenameError(err.message || '重命名失败');
  }
}

/** 在表单内显示错误 */
function showRenameError(msg) {
  const el = $('renameError');
  el.textContent = msg;
  el.hidden = false;
}

/** 关闭名称表单模态框 */
function closeRenameModal() {
  $('renameModal').hidden = true;
  state.nameModal = null;
}

/** 运行指定方案：加入多宏监听集合（不改变当前编辑焦点） */
async function runScheme(name) {
  try {
    const data = await api('POST', `/api/schemes/${encodeURIComponent(name)}/run`);
    state.runningSchemes.add(name);
    renderSchemeList();
    updateRunningUI();
    const cfg = await api('GET', `/api/config?scheme=${encodeURIComponent(name)}`);
    addLog('success', `已运行方案「${name}」：触发键 ${cfg.config.trigger.key}，退出键 ${cfg.config.exitKey}（${state.runningSchemes.size} 个宏监听中）`);
  } catch (err) {
    addLog('error', `运行方案失败：${err.message}`);
  }
}

/** 停止指定方案的监听（不影响其他方案） */
async function stopScheme(name) {
  try {
    await api('POST', `/api/schemes/${encodeURIComponent(name)}/stop`);
    state.runningSchemes.delete(name);
    renderSchemeList();
    updateRunningUI();
    addLog('info', `已停止方案「${name}」的监听`);
  } catch (err) {
    addLog('error', `停止方案失败：${err.message}`);
  }
}

/** 删除方案（default 不可删） */
async function deleteScheme(name) {
  if (name === 'default') {
    addLog('warn', '内置 default 方案不允许删除');
    return;
  }
  if (!confirm(`确定删除方案「${name}」？此操作不可恢复。`)) return;
  try {
    await api('DELETE', `/api/schemes/${encodeURIComponent(name)}`);
    addLog('info', `已删除方案「${name}」`);
    await renderSchemeSelect();
    if (name === state.config.schemeName) {
      await loadScheme('default');
    }
  } catch (err) { addLog('error', `删除失败：${err.message}`); }
}

function renderSaveState() {
  $('saveState').textContent = state.dirty ? '● 有未保存修改' : '';
  $('saveState').style.color = state.dirty ? 'var(--yellow)' : 'transparent';
}

function markDirty() {
  state.dirty = true;
  renderSaveState();
}

/** 保存当前配置到后端 */
async function saveConfig() {
  try {
    await api('POST', '/api/config', state.config);
    state.dirty = false;
    renderSaveState();
    await renderSchemeSelect();
    addLog('success', `配置已保存（方案：${state.config.schemeName}）`);
  } catch (err) {
    addLog('error', `保存失败：${err.message}`);
  }
}

/** 加载指定方案到内存并渲染 */
async function loadScheme(name) {
  const data = await api('GET', `/api/config?scheme=${encodeURIComponent(name)}`);
  state.config = data.config;
  state.dirty = false;
  renderAll();
  addLog('info', `已切换到方案「${data.scheme}」`);
}

// ---------- 步骤编辑（模态框） ----------

let editingIndex = null; // null=新增, 数字=编辑

/** 打开步骤编辑器 */
function openStepEditor(index) {
  editingIndex = index;
  const isNew = index === null;
  const step = isNew
    ? { type: 'pressKey', key: 'W', hold: true, holdDuration: null, interval: { mode: 'fixed', value: 0 } }
    : { ...(state.config.steps[index] || {}), interval: { ...(state.config.steps[index]?.interval || { mode: 'fixed', value: 0 }) } };

  $('stepModalTitle').textContent = isNew ? '添加步骤' : `编辑步骤 ${index + 1}`;
  $('stepType').value = step.type;
  updateStepTypeFields(step.type);

  // 按键
  fillKeySelect(step.key);
  $('stepKeyCapture').value = step.key || '';

  // pressKey 专属
  $('stepHold').checked = step.hold !== false;
  const hd = step.holdDuration;
  if (hd && hd.mode === 'fixed') {
    $('stepHoldDurationMode').value = 'fixed';
    $('stepHoldFixed').value = hd.value;
  } else if (hd && hd.mode === 'random') {
    $('stepHoldDurationMode').value = 'random';
    $('stepHoldMin').value = hd.min;
    $('stepHoldMax').value = hd.max;
  } else {
    $('stepHoldDurationMode').value = 'null';
  }
  updateStepHoldDurationBoxes();

  // mouseClick
  $('stepMouseButton').value = step.button || 'right';

  // mouseMove
  $('stepMoveMode').value = step.mode || 'absolute';
  $('stepMoveX').value = step.x ?? 0;
  $('stepMoveY').value = step.y ?? 0;

  // 延迟
  $('stepDelayMs').value = step.ms ?? 100;
  $('stepDelayMin').value = step.min ?? 50;
  $('stepDelayMax').value = step.max ?? 150;

  // 间隔
  const iv = step.interval || { mode: 'fixed', value: 0 };
  $('stepIntervalMode').value = iv.mode || 'fixed';
  $('stepIntervalFixed').value = iv.value ?? 0;
  $('stepIntervalMin').value = iv.min ?? 50;
  $('stepIntervalMax').value = iv.max ?? 150;
  updateIntervalBoxes();

  $('stepModal').hidden = false;
}

function closeStepEditor() {
  $('stepModal').hidden = true;
  stopCapture();
  editingIndex = null;
}

/** 根据类型显示/隐藏字段 */
function updateStepTypeFields(type) {
  document.querySelectorAll('.type-group').forEach((el) => {
    const types = el.dataset.types.split(',');
    el.style.display = types.includes(type) ? '' : 'none';
  });
}

function updateStepHoldDurationBoxes() {
  const mode = $('stepHoldDurationMode').value;
  $('stepHoldFixed').hidden = mode !== 'fixed';
  $('stepHoldRangeSep').hidden = mode !== 'random';
  $('stepHoldMin').hidden = mode !== 'random';
  $('stepHoldMax').hidden = mode !== 'random';
}

function updateIntervalBoxes() {
  const mode = $('stepIntervalMode').value;
  $('stepIntervalFixed').style.display = mode === 'fixed' ? '' : 'none';
  $('stepIntervalSep').style.display = mode === 'random' ? '' : 'none';
  $('stepIntervalMin').style.display = mode === 'random' ? '' : 'none';
  $('stepIntervalMax').style.display = mode === 'random' ? '' : 'none';
}

function fillKeySelect(current) {
  const sel = $('stepKeySelect');
  sel.innerHTML = '';
  const groups = [
    ['字母键', KEY_OPTIONS.filter((k) => /^[A-Z]$/.test(k))],
    ['数字键', KEY_OPTIONS.filter((k) => /^[0-9]$/.test(k))],
    ['功能键', KEY_OPTIONS.filter((k) => /^F\d+$/.test(k))],
    ['小键盘', KEY_OPTIONS.filter((k) => /^Numpad/.test(k))],
    ['控制键', KEY_OPTIONS.filter((k) => ['Space','Enter','Tab','CapsLock','Escape','Backspace','Ctrl','Alt','Shift','Meta','NumLock','ScrollLock','PrintScreen','Pause','Menu'].includes(k))],
    ['方向/编辑', KEY_OPTIONS.filter((k) => ['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Home','End','PageUp','PageDown','Insert','Delete'].includes(k))],
    ['符号键', KEY_OPTIONS.filter((k) => ['Semicolon','Comma','Period','Slash','Backquote','Minus','Equal','BracketLeft','BracketRight','Backslash','Quote'].includes(k))]
  ];
  for (const [label, keys] of groups) {
    if (!keys.length) continue;
    const og = document.createElement('optgroup');
    og.label = label;
    for (const k of keys) {
      const opt = document.createElement('option');
      opt.value = k; opt.textContent = k;
      og.appendChild(opt);
    }
    sel.appendChild(og);
  }
  if (current && KEY_OPTIONS.includes(current)) sel.value = current;
}

/** 从模态框读取当前编辑的步骤对象 */
function readStepFromModal() {
  const type = $('stepType').value;
  const step = { type };

  // 操作间隔（通用）
  const ivMode = $('stepIntervalMode').value;
  step.interval = ivMode === 'random'
    ? { mode: 'random', min: +$('stepIntervalMin').value || 0, max: +$('stepIntervalMax').value || 0 }
    : { mode: 'fixed', value: +$('stepIntervalFixed').value || 0 };

  switch (type) {
    case 'pressKey': {
      const key = $('stepKeyCapture').value || $('stepKeySelect').value;
      if (!key) throw new Error('请选择按键');
      step.key = key;
      step.hold = $('stepHold').checked;
      const hm = $('stepHoldDurationMode').value;
      step.holdDuration = hm === 'fixed'
        ? { mode: 'fixed', value: +$('stepHoldFixed').value || 0 }
        : hm === 'random'
          ? { mode: 'random', min: +$('stepHoldMin').value || 0, max: +$('stepHoldMax').value || 0 }
          : null;
      break;
    }
    case 'releaseKey': {
      const key = $('stepKeyCapture').value || $('stepKeySelect').value;
      if (!key) throw new Error('请选择按键');
      step.key = key;
      break;
    }
    case 'mouseClick':
      step.button = $('stepMouseButton').value;
      break;
    case 'mouseMove':
      step.mode = $('stepMoveMode').value;
      step.x = +$('stepMoveX').value || 0;
      step.y = +$('stepMoveY').value || 0;
      break;
    case 'fixedDelay':
      step.ms = +$('stepDelayMs').value || 0;
      break;
    case 'randomDelay':
      step.min = +$('stepDelayMin').value || 0;
      step.max = +$('stepDelayMax').value || 0;
      if (step.max < step.min) throw new Error('随机延迟区间无效（需 min ≤ max）');
      break;
  }
  return step;
}

function saveStepFromModal() {
  try {
    const step = readStepFromModal();
    if (editingIndex === null) {
      (state.config.steps = state.config.steps || []).push(step);
      addLog('info', `已添加步骤：${stepSummary(step)}`);
    } else {
      state.config.steps[editingIndex] = step;
      addLog('info', `已更新步骤 ${editingIndex + 1}：${stepSummary(step)}`);
    }
    renderSteps();
    markDirty();
    closeStepEditor();
  } catch (err) {
    addLog('error', err.message);
  }
}

// ---------- 拖拽排序 ----------

function attachDrag(card, index) {
  card.addEventListener('dragstart', (e) => {
    state.dragFrom = index;
    card.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
  });
  card.addEventListener('dragend', () => {
    card.classList.remove('dragging');
    document.querySelectorAll('.step-card.drag-over').forEach((c) => c.classList.remove('drag-over'));
  });
  card.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const rect = card.getBoundingClientRect();
    state.dragTo = (e.clientY < rect.top + rect.height / 2) ? index : index + 1;
    document.querySelectorAll('.step-card.drag-over').forEach((c) => c.classList.remove('drag-over'));
    card.classList.add('drag-over');
  });
  card.addEventListener('drop', (e) => {
    e.preventDefault();
    const from = state.dragFrom, to = state.dragTo;
    if (from === undefined || to === undefined || from === to || from === to - 1) return;
    const steps = state.config.steps;
    const [moved] = steps.splice(from, 1);
    steps.splice(to > from ? to - 1 : to, 0, moved);
    renderSteps();
    markDirty();
  });
}

// ---------- 按键捕获 ----------

function startCapture(inputId, onChange) {
  stopCapture();
  state.capturing = { inputId, onChange };
  const input = $(inputId);
  input.classList.add('capturing');
  input.value = '请按键…';
  addLog('info', '捕获模式开启：请按下目标按键');
}

function stopCapture() {
  if (!state.capturing) return;
  const { inputId } = state.capturing;
  const input = $(inputId);
  input.classList.remove('capturing');
  state.capturing = null;
  if (inputId === 'triggerKeyInput') input.value = state.config.trigger.key || '';
  else if (inputId === 'exitKeyInput') input.value = state.config.exitKey || '';
  else if (inputId === 'stepKeyCapture') {
    // 保留模态框中的当前值
    const val = $('stepKeySelect').value || '';
    input.value = val;
  }
}

document.addEventListener('keydown', (e) => {
  if (!state.capturing) return;
  e.preventDefault();
  e.stopPropagation();
  const name = browserCodeToKeyName(e.code);
  if (!name) return;
  const { inputId, onChange } = state.capturing;
  $(inputId).value = name;
  $(inputId).classList.remove('capturing');
  // 捕获键盘键时清掉鼠标侧键选择
  if (inputId === 'triggerKeyInput') $('triggerMouseSelect').value = '';
  if (inputId === 'exitKeyInput') $('exitMouseSelect').value = '';
  onChange?.(name);
  state.capturing = null;
});

// ---------- 录制模式 ----------

function toggleRecording() {
  if (!state.recording) {
    state.recordedSteps = [];
    state.pendingKeys.clear();
    api('POST', '/api/record', { action: 'start' })
      .then(() => {
        state.recording = true;
        $('btnRecord').classList.add('recording');
        $('btnRecord').textContent = '⏺ 停止录制';
        $('statusDot').className = 'status-dot recording';
        $('statusText').textContent = '录制中…';
        addLog('info', '录制已开始：手动执行一次操作，结束后点击「停止录制」');
      })
      .catch((err) => addLog('error', `录制开启失败：${err.message}`));
  } else {
    api('POST', '/api/record', { action: 'stop' })
      .then(() => {
        state.recording = false;
        $('btnRecord').classList.remove('recording');
        $('btnRecord').textContent = '🎙 录制';
        // 录制结果替换当前序列
        if (state.recordedSteps.length) {
          state.config.steps = state.recordedSteps;
          renderSteps();
          markDirty();
          addLog('success', `录制完成：已生成 ${state.recordedSteps.length} 个步骤并替换当前操作序列`);
        } else {
          addLog('warn', '录制结束，但未捕获到任何步骤');
        }
        state.recordedSteps = [];
        state.pendingKeys.clear();
      })
      .catch((err) => addLog('error', `录制关闭失败：${err.message}`));
  }
}

/** 处理录制事件（来自 WebSocket） */
function onRecordEvent(evt) {
  const cfg = state.config;
  const skipKeys = new Set([cfg.trigger?.key, cfg.exitKey]);
  if (evt.kind === 'keydown') {
    if (skipKeys.has(evt.key) || state.pendingKeys.has(evt.key)) return;
    state.pendingKeys.add(evt.key);
    state.recordedSteps.push({ type: 'pressKey', key: evt.key, hold: true, holdDuration: null, interval: { mode: 'fixed', value: 0 } });
  } else if (evt.kind === 'keyup') {
    if (!state.pendingKeys.has(evt.key)) return;
    state.pendingKeys.delete(evt.key);
    state.recordedSteps.push({ type: 'releaseKey', key: evt.key, interval: { mode: 'fixed', value: 0 } });
  } else if (evt.kind === 'mousedown') {
    state.recordedSteps.push({ type: 'mouseClick', button: evt.button, interval: { mode: 'fixed', value: 0 } });
  }
}

// ---------- 运行控制（多宏同时运行） ----------

function updateRunningUI() {
  const n = state.runningSchemes.size;
  $('btnStart').disabled = n > 0;
  $('btnStop').disabled = n === 0;
  $('statusDot').className = n > 0 ? 'status-dot running' : 'status-dot';
  $('statusText').textContent = n > 0 ? `运行中（${n} 个方案）` : '已停止';
  renderSchemeList();
}

function startListening() {
  api('POST', '/api/start')
    .then(async () => {
      state.runningSchemes.add(state.config.schemeName);
      updateRunningUI();
      addLog('success', `已运行当前方案「${state.config.schemeName}」：触发键 ${state.config.trigger.key}${state.config.trigger.mode === 'holdLoop' ? '（按住循环）' : ''}，退出键 ${state.config.exitKey}`);
    })
    .catch((err) => addLog('error', `启动失败：${err.message}`));
}

function stopListening() {
  api('POST', '/api/stop')
    .then(() => {
      state.runningSchemes.clear();
      updateRunningUI();
      $('currentStepText').textContent = '当前步骤：-';
      addLog('info', '已停止全部方案监听');
    })
    .catch((err) => addLog('error', `停止失败：${err.message}`));
}

function testRun() {
  api('POST', '/api/test')
    .then(() => addLog('info', '测试运行已提交（执行详情见下方日志）'))
    .catch((err) => addLog('error', `测试运行失败：${err.message}`));
}

// ---------- WebSocket ----------

function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  state.ws = new WebSocket(`${proto}://${location.host}/ws`);
  state.ws.onmessage = (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }
    if (msg.type === 'status') {
      // 服务端为权威来源：running 为正在监听的方案名数组
      state.runningSchemes = new Set(Array.isArray(msg.running) ? msg.running : []);
      state.recording = !!msg.recording;
      updateRunningUI();
      if (msg.currentStep) {
        $('currentStepText').textContent = `当前步骤：${msg.currentStep.scheme ? `[${msg.currentStep.scheme}] ` : ''}${msg.currentStep.index}/${msg.currentStep.total} ${msg.currentStep.desc}`;
      } else if (msg.currentStep === null) {
        $('currentStepText').textContent = '当前步骤：-';
      }
    } else if (msg.type === 'log') {
      addLog(msg.level, msg.msg);
    } else if (msg.type === 'recordEvent') {
      onRecordEvent(msg.evt);
    }
  };
  state.ws.onclose = () => {
    // 断线重连（服务端重启场景）
    setTimeout(connectWS, 2000);
  };
}

// ---------- 事件绑定 ----------

function bindEvents() {
  // 触发与退出
  $('triggerKeyInput').addEventListener('click', () => startCapture('triggerKeyInput', (name) => {
    state.config.trigger.key = name;
    markDirty(); renderConflict();
  }));
  $('exitKeyInput').addEventListener('click', () => startCapture('exitKeyInput', (name) => {
    state.config.exitKey = name;
    markDirty(); renderConflict();
  }));
  $('btnClearTrigger').addEventListener('click', () => {
    state.config.trigger.key = '';
    $('triggerKeyInput').value = '';
    $('triggerMouseSelect').value = '';
    markDirty();
  });
  $('btnClearExit').addEventListener('click', () => {
    state.config.exitKey = '';
    $('exitKeyInput').value = '';
    $('exitMouseSelect').value = '';
    markDirty();
  });
  $('triggerMouseSelect').addEventListener('change', (e) => {
    state.config.trigger.key = e.target.value || '';
    $('triggerKeyInput').value = e.target.value || '';
    markDirty(); renderConflict();
  });
  $('exitMouseSelect').addEventListener('change', (e) => {
    state.config.exitKey = e.target.value || '';
    $('exitKeyInput').value = e.target.value || '';
    markDirty(); renderConflict();
  });
  $('triggerMode').addEventListener('change', (e) => {
    state.config.trigger.mode = e.target.value;
    $('loopIntervalField').style.display = e.target.value === 'holdLoop' ? '' : 'none';
    markDirty();
  });
  $('holdLoopInterval').addEventListener('change', (e) => {
    state.config.trigger.holdLoopInterval = +e.target.value || 0;
    markDirty();
  });

  // 时序
  $('globalSpeed').addEventListener('input', (e) => {
    $('globalSpeedOut').textContent = `${(+e.target.value).toFixed(2)}×`;
    state.config.timing.globalSpeed = +e.target.value;
    markDirty();
  });
  $('stepJitter').addEventListener('change', (e) => {
    state.config.timing.stepJitter = +e.target.value || 0;
    markDirty();
  });
  $('holdMode').addEventListener('change', (e) => {
    updateHoldBoxes();
    applyHoldDuration();
    markDirty();
  });
  ['holdFixed', 'holdMin', 'holdMax'].forEach((id) => {
    $(id).addEventListener('change', () => { applyHoldDuration(); markDirty(); });
  });
  $('disableNutAutoDelay').addEventListener('change', (e) => {
    state.config.timing.disableNutAutoDelay = e.target.checked;
    markDirty();
  });

  // 步骤
  $('btnAddStep').addEventListener('click', () => openStepEditor(null));
  $('btnCloseModal').addEventListener('click', closeStepEditor);
  $('btnCancelModal').addEventListener('click', closeStepEditor);
  $('stepModal').addEventListener('click', (e) => { if (e.target === $('stepModal')) closeStepEditor(); });
  $('btnSaveStep').addEventListener('click', saveStepFromModal);

  // 重命名方案模态框
  $('btnCloseRenameModal').addEventListener('click', closeRenameModal);
  $('btnCancelRename').addEventListener('click', closeRenameModal);
  $('renameModal').addEventListener('click', (e) => { if (e.target === $('renameModal')) closeRenameModal(); });
  $('btnConfirmRename').addEventListener('click', confirmNameModal);
  $('renameInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); confirmNameModal(); } });
  $('stepType').addEventListener('change', (e) => updateStepTypeFields(e.target.value));
  $('stepHoldDurationMode').addEventListener('change', updateStepHoldDurationBoxes);
  $('stepIntervalMode').addEventListener('change', updateIntervalBoxes);
  $('stepKeyCapture').addEventListener('click', () => startCapture('stepKeyCapture', (name) => {
    $('stepKeySelect').value = name;
  }));
  $('stepKeySelect').addEventListener('change', (e) => {
    $('stepKeyCapture').value = e.target.value;
  });

  // 保存
  $('btnSave').addEventListener('click', saveConfig);

  // 方案
  $('schemeSelect').addEventListener('change', async (e) => {
    if (state.dirty && !confirm('当前配置有未保存修改，切换方案将丢失这些修改。继续？')) {
      e.target.value = state.config.schemeName;
      return;
    }
    try { await loadScheme(e.target.value); } catch (err) { addLog('error', err.message); }
  });
  $('btnNewScheme').addEventListener('click', () => openNameModal('create', null, ''));
  $('btnCopyScheme').addEventListener('click', () => copyScheme(state.config.schemeName));
  $('btnDelScheme').addEventListener('click', async () => {
    const name = $('schemeSelect').value;
    await deleteScheme(name);
  });
  $('btnImport').addEventListener('click', () => $('importFile').click());
  $('importFile').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const text = await file.text();
    try {
      const data = await api('POST', '/api/import', { json: text });
      await loadScheme(data.scheme);
      addLog('success', `导入成功：方案「${data.scheme}」`);
    } catch (err) { addLog('error', `导入失败：${err.message}`); }
    e.target.value = '';
  });
  $('btnExport').addEventListener('click', () => {
    window.location.href = '/api/export';
  });

  // 运行控制
  $('btnStart').addEventListener('click', startListening);
  $('btnStop').addEventListener('click', stopListening);
  $('btnTest').addEventListener('click', testRun);

  // 录制
  $('btnRecord').addEventListener('click', toggleRecording);

  // 日志
  $('btnClearLog').addEventListener('click', clearLog);
}

function applyHoldDuration() {
  const mode = $('holdMode').value;
  if (mode === 'fixed') {
    state.config.timing.holdDuration = { mode: 'fixed', value: +$('holdFixed').value || 0 };
  } else if (mode === 'random') {
    state.config.timing.holdDuration = { mode: 'random', min: +$('holdMin').value || 0, max: +$('holdMax').value || 0 };
  } else {
    state.config.timing.holdDuration = null;
  }
}

// ---------- 初始化 ----------

async function init() {
  clearLog();
  addLog('info', '正在加载配置…');

  try {
    // 1. 键列表
    const keys = await api('GET', '/api/keys');
    KEY_OPTIONS.push(...keys.keyboard);
    HOTKEY_OPTIONS.push(...keys.hotkeys);

    // 2. 方案列表
    await renderSchemeSelect();

    // 3. 当前配置
    const data = await api('GET', '/api/config');
    state.config = data.config;

    // 4. 绑定事件 + 渲染
    bindEvents();
    renderAll();
    updateRunningUI();

    addLog('success', `配置加载完成：方案「${state.config.schemeName}」，共 ${(state.config.steps || []).length} 个步骤`);

    // 5. WebSocket
    connectWS();
  } catch (err) {
    addLog('error', `初始化失败：${err.message}`);
    $('emptyState').textContent = `初始化失败：${err.message}`;
  }
}

init();
