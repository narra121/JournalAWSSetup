import { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getUserId } from '../../shared/auth';
import { envelope, errorResponse, ErrorCodes } from '../../shared/validation';

const ssm = new SSMClient({});
const FIREBASE_SA_PARAM = process.env.FIREBASE_SERVICE_ACCOUNT_PARAM!;

let cachedSaKey: string | undefined;

async function getServiceAccountKey(): Promise<string> {
  if (cachedSaKey) return cachedSaKey;
  const res = await ssm.send(new GetParameterCommand({
    Name: FIREBASE_SA_PARAM,
    WithDecryption: true,
  }));
  cachedSaKey = res.Parameter?.Value;
  if (!cachedSaKey) throw new Error('Firebase SA key not found in SSM');
  return cachedSaKey;
}

function ensureFirebaseApp() {
  if (getApps().length === 0) {
    // Will be initialized on first call after cold start
    return false;
  }
  return true;
}

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  try {
    const userId = getUserId(event);
    if (!userId) return errorResponse(401, ErrorCodes.UNAUTHORIZED, 'Unauthorized');

    const saKeyJson = await getServiceAccountKey();
    const saKey = JSON.parse(saKeyJson);

    if (!ensureFirebaseApp()) {
      initializeApp({ credential: cert(saKey) });
    }

    const customToken = await getAuth().createCustomToken(userId);

    return envelope({
      statusCode: 200,
      data: { firebaseToken: customToken },
      message: 'Firebase token created',
    });
  } catch (e: any) {
    console.error('Firebase token error:', e);
    return errorResponse(500, ErrorCodes.INTERNAL_ERROR, 'Failed to create Firebase token');
  }
};
