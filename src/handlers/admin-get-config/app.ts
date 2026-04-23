import { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import { SSMClient, GetParametersByPathCommand } from '@aws-sdk/client-ssm';
import { envelope, errorResponse, ErrorCodes } from '../../shared/validation';
import { makeLogger } from '../../shared/logger';

const ssm = new SSMClient({});

function maskValue(value: string): string {
  if (value.length <= 4) return '••••';
  return '••••' + value.slice(-4);
}

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  const log = makeLogger({ requestId: event.requestContext?.requestId });
  try {
    const parameters: { name: string; type: string; value: string; lastModified: string | null }[] = [];
    let nextToken: string | undefined;

    do {
      const res = await ssm.send(new GetParametersByPathCommand({
        Path: '/tradequt/',
        Recursive: true,
        WithDecryption: true,
        NextToken: nextToken,
      }));

      if (res.Parameters) {
        for (const param of res.Parameters) {
          const isSecure = param.Type === 'SecureString';
          parameters.push({
            name: param.Name!,
            type: param.Type!,
            value: isSecure ? maskValue(param.Value ?? '') : (param.Value ?? ''),
            lastModified: param.LastModifiedDate?.toISOString() ?? null,
          });
        }
      }

      nextToken = res.NextToken;
    } while (nextToken);

    parameters.sort((a, b) => a.name.localeCompare(b.name));

    log.info('Config retrieved', { count: parameters.length });
    return envelope({
      statusCode: 200,
      data: { parameters },
      message: 'Config retrieved',
    });
  } catch (e: any) {
    log.error('Failed to retrieve config', { error: e.message });
    return errorResponse(500, ErrorCodes.INTERNAL_ERROR, 'Internal error');
  }
};
