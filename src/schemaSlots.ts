import srsimSchemaData from "./data/srsim-hw.schema.json";

export interface SlotRules {
  componentStringSlots: string[];
  componentIntegerMinimum: number;
  mdaIntegerMinimum: number;
  xiomIntegerMinimum: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringSlotsFromPattern(pattern: string | undefined): string[] {
  if (pattern === "^[ABab]$") return ["A", "B"];
  return [];
}

function integerMinimum(value: unknown): number {
  const record = asRecord(value);
  const minimum = Number(record?.minimum);
  return Number.isInteger(minimum) && minimum > 0 ? minimum : 1;
}

function definition(schema: Record<string, unknown>, name: string): Record<string, unknown> {
  return asRecord(asRecord(schema.definitions)?.[name]) ?? {};
}

function property(def: Record<string, unknown>, name: string): unknown {
  return asRecord(def.properties)?.[name];
}

function componentSlotRules(componentSlot: unknown): Pick<SlotRules, "componentStringSlots" | "componentIntegerMinimum"> {
  const alternatives = asRecord(componentSlot)?.anyOf;
  if (!Array.isArray(alternatives)) {
    return { componentStringSlots: [], componentIntegerMinimum: 1 };
  }

  const stringSlots = alternatives.flatMap((item) => {
    const record = asRecord(item);
    return record?.type === "string" ? stringSlotsFromPattern(String(record.pattern ?? "")) : [];
  });
  const integerSchema = alternatives.find((item) => asRecord(item)?.type === "integer");

  return {
    componentStringSlots: stringSlots.length ? stringSlots : ["A", "B"],
    componentIntegerMinimum: integerMinimum(integerSchema)
  };
}

export function extractSlotRules(schema: Record<string, unknown>): SlotRules {
  const component = definition(schema, "srsim-component");
  const mda = definition(schema, "srsim-mda");
  const xiom = definition(schema, "srsim-xiom");
  const componentRules = componentSlotRules(property(component, "slot"));

  return {
    ...componentRules,
    mdaIntegerMinimum: integerMinimum(property(mda, "slot")),
    xiomIntegerMinimum: integerMinimum(property(xiom, "slot"))
  };
}

export const slotRules = extractSlotRules(srsimSchemaData as Record<string, unknown>);
