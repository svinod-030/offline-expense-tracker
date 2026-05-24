import { NativeModules, Platform } from 'react-native';
import {
  SmsMessage,
  ParsedSmsTransaction,
  ParsedSmsBill,
} from '../types';

import { getParserConfig } from './remoteConfig';
import {
  matchSmsTemplate,
  resolveTransactionType,
  resolveTransactionKind,
} from './smsTemplates';

const { SmsEventModule } = NativeModules;

// ─── Non-transactional message guard patterns ─────────────────────────────────
// Skip messages matching these before any parsing attempt.
const NON_TRANSACTIONAL = [
  /\botp\b/i,
  /one.?time.?pass/i,
  /\b(?:recharge|top-up)s?\s+(?:your|now|to|on|every)\b/i,
  /\b(?:offer|discount|vouchers?|plan)s?\s+valid\b/i,
  /\b(?:dial|call)\s+\*[\d#]+/i,
  /\b(?:win|claim|get|save)\s+(?:rewards?|prizes?|vouchers?|more|cashback)\b/i,
  /\bclick\s+(?:here|to|link)\b/i,
  /\b(?:today|tonight|exclusive|limited|family)\s+offer\b/i,
  /\b(?:switch|join|upgrade)\s+now\b/i,
  /\bget\s+family\s+plans?\b/i,
];

// ─── Bill detection ───────────────────────────────────────────────────────────
const BILL_KEYWORDS = /\b(due|outstanding|reminder|overdue|minimum\s+due|total\s+due)\b/i;

// ─── Amount patterns ──────────────────────────────────────────────────────────
const AMOUNT_PATTERN = /(?:rs\.?|inr|₹)\s*([0-9,]+(?:\.[0-9]{1,2})?)/i;
const AMOUNT_GLOBAL = /(?:rs\.?|inr|₹)\s*([0-9,]+(?:\.[0-9]{1,2})?)/gi;

// ─── Metadata patterns ────────────────────────────────────────────────────────
const ACCOUNT_PATTERN = /(?:a\/c|acct|account|card(?:\s+ending)?)\s*[x*]*([0-9]{2,6})/i;
const REF_PATTERN = /(?:ref(?:erence)?(?:\s*(?:no\.?|id))?|utr(?:\s*no\.?)?|txn(?:\s*id)?)\s*[:\-]?\s*([a-z0-9]{6,30})/i;

// ─── Date helpers ─────────────────────────────────────────────────────────────

const MONTH_INDEX: Record<string, number> = {
  jan: 0, january: 0,
  feb: 1, february: 1,
  mar: 2, march: 2,
  apr: 3, april: 3,
  may: 4,
  jun: 5, june: 5,
  jul: 6, july: 6,
  aug: 7, august: 7,
  sep: 8, september: 8,
  oct: 9, october: 9,
  nov: 10, november: 10,
  dec: 11, december: 11,
};

/**
 * Parses common date string formats, bypassing unreliable native Date parsing on Hermes.
 */
export function parseDateString(dateStr: string): Date | null {
  if (!dateStr) return null;
  const s = dateStr.trim();

  // YYYY-MM-DD or YYYY/MM/DD
  let m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (m) {
    const d = new Date(+m[1], +m[2] - 1, +m[3]);
    if (!isNaN(d.getTime())) return d;
  }

  // DD-MM-YY (2-digit year)
  m = s.match(/^(\d{1,2})[-/\s](\d{1,2})[-/\s](\d{2})$/);
  if (m) {
    const d = new Date(2000 + +m[3], +m[2] - 1, +m[1]);
    if (!isNaN(d.getTime()) && +m[2] <= 12 && +m[1] <= 31) return d;
  }

  // DD-MM-YYYY (4-digit year)
  m = s.match(/^(\d{1,2})[-/\s](\d{1,2})[-/\s](\d{4})$/);
  if (m) {
    const d = new Date(+m[3], +m[2] - 1, +m[1]);
    if (!isNaN(d.getTime()) && +m[2] <= 12 && +m[1] <= 31) return d;
  }

  // DD-MMM-YY(YY) e.g. "30 APR 26", "30-Apr-2026"
  m = s.match(/^(\d{1,2})[-/\s]+([A-Za-z]{3,9})[-/\s]+(\d{2,4})$/);
  if (m) {
    const monthIdx = MONTH_INDEX[m[2].toLowerCase()];
    if (monthIdx !== undefined) {
      const year = m[3].length <= 2 ? 2000 + +m[3] : +m[3];
      const d = new Date(year, monthIdx, +m[1]);
      if (!isNaN(d.getTime())) return d;
    }
  }

  // Native fallback
  const d = new Date(s);
  if (!isNaN(d.getTime())) {
    if (d.getFullYear() < 100) d.setFullYear(2000 + d.getFullYear());
    return d;
  }

  return null;
}

const DATE_IN_BODY =
  /\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}[-/]\d{1,2}[-/]\d{2,4}|\d{1,2}[\s\-]+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*[\s\-]+\d{2,4}/i;

