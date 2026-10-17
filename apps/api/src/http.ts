import type { INestApplication } from '@nestjs/common';
import { REQUEST_ID_HEADER } from './logging/logging.js';

/** HTTP settings shared by main.ts and the e2e tests. Only the web app's
 * origin may call the API from a browser; it may read the request ID. */
export function configureHttp(app: INestApplication, webOrigin: string): void {
  // credentials: the browser may send the session cookie with requests.
  app.enableCors({ origin: webOrigin, credentials: true, exposedHeaders: [REQUEST_ID_HEADER] });
}
