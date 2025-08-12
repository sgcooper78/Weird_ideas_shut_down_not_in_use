import { Construct } from "constructs";
import { Environment } from "aws-cdk-lib";
import { Cluster } from "aws-cdk-lib/aws-ecs";
import { SecurityGroup, Vpc } from "aws-cdk-lib/aws-ec2";
import { Duration, Stack, StackProps } from "aws-cdk-lib";
import { EcsService } from "../Constructs/ecs-service";
import {
  ApplicationListener,
  ApplicationLoadBalancer,
  ApplicationTargetGroup,
  Protocol,
} from "aws-cdk-lib/aws-elasticloadbalancingv2";
import { Certificate } from "aws-cdk-lib/aws-certificatemanager";
import { Secret } from "aws-cdk-lib/aws-secretsmanager";
import { Alarm, ComparisonOperator, TreatMissingData, Metric } from "aws-cdk-lib/aws-cloudwatch";
import { LambdaAction } from "aws-cdk-lib/aws-cloudwatch-actions";
import { ShutDownServicesLambda } from "../Constructs/shut-down-services-lambda";
import { StartUpServicesLambda } from "../Constructs/start-up-services-lambda";
import { DatabaseInstance } from "aws-cdk-lib/aws-rds";

interface AppStackProps extends StackProps {
  loadBalancer: ApplicationLoadBalancer;
  vpc: Vpc;
  cluster: Cluster;
  ecsSecurityGroup: SecurityGroup;
  httpsListener: ApplicationListener;
  certificate: Certificate;
  dbInstance: DatabaseInstance;
  env: Environment
  dbSecrets: Secret;
  targetGroup: ApplicationTargetGroup;
  lambdaTargetGroup: ApplicationTargetGroup;
}

export class AppStack extends Stack {
  public ecsService: EcsService;
  public idleAlarm: Alarm;
  public shutdownLambda: ShutDownServicesLambda;
  public startupLambda: StartUpServicesLambda;

  constructor(scope: Construct, id: string, props: AppStackProps) {
    super(scope, id, props);

    this.ecsService = new EcsService(this, "EcsWebService", {
      cluster: props.cluster,
      loadBalancer: props.loadBalancer,
      projectName: "phpmyadmin",
      targetGroup: props.targetGroup,
      vpc: props.vpc,
      domainName: 'db.scottgcooper.com',
      targetGroupHealthCheck: {
        enabled: true,
        healthyHttpCodes: "200-399",
        path: "/",
        port: "80",
        protocol: Protocol.HTTP,
        timeout: Duration.seconds(5),
      },
      ecsSecurityGroup: props.ecsSecurityGroup,
      listener: props.httpsListener,
      memoryLimit: 1024,
      cpu: 512,
      ecsEnvironment: {
        PMA_HOST: props.dbInstance.dbInstanceEndpointAddress,
      },
    });

    this.shutdownLambda = new ShutDownServicesLambda(this, "ShutdownLambda", {
      cluster: props.cluster,
      ecsService: this.ecsService.ecsService,
      dbID: props.dbInstance.instanceIdentifier,
      httpsListener: props.httpsListener,
      targetGroupArn: props.targetGroup.targetGroupArn,
      domainName: 'db.scottgcooper.com',
      projectName: "phpmyadmin",
    });

    this.startupLambda = new StartUpServicesLambda(this, "StartupLambda", {
      cluster: props.cluster,
      ecsService: this.ecsService.ecsService,
      httpsListener: props.httpsListener,
      domainName: 'db.scottgcooper.com',
      projectName: "phpmyadmin",
      dbID: props.dbInstance.instanceIdentifier,
      targetGroup: props.lambdaTargetGroup,
    });
    
    // Create CloudWatch alarm for 15 minutes of inactivity
    this.idleAlarm = new Alarm(this, "IdleAlarm", {
      alarmName: "ecs-service-idle-alarm",
      alarmDescription: "Triggers when no requests for 15 minutes - shutdown infrastructure",
      metric: new Metric({
        namespace: 'AWS/ApplicationELB',
        metricName: 'RequestCount',
        dimensionsMap: {
          TargetGroup: props.targetGroup.targetGroupName,
          LoadBalancer: props.loadBalancer.loadBalancerName,
        },
        statistic: 'Sum',
        period: Duration.minutes(1),
      }),
      threshold: 0,
      evaluationPeriods: 15, // 15 consecutive 1-minute periods
      datapointsToAlarm: 15, // All 15 periods must have 0 requests
      treatMissingData: TreatMissingData.NOT_BREACHING,
      comparisonOperator: ComparisonOperator.LESS_THAN_OR_EQUAL_TO_THRESHOLD,
    });

    // Add Lambda action directly to the alarm
    this.idleAlarm.addAlarmAction(new LambdaAction(this.shutdownLambda.lambdaFunction));
  }
}