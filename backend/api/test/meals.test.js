import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';

// Mock Prisma
const mockPrisma = {
  meal: {
    create: vi.fn(),
    findMany: vi.fn()
  },
  dailyTotal: {
    upsert: vi.fn(),
    findUnique: vi.fn(),
    findMany: vi.fn()
  },
  $transaction: vi.fn()
};

vi.mock('@prisma/client', () => ({
  PrismaClient: vi.fn(() => mockPrisma)
}));

// Mock LLM
vi.mock('../src/llm.js', () => ({
  estimateNutrition: vi.fn(() => Promise.resolve({
    calories: 100,
    protein_g: 5,
    carbs_g: 10,
    fat_g: 2,
    source: 'llm_local'
  }))
}));

const { default: app } = await import('../src/server.js');

describe('Meals API', () => {
  const authToken = jwt.sign({ userId: 'user-123' }, 'dev-secret-change-me');

  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.$transaction.mockImplementation(async (callback) => {
      return callback(mockPrisma);
    });
  });

  describe('POST /api/meals', () => {
    it('should create meal with known foods', async () => {
      mockPrisma.meal.create.mockResolvedValue({});
      mockPrisma.dailyTotal.upsert.mockResolvedValue({});

      const response = await request(app)
        .post('/api/meals')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          text: 'egg and toast',
          mealType: 'breakfast'
        });

      expect(response.status).toBe(200);
      expect(response.body.meal).toBeDefined();
      expect(response.body.meal.items).toHaveLength(2);
      expect(response.body.meal.total.calories).toBeGreaterThan(0);
    });

    it('should handle unknown foods with LLM', async () => {
      mockPrisma.meal.create.mockResolvedValue({});
      mockPrisma.dailyTotal.upsert.mockResolvedValue({});

      const response = await request(app)
        .post('/api/meals')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          text: 'quinoa salad',
          mealType: 'lunch'
        });

      expect(response.status).toBe(200);
      expect(response.body.meal.items).toHaveLength(2); // quinoa + salad
      expect(response.body.meal.items[0].source).toBe('llm_local');
    });

    it('should require authentication', async () => {
      const response = await request(app)
        .post('/api/meals')
        .send({ text: 'egg' });

      expect(response.status).toBe(401);
      expect(response.body.error).toBe('unauthorized');
    });

    it('should require text input', async () => {
      const response = await request(app)
        .post('/api/meals')
        .set('Authorization', `Bearer ${authToken}`)
        .send({});

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('text is required');
    });

    it('should infer meal type from time', async () => {
      mockPrisma.meal.create.mockResolvedValue({});
      mockPrisma.dailyTotal.upsert.mockResolvedValue({});

      const morningTime = new Date();
      morningTime.setHours(8, 0, 0, 0);

      const response = await request(app)
        .post('/api/meals')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          text: 'egg',
          consumedAt: morningTime.toISOString()
        });

      expect(response.status).toBe(200);
      expect(response.body.meal.mealType).toBe('breakfast');
    });
  });

  describe('GET /api/daily', () => {
    it('should return daily totals and meals', async () => {
      const mockDay = {
        userId: 'user-123',
        date: '2024-01-01',
        calories: 1500,
        protein_g: 75,
        carbs_g: 150,
        fat_g: 50
      };

      const mockMeals = [{
        id: 'meal-1',
        mealType: 'breakfast',
        text: 'egg and toast',
        items: []
      }];

      mockPrisma.dailyTotal.findUnique.mockResolvedValue(mockDay);
      mockPrisma.meal.findMany.mockResolvedValue(mockMeals);

      const response = await request(app)
        .get('/api/daily')
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(200);
      expect(response.body.day).toEqual(mockDay);
      expect(response.body.meals).toEqual(mockMeals);
    });

    it('should handle missing daily total', async () => {
      mockPrisma.dailyTotal.findUnique.mockResolvedValue(null);
      mockPrisma.meal.findMany.mockResolvedValue([]);

      const response = await request(app)
        .get('/api/daily')
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(200);
      expect(response.body.day.calories).toBe(0);
      expect(response.body.meals).toEqual([]);
    });
  });

  describe('GET /api/days', () => {
    it('should return date range totals', async () => {
      const mockDays = [
        { date: '2024-01-01', calories: 1500 },
        { date: '2024-01-02', calories: 1600 }
      ];

      mockPrisma.dailyTotal.findMany.mockResolvedValue(mockDays);

      const response = await request(app)
        .get('/api/days?start=2024-01-01&end=2024-01-02')
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(200);
      expect(response.body.days).toEqual(mockDays);
    });

    it('should require start date', async () => {
      const response = await request(app)
        .get('/api/days')
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('start required (YYYY-MM-DD)');
    });
  });
});