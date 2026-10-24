//==============================================================
// engine.js —— 宏执行引擎
// 职责：根据配置对象中的操作序列，使用 @nut-tree/nut-js 执行
//       键鼠模拟。
// 关键设计：
//   1. 防重入：busy 标志，宏执行中忽略新的触发
//   2. 防卡键：heldKeys / heldButtons 记录所有被按下的键，
//      无论成功或失败，finally 兜底全部释放（修复原脚本按键卡住问题）
//   3. 所有延迟/按键/鼠标参数均从配置对象动态读取，不硬编码
//   4. 支持单次执行（runOnce）与按住循环（runLoop）
//==============================================================
'use strict';

const { keyboard, mouse, Button, Point } = require('@nut-tree/nut-js');
const { toNutKey } = require('./keymap');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

/** 区间随机数 [min, max] */
function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}

/** 步骤描述（用于日志 / 前端状态显示） */
function describeStep(step) {
  switch (step.type) {
    case 'pressKey': return step.hold
      ? `按住 ${step.key}（保持中）`
      : `点按 ${step.key}`;
    case 'releaseKey': return `松开 ${step.key}`;
    case 'mouseClick': return `鼠标${buttonName(step.button)}键点击`;
    case 'mouseMove':
      return step.mode === 'absolute'
        ? `鼠标移动到 (${step.x}, ${step.y})`
        : `鼠标相对移动 (${step.x > 0 ? '+' : ''}${step.x}, ${step.y > 0 ? '+' : ''}${step.y})`;
    case 'fixedDelay': return `固定延迟 ${step.ms}ms`;
    case 'randomDelay': return `随机延迟 ${step.min}~${step.max}ms`;
    default: return '未知步骤';
  }
}

function buttonName(b) {
  return { left: '左', right: '右', middle: '中' }[b] || b;
}

class MacroEngine {
  constructor() {
    this._busy = false;          // 防重入标志：宏执行中
    this._loopSignals = new Map(); // 循环停止信号：ctxId(方案名) -> { stop }
    this._heldKeys = new Set();  // 当前被按下的键盘键（键名）
    this._heldButtons = new Set(); // 当前被按下的鼠标键（Button 枚举）
  }

  get busy() { return this._busy; }

  /**
   * 应用 nut.js 自动延迟开关。
   * 开启：nut.js 会在每次键鼠事件间插入自动延迟，时序由库控制；
   * 关闭（推荐）：时序完全由本引擎控制，更精准。
   */
  _applyAutoDelay(cfg) {
    const enabled = cfg.timing?.disableNutAutoDelay !== true;
    mouse.config.autoDelayMs = enabled ? 20 : 0;
    keyboard.config.autoDelayMs = enabled ? 20 : 0;
  }

  /** 计算单次延迟：基准值 + 全局抖动，再乘全局倍率 */
  _calcDelay(baseMs, cfg) {
    let ms = Number(baseMs) || 0;
    const jitter = Number(cfg.timing?.stepJitter) || 0;
    if (jitter > 0) ms += (Math.random() * 2 - 1) * jitter;
    const speed = Number(cfg.timing?.globalSpeed) || 1;
    ms *= clamp(speed, 0.1, 5);
    return Math.max(0, Math.round(ms));
  }

  /** 计算保持时长 / 间隔等 {mode,value} 或 {mode,min,max} 结构 */
  _calcIntervalConfig(iv, cfg) {
    if (!iv || typeof iv !== 'object') return 0;
    let base = 0;
    if (iv.mode === 'random') {
      base = randomBetween(Number(iv.min) || 0, Number(iv.max) || 0);
    } else {
      base = Number(iv.value) || 0;
    }
    return this._calcDelay(base, cfg);
  }

  /**
   * 释放所有被按下的键（键盘 + 鼠标），保证不卡键。
   * 每个键独立 try/catch：单个失败不影响其余键释放。
   */
  async _releaseAllHeld() {
    for (const key of this._heldKeys) {
      const nutKey = toNutKey(key);
      if (nutKey != null) {
        try { await keyboard.releaseKey(nutKey); } catch (e) { /* 忽略单个键的释放失败 */ }
      }
    }
    this._heldKeys.clear();

    for (const btn of this._heldButtons) {
      try { await mouse.releaseButton(btn); } catch (e) { /* 同上 */ }
    }
    this._heldButtons.clear();
  }

