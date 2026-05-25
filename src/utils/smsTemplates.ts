/**
 * SMS Structural Template Library
 *
 * Each template is a named-capture-group regex that matches the full structure
 * of a specific family of bank/UPI SMS messages. A successful match simultaneously
 * identifies the transaction type AND extracts amount, merchant, date, account,
 * and reference ID — all in one pass, with zero keyword guessing.
 *
 * Named capture groups:
 *   amount   — numeric string, may contain commas (e.g. "1,234.56")
 *   type     — literal "debited" | "credited" | "sent" | "received" | "paid" | "spent" | "refund" etc.
 *   merchant — raw merchant/payee/payer string (will be cleaned downstream)
 *   date     — raw date string (will be parsed downstream)
 *   account  — last N digits of account/card
 *   ref      — UTR / TXN / reference ID
 *
 * Templates are dynamically loaded from GitHub via remoteConfig when available.
 * The hardcoded SMS_TEMPLATES below serve as the offline fallback.
 */

import { getRemoteTemplates } from './remoteConfig';

export interface TemplateMatch {
  amount: string;
  type: string;      // raw matched word, e.g. "debited", "credited"
  merchant?: string;
  date?: string;
  account?: string;
  ref?: string;
}

interface SmsTemplate {
  /** Human-readable name for debugging */
  name: string;
  pattern: RegExp;
}

// ─── Amount fragment ──────────────────────────────────────────────────────────
// Matches: Rs. 1,234.56 / INR 500 / ₹200.00
const AMT = `(?:(?:rs\\.?|inr|₹)\\s*)(?<amount>[0-9,]+(?:\\.[0-9]{1,2})?)`;

// ─── Date fragment ────────────────────────────────────────────────────────────
// Matches: 24-05-26 / 24/05/2026 / 24 May 2026 / 2026-05-24
const DATE = `(?<date>\\d{4}[-/]\\d{1,2}[-/]\\d{1,2}|\\d{1,2}[-/]\\d{1,2}[-/]\\d{2,4}|\\d{1,2}[\\s\\-]+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*[\\s\\-]+\\d{2,4})`;

// ─── Optional Date fragment ───────────────────────────────────────────────────
const OPT_DATE = `(?:(?:on|date|dt)[:\\s]+${DATE})?`;

// ─── Account fragment ─────────────────────────────────────────────────────────
// Matches: A/c xx1234 / acct *9876 / card ending 4321
const ACCT = `(?:(?:a\\/c|acct|account|card(?:\\s+ending)?|a\\/c\\s+no\\.?)\\s*[x*]*(?<account>\\d{2,6}))`;
const OPT_ACCT = `(?:${ACCT}\\s*)?`;

// ─── Ref fragment ─────────────────────────────────────────────────────────────
const REF = `(?:(?:ref(?:erence)?(?:\\s*(?:no\\.?|id))?|utr(?:\\s*no\\.?)?|txn(?:\\s*id)?|tran(?:\\s*id)?)\\s*[:\\-]?\\s*(?<ref>[A-Za-z0-9]{6,30}))`;
const OPT_REF = `(?:[,\\s]*${REF})?`;

// ─── Merchant fragment ────────────────────────────────────────────────────────
// Up to 60 chars, stopping at common delimiters
const MERCH = `(?<merchant>[^.\\n]{2,60}?)`;
const MERCH_STOP = `(?=\\.|on\\s|for\\s|\\bbal\\b|\\bavl\\b|\\bref\\b|\\butr\\b|\\btxn\\b|\\busing\\b|\\bvia\\b|\\brs\\.?\\s*\\d|\\binr\\b|₹|$)`;

// ─── Template definitions ─────────────────────────────────────────────────────

