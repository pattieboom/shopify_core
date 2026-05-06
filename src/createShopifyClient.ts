import { createAdminApiClient } from "@shopify/admin-api-client";

export function createShopifyClient({
  storeDomain,
  accessToken,
}: {
  storeDomain: string;
  accessToken: string;
}) {
  return createAdminApiClient({
    storeDomain,
    accessToken,
    apiVersion: "2025-01",
  });
}

async function test() {
  const client = createShopifyClient({
    storeDomain: "test.myshopify.com",
    accessToken: "shpat_test",
  });

  console.log(typeof client.request);
}

test();