exports.handler = async (event) => {
  return { batchItemFailures: [] }; // DynamoDB stream handler shape
};
