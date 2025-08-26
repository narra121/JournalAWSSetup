import { APIGatewayProxyHandlerV2 } from 'aws-lambda';

// Lightweight Swagger UI HTML referencing /openapi.yaml
// Uses CDN assets to keep bundle tiny.
const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Trading Journal API Docs</title>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css" />
  <style>body { margin:0; } #swagger-ui { max-width: 100%; }</style>
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
  <script>
    window.onload = () => {
      // Use current host for the spec URL to avoid CORS issues
      const baseUrl = window.location.origin + window.location.pathname.replace('/docs', '');
      window.ui = SwaggerUIBundle({
        url: baseUrl + '/openapi.yaml',
        dom_id: '#swagger-ui',
        presets: [SwaggerUIBundle.presets.apis],
        layout: 'BaseLayout'
      });
    };
  </script>
</body>
</html>`;

export const handler: APIGatewayProxyHandlerV2 = async () => ({
  statusCode: 200,
  headers: {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'public, max-age=300'
  },
  body: html
});