/**
 * Extracts a date from the SMS body.
 * Prioritizes dates preceded by "on/date/dt/at".
 * Falls back to any date in the body, then to message timestamp.
 */
export function extractTransactionDate(body: string, messageTimestamp: number): string {
  const prefixed = body.match(
    new RegExp(`(?:on|date|dt|at)\\s*[:\\s]*(${DATE_IN_BODY.source})`, 'i')
  );
  if (prefixed?.[1]) {
    const d = parseDateString(prefixed[1]);
    if (d) return d.toISOString();
  }
  const general = body.match(DATE_IN_BODY);
  if (general?.[0]) {
    const d = parseDateString(general[0]);
    if (d) return d.toISOString();
  }
  return new Date(messageTimestamp).toISOString();
}

// ─── Heuristic Fallback Helpers ───────────────────────────────────────────────

/**
 * Returns true if the amount at position `start` is preceded by balance/limit keywords.
 */
function isBalanceOrLimit(body: string, start: number): boolean {
  const prefix = body.substring(0, start).toLowerCase().slice(-35);
  return /\b(?:bal(?:ance)?|avl|available|updated\s+bal|new\s+bal|limit|outstanding|due|overdue|total\s+due|statement|max\s+limit)\b/.test(prefix);
}

/**
 * Heuristic amount extractor — scans all amount matches, skips balance/limit context.
 */
export function extractTransactionAmount(body: string): number | null {
  let match: RegExpExecArray | null;
  let firstVal: number | null = null;
  const re = new RegExp(AMOUNT_GLOBAL.source, 'gi');

  while ((match = re.exec(body)) !== null) {
    const val = Number(match[1].replace(/,/g, ''));
    if (val > 0) {
      if (firstVal === null) firstVal = val;
      if (!isBalanceOrLimit(body, match.index)) return val;
    }
  }
  return firstVal;
}

/**
 * Heuristic type detection — last resort when no template matches.
 */
function heuristicType(body: string): 'expense' | 'income' | null {
  const lower = body.toLowerCase();
  const config = getParserConfig();
  if (config.excludeKeywords.some(kw => lower.includes(kw))) return null;
  if (/\b(debited|spent|paid|purchase|withdrawn|withdrawal|sent)\b/.test(lower)) return 'expense';
  if (/\b(credited|received|deposited|refund)\b/.test(lower)) return 'income';
  if (/\b(neft|imps|rtgs|transfer)\b/.test(lower)) return 'expense';
  return null;
}

/**
 * Heuristic kind detection — last resort when no template matches.
 */
function heuristicKind(body: string): 'expense' | 'income' | 'refund' | 'transfer' {
  const lower = body.toLowerCase();
  if (/\b(refund|reversed|chargeback)\b/.test(lower)) return 'refund';
  if (/\b(neft|imps|rtgs|transfer)\b/.test(lower)) return 'transfer';
  if (/\b(credited|received|deposited)\b/.test(lower)) return 'income';
  return 'expense';
}

// ─── Merchant Cleaning ────────────────────────────────────────────────────────

