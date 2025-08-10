import { Construct } from "constructs";
import { Duration } from "aws-cdk-lib";
import {
  Role,
  ServicePrincipal,
  ManagedPolicy,
  PolicyDocument,
  PolicyStatement,
  Effect,
} from "aws-cdk-lib/aws-iam";
import { BuildEnvironmentVariable } from "aws-cdk-lib/aws-codebuild";
import {
  ContainerDependencyCondition,
  ContainerImage,
  CpuArchitecture,
  FargateService,
  FargateTaskDefinition,
  HealthCheck,
  ICluster,
  LogDriver,
  OperatingSystemFamily,
  Secret,
} from "aws-cdk-lib/aws-ecs";
import { ISecurityGroup, IVpc } from "aws-cdk-lib/aws-ec2";
import {
  ApplicationListenerRule,
  ApplicationProtocol,
  ApplicationTargetGroup,
  IApplicationListener,
  IApplicationLoadBalancer,
  ListenerAction,
  ListenerCondition,
  TargetType,
} from "aws-cdk-lib/aws-elasticloadbalancingv2";
import { HealthCheck as ec2HealthCheck } from "aws-cdk-lib/aws-elasticloadbalancingv2";
import { aws_secretsmanager } from "aws-cdk-lib";
import { Repository } from "aws-cdk-lib/aws-ecr";
import { DockerImageAsset, Platform } from "aws-cdk-lib/aws-ecr-assets";
import * as fs from "fs";
import * as path from "path";
import { Bucket } from "aws-cdk-lib/aws-s3";

interface EcsServiceProps {
  projectName: string;
  cluster: ICluster;
  vpc: IVpc;
  memoryLimit?: number;
  desiredCount?: number;
  cpu?: number;
  loadBalancer: IApplicationLoadBalancer;
  ecsEnvironment?: { [key: string]: string };
  ecsSecrets?: { [key: string]: Secret };
  idleTimeout?: Duration;
  domainName: string;
  healthCheckGracePeriod?: Duration;
  targetGroupHealthCheck: ec2HealthCheck;
  ecsSecurityGroup: ISecurityGroup;
  buildEnvVariables?: { [name: string]: BuildEnvironmentVariable };
  listener: IApplicationListener;
  ecrRepo?: Repository;
  targetGroup: ApplicationTargetGroup;
}

export class EcsService extends Construct {
  public readonly taskDefinition: FargateTaskDefinition;
  public readonly ApplicationListenerRule: ApplicationListenerRule;
  public readonly ecsService: FargateService;

  constructor(scope: Construct, id: string, props: EcsServiceProps) {
    super(scope, id);

    // Define the task role
    const taskRole = new Role(this, "ECSTaskRole", {
      assumedBy: new ServicePrincipal("ecs-tasks.amazonaws.com"),
      managedPolicies: [
        ManagedPolicy.fromAwsManagedPolicyName(
          "service-role/AmazonECSTaskExecutionRolePolicy",
        ),
      ],
    });

    // Define the execution role
    const executionRole = new Role(this, "ECSExecutionRole", {
      assumedBy: new ServicePrincipal("ecs-tasks.amazonaws.com"),
      managedPolicies: [
        ManagedPolicy.fromAwsManagedPolicyName(
          "service-role/AmazonECSTaskExecutionRolePolicy",
        ),
      ],
      inlinePolicies: {
        "AWS-Task-Logging": new PolicyDocument({
          statements: [
            new PolicyStatement({
              actions: ["logs:CreateLogGroup"],
              resources: ["*"],
              effect: Effect.ALLOW,
            }),
          ],
        }),
      },
    });

    this.taskDefinition = new FargateTaskDefinition(this, "TaskDefinition", {
      memoryLimitMiB: props.memoryLimit ?? 1024,
      cpu: props.cpu ?? 512,
      executionRole: executionRole,
      taskRole: taskRole,
      family: props.projectName,
      runtimePlatform: {
        cpuArchitecture: CpuArchitecture.ARM64,
        operatingSystemFamily: OperatingSystemFamily.LINUX,
      },
    });

    this.taskDefinition.addContainer("WebContainer", {
      containerName: props.projectName,
      image: ContainerImage.fromRegistry('phpmyadmin:latest'),
      memoryLimitMiB: props.memoryLimit
        ? props.memoryLimit
        : 1024,
      cpu: props.cpu ? props.cpu : 512,
      secrets: props.ecsSecrets,
      environment: props.ecsEnvironment,
      logging: LogDriver.awsLogs({
        streamPrefix: props.projectName,
      }),

      portMappings: [
        {
          containerPort: 80,
          hostPort: 80,
        },
      ],

    });

    this.ecsService = new FargateService(this, "EcsService", {
      cluster: props.cluster,
      taskDefinition: this.taskDefinition,
      securityGroups: [props.ecsSecurityGroup],
      assignPublicIp: false,
      desiredCount: props.desiredCount,
      enableExecuteCommand: true,
      healthCheckGracePeriod:
        props.healthCheckGracePeriod ?? Duration.seconds(60),
      serviceName: props.projectName,
      vpcSubnets: {
        subnets: props.vpc.privateSubnets,
      },

    });

    props.targetGroup.addTarget(this.ecsService);

    props.listener.addAction("Redirect", {
      priority: 2,
      action: ListenerAction.forward([props.targetGroup]),
      conditions: [
        ListenerCondition.hostHeaders([`${props.domainName}`]),
      ],
    });
  }
}