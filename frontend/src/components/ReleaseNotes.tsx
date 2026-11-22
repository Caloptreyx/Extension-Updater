import { Typography } from '@mantine/core';
import { useMemo } from 'react';
import Markdown, { type Components } from 'react-markdown';
import rehypeSanitize from 'rehype-sanitize';
import remarkGfm from 'remark-gfm';
import Anchor from '@/elements/typography/Anchor.tsx';
import { markdownComponents } from '@/providers/TranslationProvider.tsx';
import { isSafeUrl, sanitizeReleaseNotes } from '../lib/notes.ts';

// No rehype-raw: raw HTML in the notes is never rendered. The text is sanitized first and the
// tree again by rehype-sanitize; links open in a new tab without access to this page.
const components: Components = {
  ...markdownComponents,
  // the panel's translation markdown renders paragraphs inline; release notes need real ones
  p: ({ children }) => <p>{children}</p>,
  a: ({ href, children }) =>
    href && isSafeUrl(href) ? (
      <Anchor href={href} target='_blank' rel='noopener noreferrer' inherit>
        {children}
      </Anchor>
    ) : (
      <span>{children}</span>
    ),
  img: ({ src, alt }) =>
    typeof src === 'string' && isSafeUrl(src) ? (
      <Anchor href={src} target='_blank' rel='noopener noreferrer' inherit>
        {alt || src}
      </Anchor>
    ) : (
      <span>{alt}</span>
    ),
};

export default function ReleaseNotes({ body }: { body: string }) {
  const text = useMemo(() => sanitizeReleaseNotes(body), [body]);

  return (
    <Typography className='min-w-0 break-words text-sm leading-relaxed [&_ol]:list-decimal [&_ol]:pl-6 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0 [&_ul]:list-disc [&_ul]:pl-6'>
      <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]} components={components}>
        {text}
      </Markdown>
    </Typography>
  );
}
