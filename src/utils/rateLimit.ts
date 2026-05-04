export const estimateCost = (_query: string) => 50;

export const calculateWaitTime = (
  avail: number,
  rate: number,
  query: string
) => {
  const cost = estimateCost(query);

  if (avail >= cost) return 0;

  return ((cost - avail) / rate) * 1000;
};