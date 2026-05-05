// src/client/createShopifyClient.ts
function createShopifyClient(env, app) {
  return {
    async graphql({ shop, accessToken, query, variables = {} }) {
      const id = env.SHOPIFY_DO.idFromName(`${app}:${shop}`);
      const stub = env.SHOPIFY_DO.get(id);
      const res = await stub.fetch("https://do/graphql", {
        method: "POST",
        body: JSON.stringify({ shop, accessToken, query, variables })
      });
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    }
  };
}

// src/utils/sleep.ts
var sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// src/utils/rateLimit.ts
var estimateCost = (_query) => 50;
var calculateWaitTime = (avail, rate, query) => {
  const cost = estimateCost(query);
  if (avail >= cost) return 0;
  return (cost - avail) / rate * 1e3;
};

// src/utils/retry.ts
var getBackoffDelay = (a) => Math.min(1e3 * 2 ** a, 5e3);

// src/do/ShopifyRateLimiterDO.ts
var ShopifyRateLimiterDO = class {
  queue = [];
  running = false;
  currentlyAvailable = 1e3;
  restoreRate = 50;
  async fetch(req) {
    const url = new URL(req.url);
    console.log("DO URL:", req.url);
    console.log("DO PATH:", url.pathname);
    if (url.pathname === "/graphql") {
      const payload = await req.json();
      return new Promise((resolve, reject) => {
        this.queue.push({ resolve, reject, payload });
        this.run();
      });
    }
    if (url.pathname === "/backfill") {
      const payload = await req.json();
      const result = await this.backfill(payload);
      return new Response(JSON.stringify(result));
    }
    console.log("DO PATH:", url.pathname);
    return new Response("Not found", { status: 404 });
  }
  async run() {
    if (this.running) return;
    this.running = true;
    while (this.queue.length > 0) {
      const job = this.queue.shift();
      if (!job) continue;
      try {
        const result = await this.handle(job.payload);
        job.resolve(new Response(JSON.stringify(result), { status: 200 }));
      } catch (e) {
        job.reject(new Response(e?.message || "Error", { status: 500 }));
      }
    }
    this.running = false;
  }
  async handle(payload) {
    let attempt = 0;
    while (true) {
      const wait = calculateWaitTime(
        this.currentlyAvailable,
        this.restoreRate,
        payload.query
      );
      if (wait > 0) {
        await sleep(wait);
      }
      const res = await fetch(
        `https://${payload.shop}/admin/api/2024-10/graphql.json`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Shopify-Access-Token": payload.accessToken
          },
          body: JSON.stringify({
            query: payload.query,
            variables: payload.variables
          })
        }
      );
      const json = await res.json();
      const cost = json?.extensions?.cost;
      if (cost) {
        this.currentlyAvailable = cost.throttleStatus.currentlyAvailable;
        this.restoreRate = cost.throttleStatus.restoreRate;
      }
      if (!res.ok) {
        if (attempt > 5) {
          throw new Error("Max retries reached");
        }
        await sleep(getBackoffDelay(attempt));
        attempt++;
        continue;
      }
      return json;
    }
  }
  async backfill(payload) {
    const { shop, accessToken, startDate, endDate, cursor } = payload;
    const json = await this.handle({
      shop,
      accessToken,
      query: `
      query ($cursor: String) {
        orders(
          first: 50,
          after: $cursor,
          query: "created_at:>=${startDate} AND created_at:<=${endDate}"
        ) {
          pageInfo {
            hasNextPage
            endCursor
          }
          edges {
            node {
              id
            }
          }
        }
      }
    `,
      variables: { cursor: cursor || null }
    });
    const edges = json?.data?.orders?.edges || [];
    const orders = [];
    for (const edge of edges) {
      const id = edge.node.id.split("/").pop();
      let attempt = 0;
      while (true) {
        const res = await fetch(
          `https://${shop}/admin/api/2024-01/orders/${id}.json`,
          {
            headers: {
              "Content-Type": "application/json",
              "X-Shopify-Access-Token": accessToken
            }
          }
        );
        if (!res.ok) {
          if (attempt > 5) {
            throw new Error(`Order fetch failed: ${await res.text()}`);
          }
          await sleep(getBackoffDelay(attempt));
          attempt++;
          continue;
        }
        const data = await res.json();
        if (data?.order) {
          orders.push(data.order);
        }
        break;
      }
    }
    return {
      orders,
      nextCursor: json?.data?.orders?.pageInfo?.endCursor || null,
      hasNextPage: json?.data?.orders?.pageInfo?.hasNextPage || false
    };
  }
};

// src/bulk/runBulk.ts
async function runBulk({
  shop,
  accessToken,
  query,
  onOrder,
  signal
}) {
  const bulkId = await startBulk(shop, accessToken, query);
  const url = await waitForBulk(shop, accessToken, bulkId, signal);
  await processBulkFile(url, onOrder, signal);
}
async function startBulk(shop, token, query) {
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
      "Bulk start failed: " + json.data.bulkOperationRunQuery.userErrors.map((e) => e.message).join(", ")
    );
  }
  return json.data.bulkOperationRunQuery.bulkOperation.id;
}
async function waitForBulk(shop, token, bulkId, signal) {
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
    await sleep(2e3);
  }
}
async function processBulkFile(url, onOrder, signal) {
  const res = await fetch(url);
  if (!res.ok || !res.body) {
    throw new Error("Failed to download bulk file");
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const orders = /* @__PURE__ */ new Map();
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
      if (isOrder(obj)) {
        orders.set(obj.id, mapOrder(obj));
        continue;
      }
      if (isLineItem(obj)) {
        const order = orders.get(obj.__parentId);
        if (!order) continue;
        order.line_items.push(mapLineItem(obj));
      }
    }
  }
  for (const order of orders.values()) {
    await onOrder(order);
  }
}
function isOrder(obj) {
  return obj.id?.includes("Order") && !obj.__parentId;
}
function isLineItem(obj) {
  return obj.__parentId && obj.id?.includes("LineItem");
}
function mapOrder(obj) {
  return {
    id: obj.id.split("/").pop(),
    created_at: obj.createdAt,
    currency: obj.totalPriceSet?.shopMoney?.currencyCode,
    current_total_price: obj.totalPriceSet?.shopMoney?.amount,
    current_total_tax: obj.totalTaxSet?.shopMoney?.amount,
    current_total_discounts: "0.00",
    order_number: obj.name ? parseInt(obj.name.replace("#", "")) : null,
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
function mapLineItem(obj) {
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
export {
  ShopifyRateLimiterDO,
  createShopifyClient,
  runBulk
};
