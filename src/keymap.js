//==============================================================
// keymap.js —— 键位映射模块
// 统一键名（字符串）↔ nut-js Key 枚举 ↔ uiohook-napi keycode
// 作用：让配置文件中使用人类可读的键名（如 "W"、"F1"、"Numpad2"），
//       执行时转换为两个库各自的内部表示。
//==============================================================
'use strict';

const { Key } = require('@nut-tree/nut-js');
const { UiohookKey } = require('uiohook-napi');

// ---------- 键名 → nut-js Key ----------
// 键名规范（同时用于 UI 下拉框与配置文件）：
//   A~Z / 0~9 / F1~F12 / Numpad0~9 / Space / Enter / Tab / 修饰键等
const NAME_TO_NUT_KEY = {
  '0': Key.Num0, '1': Key.Num1, '2': Key.Num2, '3': Key.Num3, '4': Key.Num4,
  '5': Key.Num5, '6': Key.Num6, '7': Key.Num7, '8': Key.Num8, '9': Key.Num9,
  A: Key.A, B: Key.B, C: Key.C, D: Key.D, E: Key.E, F: Key.F, G: Key.G,
  H: Key.H, I: Key.I, J: Key.J, K: Key.K, L: Key.L, M: Key.M, N: Key.N,
  O: Key.O, P: Key.P, Q: Key.Q, R: Key.R, S: Key.S, T: Key.T, U: Key.U,
  V: Key.V, W: Key.W, X: Key.X, Y: Key.Y, Z: Key.Z,
  F1: Key.F1, F2: Key.F2, F3: Key.F3, F4: Key.F4, F5: Key.F5, F6: Key.F6,
  F7: Key.F7, F8: Key.F8, F9: Key.F9, F10: Key.F10, F11: Key.F11, F12: Key.F12,
  Numpad0: Key.NumPad0, Numpad1: Key.NumPad1, Numpad2: Key.NumPad2,
  Numpad3: Key.NumPad3, Numpad4: Key.NumPad4, Numpad5: Key.NumPad5,
  Numpad6: Key.NumPad6, Numpad7: Key.NumPad7, Numpad8: Key.NumPad8,
  Numpad9: Key.NumPad9,
  Space: Key.Space, Enter: Key.Enter, Tab: Key.Tab, CapsLock: Key.CapsLock,
  Escape: Key.Escape, Backspace: Key.Backspace,
  ArrowUp: Key.Up, ArrowDown: Key.Down, ArrowLeft: Key.Left, ArrowRight: Key.Right,
  Home: Key.Home, End: Key.End, PageUp: Key.PageUp, PageDown: Key.PageDown,
  Insert: Key.Insert, Delete: Key.Delete,
  Semicolon: Key.Semicolon, Comma: Key.Comma, Period: Key.Period, Slash: Key.Slash,
  Backquote: Key.Grave, Minus: Key.Minus, Equal: Key.Equal,
  BracketLeft: Key.LeftBracket, BracketRight: Key.RightBracket,
  Backslash: Key.Backslash, Quote: Key.Quote,
  Ctrl: Key.LeftControl, Alt: Key.LeftAlt, Shift: Key.LeftShift, Meta: Key.LeftSuper,
  NumLock: Key.NumLock, ScrollLock: Key.ScrollLock, PrintScreen: Key.Print,
  Pause: Key.Pause, Menu: Key.Menu
};

