import { SQSEvent, SQSBatchResponse, SQSRecord } from 'aws-lambda';
import {
  DynamoDBClient,
  PutItemCommand,
  ConditionalCheckFailedException
} from '@aws-sdk/client-dynamodb';

const TABLE_NAME = process.env.TABLE_NAME;
const TTL_DAYS = parseInt(process.env.TTL_DAYS || '7', 10);

if (!TABLE_NAME) {
  console.error(
    JSON.stringify({
      level: 'error',
      msg: 'Missing TABLE_NAME environment variable'
    })
  );
}

const dynamoClient = new DynamoDBClient({});

interface OrderItem {
  sku: string;
  qty: number;
}

interface OrderCreatedDetail {
  schemaVersion: string;
  eventId: string;
  orderId: string;
  createdAt: string;
  customerId?: string;
  items: OrderItem[];
}

interface EventBridgeEnvelope {
  id: string;
  source: string;
  'detail-type': string;
  detail: OrderCreatedDetail;
  [key: string]: any;
}

function parseEventBridgeEnvelope(record: SQSRecord): EventBridgeEnvelope {
  if (!record.body) {
    throw new Error('SQS message body is empty');
  }

  let envelope: any;
  try {
    envelope = JSON.parse(record.body);
  } catch {
    throw new Error('Failed to parse SQS message body as JSON');
  }

  if (!envelope.detail || !envelope['detail-type'] || !envelope.source) {
    throw new Error('SQS message does not contain a valid EventBridge envelope');
  }

  return envelope as EventBridgeEnvelope;
}

async function recordIdempotency(detail: OrderCreatedDetail): Promise<'new' | 'duplicate'> {
  if (!TABLE_NAME) {
    throw new Error('TABLE_NAME is not configured');
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  const ttlSeconds = nowSeconds + TTL_DAYS * 24 * 60 * 60;

  const command = new PutItemCommand({
    TableName: TABLE_NAME,
    Item: {
      eventId: { S: detail.eventId },
      orderId: { S: detail.orderId },
      createdAt: { S: detail.createdAt },
      expiresAt: { N: ttlSeconds.toString() }
    },
    ConditionExpression: 'attribute_not_exists(eventId)'
  });

  try {
    await dynamoClient.send(command);
    return 'new';
  } catch (err: any) {
    if (err instanceof ConditionalCheckFailedException || err?.name === 'ConditionalCheckFailedException') {
      return 'duplicate';
    }
    throw err;
  }
}

async function processOrder(detail: OrderCreatedDetail): Promise<void> {
  const hasFailSku = detail.items.some((item) => item.sku === 'FAIL-ME');
  if (hasFailSku) {
    throw new Error('Failure injection triggered for sku=FAIL-ME');
  }

  console.log(
    JSON.stringify({
      level: 'info',
      msg: 'Order processed successfully',
      eventId: detail.eventId,
      orderId: detail.orderId,
      schemaVersion: detail.schemaVersion,
      customerId: detail.customerId,
      itemCount: detail.items.length,
      outcome: 'success'
    })
  );
}

export const handler = async (event: SQSEvent): Promise<SQSBatchResponse> => {
  const batchItemFailures: { itemIdentifier: string }[] = [];

  for (const record of event.Records) {
    let envelope: EventBridgeEnvelope | undefined;
    let detail: OrderCreatedDetail | undefined;

    try {
      envelope = parseEventBridgeEnvelope(record);
      detail = envelope.detail;

      const idempotencyStatus = await recordIdempotency(detail);

      if (idempotencyStatus === 'duplicate') {
        console.log(
          JSON.stringify({
            level: 'info',
            msg: 'duplicate',
            eventId: detail.eventId,
            orderId: detail.orderId,
            schemaVersion: detail.schemaVersion,
            outcome: 'duplicate_ignored'
          })
        );
        continue;
      }

      await processOrder(detail);
    } catch (err: any) {
      const eventId = detail?.eventId ?? envelope?.id ?? 'unknown';
      const orderId = detail?.orderId ?? 'unknown';

      console.error(
        JSON.stringify({
          level: 'error',
          msg: 'processing_failed',
          eventId,
          orderId,
          errorMessage: err?.message,
          errorStack: err?.stack,
          outcome: 'failed'
        })
      );

      batchItemFailures.push({
        itemIdentifier: record.messageId
      });
    }
  }

  return { batchItemFailures };
};
