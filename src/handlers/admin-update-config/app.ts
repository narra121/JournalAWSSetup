import { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import { SSMClient, PutParameterCommand } from '@aws-sdk/client-ssm';
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
    if (!event.body) return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'Missing body');

    const { name, value, type } = JSON.parse(event.body);

    if (!name || !value || !type) {
      return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'name, value, and type are required');
    }

    if (!name.startsWith('/tradequt/')) {
      return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'name must start with /tradequt/');
    }

    if (type !== 'String' && type !== 'SecureString') {
      return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'type must be String or SecureString');
    }

    await ssm.send(new PutParameterCommand({
      Name: name,
      Value: value,
      Type: type,
      Overwrite: true,
    }));

    const maskedValue = type === 'SecureString' ? maskValue(value) : value;

    log.info('Config updated', { name, type });
    return envelope({
      statusCode: 200,
      data: { name, type, value: maskedValue },
      message: 'Config updated',
    });
  } catch (e: any) {
    log.error('Failed to update config', { error: e.message });
    return errorResponse(500, ErrorCodes.INTERNAL_ERROR, 'Internal error');
  }
};
