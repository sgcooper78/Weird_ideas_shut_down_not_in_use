const { ECSClient, UpdateServiceCommand, DescribeServicesCommand } = require("@aws-sdk/client-ecs");
const { RDSClient, DescribeDBInstancesCommand, StartDBInstanceCommand } = require("@aws-sdk/client-rds");
const { ELBV2Client, DescribeRulesCommand, ModifyRuleCommand } = require("@aws-sdk/client-elasticloadbalancingv2");

const ecsClient = new ECSClient();
const rdsClient = new RDSClient();
const elbv2Client = new ELBV2Client();

exports.handler = async (event) => {
  try {
    console.log("Starting up infrastructure...");

    // 1. Start ECS service (set desired count to 1)
    await ecsClient.send(new UpdateServiceCommand({
      cluster: process.env.ECS_CLUSTER_NAME,
      service: process.env.ECS_SERVICE_NAME,
      desiredCount: 1,
    }));

    console.log("ECS service started with desired count 1");

    // 2. Start RDS instance if it's stopped
    try {
      const dbInstance = await rdsClient.send(new DescribeDBInstancesCommand({
        DBInstanceIdentifier: process.env.RDS_INSTANCE_ID,
      }));

      if (dbInstance.DBInstances && dbInstance.DBInstances[0] && dbInstance.DBInstances[0].DBInstanceStatus === "stopped") {
        await rdsClient.send(new StartDBInstanceCommand({
          DBInstanceIdentifier: process.env.RDS_INSTANCE_ID,
        }));
        console.log("RDS instance started");
      } else {
        console.log("RDS instance is already running");
      }
    } catch (error) {
      console.log("Could not start RDS instance:", error);
    }

    // 3. Swap listener rule priorities
    await swapListenerRulePriorities();

    console.log("Infrastructure startup completed successfully");

    // 4. Wait for ECS service to be stable and RDS to be available
    await waitForInfrastructureReady();

    // 5. Forward the original request to the ECS service
    const response = await forwardRequestToEcs(event);

    return response;

  } catch (error) {
    console.error("Error starting infrastructure:", error);
    
    // Return a 503 Service Unavailable while infrastructure is starting
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

async function waitForInfrastructureReady() {
  console.log("Waiting for infrastructure to be ready...");
  
  // Wait for ECS service to be stable
  let attempts = 0;
  const maxAttempts = 30; // 5 minutes with 10 second intervals
  
  while (attempts < maxAttempts) {
    try {
      const service = await ecsClient.send(new DescribeServicesCommand({
        cluster: process.env.ECS_CLUSTER_NAME,
        services: [process.env.ECS_SERVICE_NAME],
      }));

      const serviceStatus = service.services && service.services[0] ? service.services[0].status : '';
      const runningCount = service.services && service.services[0] ? service.services[0].runningCount : 0;
      const desiredCount = service.services && service.services[0] ? service.services[0].desiredCount : 0;

      if (serviceStatus === 'ACTIVE' && runningCount === desiredCount && desiredCount === 1) {
        console.log("ECS service is ready");
        break;
      }

      console.log(`ECS service status: ${serviceStatus}, running: ${runningCount}/${desiredCount}`);
      
    } catch (error) {
      console.log("Error checking ECS service status:", error);
    }

    attempts++;
    if (attempts < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, 10000)); // Wait 10 seconds
    }
  }

  if (attempts >= maxAttempts) {
    throw new Error("ECS service did not become ready in time");
  }

  // Wait for RDS to be available
  attempts = 0;
  while (attempts < maxAttempts) {
    try {
      const dbInstance = await rdsClient.send(new DescribeDBInstancesCommand({
        DBInstanceIdentifier: process.env.RDS_INSTANCE_ID,
      }));

      const dbStatus = dbInstance.DBInstances && dbInstance.DBInstances[0] ? dbInstance.DBInstances[0].DBInstanceStatus : '';
      
      if (dbStatus === 'available') {
        console.log("RDS instance is available");
        break;
      }

      console.log(`RDS status: ${dbStatus}`);
      
    } catch (error) {
      console.log("Error checking RDS status:", error);
    }

    attempts++;
    if (attempts < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, 10000)); // Wait 10 seconds
    }
  }

  if (attempts >= maxAttempts) {
    throw new Error("RDS instance did not become available in time");
  }
}

async function forwardRequestToEcs(event) {
  try {
    const targetUrl = `http://${process.env.ECS_SERVICE_HOST}:80${event.path || '/'}`;
    
    console.log(`Forwarding request to: ${targetUrl}`);

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

    // Make the request to the ECS service
    const response = await fetch(targetUrl, {
      method: event.httpMethod || 'GET',
      headers: headers,
      body: body || undefined,
    });

    // Get response body
    const responseBody = await response.text();

    // Return the response from ECS
    return {
      statusCode: response.status,
      headers: {
        'Content-Type': response.headers.get('content-type') || 'application/json',
        ...Object.fromEntries(response.headers.entries()),
      },
      body: responseBody,
    };

  } catch (error) {
    console.error("Error forwarding request to ECS:", error);
    
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