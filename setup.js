import fs from "fs";

const files = {
  "package.json": `{
  "name": "@your-org/shopify-core",
  "version": "1.0.0",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "files": ["dist"],
  "scripts": { "build": "tsup" },
  "devDependencies": {
    "tsup": "^8.0.0",
    "typescript": "^5.4.0"
  }
}`,

  "tsconfig.json": `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "declaration": true,
    "outDir": "dist",
    "strict": true
  },
  "include": ["src"]
}`,

  "tsup.config.ts": `
import { defineConfig } from "tsup";
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  clean: true
});
`,

  "src/index.ts": `
export { createShopifyClient } from "./client/createShopifyClient";
export { ShopifyRateLimiterDO } from "./do/ShopifyRateLimiterDO";
`,

  "src/types.ts": `
export type ShopifyGraphQLRequest = {
  shop: string;
  accessToken: string;
  query: string;
  variables?: any;
};
`,

  "src/utils/sleep.ts": `
export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
`,

  "src/utils/retry.ts": `
export const getBackoffDelay = (a: number) => Math.min(1000 * 2 ** a, 5000);
`,

  "src/utils/rateLimit.ts": `
export const estimateCost = () => 50;
export const calculateWaitTime = (avail: number, rate: number) => {
  if (avail >= 50) return 0;
  return ((50 - avail) / rate) * 1000;
};
`,

  "src/client/createShopifyClient.ts": `
import { ShopifyGraphQLRequest } from "../types";

export function createShopifyClient(env: any, app: string) {
  return {
    async graphql({ shop, accessToken, query, variables = {} }: ShopifyGraphQLRequest) {
      const id = env.SHOPIFY_DO.idFromName(\`\${app}:\${shop}\`);
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
`,

  "src/do/ShopifyRateLimiterDO.ts": `
import { sleep } from "../utils/sleep";
import { calculateWaitTime } from "../utils/rateLimit";
import { getBackoffDelay } from "../utils/retry";

export class ShopifyRateLimiterDO {
  queue = [];
  running = false;
  currentlyAvailable = 1000;
  restoreRate = 50;

  async fetch(req) {
    if (new URL(req.url).pathname !== "/graphql") return new Response("404", {status:404});
    const payload = await req.json();

    return new Promise((resolve, reject) => {
      this.queue.push({ resolve, reject, payload });
      this.run();
    });
  }

  async run() {
    if (this.running) return;
    this.running = true;

    while (this.queue.length) {
      const job = this.queue.shift();
      try {
        const res = await this.handle(job.payload);
        job.resolve(new Response(JSON.stringify(res)));
      } catch (e) {
        job.reject(new Response(e.message, {status:500}));
      }
    }

    this.running = false;
  }

  async handle(p) {
    let attempt = 0;

    while (true) {
      const wait = calculateWaitTime(this.currentlyAvailable, this.restoreRate);
      if (wait) await sleep(wait);

      const res = await fetch(\`https://\${p.shop}/admin/api/2024-10/graphql.json\`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": p.accessToken
        },
        body: JSON.stringify({ query: p.query, variables: p.variables })
      });

      const json = await res.json();

      const cost = json?.extensions?.cost;
      if (cost) {
        this.currentlyAvailable = cost.throttleStatus.currentlyAvailable;
        this.restoreRate = cost.throttleStatus.restoreRate;
      }

      if (!res.ok) {
        if (attempt++ > 5) throw new Error("retry failed");
        await sleep(getBackoffDelay(attempt));
        continue;
      }

      return json;
    }
  }
`
};

for (const path in files) {
  const full = path;
  const dir = full.split("/").slice(0, -1).join("/");
  if (dir) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(full, files[path]);
}

console.log("✅ shopify-core generated");