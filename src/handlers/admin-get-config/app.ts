import type { ApiHandler } from '../../shared/types';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { envelope, errorResponse, ErrorCodes } from '../../shared/validation';
import { makeLogger } from '../../shared/logger';

const ssm = new SSMClient({});

/** The admin console edits only the ad configuration; no other parameter (and no secret) is listed or exposed. */
export const handler: ApiHandler = async (event) => {
  const log = makeLogger({ requestId: event.requestContext?.requestId });
  try {
    const name = process.env.AD_CONFIG_PARAM!;
    const parameters: { name: string; type: string; value: string; lastModified: string | null }[] = [];
    try {
      const res = await ssm.send(new GetParameterCommand({ Name: name }));
      if (res.Parameter) {
        parameters.push({
          name: res.Parameter.Name!,
          type: res.Parameter.Type!,
          value: res.Parameter.Value ?? '',
          lastModified: res.Parameter.LastModifiedDate?.toISOString() ?? null,
        });
      }
    } catch (e: any) {
      if (e.name !== 'ParameterNotFound') throw e;
    }

    log.info('Config retrieved', { count: parameters.length });
    return envelope({ statusCode: 200, data: { parameters }, message: 'Config retrieved' });
  } catch (e: any) {
    log.error('Failed to retrieve config', { error: e.message });
    return errorResponse(500, ErrorCodes.INTERNAL_ERROR, 'Internal error');
  }
};
