exports.handler = async (event) => {
  const tradeId = event?.pathParameters?.tradeId;
  return { statusCode: 200, body: JSON.stringify({ message: 'update-trade stub', tradeId }) };
};
