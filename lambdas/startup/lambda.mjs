import { ECSClient, UpdateServiceCommand, DescribeServicesCommand } from "@aws-sdk/client-ecs";
import { RDSClient, DescribeDBInstancesCommand, StartDBInstanceCommand } from "@aws-sdk/client-rds";
import { ElasticLoadBalancingV2Client, DescribeRulesCommand, ModifyRuleCommand } from "@aws-sdk/client-elastic-load-balancing-v2";

const ecsClient = new ECSClient();
const rdsClient = new RDSClient();
const elbv2Client = new ElasticLoadBalancingV2Client();

export const handler = async (event) => {
  try {
    console.log("Starting up infrastructure...");

    // 1. Start ECS service (set desired count to 1)
    await ecsClient.send(new UpdateServiceCommand({
      cluster: process.env.ECS_CLUSTER_NAME,
      service: process.env.ECS_SERVICE_NAME,
      desiredCount: 1,
    }));

    console.log("ECS service started with desired count 1");

    // 2. Start RDS instance if it's stopped (don't wait for it to be ready)
    try {
      const dbInstance = await rdsClient.send(new DescribeDBInstancesCommand({
        DBInstanceIdentifier: process.env.RDS_INSTANCE_ID,
      }));

      if (dbInstance.DBInstances && dbInstance.DBInstances[0] && dbInstance.DBInstances[0].DBInstanceStatus === "stopped") {
        await rdsClient.send(new StartDBInstanceCommand({
          DBInstanceIdentifier: process.env.RDS_INSTANCE_ID,
        }));
        console.log("RDS instance start initiated (not waiting for completion)");
      } else {
        console.log("RDS instance is already running");
      }
    } catch (error) {
      console.log("Could not start RDS instance:", error);
    }

    // 3. Swap listener rule priorities
    await swapListenerRulePriorities();

    console.log("Infrastructure startup completed successfully");

    // 4. Forward the original request to the ECS service immediately
    // Don't wait for ECS to be fully ready, just check response codes
    const response = await forwardRequestToEcsWithRetry(event);

    return response;

  } catch (error) {
    console.error("Error starting infrastructure:", error);
    
    return {
      statusCode: 503,
      headers: {
        'Content-Type': 'application/json',
        'Retry-After': '30'
      },
      body: JSON.stringify({ 
        message: "Service is starting up, please try again in a moment",
        error: error instanceof Error ? error.message : "Unknown error"
      }),
    };
  }
};

async function swapListenerRulePriorities() {
  try {
    // Get current listener rules
    const rules = await elbv2Client.send(new DescribeRulesCommand({
      ListenerArn: process.env.LISTENER_ARN,
    }));

    // Find the Lambda rule and ECS rule
    const lambdaRule = rules.Rules && rules.Rules.find(rule => 
      rule.Actions && rule.Actions[0] && rule.Actions[0].Type === "lambda"
    );
    const ecsRule = rules.Rules && rules.Rules.find(rule => 
      rule.Actions && rule.Actions[0] && rule.Actions[0].Type === "forward"
    );

    if (lambdaRule && ecsRule) {
      // Swap priorities - ECS rule gets higher priority (1), Lambda gets lower (2)
      await elbv2Client.send(new ModifyRuleCommand({
        RuleArn: ecsRule.RuleArn,
        Priority: 1,
      }));

      await elbv2Client.send(new ModifyRuleCommand({
        RuleArn: lambdaRule.RuleArn,
        Priority: 2,
      }));

      console.log("Listener rule priorities swapped successfully");
    }
  } catch (error) {
    console.log("Could not swap listener rule priorities:", error);
  }
}

async function forwardRequestToEcsWithRetry(event) {
  console.log("Forwarding request to ECS service...");
  
  let attempts = 0;
  const retryInterval = 5000; // 5 seconds between retries
  
  while (true) { // Keep trying until Lambda times out or we succeed
    attempts++;
    console.log(`Attempt ${attempts}: Forwarding request to ECS...`);
    
    try {
      // Use the actual URL from the event

      const targetPath = event.url || event.requestContext?.http?.url || event.path;
      const targetUrl = `https://db.scottgcooper.com${targetPath}`;
      console.log(`Attempt ${attempts}: Forwarding request to: ${targetUrl}`);

      // Build the request body
      let body = '';
      if (event.body) {
        body = event.body;
      }

      // Build headers (filter out Lambda-specific headers)
      const headers = {};
      if (event.headers) {
        Object.entries(event.headers).forEach(([key, value]) => {
          if (value && !key.toLowerCase().startsWith('x-amz-') && key.toLowerCase() !== 'host') {
            headers[key] = value;
          }
        });
      }

      // Make the request to the ECS service using the actual URL
      const response = await fetch(targetUrl, {
        method: event.httpMethod || 'GET',
        headers: headers,
        body: body || undefined,
      });

      // Check if we got a successful response
      if (response.status === 200 || response.status === 201 || response.status === 202) {
        // Success! Get response body and return
        const responseBody = await response.text();
        console.log(`Request successful on attempt ${attempts}`);
        
        return {
          statusCode: response.status,
          headers: {
            'Content-Type': response.headers.get('content-type') || 'application/json',
            ...Object.fromEntries(response.headers.entries()),
          },
          body: responseBody,
        };
      } else if (response.status === 503 || response.status === 502) {
        // Service still starting up, wait and retry
        console.log(`ECS service still starting (status: ${response.status}), retrying in 5 seconds...`);
        await new Promise(resolve => setTimeout(resolve, retryInterval));
      } else {
        // Other error status, return the error response
        const responseBody = await response.text();
        console.log(`ECS service returned error status: ${response.status}`);
        
        return {
          statusCode: response.status,
          headers: {
            'Content-Type': response.headers.get('content-type') || 'application/json',
            ...Object.fromEntries(response.headers.entries()),
          },
          body: responseBody,
        };
      }
      
    } catch (error) {
      console.log(`Attempt ${attempts} failed:`, error.message);
      
      // If it's a connection error, wait and retry
      if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
        console.log("ECS service not yet accessible, retrying in 5 seconds...");
        await new Promise(resolve => setTimeout(resolve, retryInterval));
      } else {
        // Other error, return error response
        return {
          statusCode: 502,
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ 
            message: "Error forwarding request to backend service",
            error: error instanceof Error ? error.message : "Unknown error"
          }),
        };
      }
    }
    
    // Log progress every 10 attempts
    if (attempts % 10 === 0) {
      console.log(`Still retrying... Attempt ${attempts} completed`);
    }
  }
} 