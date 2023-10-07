import Stripe from "stripe";
import { getCountryData } from "countries-list";
import { debug } from "./utils.js";

export function getStripeClients() {
  const clients = {};

  Object.keys(process.env).forEach((key) => {
    if (key.startsWith("STRIPE_TOKEN_")) {
      const account = key.slice(13).toLowerCase();
      const secret = process.env[key];

      if (!secret) return;

      const client = new Stripe(secret, {
        apiVersion: "2023-08-16",
      });

      clients[account] = client;
    }
  });

  const accounts = Object.keys(clients);

  return [clients, accounts];
}

function processCharge(transaction) {
  const txCharge = transaction.source;

  const errors = [];
  const charge = {
    transaction_id: transaction.id,
    id: txCharge.id,
    amount: transaction.amount,
    net: transaction.net,
    fee: transaction.fee,
    currency: transaction.currency,
    exchange_rate: transaction.exchange_rate ?? 1,
    description:
      txCharge.description ??
      txCharge.statement_descriptor ??
      txCharge.calculated_statement_descriptor,
    created: new Date(transaction.created * 1000),
    available_on: new Date(transaction.available_on * 1000),
    metadata: txCharge.metadata,
    payment_method: txCharge.payment_method_details,
    billing_details: txCharge.billing_details,
    invoice: txCharge.invoice
      ? {
          id: txCharge.invoice.id,
          number: txCharge.invoice.number,
          invoice_pdf: txCharge.invoice.invoice_pdf,
          // effective_at: txCharge.invoice.effective_at,
          // period_end: txCharge.invoice.period_end,
          // period_start: txCharge.invoice.period_start,
          lines: txCharge.invoice.lines.data.map((line) => {
            return {
              id: line.id,
              amount: line.amount,
              currency: line.currency,
              description: line.description,
              period: {
                start: line.period?.start && new Date(line.period.start * 1000),
                end: line.period?.end && new Date(line.period.end * 1000),
              },
              type: line.type,
            };
          }),
          total: txCharge.invoice.total,
          total_excluding_tax: txCharge.invoice.total_excluding_tax,
          total_tax_amounts: txCharge.invoice.total_tax_amounts,
        }
      : null,
    customer: txCharge.customer
      ? {
          id: txCharge.customer.id,
          email: txCharge.customer.email,
          name: txCharge.customer.name,
          address: txCharge.customer.address,
        }
      : null,
  };

  // Remove stripe internal data:
  if (charge.metadata?.PageId) {
    delete charge.metadata.PageId;
  }

  if (charge.billing_details?.email === null) {
    if (charge.customer?.email) {
      charge.billing_details.email = charge.customer.email;
    } else if (charge.metadata?.recipient_email) {
      charge.billing_details.email = charge.metadata.recipient_email;
    }
  }

  if (charge.billing_details?.address?.country) {
    const country = getCountryData(charge.billing_details.address.country);
    charge.billing_details.address.country = country.name;
  }

  if (!charge.invoice) {
    charge.invoice = {
      id: null,
      number: transaction.receipt_number,
      invoice_pdf: null,
      total: transaction.amount,
      total_excluding_tax: transaction.amount,
      total_tax_amounts: [],
      lines: [
        {
          id: null,
          amount: transaction.amount,
          currency: transaction.currency,
          description: charge.description,
          quantity: 1,
          period: {
            start: charge.created,
            end: charge.created,
          },
          type: "invoiceitem",
        },
      ],
    };
  }

  if (transaction.source?.payment_method_details) {
    const payment_method_type = transaction.source.payment_method_details.type;
    const payment_method =
      transaction.source.payment_method_details[payment_method_type];

    if (payment_method_type === "card") {
      charge.payment_method = {
        exp_year: payment_method.exp_year,
        exp_month: payment_method.exp_month,
        network: payment_method.network,
        last4: payment_method.last4,
      };

      if (
        charge.billing_details.address &&
        !charge.billing_details.address.country
      ) {
        const country = getCountryData(payment_method.country);
        charge.billing_details.address.country = country.name;
      }
    } else {
      errors.push({
        error: `unhandled payment method: ${payment_method_type}`,
        payment_method,
      });
    }
  }

  return { charge, errors };
}

