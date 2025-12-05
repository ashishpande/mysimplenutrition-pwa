import { vi } from 'vitest';

// Mock Prisma globally for all tests
vi.mock('@prisma/client', () => ({
  PrismaClient: vi.fn(() => ({
    user: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn()
    },
    meal: {
      create: vi.fn(),
      findMany: vi.fn()
    },
    dailyTotal: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      upsert: vi.fn()
    },
    trustedDevice: {
      create: vi.fn()
    },
    mealItem: {
      create: vi.fn()
    },
    $transaction: vi.fn((callback) => callback({})),
    $disconnect: vi.fn()
  }))
}));

// Mock LLM module
vi.mock('../src/llm.js', () => ({
  estimateNutrition: vi.fn(() => Promise.resolve({
    calories: 100,
    protein_g: 5,
    carbs_g: 10,
    fat_g: 2,
    source: 'llm_local'
  }))
}));