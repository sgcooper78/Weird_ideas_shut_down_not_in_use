import { Stack, StackProps, Duration, RemovalPolicy, Environment } from 'aws-cdk-lib'
import { Construct } from 'constructs'
import {
  CaCertificate,
  DatabaseInstance,
  DatabaseInstanceEngine,
  DatabaseInstanceFromSnapshot,
  MariaDbEngineVersion,
  OptionGroup,
  ParameterGroup,
  StorageType,
} from 'aws-cdk-lib/aws-rds'
import { Secret } from 'aws-cdk-lib/aws-secretsmanager'
import {
  KeyPair,
  KeyPairType,
  SecurityGroup,
  Vpc,
  Port,
  InstanceType,
  InstanceClass,
  InstanceSize,
} from 'aws-cdk-lib/aws-ec2'
import { Topic } from 'aws-cdk-lib/aws-sns'
import { Credentials } from 'aws-cdk-lib/aws-rds'
import { HostedZone, RecordTarget } from 'aws-cdk-lib/aws-route53'
import {
  Alarm,
  ComparisonOperator,
  TreatMissingData,
  Metric,
} from 'aws-cdk-lib/aws-cloudwatch'
import { RecordSet, RecordType } from 'aws-cdk-lib/aws-route53'
import { SnsAction } from 'aws-cdk-lib/aws-cloudwatch-actions'

interface DatabaseStackProps extends StackProps {
  vpc: Vpc
  ecsSecurityGroup: SecurityGroup
  hostedZone: HostedZone
  snapshotArn?: string
  rdsPort?: number
  env: Environment
}

export class DatabaseStack extends Stack {
  public readonly rdsSecurityGroup: SecurityGroup
  public readonly databaseInstance: DatabaseInstance
  public readonly instanceType: InstanceType
  public readonly privateZoneRecordSet: RecordSet
  public readonly dbSecrets: Secret

  constructor(
    scope: Construct,
    id: string,
    props: DatabaseStackProps,
  ) {
    super(scope, id, props)

      const RDSSecret = new Secret(this, 'RDSSecret', {
        generateSecretString: {
          secretStringTemplate: JSON.stringify({ username: 'admin' }),
          generateStringKey: 'password',
          excludeCharacters: '/@"',
        },
      })

    // Security group for RDS
    this.rdsSecurityGroup = new SecurityGroup(
      this,
      `Application-RDS`,
      {
        description: 'security group for RDS',
        securityGroupName: `Application-RDS`,
        vpc: props.vpc,
        allowAllOutbound: true,
      },
    )

    this.rdsSecurityGroup.addIngressRule(
      props.ecsSecurityGroup,
      Port.tcp(3306),
      'Allow connections from ecs',
    )

      this.databaseInstance = new DatabaseInstance(
        this,
        `Application`,
        {
          instanceIdentifier: `Application-RDS`,
          instanceType: InstanceType.of(InstanceClass.T3, InstanceSize.MICRO),
          allocatedStorage: 30,
          multiAz: false,
          engine: DatabaseInstanceEngine.mariaDb({
            version: MariaDbEngineVersion.VER_10_11_13,
          }),
          securityGroups: [this.rdsSecurityGroup],
          credentials: Credentials.fromSecret(RDSSecret),
          vpc: props.vpc,
          port: props.rdsPort ? props.rdsPort : 3306,
          autoMinorVersionUpgrade: true,
          preferredBackupWindow: '05:00-06:00',
          monitoringInterval: Duration.seconds(60),
          storageType: StorageType.GP3,
          caCertificate: CaCertificate.RDS_CA_ECC384_G1,
          enablePerformanceInsights: false,
          removalPolicy: RemovalPolicy.DESTROY,
        },
      )

  }
}