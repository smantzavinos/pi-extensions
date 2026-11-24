/**
 * Threshold flag parsing and resolution.
 *
 * Pure, Pi-runtime-free helpers so the numeric contract can be unit-tested in
 * isolation. The extension owns all parsing and validation: Pi only hands us
 * the raw string flag values. Invalid configuration is reported as an explicit
 * actionable error so the caller can fail closed at the execution gate rather
 * than silently guessing a default.
 *
 * Rules:
 *   - A value is `<number>` (whole safe integer), `<number>k`, `<number>m`, or
 *     `<number>%`. No expressions, signs, exponents, infinities, or trailing
 *     junk. Fractions are allowed only when a suffix makes them resolve to a
 *     whole token count (e.g. `1.5k` = 1500); percentages resolve against the
 *     full window with a single documented rounding rule (round half up).
 *   - Zero is allowed only where `allowZero` is set (the buffer).
 *   - For a window `W`: `0 < soft < warning <= hard <= floor(0.9 * W)`, where
 *     `hard = min(warning + buffer, floor(0.9 * W))`. A `warning` beyond the
 *     cap is invalid, never silently lowered; a capped `hard == warning` is
 *     valid and enforces immediately.
 */

/** Documented example that always produces a valid ordering on any window. */
export const THRESHOLD_GUIDANCE =
  'try percentages of the window, e.g. `--compact-soft-at 20% --compact-at 50% --compact-buffer 10%`';

export type ThresholdUnit = 'tokens' | 'percent';

export interface ParsedThreshold {
  unit: ThresholdUnit;
  /** Token count when `unit === 'tokens'`, percentage points when `'percent'`. */
  value: number;
}

export type ParseResult = { ok: true; parsed: ParsedThreshold } | { ok: false; error: string };

const THRESHOLD_PATTERN = /^(\d+(?:\.\d+)?)(k|m|%)?$/i;

/** Parse a single threshold flag value without resolving it against a window. */
export function parseThreshold(raw: string, options: { allowZero?: boolean } = {}): ParseResult {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { ok: false, error: 'must not be blank' };

  const match = THRESHOLD_PATTERN.exec(trimmed);
  if (!match) {
    return {
      ok: false,
      error: `invalid threshold "${raw}"; use a whole token count or a k/m/% value (e.g. 250k, 0.5m, 50%)`,
    };
  }

  const numberText = match[1] as string;
  const suffix = (match[2] ?? '').toLowerCase();
  const value = Number(numberText);
  if (!Number.isFinite(value)) return { ok: false, error: `invalid threshold "${raw}"` };

  const allowZero = options.allowZero ?? false;
  if (value === 0 && !allowZero) return { ok: false, error: 'must be greater than zero' };

  if (suffix === '%') {
    return { ok: true, parsed: { unit: 'percent', value } };
  }

  if (suffix === '') {
    if (numberText.includes('.')) {
      return { ok: false, error: `token counts must be whole numbers (use k, m, or %): "${raw}"` };
    }
    if (!Number.isSafeInteger(value)) return { ok: false, error: `token count is too large: "${raw}"` };
    return { ok: true, parsed: { unit: 'tokens', value } };
  }

  // k / m suffix: must resolve to a whole, safe token count.
  const multiplier = suffix === 'k' ? 1_000 : 1_000_000;
  const tokens = value * multiplier;
  if (!Number.isInteger(tokens)) {
    return { ok: false, error: `"${raw}" does not resolve to a whole token count` };
  }
  if (!Number.isSafeInteger(tokens)) return { ok: false, error: `token count is too large: "${raw}"` };
  return { ok: true, parsed: { unit: 'tokens', value: tokens } };
}

export type ResolveTokensResult = { ok: true; tokens: number } | { ok: false; error: string };

/** Resolve a parsed threshold to a whole token count for a given window. */
export function resolveTokens(parsed: ParsedThreshold, contextWindow: number): ResolveTokensResult {
  if (parsed.unit === 'tokens') {
    if (!Number.isSafeInteger(parsed.value)) return { ok: false, error: 'token count is too large' };
    return { ok: true, tokens: parsed.value };
  }
  // Percentage of the full window, rounded half up to a whole token count.
  const raw = (parsed.value / 100) * contextWindow;
  const tokens = Math.round(raw);
  if (!Number.isFinite(tokens) || !Number.isSafeInteger(tokens)) {
    return { ok: false, error: 'percentage does not resolve to a whole token count' };
  }
  return { ok: true, tokens };
}

