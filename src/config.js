//==============================================================
// config.js —— 配置模块
// 职责：
//   1. 配置的加载 / 保存（JSON 持久化，支持多方案）
//   2. 配置的导入 / 导出
//   3. 配置校验（结构完整性、热键冲突检测）
// 配置文件存放于 config/ 目录，每个方案一个 JSON 文件。
//==============================================================
'use strict';

const fs = require('fs');
const path = require('path');
const { isKeyboardKey, isValidHotkey } = require('./keymap');

const CONFIG_DIR = path.join(__dirname, '..', 'config');
const FILE_SUFFIX = '.json';
const ORDER_FILE = path.join(CONFIG_DIR, '_order.json'); // 方案显示顺序（default 固定置顶，不参与排序）

// ---------- 内置默认配置（作为新建方案的模板） ----------
const DEFAULT_SCHEME = {
  version: 1,
  schemeName: '示例方案（W+右键）',
  trigger: {
    key: 'C',          // 触发键（键盘键或 Mouse4/Mouse5 侧键）
    mode: 'once',      // once=单次触发 | holdLoop=按住循环触发
    holdLoopInterval: 300 // 按住循环模式下，每轮之间的间隔（毫秒）
  },
  exitKey: 'X',        // 退出键：按下后停止监听（并非退出程序）
  timing: {
    globalSpeed: 1.0,  // 全局延迟倍率（0.5x ~ 2x），作用于所有延迟
    stepJitter: 0,     // 每一步延迟的抖动范围 ±ms
    holdDuration: null,// 按键保持时长（按下→松开），null=保持到显式 releaseKey
    disableNutAutoDelay: true // 关闭 nut.js 内置自动延迟，时序完全自控
  },
  steps: []            // 操作序列（见 README / 前端说明）
};

// ---------- 内部工具 ----------

/** 列出 config 目录下所有方案文件（不含扩展名；排除以下划线开头的内部文件如 _order.json） */
function listSchemeFiles() {
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
  return fs.readdirSync(CONFIG_DIR)
    .filter((f) => f.endsWith(FILE_SUFFIX) && !f.startsWith('_'))
    .map((f) => f.slice(0, -FILE_SUFFIX.length));
}

/** 方案名 → 文件路径（对文件名中的不安全字符做转义处理） */
function schemeToFile(schemeName) {
  const safe = String(schemeName).replace(/[\\/:*?"<>|]/g, '_').trim() || 'unnamed';
  return path.join(CONFIG_DIR, safe + FILE_SUFFIX);
}

/** 深度克隆（用于避免外部修改污染内部状态） */
function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

// ---------- 对外 API ----------

/** 读取用户自定义的方案显示顺序（不含 default） */
function readOrder() {
  try {
    const data = JSON.parse(fs.readFileSync(ORDER_FILE, 'utf8'));
    return Array.isArray(data.order) ? data.order.filter((n) => typeof n === 'string') : [];
  } catch { /* 顺序文件不存在或损坏时按默认排序 */ }
  return [];
}

/** 保存方案显示顺序（default 固定置顶，自动从顺序中剔除） */
function saveOrder(order) {
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const cleaned = (Array.isArray(order) ? order : [])
    .map((n) => String(n).trim())
    .filter((n) => n && n !== 'default');
  fs.writeFileSync(ORDER_FILE, JSON.stringify({ order: cleaned }, null, 2), 'utf8');
  return cleaned;
}

/**
 * 读取全部方案名：default 固定置顶，其余按自定义顺序（_order.json），
 * 新建的方案自动追加到末尾。
 */
function listSchemes() {
  const files = listSchemeFiles();
  const order = readOrder();
  const ordered = order.filter((n) => files.includes(n));       // 自定义顺序中仍存在的方案
  const rest = files.filter((n) => !ordered.includes(n) && n !== 'default'); // 新方案等按字母序追加
  const hasDefault = files.includes('default');
  return [...(hasDefault ? ['default'] : []), ...ordered, ...rest];
}

/** 读取指定方案配置；文件不存在或损坏时返回 null */
function loadScheme(schemeName) {
  const file = schemeToFile(schemeName);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    console.error(`[config] 读取方案 "${schemeName}" 失败:`, err.message);
    return null;
  }
}

/**
 * 保存方案配置（覆盖写）。
 * @param {object} config 完整配置对象（含 schemeName）
 */
function saveScheme(config) {
  if (!config || typeof config !== 'object') throw new Error('配置为空');
  const name = config.schemeName || 'unnamed';
  const file = schemeToFile(name);
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(config, null, 2), 'utf8');
  return file;
}

