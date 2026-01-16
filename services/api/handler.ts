import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { v4 as uuidv4 } from 'uuid';

const eventBridgeClient = new EventBridgeClient({});

const EVENT_BUS_NAME = process.env.EVENT_BUS_NAME;
const SCHEMA_VERSION = '1.0';

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

function parseBody(event: APIGatewayProxyEvent): any {
  if (!event.body) {
    throw new Error('Missing request body');
  }

  try {
    return JSON.parse(event.body);
  } catch {
    throw new Error('Invalid JSON body');
  }
}

function validateOrderPayload(payload: any): { customerId?: string; orderId?: string; items: OrderItem[] } {
  const { customerId, orderId, items } = payload || {};

  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('items must be a non-empty array');
  }

  const validatedItems: OrderItem[] = items.map((item: any, index: number) => {
    if (!item || typeof item.sku !== 'string' || item.sku.trim().length === 0) {
      throw new Error(`items[${index}].sku must be a non-empty string`);
    }

    if (typeof item.qty !== 'number' || !Number.isFinite(item.qty) || item.qty <= 0) {
      throw new Error(`items[${index}].qty must be a positive number`);
    }

    return {
      sku: item.sku,
      qty: item.qty
    };
  });

  if (customerId !== undefined && typeof customerId !== 'string') {
    throw new Error('customerId must be a string if provided');
  }

  if (orderId !== undefined && typeof orderId !== 'string') {
    throw new Error('orderId must be a string if provided');
  }

  return {
    customerId,
    orderId,
    items: validatedItems
  };
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const requestId = event.requestContext.requestId || uuidv4();

  if (!EVENT_BUS_NAME) {
    console.error(
      JSON.stringify({
        level: 'error',
        msg: 'Missing EVENT_BUS_NAME environment variable',
        requestId
      })
    );
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Internal server error' })
    };
  }

  try {
    const rawBody = parseBody(event);
    const { customerId, orderId: maybeOrderId, items } = validateOrderPayload(rawBody);

    const eventId = uuidv4();
    const orderId = maybeOrderId || uuidv4();
    const createdAt = new Date().toISOString();

    const detail: OrderCreatedDetail = {
      schemaVersion: SCHEMA_VERSION,
      eventId,
      orderId,
      createdAt,
      customerId,
      items
    };

    const putEventsCommand = new PutEventsCommand({
      Entries: [
        {
          EventBusName: EVENT_BUS_NAME,
          Source: 'myapp.orders',
          DetailType: 'OrderCreated',
          Detail: JSON.stringify(detail)
        }
      ]
    });

    const response = await eventBridgeClient.send(putEventsCommand);

    const failedEntryCount = response.FailedEntryCount ?? 0;
    if (failedEntryCount > 0) {
      console.error(
        JSON.stringify({
          level: 'error',
          msg: 'Failed to publish OrderCreated event',
          requestId,
          eventId,
          orderId,
          failedEntryCount,
          response
        })
      );
      return {
        statusCode: 500,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'Failed to publish event' })
      };
    }

    console.log(
      JSON.stringify({
        level: 'info',
        msg: 'OrderCreated event published',
        requestId,
        eventId,
        orderId,
        schemaVersion: SCHEMA_VERSION,
        customerId,
        itemCount: items.length
      })
    );

    return {
      statusCode: 202,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        orderId,
        eventId
      })
    };
  } catch (err: any) {
    console.error(
      JSON.stringify({
        level: 'error',
        msg: 'Failed to handle /orders request',
        requestId,
        errorMessage: err?.message,
        errorStack: err?.stack
      })
    );

    const message = err instanceof Error ? err.message : 'Bad request';

    const statusCode = message.toLowerCase().includes('must') || message.toLowerCase().includes('invalid')
      ? 400
      : 500;

    return {
      statusCode,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message
      })
    };
  }
};
