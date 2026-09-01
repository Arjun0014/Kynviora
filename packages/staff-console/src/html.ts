/**
 * HTML, built as strings, escaped by construction.
 *
 * Spec references: `14` (no content sniffing, strict transport, nothing sensitive in a log; a
 * console is staff software and its attack surface should be small), `13` (reviewer console
 * backend controls), `DEV-016`.
 *
 * WHY STRINGS AND NOT A FRAMEWORK
 * The console renders a queue, a request and a snapshot, and submits three forms. A client-side
 * framework would add a build step, a dependency tree to audit and a bundle to serve, to a
 * surface whose entire security argument is that it is small and separately deployed. `14`'s
 * supply-chain section asks for dependency scanning; the cheapest dependency to scan is the one
 * that is not there. Server-rendered HTML with no script also means a compromised dependency has
 * nowhere to run.
 *
 * WHY THERE IS NO `raw()` ESCAPE HATCH
 * Every value that reaches a page goes through {@link escapeHtml}. A helper that let a caller opt
 * out would be used the first time somebody wanted a bold word, and after that the audit question
 * stops being "is this escaped" and becomes "which of these is escaped". Structure is expressed by
 * the element helpers below, which are the only things that emit a tag.
 */

/**
 * Escape text for HTML.
 *
 * Escapes the five characters that matter in both element and attribute contexts, so one function
 * covers both and there is no second one to pick wrongly. Ampersand goes first; escaping it after
 * the others would double-escape their output.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** An attribute name that may appear on an element this console emits. */
const SAFE_ATTRIBUTES: readonly string[] = Object.freeze([
  'class',
  'href',
  'method',
  'action',
  'type',
  'name',
  'value',
  'id',
  'for',
  'lang',
  'charset',
  'content',
  'rel',
  'colspan',
  'scope',
  'checked',
  'required',
  'rows',
  'cols',
  'maxlength',
  'aria-label',
  'aria-describedby',
  'aria-live',
]);

export class UnsafeMarkup extends Error {}

export type Attributes = Readonly<Record<string, string | number | boolean | undefined>>;

/**
 * Serialise attributes, refusing any name not on the list above.
 *
 * An allowlist rather than a denylist. The names that matter are `onclick`, `onerror`, `srcdoc`
 * and every future one; a denylist has to be updated when HTML gains an attribute and an
 * allowlist does not.
 */
function attributesToString(attributes: Attributes): string {
  const parts: string[] = [];
  for (const [name, value] of Object.entries(attributes)) {
    if (value === undefined || value === false) continue;
    if (!SAFE_ATTRIBUTES.includes(name)) {
      throw new UnsafeMarkup(
        `Refusing the attribute ${JSON.stringify(name)}. The console emits an allowlist of ` +
          'attributes so that an event handler cannot be introduced by a value.',
      );
    }
    // A boolean attribute is present or absent, never `="true"`.
    if (value === true) {
      parts.push(` ${name}`);
      continue;
    }
    parts.push(` ${name}="${escapeHtml(String(value))}"`);
  }
  return parts.join('');
}

const VOID_ELEMENTS: readonly string[] = Object.freeze(['input', 'meta', 'br', 'hr']);

/**
 * One element.
 *
 * `children` are already-serialised markup from these same helpers; `text` is escaped. Both are
 * accepted because a paragraph of text and a list of rows are different shapes, and forcing text
 * through a child helper made every call site noisier without making anything safer.
 */
export function el(
  tag: string,
  attributes: Attributes = {},
  children: readonly string[] = [],
): string {
  if (!/^[a-z][a-z0-9]*$/.test(tag)) {
    throw new UnsafeMarkup(
      `Refusing a tag name that is not a plain element: ${JSON.stringify(tag)}.`,
    );
  }
  const open = `<${tag}${attributesToString(attributes)}>`;
  if (VOID_ELEMENTS.includes(tag)) return open;
  return `${open}${children.join('')}</${tag}>`;
}

/** An element whose only content is escaped text. */
export function text(tag: string, value: string, attributes: Attributes = {}): string {
  return el(tag, attributes, [escapeHtml(value)]);
}

