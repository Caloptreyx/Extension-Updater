import type { ExtraProps } from 'react-markdown';

type Element = NonNullable<ExtraProps['node']>;

const alerts = {
  NOTE: ['Note', 'border-blue-500'],
  TIP: ['Tip', 'border-green-500'],
  IMPORTANT: ['Important', 'border-violet-500'],
  WARNING: ['Warning', 'border-yellow-500'],
  CAUTION: ['Caution', 'border-red-500'],
} as const;

// Run after sanitization: only fixed labels and classes are added to the safe tree.
export function releaseNoteAlerts() {
  return (tree: { children: Array<Element['children'][number] | { type: 'doctype' }> }) => {
    for (const quote of tree.children) {
      if (quote.type !== 'element' || quote.tagName !== 'blockquote') continue;
      const paragraph = quote.children.find((child) => child.type !== 'text' || child.value.trim());
      if (paragraph?.type !== 'element' || paragraph.tagName !== 'p') continue;
      const first = paragraph.children[0];
      if (first?.type !== 'text') continue;

      const match = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*(?:\n|$)/.exec(first.value);
      if (!match) continue;
      const remainder = first.value.slice(match[0].length);
      const next = paragraph.children[1];
      const hardBreak = !remainder && next?.type === 'element' && next.tagName === 'br';
      if (!match[0].endsWith('\n') && next && !hardBreak) continue;
      const [label, color] = alerts[match[1] as keyof typeof alerts];

      if (remainder) first.value = remainder;
      else paragraph.children.splice(0, hardBreak ? 2 : 1);
      if (!paragraph.children.length) quote.children.splice(quote.children.indexOf(paragraph), 1);

      quote.tagName = 'div';
      quote.properties = { className: ['my-3 border-s-4 ps-3', color] };
      quote.children.unshift({
        type: 'element',
        tagName: 'div',
        properties: { className: ['mb-1 font-semibold'] },
        children: [{ type: 'text', value: label }],
      });
    }
  };
}
