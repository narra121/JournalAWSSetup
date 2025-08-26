exports.handler = async (event) => {
  const userId = event?.requestContext?.authorizer?.jwt?.claims?.sub || 'unknown';
  return {
    statusCode: 200,
    body: JSON.stringify({ message: 'create-trade stub', userId })
  };
};