/** 删除指定方案（保护默认方案不被误删） */
function deleteScheme(schemeName) {
  if (schemeName === 'default') {
    return { ok: false, error: '内置 default 方案不允许删除' };
  }
  const file = schemeToFile(schemeName);
  if (!fs.existsSync(file)) return { ok: false, error: '方案不存在' };
  fs.unlinkSync(file);
  return { ok: true };
}

/** 重命名方案：改名文件 + 更新 schemeName 字段（保护默认方案） */
function renameScheme(oldName, newName) {
  const target = String(newName).trim();
  if (!target) return { ok: false, error: '新方案名不能为空' };
  if (target === oldName) return { ok: true, scheme: oldName };
  if (oldName === 'default') {
    return { ok: false, error: '内置 default 方案不允许重命名' };
  }
  if (listSchemes().includes(target)) {
    return { ok: false, error: `方案 "${target}" 已存在` };
  }
  const oldFile = schemeToFile(oldName);
  if (!fs.existsSync(oldFile)) return { ok: false, error: `方案 "${oldName}" 不存在` };
  const cfg = loadScheme(oldName);
  if (!cfg) return { ok: false, error: `方案 "${oldName}" 读取失败` };
  cfg.schemeName = target;
  fs.unlinkSync(oldFile);
  saveScheme(cfg);
  // 同步显示顺序：重命名后保持原位置
  const order = readOrder();
  const idx = order.indexOf(oldName);
  if (idx >= 0) {
    order[idx] = target;
    saveOrder(order);
  }
  return { ok: true, scheme: target };
}

/** 新建方案：以默认模板初始化，返回新配置对象 */
function createScheme(schemeName) {
  const cfg = clone(DEFAULT_SCHEME);
  cfg.schemeName = schemeName || `新方案 ${new Date().toLocaleTimeString('zh-CN')}`;
  return cfg;
}

/**
 * 配置校验 + 热键冲突检测。
 * 返回 { ok, errors: string[] }
 */
function validateConfig(config) {
  const errors = [];
  if (!config || typeof config !== 'object') return { ok: false, errors: ['配置为空'] };

  // 1) 触发键 / 退出键合法性
  const triggerKey = config.trigger?.key;
  const exitKey = config.exitKey;
  if (!isValidHotkey(triggerKey)) errors.push(`触发键 "${triggerKey}" 不受支持`);
  if (!isValidHotkey(exitKey)) errors.push(`退出键 "${exitKey}" 不受支持`);

  // 2) 触发模式合法性
  const mode = config.trigger?.mode;
  if (mode !== 'once' && mode !== 'holdLoop') errors.push(`触发模式 "${mode}" 不受支持`);

  // 3) 全局倍率范围
  const speed = Number(config.timing?.globalSpeed);
  if (!(speed >= 0.1 && speed <= 5)) errors.push(`全局延迟倍率 ${speed} 超出 0.1~5 范围`);

  // 4) 步骤校验
  const steps = Array.isArray(config.steps) ? config.steps : [];
  const usedKeys = new Set(); // 操作序列中涉及的键
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i] || {};
    const label = `步骤${i + 1}`;
    switch (s.type) {
      case 'pressKey':
      case 'releaseKey':
        if (!isKeyboardKey(s.key)) errors.push(`${label}: 按键 "${s.key}" 不受支持`);
        else usedKeys.add(s.key);
        break;
      case 'mouseClick':
        if (!['left', 'right', 'middle'].includes(s.button)) {
          errors.push(`${label}: 鼠标键 "${s.button}" 不受支持`);
        }
        break;
      case 'mouseMove':
        if (typeof s.x !== 'number' || typeof s.y !== 'number') {
          errors.push(`${label}: 鼠标移动坐标必须为数字`);
        }
        break;
      case 'fixedDelay':
        if (!(Number(s.ms) >= 0)) errors.push(`${label}: 固定延迟必须 ≥ 0`);
        break;
      case 'randomDelay':
        if (!(Number(s.min) >= 0 && Number(s.max) >= Number(s.min))) {
          errors.push(`${label}: 随机延迟区间无效（需 0 ≤ min ≤ max）`);
        }
        break;
      default:
        errors.push(`${label}: 未知步骤类型 "${s.type}"`);
    }
  }

  // 5) 热键冲突检测：触发键/退出键不能出现在操作序列的按键里
  if (usedKeys.has(triggerKey)) {
    errors.push(`热键冲突：触发键 "${triggerKey}" 与操作序列中的按键重复`);
  }
  if (usedKeys.has(exitKey)) {
    errors.push(`热键冲突：退出键 "${exitKey}" 与操作序列中的按键重复`);
  }

  return { ok: errors.length === 0, errors };
}

module.exports = {
  CONFIG_DIR,
  DEFAULT_SCHEME,
  listSchemes,
  loadScheme,
  saveScheme,
  deleteScheme,
  createScheme,
  validateConfig,
  renameScheme,
  saveOrder,
  clone
};
