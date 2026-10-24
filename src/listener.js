//==============================================================
// listener.js —— 事件监听模块
// 职责：使用 uiohook-napi 做全局键盘/鼠标监听，负责：
//   1. 多方案同时监听：每个方案绑定自己的触发键 + 退出键，
//      按对应键触发对应方案的回调
//   2. 防重复触发：每个绑定独立维护 triggerDown 标志
//   3. 录制模式：将全局键鼠事件转发给 onRecordEvent
//
// 设计：所有绑定共享同一组 uiohook 事件处理器，通过引用计数
// 决定何时注册/注销、何时 start/stop 原生钩子。录制模式可独立
// 于宏监听运行。运行新方案前做热键冲突检测（触发/退出键不得
// 与其他已运行方案重复）。
//==============================================================
'use strict';

const { uIOhook } = require('uiohook-napi');
const { toUiohookCode, uiohookCodeToName, MOUSE_BUTTONS } = require('./keymap');

// uiohook 鼠标按钮值 → 通用名称（1=左 2=右 3=中 4/5=侧键）
const MOUSE_BUTTON_NAMES = { 1: 'left', 2: 'right', 3: 'middle' };

class MacroListener {
  /**
   * @param {object} callbacks
   * @param {(evt: object) => void} callbacks.onRecordEvent 录制模式事件
   */
  constructor(callbacks = {}) {
    this._onRecordEvent = callbacks.onRecordEvent || (() => {});

    this._bindings = [];      // 已注册的方案绑定：{ name, trigger, exit, onTrigger, onTriggerRelease, onExit }
    this._triggerDown = new Map(); // 方案名 -> 触发键当前是否按住（防重复触发）
    this._recording = false;  // 录制模式开关
    this._useCount = 0;       // 原生钩子引用计数（绑定数 + 录制）
    this._nativeStarted = false;
    this._handlers = null;
  }

  /** 当前是否有任何绑定或录制在使用原生钩子 */
  get active() { return this._useCount > 0; }

  /** 当前已绑定的方案名列表 */
  get bindings() { return this._bindings.map((b) => b.name); }

  /** 录制模式是否开启 */
  get recording() { return this._recording; }

  /** 根据配置解析触发源 / 退出源为内部表示 */
  _resolveHotkey(name) {
    if (Object.prototype.hasOwnProperty.call(MOUSE_BUTTONS, name)) {
      return { type: 'mouse', code: MOUSE_BUTTONS[name] };
    }
    const code = toUiohookCode(name);
    return code == null ? null : { type: 'key', code };
  }

  /**
   * 为方案注册一组触发/退出绑定并启动原生钩子。
   * 执行热键冲突检测：触发键/退出键不得与其他已运行方案重复。
   * @returns {{ok:boolean, error?:string}}
   */
  addBinding({ name, triggerKey, exitKey, onTrigger, onTriggerRelease, onExit }) {
    const trigger = this._resolveHotkey(triggerKey);
    const exit = this._resolveHotkey(exitKey);
    if (!trigger) return { ok: false, error: `方案「${name}」触发键 "${triggerKey}" 无效` };
    if (!exit) return { ok: false, error: `方案「${name}」退出键 "${exitKey}" 无效` };

    // 与其他已运行方案做热键冲突检测（触发/退出之间均不得重复）
    for (const b of this._bindings) {
      const pairs = [
        ['触发键', trigger, b.trigger],
        ['退出键', exit, b.exit],
        ['触发键', trigger, b.exit],
        ['退出键', exit, b.trigger]
      ];
      for (const [role, mine, theirs] of pairs) {
        if (mine.type === theirs.type && mine.code === theirs.code) {
          return { ok: false, error: `热键冲突：${role}与已运行方案「${b.name}」重复（${triggerKey}/${exitKey}）` };
        }
      }
    }

    this._bindings.push({ name, trigger, exit, onTrigger: onTrigger || (() => {}), onTriggerRelease: onTriggerRelease || (() => {}), onExit: onExit || (() => {}) });
    this._triggerDown.set(name, false);
    this._acquire();
    return { ok: true };
  }

  /** 移除指定方案的绑定；无剩余绑定时停止原生钩子 */
  removeBinding(name) {
    const idx = this._bindings.findIndex((b) => b.name === name);
    if (idx < 0) return;
    this._bindings.splice(idx, 1);
    this._triggerDown.delete(name);
    this._release();
  }

