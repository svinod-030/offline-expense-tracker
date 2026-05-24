import { NativeModules, Platform } from 'react-native';
import {
  SmsMessage,
  ParsedSmsTransaction,
  ParsedSmsBill,
  ParsedTransactionType,
  TransactionKind
} from '../types';

import { getParserConfig } from './remoteConfig';

const { SmsEventModule } = NativeModules;

// ─── Native bridge (Notifications only) ───────────────────────────────────────

// Note: SMSParserModule is completely removed as we now use pure JS heuristics.

/** Non-transactional message patterns — skip these entirely */
const nonTransactionalPatterns = [
  /\botp\b/i,
  /bank\s*alert/i,
  /one.?time.?pass/i,
  /\b(?:recharge|top-up)s?\s+(?:your|now|to|on|every)\b/i,
  /\b(?:offer|discount|cashback|vouchers?|plan)s?\s+valid\b/i,
  /\b(?:dial|call)\s+\*[\d#]+/i,
  /\b(?:win|claim|get|save)\s+(?:rewards?|prizes?|vouchers?|more|cashback)\b/i,
  /\bclick\s+(?:here|to|link)\b/i,
  /\b(?:today|tonight|exclusive|limited|family)\s+offer\b/i,
  /\b(?:switch|join|upgrade)\s+now\b/i,
  /\bpay\s+in\s+one\s+go\b/i,
  /\bget\s+family\s+plans?\b/i,
];

// ─── Regex helpers ────────────────────────────────────────────────────────────

const amountPattern = /(?:rs\.?|inr|₹)\s*([0-9,]+(?:\.[0-9]{1,2})?)/i;
const accountPattern = /(?:a\/c|acct|account)\s*[x*]*([0-9]{2,6})/i;
const refPattern = /(?:ref(?:erence)?(?:\s*id)?|utr|txn(?:\s*id)?)\s*[:\-]?\s*([a-z0-9\-]+)/i;

let cachedTransactionRegex: RegExp | null = null;
let lastKeywordsHash: string | null = null;

function getTransactionKeywordRegex() {
  const config = getParserConfig();
  const keywordsHash = config.transactionKeywords.join('|');
  
  if (cachedTransactionRegex && lastKeywordsHash === keywordsHash) {
    return cachedTransactionRegex;
  }
  
  cachedTransactionRegex = new RegExp(`\\b(${keywordsHash})\\b`, 'i');
  lastKeywordsHash = keywordsHash;
  return cachedTransactionRegex;
}

function getBillDueDatePatterns() {
  const config = getParserConfig();
  const dateStrPattern = /\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}[-/]\d{1,2}[-/]\d{2,4}|\d{1,2}[-\s]+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*[-\s]+\d{2,4}/i;
  return [
    new RegExp(`(?:due|by|on|since)\\s*[:\\s]*(${dateStrPattern.source})`, 'i'),
    new RegExp(`(${dateStrPattern.source})`, 'i'),
  ];
}

function normalizeAmount(raw: string): number {
  return Number(raw.replace(/,/g, ''));
}

// ─── Heuristic Helpers ────────────────────────────────────────────────────────

/**
 * Checks the text preceding the matched amount location.
 * Returns true if the amount is likely a limit or available balance instead of the transaction amount.
 */
function isBalanceOrLimitAmount(body: string, start: number): boolean {
  const prefix = body.substring(0, start).toLowerCase();
  const balanceKeywords = /\b(?:bal(?:ance)?|avl|available|updated\s+bal|new\s+bal|limit|outstanding|due|overdue|total\s+due|statement|limit\s+of|max\s+limit)\b/i;
  const lastPart = prefix.slice(-30);
  return balanceKeywords.test(lastPart);
}

/**
 * Iterates through all amount patterns in the text.
 * Finds the first amount that does not match available balance or limit context.
 * Falls back to the first amount found if none pass.
 */
export function extractTransactionAmount(body: string): number | null {
  const globalPattern = new RegExp(amountPattern.source, 'gi');
  let match;
  let firstMatchVal: number | null = null;
  
  while ((match = globalPattern.exec(body)) !== null) {
    const val = normalizeAmount(match[1]);
    if (val > 0) {
      if (firstMatchVal === null) firstMatchVal = val;
      const matchStart = match.index;
      if (!isBalanceOrLimitAmount(body, matchStart)) {
        return val;
      }
    }
  }
  return firstMatchVal;
}

