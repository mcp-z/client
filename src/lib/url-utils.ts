export function normalizeUrl(input: string): string {
  try {
    const url = new URL(input);
    url.search = '';
    url.hash = '';
    // Strip after joining: assigning an empty pathname puts the '/' straight back.
    return (url.origin + url.pathname).replace(/\/+$/, '');
  } catch {
    return input.replace(/\/+$/, '');
  }
}

export function joinWellKnown(baseUrl: string, suffix: string): string {
  return `${normalizeUrl(baseUrl)}${suffix}`;
}
