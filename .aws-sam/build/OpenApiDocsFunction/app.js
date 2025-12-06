"use strict";var r=Object.defineProperty;var i=Object.getOwnPropertyDescriptor;var n=Object.getOwnPropertyNames;var l=Object.prototype.hasOwnProperty;var d=(t,e)=>{for(var a in e)r(t,a,{get:e[a],enumerable:!0})},g=(t,e,a,o)=>{if(e&&typeof e=="object"||typeof e=="function")for(let s of n(e))!l.call(t,s)&&s!==a&&r(t,s,{get:()=>e[s],enumerable:!(o=i(e,s))||o.enumerable});return t};var c=t=>g(r({},"__esModule",{value:!0}),t);var p={};d(p,{handler:()=>h});module.exports=c(p);var u=`<!DOCTYPE html>
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
</html>`,h=async()=>({statusCode:200,headers:{"Content-Type":"text/html; charset=utf-8","Cache-Control":"public, max-age=300"},body:u});0&&(module.exports={handler});
//# sourceMappingURL=app.js.map