// ─── Date Parsers ─────────────────────────────────────────────────────────────

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
 * Robustly parses DD/MM/YY(YY), YYYY-MM-DD, and DD-MMM-YY(YY) formats.
 * Bypasses engine-level native Date parsing bugs on platforms like Hermes.
 */
export function parseDateString(dateStr: string): Date | null {
  if (!dateStr) return null;
  const cleaned = dateStr.trim();

  // 1. Handle YYYY-MM-DD or YYYY/MM/DD
  const yyyyMmDd = cleaned.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (yyyyMmDd) {
    const [, yrStr, monthStr, dayStr] = yyyyMmDd;
    const day = parseInt(dayStr, 10);
    const month = parseInt(monthStr, 10) - 1;
    const year = parseInt(yrStr, 10);
    if (month >= 0 && month <= 11 && day >= 1 && day <= 31) {
      const d = new Date(year, month, day);
      if (!isNaN(d.getTime())) return d;
    }
  }

  // 2. Handle DD-MM-YY or DD/MM/YY (length 2 year)
  const ddMmYy = cleaned.match(/^(\d{1,2})[-/\s](\d{1,2})[-/\s](\d{2})$/);
  if (ddMmYy) {
    const [, dayStr, monthStr, yrStr] = ddMmYy;
    const day = parseInt(dayStr, 10);
    const month = parseInt(monthStr, 10) - 1;
    const year = 2000 + parseInt(yrStr, 10);
    if (month >= 0 && month <= 11 && day >= 1 && day <= 31) {
      const d = new Date(year, month, day);
      if (!isNaN(d.getTime())) return d;
    }
  }

  // 3. Handle DD-MM-YYYY or DD/MM/YYYY (length 4 year)
  const ddMmYyyy = cleaned.match(/^(\d{1,2})[-/\s](\d{1,2})[-/\s](\d{4})$/);
  if (ddMmYyyy) {
    const [, dayStr, monthStr, yrStr] = ddMmYyyy;
    const day = parseInt(dayStr, 10);
    const month = parseInt(monthStr, 10) - 1;
    const year = parseInt(yrStr, 10);
    if (month >= 0 && month <= 11 && day >= 1 && day <= 31) {
      const d = new Date(year, month, day);
      if (!isNaN(d.getTime())) return d;
    }
  }

  // 4. Handle DD-MMM-YY(YY) e.g. "30-APR-26", "30-Apr-2026", "30 APR 2026"
  const ddMmmYy = cleaned.match(/^(\d{1,2})[-\/\s]+([A-Za-z]{3,9})[-\/\s]+(\d{2,4})$/);
  if (ddMmmYy) {
    const [, day, mon, yr] = ddMmmYy;
    const monthIdx = MONTH_INDEX[mon.toLowerCase()];
    if (monthIdx !== undefined) {
      const year = yr.length <= 2 ? 2000 + parseInt(yr, 10) : parseInt(yr, 10);
      const d = new Date(year, monthIdx, parseInt(day, 10));
      if (!isNaN(d.getTime())) return d;
    }
  }

  // Fallback to native parsing
  const d = new Date(cleaned);
  if (!isNaN(d.getTime())) {
    if (d.getFullYear() < 100) d.setFullYear(2000 + d.getFullYear());
    return d;
  }

  return null;
}

/**
 * Searches the SMS body for date strings.
 * Prioritizes dates preceded by contextual words like 'on', 'date', 'at'.
 * Falls back to the message receipt date if no date is matched.
 */
export function extractTransactionDate(body: string, messageTimestamp: number): string {
  const dateStrPattern = /\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}[-/]\d{1,2}[-/]\d{2,4}|\d{1,2}[-\s]+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*[-\s]+\d{2,4}/i;
  
  // 1. Try prefixed date (e.g. "on 24-05-26")
  const prefixedPattern = new RegExp(`(?:on|date|dt|at)\\s*[:\\s]*(${dateStrPattern.source})`, 'i');
  const prefixedMatch = body.match(prefixedPattern);
  if (prefixedMatch?.[1]) {
    const parsed = parseDateString(prefixedMatch[1]);
    if (parsed) return parsed.toISOString();
  }
  
  // 2. Try any matching date string in the body
  const generalMatch = body.match(dateStrPattern);
  if (generalMatch?.[0]) {
    const parsed = parseDateString(generalMatch[0]);
    if (parsed) return parsed.toISOString();
  }
  
  // 3. Fallback to message timestamp
  return new Date(messageTimestamp).toISOString();
}

