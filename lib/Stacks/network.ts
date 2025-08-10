import { Stack, StackProps, Duration, Environment } from 'aws-cdk-lib'
import { Construct } from 'constructs'
import {
  Certificate,
  CertificateValidation,
} from 'aws-cdk-lib/aws-certificatemanager'
import {
  Vpc,
  IpAddresses,
  SecurityGroup,
  Peer,
  Port,
  InstanceType,
  InstanceClass,
  InstanceSize,
} from 'aws-cdk-lib/aws-ec2'
import { PrivateDnsNamespace } from 'aws-cdk-lib/aws-servicediscovery'
import { HostedZone } from 'aws-cdk-lib/aws-route53'
import {
  ApplicationLoadBalancer,
  ApplicationProtocol,
  ApplicationTargetGroup,
  TargetType,
  ListenerAction,
  ApplicationListener,
} from 'aws-cdk-lib/aws-elasticloadbalancingv2'
import { FckNatInstanceProvider } from 'cdk-fck-nat'

interface NetworkStackProps extends StackProps {
  env: Environment
}

export class NetworkStack extends Stack {
  public readonly vpc: Vpc
  public readonly loadBalancerSecurityGroup: SecurityGroup
  public readonly loadBalancer: ApplicationLoadBalancer
  public readonly namespace: PrivateDnsNamespace
  public readonly hostedZone: HostedZone
  public readonly HttpListener: ApplicationListener
  public readonly HttpsListener: ApplicationListener
  public readonly defaultCert: Certificate
  public readonly targetGroup: ApplicationTargetGroup

  constructor(
    scope: Construct,
    id: string,
    props: NetworkStackProps,
  ) {
    super(scope, id, props)

    const totalAzs = this.availabilityZones.length

    const natGatewayProvider = new FckNatInstanceProvider({
      instanceType: InstanceType.of(InstanceClass.T4G, InstanceSize.MICRO),
    });

    //https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_ec2.Vpc.html
    this.vpc = new Vpc(
      this,
      `Application-VPC`,
      {
        vpcName: `Application-VPC`,
        ipAddresses: IpAddresses.cidr('172.18.0.0/16'),
        maxAzs: 2,
        natGatewayProvider: natGatewayProvider,
      },
    )

    natGatewayProvider.securityGroup.addIngressRule(Peer.ipv4(this.vpc.vpcCidrBlock), Port.allTraffic());

    //https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_ec2.SecurityGroup.html
    this.loadBalancerSecurityGroup = new SecurityGroup(
      this,
      `Application-LB-SG`,
      {
        description: 'security group for ALB',
        securityGroupName: `Application-LB-SG`,
        vpc: this.vpc,
        allowAllOutbound: true,
      },
    )

    this.loadBalancerSecurityGroup.addIngressRule(
      Peer.anyIpv4(),
      Port.tcp(80),
      'Allow HTTP traffic from anywhere',
    )
    this.loadBalancerSecurityGroup.addIngressRule(
      Peer.anyIpv4(),
      Port.tcp(443),
      'Allow HTTPS traffic from anywhere',
    )

    const zone = HostedZone.fromHostedZoneId(this, 'HostedZone', 'Z0993025RUBKU1TXRGB5')

    //https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_certificatemanager.Certificate.html
    this.defaultCert = new Certificate(this, 'certificate', {
      domainName: "*.scottgcooper.com",
      validation: CertificateValidation.fromDns(zone),
    })

    // https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_elasticloadbalancingv2.ApplicationLoadBalancer.html
    this.loadBalancer = new ApplicationLoadBalancer(
      this,
      `ApplicationLoadBalancer`,
      {
        loadBalancerName: `ApplicationLoadBalancer`,
        vpc: this.vpc,
        internetFacing: true,
        securityGroup: this.loadBalancerSecurityGroup,
      },
    )

    this.HttpListener = this.loadBalancer.addListener(
      'http-listener',
      {
        port: 80,
        protocol: ApplicationProtocol.HTTP,
        open: true,
        defaultAction: ListenerAction.redirect({
          protocol: ApplicationProtocol.HTTPS,
          port: '443',
          permanent: true,
        }),
      },
    )

    this.HttpsListener = this.loadBalancer.addListener(
      'https-listener',
      {
        port: 443,
        protocol: ApplicationProtocol.HTTPS,
        open: true,
        certificates: [this.defaultCert],
        // defaultTargetGroups: [testTargetGroup],
        defaultAction: ListenerAction.redirect({
          host: 'www.scottgcooper.com',
        }),
      },
    )

    this.targetGroup = new ApplicationTargetGroup(this, "TargetGroup", {
      vpc: this.vpc,
      port: 80,
      protocol: ApplicationProtocol.HTTP,
      targetType: TargetType.IP,
      healthCheck: {
        interval: Duration.seconds(30),
        path: "/",
        healthyHttpCodes: "200-302",
      },
    });

  }

}