//==============================================================
// server.js —— UI 服务入口（Express + WebSocket）
// 职责：
//   1. 提供浏览器访问的配置界面（public/ 静态资源）
//   2. REST API：配置读写 / 方案管理 / 导入导出 / 运行控制 / 录制
//   3. WebSocket：实时推送运行状态、当前步骤、日志、录制事件
//   4. 组装各模块：config（配置）、engine（执行）、listener（监听）
// 启动：npm start 或 node src/server.js
//==============================================================
'use strict';

require('dotenv').config();

const path = require('path');
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');

const configModule = require('./config');
const { MacroEngine } = require('./engine');
const { MacroListener } = require('./listener');
const keymap = require('./keymap');

const PORT = Number(process.env.PORT) || 8765;
const HOST = '127.0.0.1'; // 仅本机可访问（键鼠模拟工具，不对外网开放）
const DEBUG = process.env.LOG === 'DEBUG'; // 仅在设置 LOG=DEBUG 时打印控制台日志

// ---------- 全局状态 ----------
const state = {
  currentScheme: 'default',       // 当前编辑中的方案名
  config: null,                   // 当前编辑中的配置对象（内存副本）
  runningSchemes: new Map(),      // 正在监听运行的方案：方案名 -> 配置（支持多宏同时运行）
  recording: false                // 录制模式是否开启
};

const engine = new MacroEngine();
const listener = new MacroListener({
  onRecordEvent: (evt) => broadcast({ type: 'recordEvent', evt })
});

// ---------- 工具函数 ----------

/** 日志：控制台（仅 LOG=DEBUG）+ WebSocket 推送 */
function log(level, msg) {
  const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  const line = { type: 'log', level, time, msg };
  if (DEBUG) console.log(`[${time}] [${level}] ${msg}`);
  broadcast(line);
}

/** 向所有已连接的 WebSocket 客户端广播 */
function broadcast(payload) {
  const data = JSON.stringify(payload);
  for (const ws of wss.clients) {
    if (ws.readyState === 1 /* OPEN */) ws.send(data);
  }
}

/** 推送运行状态变化（running 为正在监听运行的方案名数组） */
function pushStatus(extra = {}) {
  broadcast({
    type: 'status',
    running: [...state.runningSchemes.keys()],
    recording: state.recording,
    ...extra
  });
}

/** 立即重新加载当前方案到内存 */
function reloadCurrentConfig() {
  state.config = configModule.loadScheme(state.currentScheme);
  if (!state.config) {
    // 方案文件损坏/缺失：回退到默认模板
    state.config = configModule.createScheme(state.currentScheme);
  }
  return state.config;
}

// ---------- 触发 / 退出事件处理（按方案隔离） ----------

/** 为指定方案生成执行回调（日志/进度带方案名） */
function makeHooks(schemeName) {
  return {
    onStep: (index, total, desc) => {
      pushStatus({ currentStep: { scheme: schemeName, index, total, desc } });
      log('info', `[${schemeName}] 步骤 ${index}/${total}：${desc}`);
    },
    onRound: (n) => log('info', `[${schemeName}] 第 ${n} 轮循环开始`)
  };
}

/** 触发键按下：执行对应方案（单次或按住循环） */
function handleTrigger(schemeName) {
  const cfg = state.runningSchemes.get(schemeName);
  if (!cfg) return;

  if (engine.busy) {
    log('warn', `[${schemeName}] 触发被忽略：另一个宏正在执行（防重入）`);
    return;
  }
  const mode = cfg.trigger?.mode || 'once';
  log('info', `[${schemeName}] 触发键按下 → 开始执行（模式：${mode === 'holdLoop' ? '按住循环' : '单次'}）`);
  const hooks = makeHooks(schemeName);

  if (mode === 'holdLoop') {
    // 按住循环：持续执行直到松开触发键，循环按方案独立停止
    engine.runLoop(cfg, hooks, schemeName).then((result) => {
      if (!result.ok && !result.skipped) log('error', `[${schemeName}] 循环执行结束（${result.error}）`);
    });
  } else {
    engine.runOnce(cfg, hooks).then((result) => {
      if (result.skipped) {
        log('warn', `[${schemeName}] 执行被跳过：另一个宏正在执行（防重入）`);
      } else if (!result.ok) {
        log('error', `[${schemeName}] 宏执行失败：${result.error}`);
      }
    });
  }
}

