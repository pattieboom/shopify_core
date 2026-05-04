
import { ShopifyGraphQLRequest } from "../types";

export function createShopifyClient(env: any, app: string) {
  return {
    async graphql({ shop, accessToken, query, variables = {} }: ShopifyGraphQLRequest) {
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
