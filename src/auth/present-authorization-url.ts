import openUrl from '../lib/open-url.ts';
import type { Logger } from '../utils/logger.ts';

/**
 * Shows the user the authorization URL: opens it in the browser, or prints it when `headless` or when the browser cannot open it.
 * The caller keeps waiting for the callback either way, so the user can open a printed URL by hand.
 */
export async function presentAuthorizationUrl(url: string, options: { headless?: boolean; logger: Logger }): Promise<void> {
  const { headless, logger } = options;
  if (headless) {
    logger.info('🔗 Please visit this URL to authorize:');
    logger.info(url);
    logger.info('Waiting for callback...');
    return;
  }

  logger.debug('🌐 Opening browser for OAuth authorization...');
  try {
    await openUrl(url);
  } catch (error) {
    logger.warn('Could not open the browser:', error instanceof Error ? error.message : String(error));
    logger.info('🔗 Please visit this URL to authorize:');
    logger.info(url);
  }
}
