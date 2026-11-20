import { launch } from './launch.ts';

/**
 * Opens an http or https URL in the default browser. Any other scheme is refused before a process starts.
 * Resolves once the launcher has started (or handed off); rejects when it cannot be started or fails.
 */
export default function launchUrl(url: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch (_err) {
    return Promise.reject(new Error('openUrl: not a valid URL'));
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return Promise.reject(new Error(`openUrl: refusing to open ${parsed.protocol} URL`));
  return launch(parsed.href);
}
