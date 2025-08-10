const { ECS, RDS, ELBV2 } = require("aws-sdk");

const ecs = new ECS();
const rds = new RDS();
const elbv2 = new ELBV2();

exports.handler = async (event) => {
  try {
    console.log("Shutting down infrastructure...");

    // 1. Swap listener rule priorities back (Lambda gets priority 1, ECS gets priority 2)
    await swapListenerRulePriorities();

    // 2. Scale down ECS service to 0 desired count
    await ecs.updateService({
      cluster: process.env.ECS_CLUSTER_NAME,
      service: process.env.ECS_SERVICE_NAME,
      desiredCount: 0,
    }).promise();

    console.log("ECS service scaled down to 0 desired count");

    // 3. Wait for ECS tasks to drain
    await waitForEcsTasksToDrain();

    // 4. Stop RDS instance
    try {
      const dbInstance = await rds.describeDBInstances({
        DBInstanceIdentifier: process.env.RDS_INSTANCE_ID,
      }).promise();

      if (dbInstance.DBInstances && dbInstance.DBInstances[0] && dbInstance.DBInstances[0].DBInstanceStatus === "available") {
        await rds.stopDBInstance({
          DBInstanceIdentifier: process.env.RDS_INSTANCE_ID,
        }).promise();
        console.log("RDS instance stopped");
      } else {
        console.log("RDS instance is already stopped or in another state");
      }
    } catch (error) {
      console.log("Could not stop RDS instance:", error);
    }

    console.log("Infrastructure shutdown completed successfully");

  } catch (error) {
    console.error("Error shutting down infrastructure:", error);
    throw error;
  }
};

async function swapListenerRulePriorities() {
  try {
    // Get current listener rules
    const rules = await elbv2.describeRules({
      ListenerArn: process.env.LISTENER_ARN,
    }).promise();

    // Find the Lambda rule and ECS rule
    const lambdaRule = rules.Rules && rules.Rules.find(rule => 
      rule.Actions && rule.Actions[0] && rule.Actions[0].Type === "lambda"
    );
    const ecsRule = rules.Rules && rules.Rules.find(rule => 
      rule.Actions && rule.Actions[0] && rule.Actions[0].Type === "forward"
    );

    if (lambdaRule && ecsRule) {
      // Swap priorities back - Lambda rule gets higher priority (1), ECS gets lower (2)
      await elbv2.modifyRule({
        RuleArn: lambdaRule.RuleArn,
        Priority: 1,
      }).promise();

      await elbv2.modifyRule({
        RuleArn: ecsRule.RuleArn,
        Priority: 2,
      }).promise();

      console.log("Listener rule priorities swapped back - Lambda now has priority 1");
    }
  } catch (error) {
    console.log("Could not swap listener rule priorities:", error);
  }
}

async function waitForEcsTasksToDrain() {
  console.log("Waiting for ECS tasks to drain...");
  
  let attempts = 0;
  const maxAttempts = 60; // 10 minutes with 10 second intervals
  
  while (attempts < maxAttempts) {
    try {
      const service = await ecs.describeServices({
        cluster: process.env.ECS_CLUSTER_NAME,
        services: [process.env.ECS_SERVICE_NAME],
      }).promise();

      const runningCount = service.services && service.services[0] ? service.services[0].runningCount : 0;
      const desiredCount = service.services && service.services[0] ? service.services[0].desiredCount : 0;

      if (runningCount === 0 && desiredCount === 0) {
        console.log("All ECS tasks have been drained");
        break;
      }

      console.log(`ECS tasks: ${runningCount} running, ${desiredCount} desired`);
      
    } catch (error) {
      console.log("Error checking ECS service status:", error);
    }

    attempts++;
    if (attempts < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, 10000)); // Wait 10 seconds
    }
  }

  if (attempts >= maxAttempts) {
    console.warn("ECS tasks did not drain completely in time, proceeding anyway");
  }
}