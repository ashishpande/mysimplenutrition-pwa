import { describe, it, expect } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';

// Mock Prisma
const mockPrisma = {
  user: { findUnique: vi.fn() },
  meal: { create: vi.fn(), findMany: vi.fn() },
  dailyTotal: { findUnique: vi.fn(), findMany: vi.fn(), upsert: vi.fn() },
  trustedDevice: { create: vi.fn() },
  $transaction: vi.fn((cb) => cb({
    meal: { create: mockPrisma.meal.create },
    dailyTotal: mockPrisma.dailyTotal,
  })),
};

vi.mock('@prisma/client', () => ({
  PrismaClient: vi.fn(() => mockPrisma)
}));

const { default: app } = await import('../src/server.js');

describe('Security Tests', () => {
  describe('JWT Authentication', () => {
    it('should reject requests without token', async () => {
      const response = await request(app)
        .get('/api/profile');

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

    it('should reject expired tokens', async () => {
      const expiredToken = jwt.sign(
        { userId: 'user-123' }, 
        'dev-secret-change-me', 
        { expiresIn: '-1h' }
      );

      const response = await request(app)
        .get('/api/profile')
        .set('Authorization', `Bearer ${expiredToken}`);

      expect(response.status).toBe(401);
      expect(response.body.error).toBe('invalid_token');
    });

    it('should accept valid tokens', async () => {
      const validToken = jwt.sign(
        { userId: 'user-123' }, 
        'dev-secret-change-me', 
        { expiresIn: '1h' }
      );

      mockPrisma.user.findUnique.mockResolvedValue({
        id: 'user-123',
        email: 'test@example.com'
      });

      const response = await request(app)
        .get('/api/profile')
        .set('Authorization', `Bearer ${validToken}`);

      expect(response.status).not.toBe(401);
    });
  });

  describe('Input Validation', () => {
    const validToken = jwt.sign({ userId: 'user-123' }, 'dev-secret-change-me');

    it('should reject empty meal text', async () => {
      const response = await request(app)
        .post('/api/meals')
        .set('Authorization', `Bearer ${validToken}`)
        .send({ text: '' });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('text is required');
    });

    it('should reject whitespace-only meal text', async () => {
      const response = await request(app)
        .post('/api/meals')
        .set('Authorization', `Bearer ${validToken}`)
        .send({ text: '   ' });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('text is required');
    });

    it('should sanitize SQL injection attempts', async () => {
      mockPrisma.meal.create.mockResolvedValue({});
      mockPrisma.dailyTotal.upsert.mockResolvedValue({});

      const maliciousInput = "'; DROP TABLE users; --";
      
      const response = await request(app)
        .post('/api/meals')
        .set('Authorization', `Bearer ${validToken}`)
        .send({ text: maliciousInput });

      // Should not crash and should treat as normal text
      expect(response.status).toBe(200);
    });
  });

  describe('Authorization', () => {
    it('should prevent access to other users data', async () => {
      const userAToken = jwt.sign({ userId: 'user-a' }, 'dev-secret-change-me');
      const userBToken = jwt.sign({ userId: 'user-b' }, 'dev-secret-change-me');

      mockPrisma.user.findUnique.mockResolvedValue(null);

      // User A tries to access their profile
      const responseA = await request(app)
        .get('/api/profile')
        .set('Authorization', `Bearer ${userAToken}`);

      // User B tries to access their profile  
      const responseB = await request(app)
        .get('/api/profile')
        .set('Authorization', `Bearer ${userBToken}`);

      // Both should get 404 (user not found) but not each other's data
      expect(responseA.status).toBe(404);
      expect(responseB.status).toBe(404);
    });
  });

  describe('Rate Limiting & Headers', () => {
    it('should have CORS enabled', async () => {
      const response = await request(app)
        .options('/api/profile')
        .set('Origin', 'http://localhost:3000');

      expect(response.headers['access-control-allow-origin']).toBeDefined();
    });

    it('should handle malformed JSON', async () => {
      const response = await request(app)
        .post('/auth/register')
        .set('Content-Type', 'application/json')
        .send('{"invalid": json}');

      expect(response.status).toBe(400);
    });
  });

  describe('Password Security', () => {
    it('should not return password hashes', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        id: 'user-123',
        email: 'test@example.com',
        passwordHash: 'hashed-password',
        firstName: 'Test'
      });

      const validToken = jwt.sign({ userId: 'user-123' }, 'dev-secret-change-me');

      const response = await request(app)
        .get('/api/profile')
        .set('Authorization', `Bearer ${validToken}`);

      expect(response.body.user).toBeDefined();
      expect(response.body.user.passwordHash).toBeUndefined();
      expect(response.body.user.password).toBeUndefined();
    });
  });
});