/** 触发键松开：停止该方案的按住循环 */
function handleTriggerRelease(schemeName) {
  const cfg = state.runningSchemes.get(schemeName);
  if (cfg?.trigger?.mode === 'holdLoop') {
    engine.stop(schemeName);
    log('info', `[${schemeName}] 触发键已松开，停止循环`);
  }
}

/** 退出键按下：仅停止该方案的监听（安全停止，不强制杀进程） */
function handleExit(schemeName) {
  log('info', `[${schemeName}] 退出键按下 → 停止该方案监听`);
  stopScheme(schemeName);
}

// ---------- 监听控制 ----------

/** 运行指定方案：加载配置、校验、注册监听绑定（加入运行集合） */
function startScheme(name) {
  const cfg = configModule.loadScheme(name);
  if (!cfg) return { ok: false, error: `方案 "${name}" 不存在` };
  if (state.runningSchemes.has(name)) return { ok: false, error: `方案「${name}」已在运行中` };

  const validation = configModule.validateConfig(cfg);
  if (!validation.ok) {
    return { ok: false, error: `配置校验失败：${validation.errors.join('；')}` };
  }

  const result = listener.addBinding({
    name,
    triggerKey: cfg.trigger?.key,
    exitKey: cfg.exitKey,
    onTrigger: () => handleTrigger(name),
    onTriggerRelease: () => handleTriggerRelease(name),
    onExit: () => handleExit(name)
  });
  if (!result.ok) return result;

  state.runningSchemes.set(name, cfg);
  pushStatus();
  log('info', `宏监听已启动：方案「${name}」触发键 ${cfg.trigger.key}，退出键 ${cfg.exitKey}`);
  return { ok: true };
}

/** 停止指定方案的监听（不影响其他方案） */
function stopScheme(name) {
  listener.removeBinding(name);
  engine.stop(name);
  state.runningSchemes.delete(name);
  pushStatus({ currentStep: null });
  log('info', `已停止方案「${name}」的监听`);
}

/** 停止全部方案的监听 */
function stopAllSchemes() {
  listener.clear();
  engine.stopAll();
  state.runningSchemes.clear();
  pushStatus({ currentStep: null });
  log('info', '已停止全部方案监听');
}

// ---------- WebSocket 服务 ----------

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (ws) => {
  // 新客户端连接后立即推送当前状态
  ws.send(JSON.stringify({ type: 'status', running: [...state.runningSchemes.keys()], recording: state.recording }));
});

// ---------- REST API ----------

/** GET /api/keys —— 支持的键列表 */
app.get('/api/keys', (req, res) => {
  res.json({ keyboard: keymap.KEY_NAMES, hotkeys: keymap.ALL_TRIGGER_OPTIONS, mouseButtons: keymap.MOUSE_BUTTONS });
});

/** 构造方案列表摘要（供列表 / 顺序接口共用） */
function schemeListPayload() {
  return configModule.listSchemes().map((name) => {
    const cfg = configModule.loadScheme(name) || {};
    return {
      name,
      schemeName: cfg.schemeName || name,
      triggerKey: cfg.trigger?.key || '',
      steps: Array.isArray(cfg.steps) ? cfg.steps.length : 0
    };
  });
}

/** GET /api/schemes —— 方案列表（含每个方案的摘要信息） */
app.get('/api/schemes', (req, res) => {
  res.json({ schemes: schemeListPayload(), current: state.currentScheme });
});

/** GET /api/config?scheme=xxx —— 获取方案配置（默认当前方案） */
app.get('/api/config', (req, res) => {
  const scheme = req.query.scheme || state.currentScheme;
  const cfg = configModule.loadScheme(scheme);
  if (!cfg) return res.status(404).json({ error: `方案 "${scheme}" 不存在` });
  state.currentScheme = scheme;
  state.config = cfg;
  res.json({ scheme, config: cfg });
});