export interface FlagInputs {
  /** Raw `--compact-soft-at` value. */
  softAt: string;
  /** Raw `--compact-at` value. */
  at: string;
  /** Raw `--compact-buffer` value. */
  buffer: string;
  /** Raw `--compact-prompt` value, or undefined when the flag was not supplied. */
  compactPrompt?: string | undefined;
}

export interface ResolvedThresholds {
  contextWindow: number;
  softTokens: number;
  warningTokens: number;
  hardTokens: number;
  /** floor(0.9 * contextWindow). */
  cap: number;
}

export type ConfigResult =
  | { ok: true; thresholds: ResolvedThresholds; compactPromptOverride: string | undefined }
  | { ok: false; error: string };

/** Percentage of the window a token count represents, rounded to a whole number. */
export function tokensToPercent(tokens: number, contextWindow: number): number {
  if (contextWindow <= 0) return 0;
  return Math.round((tokens / contextWindow) * 100);
}

/**
 * Resolve raw flag inputs against a concrete context window. Returns an
 * actionable error (never throws) when the configuration cannot enforce a valid
 * `0 < soft < warning <= hard <= floor(0.9 * W)` ordering, so the caller can
 * fail closed while keeping info/manual controls available.
 */
export function resolveThresholds(inputs: FlagInputs, contextWindow: number): ConfigResult {
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) {
    return { ok: false, error: `self-compact: unknown or invalid model context window (${contextWindow})` };
  }

  // A supplied summary override must be a real literal; blank is invalid rather
  // than a silent fall-through to the default file.
  let compactPromptOverride: string | undefined;
  if (inputs.compactPrompt !== undefined) {
    if (inputs.compactPrompt.trim().length === 0) {
      return { ok: false, error: 'self-compact: --compact-prompt must not be blank' };
    }
    compactPromptOverride = inputs.compactPrompt;
  }

  const soft = parseThreshold(inputs.softAt);
  if (!soft.ok) return { ok: false, error: `self-compact: --compact-soft-at ${soft.error}` };
  const warning = parseThreshold(inputs.at);
  if (!warning.ok) return { ok: false, error: `self-compact: --compact-at ${warning.error}` };
  const buffer = parseThreshold(inputs.buffer, { allowZero: true });
  if (!buffer.ok) return { ok: false, error: `self-compact: --compact-buffer ${buffer.error}` };

  const softTokens = resolveTokens(soft.parsed, contextWindow);
  if (!softTokens.ok) return { ok: false, error: `self-compact: --compact-soft-at ${softTokens.error}` };
  const warningTokens = resolveTokens(warning.parsed, contextWindow);
  if (!warningTokens.ok) return { ok: false, error: `self-compact: --compact-at ${warningTokens.error}` };
  const bufferTokens = resolveTokens(buffer.parsed, contextWindow);
  if (!bufferTokens.ok) return { ok: false, error: `self-compact: --compact-buffer ${bufferTokens.error}` };

  const cap = Math.floor(0.9 * contextWindow);
  const sum = warningTokens.tokens + bufferTokens.tokens;
  if (!Number.isSafeInteger(sum)) {
    return { ok: false, error: 'self-compact: --compact-at plus --compact-buffer overflows' };
  }
  const hardTokens = Math.min(sum, cap);

  const s = softTokens.tokens;
  const w = warningTokens.tokens;
  const h = hardTokens;
  if (!(s > 0 && s < w && w <= h && h <= cap)) {
    return {
      ok: false,
      error:
        `self-compact: thresholds do not fit a ${contextWindow}-token window ` +
        `(soft=${s}, warning=${w}, hard=${h}, max=${cap}); require 0 < soft < warning <= hard <= ${cap}. ` +
        THRESHOLD_GUIDANCE,
    };
  }

  return {
    ok: true,
    thresholds: { contextWindow, softTokens: s, warningTokens: w, hardTokens: h, cap },
    compactPromptOverride,
  };
}

export const FLAG_SOFT_AT = 'compact-soft-at';
export const FLAG_AT = 'compact-at';
export const FLAG_BUFFER = 'compact-buffer';
export const FLAG_PROMPT = 'compact-prompt';

export const DEFAULT_SOFT_AT = '225k';
export const DEFAULT_AT = '250k';
export const DEFAULT_BUFFER = '20k';

