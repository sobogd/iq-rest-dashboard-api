-- Align legacy SPA allergen codes with canonical EU-14 codes used by the public menu.
-- Replaces deprecated tokens inside items.allergens[] (text[]).
UPDATE items SET allergens = array_replace(allergens, 'lactose',   'dairy')      WHERE 'lactose'   = ANY(allergens);
UPDATE items SET allergens = array_replace(allergens, 'shellfish', 'crustaceans') WHERE 'shellfish' = ANY(allergens);
UPDATE items SET allergens = array_replace(allergens, 'soy',       'soybeans')    WHERE 'soy'       = ANY(allergens);
UPDATE items SET allergens = array_replace(allergens, 'sulfites',  'sulphites')   WHERE 'sulfites'  = ANY(allergens);