/** Escaped text with no element around it. */
export function plain(value: string): string {
  return escapeHtml(value);
}

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

/**
 * The console's stylesheet.
 *
 * Inline, because an external stylesheet is a second request to secure and a second file to serve
 * from a process whose whole job is three pages. No colour carries meaning on its own: `18` is a
 * household accessibility rule and applying it here costs nothing, and a reviewer working through
 * ten checklist items on a bad monitor is exactly the reader it was written for.
 */
const STYLE = `
:root { color-scheme: light dark; }
body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; line-height: 1.5;
       margin: 0; padding: 0 1rem 4rem; max-width: 60rem; }
header { padding: 1rem 0; border-bottom: 1px solid currentColor; margin-bottom: 1.5rem; }
header nav a { margin-right: 1rem; }
h1 { font-size: 1.5rem; margin: 0 0 .25rem; }
h2 { font-size: 1.2rem; margin: 2rem 0 .5rem; }
h3 { font-size: 1rem; margin: 1.25rem 0 .25rem; }
.warning { border: 2px solid currentColor; padding: .75rem 1rem; margin: 0 0 1rem; }
.warning p { margin: .25rem 0; }
.row { border: 1px solid currentColor; padding: .75rem 1rem; margin-bottom: 1rem; }
.meta { font-size: .9rem; }
.tally li { list-style: none; }
.tally li::before { content: "\\2014\\00a0"; }
table { border-collapse: collapse; width: 100%; }
th, td { text-align: left; padding: .35rem .5rem; border-bottom: 1px solid currentColor;
         vertical-align: top; }
label { display: block; margin: .35rem 0; }
fieldset { margin: 1rem 0; }
button { font: inherit; padding: .5rem 1rem; }
code { font-size: .9em; word-break: break-all; }
`;

export interface PageOptions {
  readonly title: string;
  /** Standing warnings. Rendered first, always, and never collapsible. */
  readonly warnings: readonly string[];
  /** Which navigation entry is the current page, if any. */
  readonly current?: 'queue' | 'operations';
  /** Who the console believes it is acting as, or `null` when signed out. */
  readonly userId: string | null;
}

/**
 * Wrap a body in the console shell.
 *
 * The warnings come before the content on every page rather than behind a control. They say that
 * nothing here can publish anything and that this session is not strongly authenticated; a
 * console that let a reviewer dismiss them would be one where the dismissal happens on day one.
 */
export function page(options: PageOptions, body: readonly string[]): string {
  const nav = el('nav', {}, [
    el('a', { href: '/queue' }, [plain(options.current === 'queue' ? 'Queue (here)' : 'Queue')]),
    el('a', { href: '/operations' }, [
      plain(options.current === 'operations' ? 'Operations (here)' : 'Operations'),
    ]),
  ]);

  const identity =
    options.userId === null
      ? text('p', 'Not signed in.', { class: 'meta' })
      : el('p', { class: 'meta' }, [
          plain('Acting as '),
          text('code', options.userId),
          plain('. Roles are held in the database, not in this session.'),
        ]);

  const warnings =
    options.warnings.length === 0
      ? ''
      : el('div', { class: 'warning', 'aria-label': 'Standing limitations' }, [
          text('h2', 'What this console cannot do'),
          ...options.warnings.map((warning) => text('p', warning)),
        ]);

  return [
    '<!doctype html>',
    el('html', { lang: 'en' }, [
      el('head', {}, [
        el('meta', { charset: 'utf-8' }),
        el('meta', { name: 'viewport', content: 'width=device-width, initial-scale=1' }),
        // No external anything. The CSP the server sends says the same; this is the page not
        // needing the exception in the first place.
        text('title', `${options.title} - Kynviora reviewer console`),
        el('style', {}, [STYLE]),
      ]),
      el('body', {}, [
        el('header', {}, [text('h1', 'Kynviora reviewer console'), nav, identity]),
        el('main', {}, [warnings, ...body]),
      ]),
    ]),
  ].join('');
}
