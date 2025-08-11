import { Construct } from "constructs";
import { BundlingFileAccess, BundlingOutput, DockerImage, Duration, SymlinkFollowMode } from "aws-cdk-lib";
import { Code, Runtime } from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { Role, ServicePrincipal, ManagedPolicy, PolicyDocument, Effect, PolicyStatement } from "aws-cdk-lib/aws-iam";
import * as path from "path";
import { ApplicationListenerRule, IApplicationListener } from "aws-cdk-lib/aws-elasticloadbalancingv2";
import { FargateService } from "aws-cdk-lib/aws-ecs";
import { Cluster } from "aws-cdk-lib/aws-ecs";
import { Function } from "aws-cdk-lib/aws-lambda"; // Changed from NodejsFunction

interface ShutDownServicesLambdaProps {
  projectName: string;
  ecsService: FargateService;
  cluster: Cluster;
  dbID: string;
  httpsListener: IApplicationListener;
  targetGroupArn: string;
  domainName: string;
}

export class ShutDownServicesLambda extends Construct {
  public readonly lambdaFunction: NodejsFunction;
  public readonly listenerRule: ApplicationListenerRule;

  constructor(scope: Construct, id: string, props: ShutDownServicesLambdaProps) {
    super(scope, id);
    // Create IAM role for the Lambda
    const lambdaRole = new Role(this, "ShutdownLambdaRole", {
      assumedBy: new ServicePrincipal("lambda.amazonaws.com"),
      managedPolicies: [
        ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaBasicExecutionRole"),
      ],
      inlinePolicies: {
        "ShutdownPermissions": new PolicyDocument({
          statements: [
            new PolicyStatement({
              effect: Effect.ALLOW,
              actions: [
                "ecs:UpdateService",
                "ecs:DescribeServices",
                "rds:StopDBInstance",
                "rds:DescribeDBInstances",
                "elasticloadbalancing:ModifyListenerRule",
                "elasticloadbalancing:DescribeListenerRules",
                "elasticloadbalancing:DescribeListeners"
              ],
              resources: ["*"],
            }),
          ],
        }),
      },
    });

    // Create the Lambda function
    this.lambdaFunction = new Function(this, "ShutdownFunction", {
      runtime: Runtime.NODEJS_LATEST,
      handler: "lambda.handler",
      code: Code.fromAsset(path.join(__dirname, "../../lambdas/shutdown"), {
        bundling: {
          command: ['sh', '-c', 'apt-get update && apt-get install -y zip && NODE_ENV=production npm install && zip -r /asset-output/function.zip .'],
          image: DockerImage.fromRegistry('public.ecr.aws/docker/library/node:20.12.1'),
          user: 'root',
          bundlingFileAccess: BundlingFileAccess.VOLUME_COPY,
          outputType: BundlingOutput.ARCHIVED,
        },
        followSymlinks: SymlinkFollowMode.ALWAYS,
      }),      role: lambdaRole,
      timeout: Duration.minutes(5),
      environment: {
        ECS_SERVICE_NAME: props.ecsService.serviceName,
        ECS_CLUSTER_NAME: props.ecsService.cluster.clusterName,
        RDS_INSTANCE_ID: props.dbID,
        LISTENER_ARN: props.httpsListener.listenerArn,
        DOMAIN_NAME: props.domainName,
      },
    });

  }
}