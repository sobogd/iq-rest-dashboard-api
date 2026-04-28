-- Set onboardingStep = 2 for companies that already have a restaurant with title AND at least one menu item
UPDATE companies
SET "onboardingStep" = 2
WHERE "onboardingStep" < 2
  AND id IN (
    SELECT r."companyId"
    FROM restaurants r
    JOIN items i ON i."companyId" = r."companyId"
    WHERE r.title IS NOT NULL AND r.title != ''
    GROUP BY r."companyId"
    HAVING COUNT(i.id) > 0
  );

-- Set onboardingStep = 1 for companies that have a restaurant with title but no items
UPDATE companies
SET "onboardingStep" = 1
WHERE "onboardingStep" = 0
  AND id IN (
    SELECT r."companyId"
    FROM restaurants r
    WHERE r.title IS NOT NULL AND r.title != ''
  )
  AND id NOT IN (
    SELECT DISTINCT "companyId" FROM items
  );
