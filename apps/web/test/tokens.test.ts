// @vitest-environment node
// Reads tokens.css from disk; no DOM needed.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'vitest';

// WCAG 2.2 AA: 4.5:1 for normal text, 3:1 for meaningful non-text shapes
// (status marks, control borders, focus rings).
const TEXT = 4.5;
const SHAPE = 3;

const css = readFileSync(new URL('../src/styles/tokens.css', import.meta.url), 'utf8');
const declarations = new Map(
  [...css.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map(([, name = '', value = '']) => [
    name,
    value.trim(),
  ]),
);

function resolve(name: string): string {
  const value = declarations.get(name);
  assert.ok(value !== undefined, `${name} is not defined in tokens.css`);
  const reference = /^var\((--[\w-]+)\)$/.exec(value);
  return reference?.[1] !== undefined ? resolve(reference[1]) : value;
}

function luminance(hex: string): number {
  assert.match(hex, /^#[0-9a-f]{6}$/i, `expected a 6-digit hex color, got ${hex}`);
  const [r = 0, g = 0, b = 0] = [1, 3, 5].map((i) => {
    const channel = parseInt(hex.slice(i, i + 2), 16) / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [high, low] = [luminance(resolve(a)), luminance(resolve(b))].sort((x, y) => y - x);
  return ((high ?? 0) + 0.05) / ((low ?? 0) + 0.05);
}

const pairs: [foreground: string, background: string, minimum: number][] = [
  ['--color-text', '--color-bg', TEXT],
  ['--color-text', '--color-surface', TEXT],
  ['--color-text-muted', '--color-bg', TEXT],
  ['--color-text-muted', '--color-surface', TEXT],
  ['--color-status-critical', '--color-bg', TEXT],
  ['--color-status-healthy', '--color-bg', TEXT],
  ['--color-status-info', '--color-bg', TEXT],
  ['--color-text-inverse', '--color-selected', TEXT],
  ['--color-text-inverse', '--color-status-critical', TEXT],
  ['--color-text-inverse', '--color-status-healthy', TEXT],
  ['--color-on-warning', '--color-status-warning', TEXT],
  ['--color-border-control', '--color-bg', SHAPE],
  ['--color-border-control', '--color-surface', SHAPE],
  ['--color-focus', '--color-bg', SHAPE],
  ['--color-focus', '--color-surface', SHAPE],
  ['--color-status-warning-outline', '--color-bg', SHAPE],
  ['--color-status-warning-outline', '--color-surface', SHAPE],
  ['--color-nav-text', '--color-nav-bg', TEXT],
  ['--color-nav-muted', '--color-nav-bg', TEXT],
  ['--color-focus-inverse', '--color-nav-bg', SHAPE],
  ['--color-focus-inverse', '--color-selected', SHAPE],
  ['--color-on-action-primary', '--color-action-primary', TEXT],
];

describe('design token contrast (WCAG AA)', () => {
  for (const [foreground, background, minimum] of pairs) {
    it(`${foreground} on ${background} is at least ${minimum}:1`, () => {
      const ratio = contrast(foreground, background);
      assert.ok(ratio >= minimum, `${ratio.toFixed(2)}:1`);
    });
  }

  it('documents that a bare yellow shape would fail, so the outline is required', () => {
    assert.ok(contrast('--color-status-warning', '--color-bg') < SHAPE);
  });

  it('documents that the blue focus ring fails on ink, so dark areas use the inverse ring', () => {
    assert.ok(contrast('--color-focus', '--color-nav-bg') < SHAPE);
  });
});
