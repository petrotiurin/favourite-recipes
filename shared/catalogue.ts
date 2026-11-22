// The ingredient catalogue, data/ingredients.json (docs/structured-ingredients.md section 2): one entry per thing we buy, keyed by a stable id.
// This is the shape of the file. The backend's write-time rules (names that clash, conversions that must exist, `per` ranges) stay in
// mcp-server/lib/catalogue.js, which gives each problem its own message; the site's build only needs the shape and that every recipe's
// `item` is in it (src/content.config.ts).
import { z } from "zod";

/** The shopping list's fixed aisles, in the order the list shows them. */
export const SECTIONS = ["Fresh produce", "Meat & fish", "Dairy & eggs", "Bakery", "Tins & jars", "Pantry", "Frozen"] as const;
/** Named recipe units an item can also be bought / counted in. */
const NAMED = ["clove", "can", "slice", "bunch", "sprig", "piece"] as const;
export const SHOP_UNITS = ["g", "ml", "count", ...NAMED] as const;

/** An item id: kebab-case. */
export const ITEM_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const catalogueEntrySchema = z.object({
  /** The shopping-list name ("Red onions"). */
  name: z.string().min(1),
  /** The aisle; left out on an item that is never bought (`skip`). */
  section: z.enum(SECTIONS).optional(),
  /** The unit it's bought in; left out on a `staple` or `skip` item. */
  unit: z.enum(SHOP_UNITS).optional(),
  /** Shopping units per one recipe unit: { tbsp: 18 } for a g item, { can: 400 } for ml, { juice: 1 } for a count. */
  per: z.record(z.string(), z.number().positive()).optional(),
  /** Other names recipes use for it (lower case). */
  aliases: z.array(z.string()).optional(),
  /** Listed in Pantry without a quantity (salt, oil). */
  staple: z.literal(true).optional(),
  /** Never on the list (water, ice). */
  skip: z.literal(true).optional(),
});
export type CatalogueEntry = z.infer<typeof catalogueEntrySchema>;

export const catalogueSchema = z.record(z.string().regex(ITEM_ID, "an item id is kebab-case"), catalogueEntrySchema);
export type Catalogue = z.infer<typeof catalogueSchema>;
