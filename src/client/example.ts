/** Clearly labelled fixture. It never comes from, and never triggers, a live lookup. */
export const EXAMPLE_BADGE = "Example — sample data, not a live lookup";

export const EXAMPLE = {
  name: "Greek yogurt",
  priceAmount: "5.49",
  currency: "USD",
  packageAmount: "907",
  packageUnit: "g",
  proteinG: "10",
  energyKcal: "59",
  basisAmount: "100",
  basisUnit: "g",
} as const;
