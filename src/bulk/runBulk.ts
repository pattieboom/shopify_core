import { sleep } from "../utils/sleep";

type BulkRunOptions = {
  shop: string;
  accessToken: string;
  query: string;
  onOrder: (order: any) => Promise<void>;
  signal?: AbortSignal;
};

export async function runBulk({
  shop,
  accessToken,
  query,
  onOrder,
  signal
}: BulkRunOptions) {
  // 1. Start bulk
  const bulkId = await startBulk(shop, accessToken, query);

  // 2. Wacht tot klaar
  const url = await waitForBulk(shop, accessToken, bulkId, signal);

  // 3. Stream & process
  await processBulkFile(url, onOrder, signal);
}

// =========================
// START BULK
// =========================

async function startBulk(shop: string, token: string, query: string) {
  const res = await fetch(`https://${shop}/admin/api/2024-01/graphql.json`, {
    method: "POST",
    headers: {
      "X-Shopify-Access-Token": token,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      query: `
        mutation {
          bulkOperationRunQuery(
            query: """
            ${query}
            """
          ) {
            bulkOperation { id status }
            userErrors { message }
          }
        }
      `
    })
  });

  const json = await res.json();

  if (json?.data?.bulkOperationRunQuery?.userErrors?.length) {
    throw new Error(
      "Bulk start failed: " +
        json.data.bulkOperationRunQuery.userErrors
          .map((e: any) => e.message)
          .join(", ")
    );
  }

  return json.data.bulkOperationRunQuery.bulkOperation.id;
}

// =========================
// WAIT FOR BULK
// =========================

async function waitForBulk(
  shop: string,
  token: string,
  bulkId: string,
  signal?: AbortSignal
) {
  while (true) {
    if (signal?.aborted) throw new Error("Bulk aborted");

    const res = await fetch(
      `https://${shop}/admin/api/2024-01/graphql.json`,
      {
        method: "POST",
        headers: {
          "X-Shopify-Access-Token": token,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          query: `
            {
              node(id: "${bulkId}") {
                ... on BulkOperation {
                  id
                  status
                  url
                  errorCode
                }
              }
            }
          `
        })
      }
    );

    const json = await res.json();
    const op = json?.data?.node;

    if (!op) throw new Error("Bulk operation not found");

    if (op.status === "COMPLETED") {
      if (!op.url) throw new Error("Bulk completed but no URL");
      return op.url;
    }

    if (op.status === "FAILED") {
      throw new Error("Bulk failed: " + op.errorCode);
    }

    await sleep(2000);
  }
}

// =========================
// PROCESS NDJSON STREAM
// =========================

async function processBulkFile(
  url: string,
  onOrder: (order: any) => Promise<void>,
  signal?: AbortSignal
) {
  const res = await fetch(url);

  if (!res.ok || !res.body) {
    throw new Error("Failed to download bulk file");
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();

  let buffer = "";
  const orders = new Map<string, any>();

  while (true) {
    if (signal?.aborted) throw new Error("Bulk aborted");

    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.trim()) continue;

      const obj = JSON.parse(line);

      // ORDER
      if (isOrder(obj)) {
        orders.set(obj.id, mapOrder(obj));
        continue;
      }

      // LINE ITEM
      if (isLineItem(obj)) {
        const order = orders.get(obj.__parentId);
        if (!order) continue;

        order.line_items.push(mapLineItem(obj));
      }
    }
  }

  // flush
  for (const order of orders.values()) {
    await onOrder(order);
  }
}

// =========================
// TYPE GUARDS
// =========================

function isOrder(obj: any) {
  return obj.id?.includes("Order") && !obj.__parentId;
}

function isLineItem(obj: any) {
  return obj.__parentId && obj.id?.includes("LineItem");
}

// =========================
// MAPPERS (Webhook compatible)
// =========================

function mapOrder(obj: any) {
  console.log("MAP ORDER INPUT:", obj);
  return {
    id: obj.id.split("/").pop(),
    name: obj.name,
    created_at: obj.createdAt,
    currency: obj.totalPriceSet?.shopMoney?.currencyCode,
    current_total_price: obj.totalPriceSet?.shopMoney?.amount,
    current_total_tax: obj.totalTaxSet?.shopMoney?.amount,
    current_total_discounts: "0.00",
    order_number: obj.name
      ? parseInt(obj.name.replace("#", ""))
      : null,
    email: obj.email,
    shipping_address: {
      country_code: obj.shippingAddress?.countryCode
    },
    billing_address: {
      country_code: obj.billingAddress?.countryCode
    },
    line_items: []
  };
}

function mapLineItem(obj: any) {
  return {
    id: obj.id.split("/").pop(),
    sku: obj.sku,
    quantity: obj.quantity,
    price: obj.originalUnitPriceSet?.shopMoney?.amount,
    product_id: obj.product?.id?.split("/").pop(),
    variant_id: obj.variant?.id?.split("/").pop(),
    title: obj.title,
    vendor: obj.vendor,
    product_type: obj.product?.productType,
    tax_lines: []
  };
}