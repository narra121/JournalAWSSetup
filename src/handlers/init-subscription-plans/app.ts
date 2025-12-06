import Razorpay from 'razorpay';
import { SSMClient, PutParameterCommand, GetParameterCommand } from '@aws-sdk/client-ssm';

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID!,
  key_secret: process.env.RAZORPAY_KEY_SECRET!,
});

const ssmClient = new SSMClient({});
const STAGE_NAME = process.env.STAGE_NAME!;

// Define default subscription plans
const DEFAULT_PLANS = [
  // Monthly Plans
  {
    name: 'TradeFlow Supporter Monthly',
    amount: 99, // in rupees
    currency: 'INR',
    period: 'monthly' as const,
    interval: 1,
    description: 'Monthly subscription - All features included. Support the developer!',
  },
  {
    name: 'TradeFlow Enthusiast Monthly',
    amount: 299, // in rupees
    currency: 'INR',
    period: 'monthly' as const,
    interval: 1,
    description: 'Monthly subscription - All features included. Extra support for continued development!',
  },
  {
    name: 'TradeFlow Champion Monthly',
    amount: 499, // in rupees
    currency: 'INR',
    period: 'monthly' as const,
    interval: 1,
    description: 'Monthly subscription - All features included. Help fund new features and improvements!',
  },
  // Yearly Plans
  {
    name: 'TradeFlow Supporter Yearly',
    amount: 999, // in rupees (save ~16%)
    currency: 'INR',
    period: 'yearly' as const,
    interval: 1,
    description: 'Yearly subscription - All features included. Support the developer!',
  },
  {
    name: 'TradeFlow Enthusiast Yearly',
    amount: 2999, // in rupees (save ~16%)
    currency: 'INR',
    period: 'yearly' as const,
    interval: 1,
    description: 'Yearly subscription - All features included. Extra support for continued development!',
  },
  {
    name: 'TradeFlow Champion Yearly',
    amount: 4999, // in rupees (save ~16%)
    currency: 'INR',
    period: 'yearly' as const,
    interval: 1,
    description: 'Yearly subscription - All features included. Help fund new features and improvements!',
  },
];

interface CloudFormationEvent {
  RequestType: 'Create' | 'Update' | 'Delete';
  ResponseURL: string;
  StackId: string;
  RequestId: string;
  ResourceType: string;
  LogicalResourceId: string;
  PhysicalResourceId?: string;
  ResourceProperties: {
    ServiceToken: string;
    [key: string]: any;
  };
}

/**
 * CloudFormation Custom Resource handler to initialize subscription plans
 * Creates default plans in Razorpay on first deployment
 */
export const handler = async (event: CloudFormationEvent): Promise<void> => {
  console.log('Event:', JSON.stringify(event, null, 2));

  const { RequestType, ResponseURL, StackId, RequestId, LogicalResourceId } = event;
  let physicalResourceId = event.PhysicalResourceId || `subscription-plans-${Date.now()}`;
  let status = 'SUCCESS';
  let responseData: any = {};

  try {
    if (RequestType === 'Create' || RequestType === 'Update') {
      console.log('Initializing subscription plans...');

      const createdPlans = [];

      for (const planConfig of DEFAULT_PLANS) {
        try {
          // Check if plan already exists in SSM Parameter Store
          // Use a unique key based on period and amount
          const planKey = `${planConfig.period}-${planConfig.amount}`;
          const paramName = `/tradeflow/${STAGE_NAME}/razorpay/plan/${planKey}`;
          
          let existingPlanId: string | null = null;
          try {
            const getResult = await ssmClient.send(
              new GetParameterCommand({ Name: paramName })
            );
            existingPlanId = getResult.Parameter?.Value || null;
            console.log(`Found existing plan ID for ${planConfig.name}: ${existingPlanId}`);
          } catch (error: any) {
            if (error.name !== 'ParameterNotFound') {
              throw error;
            }
            console.log(`No existing plan ID found for ${planConfig.name}`);
          }

          let planId = existingPlanId;

          // If no existing plan or this is an Update, create/recreate the plan
          if (!existingPlanId || RequestType === 'Update') {
            console.log(`Creating Razorpay plan: ${planConfig.name}`);
            
            const plan = await razorpay.plans.create({
              period: planConfig.period,
              interval: planConfig.interval,
              item: {
                name: planConfig.name,
                amount: Math.round(planConfig.amount * 100), // Convert to paise
                currency: planConfig.currency,
                description: planConfig.description,
              },
            });

            planId = plan.id;
            console.log(`Created plan: ${planId}`);

            // Store plan ID in SSM Parameter Store
            await ssmClient.send(
              new PutParameterCommand({
                Name: paramName,
                Value: planId,
                Type: 'String',
                Description: `Razorpay plan ID for ${planConfig.name}`,
                Overwrite: true,
              })
            );

            console.log(`Stored plan ID in SSM: ${paramName}`);
          }

          createdPlans.push({
            name: planConfig.name,
            planId,
            period: planConfig.period,
            amount: planConfig.amount,
            currency: planConfig.currency,
          });
        } catch (error: any) {
          console.error(`Error creating plan ${planConfig.name}:`, error);
          // Continue with other plans even if one fails
        }
      }

      responseData = {
        Message: 'Subscription plans initialized successfully',
        Plans: createdPlans,
      };

      console.log('All plans initialized:', responseData);
    } else if (RequestType === 'Delete') {
      console.log('Delete request - no action needed (plans remain in Razorpay)');
      responseData = { Message: 'Delete completed (plans preserved)' };
    }
  } catch (error: any) {
    console.error('Error initializing plans:', error);
    status = 'FAILED';
    responseData = {
      Error: error.message,
    };
  }

  // Send response to CloudFormation
  await sendResponse(
    ResponseURL,
    {
      Status: status,
      Reason: status === 'FAILED' ? responseData.Error : 'See CloudWatch logs for details',
      PhysicalResourceId: physicalResourceId,
      StackId,
      RequestId,
      LogicalResourceId,
      Data: responseData,
    }
  );
};

async function sendResponse(url: string, body: any): Promise<void> {
  const https = await import('https');
  const { URL } = await import('url');

  const parsedUrl = new URL(url);
  const options = {
    hostname: parsedUrl.hostname,
    port: 443,
    path: parsedUrl.pathname + parsedUrl.search,
    method: 'PUT',
    headers: {
      'Content-Type': '',
      'Content-Length': JSON.stringify(body).length,
    },
  };

  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      console.log('CloudFormation response status:', res.statusCode);
      resolve();
    });

    req.on('error', (error) => {
      console.error('Error sending response to CloudFormation:', error);
      reject(error);
    });

    req.write(JSON.stringify(body));
    req.end();
  });
}
