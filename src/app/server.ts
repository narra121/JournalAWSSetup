import { serve } from '@hono/node-server';
import { featureRoutes } from '../features/index';
import { createApp } from './app';

const app = createApp({ featureRoutes });

// Lambda Web Function: bind exactly the address in AWS_LAMBDA_HTTP_ENDPOINT (host:port). Locally fall back to $PORT.
const endpoint = process.env.AWS_LAMBDA_HTTP_ENDPOINT;
const [hostname, port] = endpoint
  ? [endpoint.slice(0, endpoint.lastIndexOf(':')), Number(endpoint.slice(endpoint.lastIndexOf(':') + 1))]
  : ['127.0.0.1', Number(process.env.PORT || 3001)];

const server = serve({ fetch: app.fetch, hostname, port }, (info) => {
  console.log(JSON.stringify({ msg: 'listening', hostname: info.address, port: info.port }));
});

process.on('SIGTERM', () => {
  server.close();
});
