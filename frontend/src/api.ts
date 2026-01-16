// Default placeholders make the repo safe to publish; override in real use via Vite env vars.
const DEFAULT_API_URL = 'https://your-api-id.execute-api.your-region.amazonaws.com/prod';
const DEFAULT_ENV_NAME = 'dev';
const DEFAULT_AWS_REGION = 'your-region';

// You can override these via Vite env vars: VITE_API_URL, VITE_ENV_NAME, VITE_AWS_REGION
export const API_URL = import.meta.env.VITE_API_URL ?? DEFAULT_API_URL;
export const ENV_NAME = import.meta.env.VITE_ENV_NAME ?? DEFAULT_ENV_NAME;
export const AWS_REGION = import.meta.env.VITE_AWS_REGION ?? DEFAULT_AWS_REGION;

export interface OrderItem {
  sku: string;
  qty: number;
}

export interface CreateOrderRequest {
  customerId?: string;
  items: OrderItem[];
}

export interface CreateOrderResponse {
  orderId: string;
  eventId: string;
}

export async function createOrder(body: CreateOrderRequest): Promise<CreateOrderResponse> {
  const res = await fetch(`${API_URL}/orders`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  const data = await res.json();

  if (!res.ok) {
    throw new Error(data?.message ?? `API error: ${res.status}`);
  }

  return data as CreateOrderResponse;
}
