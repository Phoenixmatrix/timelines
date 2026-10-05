import type { AiModelOption } from "../../shared/ai.ts";

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
});

/** A model's published prices, in USD per million tokens, each with what it is for. */
export function modelPriceParts(option: AiModelOption): string[] {
  if (option.variablePricing) return ["Price varies with the model each call is routed to"];
  const parts = [
    `${money.format(option.inputUsdPerMillion)} input`,
    `${money.format(option.outputUsdPerMillion)} output`,
  ];
  if (option.cacheReadUsdPerMillion !== undefined)
    parts.push(`${money.format(option.cacheReadUsdPerMillion)} cached input`);
  if (option.cacheWriteUsdPerMillion !== undefined)
    parts.push(`${money.format(option.cacheWriteUsdPerMillion)} cache write`);
  if (option.reasoningUsdPerMillion !== undefined)
    parts.push(`${money.format(option.reasoningUsdPerMillion)} reasoning`);
  return parts;
}

/** Inline prices: "$3.00 input / $15.00 output / $0.30 cached input". */
export function ModelPrices({ option }: { option: AiModelOption }) {
  return <span className="text-ink-muted">{modelPriceParts(option).join(" / ")}</span>;
}
