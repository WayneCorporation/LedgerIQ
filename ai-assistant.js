const Anthropic = require('@anthropic-ai/sdk');

const MODEL = process.env.AI_ASSISTANT_MODEL || 'claude-opus-5';
const MAX_ITERATIONS = 6;

const SYSTEM_PROMPT = `You are a financial assistant built into ledgerIQ, a small-business invoicing and bookkeeping app. Answer questions about the signed-in user's own business finances using ONLY the data returned by the tools provided to you — never estimate, guess, or invent financial figures. If a tool returns no relevant data, say so plainly rather than speculating. You are strictly read-only: you have no ability to create, edit, send, or delete any record, and must never claim to have done so, even if asked. Keep answers concise, cite specific figures and record numbers from the tool results, and use currency values exactly as returned.`;

const TOOLS = [
  {
    name: 'list_outstanding_invoices',
    description: 'List invoices that are not yet fully paid (draft, sent, or overdue), with client name, total, amount paid, outstanding balance, due date and status. Use for questions about who owes money, accounts receivable, or which invoices are overdue.',
    input_schema: {
      type: 'object',
      properties: {
        statusFilter: { type: 'string', enum: ['any', 'overdue'], description: 'Restrict to overdue invoices only, or any unpaid status (draft, sent, overdue).' },
      },
      required: [],
    },
  },
  {
    name: 'list_expenses',
    description: 'List expenses/supplier bills, optionally filtered to a specific calendar month and/or category, with vendor, amount, status and date. Use for questions about spending, biggest expenses, or a specific expense category.',
    input_schema: {
      type: 'object',
      properties: {
        month: { type: 'string', description: 'Restrict to this calendar month, formatted YYYY-MM.' },
        category: { type: 'string', description: 'Restrict to this expense category.' },
      },
      required: [],
    },
  },
  {
    name: 'compare_expenses_by_month',
    description: 'Get total paid expenses for the last N calendar months, broken down by category, to answer questions like "why did expenses increase" or to compare spending over time.',
    input_schema: {
      type: 'object',
      properties: {
        months: { type: 'integer', description: 'How many trailing months to include, including the current month. Default 3, max 12.' },
      },
      required: [],
    },
  },
  {
    name: 'get_cashflow_position',
    description: 'Get the current cash position: total bank balances, total outstanding invoice value expected to come in, total outstanding expense value expected to go out, and the resulting projected cash balance. Use for questions about projected cash, runway, or overall financial health.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
];

function round(value) { return Math.round(Number(value || 0) * 100) / 100; }

function initAiAssistant(db, { clean }) {
  const client = process.env.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) : null;

  function invoiceOutstanding(row) {
    const net = Math.max(0, row.subtotal - Number(row.discount || 0));
    const total = net * (1 + Number(row.taxRate || 0) / 100);
    return { total, outstanding: Math.max(0, total - row.paid) };
  }

  function runTool(name, input, context) {
    const { tenantId, organizationId } = context;
    if (name === 'list_outstanding_invoices') {
      const statuses = input.statusFilter === 'overdue' ? ['overdue'] : ['draft', 'sent', 'overdue'];
      const placeholders = statuses.map(() => '?').join(',');
      const rows = db.prepare(`SELECT i.number,c.name clientName,i.due_date dueDate,i.status,i.tax_rate taxRate,i.discount,COALESCE((SELECT SUM(ii.quantity*ii.rate) FROM invoice_items ii WHERE ii.invoice_id=i.id),0) subtotal,COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.subject_type='invoice' AND p.subject_id=i.id),0) paid FROM invoices i JOIN clients c ON c.id=i.client_id WHERE i.tenant_id=? AND i.organization_id=? AND i.status IN (${placeholders}) ORDER BY i.due_date`).all(tenantId, organizationId, ...statuses);
      const invoices = rows.map(row => {
        const { total, outstanding } = invoiceOutstanding(row);
        return { invoiceNumber: row.number, client: row.clientName, dueDate: row.dueDate, status: row.status, total: round(total), outstanding: round(outstanding) };
      }).filter(inv => inv.outstanding > 0).sort((a, b) => b.outstanding - a.outstanding);
      return { invoices };
    }
    if (name === 'list_expenses') {
      let query = `SELECT reference,vendor,category,expense_date date,due_date due,amount,status FROM expenses WHERE tenant_id=? AND organization_id=?`;
      const params = [tenantId, organizationId];
      if (/^\d{4}-\d{2}$/.test(String(input.month || ''))) { query += ' AND expense_date LIKE ?'; params.push(`${input.month}%`); }
      if (input.category) { query += ' AND category=?'; params.push(clean(input.category, 80)); }
      query += ' ORDER BY amount DESC LIMIT 200';
      return { expenses: db.prepare(query).all(...params) };
    }
    if (name === 'compare_expenses_by_month') {
      const months = Math.min(12, Math.max(1, Number(input.months) || 3));
      const results = [];
      for (let i = months - 1; i >= 0; i--) {
        const cursor = new Date(); cursor.setMonth(cursor.getMonth() - i);
        const key = cursor.toISOString().slice(0, 7);
        const rows = db.prepare(`SELECT category,COALESCE(SUM(amount),0) total FROM expenses WHERE tenant_id=? AND organization_id=? AND status='paid' AND expense_date LIKE ? GROUP BY category`).all(tenantId, organizationId, `${key}%`);
        results.push({ month: key, total: round(rows.reduce((s, r) => s + r.total, 0)), byCategory: rows.map(r => ({ category: r.category, total: round(r.total) })) });
      }
      return { months: results };
    }
    if (name === 'get_cashflow_position') {
      const bankBalance = (db.prepare(`SELECT COALESCE(SUM(balance),0) total FROM bank_accounts WHERE tenant_id=? AND organization_id=?`).get(tenantId, organizationId) || { total: 0 }).total;
      const invoiceRows = db.prepare(`SELECT i.tax_rate taxRate,i.discount,COALESCE((SELECT SUM(ii.quantity*ii.rate) FROM invoice_items ii WHERE ii.invoice_id=i.id),0) subtotal,COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.subject_type='invoice' AND p.subject_id=i.id),0) paid FROM invoices i WHERE i.tenant_id=? AND i.organization_id=? AND i.status IN ('draft','sent','overdue')`).all(tenantId, organizationId);
      const expectedIn = invoiceRows.reduce((s, row) => s + invoiceOutstanding(row).outstanding, 0);
      const expenseRows = db.prepare(`SELECT amount,COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.subject_type='expense' AND p.subject_id=e.id),0) paid FROM expenses e WHERE e.tenant_id=? AND e.organization_id=? AND e.status IN ('due','overdue')`).all(tenantId, organizationId);
      const expectedOut = expenseRows.reduce((s, row) => s + Math.max(0, Number(row.amount) - row.paid), 0);
      return { currentCash: round(bankBalance), expectedReceivables: round(expectedIn), expectedPayables: round(expectedOut), projectedBalance: round(bankBalance + expectedIn - expectedOut) };
    }
    return { error: 'Unknown tool' };
  }

  async function ask(user, question) {
    if (!client) return { configured: false, answer: 'The AI finance assistant is not configured yet. Set ANTHROPIC_API_KEY to enable it.' };
    const context = { tenantId: user.tenant_id, organizationId: user.organization_id };
    const messages = [{ role: 'user', content: question }];
    for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
      let response;
      try {
        response = await client.messages.create({ model: MODEL, max_tokens: 1024, system: SYSTEM_PROMPT, tools: TOOLS, thinking: { type: 'adaptive' }, messages });
      } catch (error) {
        return { configured: true, answer: 'The AI assistant could not answer right now — please try again shortly.' };
      }
      const toolUses = response.content.filter(block => block.type === 'tool_use');
      if (!toolUses.length) {
        const text = response.content.filter(block => block.type === 'text').map(block => block.text).join('\n').trim();
        return { configured: true, answer: text || 'I could not find an answer to that question.' };
      }
      messages.push({ role: 'assistant', content: response.content });
      const toolResults = toolUses.map(use => ({ type: 'tool_result', tool_use_id: use.id, content: JSON.stringify(runTool(use.name, use.input, context)) }));
      messages.push({ role: 'user', content: toolResults });
    }
    return { configured: true, answer: 'That question needed more steps than I could take — try asking something more specific.' };
  }

  return { ask, configured: Boolean(client) };
}

module.exports = { initAiAssistant };