/**
 * Window-relative defaults used for any threshold flag the user did not supply
 * when the token defaults cannot fit the model window (e.g. a 200k model).
 * Valid on every window: soft 60% < warning 70% <= hard 80% <= 90% cap.
 */
export const FALLBACK_SOFT_AT = '60%';
export const FALLBACK_AT = '70%';
export const FALLBACK_BUFFER = '10%';

/** Branch-local session overrides for threshold values (`undefined` = inherit startup flag/default). */
export interface ThresholdOverrides {
  softAt?: string | undefined;
  at?: string | undefined;
  buffer?: string | undefined;
}

export type ThresholdCommandAction =
  | { kind: 'show' }
  | { kind: 'reset' }
  | { kind: 'set'; updates: ThresholdOverrides };

export type ThresholdCommandParseResult = { ok: true; action: ThresholdCommandAction } | { ok: false; error: string };

const THRESHOLD_COMMAND_USAGE =
  'usage: /self-compact-thresholds [soft=<val>] [at=<val>] [buffer=<val>] | reset (e.g. soft=55% at=65% buffer=10%)';

const KEY_ALIASES: Readonly<Record<string, keyof ThresholdOverrides>> = {
  soft: 'softAt',
  'soft-at': 'softAt',
  'compact-soft-at': 'softAt',
  at: 'at',
  warning: 'at',
  'compact-at': 'at',
  buffer: 'buffer',
  'compact-buffer': 'buffer',
};

/**
 * Parse `/self-compact-thresholds` arguments.
 *
 * Accepts:
 *   - blank -> show current thresholds
 *   - `reset` -> clear session overrides back to startup flags/defaults
 *   - one or more `key=value` tokens (`soft`, `at`/`warning`, `buffer`, or
 *     their `compact-*` equivalents). Each key may appear at most once.
 */
export function parseThresholdsCommandArgs(rawArgs: string): ThresholdCommandParseResult {
  const trimmed = rawArgs.trim();
  if (trimmed.length === 0) return { ok: true, action: { kind: 'show' } };

  const tokens = trimmed.split(/\s+/);
  if (tokens.length === 1 && tokens[0]?.toLowerCase() === 'reset') {
    return { ok: true, action: { kind: 'reset' } };
  }

  const updates: ThresholdOverrides = {};
  for (const token of tokens) {
    if (token.toLowerCase() === 'reset') {
      return {
        ok: false,
        error: `self-compact: "reset" cannot be combined with threshold assignments; ${THRESHOLD_COMMAND_USAGE}`,
      };
    }
    const eq = token.indexOf('=');
    if (eq <= 0) {
      return { ok: false, error: `self-compact: invalid argument "${token}"; ${THRESHOLD_COMMAND_USAGE}` };
    }
    const rawKey = token.slice(0, eq).replace(/^--/, '').toLowerCase();
    const rawValue = token.slice(eq + 1);
    const field = KEY_ALIASES[rawKey];
    if (!field) {
      return {
        ok: false,
        error: `self-compact: unknown threshold key "${token.slice(0, eq)}"; expected soft, at, or buffer. ${THRESHOLD_COMMAND_USAGE}`,
      };
    }
    if (updates[field] !== undefined) {
      return { ok: false, error: `self-compact: duplicate key "${rawKey}"; ${THRESHOLD_COMMAND_USAGE}` };
    }
    const parsed = parseThreshold(rawValue, { allowZero: field === 'buffer' });
    if (!parsed.ok) {
      return { ok: false, error: `self-compact: ${rawKey} ${parsed.error}` };
    }
    updates[field] = rawValue.trim();
  }

  return { ok: true, action: { kind: 'set', updates } };
}

/** Raw flag values; `undefined` means the flag was not supplied. */
export interface RawFlagInputs {
  softAt: string | undefined;
  at: string | undefined;
  buffer: string | undefined;
  compactPrompt?: string | undefined;
}

/**
 * Determine the effective raw threshold strings (`softAt`, `at`, `buffer`) that
 * `resolveThresholdsWithDefaults` selects for a given window.
 *
 * When unsupplied flags fall back to the window-relative percentages
 * (`60%`/`70%`/`10%`), those fallback strings are returned for the unsupplied
 * fields; explicitly supplied values are always preserved verbatim.
 */
