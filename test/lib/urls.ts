// Tails that reached cmd or PowerShell as live syntax in the probe runs, appended to a sign-in-shaped URL.
export const TAILS: { name: string; tail: string }[] = [
  { name: '&marker', tail: '&marker' },
  { name: '&marker,a;b', tail: '&marker,a;b' },
  { name: '|marker', tail: '|marker' },
  { name: '|marker,a;b', tail: '|marker,a;b' },
  { name: '%MARKER_VAR%', tail: '%MARKER_VAR%' },
  { name: '^b', tail: '^b' },
  { name: '$(marker)', tail: '$(marker)' },
  { name: '`$x', tail: '`$x' },
  { name: '(b)', tail: '(b)' },
  { name: 'realistic sign-in query', tail: '&client_id=abc&redirect_uri=http%3A%2F%2F127.0.0.1%3A3000%2Fcb&response_type=code&scope=a+b' },
];

export function buildUrl(scheme: string, tag: string, tail: string): string {
  return new URL(`${scheme}://probe.example/${tag}?a=1${tail}`).toString();
}