/** POST /api/config —— 保存当前配置（完整覆盖） */
app.post('/api/config', (req, res) => {
  const cfg = req.body;
  const validation = configModule.validateConfig(cfg);
  if (!validation.ok) {
    return res.status(400).json({ ok: false, errors: validation.errors });
  }
  try {
    const file = configModule.saveScheme(cfg);
    state.config = cfg;
    state.currentScheme = cfg.schemeName;
    res.json({ ok: true, file, scheme: cfg.schemeName });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/** POST /api/schemes —— 新建方案（body: { name }） */
app.post('/api/schemes', (req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ ok: false, error: '方案名不能为空' });
  if (configModule.listSchemes().includes(name)) {
    return res.status(400).json({ ok: false, error: `方案 "${name}" 已存在` });
  }
  const cfg = configModule.createScheme(name);
  configModule.saveScheme(cfg);
  state.currentScheme = name;
  state.config = cfg;
  res.json({ ok: true, scheme: name, config: cfg });
});

/** POST /api/schemes/copy —— 基于指定（默认当前）方案复制一套新的（body: { from?, name }） */
app.post('/api/schemes/copy', (req, res) => {
  const from = String(req.body?.from || state.currentScheme);
  const name = String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ ok: false, error: '新方案名不能为空' });
  if (configModule.listSchemes().includes(name)) {
    return res.status(400).json({ ok: false, error: `方案 "${name}" 已存在` });
  }
  const src = configModule.loadScheme(from);
  if (!src) return res.status(404).json({ ok: false, error: `源方案 "${from}" 不存在` });
  const copy = configModule.clone(src);
  copy.schemeName = name;
  configModule.saveScheme(copy);
  log('info', `已基于方案「${from}」复制出新方案「${name}」`);
  res.json({ ok: true, scheme: name });
});

/** POST /api/schemes/:name/run —— 运行指定方案（加入多宏监听集合） */
app.post('/api/schemes/:name/run', (req, res) => {
  const result = startScheme(req.params.name);
  if (result.ok) {
    res.json({ ok: true, scheme: req.params.name });
  } else {
    res.status(400).json({ ok: false, error: result.error });
  }
});

/** POST /api/schemes/order —— 保存方案显示顺序（default 固定置顶） */
app.post('/api/schemes/order', (req, res) => {
  const order = Array.isArray(req.body?.order)
    ? req.body.order.map((n) => String(n).trim()).filter(Boolean)
    : [];
  configModule.saveOrder(order);
  res.json({ ok: true, schemes: schemeListPayload() });
});

/** POST /api/schemes/:name/rename —— 重命名方案（body: { name: 新方案名 }） */
app.post('/api/schemes/:name/rename', (req, res) => {
  const oldName = req.params.name;
  const newName = String(req.body?.name || '').trim();
  if (!newName) return res.status(400).json({ ok: false, error: '新方案名不能为空' });

  const result = configModule.renameScheme(oldName, newName);
  if (!result.ok) return res.status(400).json(result);
  if (newName === oldName) return res.json({ ok: true, scheme: newName });

  // 若方案正在运行：同步运行集合与监听绑定（热键不变，先移除旧绑定再注册新绑定）
  if (state.runningSchemes.has(oldName)) {
    const cfg = state.runningSchemes.get(oldName);
    state.runningSchemes.delete(oldName);
    cfg.schemeName = newName;
    listener.removeBinding(oldName);
    const bind = listener.addBinding({
      name: newName,
      triggerKey: cfg.trigger?.key,
      exitKey: cfg.exitKey,
      onTrigger: () => handleTrigger(newName),
      onTriggerRelease: () => handleTriggerRelease(newName),
      onExit: () => handleExit(newName)
    });
    if (!bind.ok) {
      // 绑定失败（理论不会发生，热键未变）：回滚文件与运行状态
      configModule.renameScheme(newName, oldName);
      cfg.schemeName = oldName;
      listener.addBinding({
        name: oldName,
        triggerKey: cfg.trigger?.key,
        exitKey: cfg.exitKey,
        onTrigger: () => handleTrigger(oldName),
        onTriggerRelease: () => handleTriggerRelease(oldName),
        onExit: () => handleExit(oldName)
      });
      state.runningSchemes.set(oldName, cfg);
      return res.status(400).json({ ok: false, error: `重命名后重新注册监听失败：${bind.error}` });
    }
    state.runningSchemes.set(newName, cfg);
  }

  // 若是当前编辑方案：同步 currentScheme 与内存配置
  if (state.currentScheme === oldName) {
    state.currentScheme = newName;
    if (state.config) state.config.schemeName = newName;
  }

  pushStatus();
  log('info', `方案已重命名：「${oldName}」→「${newName}」`);
  res.json({ ok: true, scheme: newName });
});

