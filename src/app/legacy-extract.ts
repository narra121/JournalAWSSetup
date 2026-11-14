import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { handler as extractTrades } from '../handlers/extract-trades/app';
import { defaultsFor, errorBody, normalizeErrorBody } from '../shared/apiError';
import { ddb } from '../shared/dynamo';
import { computeEntitlements, effectiveSubscription, isReadOnly } from './billing/entitlements';
import { createQuota } from './billing/quota';
import { extractUnits } from './billing/extractUnits';
import { trialExpiredBody } from './billing/middleware';
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

/** True when the verified token was issued by the prod user pool, whose subscriptions this dev stack cannot see. */
function fromProdPool(claims: Record<string, string>): boolean {
  const prodPool = process.env.PROD_USER_POOL_ID;
  return !!prodPool && !!claims.iss?.endsWith(`/${prodPool}`);
}

/**
 * Function URL entry for `POST /` of the old public extract endpoint: signature-verified JWT, plus the read-only check
 * and the `ai_extract` quota for dev-pool users. This function can only read Subscriptions, so a record from before the
 * trial and Pro plans is judged as the web app will store it (`effectiveSubscription`). Prod-pool callers are not
 * checked: their plan lives in prod, and a dev limit would cut off paying users and hide their usage from prod.
 */
export const legacyExtract = async (event: any, context?: any) => {
  const header: string | undefined = event?.headers?.authorization || event?.headers?.Authorization;
  const token = header?.replace(/^Bearer\s+/i, '').trim();
  let claims: Record<string, string>;
  try {
    if (!token) throw new Error('missing token');
    claims = stringifyClaims(await getVerifier().verify(token));
    if (!claims.sub) throw new Error('missing sub');
  } catch {
    return json(401, errorBody('UNAUTHORIZED', defaultsFor(401).message));
  }

  const userId = claims.sub;
  let quota: ReturnType<typeof createQuota> | undefined;
  let units = 1;
  if (!fromProdPool(claims)) {
    const sub = (await ddb.send(new GetCommand({ TableName: process.env.SUBSCRIPTIONS_TABLE!, Key: { userId } }))).Item;
    const entitlements = computeEntitlements(effectiveSubscription(sub));
    if (isReadOnly(entitlements)) return json(402, trialExpiredBody(entitlements));
    quota = createQuota(userId, entitlements);
    units = extractUnits(event.body);
    const taken = await quota.consume('ai_extract', units);
    if (!taken.ok) return json(402, quotaExceededBody('ai_extract', entitlements, taken.resetsAt));
  }

  const result: any = await extractTrades(
    { ...event, requestContext: { ...event.requestContext, authorizer: { jwt: { claims } } } },
    context,
    () => undefined,
  );
  const status = Number(result?.statusCode);
  if (status >= 400) {
    await quota?.consume('ai_extract', -units);
    return json(status, normalizeErrorBody(status, result.body));
  }
  return result;
};