export const SMS_TEMPLATES: SmsTemplate[] = [

  // ── Credit (Date before Merchant): "Your A/c x1234 has been credited with Rs. 50000 on 2026-05-04 from HDFC"
  {
    name: 'credited-on-from',
    pattern: new RegExp(
      `(?:dear\\s+customer,\\s+)?(?:your\\s+)?${OPT_ACCT}\\s*has\\s+been\\s+(?<type>credited)\\s+(?:with|by|for)?\\s*${AMT}` +
      `\\s+on\\s+${DATE}` +
      `\\s+(?:from|by)\\s+${MERCH}${MERCH_STOP}` +
      `\\s*${OPT_REF}`,
      'i'
    ),
  },

  // ── HDFC-style: "A/c x1234 debited for Rs.500 at ZOMATO on 24-05-26"
  {
    name: 'hdfc-debit-at',
    pattern: new RegExp(
      `${OPT_ACCT}\\s*(?<type>debited|withdrawn)\\s+(?:for|of|with)?\\s*${AMT}` +
      `\\s+(?:at|to)\\s+${MERCH}${MERCH_STOP}` +
      `\\s*${OPT_DATE}${OPT_REF}`,
      'i'
    ),
  },

  // ── HDFC-style credit: "A/c x1234 credited with Rs.2000 from SALARY on 24-05-26"
  {
    name: 'hdfc-credit',
    pattern: new RegExp(
      `${OPT_ACCT}\\s*(?<type>credited)\\s+(?:with|by|for)?\\s*${AMT}` +
      `\\s+(?:from|by)?\\s*${MERCH}${MERCH_STOP}` +
      `\\s*${OPT_DATE}${OPT_REF}`,
      'i'
    ),
  },

  // ── ICICI / Axis: "Rs.500 debited from A/c **1234 at MERCHANT on 24-05-26"
  {
    name: 'icici-debit',
    pattern: new RegExp(
      `${AMT}\\s+(?<type>debited|withdrawn)\\s+from\\s+${OPT_ACCT}` +
      `\\s*(?:at|to)?\\s*${MERCH}${MERCH_STOP}` +
      `\\s*${OPT_DATE}${OPT_REF}`,
      'i'
    ),
  },

  // ── ICICI credit: "Rs.2000 credited to A/c **1234 from MERCHANT on 24-05-26"
  {
    name: 'icici-credit',
    pattern: new RegExp(
      `${AMT}\\s+(?<type>credited)\\s+to\\s+${OPT_ACCT}` +
      `\\s*(?:from|by)?\\s*${MERCH}${MERCH_STOP}` +
      `\\s*${OPT_DATE}${OPT_REF}`,
      'i'
    ),
  },

  // ── SBI: "Your A/c x1234 has been debited with Rs.500 on 24-05-26"
  {
    name: 'sbi-debit',
    pattern: new RegExp(
      `(?:your\\s+)?${OPT_ACCT}\\s*has\\s+been\\s+(?<type>debited|withdrawn)\\s+(?:with|for|by|of)?\\s*${AMT}` +
      `(?:\\s+(?:at|to)\\s+${MERCH}${MERCH_STOP})?` +
      `\\s*${OPT_DATE}${OPT_REF}`,
      'i'
    ),
  },

  // ── SBI credit: "Your A/c x1234 has been credited with Rs.2000 from MERCHANT"
  {
    name: 'sbi-credit',
    pattern: new RegExp(
      `(?:your\\s+)?${OPT_ACCT}\\s*has\\s+been\\s+(?<type>credited)\\s+(?:with|by|for)?\\s*${AMT}` +
      `(?:\\s+(?:from|by)\\s+${MERCH}${MERCH_STOP})?` +
      `\\s*${OPT_DATE}${OPT_REF}`,
      'i'
    ),
  },

  // ── UPI Debit: "Paid Rs.500 to ZOMATO via UPI on 24-05-26. Ref 123456"
  {
    name: 'upi-paid-to',
    pattern: new RegExp(
      `(?<type>paid|sent)\\s+${AMT}\\s+to\\s+${MERCH}${MERCH_STOP}` +
      `(?:\\s+via\\s+\\S+)?\\s*${OPT_DATE}${OPT_REF}`,
      'i'
    ),
  },

  // ── UPI Credit: "Received Rs.500 from MERCHANT via UPI on 24-05-26"
  {
    name: 'upi-received-from',
    pattern: new RegExp(
      `(?<type>received)\\s+${AMT}\\s+from\\s+${MERCH}${MERCH_STOP}` +
      `(?:\\s+via\\s+\\S+)?\\s*${OPT_DATE}${OPT_REF}`,
      'i'
    ),
  },

  // ── Spent: "You've spent Rs.200 at SWIGGY on 24-05-26"
  {
    name: 'card-spent-at',
    pattern: new RegExp(
      `(?:you(?:'ve)?\\s+)?(?<type>spent|used)\\s+${AMT}\\s+(?:at|on|to)\\s+${MERCH}${MERCH_STOP}` +
      `\\s*${OPT_DATE}${OPT_REF}`,
      'i'
    ),
  },

  // ── Purchase: "Purchase of Rs.1200 at AMAZON on 24-05-26 on card **1234"
  {
    name: 'card-purchase',
    pattern: new RegExp(
      `(?<type>purchase)\\s+of\\s+${AMT}\\s+(?:at|on)\\s+${MERCH}${MERCH_STOP}` +
      `\\s*${OPT_DATE}(?:[\\s,]*${OPT_ACCT})?${OPT_REF}`,
      'i'
    ),
  },

  // ── ATM Withdrawal: "ATM withdrawal of Rs.2000 from A/c x1234 on 24-05-26"
  {
    name: 'atm-withdrawal',
    pattern: new RegExp(
      `(?:atm\\s+)?(?<type>withdrawal|withdrawn)\\s+(?:of|for)?\\s+${AMT}` +
      `\\s*(?:from\\s+${OPT_ACCT})?\\s*${OPT_DATE}${OPT_REF}`,
      'i'
    ),
  },

  // ── NEFT/IMPS/RTGS Debit: "NEFT/IMPS transfer of Rs.5000 to MERCHANT on 24-05-26"
  {
    name: 'neft-imps-debit',
    pattern: new RegExp(
      `(?<type>neft|imps|rtgs)\\s+(?:transfer|txn)?\\s*(?:of\\s+)?${AMT}` +
      `\\s+(?:to|from)\\s+${MERCH}${MERCH_STOP}` +
      `\\s*${OPT_DATE}${OPT_REF}`,
      'i'
    ),
  },

  // ── Refund: "Refund of Rs.299 received from MERCHANT"
  {
    name: 'refund',
    pattern: new RegExp(
      `(?<type>refund)\\s+(?:of\\s+)?${AMT}\\s+(?:(?:received|processed|credited)\\s+)?(?:from|by)?\\s*${MERCH}${MERCH_STOP}` +
      `\\s*${OPT_DATE}${OPT_REF}`,
      'i'
    ),
  },

  // ── Deposited: "Rs.5000 deposited to A/c x1234 on 24-05-26"
  {
    name: 'deposited',
    pattern: new RegExp(
      `${AMT}\\s+(?<type>deposited|added)\\s+(?:to|in)?\\s*${OPT_ACCT}` +
      `\\s*${OPT_DATE}${OPT_REF}`,
      'i'
    ),
  },

  // ── Generic debit fallback: "<anything> debited <amount>"
  {
    name: 'generic-debit',
    pattern: new RegExp(
      `(?<type>debited|withdrawn|deducted)(?:[^₹Rs.]*)${AMT}` +
      `(?:\\s+(?:at|to)\\s+${MERCH}${MERCH_STOP})?` +
      `\\s*${OPT_DATE}${OPT_REF}`,
      'i'
    ),
  },

  // ── Generic credit fallback: "<anything> credited <amount>"
  {
    name: 'generic-credit',
    pattern: new RegExp(
      `(?<type>credited|received|deposited)(?:[^₹Rs.]*)${AMT}` +
      `(?:\\s+(?:from|by)\\s+${MERCH}${MERCH_STOP})?` +
      `\\s*${OPT_DATE}${OPT_REF}`,
      'i'
    ),
  },
];

