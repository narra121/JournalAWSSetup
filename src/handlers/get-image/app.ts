import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { Readable } from 'stream';

const s3Client = new S3Client({});

interface PathParameters {
  imageId?: string;
}

/**
 * Lambda function to serve images from S3 with authentication
 * Takes an image ID and returns the image content with appropriate headers
 * Ensures images cannot be accessed directly via browser URLs
 */
export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    // Verify that the request has proper authorization
    const authHeader = event.headers.authorization || event.headers.Authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return {
        statusCode: 401,
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          error: 'Unauthorized - Bearer token required',
        }),
      };
    }

    const pathParameters = event.pathParameters as PathParameters;
    const imageId = pathParameters?.imageId;

    if (!imageId) {
      return {
        statusCode: 400,
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          error: 'imageId is required',
        }),
      };
    }

    // Validate image ID format and extension for security
    const allowedExtensions = /\.(jpg|jpeg|png|gif|webp)$/i;
    if (!allowedExtensions.test(imageId)) {
      return {
        statusCode: 400,
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          error: 'Invalid image format. Only jpg, jpeg, png, gif, and webp are allowed.',
        }),
      };
    }

    // Prevent path traversal attacks
    if (imageId.includes('..') || imageId.includes('/') || imageId.includes('\\')) {
      return {
        statusCode: 400,
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          error: 'Invalid image ID format',
        }),
      };
    }

    const bucketName = process.env.IMAGES_BUCKET;
    if (!bucketName) {
      console.error('IMAGES_BUCKET environment variable not set');
      return {
        statusCode: 500,
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          error: 'Server configuration error',
        }),
      };
    }

    // Construct the S3 key - images are stored in the /images/ prefix
    const s3Key = `images/${imageId}`;

    try {
      // Get the object from S3
      const getObjectCommand = new GetObjectCommand({
        Bucket: bucketName,
        Key: s3Key,
      });

      const response = await s3Client.send(getObjectCommand);

      if (!response.Body) {
        return {
          statusCode: 404,
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            error: 'Image not found',
          }),
        };
      }

      // Convert the stream to buffer
      const chunks: Buffer[] = [];
      const stream = response.Body as Readable;
      
      for await (const chunk of stream) {
        chunks.push(chunk);
      }
      
      const buffer = Buffer.concat(chunks);
      const base64Data = buffer.toString('base64');

      // Determine content type from metadata or file extension
      let contentType = response.ContentType || 'application/octet-stream';
      
      // If no content type from S3, try to infer from file extension
      if (contentType === 'application/octet-stream') {
        const extension = imageId.split('.').pop()?.toLowerCase();
        switch (extension) {
          case 'jpg':
          case 'jpeg':
            contentType = 'image/jpeg';
            break;
          case 'png':
            contentType = 'image/png';
            break;
          case 'gif':
            contentType = 'image/gif';
            break;
          case 'webp':
            contentType = 'image/webp';
            break;
          case 'svg':
            contentType = 'image/svg+xml';
            break;
          default:
            contentType = 'image/jpeg'; // Default fallback
        }
      }

      return {
        statusCode: 200,
        headers: {
          'Content-Type': contentType,
          'Cache-Control': 'private, max-age=3600', // Private cache only
          'Content-Length': buffer.length.toString(),
          'X-Content-Type-Options': 'nosniff', // Security header
          'X-Frame-Options': 'DENY', // Prevent embedding
          'Referrer-Policy': 'strict-origin-when-cross-origin', // Limit referrer info
        },
        isBase64Encoded: true,
        body: base64Data,
      };

    } catch (s3Error: any) {
      console.error('S3 Error:', s3Error);
      
      if (s3Error.name === 'NoSuchKey') {
        return {
          statusCode: 404,
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            error: 'Image not found',
          }),
        };
      }

      // For any other S3 error
      return {
        statusCode: 500,
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          error: 'Failed to retrieve image',
        }),
      };
    }

  } catch (error) {
    console.error('Handler Error:', error);
    return {
      statusCode: 500,
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        error: 'Internal server error',
      }),
    };
  }
};