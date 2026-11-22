import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { isSafeUrl, MAX_NOTES_LENGTH, sanitizeReleaseNotes } from '../frontend/src/lib/notes.ts';

const clean = sanitizeReleaseNotes;

/** No tag can start anywhere in the output. */
const noMarkup = (text: string) => assert.doesNotMatch(text, /<[a-zA-Z!?/]/);

describe('raw html', () => {
  test('script, style and iframe go with their content', () => {
    assert.equal(clean('a<script>alert(1)</script>b'), 'ab');
    assert.equal(clean('a<SCRIPT type="x">alert(1)</SCRIPT >b'), 'ab');
    assert.equal(clean('a<style>body{display:none}</style>b'), 'ab');
    assert.equal(clean('a<iframe src="https://evil.example"></iframe>b'), 'ab');
    assert.equal(clean('a\n<script>\nalert(1)\n</script>\nb'), 'a\n\nb');
  });

  test('an unclosed script drops the rest', () => {
    assert.equal(clean('safe\n<script>alert(1)\nmore'), 'safe');
  });

  test('event handlers go with their tag', () => {
    assert.equal(clean('x <img src=x onerror=alert(1)> y'), 'x  y');
    assert.equal(clean('<a href="#" onclick="alert(1)">click</a>'), 'click');
    assert.equal(clean('<div onmouseover="alert(1)">text</div>'), 'text');
  });

  test('comments', () => {
    assert.equal(clean('a<!-- hidden -->b'), 'ab');
    assert.equal(clean('a<!--\n<script>alert(1)</script>\n-->b'), 'ab');
    assert.equal(clean('a<!-- never closed'), 'a');
  });

  test('nested tricks', () => {
    for (const input of [
      '<scr<script>ipt>alert(1)</scr</script>ipt>',
      '<scr<script></script>ipt>alert(1)</scr<script></script>ipt>',
      '<<script>script>alert(1)<</script>/script>',
      '<ifr<!-- x -->ame src=javascript:alert(1)>',
      '<<img src=x onerror=alert(1)>img src=x onerror=alert(1)>',
    ]) {
      const out = clean(input);
      noMarkup(out);
      assert.doesNotMatch(out, /<script|<iframe|<img/i, input);
    }
    assert.equal(clean('<scr<script>ipt>alert(1)</script>'), '&lt;scr');
  });

  test('stray angle brackets stay text', () => {
    assert.equal(clean('a < b and c > d'), 'a < b and c > d');
    assert.equal(clean('1 <2'), '1 <2');
  });

  test('autolinks keep their url', () => {
    assert.equal(clean('see <https://github.com/Caloptreyx>'), 'see https://github.com/Caloptreyx');
    assert.equal(clean('<javascript:alert(1)>'), '');
  });
});

describe('links and images', () => {
  test('safe links stay', () => {
    for (const md of [
      '[docs](https://example.com/docs)',
      '[x](http://example.com "title")',
      '[mail](mailto:dev@example.com)',
      '[rel](../CHANGELOG.md)',
      '[anchor](#fixes)',
    ]) {
      assert.equal(clean(md), md);
    }
  });

  test('unsafe links keep only their text', () => {
    assert.equal(clean('[click](javascript:alert(1))'), 'click)');
    assert.equal(clean('[click](JavaScript:alert`1`)'), 'click');
    // not a CommonMark link (unquoted title), still no target left
    assert.equal(clean('[click](  java\tscript:alert)'), '[click]');
    assert.equal(clean('[click](java script:alert "t")'), '[click]');
    assert.equal(clean('[click](javascript&#58;alert)'), 'click');
    assert.equal(clean('[click](javascript&colon;alert)'), 'click');
    assert.equal(clean('[click](java\\script:alert)'), 'click');
    assert.equal(clean('[click](vbscript:msgbox)'), 'click');
    assert.equal(clean('[click](data:text/html;base64,PHNjcmlwdD4=)'), 'click');
    assert.equal(clean('[click](file:///etc/passwd)'), 'click');
    // the angle brackets go as markup, leaving an empty target
    assert.equal(clean('[click](<javascript:alert(1)>)'), '[click]()');
  });

  test('reference definitions with unsafe urls are dropped', () => {
    assert.equal(clean('[x][a]\n\n[a]: javascript:alert(1)'), '[x][a]');
    assert.equal(clean('[x][a]\n\n[a]: https://example.com'), '[x][a]\n\n[a]: https://example.com');
  });

  test('images become links', () => {
    assert.equal(clean('![shot](https://example.com/a.png)'), '[shot](https://example.com/a.png)');
    assert.equal(clean('![](https://example.com/a.png)'), '[image](https://example.com/a.png)');
    assert.equal(clean('![x](data:image/png;base64,AAAA)'), 'x');
    assert.equal(clean('![x](javascript:alert(1))'), 'x)');
  });

  test('isSafeUrl', () => {
    assert.ok(isSafeUrl('https://github.com'));
    assert.ok(isSafeUrl('/relative/path'));
    assert.ok(isSafeUrl('//cdn.example.com/x'));
    assert.ok(!isSafeUrl('javascript:alert(1)'));
    assert.ok(!isSafeUrl(' JAVASCRIPT:alert(1)'));
    assert.ok(!isSafeUrl('jav&#x61;script:alert(1)'));
    assert.ok(!isSafeUrl('data:text/html,x'));
    assert.ok(!isSafeUrl('vbscript:x'));
    assert.ok(!isSafeUrl('file:///etc/passwd'));
  });
});

describe('code and length', () => {
  test('fenced code stays as written', () => {
    const md = 'Text <b>bold</b>\n\n```html\n<script>alert(1)</script>\n```\n\nafter';
    assert.equal(clean(md), 'Text bold\n\n```html\n<script>alert(1)</script>\n```\n\nafter');
  });

  test('inline code stays as written', () => {
    assert.equal(clean('use `Vec<String>` here <i>x</i>'), 'use `Vec<String>` here x');
  });

  test('an escaped backtick does not hide markup', () => {
    noMarkup(clean('\\`<img src=x onerror=alert(1)>\\`'));
  });

  test('long notes are capped', () => {
    const out = clean('a'.repeat(MAX_NOTES_LENGTH + 500));
    assert.ok(out.length <= MAX_NOTES_LENGTH + 3);
    assert.ok(out.endsWith('…'));
  });

  test('windows line endings', () => {
    assert.equal(clean('a\r\nb\rc'), 'a\nb\nc');
  });
});
