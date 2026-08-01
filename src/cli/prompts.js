/**
 * src/cli/prompts.js
 *
 * Tiny TUI prompt library — zero dependencies.
 * Lineage: ported from glnc's src/cli/prompts.js (same author); the
 * split-chunk escape-sequence buffering and Esc-vs-CSI disambiguation
 * were battle-tested there over SSH/PTY.
 *
 * Exports:
 *   box(lines, opts)              => string  (rounded-border box)
 *   select({ message, choices })  => Promise<value>
 *   input({ message, ... })       => Promise<string>
 *   CancelledError                — thrown on Ctrl+C / Ctrl+D / Esc
 */

import { bold, dim, cyan, gray } from './theme.js';

const brand = cyan;
const brandDim = gray;

const stdout = process.stdout;
const stdin = process.stdin;

const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;

function visibleLen(s) {
  return s.replace(ANSI_RE, '').length;
}

function write(s) { stdout.write(s); }
function clearLine() { write('\r\x1b[2K'); }
function moveUp(n) { if (n > 0) write(`\x1b[${n}A`); }
function hideCursor() { write('\x1b[?25l'); }
function showCursor() { write('\x1b[?25h'); }

export class CancelledError extends Error {
  constructor() { super('cancelled'); this.name = 'CancelledError'; }
}

/**
 * Parse a raw stdin chunk into discrete logical keys plus any trailing
 * partial escape sequence to carry into the next chunk. A lone ESC at the
 * chunk tail is ambiguous (Esc keypress vs CSI prefix split across reads
 * over SSH/PTY) — it is buffered, never guessed.
 *
 * @param {string} data
 * @returns {{ keys: Array<{type: string, value?: string}>, remainder: string }}
 */
export function parseKeys(data) {
  const keys = [];
  let i = 0;
  while (i < data.length) {
    const ch = data[i];
    const code = data.charCodeAt(i);

    if (code === 0x03)      { keys.push({ type: 'ctrl-c' }); i++; continue; }
    if (code === 0x04)      { keys.push({ type: 'ctrl-d' }); i++; continue; }
    if (code === 0x09)      { keys.push({ type: 'tab' }); i++; continue; }
    if (code === 0x0d || code === 0x0a) { keys.push({ type: 'enter' }); i++; continue; }
    if (code === 0x7f || code === 0x08) { keys.push({ type: 'backspace' }); i++; continue; }

    if (code === 0x1b) {
      if (i === data.length - 1) {
        return { keys, remainder: '\x1b' };
      }

      const next = data[i + 1];

      // SS3 sequence: ESC O <final>
      if (next === 'O') {
        if (i + 2 >= data.length) {
          return { keys, remainder: data.slice(i) };
        }
        const final = data[i + 2];
        if      (final === 'A') keys.push({ type: 'up' });
        else if (final === 'B') keys.push({ type: 'down' });
        else if (final === 'C') keys.push({ type: 'right' });
        else if (final === 'D') keys.push({ type: 'left' });
        i += 3;
        continue;
      }

      // CSI sequence: ESC [ <params> <final 0x40–0x7E>
      if (next === '[') {
        let j = i + 2;
        while (j < data.length) {
          const fc = data.charCodeAt(j);
          if (fc >= 0x40 && fc <= 0x7e) break;
          j++;
        }
        if (j >= data.length) {
          return { keys, remainder: data.slice(i) };
        }

        const final = data[j];
        const params = data.slice(i + 2, j);

        if      (final === 'A') keys.push({ type: 'up' });
        else if (final === 'B') keys.push({ type: 'down' });
        else if (final === 'C') keys.push({ type: 'right' });
        else if (final === 'D') keys.push({ type: 'left' });
        else if (final === 'H') keys.push({ type: 'home' });
        else if (final === 'F') keys.push({ type: 'end' });
        else if (final === '~') {
          if      (params === '1' || params === '7') keys.push({ type: 'home' });
          else if (params === '3') keys.push({ type: 'delete' });
          else if (params === '4' || params === '8') keys.push({ type: 'end' });
          else if (params === '5') keys.push({ type: 'pageup' });
          else if (params === '6') keys.push({ type: 'pagedown' });
        }
        // any other CSI final byte: silently dropped (no leak)

        i = j + 1;
        continue;
      }

      // ESC followed by some other byte — bare Esc; next byte reprocessed.
      keys.push({ type: 'esc' });
      i++;
      continue;
    }

    // Skip other control bytes.
    if (code < 32) { i++; continue; }

    keys.push({ type: 'char', value: ch });
    i++;
  }
  return { keys, remainder: '' };
}

/**
 * Stateful wrapper around parseKeys that buffers partial escape sequences
 * across stdin data events. A chunk-tail ESC is held for `escTimeoutMs`
 * and emitted as a real Esc only if no continuation byte arrives.
 *
 * @param {{ escTimeoutMs?: number }} [opts]
 */
