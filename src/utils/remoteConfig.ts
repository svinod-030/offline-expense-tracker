import AsyncStorage from '@react-native-async-storage/async-storage';
import { ParserConfig } from '../types';

const CONFIG_CACHE_KEY = 'parser_remote_config';
const TEMPLATES_CACHE_KEY = 'parser_sms_templates';

const REMOTE_CONFIG_URL = 'https://raw.githubusercontent.com/svinod-030/spendwise/refs/heads/main/release/parser-config.json';
const REMOTE_TEMPLATES_URL = 'https://raw.githubusercontent.com/svinod-030/spendwise/refs/heads/main/release/sms-templates.json';

// ─── Parser keyword/merchant config ──────────────────────────────────────────

export const DEFAULT_PARSER_CONFIG: ParserConfig = {
  transactionKeywords: [
    'debited', 'credited', 'spent', 'received', 'paid', 'payment',
    'txn', 'transaction', 'upi', 'withdrawn', 'withdrew', 'deposited',
    'transfer', 'purchase', 'sent', 'added', 'neft', 'imps', 'rtgs', 'withdrawal',
  ],
  excludeKeywords: [
    'due', 'outstanding', 'reminder', 'generated', 'statement',
    'overdue', 'will be debited', 'payment request', 'requested a payment',
    'recharge your', 'offer valid', 'avail the offer',
  ],
  merchantNoiseWords: [
    'using', 'via', 'on', 'at', 'to', 'from', 'for', 'ref', 'id', 'date',
    'bank', 'ac', 'acct', 'available', 'bal', 'balance', 'txn', 'vpa', 'upi',
    'your', 'the', 'is', 'in', 'towards', 'info', 'dear', 'customer',
    'hi', 'hello', 'mr', 'mrs', 'ms',
  ],
  directMerchants: [
    'blinkit', 'bigbasket', 'zepto', 'swiggy', 'zomato', 'uber', 'ola',
    'amazon', 'flipkart', 'myntra', 'ajio', 'meesho', 'nykaa',
    'netflix', 'prime', 'hotstar', 'spotify', 'youtube',
    'pharmeasy', '1mg', 'apollo', 'uber eats', 'dominos',
    'makemytrip', 'goibibo', 'irctc', 'bookmyshow', 'pvr',
    'airtel', 'jio', 'vi', 'vodafone', 'bsnl',
    'paytm', 'phonepe', 'gpay', 'google pay', 'cred',
    'tata power', 'bescom', 'mseb', 'hpcl', 'bpcl', 'shell',
  ],
  allCapsNoiseWords: [
    'SMS', 'MSG', 'REF', 'ID', 'TXN', 'UPI', 'NEFT', 'IMPS', 'RTGS', 'ATM',
    'POS', 'ECOM', 'A/C', 'ACCT', 'BAL', 'AVAIL', 'INR', 'RS', 'UPDATE',
    'DEAR', 'CUSTOMER',
  ],
  billKeywords: ['due', 'outstanding', 'reminder', 'overdue'],
};

let currentConfig: ParserConfig = DEFAULT_PARSER_CONFIG;

// ─── SMS Template config ──────────────────────────────────────────────────────

/** Shape of a single template entry as stored in JSON */
export interface RemoteTemplateEntry {
  name: string;
  pattern: string;  // regex source string
  flags: string;    // e.g. "i"
  description?: string;
}

let currentTemplates: RemoteTemplateEntry[] | null = null;

// ─── Loaders ──────────────────────────────────────────────────────────────────

/**
 * Loads the keyword/merchant config from cache on startup.
 */
export const loadCachedConfig = async (): Promise<ParserConfig> => {
  try {
    const [cachedConfig, cachedTemplates] = await Promise.all([
      AsyncStorage.getItem(CONFIG_CACHE_KEY),
      AsyncStorage.getItem(TEMPLATES_CACHE_KEY),
    ]);

    if (cachedConfig) {
      currentConfig = { ...DEFAULT_PARSER_CONFIG, ...JSON.parse(cachedConfig) };
    }
    if (cachedTemplates) {
      currentTemplates = JSON.parse(cachedTemplates);
    }
  } catch (error) {
    console.error('Failed to load cached parser config:', error);
  }
  return currentConfig;
};

/**
 * Fetches the latest config AND templates from GitHub in the background.
 */
export const refreshRemoteConfig = async (): Promise<void> => {
  await Promise.all([
    _refreshKeywordConfig(),
    _refreshTemplateConfig(),
  ]);
};

async function _refreshKeywordConfig(): Promise<void> {
  try {
    const response = await fetch(REMOTE_CONFIG_URL, { headers: { 'Cache-Control': 'no-cache' } });
    if (response.ok) {
      const remoteConfig = await response.json();
      currentConfig = { ...DEFAULT_PARSER_CONFIG, ...remoteConfig };
      await AsyncStorage.setItem(CONFIG_CACHE_KEY, JSON.stringify(currentConfig));
      console.log('[RemoteConfig] Parser keyword config refreshed from GitHub');
    }
  } catch (error) {
    console.log('[RemoteConfig] Failed to refresh keyword config (offline or invalid URL):', error);
  }
}

async function _refreshTemplateConfig(): Promise<void> {
  try {
    const response = await fetch(REMOTE_TEMPLATES_URL, { headers: { 'Cache-Control': 'no-cache' } });
    if (response.ok) {
      const remoteTemplates: RemoteTemplateEntry[] = await response.json();
      if (Array.isArray(remoteTemplates) && remoteTemplates.length > 0) {
        currentTemplates = remoteTemplates;
        await AsyncStorage.setItem(TEMPLATES_CACHE_KEY, JSON.stringify(currentTemplates));
        console.log(`[RemoteConfig] SMS templates refreshed from GitHub (${remoteTemplates.length} templates)`);
      }
    }
  } catch (error) {
    console.log('[RemoteConfig] Failed to refresh SMS templates (offline or invalid URL):', error);
  }
}

// ─── Accessors ────────────────────────────────────────────────────────────────

export const getParserConfig = (): ParserConfig => currentConfig;

/**
 * Returns the currently-loaded remote templates, or null if not yet fetched.
 * smsTemplates.ts will fall back to its hardcoded defaults when this is null.
 */
export const getRemoteTemplates = (): RemoteTemplateEntry[] | null => currentTemplates;
