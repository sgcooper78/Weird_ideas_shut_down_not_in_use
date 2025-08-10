import { Environment, Stack, StackProps } from 'aws-cdk-lib'
import { Construct } from 'constructs'
import { CapacityProviderStrategy, Cluster } from 'aws-cdk-lib/aws-ecs'
import {
  KeyPair,
  KeyPairType,
  SecurityGroup,
  Vpc,
  Port,
} from 'aws-cdk-lib/aws-ec2'

interface ComputeStackProps extends StackProps {
  vpc: Vpc
  loadBalancerSecurityGroup: SecurityGroup
  env: Environment
}

export class ComputeStack extends Stack {
  public readonly keyPair: KeyPair
  public readonly ecsSecurityGroup: SecurityGroup
  public readonly cluster: Cluster

  constructor(
    scope: Construct,
    id: string,
    props: ComputeStackProps,
  ) {
    super(scope, id, props)

    //https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_ecs.Cluster.html
    this.cluster = new Cluster(
      this,
      `Application`,
      {
        vpc: props.vpc,
        clusterName: `Application`,
        enableFargateCapacityProviders: true,
      },
    )

    const defaultCapacityProviderStrategy: CapacityProviderStrategy[] = [
      {
        capacityProvider: 'FARGATE_SPOT',
        weight: 1,
      },
      // {
      //   capacityProvider: 'FARGATE',
      //   weight: 1,
      // },
    ];

    // Add the default capacity provider strategy to the cluster
    this.cluster.addDefaultCapacityProviderStrategy(defaultCapacityProviderStrategy);


    //https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_ec2.KeyPair.html
    this.keyPair = new KeyPair(
      this,
      `Application-key-pair`,
      {
        keyPairName: `Application-key-pair`,
        type: KeyPairType.RSA,
      },
    )

    //https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_ec2.SecurityGroup.html
    this.ecsSecurityGroup = new SecurityGroup(
      this,
      `Application-ECS-SG`,
      {
        description: 'security group for ECS',
        securityGroupName: `Application-ECS-SG`,
        vpc: props.vpc,
        allowAllOutbound: true,
      },
    )

    // Allow HTTP traffic from the LoadBalancer security group
    this.ecsSecurityGroup.addIngressRule(
      props.loadBalancerSecurityGroup,
      Port.tcp(80),
      'Allow HTTP traffic from the LoadBalancer security group',
    )

    // Allow HTTP Traffic from itself (if needed for service discovery)
    this.ecsSecurityGroup.addIngressRule(
      this.ecsSecurityGroup,
      Port.tcp(80),
      'Allow HTTP traffic from itself',
    )
    
  }
}