// Release notes are untrusted GitHub markdown. They are rendered without raw HTML and through
// rehype-sanitize; this pass also removes markup and unsafe links from the text itself, so
// nothing depends on a single layer.

export const MAX_NOTES_LENGTH = 20_000;

/** Elements whose content is dropped along with the tags. */
const BLOCK_TAGS = 'script|style|iframe|object|embed|noscript|template|textarea|xmp|title|svg|math|noembed|noframes';
const BLOCK = new RegExp(`<(${BLOCK_TAGS})\\b[\\s\\S]*?<\\/\\1\\s*>`, 'gi');
const UNCLOSED_BLOCK = new RegExp(`<(?:${BLOCK_TAGS})\\b[\\s\\S]*$`, 'i');
const COMMENT = /<!--[\s\S]*?(?:-->|$)/g;
const TAG = /<\/?[a-zA-Z][^>]*>|<[!?][^>]*>/g;
const AUTOLINK = /<((?:https?:\/\/|mailto:)[^\s<>]+)>/gi;
const TAG_START = /<(?=[a-zA-Z!?/])/g;
const IMAGE = /!\[((?:[^[\]]|\[[^[\]]*\])*)\]/g;
const LINK =
  /\[((?:[^[\]]|\[[^[\]]*\])*)\]\(\s*(<[^>\n]*>|[^\s)]*)(?:\s+(?:"[^"\n]*"|'[^'\n]*'|\([^)\n]*\)))?\s*\)/g;
const DEFINITION = /^ {0,3}\[[^\]\n]+\]:[ \t]*(<[^>\n]*>|\S+).*$/gm;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const INLINE_CODE = /(?<![`\\])(`+)(?!`)[^\n]*?(?<!`)\1(?!`)/g;
const PLACEHOLDER = /\u0000(\d+)\u0000/g;

const NAMED_ENTITIES: Record<string, string> = {
  colon: ':',
  tab: '\t',
  newline: '\n',
  sol: '/',
  lpar: '(',
  rpar: ')',
  period: '.',
  amp: '&',
};

/** Whether a markdown link target may be rendered: http(s), mailto or a relative URL. */
export function isSafeUrl(raw: string): boolean {
  const url = raw
    .replace(/^<|>$/g, '')
    .replace(/&#x([0-9a-f]+);?/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16) % 0x110000))
    .replace(/&#(\d+);?/g, (_, dec: string) => String.fromCodePoint(Number.parseInt(dec, 10) % 0x110000))
    .replace(/&([a-z]+);/gi, (entity, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? entity)
    .replace(/\\/g, '')
    // browsers drop whitespace and control characters inside a scheme
    .replace(/[\u0000-\u0020\u007f-\u009f\u00ad\u200b-\u200f\u2028\u2029\ufeff]/g, '')
    .toLowerCase();

  const scheme = /^([a-z][a-z0-9+.-]*):/.exec(url)?.[1];
  return scheme === undefined || scheme === 'http' || scheme === 'https' || scheme === 'mailto';
}

/** Drops raw HTML from prose; inline code spans stay as written. */
function stripHtml(text: string): string {
  const spans: string[] = [];
  let out = text.replace(INLINE_CODE, (span) => `\u0000${spans.push(span) - 1}\u0000`);
  for (let previous = ''; previous !== out; ) {
    previous = out;
    out = out
      .replace(COMMENT, '')
      .replace(BLOCK, '')
      .replace(UNCLOSED_BLOCK, '')
      .replace(AUTOLINK, '$1')
      .replace(TAG, '');
  }
  return out.replace(TAG_START, '&lt;').replace(PLACEHOLDER, (_, index: string) => spans[Number(index)] ?? '');
}

/** Turns images into links and removes links to unsafe URLs. */
function stripUnsafeLinks(text: string): string {
  return text
    .replace(IMAGE, (_, alt: string) => `[${alt.trim() || 'image'}]`)
    .replace(LINK, (link, label: string, url: string) => (isSafeUrl(url) ? link : label))
    .replace(DEFINITION, (line, url: string) => (isSafeUrl(url) ? line : ''));
}

/**
 * Makes GitHub release notes safe to render as markdown: drops raw HTML (and the content of
 * script-like elements) and comments, turns images into links, removes links to anything but
 * http(s), mailto and relative URLs, and caps the length. Fenced code blocks stay as written;
 * the renderer shows them as text.
 */
export function sanitizeReleaseNotes(md: string): string {
  let input = md.replace(/\r\n?/g, '\n').replace(/\u0000/g, '');
  const truncated = input.length > MAX_NOTES_LENGTH;
  if (truncated) input = input.slice(0, MAX_NOTES_LENGTH);

  const parts: string[] = [];
  let prose: string[] = [];
  let fence: string | null = null;
  const flush = () => {
    if (prose.length > 0) parts.push(stripUnsafeLinks(stripHtml(prose.join('\n'))));
    prose = [];
  };

  for (const line of input.split('\n')) {
    const marker = FENCE.exec(line)?.[1];
    if (fence !== null) {
      parts.push(line);
      if (marker && marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker) fence = null;
    } else if (marker) {
      flush();
      fence = marker;
      parts.push(line);
    } else {
      prose.push(line);
    }
  }
  flush();

  const out = parts.join('\n').trim();
  return truncated ? `${out}\n\n…` : out;
}
