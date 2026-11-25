import assert from 'node:assert/strict';
import { test } from 'node:test';
import { releaseNoteAlerts } from '../frontend/src/lib/alerts.ts';

const text = (value: string) => ({ type: 'text' as const, value });
type Child = ReturnType<typeof text> | Element;
type Element = { type: 'element'; tagName: string; properties: object; children: Child[] };
const element = (tagName: string, ...children: Child[]): Element => ({
  type: 'element' as const,
  tagName,
  properties: {},
  children,
});

test('GitHub alerts keep formatted content and replace the marker with a label', () => {
  for (const label of ['Note', 'Tip', 'Important', 'Warning', 'Caution']) {
    const emphasis = element('strong', text('Upgrade first'));
    const quote = element('blockquote', text('\n'), element('p', text(`[!${label.toUpperCase()}]\n`), emphasis));
    releaseNoteAlerts()({ children: [quote] });
    assert.equal(quote.tagName, 'div');
    const [heading, , body] = quote.children;
    assert.equal(heading.type, 'element');
    assert.deepEqual(heading.children, [text(label)]);
    assert.equal(body.type, 'element');
    assert.ok(body.children.includes(emphasis));
  }
});

test('ordinary quotes, unknown markers, inline markers and code stay unchanged', () => {
  const tree = {
    children: [
      element('blockquote', element('p', text('A quote'))),
      element('blockquote', element('p', text('[!UNKNOWN]\nA quote'))),
      element('blockquote', element('p', text('[!NOTE] Inline marker'))),
      element('blockquote', element('pre', element('code', text('[!WARNING]\nExample')))),
    ],
  };
  const original = structuredClone(tree);
  releaseNoteAlerts()(tree);
  assert.deepEqual(tree, original);
});