/** POST /api/schemes/:name/stop —— 停止指定方案的监听（不影响其他方案） */
app.post('/api/schemes/:name/stop', (req, res) => {
  stopScheme(req.params.name);
  res.json({ ok: true, scheme: req.params.name });
});

/** DELETE /api/schemes/:name —— 删除方案（若正在运行则先停止） */
app.delete('/api/schemes/:name', (req, res) => {
  const name = req.params.name;
  if (state.runningSchemes.has(name)) stopScheme(name);
  const result = configModule.deleteScheme(name);
  if (!result.ok) return res.status(400).json(result);
  if (state.currentScheme === name) {
    state.currentScheme = 'default';
    reloadCurrentConfig();
  }
  res.json({ ok: true });
});

/** POST /api/import —— 导入配置（body: { json } 或 { name, config }） */
app.post('/api/import', (req, res) => {
  try {
    let parsed;
    if (typeof req.body?.json === 'string') {
      parsed = JSON.parse(req.body.json);
    } else if (req.body?.config) {
      parsed = req.body.config;
    } else {
      return res.status(400).json({ ok: false, error: '缺少导入内容' });
    }
    const validation = configModule.validateConfig(parsed);
    if (!validation.ok) {
      return res.status(400).json({ ok: false, errors: validation.errors });
    }
    const name = parsed.schemeName || 'imported';
    configModule.saveScheme(parsed);
    state.currentScheme = name;
    state.config = parsed;
    res.json({ ok: true, scheme: name });
  } catch (err) {
    res.status(400).json({ ok: false, error: `JSON 解析失败：${err.message}` });
  }
});

/** GET /api/export —— 导出当前配置 */
app.get('/api/export', (req, res) => {
  res.setHeader('Content-Disposition', `attachment; filename="macro-${state.currentScheme}.json"`);
  res.json(state.config);
});

/** POST /api/start —— 启动监听：运行当前编辑中的方案（加入多宏监听集合） */
app.post('/api/start', (req, res) => {
  const result = startScheme(state.currentScheme);
  res.json(result.ok ? { ok: true } : { ok: false, error: result.error });
});

/** POST /api/stop —— 停止全部方案的监听 */
app.post('/api/stop', (req, res) => {
  stopAllSchemes();
  res.json({ ok: true });
});

/** POST /api/test —— 测试运行：不经过全局监听，直接执行一遍当前配置 */
app.post('/api/test', (req, res) => {
  const validation = configModule.validateConfig(state.config);
  if (!validation.ok) {
    return res.status(400).json({ ok: false, errors: validation.errors });
  }
  if (engine.busy) return res.json({ ok: false, error: '宏正在执行中，请稍后再试' });
  log('info', '=== 测试运行开始（不经过全局监听） ===');
  engine.runOnce(state.config, makeHooks(`测试-${state.currentScheme}`)).then((result) => {
    if (result.ok) log('info', '=== 测试运行完成 ===');
    else log('error', `测试运行失败：${result.error}`);
  });
  res.json({ ok: true });
});