export function createKeyReader(opts = {}) {
  const escTimeoutMs = opts.escTimeoutMs ?? 50;
  let pending = '';
  let pendingTimer = null;
  let lastEmit = null;

  const clearPendingTimer = () => {
    if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; }
  };

  return {
    feed(data, onKeys) {
      lastEmit = onKeys;
      clearPendingTimer();

      const combined = pending + data;
      const { keys, remainder } = parseKeys(combined);
      pending = remainder;

      if (keys.length) onKeys(keys);

      if (pending === '\x1b') {
        pendingTimer = setTimeout(() => {
          pendingTimer = null;
          if (pending === '\x1b' && lastEmit) {
            pending = '';
            lastEmit([{ type: 'esc' }]);
          }
        }, escTimeoutMs);
      }
    },
    dispose() {
      clearPendingTimer();
      pending = '';
      lastEmit = null;
    },
  };
}

function ensureTTY() {
  if (!stdin.isTTY) throw new Error('Interactive prompts require a TTY');
}

let cleanupInstalled = false;
function installGlobalCleanup() {
  if (cleanupInstalled) return;
  cleanupInstalled = true;
  const restore = () => {
    try { stdin.setRawMode(false); } catch { /* not a TTY */ }
    showCursor();
  };
  process.on('exit', restore);
}

// ---------------------------------------------------------------------------
// Rounded box
// ---------------------------------------------------------------------------

/**
 * Render a rounded-border box around the given (already styled) lines.
 *
 * @param {string[]} lines
 * @param {{ borderColor?: (s: string) => string, paddingX?: number, title?: string }} [opts]
 * @returns {string}
 */
export function box(lines, opts = {}) {
  const borderColor = opts.borderColor ?? brand;
  const paddingX = opts.paddingX ?? 2;

  const innerWidth = Math.max(...lines.map(visibleLen));
  const totalInner = innerWidth + paddingX * 2;
  const padX = ' '.repeat(paddingX);

  let top;
  if (opts.title) {
    const titleText = ' ' + opts.title + ' ';
    const dashTotal = Math.max(0, totalInner - titleText.length);
    const leftDashes = Math.floor(dashTotal / 2);
    top = borderColor('╭' + '─'.repeat(leftDashes) + titleText + '─'.repeat(dashTotal - leftDashes) + '╮');
  } else {
    top = borderColor('╭' + '─'.repeat(totalInner) + '╮');
  }

  const bottom = borderColor('╰' + '─'.repeat(totalInner) + '╯');

  const middle = lines.map(line => {
    const trail = ' '.repeat(innerWidth - visibleLen(line));
    return borderColor('│') + padX + line + trail + padX + borderColor('│');
  });

  return [top, ...middle, bottom].join('\n');
}

// ---------------------------------------------------------------------------
// select — arrow-key menu
// ---------------------------------------------------------------------------

/**
 * @typedef {{ value: any, label: string, description?: string, icon?: string }} Choice
 *
 * @param {{ message: string, hint?: string, choices: Choice[], initial?: number }} args
 * @returns {Promise<any>}
 */
export async function select({ message, hint, choices, initial = 0 }) {
  ensureTTY();
  installGlobalCleanup();

  let index = Math.max(0, Math.min(initial, choices.length - 1));
  const labelWidth = Math.max(...choices.map(ch => visibleLen(ch.label)));
  const quitChoiceIdx = choices.findIndex(ch => ch.value === 'quit');

  const hintText = hint ?? '↑/↓ move · Enter select · Esc cancel · Ctrl+C quit';

  const renderHeader = () => {
    write(brand('›') + ' ' + bold(message) + ' ' + brandDim('(' + hintText + ')') + '\n');
  };

  const renderChoices = (firstRender) => {
    if (!firstRender) moveUp(choices.length);
    for (let i = 0; i < choices.length; i++) {
      const ch = choices[i];
      const active = i === index;
      clearLine();

      const cursor = active ? brand('›') + ' ' : '  ';
      const icon   = ch.icon ? (active ? brand(ch.icon) : dim(ch.icon)) + ' ' : '';
      const pad    = ' '.repeat(labelWidth - visibleLen(ch.label));

      let label, desc;
      if (active) {
        label = bold(brand(ch.label));
        desc  = ch.description ? '  ' + dim(ch.description) : '';
      } else {
        label = dim(ch.label);
        desc  = ch.description ? '  ' + dim(ch.description) : '';
      }

      write(cursor + icon + label + pad + desc + '\n');
    }
  };

  hideCursor();
  renderHeader();
  renderChoices(true);

  return new Promise((resolve, reject) => {
    const reader = createKeyReader();
    const finish = (resolveFn, value) => {
      reader.dispose();
      stdin.setRawMode(false);
      stdin.removeListener('data', onData);
      stdin.pause();
      showCursor();
      resolveFn(value);
    };

    const handleKeys = (keys) => {
      for (const key of keys) {
        if (key.type === 'ctrl-c' || key.type === 'ctrl-d' || key.type === 'esc') {
          return finish(reject, new CancelledError());
        }
        if (key.type === 'up' || (key.type === 'char' && key.value === 'k')) {
          index = (index - 1 + choices.length) % choices.length;
          renderChoices(false);
          continue;
        }
        if (key.type === 'down' || (key.type === 'char' && key.value === 'j')) {
          index = (index + 1) % choices.length;
          renderChoices(false);
          continue;
        }
        if (key.type === 'home') { index = 0; renderChoices(false); continue; }
        if (key.type === 'end')  { index = choices.length - 1; renderChoices(false); continue; }
        if (key.type === 'enter') {
          return finish(resolve, choices[index].value);
        }
        if (key.type === 'char') {
          if ((key.value === 'q' || key.value === 'Q') && quitChoiceIdx >= 0) {
            index = quitChoiceIdx;
            return finish(resolve, choices[quitChoiceIdx].value);
          }
          // Digit jumps the cursor but does NOT auto-submit — a fat-finger
          // on a webhook-firing prompt must never resolve without Enter.
          const n = parseInt(key.value, 10);
          if (!isNaN(n) && n >= 1 && n <= choices.length) {
            index = n - 1;
            renderChoices(false);
            continue;
          }
        }
      }
    };

    const onData = (buf) => reader.feed(buf.toString(), handleKeys);

    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
  });
}

