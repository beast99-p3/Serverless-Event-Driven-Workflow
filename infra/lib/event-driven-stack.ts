import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import {
  aws_apigateway as apigw,
  aws_dynamodb as dynamodb,
  aws_events as events,
  aws_events_targets as targets,
  aws_lambda as lambda,
  aws_lambda_nodejs as lambdaNodejs,
  aws_lambda_event_sources as lambdaEventSources,
  aws_logs as logs,
  aws_sqs as sqs,
  aws_cloudwatch as cloudwatch
} from 'aws-cdk-lib';

export class EventDrivenOrdersStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // EventBridge EventBus
    const eventBus = new events.EventBus(this, 'OrdersEventBus', {
      eventBusName: 'orders-event-bus'
    });

    // DynamoDB table for idempotency (PK = eventId, TTL enabled)
    const idempotencyTable = new dynamodb.Table(this, 'OrdersIdempotencyTable', {
      tableName: 'orders-idempotency',
      partitionKey: {
        name: 'eventId',
        type: dynamodb.AttributeType.STRING
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'expiresAt',
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      removalPolicy: cdk.RemovalPolicy.DESTROY
    });

    // SQS DLQ
    const dlq = new sqs.Queue(this, 'OrdersDlq', {
      queueName: 'orders-dlq',
      retentionPeriod: cdk.Duration.days(14),
      encryption: sqs.QueueEncryption.SQS_MANAGED
    });

    // SQS main queue
    const mainQueue = new sqs.Queue(this, 'OrdersMainQueue', {
      queueName: 'orders-main-queue',
      visibilityTimeout: cdk.Duration.seconds(180), // >= 6x worker timeout (30s)
      deadLetterQueue: {
        queue: dlq,
        maxReceiveCount: 5
      },
      encryption: sqs.QueueEncryption.SQS_MANAGED
    });

    // API Lambda - validates and publishes OrderCreated events
    const apiFunction = new lambdaNodejs.NodejsFunction(this, 'ApiLambda', {
      functionName: 'orders-api',
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, '../../services/api/handler.ts'),
      handler: 'handler',
      memorySize: 256,
      timeout: cdk.Duration.seconds(10),
      logRetention: logs.RetentionDays.TWO_WEEKS,
      environment: {
        EVENT_BUS_NAME: eventBus.eventBusName
      },
      bundling: {
        externalModules: ['aws-sdk'],
        minify: true,
        target: 'node20'
      }
    });

    // Grant API Lambda permission to put events onto the custom bus
    eventBus.grantPutEventsTo(apiFunction);

    // API Gateway REST API with CORS enabled so browser frontends can call it
    const api = new apigw.RestApi(this, 'OrdersApi', {
      restApiName: 'Orders Service',
      deployOptions: {
        stageName: 'prod',
        metricsEnabled: true,
        loggingLevel: apigw.MethodLoggingLevel.INFO,
        dataTraceEnabled: false
      },
      defaultCorsPreflightOptions: {
        allowOrigins: apigw.Cors.ALL_ORIGINS,
        allowMethods: apigw.Cors.ALL_METHODS,
        allowHeaders: ['Content-Type']
      }
    });

    const ordersResource = api.root.addResource('orders');
    ordersResource.addMethod('POST', new apigw.LambdaIntegration(apiFunction), {
      methodResponses: [
        {
          statusCode: '202'
        },
        {
          statusCode: '400'
        },
        {
          statusCode: '500'
        }
      ]
    });

    // Worker Lambda - processes orders from SQS with idempotency
    const workerFunction = new lambdaNodejs.NodejsFunction(this, 'WorkerLambda', {
      functionName: 'orders-worker',
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, '../../services/worker/handler.ts'),
      handler: 'handler',
      memorySize: 256,
      timeout: cdk.Duration.seconds(30),
      logRetention: logs.RetentionDays.TWO_WEEKS,
      environment: {
        TABLE_NAME: idempotencyTable.tableName,
        TTL_DAYS: '7'
      },
      bundling: {
        externalModules: ['aws-sdk'],
        minify: true,
        target: 'node20'
      }
    });

    // Grant Worker Lambda permission to read/write DynamoDB idempotency table
    idempotencyTable.grantReadWriteData(workerFunction);

    // SQS -> Lambda event source with partial batch response enabled
    workerFunction.addEventSource(
      new lambdaEventSources.SqsEventSource(mainQueue, {
        batchSize: 5,
        reportBatchItemFailures: true
      })
    );

    // EventBridge rule to route OrderCreated events to SQS main queue
    const orderCreatedRule = new events.Rule(this, 'OrderCreatedRule', {
      eventBus,
      ruleName: 'order-created-to-sqs',
      eventPattern: {
        source: ['myapp.orders'],
        detailType: ['OrderCreated']
      }
    });

    orderCreatedRule.addTarget(new targets.SqsQueue(mainQueue));

    // CloudWatch Alarms

    // DLQ has any visible messages
    const dlqVisibleMessagesAlarm = new cloudwatch.Alarm(this, 'DlqVisibleMessagesAlarm', {
      alarmName: 'OrdersDlqMessagesVisibleAlarm',
      alarmDescription: 'Triggered when DLQ has visible messages (failed order processing).',
      metric: dlq.metricApproximateNumberOfMessagesVisible(),
      threshold: 0,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD
    });

    // Worker Lambda errors
    const workerErrorsAlarm = new cloudwatch.Alarm(this, 'WorkerErrorsAlarm', {
      alarmName: 'OrdersWorkerErrorsAlarm',
      alarmDescription: 'Triggered when Worker Lambda records errors.',
      metric: workerFunction.metricErrors({
        period: cdk.Duration.minutes(5)
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD
    });

    // Optional: Age of oldest message in main queue
    const mainQueueAgeAlarm = new cloudwatch.Alarm(this, 'MainQueueAgeAlarm', {
      alarmName: 'OrdersMainQueueAgeAlarm',
      alarmDescription: 'Triggered when main queue messages are getting old.',
      metric: mainQueue.metricApproximateAgeOfOldestMessage(),
      threshold: 300,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD
    });

    // Avoid unused variable warnings
    void dlqVisibleMessagesAlarm;
    void workerErrorsAlarm;
    void mainQueueAgeAlarm;

    // CloudWatch Dashboard
    const dashboard = new cloudwatch.Dashboard(this, 'OrdersDashboard', {
      dashboardName: 'OrdersEventDrivenDashboard'
    });

    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'API Lambda Invocations / Errors',
        left: [apiFunction.metricInvocations()],
        right: [apiFunction.metricErrors()]
      }),
      new cloudwatch.GraphWidget({
        title: 'Worker Lambda Invocations / Errors / Duration',
        left: [workerFunction.metricInvocations(), workerFunction.metricErrors()],
        right: [workerFunction.metricDuration()]
      }),
      new cloudwatch.GraphWidget({
        title: 'Main Queue Visible / Age Of Oldest',
        left: [mainQueue.metricApproximateNumberOfMessagesVisible()],
        right: [mainQueue.metricApproximateAgeOfOldestMessage()]
      }),
      new cloudwatch.GraphWidget({
        title: 'DLQ Visible Messages',
        left: [dlq.metricApproximateNumberOfMessagesVisible()]
      })
    );

    // Stack Outputs for quick testing
    new cdk.CfnOutput(this, 'ApiEndpoint', {
      value: api.url,
      description: 'Base URL of the Orders API Gateway endpoint'
    });

    new cdk.CfnOutput(this, 'EventBusName', {
      value: eventBus.eventBusName,
      description: 'Name of the custom EventBridge EventBus'
    });

    new cdk.CfnOutput(this, 'MainQueueUrl', {
      value: mainQueue.queueUrl,
      description: 'URL of the main orders SQS queue'
    });

    new cdk.CfnOutput(this, 'DlqUrl', {
      value: dlq.queueUrl,
      description: 'URL of the DLQ for failed orders'
    });

    new cdk.CfnOutput(this, 'DynamoTableName', {
      value: idempotencyTable.tableName,
      description: 'Name of the DynamoDB idempotency table'
    });
  }
}
