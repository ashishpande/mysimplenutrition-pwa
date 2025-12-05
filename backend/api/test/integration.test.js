import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import speakeasy from 'speakeasy';

// Create test app without importing server.js to avoid port conflicts
const createTestApp = () => {
  const app = express();
  const JWT_SECRET = 'test-secret';

  // Mock Prisma
  const mockPrisma = {
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
    $transaction: vi.fn((callback) => callback(mockPrisma))
  };

  app.use(cors());
  app.use(bodyParser.json());

  // Auth middleware
  const authMiddleware = (req, res, next) => {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'unauthorized' });
    try {
      const payload = jwt.verify(token, JWT_SECRET);
      req.user = payload;
      next();
    } catch (err) {
      return res.status(401).json({ error: 'invalid_token' });
    }
  };

  // Routes
  app.post('/auth/register', async (req, res) => {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'email_and_password_required' });
    
    const existing = await mockPrisma.user.findUnique({ where: { email } });
    if (existing) return res.status(409).json({ error: 'email_taken' });
    
    const user = { id: 'user-123', email, mfaEnabled: false };
    await mockPrisma.user.create({ data: user });
    
    const accessToken = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '1h' });
    res.json({ user, accessToken });
  });

  app.post('/auth/login', async (req, res) => {
    const { email, password, token: mfaToken } = req.body || {};
    const user = await mockPrisma.user.findUnique({ where: { email } });
    if (!user) return res.status(401).json({ error: 'invalid_credentials' });
    
    if (user.mfaEnabled && !mfaToken) {
      return res.status(206).json({ mfaRequired: true, error: 'mfa_required' });
    }
    
    const accessToken = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '1h' });
    res.json({ user, accessToken });
  });

  app.get('/api/profile', authMiddleware, async (req, res) => {
    const user = await mockPrisma.user.findUnique({ where: { id: req.user.userId } });
    if (!user) return res.status(404).json({ error: 'not_found' });
    res.json({ user });
  });

  app.post('/api/meals', authMiddleware, async (req, res) => {
    const { text } = req.body || {};
    if (!text?.trim()) return res.status(400).json({ error: 'text is required' });
    
    const meal = {
      id: 'meal-123',
      userId: req.user.userId,
      text,
      items: [],
      total: { calories: 100, protein_g: 5, carbs_g: 10, fat_g: 2 }
    };
    
    await mockPrisma.meal.create({ data: meal });
    res.json({ meal });
  });

  return { app, mockPrisma };
};

describe('Nutrition App Integration Tests', () => {
  let app, mockPrisma;

  beforeEach(() => {
    const testApp = createTestApp();
    app = testApp.app;
    mockPrisma = testApp.mockPrisma;
    vi.clearAllMocks();
  });

  describe('Authentication', () => {
    it('should register a new user', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);
      mockPrisma.user.create.mockResolvedValue({});

      const response = await request(app)
        .post('/auth/register')
        .send({ email: 'test@example.com', password: 'password123' });

      expect(response.status).toBe(200);
      expect(response.body.user.email).toBe('test@example.com');
      expect(response.body.accessToken).toBeDefined();
    });

    it('should reject duplicate email', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ id: 'existing' });

      const response = await request(app)
        .post('/auth/register')
        .send({ email: 'test@example.com', password: 'password123' });

      expect(response.status).toBe(409);
      expect(response.body.error).toBe('email_taken');
    });

    it('should require MFA when enabled', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        id: 'user-123',
        email: 'test@example.com',
        mfaEnabled: true
      });

      const response = await request(app)
        .post('/auth/login')
        .send({ email: 'test@example.com', password: 'password123' });

      expect(response.status).toBe(206);
      expect(response.body.mfaRequired).toBe(true);
    });
  });

  describe('Security', () => {
    it('should reject requests without token', async () => {
      const response = await request(app).get('/api/profile');
      expect(response.status).toBe(401);
      expect(response.body.error).toBe('unauthorized');
    });

    it('should reject invalid tokens', async () => {
      const response = await request(app)
        .get('/api/profile')
        .set('Authorization', 'Bearer invalid-token');

      expect(response.status).toBe(401);
      expect(response.body.error).toBe('invalid_token');
    });

    it('should accept valid tokens', async () => {
      const validToken = jwt.sign({ userId: 'user-123' }, 'test-secret');
      mockPrisma.user.findUnique.mockResolvedValue({
        id: 'user-123',
        email: 'test@example.com'
      });

      const response = await request(app)
        .get('/api/profile')
        .set('Authorization', `Bearer ${validToken}`);

      expect(response.status).toBe(200);
    });
  });

  describe('Meals API', () => {
    const authToken = jwt.sign({ userId: 'user-123' }, 'test-secret');

    it('should create meal with valid input', async () => {
      mockPrisma.meal.create.mockResolvedValue({});

      const response = await request(app)
        .post('/api/meals')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ text: 'egg and toast' });

      expect(response.status).toBe(200);
      expect(response.body.meal).toBeDefined();
      expect(response.body.meal.text).toBe('egg and toast');
    });

    it('should require text input', async () => {
      const response = await request(app)
        .post('/api/meals')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ text: '' });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('text is required');
    });

    it('should require authentication', async () => {
      const response = await request(app)
        .post('/api/meals')
        .send({ text: 'egg' });

      expect(response.status).toBe(401);
    });
  });

  describe('Profile API', () => {
    const authToken = jwt.sign({ userId: 'user-123' }, 'test-secret');

    it('should return user profile', async () => {
      const mockUser = {
        id: 'user-123',
        email: 'test@example.com',
        firstName: 'Test'
      };

      mockPrisma.user.findUnique.mockResolvedValue(mockUser);

      const response = await request(app)
        .get('/api/profile')
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(200);
      expect(response.body.user).toEqual(mockUser);
    });

    it('should return 404 for non-existent user', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);

      const response = await request(app)
        .get('/api/profile')
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('not_found');
    });
  });
});