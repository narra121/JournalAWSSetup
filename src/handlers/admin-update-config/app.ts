import type { ApiHandler } from '../../shared/types';
import { SSMClient, PutParameterCommand } from '@aws-sdk/client-ssm';
import { envelope, errorResponse, ErrorCodes } from '../../shared/validation';
import { makeLogger } from '../../shared/logger';

const ssm = new SSMClient({});

/** Only the ad configuration parameter can be written from the admin console. */
export const handler: ApiHandler = async (event) => {
  const log = makeLogger({ requestId: event.requestContext?.requestId });
  try {
    if (!event.body) return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'Missing body');

    let parsed: any;
    try {
      parsed = JSON.parse(event.body);
    } catch {
      return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'Invalid JSON');
    }
    const { name, value } = parsed ?? {};

    if (!name || typeof value !== 'string' || !value) {
      return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'name and value are required');
    }

    if (name !== process.env.AD_CONFIG_PARAM) {
      return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'Only the ad configuration parameter can be changed');
    }

    await ssm.send(new PutParameterCommand({ Name: name, Value: value, Type: 'String', Overwrite: true }));

    log.info('Config updated', { name });
    return envelope({ statusCode: 200, data: { name, type: 'String', value }, message: 'Config updated' });
  } catch (e: any) {
    log.error('Failed to update config', { error: e.message });
    return errorResponse(500, ErrorCodes.INTERNAL_ERROR, 'Internal error');
  }
};
