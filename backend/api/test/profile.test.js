import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';

// Mock Prisma
const mockPrisma = {
  user: {
    findUnique: vi.fn(),
    update: vi.fn()
  }
};

vi.mock('@prisma/client', () => ({
  PrismaClient: vi.fn(() => mockPrisma)
}));

const { default: app } = await import('../src/server.js');

describe('Profile API', () => {
  const authToken = jwt.sign({ userId: 'user-123' }, 'dev-secret-change-me');

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('GET /api/profile', () => {
    it('should return user profile', async () => {
      const mockUser = {
        id: 'user-123',
        email: 'test@example.com',
        firstName: 'Test',
        lastName: 'User',
        heightCm: 175,
        weightKg: 70,
        mfaEnabled: false
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

    it('should require authentication', async () => {
      const response = await request(app)
        .get('/api/profile');

      expect(response.status).toBe(401);
      expect(response.body.error).toBe('unauthorized');
    });
  });

  describe('PUT /api/profile', () => {
    it('should update profile with metric units', async () => {
      const updateData = {
        firstName: 'Updated',
        lastName: 'Name',
        heightUnit: 'cm',
        heightValue: 180,
        weightUnit: 'kg',
        weightValue: 75
      };

      const updatedUser = {
        id: 'user-123',
        email: 'test@example.com',
        firstName: 'Updated',
        lastName: 'Name',
        heightCm: 180,
        weightKg: 75,
        mfaEnabled: false
      };

      mockPrisma.user.update.mockResolvedValue(updatedUser);

      const response = await request(app)
        .put('/api/profile')
        .set('Authorization', `Bearer ${authToken}`)
        .send(updateData);

      expect(response.status).toBe(200);
      expect(response.body.user.firstName).toBe('Updated');
      expect(response.body.user.heightCm).toBe(180);
      expect(response.body.user.weightKg).toBe(75);
    });

    it('should convert imperial units', async () => {
      const updateData = {
        heightUnit: 'ftin',
        heightFeet: 5,
        heightInches: 10,
        weightUnit: 'lbs',
        weightValue: 165
      };

      mockPrisma.user.update.mockResolvedValue({
        id: 'user-123',
        heightCm: 177.8, // 5'10" in cm
        weightKg: 74.84 // 165 lbs in kg
      });

      const response = await request(app)
        .put('/api/profile')
        .set('Authorization', `Bearer ${authToken}`)
        .send(updateData);

      expect(response.status).toBe(200);
      expect(Math.round(response.body.user.heightCm)).toBe(178);
      expect(Math.round(response.body.user.weightKg)).toBe(75);
    });

    it('should handle database errors', async () => {
      mockPrisma.user.update.mockRejectedValue(new Error('DB Error'));

      const response = await request(app)
        .put('/api/profile')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ firstName: 'Test' });

      expect(response.status).toBe(500);
      expect(response.body.error).toBe('server_error');
    });
  });
});