  /**
   * 执行操作序列中的单个步骤。
   * @param {object} step  步骤配置
   * @param {object} cfg   完整配置（含 timing）
   */
  async _executeStep(step, cfg) {
    switch (step.type) {
      case 'pressKey': {
        const nutKey = toNutKey(step.key);
        if (nutKey == null) throw new Error(`未知按键 "${step.key}"`);
        await keyboard.pressKey(nutKey); // 按下
        if (step.hold === false) {
          await keyboard.releaseKey(nutKey); // 不保持 → 立即松开（点按）
          return;
        }
        // 保持按住：记录到 heldKeys 以便兜底释放
        this._heldKeys.add(step.key);
        // 保持时长：步骤内显式配置优先，否则回落到全局配置
        const holdCfg = step.holdDuration ?? cfg.timing?.holdDuration;
        if (holdCfg && typeof holdCfg === 'object') {
          await sleep(this._calcIntervalConfig(holdCfg, cfg)); // 保持 N ms
          await keyboard.releaseKey(nutKey);
          this._heldKeys.delete(step.key);
        }
        // holdCfg 为空 → 保持到显式 releaseKey 或宏结束（finally 兜底）
        break;
      }

      case 'releaseKey': {
        const nutKey = toNutKey(step.key);
        if (nutKey == null) throw new Error(`未知按键 "${step.key}"`);
        await keyboard.releaseKey(nutKey);
        this._heldKeys.delete(step.key);
        break;
      }

      case 'mouseClick': {
        const btn = { left: Button.LEFT, right: Button.RIGHT, middle: Button.MIDDLE }[step.button];
        if (btn == null) throw new Error(`未知鼠标键 "${step.button}"`);
        await mouse.click(btn);
        break;
      }

      case 'mouseMove': {
        if (step.mode === 'relative') {
          // 相对位移：先取当前坐标，再移动到新位置
          const cur = await mouse.getPosition();
          await mouse.setPosition(new Point(cur.x + (Number(step.x) || 0), cur.y + (Number(step.y) || 0)));
        } else {
          // 绝对坐标
          await mouse.setPosition(new Point(Number(step.x) || 0, Number(step.y) || 0));
        }
        break;
      }

      case 'fixedDelay': {
        await sleep(this._calcDelay(step.ms, cfg));
        break;
      }

      case 'randomDelay': {
        await sleep(this._calcDelay(randomBetween(Number(step.min), Number(step.max)), cfg));
        break;
      }

      default:
        throw new Error(`未知步骤类型 "${step.type}"`);
    }
  }

  /**
   * 执行一遍操作序列（不含 busy 检查，供 runOnce / runLoop 内部调用）。
   * @returns {Promise<{ok:boolean, error?:string}>}
   */
  async _runSequence(cfg, hooks) {
    const steps = Array.isArray(cfg.steps) ? cfg.steps : [];
    try {
      this._applyAutoDelay(cfg);
      for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        await this._executeStep(step, cfg);
        hooks.onStep?.(i + 1, steps.length, describeStep(step));
        // 步骤间隔：最后一步之后不再等待
        if (i < steps.length - 1) {
          await sleep(this._calcIntervalConfig(step.interval, cfg));
        }
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    } finally {
      // ★ 核心修复：无论成功或失败，确保所有按下的键最终被释放
      await this._releaseAllHeld();
    }
  }

  /**
   * 单次执行整个操作序列。
   * @param {object} cfg  完整配置
   * @param {object} [hooks] { onStep(index, total, desc) }
   * @returns {Promise<{ok:boolean, skipped?:boolean, error?:string}>}
   */
  async runOnce(cfg, hooks = {}) {
    // 防重入：执行中直接忽略
    if (this._busy) return { ok: false, skipped: true, error: '另一个宏正在执行中' };

    this._busy = true;
    try {
      return await this._runSequence(cfg, hooks);
    } finally {
      this._busy = false;
    }
  }

  /**
   * 按住循环模式：持续执行操作序列，直到 stop(ctxId) 被调用（松开触发键）。
   * 支持多个方案各自独立的循环：ctxId 标识循环所属的方案。
   * @param {object} cfg  完整配置
   * @param {object} [hooks] { onStep(...), onRound(n) }
   * @param {string} [ctxId] 循环上下文标识（通常为方案名）
   */
  async runLoop(cfg, hooks = {}, ctxId = 'default') {
    if (this._busy) return { ok: false, skipped: true, error: '另一个宏正在执行中' };

    this._busy = true;
    const signal = { stop: false };
    this._loopSignals.set(ctxId, signal);
    let round = 0;

    try {
      while (!signal.stop) {
        round++;
        hooks.onRound?.(round);
        const result = await this._runSequence(cfg, hooks);
        if (!result.ok) return result; // 出错则终止循环
        if (signal.stop) break;
        await sleep(this._calcIntervalConfig(cfg.trigger?.holdLoopInterval, cfg));
      }
      return { ok: true };
    } finally {
      this._loopSignals.delete(ctxId);
      this._busy = false;
    }
  }

  /**
   * 停止指定方案的循环（ctxId），并立即释放所有按键。
   * 不停止其他方案正在执行的循环。
   */
  async stop(ctxId = 'default') {
    const signal = this._loopSignals.get(ctxId);
    if (signal) signal.stop = true;
    await this._releaseAllHeld();
  }

  /** 停止所有方案的循环并释放所有按键 */
  async stopAll() {
    for (const signal of this._loopSignals.values()) signal.stop = true;
    await this._releaseAllHeld();
  }
}

module.exports = { MacroEngine, describeStep };
