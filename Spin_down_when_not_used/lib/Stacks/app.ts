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

interface AppStackProps extends StackProps {
  loadBalancer: ApplicationLoadBalancer;
  vpc: Vpc;
  cluster: Cluster;
  ecsSecurityGroup: SecurityGroup;
  httpsListener: ApplicationListener;
  certificate: Certificate;
  dbHost: string;
  env: Environment
  dbSecrets: Secret;
  targetGroup: ApplicationTargetGroup;
}

export class AppStack extends Stack {
  public ecsService: EcsService;
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
        PMA_HOST: props.dbHost,
      },
    });

  }
}