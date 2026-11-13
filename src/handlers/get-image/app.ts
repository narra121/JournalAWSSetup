import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { Readable } from 'stream';
import { getUserId } from '../../shared/auth';
import { defaultsFor } from '../../shared/apiError';
import { errorResponse, ErrorCodes } from '../../shared/validation';

const s3Client = new S3Client({});
const IMAGE_NOT_FOUND = "That image couldn't be found. It may have been removed.";

interface PathParameters {
  imageId?: string;
}

/**
 * Lambda function to serve images from S3 with authentication
 * Takes an image ID and returns the image content with appropriate headers
 * Ensures images cannot be accessed directly via browser URLs
 */
export const handler = async (event: APIGatewayProxyEvent, _context?: unknown, _callback?: unknown): Promise<APIGatewayProxyResult> => {
  try {
    // Verify that the request has proper authorization
    const authHeader = event.headers.authorization || event.headers.Authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return errorResponse(401, ErrorCodes.UNAUTHORIZED, 'Please log in to view this image.');
    }

    const pathParameters = event.pathParameters as PathParameters;
    const imageId = pathParameters?.imageId;

    if (!imageId) {
      return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'Choose an image to open.');
    }

    // Validate image ID format and extension for security
    const allowedExtensions = /\.(jpg|jpeg|png|gif|webp)$/i;
    if (!allowedExtensions.test(imageId)) {
      return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'Only JPG, PNG, GIF and WebP images can be shown.');
    }

    // Prevent path traversal attacks (but allow forward slashes for the path structure)
    if (imageId.includes('..') || imageId.includes('\\')) {
      return errorResponse(400, ErrorCodes.VALIDATION_ERROR, "That image link isn't valid.");
    }

    // Validate the path structure: should be accountId/tradeId/filename
    const pathParts = imageId.split('/');
    if (pathParts.length !== 3) {
      return errorResponse(400, ErrorCodes.VALIDATION_ERROR, "That image link isn't valid.");
    }

    // Keys are images/<userId>/<tradeId>/<file>: only the owner may read them (other users get the same 404 as a missing image).
    if (!getUserId(event) || pathParts[0] !== getUserId(event)) {
      return errorResponse(404, ErrorCodes.NOT_FOUND, IMAGE_NOT_FOUND);
    }

    const bucketName = process.env.IMAGES_BUCKET;
    if (!bucketName) {
      console.error('IMAGES_BUCKET environment variable not set');
      return errorResponse(500, ErrorCodes.INTERNAL_ERROR, defaultsFor(500).message);
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
        return errorResponse(404, ErrorCodes.NOT_FOUND, IMAGE_NOT_FOUND);
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
        return errorResponse(404, ErrorCodes.NOT_FOUND, IMAGE_NOT_FOUND);
      }

      // For any other S3 error
      return errorResponse(500, ErrorCodes.INTERNAL_ERROR, "We couldn't load that image. Please try again.");
    }

  } catch (error) {
    console.error('Handler Error:', error);
    return errorResponse(500, ErrorCodes.INTERNAL_ERROR, defaultsFor(500).message);
  }
};