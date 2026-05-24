import { create } from "zustand";
import { getDb } from "../db/database";
import * as FileSystem from "expo-file-system";
import * as Sharing from "expo-sharing";
import { parseSmsForTransaction, parseSmsForBill, buildHash, parseSmsForTransactionSync, parseSmsForBillSync, showTransactionNotification, showBillNotification } from "../utils/smsParser";
import { checkSmsPermission, readInboxMessages, requestSmsPermission } from "../utils/smsReader";
import { SmsMessage } from "../types";
import { CURRENCY_SYMBOLS } from "../constants/currencies";
import { Alert } from "react-native";
import { SQLiteDatabase } from "expo-sqlite";
import { ExpenseState, Category, Transaction, Bill, Budget, CategorySpending, Goal, MerchantSpending, MonthlyTrend } from "../types/expense-store";

export const useExpenseStore = create<ExpenseState>((set, get) => ({
  transactions: [],
  categories: [],
  budgets: [],
  bills: [],
  currency: "INR",
  isLoading: 0,
  isSyncing: false,
  syncProgress: null,
  goals: [],
  monthlyExpense: 0,
  monthlyIncome: 0,
  autoTransferThreshold: 10000,

  getCurrencySymbol: (code?: string) => {
    const target = code || get().currency;

    if (CURRENCY_SYMBOLS[target]) return CURRENCY_SYMBOLS[target];

    try {
      const symbol = (0).toLocaleString("en-US", {
        style: 'currency',
        currency: target,
        minimumFractionDigits: 0,
        maximumFractionDigits: 0,
      }).replace(/\d/g, '').replace(/[.,]/g, '').trim();
      return symbol || target;
    } catch {
      return target;
    }
  },

  fetchCategories: async () => {
    set((state) => ({ isLoading: state.isLoading + 1 }));
    try {
      const db = await getDb();
      const categories = await db.getAllAsync<Category>("SELECT * FROM categories");
      set({ categories });
    } finally {
      set((state) => ({ isLoading: Math.max(0, state.isLoading - 1) }));
    }
  },

  fetchTransactions: async (limit?: number, month?: string) => {
    set((state) => ({ isLoading: state.isLoading + 1 }));
    try {
      const db = await getDb();
      let query = `
        SELECT t.*, c.name as category_name, c.color as category_color, c.icon as category_icon 
        FROM transactions t 
        LEFT JOIN categories c ON t.category_id = c.id
      `;
      const params: any[] = [];
      if (month) {
        query += " WHERE t.date LIKE ? ";
        params.push(`${month}%`);
      }
      query += " ORDER BY t.date DESC ";
      if (limit) {
        query += " LIMIT ? ";
        params.push(limit);
      }
      const transactions = await db.getAllAsync<Transaction>(query, params);
      set({ transactions });
    } finally {
      set((state) => ({ isLoading: Math.max(0, state.isLoading - 1) }));
    }
  },

  addTransaction: async (transaction) => {
    const db = await getDb();
    const kind = transaction.kind ?? (transaction.type === "income" ? "income" : "expense");

    // Duplicate check: same amount within 60 seconds
    const txTimeSec = Math.floor(new Date(transaction.date).getTime() / 1000);
    const existing = await db.getFirstAsync<{ id: number }>(
      `SELECT id FROM transactions WHERE amount = ? AND ABS(strftime('%s', date) - ?) <= 60 LIMIT 1`,
      [transaction.amount, txTimeSec]
    );
    if (existing) {
      console.log('[addTransaction] Duplicate detected (same amount + time), skipping.');
      return;
    }

    await db.runAsync(
      "INSERT INTO transactions (category_id, amount, type, kind, date, note, is_excluded, goal_id, goal_percent) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [transaction.category_id, transaction.amount, transaction.type, kind, transaction.date, transaction.note, transaction.is_excluded || 0, transaction.goal_id || null, transaction.goal_percent ?? 100]
    );

    // Update goal amount if linked (respects goal_percent)
    if (transaction.goal_id) {
      const goal = await db.getFirstAsync<Goal>("SELECT * FROM goals WHERE id = ?", [transaction.goal_id]);
      if (goal) {
        const contribution = transaction.amount * ((transaction.goal_percent ?? 100) / 100);
        const newAmount = goal.current_amount + contribution;
        await db.runAsync("UPDATE goals SET current_amount = ? WHERE id = ?", [newAmount, transaction.goal_id]);
        await get().fetchGoals();
      }
    }

    await get().fetchTransactions();
  },

  updateTransaction: async (id, transaction) => {
    const db = await getDb();

    // Get old state for goal sync
    const oldTx = await db.getFirstAsync<Transaction>("SELECT * FROM transactions WHERE id = ?", [id]);

    const sets: string[] = [];
    const params: any[] = [];

    if (transaction.category_id !== undefined) { sets.push("category_id = ?"); params.push(transaction.category_id); }
    if (transaction.amount !== undefined) { sets.push("amount = ?"); params.push(transaction.amount); }
    if (transaction.type !== undefined) { sets.push("type = ?"); params.push(transaction.type); }
    if (transaction.kind !== undefined) { sets.push("kind = ?"); params.push(transaction.kind); }
    if (transaction.date !== undefined) { sets.push("date = ?"); params.push(transaction.date); }
    if (transaction.note !== undefined) { sets.push("note = ?"); params.push(transaction.note); }
    if (transaction.is_excluded !== undefined) { sets.push("is_excluded = ?"); params.push(transaction.is_excluded); }
    if (transaction.parent_id !== undefined) { sets.push("parent_id = ?"); params.push(transaction.parent_id); }
    if (transaction.goal_id !== undefined) { sets.push("goal_id = ?"); params.push(transaction.goal_id); }
    if (transaction.goal_percent !== undefined) { sets.push("goal_percent = ?"); params.push(transaction.goal_percent); }

    if (sets.length === 0) return;

    params.push(id);
    await db.runAsync(
      `UPDATE transactions SET ${sets.join(", ")} WHERE id = ?`,
      params
    );

    // Sync Goal Amounts
    const newTx = await db.getFirstAsync<Transaction>("SELECT * FROM transactions WHERE id = ?", [id]);
    if (oldTx && newTx && (oldTx.goal_id !== newTx.goal_id || newTx.goal_id || oldTx.goal_percent !== newTx.goal_percent)) {
      // 1. Subtract old contribution from old goal
      if (oldTx.goal_id) {
        const oldGoal = await db.getFirstAsync<Goal>("SELECT * FROM goals WHERE id = ?", [oldTx.goal_id]);
        if (oldGoal) {
          const oldContribution = oldTx.amount * ((oldTx.goal_percent ?? 100) / 100);
          await db.runAsync("UPDATE goals SET current_amount = ? WHERE id = ?", [Math.max(0, oldGoal.current_amount - oldContribution), oldTx.goal_id]);
        }
      }
      // 2. Add new contribution to new goal
      if (newTx.goal_id) {
        const newGoal = await db.getFirstAsync<Goal>("SELECT * FROM goals WHERE id = ?", [newTx.goal_id]);
        if (newGoal) {
          const newContribution = newTx.amount * ((newTx.goal_percent ?? 100) / 100);
          await db.runAsync("UPDATE goals SET current_amount = ? WHERE id = ?", [newGoal.current_amount + newContribution, newTx.goal_id]);
        }
      }
      await get().fetchGoals();
    }

    // Optimistic Update for UI snappiness
    set((state) => ({
      transactions: state.transactions.map((t) => {
        if (t.id === id) {
          const updated = { ...t, ...transaction };

          // If category changed, also update the category-related display fields
          if (transaction.category_id !== undefined) {
            const cat = state.categories.find(c => c.id === transaction.category_id);
            if (cat) {
              updated.category_name = cat.name;
              updated.category_color = cat.color;
              updated.category_icon = cat.icon;
            }
          }
          return updated;
        }
        return t;
      }),
    }));
  },

  deleteTransaction: async (id) => {
    const db = await getDb();

    // Check if linked to goal before deleting
    const transaction = await db.getFirstAsync<Transaction>("SELECT * FROM transactions WHERE id = ?", [id]);
    if (transaction && transaction.goal_id) {
      const goal = await db.getFirstAsync<Goal>("SELECT * FROM goals WHERE id = ?", [transaction.goal_id]);
      if (goal) {
        const contribution = transaction.amount * ((transaction.goal_percent ?? 100) / 100);
        const newAmount = Math.max(0, goal.current_amount - contribution);
        await db.runAsync("UPDATE goals SET current_amount = ? WHERE id = ?", [newAmount, transaction.goal_id]);
        await get().fetchGoals();
      }
    }

    await db.runAsync("DELETE FROM transactions WHERE id = ?", [id]);

    // Optimistic update for UI snappiness
    set((state) => ({
      transactions: state.transactions.filter((t) => t.id !== id),
    }));
  },

  fetchCurrency: async () => {
    set((state) => ({ isLoading: state.isLoading + 1 }));
    try {
      const db = await getDb();
      const row = await db.getFirstAsync<{ value: string }>("SELECT value FROM app_meta WHERE key = 'currency'");
      const currency = row?.value || "INR";
      set({ currency });
      return currency;
    } finally {
      set((state) => ({ isLoading: Math.max(0, state.isLoading - 1) }));
    }
  },

  fetchMessageById: async (id: number) => {
    const db = await getDb();
    const result = await db.getFirstAsync<{ sms_sender: string; sms_body: string; date: string }>(
      "SELECT sms_sender, sms_body, date FROM transactions WHERE id = ?",
      [id]
    );
    if (!result || !result.sms_body) return null;
    return { sender: result.sms_sender, body: result.sms_body, date: result.date };
  },

  updateCurrency: async (currency: string) => {
    set((state) => ({ isLoading: state.isLoading + 1 }));
    try {
      const db = await getDb();
      await db.runAsync("INSERT OR REPLACE INTO app_meta (key, value) VALUES ('currency', ?)", [currency]);
      set({ currency });
    } finally {
      set((state) => ({ isLoading: Math.max(0, state.isLoading - 1) }));
    }
  },

  isSetupDone: async () => {
    set((state) => ({ isLoading: state.isLoading + 1 }));
    try {
      const db = await getDb();
      const row = await db.getFirstAsync<{ value: string }>("SELECT value FROM app_meta WHERE key = 'setup_done'");
      return row?.value === "true";
    } finally {
      set((state) => ({ isLoading: Math.max(0, state.isLoading - 1) }));
    }
  },

  setSetupDone: async () => {
    const db = await getDb();
    await db.runAsync("INSERT OR REPLACE INTO app_meta (key, value) VALUES ('setup_done', 'true')");
  },

  addCategory: async (category) => {
    const db = await getDb();
    await db.runAsync("INSERT INTO categories (name, icon, color) VALUES (?, ?, ?)", [
      category.name,
      category.icon,
      category.color,
    ]);
    await get().fetchCategories();
  },

  fetchBudgets: async () => {
    set((state) => ({ isLoading: state.isLoading + 1 }));
    try {
      const db = await getDb();
      const budgets = await db.getAllAsync<Budget>(
        "SELECT * FROM budgets ORDER BY category_id ASC, id ASC"
      );
      set({ budgets });
    } finally {
      set((state) => ({ isLoading: Math.max(0, state.isLoading - 1) }));
    }
  },

  upsertMonthlyBudget: async (limitAmount) => {
    const db = await getDb();
    // Manual UPSERT because SQLite UNIQUE(category_id) where category_id IS NULL 
    // does NOT trigger a conflict on multiple NULLs.
    const existing = await db.getFirstAsync<{ id: number }>(
      "SELECT id FROM budgets WHERE category_id IS NULL AND period_type = 'monthly'"
    );

    if (existing) {
      await db.runAsync(
        "UPDATE budgets SET limit_amount = ?, start_date = ? WHERE id = ?",
        [limitAmount, new Date().toISOString(), existing.id]
      );
    } else {
      await db.runAsync(
        "INSERT INTO budgets (category_id, period_type, limit_amount, start_date) VALUES (NULL, 'monthly', ?, ?)",
        [limitAmount, new Date().toISOString()]
      );
    }
    await get().fetchBudgets();
  },

  fetchMonthlyStats: async (month?: string) => {
    set((state) => ({ isLoading: state.isLoading + 1 }));
    try {
      const db = await getDb();
      const targetMonth = month || new Date().toISOString().substring(0, 7);
      const dateQuery = `'${targetMonth}-01'`;
      const nextMonth = `date(${dateQuery}, '+1 month')`;

      // Optimized combined fetching
      const [expenseResult, incomeResult] = await Promise.all([
        db.getFirstAsync<{ total: number }>(
          `SELECT (
            (SELECT COALESCE(SUM(amount), 0) FROM transactions 
             WHERE kind = 'expense' AND is_excluded = 0 
             AND date >= ${dateQuery} AND date < ${nextMonth})
            -
            (SELECT COALESCE(SUM(r.amount), 0) 
             FROM transactions r
             JOIN transactions p ON r.parent_id = p.id
             WHERE p.kind = 'expense' AND p.is_excluded = 0 
             AND p.date >= ${dateQuery} AND p.date < ${nextMonth}
             AND r.is_excluded = 0)
          ) as total`
        ),
        db.getFirstAsync<{ total: number }>(
          `SELECT COALESCE(SUM(amount), 0) as total
           FROM transactions
           WHERE type = 'income'
           AND parent_id IS NULL
           AND is_excluded = 0
           AND date >= ${dateQuery}
           AND date < ${nextMonth}`
        )
      ]);

      set({
        monthlyExpense: expenseResult?.total ?? 0,
        monthlyIncome: incomeResult?.total ?? 0
      });
    } finally {
      set((state) => ({ isLoading: Math.max(0, state.isLoading - 1) }));
    }
  },

  getCurrentMonthExpenseTotal: async (month?: string) => {
    // Legacy support or direct usage
    const targetMonth = month || new Date().toISOString().substring(0, 7);
    const db = await getDb();
    const dateQuery = `'${targetMonth}-01'`;
    const nextMonth = `date(${dateQuery}, '+1 month')`;

    const row = await db.getFirstAsync<{ total: number }>(
      `SELECT (
        (SELECT COALESCE(SUM(amount), 0) FROM transactions 
         WHERE kind = 'expense' AND is_excluded = 0 
         AND date >= ${dateQuery} AND date < ${nextMonth})
        -
        (SELECT COALESCE(SUM(r.amount), 0) 
         FROM transactions r
         JOIN transactions p ON r.parent_id = p.id
         WHERE p.kind = 'expense' AND p.is_excluded = 0 
         AND p.date >= ${dateQuery} AND p.date < ${nextMonth}
         AND r.is_excluded = 0)
      ) as total`
    );
    return row?.total ?? 0;
  },

  getCurrentMonthIncomeTotal: async (month?: string) => {
    const targetMonth = month || new Date().toISOString().substring(0, 7);
    const db = await getDb();
    const dateQuery = `'${targetMonth}-01'`;
    const nextMonth = `date(${dateQuery}, '+1 month')`;

    const row = await db.getFirstAsync<{ total: number }>(
      `SELECT COALESCE(SUM(amount), 0) as total
       FROM transactions
       WHERE type = 'income'
       AND parent_id IS NULL
       AND is_excluded = 0
       AND date >= ${dateQuery}
       AND date < ${nextMonth}`
    );
    return row?.total ?? 0;
  },

  getCurrentMonthCategorySpending: async (month?: string) => {
    set((state) => ({ isLoading: state.isLoading + 1 }));
    try {
      const db = await getDb();
      const dateQuery = month ? `date('${month}-01')` : "date('now', 'start of month')";
      const nextMonth = `date(${dateQuery}, '+1 month')`;

      const rows = await db.getAllAsync<CategorySpending>(
        `WITH base_spending AS (
           SELECT category_id, SUM(amount) as amount
           FROM transactions
           WHERE kind = 'expense' AND is_excluded = 0
           AND date >= ${dateQuery} AND date < ${nextMonth}
           GROUP BY category_id
         ),
         refund_adjustments AS (
           SELECT p.category_id, SUM(r.amount) as amount
           FROM transactions r
           JOIN transactions p ON r.parent_id = p.id
           WHERE r.is_excluded = 0
           AND p.date >= ${dateQuery} AND p.date < ${nextMonth}
           GROUP BY p.category_id
         )
         SELECT 
           c.id as category_id, 
           COALESCE(c.name, 'Uncategorized') as category_name, 
           c.color as category_color,
           c.icon as category_icon,
           (COALESCE(b.amount, 0) - COALESCE(ra.amount, 0)) as total
         FROM categories c
         LEFT JOIN base_spending b ON c.id = b.category_id
         LEFT JOIN refund_adjustments ra ON c.id = ra.category_id
         WHERE total > 0
         ORDER BY total DESC`
      );
      return rows;
    } finally {
      set((state) => ({ isLoading: Math.max(0, state.isLoading - 1) }));
    }
  },

  getMonthlyTrends: async () => {
    set((state) => ({ isLoading: state.isLoading + 1 }));
    try {
      const db = await getDb();
      const rows = await db.getAllAsync<MonthlyTrend>(
        `WITH monthly_base AS (
           SELECT strftime('%Y-%m', date) as month, SUM(amount) as amount
           FROM transactions
           WHERE kind = 'expense' AND is_excluded = 0
           AND date >= date('now', '-12 months')
           GROUP BY month
         ),
         monthly_refunds AS (
           SELECT strftime('%Y-%m', p.date) as month, SUM(r.amount) as amount
           FROM transactions r
           JOIN transactions p ON r.parent_id = p.id
           WHERE r.is_excluded = 0
           AND p.date >= date('now', '-12 months')
           GROUP BY month
         )
         SELECT 
           b.month,
           (COALESCE(b.amount, 0) - COALESCE(r.amount, 0)) as total
         FROM monthly_base b
         LEFT JOIN monthly_refunds r ON b.month = r.month
         ORDER BY b.month ASC`
      );
      return rows;
    } finally {
      set((state) => ({ isLoading: Math.max(0, state.isLoading - 1) }));
    }
  },

  getMerchantSpending: async () => {
    set((state) => ({ isLoading: state.isLoading + 1 }));
    try {
      const db = await getDb();
      const rows = await db.getAllAsync<MerchantSpending>(
        `WITH merchant_base AS (
           SELECT merchant, SUM(amount) as amount
           FROM transactions
           WHERE kind = 'expense' AND is_excluded = 0 AND merchant IS NOT NULL
           GROUP BY merchant
         ),
         merchant_refunds AS (
           SELECT p.merchant, SUM(r.amount) as amount
           FROM transactions r
           JOIN transactions p ON r.parent_id = p.id
           WHERE r.is_excluded = 0 AND p.merchant IS NOT NULL
           GROUP BY p.merchant
         )
         SELECT 
           b.merchant,
           (COALESCE(b.amount, 0) - COALESCE(r.amount, 0)) as total
         FROM merchant_base b
         LEFT JOIN merchant_refunds r ON b.merchant = r.merchant
         ORDER BY total DESC`
      );
      return rows;
    } finally {
      set((state) => ({ isLoading: Math.max(0, state.isLoading - 1) }));
    }
  },
  importTransactionsFromSms: async (limit?: number) => {
    if (get().isSyncing) return { imported: 0, skipped: 0 };
    set({ isSyncing: true });
    try {
      const hasPermission = await requestSmsPermission();
      if (!hasPermission) {
        throw new Error("SMS permission denied");
      }

      const db = await getDb();
      const lastSyncRow = await db.getFirstAsync<{ value: string }>("SELECT value FROM app_meta WHERE key = 'last_sms_sync_time'");
      const lastSyncTime = lastSyncRow ? parseInt(lastSyncRow.value) : 0;

      const messages = await readInboxMessages(limit, lastSyncTime);
      const { imported, skipped } = await ingestSmsMessages(db, messages, (current, total) => {
        set({ syncProgress: { current, total, message: "Importing messages..." } });
      });

      await Promise.all([
        get().fetchTransactions(),
        get().fetchBills(),
      ]);
      return { imported, skipped };
    } finally {
      set({ isSyncing: false, syncProgress: null });
    }
  },

  syncRecentSmsTransactions: async () => {
    if (get().isSyncing) return { imported: 0, skipped: 0 };
    set({ isSyncing: true });
    try {
      const hasPermission = await checkSmsPermission();
      if (!hasPermission) return { imported: 0, skipped: 0 };

      const db = await getDb();
      const lastSyncRow = await db.getFirstAsync<{ value: string }>("SELECT value FROM app_meta WHERE key = 'last_sms_sync_time'");
      const lastSyncTime = lastSyncRow ? parseInt(lastSyncRow.value) : 0;

      const messages = await readInboxMessages(100, lastSyncTime);
      const result = await ingestSmsMessages(db, messages, (current, total) => {
        set({ syncProgress: { current, total, message: "Syncing recent transactions..." } });
      });

      await Promise.all([
        get().fetchTransactions(),
        get().fetchBills(),
      ]);
      return result;
    } finally {
      set({ isSyncing: false, syncProgress: null });
    }
  },

  processIncomingSmsMessage: async (message) => {
    if (get().isSyncing) return false;
    set({ isSyncing: true });
    try {
      const db = await getDb();
      const result = await ingestSmsMessages(db, [message]);
      if (result.imported > 0) {
        await Promise.all([
          get().fetchTransactions(),
          get().fetchBills(),
        ]);
        return true;
      }
      return false;
    } finally {
      set({ isSyncing: false });
    }
  },

  runInitialSmsImportIfNeeded: async () => {
    const db = await getDb();
    const importMetaKey = "sms_initial_import_done";
    const existing = await db.getFirstAsync<{ value: string }>(
      "SELECT value FROM app_meta WHERE key = ? LIMIT 1",
      [importMetaKey]
    );

    if (existing?.value === "true") {
      return { ran: false, imported: 0, skipped: 0 };
    }

    try {
      const result = await get().importTransactionsFromSms();   // No limit since it's a one time import on app launch
      await db.runAsync(
        "INSERT OR REPLACE INTO app_meta (key, value) VALUES (?, ?)",
        [importMetaKey, "true"]
      );
      return { ran: true, imported: result.imported, skipped: result.skipped };
    } catch {
      return { ran: false, imported: 0, skipped: 0 };
    }
  },

  exportData: async () => {
    try {
      const db = await getDb();
      const [transactions, categories, bills, messages] = await Promise.all([
        db.getAllAsync("SELECT * FROM transactions"),
        db.getAllAsync("SELECT * FROM categories"),
        db.getAllAsync("SELECT * FROM bills"),
        db.getAllAsync<any>("SELECT * FROM messages ORDER BY received_at DESC"),
      ]);
      const data = JSON.stringify({ transactions, categories, bills, messages }, null, 2);

      const dir = await FileSystem.Directory.pickDirectoryAsync();
      if (!dir) throw new Error("No storage directory available");

      const fileName = `spendwise_backup_${new Date().getTime()}.json`;
      const file = dir.createFile(fileName, "application/json");

      file.write(data);

      const isSharingAvailable = await Sharing.isAvailableAsync();
      if (isSharingAvailable) {
        await Sharing.shareAsync(file.contentUri);
      } else {
        console.log("File saved to:", file.uri);
        Alert.alert("Sharing Unavailable", `Sharing is not supported on this device. File saved at: ${file.uri}`);
      }
    } catch (error: any) {
      console.error("Export error:", error);
      Alert.alert("Export Failed", error.message || "An unknown error occurred during export.");
    }
  },

  generateExportTxt: async () => {
    const db = await getDb();
    const [transactions, bills, categories] = await Promise.all([
      db.getAllAsync<any>("SELECT * FROM transactions ORDER BY date DESC"),
      db.getAllAsync<any>("SELECT * FROM bills ORDER BY due_date DESC"),
      db.getAllAsync<any>("SELECT * FROM categories"),
    ]);

    const categoryMap = categories.reduce((acc, cat) => {
      acc[cat.id] = cat.name;
      return acc;
    }, {} as Record<number, string>);

    let content = "SPENDWISE DATA EXPORT\n";
    content += `Exported on: ${new Date().toLocaleString()}\n`;
    content += "=====================\n\n";

    content += "TRANSACTIONS\n";
    content += "------------\n";
    if (transactions.length === 0) {
      content += "No transactions found.\n";
    } else {
      transactions.forEach((t: any) => {
        const catName = t.category_id ? categoryMap[t.category_id] || "Unknown" : "Uncategorized";
        const smsInfo = t.sms_hash ? ` [SMS: ${t.sms_sender || "Unknown"}]` : "";
        content += `ID: ${t.id}${smsInfo} | Date: ${t.date} | Amount: ${t.amount} | Type: ${t.type} | Kind: ${t.kind} | Cat: ${catName} | Merchant: ${t.merchant || "N/A"} | Note: ${t.note || ""}\n`;
      });
    }

    content += "\nBILLS\n";
    content += "-----\n";
    if (bills.length === 0) {
      content += "No bills found.\n";
    } else {
      bills.forEach((b: any) => {
        const catName = b.category_id ? categoryMap[b.category_id] || "Unknown" : "Uncategorized";
        content += `ID: ${b.id} | Due: ${b.due_date} | Amount: ${b.amount} | Status: ${b.status} | Sender: ${b.sender || "N/A"} | Cat: ${catName}\n`;
      });
    }

    return content;
  },

  importData: async (jsonData) => {
    const db = await getDb();
    const { transactions, categories } = JSON.parse(jsonData);

    // Clear existing data
    await db.execAsync("DELETE FROM transactions; DELETE FROM categories;");

    // Insert categories
    for (const cat of categories) {
      await db.runAsync(
        "INSERT INTO categories (id, name, icon, color) VALUES (?, ?, ?, ?)",
        [cat.id, cat.name, cat.icon, cat.color]
      );
    }

    // Insert transactions
    for (const t of transactions) {
      const kind = t.kind ?? (t.type === "income" ? "income" : "expense");
      await db.runAsync(
        "INSERT INTO transactions (category_id, amount, type, kind, date, note) VALUES (?, ?, ?, ?, ?, ?)",
        [t.category_id, t.amount, t.type, kind, t.date, t.note]
      );
    }

    await Promise.all([
      get().fetchCategories(),
      get().fetchTransactions(),
    ]);
  },

  clearAllData: async () => {
    set((state) => ({ isLoading: state.isLoading + 1 }));
    try {
      const db = await getDb();
      await db.execAsync("DELETE FROM transactions; DELETE FROM categories; DELETE FROM budgets; DELETE from bills; DELETE FROM goals; DELETE FROM app_meta;");
      await db.runAsync("INSERT OR REPLACE INTO app_meta (key, value) VALUES ('sms_initial_import_done', 'false')");
      await Promise.all([
        get().fetchTransactions(),
        get().fetchBudgets(),
        get().fetchBills(),
      ]);
    } finally {
      set((state) => ({ isLoading: Math.max(0, state.isLoading - 1) }));
    }
  },

  fetchBills: async (month?: string) => {
    set((state) => ({ isLoading: state.isLoading + 1 }));
    try {
      const db = await getDb();
      const now = new Date();
      const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
      const targetMonth = month || currentMonth;
      const dateQuery = `date('${targetMonth}-01')`;

      // Auto-cleanup duplicates if any exist from previous bug
      await db.runAsync(`
        DELETE FROM bills 
        WHERE status = 'unpaid' AND id NOT IN (
          SELECT MIN(id) FROM bills GROUP BY body, amount, due_date
        )
      `);

      // Boundary logic:
      // If current month is selected: show this month + next month.
      // Otherwise: show only the respective month.
      const isCurrent = targetMonth === currentMonth;
      const endBoundary = isCurrent ? `date(${dateQuery}, '+2 months')` : `date(${dateQuery}, '+1 month')`;

      const bills = await db.getAllAsync<Bill>(
        `SELECT * FROM bills 
         WHERE due_date >= ${dateQuery} 
         AND due_date < ${endBoundary}
         AND NOT (amount = 0 AND due_date >= date('now', 'start of month', '+2 months'))
         ORDER BY due_date ASC`
      );
      set({ bills });
    } finally {
      set((state) => ({ isLoading: Math.max(0, state.isLoading - 1) }));
    }
  },

  cleanupDuplicateBills: async () => {
    const db = await getDb();
    await db.runAsync(`
      DELETE FROM bills 
      WHERE status = 'unpaid' AND id NOT IN (
        SELECT MIN(id) FROM bills GROUP BY body, amount, due_date
      )
    `);
    get().fetchBills();
  },

  markBillAsPaid: async (billId, transactionId) => {
    const db = await getDb();
    const bill = await db.getFirstAsync<Bill>("SELECT * FROM bills WHERE id = ?", [billId]);
    if (!bill) return;

    // 1. Mark as paid & link transaction_id
    if (transactionId) {
      await db.runAsync("UPDATE bills SET status = 'paid', transaction_id = ? WHERE id = ?", [transactionId, billId]);
    } else if (transactionId === null) {
      // Mark as paid but explicitly without transaction
      await db.runAsync("UPDATE bills SET status = 'paid' WHERE id = ?", [billId]);
    } else {
      // Create new transaction if none provided (manual payment)
      const txId = Date.now(); // In reality addTransaction should return the ID
      // Let's call addTransaction but we need the ID back. 
      // addTransaction in useExpenseStore is async and doesn't return ID.
      // I'll manually insert to get the ID for linking.
      const categoryId = bill.category_id || null;
      const result = await db.runAsync(
        `INSERT INTO transactions 
          (category_id, amount, type, kind, date, note, merchant) 
          VALUES (?, ?, 'expense', 'expense', ?, ?, ?)`,
        [
          categoryId,
          bill.amount,
          new Date().toISOString(),
          bill.body ? bill.body.substring(0, 100) : "Paid Bill",
          bill.sender ? cleanMerchant(bill.sender) : "Bill Payment"
        ]
      );
      const lastId = result.lastInsertRowId;
      await db.runAsync("UPDATE bills SET status = 'paid', transaction_id = ? WHERE id = ?", [lastId, billId]);
      await get().fetchTransactions();
    }

    await get().fetchBills();
  },

  deleteBill: async (billId: number, month?: string) => {
    const db = await getDb();
    await db.runAsync("DELETE FROM bills WHERE id = ?", [billId]);
    await get().fetchBills(month);
  },

  fetchDashboardData: async (month: string) => {
    set((state) => ({ isLoading: state.isLoading + 1 }));
    try {
      const db = await getDb();
      const now = new Date();
      const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
      const targetMonth = month || currentMonth;
      const dateQuery = `date('${targetMonth}-01')`;

      // 1. Fetch Transactions
      const transactions = await db.getAllAsync<Transaction>(
        `SELECT t.*, c.name as category_name, c.color as category_color, c.icon as category_icon 
         FROM transactions t
         LEFT JOIN categories c ON t.category_id = c.id
         WHERE t.date LIKE ? AND t.is_excluded = 0
         ORDER BY t.date DESC LIMIT 10`,
        [`${targetMonth}%`]
      );

      // 2. Fetch Bills
      const isCurrent = targetMonth === currentMonth;
      const endBoundary = isCurrent ? `date(${dateQuery}, '+2 months')` : `date(${dateQuery}, '+1 month')`;
      const bills = await db.getAllAsync<Bill>(
        `SELECT * FROM bills 
         WHERE due_date >= ${dateQuery} 
         AND due_date < ${endBoundary}
         AND NOT (amount = 0 AND due_date >= date('now', 'start of month', '+2 months'))
         ORDER BY due_date ASC`
      );

      // 3. Fetch Monthly Stats
      const [expenseRes, incomeRes] = await Promise.all([
        db.getFirstAsync<{ total: number }>(
          "SELECT SUM(amount) as total FROM transactions WHERE date LIKE ? AND type = 'expense' AND is_excluded = 0",
          [`${targetMonth}%`]
        ),
        db.getFirstAsync<{ total: number }>(
          "SELECT SUM(amount) as total FROM transactions WHERE date LIKE ? AND type = 'income' AND is_excluded = 0",
          [`${targetMonth}%`]
        )
      ]);

      // 4. Fetch Budgets
      const budgets = await db.getAllAsync<Budget>("SELECT * FROM budgets");

      // Single set call to avoid multiple re-renders
      set({ 
        transactions, 
        bills, 
        monthlyExpense: expenseRes?.total || 0,
        monthlyIncome: incomeRes?.total || 0,
        budgets
      });
    } finally {
      set((state) => ({ isLoading: Math.max(0, state.isLoading - 1) }));
    }
  },

  fetchGoals: async () => {
    set((state) => ({ isLoading: state.isLoading + 1 }));
    try {
      const db = await getDb();
      const goals = await db.getAllAsync<Goal>("SELECT * FROM goals ORDER BY id DESC");
      set({ goals });
    } finally {
      set((state) => ({ isLoading: Math.max(0, state.isLoading - 1) }));
    }
  },

  addGoal: async (goal) => {
    const db = await getDb();
    await db.runAsync(
      "INSERT INTO goals (name, target_amount, current_amount, deadline, color, icon) VALUES (?, ?, ?, ?, ?, ?)",
      [goal.name, goal.target_amount, goal.current_amount, goal.deadline, goal.color, goal.icon]
    );
    await get().fetchGoals();
  },

  updateGoal: async (id, goal) => {
    const db = await getDb();
    const sets: string[] = [];
    const params: any[] = [];

    if (goal.name !== undefined) { sets.push("name = ?"); params.push(goal.name); }
    if (goal.target_amount !== undefined) { sets.push("target_amount = ?"); params.push(goal.target_amount); }
    if (goal.current_amount !== undefined) { sets.push("current_amount = ?"); params.push(goal.current_amount); }
    if (goal.deadline !== undefined) { sets.push("deadline = ?"); params.push(goal.deadline); }
    if (goal.color !== undefined) { sets.push("color = ?"); params.push(goal.color); }
    if (goal.icon !== undefined) { sets.push("icon = ?"); params.push(goal.icon); }

    if (sets.length === 0) return;

    params.push(id);
    await db.runAsync(`UPDATE goals SET ${sets.join(", ")} WHERE id = ?`, params);
    await get().fetchGoals();
  },

  deleteGoal: async (id) => {
    const db = await getDb();
    await db.runAsync("DELETE FROM goals WHERE id = ?", [id]);
    await get().fetchGoals();
  },


  getPredictiveAlert: async () => {
    const currentSpending = await get().getCurrentMonthExpenseTotal();
    const budgets = get().budgets;
    const monthlyBudget = budgets.find(b => b.category_id === null && b.period_type === 'monthly');

    if (!monthlyBudget || monthlyBudget.limit_amount <= 0) return null;

    const now = new Date();
    const dayOfMonth = now.getDate();
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();

    if (dayOfMonth === 0) return null;

    const velocity = currentSpending / dayOfMonth;
    const predictedTotal = velocity * daysInMonth;
    const limit = monthlyBudget.limit_amount;

    if (predictedTotal > limit) {
      const daysUntilLimit = Math.floor(limit / velocity);
      const ratio = predictedTotal / limit;

      if (ratio > 1.5) {
        return {
          level: "danger",
          message: `Critical: At this rate, you'll overshoot your budget by ${Math.round((ratio - 1) * 100)}%. You'll likely hit the limit by day ${daysUntilLimit} of the month.`,
          predictedTotal,
          daysUntilLimit
        };
      } else {
        return {
          level: "warning",
          message: `Warning: You're trending towards spending ${get().getCurrencySymbol()}${Math.round(predictedTotal)} this month, which exceeds your ${get().getCurrencySymbol()}${limit} limit.`,
          predictedTotal,
          daysUntilLimit
        };
      }
    }

    if (currentSpending > limit * 0.8) {
      return {
        level: "warning",
        message: `Caution: You've used ${Math.round((currentSpending / limit) * 100)}% of your budget with ${daysInMonth - dayOfMonth} days left.`,
        predictedTotal
      };
    }

    return {
      level: "safe",
      message: "You're well within your budget for this month. Keep it up!",
      predictedTotal
    };
  },

  getUnlinkedIncomes: async () => {
    const db = await getDb();
    const rows = await db.getAllAsync<Transaction>(
      `SELECT t.*, c.name as category_name, c.color as category_color, c.icon as category_icon 
       FROM transactions t
       LEFT JOIN categories c ON t.category_id = c.id
       WHERE t.type = 'income' AND (t.goal_id IS NULL OR t.goal_id = 0)
       ORDER BY t.date DESC`
    );
    return rows;
  },

  linkTransactionToGoal: async (transactionId, goalId, percent) => {
    const db = await getDb();
    const transaction = await db.getFirstAsync<Transaction>("SELECT * FROM transactions WHERE id = ?", [transactionId]);
    const goal = await db.getFirstAsync<Goal>("SELECT * FROM goals WHERE id = ?", [goalId]);

    if (!transaction || !goal) return;

    // 1. Link transaction and update percent if provided
    if (percent !== undefined) {
      await db.runAsync("UPDATE transactions SET goal_id = ?, goal_percent = ? WHERE id = ?", [goalId, percent, transactionId]);
    } else {
      await db.runAsync("UPDATE transactions SET goal_id = ? WHERE id = ?", [goalId, transactionId]);
    }

    // 2. Update goal amount (respects provided percent or existing goal_percent, defaults to 100)
    const pct = percent ?? transaction.goal_percent ?? 100;
    const contribution = transaction.amount * (pct / 100);
    const newAmount = goal.current_amount + contribution;
    await db.runAsync("UPDATE goals SET current_amount = ? WHERE id = ?", [newAmount, goalId]);

    await Promise.all([
      get().fetchGoals(),
      get().fetchTransactions(),
    ]);
  },

  getGoalTransactions: async (goalId) => {
    const db = await getDb();
    const rows = await db.getAllAsync<Transaction>(
      `SELECT t.*, c.name as category_name, c.color as category_color, c.icon as category_icon 
       FROM transactions t
       LEFT JOIN categories c ON t.category_id = c.id
       WHERE t.goal_id = ?
       ORDER BY t.date DESC`,
      [goalId]
    );
    return rows;
  },

  fetchAutoTransferThreshold: async () => {
    const db = await getDb();
    const row = await db.getFirstAsync<{ value: string }>("SELECT value FROM app_meta WHERE key = 'auto_transfer_threshold'");
    const threshold = row ? parseFloat(row.value) : 10000;
    set({ autoTransferThreshold: threshold });
  },

  setAutoTransferThreshold: async (amount: number) => {
    const db = await getDb();
    await db.runAsync("INSERT OR REPLACE INTO app_meta (key, value) VALUES ('auto_transfer_threshold', ?)", [amount.toString()]);
    set({ autoTransferThreshold: amount });
  },

  identifyRecurringPayments: async () => {
    const db = await getDb();
    // Same amount on same day of month in past 3 months
    const rows = await db.getAllAsync<Transaction>(`
      WITH recent_txs AS (
        SELECT *, strftime('%d', date) as day_of_month, strftime('%Y-%m', date) as month
        FROM transactions
        WHERE kind = 'expense' AND is_excluded = 0
        AND date >= date('now', '-3 months')
      )
      SELECT t1.* 
      FROM recent_txs t1
      WHERE EXISTS (
        SELECT 1 FROM recent_txs t2 
        WHERE t2.amount = t1.amount 
        AND t2.day_of_month = t1.day_of_month 
        AND t2.month != t1.month
      )
      ORDER BY t1.amount DESC, t1.date DESC
    `);
    return rows;
  },

  syncRecurringBills: async () => {
    const db = await getDb();
    const recurring = await get().identifyRecurringPayments();
    if (!recurring || recurring.length === 0) return false;

    // Deduplicate recurring patterns
    const patterns = recurring.reduce((acc: any[], curr) => {
      const day = new Date(curr.date).getDate();
      if (!acc.find(p => p.merchant === curr.merchant && p.amount === curr.amount && p.day === day)) {
        acc.push({ merchant: curr.merchant, amount: curr.amount, day, category_id: curr.category_id });
      }
      return acc;
    }, []);

    const now = new Date();
    const currentMonth = now.toISOString().substring(0, 7); // YYYY-MM
    let addedAny = false;

    for (const p of patterns) {
      // Check if a bill or transaction already exists for this merchant/amount this month
      const existingBill = await db.getFirstAsync<{ id: number }>(
        "SELECT id FROM bills WHERE sender = ? AND amount = ? AND strftime('%Y-%m', due_date) = ?",
        [p.merchant, p.amount, currentMonth]
      );

      const existingTx = await db.getFirstAsync<{ id: number }>(
        "SELECT id FROM transactions WHERE merchant = ? AND amount = ? AND strftime('%Y-%m', date) = ? AND is_excluded = 0",
        [p.merchant, p.amount, currentMonth]
      );

      if (!existingBill && !existingTx) {
        // Create a predicted bill date
        const dueDate = new Date(now.getFullYear(), now.getMonth(), p.day).toISOString();
        await db.runAsync(
          "INSERT INTO bills (sender, amount, due_date, status, is_recurring, category_id) VALUES (?, ?, ?, 'unpaid', 1, ?)",
          [p.merchant, p.amount, dueDate, p.category_id]
        );
        addedAny = true;
      }
    }

    return addedAny;
  },
}));




