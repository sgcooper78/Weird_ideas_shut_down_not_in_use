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
    console.log("Starting rule priority swap...");
    
    // Get current listener rules
    const rules = await elbv2Client.send(new DescribeRulesCommand({
      ListenerArn: process.env.LISTENER_ARN,
    }));

    console.log("Found rules:", JSON.stringify(rules.Rules, null, 2));

    // Find the Lambda rule and ECS rule by target group type
    const lambdaRule = rules.Rules && rules.Rules.find(rule => 
      rule.Actions && rule.Actions[0] && 
      rule.Actions[0].Type === "forward" && 
      rule.Actions[0].TargetGroupArn && 
      rule.Actions[0].TargetGroupArn.includes("Lambd") // Look for Lambda target group
    );
    
    const ecsRule = rules.Rules && rules.Rules.find(rule => 
      rule.Actions && rule.Actions[0] && 
      rule.Actions[0].Type === "forward" && 
      rule.Actions[0].TargetGroupArn && 
      !rule.Actions[0].TargetGroupArn.includes("Lambd") // Look for non-Lambda target group
    );

    console.log("Lambda rule:", lambdaRule ? lambdaRule.RuleArn : "Not found");
    console.log("ECS rule:", ecsRule ? ecsRule.RuleArn : "Not found");

    if (lambdaRule && ecsRule) {
      console.log(`Current priorities - Lambda: ${lambdaRule.Priority}, ECS: ${ecsRule.Priority}`);
      
      // Swap priorities - ECS rule gets higher priority (1), Lambda gets lower (2)
      await elbv2Client.send(new ModifyRuleCommand({
        RuleArn: ecsRule.RuleArn,
        Priority: 1,
      }));

      await elbv2Client.send(new ModifyRuleCommand({
        RuleArn: lambdaRule.RuleArn,
        Priority: 2,
      }));

      console.log("Listener rule priorities swapped - ECS now has priority 1, Lambda has priority 2");
    } else {
      console.log("Could not find both Lambda and ECS rules");
    }
  } catch (error) {
    console.log("Could not swap listener rule priorities:", error);
  }
}

async function forwardRequestToEcsWithRetry(event) {
  console.log("Forwarding request to ECS service...");
  console.log("Event:", JSON.stringify(event, null, 2));
  
  let attempts = 0;
  const retryInterval = 5000; // 5 seconds between retries
  
  while (true) { // Keep trying until Lambda times out or we succeed
    attempts++;
    console.log(`Attempt ${attempts}: Forwarding request to ECS...`);
    
    try {
      // Use the actual URL from the event
      const targetUrl = event.url || event.requestContext?.http?.url || event.path;
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

      console.log("Request headers:", headers);
      console.log("Request method:", event.httpMethod || 'GET');

      // Make the request to the ECS service using the actual URL
      const response = await fetch(targetUrl, {
        method: event.httpMethod || 'GET',
        headers: headers,
        body: body || undefined,
      });

      console.log(`ECS response status: ${response.status}`);
      console.log(`ECS response headers:`, Object.fromEntries(response.headers.entries()));

      // Only return success for 200-299 status codes
      if (response.status >= 200 && response.status < 300) {
        // Success! Get response body and return
        const responseBody = await response.text();
        console.log(`Request successful on attempt ${attempts} with status ${response.status}`);
        console.log(`Response body length: ${responseBody.length}`);
        
        return {
          statusCode: response.status,
          headers: {
            'Content-Type': response.headers.get('content-type') || 'application/json',
            ...Object.fromEntries(response.headers.entries()),
          },
          body: responseBody,
        };
      } else {
        // Any other status code, retry
        console.log(`Status code ${response.status} - retrying in 5 seconds...`);
        await new Promise(resolve => setTimeout(resolve, retryInterval));
      }
      
    } catch (error) {
      console.log(`Attempt ${attempts} failed:`, error.message);
      console.log(`Error details:`, error);
      
      // Any error, wait and retry
      console.log("Request failed, retrying in 5 seconds...");
      await new Promise(resolve => setTimeout(resolve, retryInterval));
    }
    
    // Log progress every 10 attempts
    if (attempts % 10 === 0) {
      console.log(`Still retrying... Attempt ${attempts} completed`);
    }
  }
} 