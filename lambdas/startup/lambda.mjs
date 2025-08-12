import { ECSClient, UpdateServiceCommand, DescribeServicesCommand } from "@aws-sdk/client-ecs";
import { RDSClient, DescribeDBInstancesCommand, StartDBInstanceCommand } from "@aws-sdk/client-rds";
import { ElasticLoadBalancingV2Client, DescribeRulesCommand, SetRulePrioritiesCommand } from "@aws-sdk/client-elastic-load-balancing-v2";

const ecsClient = new ECSClient();
const rdsClient = new RDSClient();
const elbv2Client = new ElasticLoadBalancingV2Client();

async function waitForEcsServiceReady() {
  console.log("Waiting for ECS service to be ready...");
  
  let attempts = 0;
  const maxAttempts = 30; // 5 minutes max wait
  
  while (attempts < maxAttempts) {
    attempts++;
    
    try {
      const serviceResponse = await ecsClient.send(new DescribeServicesCommand({
        cluster: process.env.ECS_CLUSTER_NAME,
        services: [process.env.ECS_SERVICE_NAME],
      }));
      
      const service = serviceResponse.services[0];
      console.log(`ECS service status: ${service.status}, desired: ${service.desiredCount}, running: ${service.runningCount}, pending: ${service.pendingCount}`);
      
      // Check if service is stable and has running tasks
      if (service.status === 'ACTIVE' && 
          service.runningCount >= 1 && 
          service.pendingCount === 0) {
        console.log("ECS service is ready with running tasks!");
        return true;
      }
      
      console.log(`Waiting for ECS service to be ready... (attempt ${attempts}/${maxAttempts})`);
      await new Promise(resolve => setTimeout(resolve, 10000)); // Wait 10 seconds
      
    } catch (error) {
      console.log(`Error checking ECS service status:`, error);
      await new Promise(resolve => setTimeout(resolve, 10000));
    }
  }
  
  throw new Error("ECS service did not become ready within timeout period");
}

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

    // 3. Swap listener rule priorities FIRST - before any request forwarding
    console.log("Swapping listener rule priorities to route traffic to ECS...");
    await swapListenerRulePriorities();
    
    // 4. Wait for ECS service to be fully ready
    console.log("Waiting for ECS service to be ready...");
    await waitForEcsServiceReady();
    
    // 5. Wait a moment for rule changes to propagate
    console.log("Waiting for rule priority changes to propagate...");
    await new Promise(resolve => setTimeout(resolve, 3000)); // Wait 3 seconds

    console.log("Infrastructure startup completed successfully");

    // 6. Now forward the original request to the ECS service
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
      
      // Use SetRulePriorities to change multiple rule priorities at once
      console.log("Setting rule priorities using SetRulePriorities...");
      
      const setPrioritiesResult = await elbv2Client.send(new SetRulePrioritiesCommand({
        ListenerArn: process.env.LISTENER_ARN,
        RulePriorities: [
          {
            RuleArn: ecsRule.RuleArn,
            Priority: 1
          },
          {
            RuleArn: lambdaRule.RuleArn,
            Priority: 2
          }
        ]
      }));
      
      console.log("SetRulePriorities result:", setPrioritiesResult);

      console.log("Listener rule priorities swapped - ECS now has priority 1, Lambda has priority 2");
      
      // Verify the changes by getting the rules again
      console.log("Verifying rule priorities...");
      await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2 seconds for changes to propagate
      
      const updatedRules = await elbv2Client.send(new DescribeRulesCommand({
        ListenerArn: process.env.LISTENER_ARN,
      }));
      
      const updatedLambdaRule = updatedRules.Rules && updatedRules.Rules.find(rule => 
        rule.RuleArn === lambdaRule.RuleArn
      );
      const updatedEcsRule = updatedRules.Rules && updatedRules.Rules.find(rule => 
        rule.RuleArn === ecsRule.RuleArn
      );
      
      console.log(`Updated priorities - Lambda: ${updatedLambdaRule?.Priority}, ECS: ${updatedEcsRule?.Priority}`);
      
      if (updatedEcsRule?.Priority === "1" && updatedLambdaRule?.Priority === "2") {
        console.log("SUCCESS: Rule priorities have been successfully updated!");
      } else {
        console.log("FAILURE: Rule priorities were not updated as expected");
        console.log("Expected: ECS=1, Lambda=2");
        console.log("Actual: ECS=" + updatedEcsRule?.Priority + ", Lambda=" + updatedLambdaRule?.Priority);
      }
      
    } else {
      console.log("Could not find both Lambda and ECS rules");
    }
  } catch (error) {
    console.log("Could not swap listener rule priorities:", error);
    console.log("Error details:", JSON.stringify(error, null, 2));
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