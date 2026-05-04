import { sleep } from "../utils/sleep";
import { calculateWaitTime } from "../utils/rateLimit";
import { getBackoffDelay } from "../utils/retry";

type Job = {
  resolve: (v: Response) => void;
  reject: (e: Response) => void;
  payload: any;
};

export class ShopifyRateLimiterDO {
  queue: Job[] = [];
  running = false;

  currentlyAvailable = 1000;
  restoreRate = 50;

async fetch(req: Request): Promise<Response> {
  const url = new URL(req.url);

  if (url.pathname === "/graphql") {
    const payload = await req.json();

    return new Promise<Response>((resolve, reject) => {
      this.queue.push({ resolve, reject, payload });
      this.run();
    });
  }

  if (url.pathname === "/backfill") {
    const payload = await req.json();
    const result = await this.backfill(payload);
    return new Response(JSON.stringify(result));
  }

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
      } catch (e: any) {
        job.reject(new Response(e?.message || "Error", { status: 500 }));
      }
    }

    this.running = false;
  }

  async handle(payload: any) {
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
            "X-Shopify-Access-Token": payload.accessToken,
          },
          body: JSON.stringify({
            query: payload.query,
            variables: payload.variables,
          }),
        }
      );

      const json = await res.json();

      // update rate limit
      const cost = json?.extensions?.cost;
      if (cost) {
        this.currentlyAvailable =
          cost.throttleStatus.currentlyAvailable;
        this.restoreRate = cost.throttleStatus.restoreRate;
      }

      // retry on network / 5xx
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
async backfill(payload: any) {
  const { shop, accessToken, startDate, endDate } = payload;

  let cursor: string | null = null;
  let total = 0;

  while (true) {
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
      variables: { cursor }
    });

const edges = json?.data?.orders?.edges || [];

const orders: any[] = [];

for (const edge of edges) {
  const id = edge.node.id.split("/").pop();

  const res = await fetch(
    `https://${shop}/admin/api/2024-01/orders/${id}.json`,
    {
      headers: {
        "X-Shopify-Access-Token": accessToken
      }
    }
  );

  const orderJson = await res.json();
  if (orderJson.order) {
    orders.push(orderJson.order);
  }
}

return {
  orders,
  nextCursor: json?.data?.orders?.pageInfo?.endCursor,
  hasNextPage: json?.data?.orders?.pageInfo?.hasNextPage
};

    if (!json?.data?.orders?.pageInfo?.hasNextPage) break;

    cursor = json.data.orders.pageInfo.endCursor;
  }

  return { success: true, total };
}

}