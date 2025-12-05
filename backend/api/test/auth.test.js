import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import speakeasy from 'speakeasy';
import { v4 as uuid } from 'uuid';

// Mock Prisma
const mockPrisma = {
  user: {
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn()
  },
  trustedDevice: {
    create: vi.fn()
  }
};

vi.mock('@prisma/client', () => ({
  PrismaClient: vi.fn(() => mockPrisma)
}));

// Import after mocking
const { default: app } = await import('../src/server.js');

describe('Authentication', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('POST /auth/register', () => {
    it('should register a new user', async () => {
      const userData = {
        email: 'test@example.com',
        password: 'password123',
        firstName: 'Test',
        lastName: 'User'
      };

      mockPrisma.user.findUnique.mockResolvedValue(null);
      mockPrisma.user.create.mockResolvedValue({
        id: 'user-123',
        email: userData.email,
        firstName: userData.firstName,
        lastName: userData.lastName,
        mfaEnabled: false
      });

      const response = await request(app)
        .post('/auth/register')
        .send(userData);

      expect(response.status).toBe(200);
      expect(response.body.user.email).toBe(userData.email);
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

    it('should require email and password', async () => {
      const response = await request(app)
        .post('/auth/register')
        .send({});

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('email_and_password_required');
    });
  });

  describe('POST /auth/login', () => {
    it('should login with valid credentials', async () => {
      const hashedPassword = await bcrypt.hash('password123', 10);
      mockPrisma.user.findUnique.mockResolvedValue({
        id: 'user-123',
        email: 'test@example.com',
        passwordHash: hashedPassword,
        mfaEnabled: false,
        trustedDevices: []
      });

      const response = await request(app)
        .post('/auth/login')
        .send({ email: 'test@example.com', password: 'password123' });

      expect(response.status).toBe(200);
      expect(response.body.accessToken).toBeDefined();
    });

    it('should reject invalid credentials', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);

      const response = await request(app)
        .post('/auth/login')
        .send({ email: 'test@example.com', password: 'wrong' });

      expect(response.status).toBe(401);
      expect(response.body.error).toBe('invalid_credentials');
    });

    it('should require MFA when enabled', async () => {
      const hashedPassword = await bcrypt.hash('password123', 10);
      mockPrisma.user.findUnique.mockResolvedValue({
        id: 'user-123',
        email: 'test@example.com',
        passwordHash: hashedPassword,
        mfaEnabled: true,
        mfaSecret: 'secret',
        trustedDevices: []
      });

      const response = await request(app)
        .post('/auth/login')
        .send({ email: 'test@example.com', password: 'password123' });

      expect(response.status).toBe(206);
      expect(response.body.mfaRequired).toBe(true);
    });
  });

  describe('MFA Setup', () => {
    it('should generate MFA secret', async () => {
      const token = jwt.sign({ userId: 'user-123' }, 'dev-secret-change-me');
      mockPrisma.user.findUnique.mockResolvedValue({
        id: 'user-123',
        email: 'test@example.com'
      });

      const response = await request(app)
        .post('/auth/mfa/setup')
        .set('Authorization', `Bearer ${token}`);

      expect(response.status).toBe(200);
      expect(response.body.otpauth_url).toBeDefined();
      expect(response.body.base32).toBeDefined();
    });

    it('should verify MFA setup', async () => {
      const token = jwt.sign({ userId: 'user-123' }, 'dev-secret-change-me');
      const secret = speakeasy.generateSecret().base32;
      const totpToken = speakeasy.totp({ secret, encoding: 'base32' });

      // Mock temp secret storage on imported app
      app.locals.mfaTempSecrets = new Map();
      app.locals.mfaTempSecrets.set('user-123', { secret, expiresAt: Date.now() + 600000 });

      mockPrisma.user.update.mockResolvedValue({});

      const response = await request(app)
        .post('/auth/mfa/verify')
        .set('Authorization', `Bearer ${token}`)
        .send({ token: totpToken });

      expect(response.status).toBe(200);
      expect(response.body.mfaEnabled).toBe(true);
    });
  });
});
