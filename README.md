# Serverless Orders Workflow (EventBridge · SQS · Lambda · DynamoDB)

This repository implements a production-ready event-driven serverless workflow on AWS using AWS CDK v2 (TypeScript) and Node.js 20.

## Architecture Overview

- API Gateway exposes `POST /orders`
- API Lambda:
  - Validates request
  - Generates `eventId` and `orderId` (if missing)
  - Publishes `OrderCreated` event to a custom EventBridge EventBus
- EventBridge Rule:
  - Matches:
    - `source: "myapp.orders"`
    - `detailType: "OrderCreated"`
  - Routes events to the main SQS queue
- SQS:
  - Main queue (encrypted, with DLQ)
  - DLQ with `maxReceiveCount = 5`
  - Visibility timeout ≥ 6x worker Lambda timeout
- Worker Lambda:
  - Triggered by SQS (batch size 5)
  - Uses partial batch response
  - Enforces idempotency using DynamoDB (`PK = eventId`, TTL enabled)
  - Failure injection with `sku = "FAIL-ME"`
  - Structured JSON logging
- Observability:
  - CloudWatch log retention: 14 days
  - CloudWatch Alarms:
    - DLQ visible messages > 0
    - Worker Lambda errors ≥ 1 in 5 minutes
    - Age of oldest message in main queue > threshold
  - CloudWatch Dashboard:
    - API & worker Lambda metrics
    - SQS queue metrics for main queue and DLQ
- Security:
  - Least-privilege IAM permissions
  - Encrypted SQS queues (SSE-SQS)
  - DynamoDB with AWS-managed encryption
  - Lambda logs retention configured

---

## AWS Account & User Setup (for this project)

This project deploys AWS infrastructure using AWS CDK (which synthesizes and deploys CloudFormation stacks). You should **not** deploy using the AWS root user.

Recommended setup (best practice):

- Secure the root user (MFA, recovery info)
- Create a normal human user in **IAM Identity Center (SSO)**
- Assign that user permissions to deploy the CDK stack
- Use SSO login from the AWS CLI (no long-lived access keys)

### 1) Create an AWS account

1. Go to https://aws.amazon.com/ and choose **Create an AWS Account**.
2. Use an email address you control and a strong password.
3. Complete billing and phone verification.
4. Choose the region you will deploy to consistently (examples: `us-east-1`, `us-west-2`).

Tip: For a class/team project, pick **one region** and stick to it to avoid confusion.

### 2) Secure the root user (do this immediately)

1. AWS Console → **Sign in** → choose **Root user**.
2. Enable **MFA** for the root user:
  - Console → your account name (top right) → **Security credentials** → **Multi-factor authentication (MFA)**.
3. (Recommended) Ensure account recovery info is correct:
  - Billing → **Account** → confirm contact details.
4. (Recommended) Enable billing visibility for non-root users:
  - Billing → **Account** → “IAM user and role access to Billing information” → **Activate**.
5. (Recommended) Add a Budget to prevent surprises:
  - Billing → **Budgets** → Create budget (monthly) + email alerts.

### 3) Create and assign a user (recommended: IAM Identity Center / SSO)

IAM Identity Center (formerly “AWS SSO”) is the easiest way to give a user console + CLI access **without** creating access keys.

1. AWS Console → search **IAM Identity Center**.
2. Choose **Enable**.
3. In IAM Identity Center, confirm these basics:
  - **Settings** → note the **AWS access portal URL** (you will sign in here)
  - **Multi-factor authentication** → set a policy if you want MFA for users
4. Create the user:
  - **Users** → **Add user** → fill name + email → finish
5. (Optional but recommended) Create a group:
  - **Groups** → **Create group** (e.g., `cdk-deployers`) → add your user to it
6. Assign the user/group to the AWS account:
  - **AWS accounts** → select your account → **Assign users or groups**
