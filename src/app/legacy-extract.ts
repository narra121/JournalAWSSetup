import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { handler as extractTrades } from '../handlers/extract-trades/app';
import { ddb } from '../shared/dynamo';
import { computeEntitlements } from './billing/entitlements';
import { createQuota } from './billing/quota';
import { quotaExceededBody } from './billing/responses';
import { stringifyClaims, type TokenVerifier } from './auth/cognito';

let verifier: TokenVerifier | undefined;

/** Accepts tokens from this stack's pool and from the prod pool (the deployed prod frontend calls this URL). */
function getVerifier(): TokenVerifier {
  verifier ??= CognitoJwtVerifier.create([
    { userPoolId: process.env.USER_POOL_ID!, clientId: process.env.USER_POOL_CLIENT_ID!, tokenUse: null },
    { userPoolId: process.env.PROD_USER_POOL_ID!, clientId: process.env.PROD_USER_POOL_CLIENT_ID!, tokenUse: null },
  ]) as unknown as TokenVerifier;
  return verifier;
}

/** Test seam. */
export function setLegacyVerifier(v: TokenVerifier | undefined): void {
  verifier = v;
}

const json = (statusCode: number, body: unknown) => ({
  statusCode,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

/** Function URL entry for `POST /` of the old public extract endpoint: signature-verified JWT + `ai_extract` quota. */
export const legacyExtract = async (event: any, context?: any) => {
  const header: string | undefined = event?.headers?.authorization || event?.headers?.Authorization;
  const token = header?.replace(/^Bearer\s+/i, '').trim();
  let claims: Record<string, string>;
  try {
    if (!token) throw new Error('missing token');
    claims = stringifyClaims(await getVerifier().verify(token));
    if (!claims.sub) throw new Error('missing sub');
  } catch {
    return json(401, { message: 'Unauthorized' });
  }

  const userId = claims.sub;
  const sub = (await ddb.send(new GetCommand({ TableName: process.env.SUBSCRIPTIONS_TABLE!, Key: { userId } }))).Item;
  const entitlements = computeEntitlements(sub);
  const quota = createQuota(userId, entitlements);
  const taken = await quota.consume('ai_extract');
  if (!taken.ok) return json(402, quotaExceededBody('ai_extract', entitlements, taken.resetsAt));

  const result: any = await extractTrades(
    { ...event, requestContext: { ...event.requestContext, authorizer: { jwt: { claims } } } },
    context,
    () => undefined,
  );
  if (Number(result?.statusCode) >= 400) await quota.consume('ai_extract', -1);
  return result;
};
