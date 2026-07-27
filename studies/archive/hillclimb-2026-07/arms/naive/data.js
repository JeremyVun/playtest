// Seed data for Fern & Fog, the hill-climb study's subject storefront.
// Everything here is copied per server instance; POST /api/reset restores it.

export const SHIPPING_CENTS = 600;

export const PRODUCTS = [
  {
    id: "monstera",
    name: "Monstera Deliciosa",
    category: "plants",
    price: 3800,
    stock: 7,
    glyph: "🪴",
    hue: "#e3efe7",
    blurb: "The classic split-leaf houseplant. Forgiving, fast-growing, dramatic.",
    description:
      "A young Monstera deliciosa in a 6-inch nursery pot, already showing its first " +
      "fenestrations. Give it bright indirect light and it will reward you with a new " +
      "leaf most months. Happy being slightly root-bound, so no rush to repot.",
    details: { "Pot size": "6 in nursery pot", Light: "Bright, indirect", Water: "Weekly, let top soil dry", Difficulty: "Easy" },
  },
  {
    id: "snake-plant",
    name: "Snake Plant",
    category: "plants",
    price: 2600,
    stock: 12,
    glyph: "🌱",
    hue: "#e8ecdc",
    blurb: "Nearly indestructible. Thrives on neglect and low light.",
    description:
      "Sansevieria trifasciata 'Laurentii' with tall, gold-edged blades. The plant to " +
      "start with if you have never kept one alive: it tolerates low light, erratic " +
      "watering, and dry air without complaint.",
    details: { "Pot size": "4 in nursery pot", Light: "Low to bright, indirect", Water: "Every 2–3 weeks", Difficulty: "Very easy" },
  },
  {
    id: "golden-pothos",
    name: "Golden Pothos",
    category: "plants",
    price: 1900,
    stock: 15,
    glyph: "🌿",
    hue: "#e3efe7",
    blurb: "Trailing vines that grow almost anywhere. Great on a shelf.",
    description:
      "Epipremnum aureum with marbled green-and-gold leaves. Trails beautifully from a " +
      "shelf or hanging planter, roots readily in water, and tells you plainly when it " +
      "is thirsty by drooping — then springs back within hours of a drink.",
    details: { "Pot size": "4 in nursery pot", Light: "Low to bright, indirect", Water: "When leaves soften", Difficulty: "Very easy" },
  },
  {
    id: "calathea",
    name: "Calathea Orbifolia",
    category: "plants",
    price: 3400,
    stock: 5,
    glyph: "🍃",
    hue: "#dfe9ef",
    blurb: "Broad striped leaves that fold up at night. A gentle diva.",
    description:
      "Calathea orbifolia with wide, silver-striped leaves that move with the light " +
      "through the day. It asks for a little more than the others — filtered water, " +
      "steady humidity — and repays the attention with foliage nothing else matches.",
    details: { "Pot size": "6 in nursery pot", Light: "Medium, indirect", Water: "Keep lightly moist", Difficulty: "Intermediate" },
  },
  {
    id: "fiddle-leaf-fig",
    name: "Fiddle-Leaf Fig",
    category: "plants",
    price: 5200,
    stock: 0,
    glyph: "🌳",
    hue: "#e8ecdc",
    blurb: "The statement tree. Currently out of stock — more are being propagated.",
    description:
      "Ficus lyrata, the violin-leaved statement tree. Ours sold out faster than we " +
      "could pot them; the next batch is hardening off in the greenhouse now. Check " +
      "back soon — they are worth the wait.",
    details: { "Pot size": "8 in nursery pot", Light: "Bright, indirect", Water: "Weekly, thorough", Difficulty: "Intermediate" },
  },
  {
    id: "terracotta-pot",
    name: "Terracotta Pot",
    category: "pots",
    price: 1400,
    stock: 20,
    glyph: "🏺",
    hue: "#f3e6da",
    blurb: "Classic unglazed clay, 6 inch, with drainage hole and saucer.",
    description:
      "A classic unglazed terracotta pot that breathes with the soil, pulling excess " +
      "moisture out through its walls — the safest home for anything prone to " +
      "overwatering. Drainage hole and matching saucer included.",
    details: { Size: "6 in diameter", Material: "Unglazed terracotta", Drainage: "Hole + saucer" },
  },
  {
    id: "ceramic-planter",
    name: "Stoneware Planter, Cream",
    category: "pots",
    price: 3200,
    stock: 9,
    glyph: "🫖",
    hue: "#efe9e1",
    blurb: "Matte cream stoneware, 7 inch, quietly elegant on any sill.",
    description:
      "A wheel-thrown stoneware planter in a warm matte cream, sized to slip a 6-inch " +
      "nursery pot straight inside — no repotting needed. The glaze is speckled " +
      "lightly, so no two are quite alike.",
    details: { Size: "7 in diameter", Material: "Glazed stoneware", Drainage: "Cachepot (no hole)" },
  },
  {
    id: "hanging-planter",
    name: "Hanging Planter, Jute",
    category: "pots",
    price: 2400,
    stock: 11,
    glyph: "🧺",
    hue: "#f3e6da",
    blurb: "Hand-knotted jute hanger with a 5 inch ceramic pot.",
    description:
      "A hand-knotted jute hanger cradling a white 5-inch ceramic pot — made for " +
      "pothos and other trailers. Hangs 30 inches from a single ceiling hook " +
      "(hardware included).",
    details: { Size: "5 in pot, 30 in drop", Material: "Jute + ceramic", Includes: "Ceiling hook kit" },
  },
  {
    id: "self-watering-pot",
    name: "Self-Watering Pot",
    category: "pots",
    price: 2800,
    stock: 8,
    glyph: "💧",
    hue: "#dfe9ef",
    blurb: "A hidden reservoir keeps soil evenly moist for up to two weeks.",
    description:
      "A double-walled planter with a hidden reservoir and a water-level window. Fill " +
      "it every week or two and the wicking insert keeps the soil evenly moist — ideal " +
      "for calatheas, ferns, and anyone who travels.",
    details: { Size: "6.5 in diameter", Material: "Recycled polypropylene", Reservoir: "0.5 L, level window" },
  },
  {
    id: "watering-can",
    name: "Long-Spout Watering Can",
    category: "care",
    price: 2200,
    stock: 14,
    glyph: "🚿",
    hue: "#dfe9ef",
    blurb: "One litre, powder-coated steel, a spout that reaches the back shelf.",
    description:
      "A one-litre watering can in powder-coated steel with a long, narrow spout that " +
      "reaches through foliage to the soil — no more showering the leaves of plants " +
      "that hate wet feet. Balanced to pour slowly without drips.",
    details: { Capacity: "1 L", Material: "Powder-coated steel", Colour: "Sage green" },
  },
  {
    id: "brass-mister",
    name: "Brass Mister",
    category: "care",
    price: 1800,
    stock: 10,
    glyph: "✨",
    hue: "#f3e6da",
    blurb: "A fine, even mist for humidity-loving plants. Ages beautifully.",
    description:
      "A solid brass mister that throws a fine, even cloud — the gentle humidity boost " +
      "calatheas and ferns ask for. The uncoated brass develops a soft patina with " +
      "use; polish it back to bright or let it age, as you prefer.",
    details: { Capacity: "300 ml", Material: "Solid brass", Spray: "Fine mist" },
  },
  {
    id: "plant-food",
    name: "Gentle Plant Food",
    category: "care",
    price: 1200,
    stock: 18,
    glyph: "🧪",
    hue: "#e8ecdc",
    blurb: "Balanced 3-1-2 liquid feed, one pump per litre, spring to autumn.",
    description:
      "A gentle 3-1-2 liquid fertiliser made for houseplants: one pump per litre of " +
      "water, every other watering through the growing season. Mild enough that you " +
      "cannot easily burn roots with it.",
    details: { Volume: "250 ml (≈50 feeds)", Formula: "3-1-2 NPK", Season: "Spring–autumn" },
  },
  {
    id: "pruning-shears",
    name: "Precision Pruning Shears",
    category: "care",
    price: 2100,
    stock: 6,
    glyph: "✂️",
    hue: "#efe9e1",
    blurb: "Japanese steel, needle-nose blades for clean cuts in tight spots.",
    description:
      "Needle-nosed pruning shears in Japanese carbon steel, sharp enough to take a " +
      "cutting without crushing the stem. Sized for houseplant work: deadheading, " +
      "trimming leggy vines, harvesting propagation cuttings.",
    details: { Blade: "Japanese carbon steel", Length: "6.5 in", Care: "Wipe dry after use" },
  },
];

export const CATEGORIES = [
  { id: "plants", label: "Plants" },
  { id: "pots", label: "Pots & Planters" },
  { id: "care", label: "Care & Tools" },
];

// The single demo shopper. Checkout prefills from this profile; the account
// page edits it.
export const ACCOUNT = {
  name: "Riley Chen",
  email: "riley@example.com",
  street: "14 Foxglove Lane",
  city: "Millbrook",
  postcode: "5041",
};

// Two past orders so order history has content on a fresh visit.
export const PAST_ORDERS = [
  {
    number: "FF-1041",
    placed_at: "2026-06-18T09:42:00.000Z",
    status: "delivered",
    items: [
      { product_id: "golden-pothos", name: "Golden Pothos", qty: 1, unit_price: 1900 },
      { product_id: "hanging-planter", name: "Hanging Planter, Jute", qty: 1, unit_price: 2400 },
    ],
  },
  {
    number: "FF-1052",
    placed_at: "2026-07-02T15:07:00.000Z",
    status: "shipped",
    items: [
      { product_id: "plant-food", name: "Gentle Plant Food", qty: 2, unit_price: 1200 },
    ],
  },
];
