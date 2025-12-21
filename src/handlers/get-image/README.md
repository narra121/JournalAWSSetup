# Get Image Handler Test

This Lambda function serves images from S3 through an API endpoint.

## Endpoint
GET /images/{imageId}

## Parameters
- `imageId`: The S3 key/filename of the image (without the /images/ prefix)

## Response
- **200**: Image data with appropriate content-type header
- **404**: Image not found
- **400**: Missing imageId parameter  
- **500**: Server error

## Authentication
Requires valid Cognito authorization token in the Authorization header.

## Example Usage
```
GET /images/abc123.jpg
Authorization: Bearer <token>
```

Returns the image file with appropriate MIME type and caching headers.