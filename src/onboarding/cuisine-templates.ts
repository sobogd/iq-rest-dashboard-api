import type { CuisineKey } from "./cuisine";
import generatedImages from "./cuisine-template-images.json";
import translationOverrides from "./cuisine-translations.json";

/** Multilingual string. `en` is the canonical fallback; other locale keys may or may not exist.
 *  The seeder picks `[seedLocale]` and falls back to `en` when missing. */
export type LocaleString = { en: string } & Partial<Record<string, string>>;

export type SeedCategory = { sortOrder: number; name: LocaleString };

export type SeedItem = {
  categoryIndex: number;
  sortOrder: number;
  price: number;
  name: LocaleString;
  description?: LocaleString;
  /** Filled at module-load from cuisine-template-images.json (output of scripts/generate-template-images.ts). */
  imageUrl?: string;
};

export type CuisineTemplate = {
  subtitle: LocaleString;
  categories: SeedCategory[];
  items: SeedItem[];
  /** Restaurant cover background, also from the generated images JSON. */
  backgroundUrl?: string;
};

const COMMON_PLACEHOLDERS = {
  description: {
    en: "Replace this with your own description",
    es: "Reemplaza esto con tu descripción",
    de: "Ersetze dies durch deine eigene Beschreibung",
    fr: "Remplace ceci par ta propre description",
    it: "Sostituisci con la tua descrizione",
    pt: "Substitui por tua descrição",
    nl: "Vervang dit door je eigen beschrijving",
    pl: "Zastąp to własnym opisem",
    ru: "Замени это своим описанием",
    uk: "Заміни це своїм описом",
    sv: "Ersätt detta med din egen beskrivning",
    da: "Erstat dette med din egen beskrivelse",
    no: "Erstatt dette med din egen beskrivelse",
    fi: "Korvaa tämä omalla kuvauksellasi",
    cs: "Nahraď to vlastním popisem",
    el: "Αντικαταστήστε με τη δική σας περιγραφή",
    tr: "Bunu kendi açıklamanla değiştir",
    ro: "Înlocuiește cu propria descriere",
    hu: "Cseréld le saját leírásra",
    bg: "Замени това със собственото си описание",
    hr: "Zamijeni vlastitim opisom",
    sk: "Nahraď vlastným popisom",
    sl: "Zamenjaj s svojim opisom",
    et: "Asenda oma kirjeldusega",
    lv: "Aizstāj ar savu aprakstu",
    lt: "Pakeisk savo aprašymu",
    sr: "Zameni sopstvenim opisom",
    ca: "Substitueix per la teva descripció",
    ga: "Athchuir é seo le do thuairisc féin",
    is: "Skiptu þessu út fyrir þína eigin lýsingu",
    fa: "این را با توضیحات خودتان جایگزین کنید",
    ar: "استبدل هذا بوصفك الخاص",
    ja: "ここをあなたの説明に置き換えてください",
    ko: "이것을 자신의 설명으로 바꾸세요",
    zh: "将此处替换为您自己的描述",
  } as LocaleString,
  address: "Sample Street 1, Your City",
  phone: "+34 600 000 000",
  instagram: "your_restaurant",
  whatsapp: "+34600000000",
};

export const commonPlaceholders = COMMON_PLACEHOLDERS;