/** POST /api/record —— 录制模式控制（body: { action: 'start'|'stop' }） */
app.post('/api/record', (req, res) => {
  const action = req.body?.action;
  if (action === 'start') {
    if (state.recording) return res.json({ ok: true, message: '录制已在进行中' });
    listener.recordStart();
    state.recording = true;
    pushStatus();
    log('info', '录制模式已开启：请手动执行一次想要录制的操作（全局生效，与宏监听是否启动无关）');
    return res.json({ ok: true });
  }
  if (action === 'stop') {
    listener.recordStop();
    state.recording = false;
    pushStatus();
    log('info', '录制模式已关闭，已生成操作序列');
    return res.json({ ok: true });
  }
  res.status(400).json({ ok: false, error: 'action 需为 start 或 stop' });
});

/** GET /api/status —— 当前状态（running 为正在监听运行的方案名数组） */
app.get('/api/status', (req, res) => {
  res.json({
    running: [...state.runningSchemes.keys()],
    recording: state.recording,
    scheme: state.currentScheme,
    busy: engine.busy
  });
});

// ---------- 启动 ----------

/**
 * 探测空闲端口：若目标端口被占用则自动顺延（8765 → 8766 → …）。
 * 避免旧实例仍在运行时新实例启动失败（EADDRINUSE）。
 */
function findFreePort(startPort) {
  return new Promise((resolve, reject) => {
    const probe = require('net').createServer();
    probe.once('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        resolve(findFreePort(startPort + 1)); // 被占用 → 递归探测下一个端口
      } else {
        reject(err);
      }
    });
    probe.listen(startPort, HOST, () => {
      const p = probe.address().port;
      probe.close(() => resolve(p));
    });
  });
}

reloadCurrentConfig();

(async () => {
  const port = await findFreePort(PORT).catch((err) => {
    console.error('端口探测失败:', err.message);
    process.exit(1);
  });

  // 兜底：listen 仍失败时给出明确错误而非崩溃
  server.on('error', (err) => {
    console.error('服务启动失败:', err.message);
    process.exit(1);
  });
  wss.on('error', () => { /* WebSocket 内部错误忽略，不影响 HTTP 服务 */ });

  server.listen(port, HOST, () => {
    const url = `http://${HOST}:${port}`;
    console.log('==============================================================');
    console.log('  可配置化一键宏 UI 工具已启动');
    console.log(`  浏览器访问：${url}`);
    if (port !== PORT) console.log(`  （原端口 ${PORT} 被其他实例占用，已自动切换到 ${port}）`);
    console.log(`  当前方案：${state.currentScheme}（${state.config.schemeName}）`);
    console.log('  提示：在界面中点击「启动监听」后，按触发键执行宏，按退出键停止');
    console.log('  关闭窗口或按 Ctrl+C 退出程序');
    console.log('==============================================================');
    // 自动打开默认浏览器（设置环境变量 MACRO_NO_BROWSER=1 可禁用）
    try {
      if (process.env.MACRO_NO_BROWSER !== '1') {
        const { spawn } = require('child_process');
        let child;
        if (process.platform === 'win32') {
          // 注意：start 命令第一个参数是窗口标题，必须用空串占位，避免 URL 被当作标题弹出多余窗口
          child = spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' });
        } else if (process.platform === 'darwin') {
          child = spawn('open', [url], { detached: true, stdio: 'ignore' });
        } else {
          child = spawn('xdg-open', [url], { detached: true, stdio: 'ignore' });
        }
        child?.unref();
      } else {
        console.log('  已通过 MACRO_NO_BROWSER 禁用自动打开浏览器');
      }
    } catch (e) { /* 打开失败不影响服务运行 */ }
  });
})();

// 进程退出前：释放所有按键、停止监听（防止残留卡键状态）
process.on('SIGINT', () => {
  console.log('\n正在退出，释放所有按键…');
  engine.stopAll().finally(() => process.exit(0));
});
process.on('SIGTERM', () => {
  engine.stopAll().finally(() => process.exit(0));
});
