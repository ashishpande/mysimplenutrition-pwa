import fs from 'fs';
import path from 'path';
import { PrismaClient } from '@prisma/client';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const prisma = new PrismaClient();

function parseNutrientValue(value) {
  if (!value || value === '') return null;
  const num = parseFloat(value);
  return isNaN(num) ? null : num;
}

function extractServingInfo(servingSize) {
  if (!servingSize) return { unit: null, grams: null };
  
  // Extract grams from serving size like "scoop (47g grams )"
  const gramsMatch = servingSize.match(/(\d+(?:\.\d+)?)g/);
  const grams = gramsMatch ? parseFloat(gramsMatch[1]) : null;
  
  // Extract unit (everything before the parentheses)
  const unit = servingSize.split('(')[0].trim() || null;
  
  return { unit, grams };
}

async function importFoodFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.trim().split('\n');
  const foods = [];

  for (const line of lines) {
    try {
      const food = JSON.parse(line);
      
      if (!food.food_name) continue; // Skip entries without names
      
      const serving = extractServingInfo(food.serving_size);
      
      const foodData = {
        name: food.food_name,
        brandName: food.brand_name || null,
        servingSize: food.serving_size || null,
        servingUnit: serving.unit,
        servingGrams: serving.grams,
        calories: parseNutrientValue(food.calories),
        totalFat: parseNutrientValue(food['Total Fat']),
        saturatedFat: parseNutrientValue(food['Saturated Fat']),
        transFat: parseNutrientValue(food['Trans']),
        cholesterol: parseNutrientValue(food['Cholesterol']),
        sodium: parseNutrientValue(food['Sodium']),
        totalCarbs: parseNutrientValue(food['Total Carbohydrates']),
        dietaryFiber: parseNutrientValue(food['Dietary Fiber']),
        sugars: parseNutrientValue(food['Sugars']),
        protein: parseNutrientValue(food['Protein']),
        vitaminD: parseNutrientValue(food['Vitamin D']),
        calcium: parseNutrientValue(food['Calcium']),
        iron: parseNutrientValue(food['Iron']),
        potassium: parseNutrientValue(food['Potassium']),
        caffeine: parseNutrientValue(food['Caffeine'])
      };

      foods.push(foodData);
    } catch (error) {
      console.warn(`Skipping invalid JSON line in ${filePath}:`, error.message);
    }
  }

  return foods;
}

async function importAllFoods() {
  const dataDir = path.resolve(__dirname, '../../../data');
  const batchSize = 1000;
  let totalImported = 0;

  console.log('Starting food import...');

  // Get all JSON files
  const getAllJsonFiles = (dir) => {
    let files = [];
    const items = fs.readdirSync(dir);
    
    for (const item of items) {
      const fullPath = path.join(dir, item);
      const stat = fs.statSync(fullPath);
      
      if (stat.isDirectory()) {
        files = files.concat(getAllJsonFiles(fullPath));
      } else if (item.endsWith('.json')) {
        files.push(fullPath);
      }
    }
    
    return files;
  };

  const jsonFiles = getAllJsonFiles(dataDir);
  console.log(`Found ${jsonFiles.length} JSON files`);

  let batch = [];
  
  for (let i = 0; i < jsonFiles.length; i++) {
    const filePath = jsonFiles[i];
    console.log(`Processing ${i + 1}/${jsonFiles.length}: ${path.basename(filePath)}`);
    
    try {
      const foods = await importFoodFile(filePath);
      batch = batch.concat(foods);
      
      // Insert in batches
      if (batch.length >= batchSize) {
        await prisma.food.createMany({
          data: batch,
          skipDuplicates: true
        });
        totalImported += batch.length;
        console.log(`Imported batch: ${totalImported} foods so far`);
        batch = [];
      }
    } catch (error) {
      console.error(`Error processing ${filePath}:`, error.message);
    }
  }

  // Insert remaining foods
  if (batch.length > 0) {
    await prisma.food.createMany({
      data: batch,
      skipDuplicates: true
    });
    totalImported += batch.length;
  }

  console.log(`Import complete! Total foods imported: ${totalImported}`);
}

async function main() {
  try {
    await importAllFoods();
  } catch (error) {
    console.error('Import failed:', error);
  } finally {
    await prisma.$disconnect();
  }
}

main();