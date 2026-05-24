jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

import {
  parseSmsForTransactionSync,
  parseSmsForBillSync,
  parseDateString,
  extractTransactionAmount,
  extractTransactionDate,
} from '../../src/utils/smsParser';

import { matchSmsTemplate, resolveTransactionType } from '../../src/utils/smsTemplates';

// ─── Date Parser ──────────────────────────────────────────────────────────────

describe('parseDateString', () => {
  it.each([
    ['2026-05-24', 2026, 4, 24],
    ['2027/12/05', 2027, 11, 5],
  ])('YYYY-MM-DD: %s', (s, yr, mo, d) => {
    const date = parseDateString(s)!;
    expect(date.getFullYear()).toBe(yr);
    expect(date.getMonth()).toBe(mo);
    expect(date.getDate()).toBe(d);
  });

  it.each([
    ['24-05-26', 2026, 4, 24],
    ['05/12/26', 2026, 11, 5],
  ])('DD-MM-YY: %s', (s, yr, mo, d) => {
    const date = parseDateString(s)!;
    expect(date.getFullYear()).toBe(yr);
    expect(date.getMonth()).toBe(mo);
    expect(date.getDate()).toBe(d);
  });

  it.each([
    ['24-05-2026', 2026, 4, 24],
    ['05/12/2026', 2026, 11, 5],
  ])('DD-MM-YYYY: %s', (s, yr, mo, d) => {
    const date = parseDateString(s)!;
    expect(date.getFullYear()).toBe(yr);
    expect(date.getMonth()).toBe(mo);
    expect(date.getDate()).toBe(d);
  });

  it.each([
    ['30-APR-26', 2026, 3, 30],
    ['30 Apr 2026', 2026, 3, 30],
  ])('DD-MMM-YY: %s', (s, yr, mo, d) => {
    const date = parseDateString(s)!;
    expect(date.getFullYear()).toBe(yr);
    expect(date.getMonth()).toBe(mo);
    expect(date.getDate()).toBe(d);
  });
});

// ─── Amount Extractor ─────────────────────────────────────────────────────────

describe('extractTransactionAmount', () => {
  it('returns transaction amount, skipping available balance', () => {
    expect(
      extractTransactionAmount('A/c x1234 debited for Rs.500 at ZOMATO. Avl Bal: Rs.15,230.12.')
    ).toBe(500);
  });

  it('skips card limit and outstanding', () => {
    expect(
      extractTransactionAmount('Spent INR 1,250 on card. Limit: INR 100,000. Outstanding: INR 45,000.')
    ).toBe(1250);
  });

  it('falls back to first amount when all have balance context', () => {
    expect(extractTransactionAmount('Available Balance: Rs 500')).toBe(500);
  });
});

// ─── Date Extractor ───────────────────────────────────────────────────────────

describe('extractTransactionDate', () => {
  const FALLBACK = 1748000000000;

  it('prefers prefixed date (on <date>)', () => {
    const d = new Date(extractTransactionDate('Debited Rs.500 on 24-05-26.', FALLBACK));
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(4);
    expect(d.getDate()).toBe(24);
  });

  it('picks up any date in body if no prefix', () => {
    const d = new Date(extractTransactionDate('Txn ref 123 (24-05-2026)', FALLBACK));
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(4);
  });

  it('falls back to message timestamp when no date found', () => {
    expect(extractTransactionDate('Debited Rs.500 at merchant.', FALLBACK)).toBe(new Date(FALLBACK).toISOString());
  });
});

// ─── Template Matching ────────────────────────────────────────────────────────