7. Create/choose a permission set and attach it to the assignment:
  - Simple / fastest (recommended for a course project): **AdministratorAccess**
  - More restricted (advanced): ensure it can run CDK bootstrap + deploy. At minimum it must allow:
    - CloudFormation (create/update stacks)
    - IAM (create roles/policies used by CDK and CloudFormation, and `iam:PassRole`)
    - Service APIs used by this project: API Gateway, Lambda, EventBridge, SQS, DynamoDB, CloudWatch Logs/Alarms/Dashboard

After assignment, the user can sign in via the **AWS access portal URL**, choose the account + role, and open the AWS Console.

### 4) Configure AWS CLI for Identity Center (SSO)

1. Install AWS CLI v2.
2. Configure SSO (creates a named profile):

```bash
aws configure sso
```

3. Follow the prompts:
  - **SSO start URL**: the AWS access portal URL from Identity Center
  - **SSO region**: the region where Identity Center is enabled
  - Select your **account** and **permission set**
  - Choose a profile name (example: `myapp-dev`)
4. Log in (this opens a browser to authenticate):

```bash
aws sso login --profile <your-profile>
```

5. Verify your identity:

```bash
aws sts get-caller-identity --profile <your-profile>
```

Windows tip (so CDK/npm scripts automatically use the profile):

- PowerShell:

```powershell
$env:AWS_PROFILE="<your-profile>"
```

- Command Prompt (cmd.exe):

```bat
set AWS_PROFILE=<your-profile>
```

### 5) Bootstrap CDK (once per account/region)

CDK bootstrap creates a staging bucket and roles used by CDK/CloudFormation.

```bash
cdk bootstrap --profile <your-profile>
```

If you use multiple regions, run bootstrap once per region. You can also be explicit:

```bash
aws sts get-caller-identity --profile <your-profile>
cdk bootstrap aws://<account-id>/<region> --profile <your-profile>
```

---

### Alternative: IAM user with access keys (not recommended)

If Identity Center isn’t available, you can use an IAM user, but avoid long-lived keys when possible.

Use this only if you cannot use Identity Center.

1. AWS Console → **IAM** → **Users** → **Create user**.
2. Choose how the user will access AWS:
  - **Console access** (for the AWS Console)
  - **Access key** (for AWS CLI/CDK)
3. Attach permissions:
  - Quick setup: **AdministratorAccess**
  - Restricted setup: ensure CDK bootstrap + deploy permissions (CloudFormation + IAM role creation/pass-role + the services in this stack)
4. Configure credentials on your machine:

```bash
aws configure
aws sts get-caller-identity
```

## Prerequisites

- Node.js **18 or 20** (recommended: 20.x)
- npm (comes with Node.js)
- AWS CLI v2 installed and authenticated (see **AWS Account & User Setup** above)
- AWS CDK v2 CLI installed globally:

```bash
npm install -g aws-cdk
```

- An AWS account with permissions to create:
  - API Gateway
  - Lambda
  - SQS
  - DynamoDB
  - EventBridge
  - CloudWatch (Logs, Alarms, Dashboard)
- CDK environment bootstrapped (once per account/region):

```bash
cdk bootstrap
```

---

## Project Structure

```text
.
├─ infra
│  ├─ bin
│  │  └─ app.ts                 # CDK app entrypoint
│  ├─ lib
│  │  └─ event-driven-stack.ts  # Main CDK stack (all AWS resources)
│  └─ test
│     └─ event-driven-stack.test.ts  # Minimal Jest test for sanity
├─ services
│  ├─ api
│  │  └─ handler.ts             # API Lambda: POST /orders, publishes events
│  └─ worker
│     └─ handler.ts             # Worker Lambda: SQS consumer with idempotency logic
├─ scripts
│  └─ replay-dlq.ts             # DLQ replay script (TypeScript, uses AWS SDK v3)
├─ frontend
│  ├─ index.html                # Vite entry HTML
│  ├─ package.json              # Frontend dependencies and scripts
│  ├─ tsconfig.json             # Frontend TypeScript config
│  ├─ vite.config.ts            # Vite build/dev configuration
│  └─ src
│     ├─ main.tsx               # React entrypoint
│     ├─ App.tsx                # AWS-themed UI to send orders
│     ├─ api.ts                 # Frontend API client (uses VITE_API_URL, etc.)
│     └─ styles.css             # AWS console-inspired styling
├─ package.json
├─ tsconfig.json
├─ jest.config.js
├─ cdk.json
└─ README.md
```

