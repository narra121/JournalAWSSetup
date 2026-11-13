import type { Hono } from 'hono';
import type { AppEnv } from '../app/types';
import { chatApp } from './chat/routes';
import { importApp } from './import/routes';
import { insightsApp } from './insights/routes';
import { reportsApp } from './reports/routes';

/** Mounted by src/app under `/v1<basePath>` behind the auth + entitlements middleware (CONTRACT §3). */
export const featureRoutes: { basePath: string; app: Hono<AppEnv> }[] = [
  { basePath: '/import', app: importApp() },
  { basePath: '/insights', app: insightsApp() },
  { basePath: '/chat', app: chatApp() },
  { basePath: '/reports', app: reportsApp() },
];

export { generateInsight } from './insights/service';
export { defaultInsightDeps } from './insights/routes';