export const knownTransactionTypes = [
  "charge",
  "payout",
  "stripe_fee",
  "payment",
];

export async function fetchBalanceTransactions(stripe, period) {
  const taxesAndFees = {
    tax: [],
    stripe_fee: [],
    application_fee: [],
  };

  const rawTransactions = [];
  const unknownTransactions = [];

  const payouts = [];
  const charges = [];

  const totals = {
    errors: 0,
    unavailable_transactions: 0,
    pending_transactions: 0,
    payouts_gross: 0,
    payouts_net: 0,
    payouts_fees: 0,
    stripe_fees: 0,
    charge_gross: 0,
    charge_net: 0,
    charge_fees: 0,
    charge_stripe_fees: 0,
    charge_application_fees: 0,
    charge_tax_fees: 0,
  };

  for await (const transaction of stripe.balanceTransactions.list({
    created: {
      gte: period.start.valueOf() / 1000,
      lt: period.end.valueOf() / 1000,
    },
    expand: [
      // basic data for all balance transactions:
      "data.source",
      // data for charges:
      "data.source.customer",
      "data.source.invoice",
      // data for payouts:
      "data.source.destination",
    ],
  })) {
    rawTransactions.push(transaction);

    // ignore pending transactions, but record a count:
    if (transaction.status === "pending") {
      totals.pending_transactions++;
      continue;
    }

    // ignore other transaction status, but log:
    if (transaction.status !== "available") {
      totals.unavailable_transactions++;
      continue;
    }

    // Log for unhandled transaction types:
    if (!knownTransactionTypes.includes(transaction.type)) {
      console.warn(
        `Unknown transaction type: ${transaction.type}, id: ${transaction.id}`
      );
      unknownTransactions.push(transaction);
      continue;
    }

    // debug(transaction);

    // Calculate data:
    if (transaction.type === "stripe_fee") {
      totals.stripe_fees += transaction.amount * -1;
    }

    if (transaction.type === "payout") {
      // Payouts are negative, but I expect the fees to be positive on them:
      totals.payouts_gross += transaction.amount * -1;
      totals.payouts_net += transaction.net * -1;
      totals.payouts_fees += transaction.fee;

      payouts.push({
        transaction_id: transaction.id,
        id: transaction.source.id,
        amount: transaction.amount,
        fee: transaction.fee,
        currency: transaction.currency,
        status: transaction.status,
        created: new Date(transaction.created * 1000),
        available_on: new Date(transaction.available_on * 1000),
        arrival_date: new Date(transaction.source.available_on * 1000),
      });
    }

    // TODO: Implement payment type:
    if (transaction.type === "payment") {
      debug("transaction", transaction);
    }

    if (transaction.type === "charge") {
      // Calculate individual fee type totals:
      transaction.fee_details.forEach((fee) => {
        if (fee.type === "stripe_fee") {
          totals.charge_stripe_fees += fee.amount;
        } else if (fee.type === "application_fee") {
          totals.charge_application_fees += fee.amount;
        } else {
          totals.charge_tax_fees += fee.amount;
        }

        taxesAndFees[fee.type].push({
          transaction_id: transaction.id,
          charge_id: transaction.source.id,
          amount: fee.amount,
          currency: fee.currency,
          description: fee.description,
          created: new Date(transaction.created * 1000),
          available_on: new Date(transaction.available_on * 1000),
        });
      });

      try {
        const { charge, errors } = processCharge(transaction);

        if (errors.length) {
          console.error(errors);
        }

        charges.push(charge);
      } catch (err) {
        console.error(err);
        debug("transaction", transaction);
      }

      totals.charge_fees += transaction.fee;
      totals.charge_gross += transaction.amount;
      totals.charge_net += transaction.net;
    }
  }

  return {
    rawTransactions,
    unknownTransactions,
    totals,
    taxesAndFees,
    payouts,
    charges,
  };
}