// Helper to clean merchant names (moved from smsParser or just using it)
function cleanMerchant(name: string) {
  return name.replace(/^VM-|^AD-|^DM-|^HP-|^BZ-|^CP-|^IC-|^AX-|^HD-|^SC-/, "").trim();
}

async function ingestSmsMessages(
  db: SQLiteDatabase,
  messages: SmsMessage[],
  onProgress?: (current: number, total: number) => void
) {
  let imported = 0;
  let skipped = 0;

  // 1. Pre-fetch categories for fast lookup
  const categories = await db.getAllAsync<Category>("SELECT * FROM categories");
  const categoryMap = categories.reduce((acc, cat) => {
    acc[cat.name.toLowerCase()] = cat.id;
    return acc;
  }, {} as Record<string, number>);

  // 2. Pre-fetch existing hashes from TRANSACTIONS to avoid N queries
  const hashesToCheck = messages.map(m => buildHash(m.address, m.body, m.date));
  const existingHashes = new Set<string>();

  for (let i = 0; i < hashesToCheck.length; i += 500) {
    const chunk = hashesToCheck.slice(i, i + 500);
    const placeholders = chunk.map(() => "?").join(",");
    const rows = await db.getAllAsync<{ sms_hash: string }>(
      `SELECT sms_hash FROM transactions WHERE sms_hash IN (${placeholders})`,
      chunk
    );
    rows.forEach(r => existingHashes.add(r.sms_hash));
  }

  let maxProcessedDate = 0;
  // 2. Intra-batch duplicate check to avoid redundant DB queries
  const processedInBatch = new Set<string>();

  // 3. Wrap in transaction for atomic speed
  await db.withTransactionAsync(async () => {
    for (let i = 0; i < messages.length; i++) {
      const message = messages[i];

      // Throttle UI updates: update every 100 messages or at the end
      if (onProgress && (i % 100 === 0 || i === messages.length - 1)) {
        onProgress(i + 1, messages.length);
      }

      if (message.date > maxProcessedDate) {
        maxProcessedDate = message.date;
      }

      // a. Fast hash check using pre-fetched Set (Cross-batch duplicate)
      const hash = buildHash(message.address, message.body, message.date);
      if (existingHashes.has(hash)) {
        skipped += 1;
        continue;
      }

      // b. Intra-batch duplicate check (Same body and similar time in this import)
      const approxTimeSec = Math.floor((message.date ?? 0) / 1000);
      const batchKey = `${message.body}_${Math.floor(approxTimeSec / 60)}`; // Group by body and minute
      if (processedInBatch.has(batchKey)) {
        skipped += 1;
        continue;
      }
      processedInBatch.add(batchKey);

      // c. Secondary DB dedup check (only if not initial import or if we have existing transactions)
      // If we have 14k messages, we don't want to run this query 14k times.
      // We skip it if the message hash is already unique and it's a bulk import into an empty DB.
      if (existingHashes.size > 0) {
        const bodyDuplicate = await db.getFirstAsync<{ id: number }>(
          `SELECT id FROM transactions
           WHERE sms_body = ? AND ABS(strftime('%s', date) - ?) <= 120
           LIMIT 1`,
          [message.body, approxTimeSec]
        );
        if (bodyDuplicate) {
          skipped += 1;
          continue;
        }

        // Amount+time dedup: skip if same amount exists within 60 seconds
        const amountRx = message.body.match(/(?:rs\.?|inr|₹)\s*([0-9,]+(?:\.[0-9]{1,2})?)/i);
        if (amountRx) {
          const smsAmt = parseFloat(amountRx[1].replace(/,/g, ''));
          if (smsAmt > 0) {
            const amountTimeDup = await db.getFirstAsync<{ id: number }>(
              `SELECT id FROM transactions WHERE amount = ? AND ABS(strftime('%s', date) - ?) <= 60 LIMIT 1`,
              [smsAmt, approxTimeSec]
            );
            if (amountTimeDup) { skipped += 1; continue; }
          }
        }
      }


      // d. Parsing: Use sync version for bulk import to avoid bridge overhead
      const isBulk = messages.length > 100;
      const parsed = isBulk
        ? parseSmsForTransactionSync(message)
        : await parseSmsForTransaction(message);

      if (!parsed) {
        // Try parsing as a bill
        const parsedBill = isBulk ? parseSmsForBillSync(message) : await parseSmsForBill(message);
        if (parsedBill && parsedBill.amount > 0) {
          const parsedBillDateStr = parsedBill.dueDate || new Date().toISOString();
          const existingBill = await db.getFirstAsync<{ id: number }>(
            "SELECT id FROM bills WHERE amount = ? AND date(due_date) = date(?)",
            [parsedBill.amount, parsedBillDateStr]
          );

          if (!existingBill) {
            await db.runAsync(
              "INSERT INTO bills (sender, body, amount, due_date, status) VALUES (?, ?, ?, ?, 'unpaid')",
              [parsedBill.sender, parsedBill.body, parsedBill.amount, parsedBillDateStr]
            );
            imported += 1;
          }
        }
        skipped += 1;
        continue;
      }

      // e. Categorize and insert transaction
      const categoryId = getCategoryIdForMessage(categoryMap, message.body, parsed.merchant, parsed.type);

      // Auto-transfer threshold: fetch from app_meta lazily
      const thresholdRow = await db.getFirstAsync<{ value: string }>("SELECT value FROM app_meta WHERE key = 'auto_transfer_threshold'");
      const autoTransferThreshold = thresholdRow ? parseFloat(thresholdRow.value) : 10000;
      const kind = (parsed.amount >= autoTransferThreshold && (parsed.kind === 'expense' || !parsed.kind))
        ? 'transfer'
        : (parsed.kind || (parsed.type === "income" ? "income" : "expense"));

      const txResult = await db.runAsync(
        `INSERT INTO transactions (
          category_id, amount, type, date, note, 
          kind, merchant, currency, account_ref, 
          reference_id, raw_sender, sms_body, 
          sms_sender, sms_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          categoryId,
          parsed.amount,
          parsed.type,
          parsed.receivedAt,
          parsed.merchant || (message.address ? `SMS: ${message.address}` : "Transaction"),
          kind,
          parsed.merchant || "",
          "INR",
          parsed.accountRef || "",
          parsed.referenceId || "",
          message.address,
          message.body,
          message.address,
          hash
        ]
      );

      if (parsed.kind === 'refund') {
        await tryAutoLinkRefund(db, txResult.lastInsertRowId, parsed.amount, parsed.merchant, message.date.toString());
      }
      imported += 1;
    }

    // Update last sync time so we don't re-process these messages next time
    if (maxProcessedDate > 0) {
      await db.runAsync(
        "INSERT OR REPLACE INTO app_meta (key, value) VALUES ('last_sms_sync_time', ?)",
        [maxProcessedDate.toString()]
      );
    }
  });

  return { imported, skipped };
}

async function tryAutoLinkRefund(
  db: Awaited<ReturnType<typeof getDb>>,
  refundId: number,
  amount: number,
  merchant: string | null | undefined,
  date: string
) {
  if (!merchant || amount <= 0) return;

  // Search for an expense with same merchant in last 30 days
  const potentialParent = await db.getFirstAsync<{ id: number; category_id: number }>(
    `SELECT id, category_id FROM transactions 
     WHERE kind = 'expense' 
     AND LOWER(merchant) = LOWER(?) 
     AND amount >= ?
     AND date <= ?
     AND date >= date(?, '-30 days')
     ORDER BY date DESC LIMIT 1`,
    [merchant, amount, date, date]
  );

  if (potentialParent) {
    await db.runAsync(
      "UPDATE transactions SET parent_id = ?, category_id = COALESCE(category_id, ?) WHERE id = ?",
      [potentialParent.id, potentialParent.category_id, refundId]
    );
  }
}

// ─── Optimized Category Detection ──────────────────────────────────────────

const CATEGORY_KEYWORDS: Record<string, string[]> = {
  Food: ["swiggy", "zomato", "restaurant", "food", "cafe", "coffee", "pizza", "burger", "dominos", "starbucks", "eat", "meal", "lunch", "dinner", "dining", "uber eats"],
  Groceries: ["blinkit", "bigbasket", "zepto", "grocery", "groceries", "supermarket", "dmart", "reliance fresh", "spencer", "mart", "kirana", "vegetable", "fruit", "dairy", "milk"],
  Transport: ["uber", "ola", "rapido", "metro", "train", "bus", "auto", "taxi", "cab", "irctc", "travel", "booking"],
  Travel: ["flight", "airline", "hotel", "stay", "makemytrip", "goibibo", "airbnb", "oyo", "trivago"],
  Bills: ["electricity", "broadband", "wifi", "recharge", "bill", "water", "gas", "mobile", "dth", "utility", "power", "energy", "bsnl", "airtel", "jio", "vi", "vodafone", "idea", "tata power", "bescom", "mseb", "maintenance"],
  Rent: ["rent", "housing", "apartment", "flat", "pg", "hostel"],
  Shopping: ["amazon", "flipkart", "myntra", "ajio", "meesho", "nykaa", "purplle", "tatacliq", "snapdeal", "mall", "shopping", "fashion", "clothing", "electronics", "gadget"],
  Health: ["pharmacy", "hospital", "health", "medic", "doctor", "clinic", "apollo", "pharmeasy", "1mg", "netmeds", "diagnostic", "lab", "test", "fitness", "gym", "wellness"],
  Entertainment: ["netflix", "prime", "hotstar", "disney", "sony", "zee5", "spotify", "youtube", "music", "movie", "cinema", "pvr", "inox", "bookmyshow", "game", "gaming"],
  Subscriptions: ["subscription", "subscriptions", "recurring", "monthly", "annual", "ott"],
  Education: ["course", "tuition", "fee", "exam", "book", "udemy", "coursera", "byju", "unacademy", "vedantu", "upgrad", "learning", "study", "school", "college"],
  Fuel: ["fuel", "petrol", "diesel", "hpcl", "bpcl", "iocl", "shell", "vehicle", "car", "bike", "scooter", "parking", "toll", "fastag"],
  Gifts: ["gift", "present", "donation", "charity", "celebration", "festival"],
  EMI: ["emi", "loan", "mortgage"],
  Investment: ["invest", "mutual fund", "stock", "share", "demat", "trading", "zerodha", "groww", "upstox", "etmoney", "savings", "fd", "fixed deposit", "rd", "ppf", "nps", "insurance", "lic"],
  Transfer: ["transfer", "sent", "received", "upi", "neft", "imps", "rtgs", "paytm", "phonepe", "gpay", "google pay", "bhim", "cred"]
};

// Pre-compile Regex for each category for maximum performance
const COMPILED_CATEGORY_REGEX = Object.entries(CATEGORY_KEYWORDS).map(([name, words]) => ({
  name,
  regex: new RegExp(`\\b(${words.join("|")})\\b`, "i")
}));

function getCategoryIdForMessage(
  categoryMap: Record<string, number>,
  body: string,
  merchant: string | undefined,
  type: "expense" | "income"
) {
  const normalized = body.toLowerCase();
  const merchantText = (merchant || "").toLowerCase();
  const combined = `${normalized} ${merchantText}`;

  const otherId = categoryMap["other"] || null;

  if (type === "income") {
    return categoryMap["salary"] || otherId;
  }

  // Fast regex matching
  for (const { name, regex } of COMPILED_CATEGORY_REGEX) {
    if (regex.test(combined)) {
      return categoryMap[name.toLowerCase()] || otherId;
    }
  }

  return otherId;
}

export function getCategoryIcon(categoryName?: string | null, merchant?: string | null, note?: string | null): string {
  const name = (categoryName || "").toLowerCase().trim();
  const merch = (merchant || "").toLowerCase().trim();
  const noteText = (note || "").toLowerCase().trim();
  const combined = `${name} ${merch} ${noteText}`;

  if (!name && !merch) return "CircleDollarSign";

  // Food & Dining
  if (combined.includes("food") || combined.includes("dining") || combined.includes("restaurant") ||
    combined.includes("swiggy") || combined.includes("zomato") || combined.includes("uber eats") ||
    combined.includes("pizza") || combined.includes("burger") || combined.includes("cafe") ||
    combined.includes("coffee") || combined.includes("starbucks") || combined.includes("dominos") ||
    combined.includes("eat") || combined.includes("meal") || combined.includes("lunch") || combined.includes("dinner"))
    return "UtensilsCrossed";

  // Groceries
  if (combined.includes("grocery") || combined.includes("groceries") || combined.includes("supermarket") ||
    combined.includes("bigbasket") || combined.includes("blinkit") || combined.includes("zepto") ||
    combined.includes("dmart") || combined.includes("reliance fresh") || combined.includes("spencer") ||
    combined.includes("mart") || combined.includes("kirana") || combined.includes("vegetable") ||
    combined.includes("fruit") || combined.includes("dairy") || combined.includes("milk"))
    return "ShoppingCart";

  // Transport (local commuting)
  if (combined.includes("transport") || combined.includes("cab") ||
    combined.includes("uber") || combined.includes("ola") || combined.includes("rapido") ||
    combined.includes("bus") || combined.includes("metro") || combined.includes("auto") ||
    combined.includes("taxi"))
    return "Car";

  // Travel (long distance trips)
  if (combined.includes("travel") || combined.includes("train") || combined.includes("flight") ||
    combined.includes("irctc") || combined.includes("makemytrip") || combined.includes("goibibo") ||
    combined.includes("booking") || combined.includes("hotel") || combined.includes("stay") ||
    combined.includes("airbnb") || combined.includes("oyo") || combined.includes("trivago"))
    return "Plane";

  // Fuel & Vehicle
  if (combined.includes("fuel") || combined.includes("petrol") || combined.includes("diesel") ||
    combined.includes("hpcl") || combined.includes("bpcl") || combined.includes("iocl") ||
    combined.includes("shell") || combined.includes("vehicle") || combined.includes("car") ||
    combined.includes("bike") || combined.includes("scooter") || combined.includes("parking") ||
    combined.includes("toll") || combined.includes("fastag"))
    return "Fuel";

  // Bills & Utilities
  if (combined.includes("bill") || combined.includes("recharge") || combined.includes("electricity") ||
    combined.includes("water") || combined.includes("gas") || combined.includes("broadband") ||
    combined.includes("wifi") || combined.includes("mobile") || combined.includes("dth") ||
    combined.includes("utility") || combined.includes("power") || combined.includes("energy") ||
    combined.includes("bsnl") || combined.includes("airtel") || combined.includes("jio") ||
    combined.includes("vi ") || combined.includes("vodafone") || combined.includes("idea") ||
    combined.includes("tata power") || combined.includes("bescom") || combined.includes("mseb") ||
    combined.includes("rent") || combined.includes("maintenance"))
    return "Receipt";

  // Shopping
  if (combined.includes("shopping") || combined.includes("amazon") || combined.includes("flipkart") ||
    combined.includes("myntra") || combined.includes("ajio") || combined.includes("meesho") ||
    combined.includes("nykaa") || combined.includes("purplle") || combined.includes("tatacliq") ||
    combined.includes("snapdeal") || combined.includes("shopify") || combined.includes("store") ||
    combined.includes("mall") || combined.includes("retail") || combined.includes("fashion") ||
    combined.includes("clothing") || combined.includes("electronics") || combined.includes("gadget"))
    return "ShoppingBag";

  // Health & Medical
  if (combined.includes("health") || combined.includes("medical") || combined.includes("hospital") ||
    combined.includes("pharmacy") || combined.includes("medicine") || combined.includes("doctor") ||
    combined.includes("clinic") || combined.includes("apollo") || combined.includes("pharmeasy") ||
    combined.includes("1mg") || combined.includes("netmeds") || combined.includes("diagnostic") ||
    combined.includes("lab") || combined.includes("test") || combined.includes("fitness") ||
    combined.includes("gym") || combined.includes("wellness"))
    return "HeartPulse";

  // Entertainment
  if (combined.includes("entertainment") || combined.includes("movie") || combined.includes("cinema") ||
    combined.includes("pvr") || combined.includes("inox") || combined.includes("bookmyshow") ||
    combined.includes("netflix") || combined.includes("prime") || combined.includes("hotstar") ||
    combined.includes("disney") || combined.includes("sony") || combined.includes("zee5") ||
    combined.includes("spotify") || combined.includes("youtube") || combined.includes("music") ||
    combined.includes("game") || combined.includes("gaming") || combined.includes("play") ||
    combined.includes("ott"))
    return "Clapperboard";

  // Subscriptions (separate from entertainment)
  if (combined.includes("subscription") || combined.includes("subscriptions") || combined.includes("recurring") ||
    combined.includes("monthly") || combined.includes("annual"))
    return "CalendarCheck";

  // Education
  if (combined.includes("education") || combined.includes("school") || combined.includes("college") ||
    combined.includes("university") || combined.includes("course") || combined.includes("tuition") ||
    combined.includes("fee") || combined.includes("exam") || combined.includes("book") ||
    combined.includes("udemy") || combined.includes("coursera") || combined.includes("byju") ||
    combined.includes("unacademy") || combined.includes("vedantu") || combined.includes("upgrad") ||
    combined.includes("learning") || combined.includes("study"))
    return "GraduationCap";

  // Rent & Housing
  if (combined.includes("rent") || combined.includes("housing") || combined.includes("apartment") ||
    combined.includes("flat") || combined.includes("pg") || combined.includes("hostel") ||
    combined.includes("accommodation") || combined.includes("lease"))
    return "Home";

  // Salary & Income
  if (combined.includes("salary") || combined.includes("income") || combined.includes("payroll") ||
    combined.includes("stipend") || combined.includes("wage") || combined.includes("earned") ||
    combined.includes("deposit") || combined.includes("credited") || combined.includes("received"))
    return "Banknote";

  // Investment
  if (combined.includes("invest") || combined.includes("mutual fund") || combined.includes("stock") ||
    combined.includes("share") || combined.includes("demat") || combined.includes("trading") ||
    combined.includes("zerodha") || combined.includes("groww") || combined.includes("upstox") ||
    combined.includes("etmoney") || combined.includes("savings") || combined.includes("fd") ||
    combined.includes("fixed deposit") || combined.includes("rd") || combined.includes("ppf") ||
    combined.includes("nps") || combined.includes("insurance") || combined.includes("lic"))
    return "TrendingUp";

  // Transfer
  if (combined.includes("transfer") || combined.includes("sent") || combined.includes("received") ||
    combined.includes("upi") || combined.includes("neft") || combined.includes("imps") ||
    combined.includes("rtgs") || combined.includes("paytm") || combined.includes("phonepe") ||
    combined.includes("gpay") || combined.includes("google pay") || combined.includes("bhim") ||
    combined.includes("cred") || combined.includes("mobikwik") || combined.includes("freecharge"))
    return "ArrowLeftRight";

  // Refund
  if (combined.includes("refund") || combined.includes("return") || combined.includes("reversal") ||
    combined.includes("cashback"))
    return "RotateCcw";

  // Insurance
  if (combined.includes("insurance") || combined.includes("policy") || combined.includes("premium") ||
    combined.includes("lic") || combined.includes("star health") || combined.includes("icici lombard") ||
    combined.includes("hdfc ergo") || combined.includes("bajaj allianz"))
    return "Shield";

  // Personal & Family
  if (combined.includes("gift") || combined.includes("donation") || combined.includes("charity") ||
    combined.includes("family") || combined.includes("personal") || combined.includes("wedding") ||
    combined.includes("celebration") || combined.includes("festival") || combined.includes("puja"))
    return "Gift";

  // Business & Professional
  if (combined.includes("business") || combined.includes("office") || combined.includes("professional") ||
    combined.includes("consulting") || combined.includes("freelance") || combined.includes("service") ||
    combined.includes("repair") || combined.includes("maintenance"))
    return "Briefcase";

  // Default
  return "CircleDollarSign";
}

export function getTransactionDisplay(transaction: Partial<Pick<Transaction, "kind" | "type" | "category_name" | "merchant" | "note" | "category_icon">>) {
  const type = transaction.type || "expense";
  const kind = transaction.kind || (type === "income" ? "income" : "expense");
  const icon = transaction.category_icon || getCategoryIcon(transaction.category_name, transaction.merchant, transaction.note);

  if (kind === "transfer") return { sign: "", colorClass: "text-amber-400", label: "Transfer", icon };
  if (kind === "refund") return { sign: "+", colorClass: "text-cyan-400", label: "Refund", icon };
  if (kind === "income") return { sign: "+", colorClass: "text-emerald-400", label: "Income", icon };
  return { sign: "-", colorClass: "text-rose-400", label: "Expense", icon };
}