function cleanMerchant(name: string | undefined): string {
  if (!name) return '';
  const config = getParserConfig();

  let s = name
    .replace(/\b(?:vpa|upi|info|id|ref|txn|a\/c|acct|acc|date)\b.*$/i, '')
    .replace(/[*\-]/g, ' ')
    .replace(/(?:\.Avl|\bAvl\b|\bCheque\b).*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();

  const words = s.split(' ');
  while (words.length > 1 && config.merchantNoiseWords.includes(words[0].toLowerCase())) words.shift();
  while (words.length > 1 && config.merchantNoiseWords.includes(words[words.length - 1].toLowerCase())) words.pop();

  s = words.join(' ').trim();
  if (!s || /^rs\.?\s*\d/i.test(s) || (/^[0-9 ]+$/.test(s) && s.length < 4)) return '';
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Heuristic merchant extractor for when template doesn't capture a merchant.
 */
function heuristicMerchant(body: string): string | undefined {
  const config = getParserConfig();

  // 1. Direct merchant name list
  for (const m of config.directMerchants) {
    const re = new RegExp(`\\b${m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    if (re.test(body)) return m.charAt(0).toUpperCase() + m.slice(1).toLowerCase();
  }

  // 2. Positional: to/at/from/towards <Merchant>
  const pos = body.match(
    /(?:to|at|from|towards|for|by)\s+([A-Za-z0-9 .&'-]{2,60}?)(?:\s+(?:on|for|using|via|ref|id|balance|bal|date|is|at)|\.|$)/i
  );
  if (pos?.[1]) {
    const cleaned = cleanMerchant(pos[1]);
    if (cleaned && cleaned.length > 2) return cleaned;
  }

  // 3. All-caps clusters
  const caps = body.match(/([A-Z][A-Za-z0-9]*(?:\s+[A-Z][A-Za-z0-9]*){0,2})/g);
  if (caps) {
    for (const c of caps) {
      if (c.length >= 3 && !config.allCapsNoiseWords.some(w => c.toUpperCase().includes(w))) {
        const cleaned = cleanMerchant(c);
        if (cleaned && cleaned.length > 2) return cleaned;
      }
    }
  }

  return undefined;
}

// ─── Hash Builder ─────────────────────────────────────────────────────────────

export function buildHash(sender: string, body: string, date: number): string {
  const key = `${sender.replace(/\W/g, '').toLowerCase()}|${body.trim()}|${Math.floor(date / 1000)}`;
  let h = 0;
  for (let i = 0; i < key.length; i++) {
    h = (h << 5) - h + key.charCodeAt(i);
    h |= 0;
  }
  return `msg_${Math.abs(h)}`;
}

// ─── Main Parser ──────────────────────────────────────────────────────────────

/**
 * Primary SMS transaction parser.
 *
 * Strategy:
 *   1. Block non-transactional messages (OTP, offers, etc.)
 *   2. Try structural template matching — one regex that yields ALL fields.
 *   3. If no template matches, fall back to heuristic keyword + regex extraction.
 *   4. Validate extracted amount and return null if nothing valid found.
 */
export function parseSmsForTransactionSync(message: SmsMessage): ParsedSmsTransaction | null {
  const sender = message.address?.trim();
  const body = message.body?.trim();
  if (!sender || !body) return null;

  // ── Step 1: Block non-transactional noise ─────────────────────────────────
  if (NON_TRANSACTIONAL.some(p => p.test(body))) return null;
  if (BILL_KEYWORDS.test(body)) return null; // Let parseSmsForBill handle these

  // ── Step 2: Structural template matching (preferred path) ─────────────────
  const tmpl = matchSmsTemplate(body);

  if (tmpl) {
    const amount = Number(tmpl.amount.replace(/,/g, ''));
    if (!amount || amount <= 0) return null;

    const type = resolveTransactionType(tmpl.type);
    const kind = resolveTransactionKind(tmpl.type, body);

    // Date: prefer template capture, then scan body, then fallback
    const date = tmpl.date
      ? (parseDateString(tmpl.date)?.toISOString() ?? extractTransactionDate(body, message.date))
      : extractTransactionDate(body, message.date);

    // Merchant: prefer template capture, then heuristic
    const merchantRaw = tmpl.merchant ? cleanMerchant(tmpl.merchant) : undefined;
    const merchant = (merchantRaw && merchantRaw.length > 2)
      ? merchantRaw
      : heuristicMerchant(body);

    // Account & Ref: template capture takes priority, then regex scan body
    const account = tmpl.account ?? body.match(ACCOUNT_PATTERN)?.[1]?.trim();
    const ref = tmpl.ref ?? body.match(REF_PATTERN)?.[1]?.trim();

    return {
      sender,
      body,
      receivedAt: date,
      hash: buildHash(sender, body, message.date),
      amount,
      type,
      kind,
      merchant: (merchant && merchant.length > 2) ? merchant : undefined,
      referenceId: ref,
      accountRef: account,
      confidence: 0.97,  // Template match = high confidence
    };
  }

  // ── Step 3: Heuristic fallback ────────────────────────────────────────────
  const type = heuristicType(body);
  if (!type) return null;

  const amount = extractTransactionAmount(body);
  if (!amount || amount <= 0) return null;

  const date = extractTransactionDate(body, message.date);
  const merchant = heuristicMerchant(body);
  const account = body.match(ACCOUNT_PATTERN)?.[1]?.trim();
  const ref = body.match(REF_PATTERN)?.[1]?.trim();

  return {
    sender,
    body,
    receivedAt: date,
    hash: buildHash(sender, body, message.date),
    amount,
    type,
    kind: heuristicKind(body),
    merchant: (merchant && merchant.length > 2) ? merchant : undefined,
    referenceId: ref,
    accountRef: account,
    confidence: merchant ? 0.80 : 0.60,  // Heuristic = lower confidence
  };
}

/**
 * Async wrapper — calls synchronous parser.
 */
export async function parseSmsForTransaction(
  message: SmsMessage
): Promise<ParsedSmsTransaction | null> {
  return parseSmsForTransactionSync(message);
}

// ─── Bill Parser ──────────────────────────────────────────────────────────────

export function parseSmsForBillSync(sms: SmsMessage): ParsedSmsBill | null {
  const lower = sms.body.toLowerCase();
  const config = getParserConfig();
  if (!config.billKeywords.some(kw => lower.includes(kw))) return null;

  const amountMatch = sms.body.match(AMOUNT_PATTERN);
  if (!amountMatch) return null;
  const amount = Number(amountMatch[1].replace(/,/g, ''));
  if (amount <= 0) return null;

  const datePatterns = [
    new RegExp(`(?:due|by|on|since)\\s*[:\\s]*(${DATE_IN_BODY.source})`, 'i'),
    new RegExp(`(${DATE_IN_BODY.source})`, 'i'),
  ];

  let dueDate = new Date(sms.date).toISOString();
  for (const pattern of datePatterns) {
    const m = sms.body.match(pattern);
    if (m?.[1]) {
      const parsed = parseDateString(m[1].trim());
      if (parsed) { dueDate = parsed.toISOString(); break; }
    }
  }

  return {
    sender: sms.address,
    body: sms.body,
    receivedAt: new Date(sms.date).toISOString(),
    amount,
    dueDate,
    merchant: cleanMerchant(sms.address),
  };
}

export async function parseSmsForBill(sms: SmsMessage): Promise<ParsedSmsBill | null> {
  return parseSmsForBillSync(sms);
}

// ─── Notifications ────────────────────────────────────────────────────────────

export function showTransactionNotification(tx: ParsedSmsTransaction): void {
  if (Platform.OS !== 'android' || !SmsEventModule) return;
  SmsEventModule.postNotification(tx.amount, tx.type, tx.merchant || null, tx.sender);
}

export function showBillNotification(bill: ParsedSmsBill): void {
  if (Platform.OS !== 'android' || !SmsEventModule) return;
  SmsEventModule.postBillNotification(bill.amount, bill.dueDate || null, bill.sender);
}
