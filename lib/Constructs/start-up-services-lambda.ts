import { Construct } from "constructs";
import { BundlingFileAccess, BundlingOutput, DockerImage, Duration, SymlinkFollowMode } from "aws-cdk-lib";
import { Code, Runtime } from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { Role, ServicePrincipal, ManagedPolicy, PolicyDocument, Effect, PolicyStatement } from "aws-cdk-lib/aws-iam";
import * as path from "path";
import { ApplicationListenerRule, ApplicationTargetGroup, IApplicationListener, ListenerAction, ListenerCondition } from "aws-cdk-lib/aws-elasticloadbalancingv2";
import { LambdaTarget } from "aws-cdk-lib/aws-elasticloadbalancingv2-targets";
import { Cluster, IFargateService } from "aws-cdk-lib/aws-ecs";
import { Function } from "aws-cdk-lib/aws-lambda";

interface StartUpServicesLambdaProps {
  projectName: string;
  ecsService: IFargateService;
  listener: IApplicationListener
  domainName: string;
  dbID: string;
  cluster: Cluster;
  targetGroup: ApplicationTargetGroup;
}

export class StartUpServicesLambda extends Construct {
  public readonly lambdaFunction: NodejsFunction;
  public readonly listenerRule: ApplicationListenerRule;

  constructor(scope: Construct, id: string, props: StartUpServicesLambdaProps) {
    super(scope, id);
    // Create IAM role for the Lambda
    const lambdaRole = new Role(this, "StartupLambdaRole", {
      assumedBy: new ServicePrincipal("lambda.amazonaws.com"),
      managedPolicies: [
        ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaBasicExecutionRole"),
      ],
      inlinePolicies: {
        "StartupPermissions": new PolicyDocument({
          statements: [
            new PolicyStatement({
              effect: Effect.ALLOW,
              actions: [
                "ecs:UpdateService",
                "ecs:DescribeServices",
                "ecs:DescribeTasks",
                "ecs:ListTasks",
                "rds:StartDBInstance",
                "rds:DescribeDBInstances",
                "rds:DescribeDBClusters",
                "elasticloadbalancing:ModifyRule",
                "elasticloadbalancing:DescribeRules",
                "elasticloadbalancing:DescribeListeners",
                "elasticloadbalancing:DescribeLoadBalancers",
                "elasticloadbalancing:DescribeTargetGroups",
                "elasticloadbalancing:DescribeTargetHealth"
              ],
              resources: ["*"],
            }),
          ],
        }),
      },
    });

    // Create the Lambda function
    this.lambdaFunction = new Function(this, "StartupFunction", {
      runtime: Runtime.NODEJS_LATEST,
      handler: "lambda.handler",
      code: Code.fromAsset(path.join(__dirname, "../../lambdas/startup/")),
      // code: Code.fromAsset(path.join(__dirname, "../../lambdas/startup"), {
      //   bundling: {
      //     command: ['sh', '-c', 'apt-get update && apt-get install -y zip && NODE_ENV=production npm install && zip -r /asset-output/function.zip .'],
      //     image: DockerImage.fromRegistry('public.ecr.aws/docker/library/node:20.12.1'),
      //     user: 'root',
      //     bundlingFileAccess: BundlingFileAccess.VOLUME_COPY,
      //     outputType: BundlingOutput.ARCHIVED,
      //   },
      //   followSymlinks: SymlinkFollowMode.ALWAYS,
      // }),
      role: lambdaRole,
      timeout: Duration.minutes(5),
      environment: {
        ECS_SERVICE_NAME: props.ecsService.serviceName,
        ECS_CLUSTER_NAME: props.cluster.clusterName,
        RDS_INSTANCE_ID: props.dbID,
        DOMAIN_NAME: props.domainName,
      },
    });

    // props.targetGroup.addTarget(new LambdaTarget(this.lambdaFunction));

    // props.listener.addAction("RedirectToLambda", {
    //   priority: 2,
    //   action: ListenerAction.forward([props.targetGroup]),
    //   conditions: [
    //     ListenerCondition.hostHeaders([`${props.domainName}`]),
    //   ],
    // });
  }
}