#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { NetworkStack } from '../lib/Stacks/network';
import { ComputeStack } from '../lib/Stacks/compute';
import { DatabaseStack } from '../lib/Stacks/database';
import { AppStack } from '../lib/Stacks/app';

const app = new cdk.App();

const networkStack = new NetworkStack(app, 'NetworkStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});

const computeStack = new ComputeStack(app, 'ComputeStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
  vpc: networkStack.vpc,
  loadBalancerSecurityGroup: networkStack.loadBalancerSecurityGroup,
});

const databaseStack = new DatabaseStack(app, 'DatabaseStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
  vpc: networkStack.vpc,
  ecsSecurityGroup: computeStack.ecsSecurityGroup,
  hostedZone: networkStack.hostedZone,
});


const appStack = new AppStack(app, 'AppStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
  loadBalancer: networkStack.loadBalancer,
  vpc: networkStack.vpc,
  cluster: computeStack.cluster,
  ecsSecurityGroup: computeStack.ecsSecurityGroup,
  httpsListener: networkStack.HttpsListener,
  certificate: networkStack.defaultCert,
  dbInstance: databaseStack.databaseInstance,
  dbSecrets: databaseStack.dbSecrets,
  targetGroup: networkStack.targetGroup,
  lambdaTargetGroup: networkStack.lambdaTargetGroup,
});

appStack.addDependency(networkStack);
appStack.addDependency(computeStack);
appStack.addDependency(databaseStack);