export const cuisineTemplates: Record<CuisineKey, CuisineTemplate> = {
  pizza: {
    subtitle: { en: "Authentic Italian Pizzeria", es: "Pizzería Italiana Auténtica" },
    categories: [
      { sortOrder: 1, name: { en: "Pizzas", es: "Pizzas" } },
      { sortOrder: 2, name: { en: "Pasta", es: "Pasta" } },
      { sortOrder: 3, name: { en: "Drinks", es: "Bebidas" } },
    ],
    items: [
      { categoryIndex: 0, sortOrder: 1, price: 9.5, name: { en: "Margherita", es: "Margarita" }, description: { en: "Tomato, mozzarella, basil", es: "Tomate, mozzarella, albahaca" } },
      { categoryIndex: 0, sortOrder: 2, price: 11.0, name: { en: "Pepperoni", es: "Pepperoni" } },
      { categoryIndex: 0, sortOrder: 3, price: 12.5, name: { en: "Four Cheese", es: "Cuatro Quesos" } },
      { categoryIndex: 1, sortOrder: 1, price: 10.5, name: { en: "Spaghetti Carbonara", es: "Espaguetis Carbonara" } },
      { categoryIndex: 1, sortOrder: 2, price: 10.5, name: { en: "Tagliatelle Bolognese", es: "Tallarines Bolognese" } },
      { categoryIndex: 2, sortOrder: 1, price: 2.5, name: { en: "Still Water 0.5L", es: "Agua sin gas 0.5L" } },
      { categoryIndex: 2, sortOrder: 2, price: 4.5, name: { en: "House Wine, glass", es: "Vino de la casa, copa" } },
    ],
  },

  sushi: {
    subtitle: { en: "Fresh Japanese Cuisine", es: "Cocina Japonesa Fresca" },
    categories: [
      { sortOrder: 1, name: { en: "Rolls", es: "Rolls" } },
      { sortOrder: 2, name: { en: "Nigiri", es: "Nigiri" } },
      { sortOrder: 3, name: { en: "Drinks", es: "Bebidas" } },
    ],
    items: [
      { categoryIndex: 0, sortOrder: 1, price: 8.5, name: { en: "California Roll", es: "California Roll" }, description: { en: "Crab, avocado, cucumber", es: "Cangrejo, aguacate, pepino" } },
      { categoryIndex: 0, sortOrder: 2, price: 9.0, name: { en: "Philadelphia Roll", es: "Philadelphia Roll" } },
      { categoryIndex: 0, sortOrder: 3, price: 9.5, name: { en: "Spicy Tuna Roll", es: "Roll Atún Picante" } },
      { categoryIndex: 1, sortOrder: 1, price: 3.5, name: { en: "Salmon Nigiri (2 pcs)", es: "Nigiri Salmón (2 uds)" } },
      { categoryIndex: 1, sortOrder: 2, price: 3.8, name: { en: "Tuna Nigiri (2 pcs)", es: "Nigiri Atún (2 uds)" } },
      { categoryIndex: 2, sortOrder: 1, price: 3.0, name: { en: "Green Tea", es: "Té Verde" } },
      { categoryIndex: 2, sortOrder: 2, price: 4.5, name: { en: "Asahi Beer", es: "Cerveza Asahi" } },
    ],
  },

  asian: {
    subtitle: { en: "Pan-Asian Kitchen", es: "Cocina Pan-Asiática" },
    categories: [
      { sortOrder: 1, name: { en: "Noodles", es: "Fideos" } },
      { sortOrder: 2, name: { en: "Rice", es: "Arroz" } },
      { sortOrder: 3, name: { en: "Drinks", es: "Bebidas" } },
    ],
    items: [
      { categoryIndex: 0, sortOrder: 1, price: 11.0, name: { en: "Pad Thai", es: "Pad Thai" }, description: { en: "Rice noodles, shrimp, peanuts, lime", es: "Fideos de arroz, gambas, cacahuetes, lima" } },
      { categoryIndex: 0, sortOrder: 2, price: 12.0, name: { en: "Chicken Ramen", es: "Ramen de Pollo" } },
      { categoryIndex: 1, sortOrder: 1, price: 9.0, name: { en: "Chicken Fried Rice", es: "Arroz Frito con Pollo" } },
      { categoryIndex: 1, sortOrder: 2, price: 12.0, name: { en: "Bibimbap", es: "Bibimbap" } },
      { categoryIndex: 2, sortOrder: 1, price: 2.8, name: { en: "Jasmine Tea", es: "Té de Jazmín" } },
      { categoryIndex: 2, sortOrder: 2, price: 4.5, name: { en: "Singha Beer", es: "Cerveza Singha" } },
    ],
  },

  burger: {
    subtitle: { en: "Handcrafted Burgers", es: "Hamburguesas Artesanas" },
    categories: [
      { sortOrder: 1, name: { en: "Burgers", es: "Hamburguesas" } },
      { sortOrder: 2, name: { en: "Sides", es: "Acompañamientos" } },
      { sortOrder: 3, name: { en: "Drinks", es: "Bebidas" } },
    ],
    items: [
      { categoryIndex: 0, sortOrder: 1, price: 9.5, name: { en: "Classic Cheeseburger", es: "Hamburguesa Clásica con Queso" }, description: { en: "Beef patty, cheddar, lettuce, tomato, pickles", es: "Carne de ternera, cheddar, lechuga, tomate, pepinillos" } },
      { categoryIndex: 0, sortOrder: 2, price: 11.0, name: { en: "Bacon Burger", es: "Hamburguesa con Bacon" } },
      { categoryIndex: 0, sortOrder: 3, price: 9.0, name: { en: "Veggie Burger", es: "Hamburguesa Vegetal" } },
      { categoryIndex: 1, sortOrder: 1, price: 3.5, name: { en: "French Fries", es: "Patatas Fritas" } },
      { categoryIndex: 1, sortOrder: 2, price: 4.0, name: { en: "Onion Rings", es: "Aros de Cebolla" } },
      { categoryIndex: 2, sortOrder: 1, price: 2.8, name: { en: "Coca-Cola 0.4L", es: "Coca-Cola 0.4L" } },
      { categoryIndex: 2, sortOrder: 2, price: 5.5, name: { en: "Vanilla Milkshake", es: "Batido de Vainilla" } },
    ],
  },

  coffee: {
    subtitle: { en: "Specialty Coffee & Pastries", es: "Café de Especialidad y Bollería" },
    categories: [
      { sortOrder: 1, name: { en: "Coffee", es: "Café" } },
      { sortOrder: 2, name: { en: "Pastries", es: "Bollería" } },
      { sortOrder: 3, name: { en: "Sandwiches", es: "Sándwiches" } },
    ],
    items: [
      { categoryIndex: 0, sortOrder: 1, price: 1.8, name: { en: "Espresso", es: "Espresso" } },
      { categoryIndex: 0, sortOrder: 2, price: 2.8, name: { en: "Cappuccino", es: "Cappuccino" } },
      { categoryIndex: 0, sortOrder: 3, price: 3.2, name: { en: "Latte", es: "Latte" } },
      { categoryIndex: 1, sortOrder: 1, price: 2.2, name: { en: "Butter Croissant", es: "Croissant de Mantequilla" } },
      { categoryIndex: 1, sortOrder: 2, price: 2.8, name: { en: "Blueberry Muffin", es: "Muffin de Arándanos" } },
      { categoryIndex: 2, sortOrder: 1, price: 5.5, name: { en: "Ham & Cheese", es: "Jamón y Queso" } },
      { categoryIndex: 2, sortOrder: 2, price: 6.5, name: { en: "Avocado Toast", es: "Tostada de Aguacate" } },
    ],
  },

  bar: {
    subtitle: { en: "Cocktails & Craft Beer", es: "Cócteles y Cerveza Artesana" },
    categories: [
      { sortOrder: 1, name: { en: "Cocktails", es: "Cócteles" } },
      { sortOrder: 2, name: { en: "Beer", es: "Cerveza" } },
      { sortOrder: 3, name: { en: "Snacks", es: "Para Picar" } },
    ],
    items: [
      { categoryIndex: 0, sortOrder: 1, price: 8.5, name: { en: "Mojito", es: "Mojito" } },
      { categoryIndex: 0, sortOrder: 2, price: 9.5, name: { en: "Aperol Spritz", es: "Aperol Spritz" } },
      { categoryIndex: 0, sortOrder: 3, price: 10.0, name: { en: "Negroni", es: "Negroni" } },
      { categoryIndex: 1, sortOrder: 1, price: 4.0, name: { en: "Lager, draft", es: "Cerveza rubia, de barril" } },
      { categoryIndex: 1, sortOrder: 2, price: 5.5, name: { en: "IPA", es: "IPA" } },
      { categoryIndex: 2, sortOrder: 1, price: 6.5, name: { en: "Nachos with Cheese", es: "Nachos con Queso" } },
      { categoryIndex: 2, sortOrder: 2, price: 4.5, name: { en: "Marinated Olives", es: "Aceitunas Marinadas" } },
    ],
  },

  bakery: {
    subtitle: { en: "Fresh Bakery Daily", es: "Panadería Fresca Diaria" },
    categories: [
      { sortOrder: 1, name: { en: "Breads", es: "Panes" } },
      { sortOrder: 2, name: { en: "Pastries", es: "Bollería" } },
      { sortOrder: 3, name: { en: "Cakes", es: "Tartas" } },
    ],
    items: [
      { categoryIndex: 0, sortOrder: 1, price: 4.5, name: { en: "Sourdough Loaf", es: "Pan de Masa Madre" } },
      { categoryIndex: 0, sortOrder: 2, price: 2.5, name: { en: "Baguette", es: "Baguette" } },
      { categoryIndex: 1, sortOrder: 1, price: 2.2, name: { en: "Butter Croissant", es: "Croissant de Mantequilla" } },
      { categoryIndex: 1, sortOrder: 2, price: 2.8, name: { en: "Pain au Chocolat", es: "Pain au Chocolat" } },
      { categoryIndex: 1, sortOrder: 3, price: 3.2, name: { en: "Cinnamon Roll", es: "Rollo de Canela" } },
      { categoryIndex: 2, sortOrder: 1, price: 4.5, name: { en: "Cheesecake Slice", es: "Porción de Tarta de Queso" } },
      { categoryIndex: 2, sortOrder: 2, price: 4.5, name: { en: "Tiramisu", es: "Tiramisú" } },
    ],
  },

  restaurant: {
    subtitle: { en: "Modern European Cuisine", es: "Cocina Europea Moderna" },
    categories: [
      { sortOrder: 1, name: { en: "Starters", es: "Entrantes" } },
      { sortOrder: 2, name: { en: "Main Courses", es: "Platos Principales" } },
      { sortOrder: 3, name: { en: "Desserts", es: "Postres" } },
    ],
    items: [
      { categoryIndex: 0, sortOrder: 1, price: 8.5, name: { en: "Caesar Salad", es: "Ensalada César" } },
      { categoryIndex: 0, sortOrder: 2, price: 7.5, name: { en: "Bruschetta (3 pcs)", es: "Bruschetta (3 uds)" } },
      { categoryIndex: 1, sortOrder: 1, price: 22.0, name: { en: "Grilled Ribeye Steak", es: "Entrecot a la Parrilla" }, description: { en: "300g, served with roasted potatoes", es: "300g, con patatas asadas" } },
      { categoryIndex: 1, sortOrder: 2, price: 18.5, name: { en: "Salmon Fillet", es: "Filete de Salmón" } },
      { categoryIndex: 1, sortOrder: 3, price: 14.5, name: { en: "Mushroom Risotto", es: "Risotto de Setas" } },
      { categoryIndex: 2, sortOrder: 1, price: 5.5, name: { en: "Tiramisu", es: "Tiramisú" } },
      { categoryIndex: 2, sortOrder: 2, price: 5.8, name: { en: "Crème Brûlée", es: "Crème Brûlée" } },
    ],
  },
};