---

## Install & Build

From the repository root:

```bash
# Install dependencies
npm install

# Type-check and compile to dist/ (for scripts and type checking)
npm run build

# Run tests (optional)
npm test
```

---

## Deploy

From the repository root:

If you configured an AWS CLI profile (recommended, especially with SSO), log in and set it for your shell:

```bash
aws sso login --profile <your-profile>
```

Then set the profile for your current terminal:

- PowerShell:

```powershell
$env:AWS_PROFILE="<your-profile>"
```

- Command Prompt (cmd.exe):

```bat
set AWS_PROFILE=<your-profile>
```

- bash (Git Bash / WSL):

```bash
export AWS_PROFILE=<your-profile>
```

```bash
# Synthesize CloudFormation templates
npm run synth

# Deploy all stacks
npm run deploy
```

During deployment, CDK will output stack information, including:

- `ApiEndpoint`
- `EventBusName`
- `MainQueueUrl`
- `DlqUrl`
- `DynamoTableName`

Note the `ApiEndpoint` and queue URLs for testing.

> ⚠️ **Do not commit secrets or account-specific artifacts**
>
> This repo is safe to publish as long as you **do not commit**:
> - `cdk.out/` (CloudFormation templates with your account ID and ARNs)
> - `dist/` (compiled JS, may include baked-in URLs)
> - `node_modules/`
>
> These paths are already listed in `.gitignore`.

---

## Event Schema

Events published to EventBridge have:

- `source: "myapp.orders"`
- `detailType: "OrderCreated"`
- `detail` JSON:

```json
{
  "schemaVersion": "1.0",
  "eventId": "uuid",
  "orderId": "string",
  "createdAt": "ISO timestamp",
  "customerId": "optional string",
  "items": [{ "sku": "string", "qty": 1 }]
}
```

The API Lambda guarantees:

- `eventId`: always a freshly generated UUID
- `orderId`:
  - If provided in request: used as-is
  - If missing: generated (UUID)
- `createdAt`: ISO 8601 timestamp at event creation

---

## Testing the API with curl

1. Get the API endpoint from the CDK outputs (look for `ApiEndpoint`).

   It will look like:

   ```text
   https://xxxxxxxx.execute-api.<region>.amazonaws.com/prod/
   ```

2. Use `curl` to create an order:

```bash
API_URL="https://xxxxxxxx.execute-api.<region>.amazonaws.com/prod"

curl -X POST "${API_URL}/orders" \
  -H "Content-Type: application/json" \
  -d '{
    "customerId": "cust-123",
    "items": [
      { "sku": "SKU-1", "qty": 2 },
      { "sku": "SKU-2", "qty": 1 }
    ]
  }'
```

Example successful response:

```json
{
  "orderId": "8c8d2f70-5f86-4e27-9c41-b61a68b7b3a1",
  "eventId": "3f8338a9-146e-4a0c-bd83-9e4597b7b578"
}
```

The event is then:

- Published to the custom EventBridge EventBus
- Routed to the main SQS queue via rule
- Processed by the worker Lambda with idempotency enforcement

---

## Failure Injection (Testing DLQ Behavior)

To test retry and DLQ behavior, send a payload with `sku = "FAIL-ME"`:

```bash
curl -X POST "${API_URL}/orders" \
  -H "Content-Type: application/json" \
  -d '{
    "customerId": "cust-fail",
    "items": [
      { "sku": "FAIL-ME", "qty": 1 }
    ]
  }'
```