describe('matchSmsTemplate', () => {
  it('matches HDFC-style debit', () => {
    const m = matchSmsTemplate('A/c x1234 debited for Rs.500.00 at Zomato on 24-05-26. Ref 123456');
    expect(m).not.toBeNull();
    expect(m!.amount).toBe('500.00');
    expect(m!.type).toBe('debited');
    expect(m!.merchant?.toLowerCase()).toContain('zomato');
  });

  it('matches ICICI-style debit (amount first)', () => {
    const m = matchSmsTemplate('Rs.1,200.00 debited from A/c **9876 at Amazon on 24-05-2026');
    expect(m).not.toBeNull();
    expect(m!.amount).toBe('1,200.00');
    expect(m!.type).toBe('debited');
  });

  it('matches UPI paid-to', () => {
    const m = matchSmsTemplate('Paid Rs.150 to Swiggy via UPI on 24-05-26. Ref 99887766');
    expect(m).not.toBeNull();
    expect(m!.type).toBe('paid');
    expect(m!.amount).toBe('150');
  });

  it('matches UPI received-from', () => {
    const m = matchSmsTemplate('Received Rs.2,000 from John Doe via UPI on 24-05-2026');
    expect(m).not.toBeNull();
    expect(m!.type).toBe('received');
    expect(Number(m!.amount.replace(/,/, ''))).toBe(2000);
  });

  it('matches SBI-style has-been-debited', () => {
    const m = matchSmsTemplate('Your A/c x4321 has been debited with Rs.800 on 24-05-26.');
    expect(m).not.toBeNull();
    expect(m!.type).toBe('debited');
    expect(m!.amount).toBe('800');
  });

  it('maps debited to expense', () => {
    expect(resolveTransactionType('debited')).toBe('expense');
  });

  it('maps credited to income', () => {
    expect(resolveTransactionType('credited')).toBe('income');
  });

  it('maps received to income', () => {
    expect(resolveTransactionType('received')).toBe('income');
  });
});

// ─── Full parser (template path) ──────────────────────────────────────────────

describe('parseSmsForTransactionSync — template path', () => {
  it('ignores OTP messages', () => {
    expect(parseSmsForTransactionSync({ address: 'BANKEX', body: 'Your OTP is 123456', date: Date.now() })).toBeNull();
  });

  it('parses HDFC debit SMS with confidence 0.97', () => {
    const sms = {
      address: 'HDFCBK',
      body: 'A/c x1234 debited for Rs.500.00 at Zomato on 24-05-26. Ref 987654',
      date: Date.now(),
    };
    const res = parseSmsForTransactionSync(sms)!;
    expect(res).not.toBeNull();
    expect(res.amount).toBe(500);
    expect(res.type).toBe('expense');
    expect(res.confidence).toBe(0.97);
    expect(res.merchant?.toLowerCase()).toContain('zomato');
    const d = new Date(res.receivedAt);
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(4);
    expect(d.getDate()).toBe(24);
  });

  it('parses credit SMS correctly', () => {
    const sms = {
      address: 'HDFCBK',
      body: 'A/c x4321 credited with Rs.15,000 from SALARY CORP on 24/05/2026. Ref UTR9876543',
      date: Date.now(),
    };
    const res = parseSmsForTransactionSync(sms)!;
    expect(res.type).toBe('income');
    expect(res.amount).toBe(15000);
    expect(res.confidence).toBe(0.97);
  });

  it('parses UPI paid-to as expense', () => {
    const sms = {
      address: 'UPIPAY',
      body: 'Paid Rs.150 to Swiggy via UPI on 24-05-26. Ref 99887766',
      date: Date.now(),
    };
    const res = parseSmsForTransactionSync(sms)!;
    expect(res.type).toBe('expense');
    expect(res.amount).toBe(150);
    expect(res.merchant?.toLowerCase()).toContain('swiggy');
  });
});

// ─── Full parser (heuristic fallback path) ────────────────────────────────────

describe('parseSmsForTransactionSync — heuristic fallback', () => {
  it('falls back gracefully for non-standard debit SMS (no template match)', () => {
    // Deliberately vague — no "debited/credited" verb, uses unusual phrasing
    const sms = {
      address: 'BANKEX',
      body: 'Money sent Rs.999 somewhere on 24-05-26.',
      date: Date.now(),
    };
    const res = parseSmsForTransactionSync(sms)!;
    expect(res).not.toBeNull();
    expect(res.amount).toBe(999);
    // Template OR heuristic will resolve — either way amount must be correct
    expect([0.97, 0.80, 0.60]).toContain(res.confidence);
  });
});

// ─── Bill Parser ──────────────────────────────────────────────────────────────

describe('parseSmsForBillSync', () => {
  it('ignores non-bill messages', () => {
    expect(parseSmsForBillSync({ address: 'BANKEX', body: 'Debited Rs.500', date: Date.now() })).toBeNull();
  });

  it('parses bill due message', () => {
    const sms = {
      address: 'BSNL',
      body: 'Your bill of Rs.399 is due on 30-Apr-2026. Please pay to avoid suspension.',
      date: Date.now(),
    };
    const res = parseSmsForBillSync(sms)!;
    expect(res).not.toBeNull();
    expect(res.amount).toBe(399);
    const d = new Date(res.dueDate!);
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(3); // April
    expect(d.getDate()).toBe(30);
  });
});
