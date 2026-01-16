import React, { useState } from 'react';
import { API_URL, AWS_REGION, ENV_NAME, createOrder, OrderItem } from './api';

interface ItemForm extends OrderItem {
  id: number;
}

export const App: React.FC = () => {
  const [customerId, setCustomerId] = useState('cust-frontend');
  const [items, setItems] = useState<ItemForm[]>([
    { id: 1, sku: 'SKU-1', qty: 1 },
    { id: 2, sku: 'SKU-2', qty: 2 }
  ]);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const validateForm = (): string | null => {
    if (items.length === 0) {
      return 'Add at least one item before submitting.';
    }

    for (let i = 0; i < items.length; i += 1) {
      const item = items[i];
      if (!item.sku.trim()) {
        return `Item ${i + 1}: SKU must not be empty.`;
      }
      if (!Number.isFinite(item.qty) || item.qty <= 0) {
        return `Item ${i + 1}: quantity must be a positive number.`;
      }
    }

    return null;
  };

  const handleItemChange = (id: number, field: keyof OrderItem, value: string) => {
    setItems((prev) =>
      prev.map((item) =>
        item.id === id
          ? {
              ...item,
              [field]: field === 'qty' ? Number(value) || 0 : value
            }
          : item
      )
    );
  };

  const addItem = () => {
    setItems((prev) => [
      ...prev,
      { id: Date.now(), sku: 'SKU-NEW', qty: 1 }
    ]);
  };

  const removeItem = (id: number) => {
    setItems((prev) => prev.filter((item) => item.id !== id));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setResult(null);
    setError(null);

    const validationError = validateForm();
    if (validationError) {
      setLoading(false);
      setError(validationError);
      return;
    }

    try {
      const payload = {
        customerId: customerId || undefined,
        items: items.map(({ sku, qty }) => ({ sku, qty }))
      };

      const response = await createOrder(payload);
      setResult(JSON.stringify(response, null, 2));
    } catch (err: any) {
      setError(err?.message ?? String(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="app-header-title">
          <h1>AWS Orders Workflow</h1>
          <span>
            EventBridge · SQS · Lambda · DynamoDB · env: {ENV_NAME} · region: {AWS_REGION}
          </span>
        </div>
        <div className="app-badge">Serverless demo</div>
      </header>

      <main className="app-main">
        <section className="app-card">
          <div className="app-card-header">
            <h2>Create order</h2>
            <div className="app-endpoint">
              <span>Backend API URL: </span>
              <code>{API_URL}</code>
            </div>
          </div>

          <form onSubmit={handleSubmit}>
            <div className="app-form-row">
              <label className="app-label" htmlFor="customerId">
                Customer ID (optional)
              </label>
              <input
                id="customerId"
                className="app-input-text"
                type="text"
                value={customerId}
                onChange={(e) => setCustomerId(e.target.value)}
                placeholder="cust-frontend"
              />
            </div>

            <div className="app-section-title">Items</div>
            <div className="items-grid">
              {items.map((item) => (
                <div key={item.id} className="item-row">
                  <input
                    className="item-input"
                    type="text"
                    value={item.sku}
                    onChange={(e) => handleItemChange(item.id, 'sku', e.target.value)}
                    placeholder="SKU"
                  />
                  <input
                    className="item-input"
                    type="number"
                    min={1}
                    value={item.qty}
                    onChange={(e) => handleItemChange(item.id, 'qty', e.target.value)}
                    placeholder="Qty"
                  />
                  <button type="button" className="btn-danger" onClick={() => removeItem(item.id)}>
                    Remove
                  </button>
                </div>
              ))}
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '0.9rem' }}>
              <button type="button" className="btn-secondary" onClick={addItem}>
                + Add item
              </button>
              <button type="submit" className="btn-primary" disabled={loading}>
                {loading ? 'Submitting…' : 'Submit order'}
              </button>
            </div>
          </form>

          {error && (
            <div className="app-output error">
              <strong>Error</strong>
              <pre>{error}</pre>
            </div>
          )}

          {result && !error && (
            <div className="app-output">
              <strong>Response</strong>
              <pre>{result}</pre>
            </div>
          )}

          <div className="app-footer-text">
            <p>
              Tip: To drive messages to the DLQ from this UI, set one item&apos;s SKU to <code>FAIL-ME</code>{' '}
              and submit. The worker Lambda will fail, SQS will retry, and the message will land in the DLQ
              after the configured receive count.
            </p>
          </div>
        </section>
      </main>
    </div>
  );
};
