import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { EventDrivenOrdersStack } from '../lib/event-driven-stack';

test('Stack creates core resources', () => {
  const app = new cdk.App();
  const stack = new EventDrivenOrdersStack(app, 'TestStack');

  const template = Template.fromStack(stack);

  // Three Lambda functions: API + worker + log retention custom resource
  template.resourceCountIs('AWS::Lambda::Function', 3);

  // Two SQS queues: main + DLQ
  template.resourceCountIs('AWS::SQS::Queue', 2);

  // One EventBridge EventBus
  template.resourceCountIs('AWS::Events::EventBus', 1);

  // One DynamoDB table
  template.resourceCountIs('AWS::DynamoDB::Table', 1);
});