// ---------------------------------------------------------------------------
// input — line input with placeholder
// ---------------------------------------------------------------------------

/**
 * @param {{ message: string, hint?: string, placeholder?: string, initial?: string,
 *           required?: boolean, acceptPlaceholder?: boolean }} args
 * @returns {Promise<string>}
 */
export async function input({
  message,
  hint,
  placeholder = '',
  initial = '',
  required = false,
  acceptPlaceholder = false,
}) {
  ensureTTY();
  installGlobalCleanup();

  let buffer = initial;
  let errorMsg = '';

  const defaultHint = (acceptPlaceholder && placeholder)
    ? 'Type a value · Tab for default · Esc cancel'
    : 'Enter to submit · Esc cancel';
  const hintText = hint ?? defaultHint;

  const prefix = brand('›') + ' ' + bold(message) + ' ' + brandDim('(' + hintText + ')') + ' ';

  let errorLineShown = false;

  const clearErrorLine = () => {
    if (!errorLineShown) return;
    write('\n');
    clearLine();
    write('\x1b[1A');
    errorLineShown = false;
  };

  const render = () => {
    clearErrorLine();
    clearLine();
    if (buffer.length === 0 && placeholder) {
      const styledPlaceholder = '\x1b[2m\x1b[3m' + placeholder + '\x1b[23m\x1b[0m';
      write(prefix + styledPlaceholder);
      if (placeholder.length > 0) write(`\x1b[${placeholder.length}D`);
    } else {
      write(prefix + buffer);
    }
    if (errorMsg) {
      write('\n  ' + dim('⚠ ') + dim(errorMsg));
      write('\x1b[1A');
      write('\r');
      const visible = buffer.length === 0 && placeholder ? 0 : buffer.length;
      write(`\x1b[${visibleLen(prefix) + visible}C`);
      errorLineShown = true;
    }
  };

  return new Promise((resolve, reject) => {
    const reader = createKeyReader();
    const finish = (fn, value) => {
      reader.dispose();
      clearErrorLine();
      stdin.setRawMode(false);
      stdin.removeListener('data', onData);
      stdin.pause();
      write('\n');
      fn(value);
    };

    const handleKeys = (keys) => {
      let dirty = false;

      for (const key of keys) {
        if (key.type === 'ctrl-c' || key.type === 'esc') {
          return finish(reject, new CancelledError());
        }
        if (key.type === 'ctrl-d' && buffer.length === 0) {
          return finish(reject, new CancelledError());
        }
        if (key.type === 'enter') {
          if (required && buffer.trim().length === 0) {
            errorMsg = 'value required — type something, Tab for placeholder, or Esc to cancel';
            dirty = true;
            continue;
          }
          if (buffer.length === 0 && acceptPlaceholder && placeholder) {
            return finish(resolve, placeholder);
          }
          return finish(resolve, buffer);
        }
        if (key.type === 'tab') {
          if (buffer.length === 0 && placeholder) {
            buffer = placeholder;
            errorMsg = '';
            dirty = true;
          }
          continue;
        }
        if (key.type === 'backspace') {
          if (buffer.length > 0) {
            buffer = buffer.slice(0, -1);
            errorMsg = '';
            dirty = true;
          }
          continue;
        }
        if (key.type === 'char') {
          buffer += key.value;
          errorMsg = '';
          dirty = true;
        }
      }

      if (dirty) render();
    };

    const onData = (buf) => reader.feed(buf.toString(), handleKeys);

    stdin.setRawMode(true);
    stdin.resume();
    render();
    stdin.on('data', onData);
  });
}