  /** 移除全部绑定 */
  clear() {
    for (const b of [...this._bindings]) this.removeBinding(b.name);
  }

  // ---------- 生命周期（引用计数） ----------

  _acquire() {
    if (this._useCount === 0) this._registerHandlers();
    this._useCount++;
    if (!this._nativeStarted) {
      uIOhook.start();
      this._nativeStarted = true;
    }
  }

  _release() {
    this._useCount = Math.max(0, this._useCount - 1);
    if (this._useCount === 0) {
      this._unregisterHandlers();
      if (this._nativeStarted) {
        try { uIOhook.stop(); } catch (e) { /* 忽略停止异常 */ }
        this._nativeStarted = false;
      }
      this._triggerDown.clear();
    }
  }

  _registerHandlers() {
    if (this._handlers) return;
    this._handlers = {
      keydown: (e) => this._onKeyEvent('keydown', e),
      keyup: (e) => this._onKeyEvent('keyup', e),
      mousedown: (e) => this._onMouseEvent('mousedown', e),
      mouseup: (e) => this._onMouseEvent('mouseup', e)
    };
    uIOhook.on('keydown', this._handlers.keydown);
    uIOhook.on('keyup', this._handlers.keyup);
    uIOhook.on('mousedown', this._handlers.mousedown);
    uIOhook.on('mouseup', this._handlers.mouseup);
  }

  _unregisterHandlers() {
    if (!this._handlers) return;
    uIOhook.removeListener('keydown', this._handlers.keydown);
    uIOhook.removeListener('keyup', this._handlers.keyup);
    uIOhook.removeListener('mousedown', this._handlers.mousedown);
    uIOhook.removeListener('mouseup', this._handlers.mouseup);
    this._handlers = null;
  }

  /** 开启录制模式（可独立于宏监听运行） */
  recordStart() {
    if (this._recording) return;
    this._recording = true;
    this._acquire();
  }

  /** 关闭录制模式 */
  recordStop() {
    if (!this._recording) return;
    this._recording = false;
    this._release();
  }

  // ---------- 事件处理 ----------

  _onKeyEvent(type, e) {
    const keyName = uiohookCodeToName(e.keycode);

    // 录制模式：转发原始事件（未知键跳过）
    if (this._recording && keyName) {
      this._onRecordEvent({ kind: type === 'keydown' ? 'keydown' : 'keyup', key: keyName });
    }

    if (this._bindings.length === 0) return;

    for (const b of this._bindings) {
      // 退出键（按下时触发，仅作用于本方案）
      if (type === 'keydown' && b.exit.type === 'key' && e.keycode === b.exit.code) {
        b.onExit();
        continue;
      }
      // 触发键（防重复触发：按住期间只触发一次）
      if (b.trigger.type === 'key' && e.keycode === b.trigger.code) {
        if (type === 'keydown' && !this._triggerDown.get(b.name)) {
          this._triggerDown.set(b.name, true);
          b.onTrigger();
        } else if (type === 'keyup') {
          this._triggerDown.set(b.name, false);
          b.onTriggerRelease();
        }
      }
    }
  }

  _onMouseEvent(type, e) {
    const btnName = MOUSE_BUTTON_NAMES[e.button] ?? `mouse${e.button}`;

    // 录制模式：转发鼠标事件（左/右/中键点击）
    if (this._recording && ['left', 'right', 'middle'].includes(btnName)) {
      this._onRecordEvent({ kind: type === 'mousedown' ? 'mousedown' : 'mouseup', button: btnName });
    }

    if (this._bindings.length === 0) return;

    for (const b of this._bindings) {
      // 退出键为鼠标键
      if (type === 'mousedown' && b.exit.type === 'mouse' && e.button === b.exit.code) {
        b.onExit();
        continue;
      }
      // 触发键为鼠标侧键
      if (b.trigger.type === 'mouse' && e.button === b.trigger.code) {
        if (type === 'mousedown' && !this._triggerDown.get(b.name)) {
          this._triggerDown.set(b.name, true);
          b.onTrigger();
        } else if (type === 'mouseup') {
          this._triggerDown.set(b.name, false);
          b.onTriggerRelease();
        }
      }
    }
  }
}

module.exports = { MacroListener };