// Splice generated image URLs into the templates at module load.
// JSON keys: dishes["<cuisine>:<itemIndex>"] and backgrounds["<cuisine>"].
type ImagesJson = { dishes: Record<string, string>; backgrounds: Record<string, string> };
const images = generatedImages as ImagesJson;
for (const cuisine of Object.keys(cuisineTemplates) as CuisineKey[]) {
  const tpl = cuisineTemplates[cuisine];
  const bg = images.backgrounds?.[cuisine];
  if (bg) tpl.backgroundUrl = bg;
  tpl.items.forEach((item, idx) => {
    const url = images.dishes?.[`${cuisine}:${idx}`];
    if (url) item.imageUrl = url;
  });
}

// Splice per-locale translation overrides into the base templates at module load.
// JSON shape:
//   { "<locale>": {
//       "subtitles": { "<cuisine>": "..." },
//       "categories": { "<cuisine>": ["cat0", "cat1", ...] },
//       "items": { "<cuisine>": [ {"name": "...", "description": "..."}, ... ] }
//     }
//   }
// Base templates carry `en` (and `es` for legacy reasons); other locales come from this JSON.
type TranslationsJson = Record<
  string,
  {
    subtitles?: Partial<Record<CuisineKey, string>>;
    categories?: Partial<Record<CuisineKey, string[]>>;
    items?: Partial<Record<CuisineKey, { name?: string; description?: string }[]>>;
  }
