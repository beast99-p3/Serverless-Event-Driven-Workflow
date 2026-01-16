import {
  SQSClient,
  ReceiveMessageCommand,
  SendMessageCommand,
  DeleteMessageBatchCommand,
  Message
} from '@aws-sdk/client-sqs';

const MAIN_QUEUE_URL = process.env.MAIN_QUEUE_URL;
const DLQ_URL = process.env.DLQ_URL;

if (!MAIN_QUEUE_URL || !DLQ_URL) {
  console.error(
    'Error: MAIN_QUEUE_URL and DLQ_URL environment variables must be set before running this script.'
  );
  process.exit(1);
}

const sqsClient = new SQSClient({});

async function replayOnce(): Promise<number> {
  const receiveCommand = new ReceiveMessageCommand({
    QueueUrl: DLQ_URL,
    MaxNumberOfMessages: 10,
    WaitTimeSeconds: 1,
    VisibilityTimeout: 30
  });

  const result = await sqsClient.send(receiveCommand);
  const messages: Message[] = result.Messages ?? [];

  if (messages.length === 0) {
    return 0;
  }

  let processedCount = 0;
  const toDelete: Message[] = [];

  for (const msg of messages) {
    if (!msg.Body || !msg.ReceiptHandle || !msg.MessageId) {
      continue;
    }

    try {
      const sendCommand = new SendMessageCommand({
        QueueUrl: MAIN_QUEUE_URL,
        MessageBody: msg.Body
      });

      await sqsClient.send(sendCommand);
      processedCount++;
      toDelete.push(msg);
    } catch (err: any) {
      console.error(
        `Failed to send message ${msg.MessageId} to main queue: ${err?.message ?? String(err)}`
      );
    }
  }

  if (toDelete.length > 0) {
    const deleteCommand = new DeleteMessageBatchCommand({
      QueueUrl: DLQ_URL,
      Entries: toDelete.map((m) => ({
        Id: m.MessageId!,
        ReceiptHandle: m.ReceiptHandle!
      }))
    });

    const deleteResult = await sqsClient.send(deleteCommand);

    const failed = deleteResult.Failed ?? [];
    if (failed.length > 0) {
      console.error(
        `Failed to delete ${failed.length} messages from DLQ after replay. Inspect DLQ for duplicates.`
      );
    }
  }

  return processedCount;
}

async function main(): Promise<void> {
  let totalReplayed = 0;

  console.log(
    `Replaying messages from DLQ (${DLQ_URL}) to main queue (${MAIN_QUEUE_URL})...`
  );

  while (true) {
    const replayed = await replayOnce();
    if (replayed === 0) {
      break;
    }
    totalReplayed += replayed;
    console.log(`Replayed ${replayed} messages in this batch (total=${totalReplayed})`);
  }

  console.log(`Done. Total messages replayed: ${totalReplayed}`);
}

main().catch((err) => {
  console.error('Unexpected error while replaying DLQ messages:', err);
  process.exit(1);
});
