import { Construct } from "constructs";
import { Duration } from "aws-cdk-lib";
import { Code, Runtime } from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { Role, ServicePrincipal, ManagedPolicy, PolicyDocument, Effect, PolicyStatement } from "aws-cdk-lib/aws-iam";
import * as path from "path";
import { ApplicationListenerRule, ApplicationTargetGroup, IApplicationListener } from "aws-cdk-lib/aws-elasticloadbalancingv2";
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
        this.lambdaFunction = new Function(this, "StartupFunction", {
            runtime: Runtime.NODEJS_22_X,
            handler: "handler",
            code: Code.fromAsset(path.join(__dirname, "../../lambdas/startup")),
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
    }
}