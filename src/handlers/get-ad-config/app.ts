import { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { envelope, errorResponse, ErrorCodes } from '../../shared/validation';
import { getUserId } from '../../shared/auth';
import { getSubscriptionTier } from '../../shared/subscription';
import { makeLogger } from '../../shared/logger';

const ssm = new SSMClient({});

// Module-scope SSM cache with 1-hour TTL
let cachedAdConfig: { value: string; expiry: number } | null = null;
const AD_CONFIG_CACHE_TTL = 3600000; // 1 hour

/** @internal Exposed for testing only */
export function _clearAdConfigCache(): void {
  cachedAdConfig = null;
}

async function getAdConfig(): Promise<any> {
  if (cachedAdConfig && Date.now() < cachedAdConfig.expiry) {
    return JSON.parse(cachedAdConfig.value);
  }
  const paramName = process.env.AD_CONFIG_PARAM;
  if (!paramName) return { placements: [] };
  const res = await ssm.send(new GetParameterCommand({ Name: paramName }));
  const value = res.Parameter?.Value || '{"placements":[]}';
  cachedAdConfig = { value, expiry: Date.now() + AD_CONFIG_CACHE_TTL };
  return JSON.parse(value);
}

/**
 * GET /v1/ad-config
 * Returns ad configuration based on user's subscription tier.
 * Paid/trial users get showAds: false; free-tier users get full ad placements.
 */
export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  const { headers, multiValueHeaders, ...safeEvent } = event as any;
  const log = makeLogger({ requestId: (event.requestContext as any)?.requestId });

  try {
    const userId = getUserId(event);
    if (!userId) {
      return errorResponse(401, ErrorCodes.UNAUTHORIZED, 'Authentication required');
    }

    log.info('Getting ad config', { userId });

    const tierResult = await getSubscriptionTier(userId);

    // Paid or trial users don't see ads
    if (!tierResult.showAds) {
      return envelope({
        statusCode: 200,
        data: {
          showAds: false,
          tier: tierResult.tier,
          placements: [],
        },
        message: 'Ad config retrieved',
      });
    }

    // Free-tier users get full ad config from SSM
    const adConfig = await getAdConfig();

    return envelope({
      statusCode: 200,
      data: {
        showAds: true,
        tier: tierResult.tier,
        provider: adConfig.provider || 'google_adsense',
        clientId: adConfig.clientId || '',
        placements: adConfig.placements || [],
      },
      message: 'Ad config retrieved',
    });
  } catch (error: any) {
    log.error('Error getting ad config', { error: error.message });
    return errorResponse(500, ErrorCodes.INTERNAL_ERROR, 'Failed to get ad config', error.message);
  }
};