export function effectiveRawThresholds(
  inputs: RawFlagInputs,
  contextWindow: number,
): { softAt: string; at: string; buffer: string; usedFallback: boolean } {
  const fill = (soft: string, at: string, buffer: string): FlagInputs => ({
    softAt: inputs.softAt ?? soft,
    at: inputs.at ?? at,
    buffer: inputs.buffer ?? buffer,
    compactPrompt: inputs.compactPrompt,
  });
  const primaryInputs = fill(DEFAULT_SOFT_AT, DEFAULT_AT, DEFAULT_BUFFER);
  const primary = resolveThresholds(primaryInputs, contextWindow);
  if (primary.ok) {
    return { softAt: primaryInputs.softAt, at: primaryInputs.at, buffer: primaryInputs.buffer, usedFallback: false };
  }
  if (inputs.softAt !== undefined && inputs.at !== undefined && inputs.buffer !== undefined) {
    return { softAt: primaryInputs.softAt, at: primaryInputs.at, buffer: primaryInputs.buffer, usedFallback: false };
  }
  const fallbackInputs = fill(FALLBACK_SOFT_AT, FALLBACK_AT, FALLBACK_BUFFER);
  const fallback = resolveThresholds(fallbackInputs, contextWindow);
  if (fallback.ok) {
    return { softAt: fallbackInputs.softAt, at: fallbackInputs.at, buffer: fallbackInputs.buffer, usedFallback: true };
  }
  return { softAt: primaryInputs.softAt, at: primaryInputs.at, buffer: primaryInputs.buffer, usedFallback: false };
}

/**
 * Resolve flags, filling unsupplied thresholds with the token defaults. If those
 * do not fit the window, retry the unsupplied thresholds with the
 * window-relative fallback so a no-flag install never fails closed. Explicitly
 * supplied values are never replaced; if they still cannot fit, the original
 * error is returned so the caller fails closed.
 */
export function resolveThresholdsWithDefaults(inputs: RawFlagInputs, contextWindow: number): ConfigResult {
  const fill = (soft: string, at: string, buffer: string): FlagInputs => ({
    softAt: inputs.softAt ?? soft,
    at: inputs.at ?? at,
    buffer: inputs.buffer ?? buffer,
    compactPrompt: inputs.compactPrompt,
  });
  const primary = resolveThresholds(fill(DEFAULT_SOFT_AT, DEFAULT_AT, DEFAULT_BUFFER), contextWindow);
  if (primary.ok) return primary;
  if (inputs.softAt !== undefined && inputs.at !== undefined && inputs.buffer !== undefined) return primary;
  const fallback = resolveThresholds(fill(FALLBACK_SOFT_AT, FALLBACK_AT, FALLBACK_BUFFER), contextWindow);
  return fallback.ok ? fallback : primary;
}

export const DEFAULT_DELTA_PERCENT = '10%';
export const DEFAULT_DELTA_TOKENS = '50k';

export type ThresholdDeltaParseResult = { ok: true; delta: ParsedThreshold | undefined } | { ok: false; error: string };

/**
 * Parse the optional single delta argument for
 * `/self-compact-thresholds-increase` and `/self-compact-thresholds-decrease`.
 *
 * Accepts blank (use default) or a single positive token/percentage value
 * (e.g. `10%`, `50k`, `50000`, `0.1m`).
 */
export function parseThresholdDeltaArgs(rawArgs: string, commandName: string): ThresholdDeltaParseResult {
  const trimmed = rawArgs.trim();
  if (trimmed.length === 0) return { ok: true, delta: undefined };

  const tokens = trimmed.split(/\s+/);
  if (tokens.length > 1) {
    return {
      ok: false,
      error: `self-compact: /${commandName} takes at most one argument (e.g. /${commandName} 10% or /${commandName} 50k)`,
    };
  }
  const parsed = parseThreshold(tokens[0] as string);
  if (!parsed.ok) {
    return {
      ok: false,
      error: `self-compact: /${commandName} ${parsed.error}`,
    };
  }
  return { ok: true, delta: parsed.parsed };
}

function formatPercentValue(value: number): string {
  // Trim floating-point noise (e.g. 55.1 + 10 = 65.10000000000001) while keeping
  // exact decimal precision up to 6 places.
  const rounded = Number(value.toFixed(6));
  return `${rounded}%`;
}

function formatTokenValue(tokens: number): string {
  if (tokens % 1_000_000 === 0) return `${tokens / 1_000_000}m`;
  if (tokens % 1_000 === 0) return `${tokens / 1_000}k`;
  return String(tokens);
}

