import { ECSClient, UpdateServiceCommand, DescribeServicesCommand } from "@aws-sdk/client-ecs";
import { RDSClient, DescribeDBInstancesCommand, StopDBInstanceCommand } from "@aws-sdk/client-rds";
import { ElasticLoadBalancingV2Client, DescribeRulesCommand, ModifyRuleCommand } from "@aws-sdk/client-elastic-load-balancing-v2";

const ecsClient = new ECSClient();
const rdsClient = new RDSClient();
const elbv2Client = new ElasticLoadBalancingV2Client();

export const handler = async (event) => {
  try {
    console.log("Shutting down infrastructure...");

    // 1. Swap listener rule priorities back (Lambda gets priority 1, ECS gets priority 2)
    await swapListenerRulePriorities();

    // 2. Scale down ECS service to 0 desired count
    await ecsClient.send(new UpdateServiceCommand({
      cluster: process.env.ECS_CLUSTER_NAME,
      service: process.env.ECS_SERVICE_NAME,
      desiredCount: 0,
    }));

    console.log("ECS service scaled down to 0 desired count");

    // 3. Wait for ECS tasks to drain
    await waitForEcsTasksToDrain();

    // 4. Stop RDS instance (don't wait for it to be fully stopped)
    try {
      const dbInstance = await rdsClient.send(new DescribeDBInstancesCommand({
        DBInstanceIdentifier: process.env.RDS_INSTANCE_ID,
      }));

      if (dbInstance.DBInstances && dbInstance.DBInstances[0] && dbInstance.DBInstances[0].DBInstanceStatus === "available") {
        await rdsClient.send(new StopDBInstanceCommand({
          DBInstanceIdentifier: process.env.RDS_INSTANCE_ID,
        }));
        console.log("RDS instance stop initiated (not waiting for completion)");
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
      // Swap priorities back - Lambda rule gets higher priority (1), ECS gets lower (2)
      await elbv2Client.send(new ModifyRuleCommand({
        RuleArn: lambdaRule.RuleArn,
        Priority: 1,
      }));

      await elbv2Client.send(new ModifyRuleCommand({
        RuleArn: ecsRule.RuleArn,
        Priority: 2,
      }));

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
      const service = await ecsClient.send(new DescribeServicesCommand({
        cluster: process.env.ECS_CLUSTER_NAME,
        services: [process.env.ECS_SERVICE_NAME],
      }));

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