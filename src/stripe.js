import Stripe from "stripe";
import { getCountryData } from "countries-list";
import { debug } from "./utils.js";
import { sortByCreated } from "./date-fns.js";

export function getStripeTokens() {
  const tokens = new Map();
  Object.keys(process.env).forEach((key) => {
    if (key.startsWith("STRIPE_TOKEN_")) {
      const account = key.slice(13).toLowerCase();
      const secret = process.env[key];

      tokens.set(account, secret);
    }
  });

  return tokens;
}

export function getStripeClient(secret) {
  return new Stripe(secret, {
    apiVersion: "2023-10-16",
  });
}

/**
 * Processes a single charge to try to get consistently shaped metadata
 * @param {any} transaction
 */
function processCharge(transaction) {
  const txCharge = transaction.source;

  const errors = [];
  const charge = {
    // FIXME: both payments and charges are processed with this method, so type
    // of "charge" isn't actually correct, but fixing requires fixing the
    // grouping logic on payout receipts, which is too complicated to fix right
    // now.
    type: "charge",
    transaction_id: transaction.id,
    id: sourceId(transaction),
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
          email: txCharge.customer.email ?? txCharge.billing_details.email,
          name: txCharge.customer.name ?? txCharge.billing_details.name,
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

  if (charge.customer === null) {
    charge.customer = {
      id: null,
      name: charge.billing_details.name,
      email: charge.billing_details.email,
      address: {},
    };
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
        type: payment_method_type,
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
    } else if (payment_method_type === "link") {
      if (
        charge.billing_details.address &&
        !charge.billing_details.address.country
      ) {
        const country = getCountryData(payment_method.country);
        charge.billing_details.address.country = country.name;
      }
    } else if (payment_method_type === "paypal") {
      charge.payment_method = {
        type: payment_method_type,
        payer_email: payment_method.payer_email,
        payer_id: payment_method.payer_id,
        payer_name: payment_method.payer_name,
        transaction_id: payment_method.transaction_id,
      };
    } else if (payment_method_type === "sepa_debit") {
      charge.payment_method = {
        type: payment_method_type,
        bank_code: payment_method.bank_code,
        branch_code: payment_method.branch_code,
        country: payment_method.country,
        fingerprint: payment_method.fingerprint,
        last4: payment_method.last4,
        mandate: payment_method.mandate,
      };
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
  "refund",
  "payout",
  "stripe_fee",
  "payment",
];

const feeTypeMap = {
  // Used by PayPal, in Stripe this is payment_method_passthrough_fee
  passthrough_fee: "passthrough_fees",
  application_fee: "application_fees",
  stripe_fee: "stripe_fees",
  tax: "taxes",
};

function sourceId(transaction) {
  if (typeof transaction.source === "object" && transaction.source !== null) {
    return transaction.source.id;
  } else {
    return transaction.source;
  }
}

/**
 * @typedef FetchBalanceTransactionFilters
 * @property {string} [filterByType]
 * @property {string} [filterByPayout]
 * @property {import("./date-fns.js").Period} [period]
 */

/**
 * @typedef Payout
 * @property {string} type
 * @property {string} transaction_id
 * @property {string} id
 * @property {number} amount
 * @property {number} fee
 * @property {string} currency
 * @property {string} status
 * @property {Date} created
 * @property {Date} available_on
 * @property {Date | null} arrival_date
 */

/**
 * @typedef Results
 * @property {string[]} warnings
 * @property {string[]} errors
 * @property {Payout[]} payouts
 * @property {object[]} charges
 * @property {object[]} refunds
 * @property {object[]} taxes
 * @property {object[]} stripe_fees
 * @property {object[]} passthrough_fees
 * @property {object[]} application_fees
 */

/**
 * @typedef Totals
 * @property {number} errors
 * @property {number} unavailable_transactions
 * @property {number} pending_transactions
 * @property {number} payouts_gross
 * @property {number} payouts_net
 * @property {number} payouts_fees
 * @property {number} stripe_fees
 * @property {number} charge_gross
 * @property {number} charge_net
 * @property {number} charge_fees
 * @property {number} charge_stripe_fees
 * @property {number} charge_application_fees
 * @property {number} charge_passthrough_fees
 * @property {number} charge_tax_fees
 */

/**
 * @typedef BalanceTransactionResults
 * @property {Results} results
 * @property {Totals} totals
 * @property {import("stripe").Stripe.BalanceTransaction[]} rawTransactions
 * @property {import("stripe").Stripe.BalanceTransaction[]} unknownTransactions
 */

/**
 * Fetches balance transactions from Stripe and formulates data for them
 * @param {Stripe} stripe
 * @param {FetchBalanceTransactionFilters} [filterOptions]
 * @returns {Promise<BalanceTransactionResults>}
 */
export async function fetchBalanceTransactions(stripe, filterOptions) {
  /** @type {Results} */
  const results = {
    taxes: [],
    stripe_fees: [],
    passthrough_fees: [],
    application_fees: [],
    payouts: [],
    charges: [],
    refunds: [],
    errors: [],
    warnings: [],
  };

  const rawTransactions = [];
  const unknownTransactions = [];

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
    charge_passthrough_fees: 0,
    charge_tax_fees: 0,
  };

  const requestOptions = {
    expand: [
      // basic data for all balance transactions:
      "data.source",
      // data for charges:
      "data.source.customer",
      "data.source.invoice",
      // data for payouts:
      "data.source.destination",
    ],
  };

  if (typeof filterOptions === "object") {
    if (filterOptions.filterByType) {
      requestOptions.type = filterOptions.filterByType;
    } else if (filterOptions.filterByPayout) {
      requestOptions.payout = filterOptions.filterByPayout;
    }

    if (filterOptions.period) {
      requestOptions.created = {
        gte: filterOptions.period.start.valueOf() / 1000,
        lt: filterOptions.period.end.valueOf() / 1000,
      };
    }
  }

  for await (const transaction of stripe.balanceTransactions.list(
    requestOptions
  )) {
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
      results.warnings.push(
        `Unknown transaction type: ${transaction.type}, id: ${transaction.id}`
      );
      unknownTransactions.push(transaction);
      continue;
    }

    // debug(transaction);
    if (transaction.type === "refund") {
      results.refunds.push({
        type: "refund",
        transaction_id: transaction.id,
        charge_id: sourceId(transaction),
        amount: transaction.amount,
        currency: transaction.currency,
        description: transaction.description,
        created: new Date(transaction.created * 1000),
        available_on: new Date(transaction.available_on * 1000),
      });
    }

    // Calculate data:
    if (transaction.type === "stripe_fee") {
      totals.stripe_fees += transaction.amount * -1;

      results.stripe_fees.push({
        type: "stripe_fee",
        transaction_id: transaction.id,
        charge_id: sourceId(transaction),
        amount: transaction.amount * -1,
        currency: transaction.currency,
        description: transaction.description,
        created: new Date(transaction.created * 1000),
        available_on: new Date(transaction.available_on * 1000),
      });
    }

    if (
      transaction.type === "payout" &&
      typeof transaction.source === "object" &&
      transaction.source !== null
    ) {
      // Payouts are negative, but I expect the fees to be positive on them:
      totals.payouts_gross += transaction.amount * -1;
      totals.payouts_net += transaction.net * -1;
      totals.payouts_fees += transaction.fee;

      let arrival_date = null;
      // @ts-ignore
      if (typeof transaction.source?.arrival_date === "number") {
        // @ts-ignore
        arrival_date = new Date(transaction.source.arrival_date * 1000);
      }

      results.payouts.push({
        type: "payout",
        transaction_id: transaction.id,
        id: sourceId(transaction),
        amount: transaction.amount * -1,
        fee: transaction.fee,
        currency: transaction.currency,
        status: transaction.status,
        created: new Date(transaction.created * 1000),
        available_on: new Date(transaction.available_on * 1000),
        arrival_date,
      });
    }

    // // TODO: Implement payment type:
    // if (transaction.type === "payment") {
    //   debug("transaction", transaction);
    // }

    if (transaction.type === "charge" || transaction.type === "payment") {
      // Calculate individual fee type totals:
      transaction.fee_details.forEach((fee) => {
        // Normalize fee type:
        const fee_type =
          fee.type === "payment_method_passthrough_fee"
            ? "passthrough_fee"
            : fee.type;

        if (fee_type === "stripe_fee") {
          totals.charge_stripe_fees += fee.amount;
        } else if (fee_type === "application_fee") {
          totals.charge_application_fees += fee.amount;
        } else if (fee_type === "passthrough_fee") {
          totals.charge_passthrough_fees += fee.amount;
        } else {
          totals.charge_tax_fees += fee.amount;
        }

        let resultType = feeTypeMap[fee_type];

        results[resultType].push({
          type: fee_type,
          transaction_id: transaction.id,
          charge_id: sourceId(transaction),
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
          errors.forEach((err) => results.errors.push(err.error));
        }

        results.charges.push(charge);
      } catch (err) {
        results.errors.push(err);
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
    results,
  };
}

/**
 *
 * @param {Stripe} stripe
 * @param {import("./date-fns.js").Period} period
 */
export async function fetchPayouts(stripe, period) {
  const payouts = [];

  for await (const payout of stripe.payouts.list({
    arrival_date: {
      gte: period.start.valueOf() / 1000,
      lte: period.end.valueOf() / 1000,
    },
  })) {
    payouts.push(payout);
  }

  return sortByCreated(payouts);
}