// ---------- 键名 → uiohook-napi keycode ----------
const NAME_TO_UIOHOOK = {
  '0': UiohookKey['0'], '1': UiohookKey['1'], '2': UiohookKey['2'], '3': UiohookKey['3'],
  '4': UiohookKey['4'], '5': UiohookKey['5'], '6': UiohookKey['6'], '7': UiohookKey['7'],
  '8': UiohookKey['8'], '9': UiohookKey['9'],
  A: UiohookKey.A, B: UiohookKey.B, C: UiohookKey.C, D: UiohookKey.D, E: UiohookKey.E,
  F: UiohookKey.F, G: UiohookKey.G, H: UiohookKey.H, I: UiohookKey.I, J: UiohookKey.J,
  K: UiohookKey.K, L: UiohookKey.L, M: UiohookKey.M, N: UiohookKey.N, O: UiohookKey.O,
  P: UiohookKey.P, Q: UiohookKey.Q, R: UiohookKey.R, S: UiohookKey.S, T: UiohookKey.T,
  U: UiohookKey.U, V: UiohookKey.V, W: UiohookKey.W, X: UiohookKey.X, Y: UiohookKey.Y,
  Z: UiohookKey.Z,
  F1: UiohookKey.F1, F2: UiohookKey.F2, F3: UiohookKey.F3, F4: UiohookKey.F4,
  F5: UiohookKey.F5, F6: UiohookKey.F6, F7: UiohookKey.F7, F8: UiohookKey.F8,
  F9: UiohookKey.F9, F10: UiohookKey.F10, F11: UiohookKey.F11, F12: UiohookKey.F12,
  Numpad0: UiohookKey.Numpad0, Numpad1: UiohookKey.Numpad1, Numpad2: UiohookKey.Numpad2,
  Numpad3: UiohookKey.Numpad3, Numpad4: UiohookKey.Numpad4, Numpad5: UiohookKey.Numpad5,
  Numpad6: UiohookKey.Numpad6, Numpad7: UiohookKey.Numpad7, Numpad8: UiohookKey.Numpad8,
  Numpad9: UiohookKey.Numpad9,
  Space: UiohookKey.Space, Enter: UiohookKey.Enter, Tab: UiohookKey.Tab,
  CapsLock: UiohookKey.CapsLock, Escape: UiohookKey.Escape,
  Backspace: UiohookKey.Backspace,
  ArrowUp: UiohookKey.ArrowUp, ArrowDown: UiohookKey.ArrowDown,
  ArrowLeft: UiohookKey.ArrowLeft, ArrowRight: UiohookKey.ArrowRight,
  Home: UiohookKey.Home, End: UiohookKey.End, PageUp: UiohookKey.PageUp,
  PageDown: UiohookKey.PageDown, Insert: UiohookKey.Insert, Delete: UiohookKey.Delete,
  Semicolon: UiohookKey.Semicolon, Comma: UiohookKey.Comma, Period: UiohookKey.Period,
  Slash: UiohookKey.Slash, Backquote: UiohookKey.Backquote, Minus: UiohookKey.Minus,
  Equal: UiohookKey.Equal, BracketLeft: UiohookKey.BracketLeft,
  BracketRight: UiohookKey.BracketRight, Backslash: UiohookKey.Backslash,
  Quote: UiohookKey.Quote,
  Ctrl: UiohookKey.Ctrl, Alt: UiohookKey.Alt, Shift: UiohookKey.Shift,
  Meta: UiohookKey.Meta, NumLock: UiohookKey.NumLock, ScrollLock: UiohookKey.ScrollLock,
  PrintScreen: UiohookKey.PrintScreen
};

// ---------- 鼠标侧键（用于触发键，uiohook 鼠标按钮值） ----------
// uiohook 约定：1=左键 2=右键 3=中键 4/5=侧键（浏览器前进/后退）
const MOUSE_BUTTONS = {
  Mouse4: 4,
  Mouse5: 5
};

// 供 UI 使用的完整可选项（键 + 鼠标侧键）
const KEY_NAMES = Object.keys(NAME_TO_NUT_KEY);
const ALL_TRIGGER_OPTIONS = [...KEY_NAMES, ...Object.keys(MOUSE_BUTTONS)];

// ---------- 工具函数 ----------

/** 键名是否为合法的键盘键 */
function isKeyboardKey(name) {
  return Object.prototype.hasOwnProperty.call(NAME_TO_NUT_KEY, name);
}

/** 键名是否为合法的触发/退出源（键盘键或鼠标侧键） */
function isValidHotkey(name) {
  return isKeyboardKey(name) || Object.prototype.hasOwnProperty.call(MOUSE_BUTTONS, name);
}

/** 键名 → nut-js Key；非法键名返回 null */
function toNutKey(name) {
  return NAME_TO_NUT_KEY[name] ?? null;
}

/** 键名 → uiohook keycode；非法键名返回 null */
function toUiohookCode(name) {
  return NAME_TO_UIOHOOK[name] ?? null;
}

/** uiohook keycode → 键名；未知 keycode 返回 null（用于按键捕获回显） */
function uiohookCodeToName(code) {
  for (const [name, value] of Object.entries(NAME_TO_UIOHOOK)) {
    if (value === code) return name;
  }
  return null;
}

/** 鼠标按钮值 → 触发键名；未知值返回 null */
function mouseButtonToName(button) {
  for (const [name, value] of Object.entries(MOUSE_BUTTONS)) {
    if (value === button) return name;
  }
  return null;
}

module.exports = {
  KEY_NAMES,
  ALL_TRIGGER_OPTIONS,
  MOUSE_BUTTONS,
  isKeyboardKey,
  isValidHotkey,
  toNutKey,
  toUiohookCode,
  uiohookCodeToName,
  mouseButtonToName
};