function shiftSingleThreshold(
  current: ParsedThreshold,
  delta: ParsedThreshold,
  sign: 1 | -1,
  contextWindow: number,
  label: string,
): { ok: true; raw: string } | { ok: false; error: string } {
  if (current.unit === 'percent' && delta.unit === 'percent') {
    const next = Number((current.value + sign * delta.value).toFixed(6));
    if (!Number.isFinite(next) || next <= 0) {
      return {
        ok: false,
        error: `self-compact: ${label} would become ${next}%, which must be greater than zero`,
      };
    }
    return { ok: true, raw: formatPercentValue(next) };
  }

  const currentTokens = resolveTokens(current, contextWindow);
  if (!currentTokens.ok) return { ok: false, error: `self-compact: ${label} ${currentTokens.error}` };
  const deltaTokens = resolveTokens(delta, contextWindow);
  if (!deltaTokens.ok) return { ok: false, error: `self-compact: delta ${deltaTokens.error}` };

  const nextTokens = currentTokens.tokens + sign * deltaTokens.tokens;
  if (!Number.isSafeInteger(nextTokens) || nextTokens <= 0) {
    return {
      ok: false,
      error: `self-compact: ${label} would become ${nextTokens} tokens, which must be greater than zero`,
    };
  }
  return { ok: true, raw: formatTokenValue(nextTokens) };
}

export type AdjustThresholdsResult =
  | { ok: true; softAt: string; at: string; buffer?: string | undefined; deltaApplied: string }
  | { ok: false; error: string };

/**
 * Shift both `soft` and `at` by a positive delta in `direction` (`increase` or
 * `decrease`), leaving `buffer` untouched.
 *
 * Default delta when `delta` is undefined:
 *   - `10%` when both current `soft` and `at` are percentage-based
 *   - `50k` otherwise (token-based)
 *
 * Unit preservation:
 *   - If a threshold and the delta are both percentages, shifts in percentage
 *     points so the threshold stays window-relative across model switches.
 *   - Otherwise, resolves both to tokens for `contextWindow` and stores the
 *     resulting whole token count.
 */
export function adjustThresholds(
  inputs: RawFlagInputs,
  contextWindow: number,
  direction: 'increase' | 'decrease',
  delta?: ParsedThreshold,
): AdjustThresholdsResult {
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) {
    return { ok: false, error: `self-compact: unknown or invalid model context window (${contextWindow})` };
  }

  const current = effectiveRawThresholds(inputs, contextWindow);
  const softParsed = parseThreshold(current.softAt);
  if (!softParsed.ok) {
    return { ok: false, error: `self-compact: current soft threshold is invalid (${softParsed.error})` };
  }
  const atParsed = parseThreshold(current.at);
  if (!atParsed.ok) {
    return { ok: false, error: `self-compact: current warning threshold is invalid (${atParsed.error})` };
  }

  const bothPercent = softParsed.parsed.unit === 'percent' && atParsed.parsed.unit === 'percent';
  const defaultRaw = bothPercent ? DEFAULT_DELTA_PERCENT : DEFAULT_DELTA_TOKENS;
  const effectiveDelta: ParsedThreshold =
    delta ?? (bothPercent ? { unit: 'percent', value: 10 } : { unit: 'tokens', value: 50_000 });
  const deltaLabel =
    delta === undefined
      ? defaultRaw
      : delta.unit === 'percent'
        ? formatPercentValue(delta.value)
        : formatTokenValue(delta.value);

  const sign: 1 | -1 = direction === 'increase' ? 1 : -1;
  const nextSoft = shiftSingleThreshold(softParsed.parsed, effectiveDelta, sign, contextWindow, 'soft');
  if (!nextSoft.ok) return nextSoft;
  const nextAt = shiftSingleThreshold(atParsed.parsed, effectiveDelta, sign, contextWindow, 'warning');
  if (!nextAt.ok) return nextAt;

  // If the current window was using the window-relative fallback buffer (10%)
  // because buffer was unsupplied, preserve it so shifting soft/at does not
  // silently flip buffer back to the 20k token default.
  const preservedBuffer = inputs.buffer === undefined && current.usedFallback ? current.buffer : undefined;

  return {
    ok: true,
    softAt: nextSoft.raw,
    at: nextAt.raw,
    ...(preservedBuffer !== undefined ? { buffer: preservedBuffer } : {}),
    deltaApplied: deltaLabel,
  };
}