// ─── Debit-type words ────────────────────────────────────────────────────────
const DEBIT_WORDS = new Set([
  'debited', 'withdrawn', 'withdrawal', 'deducted',
  'paid', 'sent', 'spent', 'used', 'purchase', 'neft', 'imps', 'rtgs',
]);

const CREDIT_WORDS = new Set([
  'credited', 'received', 'deposited', 'added',
]);

/**
 * Builds the active template list.
 * Uses remote templates from GitHub if loaded; falls back to hardcoded SMS_TEMPLATES.
 * Remote templates are stored as { name, pattern, flags } JSON and compiled to RegExp here.
 */
function getActiveTemplates(): SmsTemplate[] {
  const remote = getRemoteTemplates();
  if (!remote || remote.length === 0) return SMS_TEMPLATES;

  const compiled: SmsTemplate[] = [];
  for (const entry of remote) {
    try {
      compiled.push({ name: entry.name, pattern: new RegExp(entry.pattern, entry.flags) });
    } catch (e) {
      console.warn(`[smsTemplates] Failed to compile remote template '${entry.name}':`, e);
    }
  }
  return compiled.length > 0 ? compiled : SMS_TEMPLATES;
}

/**
 * Attempts to match one of the structural templates against the SMS body.
 * Prefers remotely-fetched templates; falls back to hardcoded defaults.
 * Returns null if no template matches.
 * Returns a TemplateMatch with raw (un-cleaned) field strings on success.
 */
export function matchSmsTemplate(body: string): TemplateMatch | null {
  for (const template of getActiveTemplates()) {
    const m = template.pattern.exec(body);
    if (m?.groups) {
      const g = m.groups;
      if (!g.amount || !g.type) continue;

      const rawType = g.type.toLowerCase().trim();
      if (!rawType) continue;

      return {
        amount: g.amount,
        type: rawType,
        merchant: g.merchant?.trim() || undefined,
        date: g.date?.trim() || undefined,
        account: g.account?.trim() || undefined,
        ref: g.ref?.trim() || undefined,
      };
    }
  }
  return null;
}

/**
 * Maps the raw 'type' word captured from the template to a standard ParsedTransactionType.
 */
export function resolveTransactionType(rawType: string): 'expense' | 'income' {
  const lower = rawType.toLowerCase();
  if (CREDIT_WORDS.has(lower)) return 'income';
  return 'expense'; // default for all debit words
}

/**
 * Maps the raw 'type' word to a TransactionKind.
 */
export function resolveTransactionKind(rawType: string, body: string): 'expense' | 'income' | 'refund' | 'transfer' {
  const lower = rawType.toLowerCase();
  if (lower === 'refund') return 'refund';
  if (CREDIT_WORDS.has(lower)) return 'income';
  if (lower === 'neft' || lower === 'imps' || lower === 'rtgs') return 'transfer';
  if (/\b(neft|imps|rtgs|transfer)\b/i.test(body)) return 'transfer';
  return 'expense';
}