function detectType(body: string): ParsedTransactionType | null {
  const lower = body.toLowerCase();
  const config = getParserConfig();
  if (config.excludeKeywords.some(kw => lower.includes(kw))) return null;
  if (/\b(debited|spent|paid|purchase|withdrawn|withdrawal|minus|taken out|sent)\b/.test(lower)) return 'expense';
  if (/\b(credited|received|deposited|refund|plus|added to)\b/.test(lower)) return 'income';
  if (/\b(transfer|neft|imps|rtgs)\b/.test(lower)) return 'expense';
  return null;
}

function detectKind(body: string): TransactionKind {
  const lower = body.toLowerCase();
  if (/\b(refund|reversed|chargeback)\b/.test(lower)) return 'refund';
  if (/\b(transfer|self transfer|neft|imps|rtgs)\b/.test(lower)) return 'transfer';
  if (/\b(credited|received|deposited)\b/.test(lower)) return 'income';
  return 'expense';
}

function cleanMerchant(name: string): string {
  if (!name) return '';
  let cleaned = name
    .replace(/^(?:dear\s+customer|dear\s+user|hi|hello|greetings)\b/i, '')
    .replace(/\b(?:vpa|upi|info|id|ref|txn|a\/c|acct|acc|date)\b.*$/i, '')
    .replace(/[*\-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Strip trailing .Avl or Avl or Cheque
  cleaned = cleaned.replace(/(?:\.Avl|\bAvl\b|\bCheque\b).*$/i, '').trim();

  const words = cleaned.split(' ');
  const config = getParserConfig();
  
  // Remove leading noise words
  while (words.length > 1 && config.merchantNoiseWords.includes(words[0].toLowerCase())) {
    words.shift();
  }
  
  // Remove trailing noise words
  while (words.length > 1 && config.merchantNoiseWords.includes(words[words.length - 1].toLowerCase())) {
    words.pop();
  }
  
  cleaned = words.join(' ');
  if (/^[0-9 ]+$/.test(cleaned) && cleaned.length < 4) return '';
  if (/^rs\.?\s*[0-9]/i.test(cleaned)) return ''; // Reject if it starts with Rs
  return cleaned ? cleaned.charAt(0).toUpperCase() + cleaned.slice(1) : '';
}

function extractMerchantViaRegex(body: string): string | undefined {
  const lower = body.toLowerCase();
  const config = getParserConfig();

  for (const merchant of config.directMerchants) {
    const pattern = new RegExp(`\\b${merchant.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    if (pattern.test(lower)) {
      return merchant.charAt(0).toUpperCase() + merchant.slice(1).toLowerCase();
    }
  }

  // Pattern 1: to/at/from/towards/for/by <Merchant> (on|for|using|…)
  const toAtMatch = body.match(
    /(?:to|at|from|towards|for|by)\s+([A-Za-z0-9 .&'-]{2,70}?)[\s\.]*(?:on|for|using|via|ref|id|balance|bal|date|is|at|towards|\.Avl|\. Avl|Avl\b|Cheque|\n|$)/i
  );

  // Pattern 2: info/memo/vpa field
  const infoMatch = body.match(/(?:info|memo|vpa|upi)[:*]?\s*([A-Za-z0-9 .&'-]{2,50})/i);

  // Pattern 3: all-caps word cluster (common in bank SMSes) - but filter out common noise
  const capsMatch = body.match(/([A-Z][A-Za-z0-9]*(?:\s+[A-Z][A-Za-z0-9]*){0,2})/g);
  let bestCapsMatch: string | undefined;
  if (capsMatch) {
    for (const match of capsMatch) {
      if (match.length >= 3 && !config.allCapsNoiseWords.some(w => match.toUpperCase().includes(w))) {
        bestCapsMatch = match;
        break;
      }
    }
  }

  let merchant = toAtMatch?.[1] || infoMatch?.[1];
  if (!merchant || merchant.length < 3 || /^rs\.?\s*[0-9]/i.test(merchant)) {
    merchant = bestCapsMatch;
  }

  return merchant ? cleanMerchant(merchant) || undefined : undefined;
}

export function buildHash(sender: string, body: string, date: number): string {
  // Normalize sender (remove non-alphanumeric like +) and body (trim)
  const cleanSender = (sender || "").replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
  const cleanBody = (body || "").trim();
  // Use seconds instead of ms to avoid small drift between intent and inbox
  const cleanDate = Math.floor(date / 1000);
  const key = `${cleanSender}|${cleanBody}|${cleanDate}`;
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) {
    hash = (hash << 5) - hash + key.charCodeAt(i);
    hash |= 0;
  }
  return `msg_${Math.abs(hash)}`;
}

// ─── Main transaction parsers ───────────────────────────────────────────

/**
 * Async version of transaction parser. Calls the synchronous context-aware parser.
 */
export async function parseSmsForTransaction(
  message: SmsMessage
): Promise<ParsedSmsTransaction | null> {
  return parseSmsForTransactionSync(message);
}

/**
 * Synchronous context-aware transaction parser.
 * Pure TypeScript, platform-agnostic, running identically on iOS & Android.
 */
export function parseSmsForTransactionSync(message: SmsMessage): ParsedSmsTransaction | null {
  const sender = message.address?.trim();
  const body = message.body?.trim();
  if (!sender || !body) return null;

  // Skip OTP / bank-alert / non-transactional messages early
  if (nonTransactionalPatterns.some(p => p.test(body))) return null;
  const lower = body.toLowerCase();
  if (!getTransactionKeywordRegex().test(lower)) return null;

  const type = detectType(body);
  if (!type) return null;

  // Parse amount using context-aware heuristics
  const amount = extractTransactionAmount(body);
  if (amount === null || !Number.isFinite(amount) || amount <= 0) return null;

  // Parse transaction date from text, falling back to message timestamp
  const transactionDate = extractTransactionDate(body, message.date);

  // Extract merchant & metadata
  const merchant = extractMerchantViaRegex(body);
  const accountMatch = body.match(accountPattern);
  const refMatch = body.match(refPattern);

  return {
    sender,
    body,
    receivedAt: transactionDate,
    hash: buildHash(sender, body, message.date),
    amount,
    type,
    kind: detectKind(body),
    merchant: (merchant && merchant.length > 2) ? merchant : undefined,
    referenceId: refMatch?.[1]?.trim(),
    accountRef: accountMatch?.[1]?.trim(),
    confidence: merchant ? 0.95 : 0.75,
  };
}

/**
 * Async version of bill parser. Calls the synchronous version.
 */
export async function parseSmsForBill(sms: SmsMessage): Promise<ParsedSmsBill | null> {
  return parseSmsForBillSync(sms);
}

/**
 * Synchronous version of bill parser.
 */
export function parseSmsForBillSync(sms: SmsMessage): ParsedSmsBill | null {
  const body = sms.body.toLowerCase();
  const config = getParserConfig();
  if (!config.billKeywords.some(kw => body.includes(kw))) return null;

  const amountMatch = sms.body.match(amountPattern);
  if (!amountMatch) return null;
  const amount = normalizeAmount(amountMatch[1]);
  if (amount <= 0) return null;

  let dueDate = new Date(sms.date).toISOString();
  for (const pattern of getBillDueDatePatterns()) {
    const match = sms.body.match(pattern);
    if (match?.[1]) {
      const parsed = parseDateString(match[1].trim());
      if (parsed) {
        dueDate = parsed.toISOString();
        break;
      }
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

/**
 * Triggers a native local notification for a parsed transaction.
 */
export function showTransactionNotification(tx: ParsedSmsTransaction): void {
  if (Platform.OS !== 'android' || !SmsEventModule) return;

  SmsEventModule.postNotification(
    tx.amount,
    tx.type,
    tx.merchant || null,
    tx.sender
  );
}

export function showBillNotification(bill: ParsedSmsBill): void {
  if (Platform.OS !== 'android' || !SmsEventModule) return;

  SmsEventModule.postBillNotification(
    bill.amount,
    bill.dueDate || null,
    bill.sender
  );
}
