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
export {
  ShopifyRateLimiterDO,
  createShopifyClient
};
