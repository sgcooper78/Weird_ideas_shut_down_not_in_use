import { ECSClient, UpdateServiceCommand } from "@aws-sdk/client-ecs";
import { RDSClient, DescribeDBInstancesCommand, StopDBInstanceCommand } from "@aws-sdk/client-rds";
import { ElasticLoadBalancingV2Client, DescribeRulesCommand, ModifyRuleCommand } from "@aws-sdk/client-elastic-load-balancing-v2";

const ecsClient = new ECSClient();
const rdsClient = new RDSClient();
const elbv2Client = new ElasticLoadBalancingV2Client();

export const handler = async (event) => {
  try {
    console.log("Shutting down infrastructure...");

    // 1. Set ECS service desired count to 0 (don't wait)
    await ecsClient.send(new UpdateServiceCommand({
      cluster: process.env.ECS_CLUSTER_NAME,
      service: process.env.ECS_SERVICE_NAME,
      desiredCount: 0,
    }));
    console.log("ECS service desired count set to 0");

    // 2. Stop RDS instance if it's running (don't wait)
    try {
      const dbInstance = await rdsClient.send(new DescribeDBInstancesCommand({
        DBInstanceIdentifier: process.env.RDS_INSTANCE_ID,
      }));

      if (dbInstance.DBInstances && dbInstance.DBInstances[0] && dbInstance.DBInstances[0].DBInstanceStatus === "available") {
        await rdsClient.send(new StopDBInstanceCommand({
          DBInstanceIdentifier: process.env.RDS_INSTANCE_ID,
        }));
        console.log("RDS instance stop initiated");
      } else {
        console.log("RDS instance is already stopped or in another state");
      }
    } catch (error) {
      console.log("Could not stop RDS instance:", error);
    }

    // 3. Swap listener rule priorities (Lambda gets priority 1, ECS gets priority 2)
    await swapListenerRulePriorities();

    console.log("Infrastructure shutdown initiated successfully");

  } catch (error) {
    console.error("Error shutting down infrastructure:", error);
    throw error;
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
      
      // Clean up conditions to remove duplicate Values
      const cleanLambdaConditions = lambdaRule.Conditions.map(condition => {
        if (condition.Field === 'host-header') {
          return {
            Field: condition.Field,
            HostHeaderConfig: condition.HostHeaderConfig
          };
        }
        return condition;
      });

      const cleanEcsConditions = ecsRule.Conditions.map(condition => {
        if (condition.Field === 'host-header') {
          return {
            Field: condition.Field,
            HostHeaderConfig: condition.HostHeaderConfig
          };
        }
        return condition;
      });
      
      // Swap priorities - Lambda rule gets higher priority (1), ECS gets lower (2)
      await elbv2Client.send(new ModifyRuleCommand({
        RuleArn: lambdaRule.RuleArn,
        Priority: 1, // Use integer priority
        Conditions: cleanLambdaConditions,
        Actions: lambdaRule.Actions,
      }));

      await elbv2Client.send(new ModifyRuleCommand({
        RuleArn: ecsRule.RuleArn,
        Priority: 2, // Use integer priority
        Conditions: cleanEcsConditions,
        Actions: ecsRule.Actions,
      }));

      console.log("Listener rule priorities swapped - Lambda now has priority 1, ECS has priority 2");
      
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
      
    } else {
      console.log("Could not find both Lambda and ECS rules");
    }
  } catch (error) {
    console.log("Could not swap listener rule priorities:", error);
  }
}