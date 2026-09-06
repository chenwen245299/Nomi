const CATEGORY_COLORS: Record<string, string> = {
  美食: "#D9803A",
  文化: "#CC5057",
  购物: "#C2507A",
  其他: "#78818F",
};

const CUSTOM_CATEGORY_COLORS = [
  "#3578C9",
  "#328A74",
  "#B2762E",
  "#7658C7",
  "#B94E72",
  "#3E879D",
  "#9A6543",
  "#65758A",
];

const UNCATEGORIZED_COLOR = "#8993A1";
export const UNCATEGORIZED_TRAVEL_LABEL = "未分类";

export function travelCategoryLabel(category: string): string {
  return category.trim() || UNCATEGORIZED_TRAVEL_LABEL;
}

/** A stable map color for built-in, custom, and uncategorized travel notes. */
export function travelCategoryColor(category: string): string {
  const normalized = category.trim();
  if (!normalized || normalized === UNCATEGORIZED_TRAVEL_LABEL) return UNCATEGORIZED_COLOR;
  if (CATEGORY_COLORS[normalized]) return CATEGORY_COLORS[normalized];

  let hash = 0;
  for (let index = 0; index < normalized.length; index += 1) {
    hash = (hash * 31 + normalized.charCodeAt(index)) >>> 0;
  }
  return CUSTOM_CATEGORY_COLORS[hash % CUSTOM_CATEGORY_COLORS.length];
}
