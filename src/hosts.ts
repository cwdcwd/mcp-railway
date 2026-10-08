/**
 * Host/Origin allow-list matching. A pattern's `*` matches any run of
 * non-separator characters, so `localhost:*` admits any port but not
 * `localhost:80.evil.com`.
 */

const toRegExp = (pattern: string) =>
  new RegExp(
    '^' + pattern.split('*').map(p => p.replace(/[.+?^${}()|[\]\\/]/g, '\\$&')).join('[^./:@]*') + '$',
    'i',
  )

export const matchesAny = (value: string, patterns: string[]) =>
  patterns.some(p => toRegExp(p).test(value))