The worker Lambda will:

- Detect `FAIL-ME` and throw an error
- SQS will retry the message up to `maxReceiveCount = 5`
- After 5 failed attempts, the message moves to the DLQ

You can verify:

- DLQ metrics on the CloudWatch dashboard
- Messages in the DLQ queue via AWS console or CLI

---

## Viewing Logs (CloudWatch)

The Lambda functions log structured JSON. Log groups:

- API Lambda: `/aws/lambda/orders-api`
- Worker Lambda: `/aws/lambda/orders-worker`

To open logs:

1. Go to **CloudWatch > Logs > Log groups** in the AWS console.
2. Select:
   - `/aws/lambda/orders-api` for API logs
   - `/aws/lambda/orders-worker` for worker logs
3. Use **Log Insights** for advanced queries (see below).

---

## CloudWatch Logs Insights Queries

### 1. Find Duplicate Events (Idempotency)

Use against the `orders-worker` log group:

```sql
fields @timestamp, @message, eventId, orderId, msg, outcome
| filter msg = "duplicate" or outcome = "duplicate_ignored"
| sort @timestamp desc
| limit 50
```

### 2. Find Failures in Worker Lambda

```sql
fields @timestamp, @message, level, msg, eventId, orderId, errorMessage
| filter level = "error" or msg = "processing_failed"
| sort @timestamp desc
| limit 50
```

### 3. Correlate by orderId or eventId Across Logs

You can query both the API and worker log groups by running a cross-log-group query (select both groups in the console):

```sql
fields @timestamp, @logGroup, @logStream, level, msg, eventId, orderId
| filter eventId = 'PUT_EVENT_ID_HERE' or orderId = 'PUT_ORDER_ID_HERE'
| sort @timestamp asc
```

Replace `PUT_EVENT_ID_HERE` or `PUT_ORDER_ID_HERE` with values from your API responses.

---

## DLQ Replay Script

The script at `scripts/replay-dlq.ts` replays messages from the DLQ to the main queue using AWS SDK v3.

### Build

The script is compiled by the main `npm run build`:

```bash
npm run build
```

This generates:

- `dist/scripts/replay-dlq.js`

### Required Environment Variables

- `MAIN_QUEUE_URL` – the URL of the main SQS queue
- `DLQ_URL` – the URL of the DLQ

You can get these from CDK outputs:

- `MainQueueUrl`
- `DlqUrl`

### Running the Replay Script (Linux/macOS)

```bash
export MAIN_QUEUE_URL="https://sqs.<region>.amazonaws.com/<account-id>/orders-main-queue"
export DLQ_URL="https://sqs.<region>.amazonaws.com/<account-id>/orders-dlq"

node dist/scripts/replay-dlq.js
```

### Running the Replay Script (Windows PowerShell)

```powershell
$env:MAIN_QUEUE_URL = "https://sqs.<region>.amazonaws.com/<account-id>/orders-main-queue"
$env:DLQ_URL = "https://sqs.<region>.amazonaws.com/<account-id>/orders-dlq"

node dist/scripts/replay-dlq.js
```

The script will:

- Read messages from DLQ in batches of up to 10
- Resend each message body to the main queue
- Delete successfully replayed messages from the DLQ
- Print processed counts and exit cleanly

---

## Security and IAM Notes

- API Lambda:
  - Granted only `events:PutEvents` permissions against the custom EventBus.
- Worker Lambda:
  - Granted only read/write access to the specific DynamoDB idempotency table.
  - SQS -> Lambda event source mapping automatically manages queue consumption permissions.
- SQS Queues:
  - Encrypted at rest using SSE-SQS (`QueueEncryption.SQS_MANAGED`).
- DynamoDB:
  - Encrypted using AWS-managed KMS key.
- Logs:
  - Log retention set to 14 days for both Lambdas.

---

## Reliability and Idempotency

- SQS main queue:
  - Visibility timeout: 180 seconds
  - DLQ with `maxReceiveCount = 5`