>;
const translations = translationOverrides as TranslationsJson;
for (const [locale, data] of Object.entries(translations)) {
  for (const cuisine of Object.keys(cuisineTemplates) as CuisineKey[]) {
    const tpl = cuisineTemplates[cuisine];

    const subtitle = data.subtitles?.[cuisine];
    if (subtitle) tpl.subtitle[locale] = subtitle;

    const cats = data.categories?.[cuisine];
    if (cats) {
      cats.forEach((name, i) => {
        if (tpl.categories[i] && name) tpl.categories[i].name[locale] = name;
      });
    }

    const items = data.items?.[cuisine];
    if (items) {
      items.forEach((override, i) => {
        const item = tpl.items[i];
        if (!item) return;
        if (override.name) item.name[locale] = override.name;
        if (override.description) {
          if (!item.description) item.description = { en: override.description };
          else item.description[locale] = override.description;
        }
      });
    }
  }
}

// Pool of realistic guest names per locale, used to populate sample orders/reservations.
// Locales not listed fall back to "en" in the seeder.
export const sampleGuestNames: Record<string, string[]> = {
  en: ["John Smith", "Sarah Johnson", "Michael Brown", "Emma Davis", "David Wilson", "Olivia Taylor"],
  es: ["María García", "Carlos López", "Laura Martínez", "Javier Rodríguez", "Sofía Fernández", "Diego Ruiz"],
  de: ["Anna Müller", "Lukas Schmidt", "Sophie Weber", "Maximilian Fischer"],
  fr: ["Pierre Dubois", "Marie Lefèvre", "Julien Bernard", "Camille Moreau"],
  it: ["Giulia Rossi", "Marco Bianchi", "Chiara Russo", "Lorenzo Ferrari"],
  pt: ["João Silva", "Mariana Santos", "Pedro Costa", "Ana Oliveira"],
  nl: ["Jan de Vries", "Emma Bakker", "Lars Visser", "Sophie Jansen"],
  pl: ["Anna Kowalska", "Piotr Nowak", "Maria Wiśniewska", "Tomasz Wójcik"],
  ru: ["Иван Иванов", "Анна Петрова", "Дмитрий Смирнов", "Екатерина Соколова"],
  uk: ["Олександр Шевченко", "Олена Коваленко", "Андрій Мельник", "Наталія Бондар"],
  sv: ["Erik Andersson", "Anna Karlsson", "Lars Johansson", "Maja Lindberg"],
  da: ["Mads Nielsen", "Sofie Hansen", "Lars Pedersen", "Emma Larsen"],
  no: ["Lars Hansen", "Ingrid Olsen", "Erik Berg", "Emma Solberg"],
  fi: ["Mikko Korhonen", "Anna Virtanen", "Jukka Mäkinen", "Liisa Nieminen"],
  cs: ["Jan Novák", "Eva Svobodová", "Petr Dvořák", "Tereza Černá"],
  el: ["Γιώργος Παπαδόπουλος", "Ελένη Δημητρίου", "Νίκος Γεωργίου", "Μαρία Ιωάννου"],
  tr: ["Mehmet Yılmaz", "Ayşe Demir", "Ali Kaya", "Zeynep Çelik"],
  ro: ["Andrei Popescu", "Maria Ionescu", "Mihai Stan", "Elena Dumitrescu"],
  hu: ["Péter Nagy", "Anna Kovács", "István Tóth", "Eszter Szabó"],
  bg: ["Иван Петров", "Мария Иванова", "Георги Димитров", "Елена Стоянова"],
  hr: ["Ivan Horvat", "Ana Marić", "Marko Novak", "Petra Kovačević"],
  sk: ["Ján Novák", "Mária Kováčová", "Peter Horváth", "Zuzana Tóthová"],
  sl: ["Janez Novak", "Maja Kovač", "Luka Horvat", "Eva Krajnc"],
  et: ["Andres Tamm", "Kati Saar", "Toomas Mägi", "Liis Kask"],
  lv: ["Jānis Bērziņš", "Anna Liepa", "Pēteris Kalniņš", "Līga Ozola"],
  lt: ["Jonas Petraitis", "Eglė Kazlauskienė", "Tomas Jankauskas", "Rūta Stankevičiūtė"],
  sr: ["Marko Petrović", "Ana Jovanović", "Stefan Nikolić", "Jelena Đorđević"],
  ca: ["Jordi Puig", "Núria Vila", "Marc Soler", "Anna Roca"],
  ga: ["Seán Ó Briain", "Áine Ní Mhaolagáin", "Conor Mac Cárthaigh", "Niamh Ní Dhomhnaill"],
  is: ["Jón Jónsson", "Anna Sigurðardóttir", "Magnús Guðmundsson", "Sara Ólafsdóttir"],
  fa: ["علی محمدی", "سارا حسینی", "امیر رضایی", "نگین کریمی"],
  ar: ["محمد أحمد", "فاطمة علي", "خالد حسن", "ليلى إبراهيم"],
  ja: ["田中太郎", "鈴木花子", "佐藤健", "高橋美咲"],
  ko: ["김민준", "이서연", "박지훈", "최수아"],
  zh: ["王伟", "李娜", "张磊", "刘洋"],
};
