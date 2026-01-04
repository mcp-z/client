export function normalizeUrl(input: string): string {
  try {
    const url = new URL(input);
    url.search = '';
    url.hash = '';
    url.pathname = url.pathname.replace(/\/+$/, '');
    return url.origin + url.pathname;
  } catch {
    return input.replace(/\/+$/, '');
  }
}

export function joinWellKnown(baseUrl: string, suffix: string): string {
  return `${normalizeUrl(baseUrl)}${suffix}`;
}