- Worker Lambda:
  - Timeout: 30 seconds
  - Batch size: 5
  - Partial batch response:
    - Only failing records are returned in `batchItemFailures`
    - Successful records are not retried
- Idempotency:
  - DynamoDB table with `PK = eventId`
  - Conditional write ensures first writer wins
  - TTL enabled (`expiresAt`), default 7 days
  - Duplicates are logged and treated as success

---

## Cost Notes

This stack uses:

- API Gateway (REST API)
- 2 Lambda functions
- 2 SQS queues (main + DLQ)
- 1 DynamoDB table (on-demand)
- 1 EventBridge EventBus + rule
- CloudWatch logs, alarms, and a dashboard

All services are pay-per-use and suitable for low to moderate traffic. For production workloads, monitor usage and adjust retention, TTL, and alarm thresholds as needed.

---

## Cleanup

To avoid ongoing charges, destroy the stack when done:

```bash
npm run destroy
```

Confirm the deletion in the terminal when prompted.

---

## Frontend (AWS-Themed UI)

This project includes a small React + Vite frontend under `frontend/` that calls the deployed API and provides an AWS console-inspired UI.

### Configure API URL (Vite env)

By default, the frontend uses placeholder values in `frontend/src/api.ts`:

- `DEFAULT_API_URL = "https://your-api-id.execute-api.your-region.amazonaws.com/prod"`
- `DEFAULT_ENV_NAME = "dev"`
- `DEFAULT_AWS_REGION = "your-region"`

In a real deployment, you should override these via a `.env` file in `frontend/` (not committed):

```bash
VITE_API_URL="https://xxxxxxxx.execute-api.<region>.amazonaws.com/prod"
VITE_ENV_NAME="dev"
VITE_AWS_REGION="us-east-1"
```

Restart the frontend dev server after changing env vars.

### Run the frontend locally

From the `frontend` folder:

```bash
cd frontend
npm install
npm run dev
```

Then open `http://localhost:5173`.

The UI shows:

- Header: "AWS Orders Workflow" and the current `env` & `region`.
- A form to enter:
  - Optional `customerId`
  - A list of items (`sku`, `qty`).
- A primary "Submit order" button.
- A styled output section for the response or errors.

Client-side validation ensures:

- At least one item is present.
- Each item has a non-empty SKU and a positive quantity.

To drive a failure and DLQ behavior from the UI, set any item's SKU to `FAIL-ME` and submit.

---

## Quick Command Summary

From the repository root:

```bash
# Install dependencies
npm install

# Build TypeScript
npm run build

# (Optional) Run tests
npm test

# Synthesize CloudFormation
npm run synth

# Deploy all stacks
npm run deploy

# Destroy all stacks
npm run destroy
```

---

## Future Enhancements (Ideas)

These are not implemented, but are natural next steps if you want to extend the project:

- **Order status & history API**
  - Add a DynamoDB table to persist full order state (not just idempotency keys).
  - Expose `GET /orders/{orderId}` and/or `GET /orders?limit=N` to show recent orders in the UI.

- **Richer processing pipeline**
  - Break processing into multiple stages and events (e.g. `OrderValidated`, `PaymentAuthorized`, `InventoryReserved`).
  - Implement additional EventBridge rules and Lambdas or a Step Functions workflow.

- **DLQ metrics and exploration in UI**
  - Add a small metrics Lambda to return `ApproximateNumberOfMessages` for main queue and DLQ.
  - Show DLQ counts in the frontend header and provide a "Replay" button that invokes a secure replay endpoint.

- **Authentication and multi-tenant support**
  - Protect API Gateway with Cognito or another IdP.
  - Update the frontend to sign in users and show which identity is submitting orders.

- **Production UX polish**
  - Improve responsiveness for mobile, refine theming, and add more contextual tooltips.
  - Add feature flags (via environment variables) to toggle failure injection or extra logging.
