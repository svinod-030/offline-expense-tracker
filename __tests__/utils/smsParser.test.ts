jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

import {
  parseSmsForTransactionSync,
  parseSmsForBillSync,
  parseDateString,
  extractTransactionAmount,
  extractTransactionDate
} from '../../src/utils/smsParser';

describe('Date String Parser', () => {
  it('should parse YYYY-MM-DD and YYYY/MM/DD formats correctly', () => {
    const d1 = parseDateString('2026-05-24');
    expect(d1?.getFullYear()).toBe(2026);
    expect(d1?.getMonth()).toBe(4); // May is 4
    expect(d1?.getDate()).toBe(24);

    const d2 = parseDateString('2027/12/05');
    expect(d2?.getFullYear()).toBe(2027);
    expect(d2?.getMonth()).toBe(11); // December is 11
    expect(d2?.getDate()).toBe(5);
  });

  it('should parse DD-MM-YY and DD/MM/YY formats correctly (Indian standard)', () => {
    const d1 = parseDateString('24-05-26');
    expect(d1?.getFullYear()).toBe(2026);
    expect(d1?.getMonth()).toBe(4);
    expect(d1?.getDate()).toBe(24);

    const d2 = parseDateString('05/12/26');
    expect(d2?.getFullYear()).toBe(2026);
    expect(d2?.getMonth()).toBe(11);
    expect(d2?.getDate()).toBe(5);
  });

  it('should parse DD-MM-YYYY and DD/MM/YYYY formats correctly', () => {
    const d1 = parseDateString('24-05-2026');
    expect(d1?.getFullYear()).toBe(2026);
    expect(d1?.getMonth()).toBe(4);
    expect(d1?.getDate()).toBe(24);

    const d2 = parseDateString('05/12/2026');
    expect(d2?.getFullYear()).toBe(2026);
    expect(d2?.getMonth()).toBe(11);
    expect(d2?.getDate()).toBe(5);
  });

  it('should parse DD-MMM-YY(YY) formats correctly', () => {
    const d1 = parseDateString('30-APR-26');
    expect(d1?.getFullYear()).toBe(2026);
    expect(d1?.getMonth()).toBe(3); // April is 3
    expect(d1?.getDate()).toBe(30);

    const d2 = parseDateString('30 Apr 2026');
    expect(d2?.getFullYear()).toBe(2026);
    expect(d2?.getMonth()).toBe(3);
    expect(d2?.getDate()).toBe(30);
  });
});

describe('Heuristic Amount Extractor', () => {
  it('should extract transaction amount and filter out available balance', () => {
    const body = 'Your A/C x1234 has been debited for Rs. 500.00 at ZOMATO. Avl Bal: Rs. 15,230.12.';
    const amount = extractTransactionAmount(body);
    expect(amount).toBe(500);
  });

  it('should extract spent amount and filter out limit / outstanding', () => {
    const body = 'Spent INR 1,250.00 on your card ending 9876. Limit: INR 100,000. Outstanding: INR 45,000.00.';
    const amount = extractTransactionAmount(body);
    expect(amount).toBe(1250);
  });

  it('should fall back to first amount if all amounts are adjacent to keywords', () => {
    const body = 'Available Balance: Rs 500';
    const amount = extractTransactionAmount(body);
    expect(amount).toBe(500);
  });
});

describe('Transaction Date Extractor', () => {
  it('should prioritize prefixed date in body', () => {
    const body = 'Debited Rs. 500 on 24-05-26 from your account.';
    const dateStr = extractTransactionDate(body, 1774354200000); // Some default fallback timestamp
    const d = new Date(dateStr);
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(4); // May
    expect(d.getDate()).toBe(24);
  });

  it('should match any general date in body if no prefix is found', () => {
    const body = 'Debited Rs. 500 (txn date 24-05-2026)';
    const dateStr = extractTransactionDate(body, 1774354200000);
    const d = new Date(dateStr);
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(4);
    expect(d.getDate()).toBe(24);
  });

  it('should fallback to message date if no dates match', () => {
    const fallback = 1774354200000;
    const body = 'Debited Rs. 500 at merchant.';
    const dateStr = extractTransactionDate(body, fallback);
    expect(new Date(dateStr).getTime()).toBe(fallback);
  });
});

describe('SMS Transaction Parser Sync', () => {
  it('should ignore non-transactional / OTP messages', () => {
    const sms = {
      address: 'BANKEX',
      body: 'Your OTP is 123456 to login to Bank app.',
      date: Date.now()
    };
    expect(parseSmsForTransactionSync(sms)).toBeNull();
  });

  it('should parse valid debit SMS correctly', () => {
    const sms = {
      address: 'BANKEX',
      body: 'Your A/C x1234 has been debited for Rs. 500.00 at Zomato on 24-05-26. Ref: 123456.',
      date: Date.now()
    };
    const res = parseSmsForTransactionSync(sms);
    expect(res).not.toBeNull();
    expect(res?.amount).toBe(500);
    expect(res?.type).toBe('expense');
    expect(res?.merchant).toBe('Zomato');
    expect(res?.accountRef).toBe('1234');
    expect(res?.referenceId).toBe('123456');
    const parsedDate = new Date(res!.receivedAt);
    expect(parsedDate.getFullYear()).toBe(2026);
    expect(parsedDate.getMonth()).toBe(4); // May
    expect(parsedDate.getDate()).toBe(24);
  });

  it('should parse valid credit SMS correctly', () => {
    const sms = {
      address: 'BANKEX',
      body: 'Your A/C x4321 has been credited with Rs. 15,000.00 on 24/05/2026. Ref: UTR98765.',
      date: Date.now()
    };
    const res = parseSmsForTransactionSync(sms);
    expect(res).not.toBeNull();
    expect(res?.amount).toBe(15000);
    expect(res?.type).toBe('income');
    expect(res?.referenceId).toBe('UTR98765');
    const parsedDate = new Date(res!.receivedAt);
    expect(parsedDate.getFullYear()).toBe(2026);
    expect(parsedDate.getMonth()).toBe(4);
    expect(parsedDate.getDate()).toBe(24);
  });
});

describe('SMS Bill Parser Sync', () => {
  it('should ignore transaction messages', () => {
    const sms = {
      address: 'BANKEX',
      body: 'Your A/C x1234 has been debited for Rs. 500.00',
      date: Date.now()
    };
    expect(parseSmsForBillSync(sms)).toBeNull();
  });

  it('should parse bill due message correctly', () => {
    const sms = {
      address: 'BSNL',
      body: 'Your bill of Rs. 399.00 is due on 30-Apr-2026. Please pay to avoid suspension.',
      date: Date.now()
    };
    const res = parseSmsForBillSync(sms);
    expect(res).not.toBeNull();
    expect(res?.amount).toBe(399);
    const parsedDueDate = new Date(res!.dueDate!);
    expect(parsedDueDate.getFullYear()).toBe(2026);
    expect(parsedDueDate.getMonth()).toBe(3); // April
    expect(parsedDueDate.getDate()).toBe(30);
  });
});
