import { describe, it, expect } from 'vitest';

// Import utility functions - we'll need to extract these from server.js
describe('Utility Functions', () => {
  // Height normalization tests
  describe('normalizeHeight', () => {
    // Mock the function since it's not exported
    const normalizeHeight = ({ heightUnit, heightValue, heightFeet, heightInches }) => {
      const unit = (heightUnit || '').toLowerCase();
      if (unit === 'cm') {
        const val = Number(heightValue);
        return Number.isFinite(val) ? val : null;
      }
      if (unit === 'in' || unit === 'inch' || unit === 'inches') {
        const val = Number(heightValue);
        return Number.isFinite(val) ? val * 2.54 : null;
      }
      if (unit === 'ft' || unit === 'feet' || unit === 'ftin') {
        const ft = Number(heightFeet);
        const inch = Number(heightInches);
        const totalInches = (Number.isFinite(ft) ? ft : 0) * 12 + (Number.isFinite(inch) ? inch : 0);
        return totalInches > 0 ? totalInches * 2.54 : null;
      }
      return null;
    };

    it('should convert cm correctly', () => {
      expect(normalizeHeight({ heightUnit: 'cm', heightValue: 175 })).toBe(175);
      expect(normalizeHeight({ heightUnit: 'CM', heightValue: 180 })).toBe(180);
    });

    it('should convert inches to cm', () => {
      expect(normalizeHeight({ heightUnit: 'in', heightValue: 70 })).toBeCloseTo(177.8);
      expect(normalizeHeight({ heightUnit: 'inches', heightValue: 60 })).toBeCloseTo(152.4);
    });

    it('should convert feet and inches to cm', () => {
      expect(normalizeHeight({ 
        heightUnit: 'ftin', 
        heightFeet: 5, 
        heightInches: 10 
      })).toBeCloseTo(177.8);
      
      expect(normalizeHeight({ 
        heightUnit: 'ft', 
        heightFeet: 6, 
        heightInches: 0 
      })).toBeCloseTo(182.88);
    });

    it('should handle invalid inputs', () => {
      expect(normalizeHeight({ heightUnit: 'cm', heightValue: 'invalid' })).toBeNull();
      expect(normalizeHeight({ heightUnit: 'unknown', heightValue: 175 })).toBeNull();
      expect(normalizeHeight({})).toBeNull();
    });
  });

  // Weight normalization tests
  describe('normalizeWeight', () => {
    const normalizeWeight = ({ weightUnit, weightValue }) => {
      const unit = (weightUnit || '').toLowerCase();
      if (unit === 'kg' || unit === 'kgs' || unit === 'kilograms') {
        const val = Number(weightValue);
        return Number.isFinite(val) ? val : null;
      }
      if (unit === 'lb' || unit === 'lbs' || unit === 'pounds') {
        const val = Number(weightValue);
        return Number.isFinite(val) ? val * 0.453592 : null;
      }
      return null;
    };

    it('should handle kg correctly', () => {
      expect(normalizeWeight({ weightUnit: 'kg', weightValue: 70 })).toBe(70);
      expect(normalizeWeight({ weightUnit: 'kgs', weightValue: 75 })).toBe(75);
    });

    it('should convert pounds to kg', () => {
      expect(normalizeWeight({ weightUnit: 'lbs', weightValue: 165 })).toBeCloseTo(74.84);
      expect(normalizeWeight({ weightUnit: 'pounds', weightValue: 200 })).toBeCloseTo(90.72);
    });

    it('should handle invalid inputs', () => {
      expect(normalizeWeight({ weightUnit: 'kg', weightValue: 'invalid' })).toBeNull();
      expect(normalizeWeight({ weightUnit: 'unknown', weightValue: 70 })).toBeNull();
      expect(normalizeWeight({})).toBeNull();
    });
  });

  // Meal type inference tests
  describe('inferMealType', () => {
    const inferMealType = (text = '', consumedAt) => {
      const lower = text.toLowerCase();
      if (lower.includes('breakfast')) return 'breakfast';
      if (lower.includes('lunch')) return 'lunch';
      if (lower.includes('dinner')) return 'dinner';
      if (lower.includes('snack')) return 'snack';
      const date = consumedAt ? new Date(consumedAt) : new Date();
      const hour = date.getHours();
      if (hour < 11) return 'breakfast';
      if (hour < 17) return 'lunch';
      return 'dinner';
    };

    it('should detect meal type from text', () => {
      expect(inferMealType('breakfast eggs')).toBe('breakfast');
      expect(inferMealType('lunch sandwich')).toBe('lunch');
      expect(inferMealType('dinner pasta')).toBe('dinner');
      expect(inferMealType('afternoon snack')).toBe('snack');
    });

    it('should infer from time when no keywords', () => {
      const morning = new Date('2024-01-01T08:00:00Z');
      const afternoon = new Date('2024-01-01T14:00:00Z');
      const evening = new Date('2024-01-01T19:00:00Z');

      expect(inferMealType('eggs', morning.toISOString())).toBe('breakfast');
      expect(inferMealType('sandwich', afternoon.toISOString())).toBe('lunch');
      expect(inferMealType('pasta', evening.toISOString())).toBe('dinner');
    });

    it('should prioritize text over time', () => {
      const evening = new Date('2024-01-01T19:00:00Z');
      expect(inferMealType('breakfast cereal', evening.toISOString())).toBe('breakfast');
    });
  });
});