import { AdminUserGlobalSignOutCommand, CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { Hono } from 'hono';
import { exportUserData, purgeUser } from '../../shared/account-data';
import { makeLogger } from '../../shared/logger';
import type { AppEnv } from '../types';

const cognito = new CognitoIdentityProviderClient({});

export const accountRoutes = new Hono<AppEnv>();

accountRoutes.get('/auth/export', async (c) => {
  const data = await exportUserData(c.get('userId'), c.get('email'));
  const date = data.exportedAt.slice(0, 10);
  return c.json({ success: true, message: 'Success', data }, 200, {
    'content-disposition': `attachment; filename="tradequt-export-${date}.json"`,
  });
});

accountRoutes.delete('/auth/account', async (c) => {
  const userId = c.get('userId');
  const result = await purgeUser(userId, makeLogger({ requestId: c.get('requestId'), userId }));
  return c.json({ success: true, message: 'Account deleted', data: result });
});

accountRoutes.post('/auth/logout-all', async (c) => {
  await cognito.send(new AdminUserGlobalSignOutCommand({ UserPoolId: process.env.USER_POOL_ID!, Username: c.get('userId') }));
  return c.json({ success: true, message: 'Signed out everywhere', data: null });
});
