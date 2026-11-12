import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2, Context } from 'aws-lambda';

/** Shape shared by every `src/handlers/*` entry point; the callback slot exists only so tests may pass one. */
export type ApiHandler = (
  event: APIGatewayProxyEventV2,
  context?: Context,
  callback?: unknown,
) => Promise<APIGatewayProxyStructuredResultV2>;
