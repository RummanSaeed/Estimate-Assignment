/**
 * Shared HTTP helpers for the estimates API routes.
 */

import { NextResponse } from 'next/server';
import type { ServiceError } from './estimate-service';
import { config } from './config';
import { logger } from './debug-logger';

/** Map a ServiceError to the correct HTTP status code. */
export function serviceErrorStatus(error: ServiceError): number {
  switch (error.kind) {
    case 'validation':
      return 400;
    case 'not_found':
      return 404;
    case 'conflict':
      return 409;
    default:
      return 500;
  }
}

/** Convert a ServiceError into a NextResponse JSON body. */
export function serviceErrorResponse(error: ServiceError): NextResponse {
  if (error.kind === 'internal') {
    logger.error('Estimate API internal error', {}, new Error(error.message));
  }
  return NextResponse.json(
    {
      error: error.message,
      ...(config.errors.exposeDetails && error.kind === 'internal'
        ? { details: error.message }
        : {}),
    },
    { status: serviceErrorStatus(error) },
  );
}
