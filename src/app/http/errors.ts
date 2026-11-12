import type { ErrorHandler, NotFoundHandler } from 'hono';
import type { AppEnv } from '../types';

export const notFound: NotFoundHandler<AppEnv> = (c) =>
  c.json(
    { success: false, message: 'Route not found', errorCode: 'ROUTE_NOT_FOUND', errorMessage: 'Route not found' },
    404,
  );

export const onError: ErrorHandler<AppEnv> = (err, c) => {
  const requestId = c.get('requestId');
  console.error(JSON.stringify({ msg: 'unhandled_error', requestId, error: err?.message, stack: err?.stack }));
  return c.json(
    {
      success: false,
      message: 'Internal server error',
      errorCode: 'INTERNAL_ERROR',
      errorMessage: 'Internal server error',
      requestId,
    },
    500,
  );
};
