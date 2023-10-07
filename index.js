import Stripe from "stripe";
import prompts from "prompts";
import { createWriteStream } from "node:fs";
import { writeFile } from "node:fs/promises";
import { mkdirp } from "fs-extra";
import { Readable } from "node:stream";
import { finished } from "node:stream/promises";
import { join as joinPath } from "node:path";
import { getCountryData } from "countries-list";
import { render } from "prettyjson";

import { temporaryFile } from "tempy";

import configuration from "./src/configuration.js";
import { getMonthChoices, formatPeriod, formatDate } from "./src/date-fns.js";
import Invoice from "./src/invoice.js";

function getStripeClients() {
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

// Turns out the strip API client supports async iterators and I didn't need to
// write one, I just missed it in the documentation
//
// async function* balanceTransactions(client, period, sinceId) { const
//   transactions = await client.balanceTransactions.list({ created: { gte:
//   Math.floor(period.start.valueOf() / 1000), lte:
//   Math.ceil(period.end.valueOf() / 1000),
//     },
//     starting_after: sinceId ?? undefined,
//     expand: ["data.source"],
//   });
//
//   for (const tx of transactions.data) {
//     yield tx;
//   }
//
//   if (transactions.has_more) {
//     yield* balanceTransactions(client, period, transactions.data.at(-1).id);
//   }
// }
function debug(type, object) {
  console.log(`\n\n${type}:\n${render(object)}\n\n`);
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

const TAX_LAWS = {
  germany: {
    smallInvoiceLimit: 25000,
    smallBusinessStatement:
      "In accordance with Section 19 UStG, this invoice does not include VAT.",
  },
};

function validateTaxLaw(config) {
  const country = config.business.country.toLowerCase();
  if (!TAX_LAWS.hasOwnProperty(country)) {
    console.error(
      `This tool currently only supports the following tax laws:\n${Object.keys(
        TAX_LAWS
      )
        .map((country) => ` - ${country}`)
        .join("\n")}\n`
    );

    process.exit(1);
  }
}

function getTaxLaw(config) {
  const country = config.business.country.toLowerCase();
  return TAX_LAWS[country];
}

function getAddresses(billing_details, business) {
  const customerAddress = [
    billing_details.name ?? billing_details.email,
    billing_details.address.line1,
    billing_details.address.line2,
    `${billing_details.address.postal_code ?? ""} ${
      billing_details.address.city ?? ""
    }`.trim(),
    billing_details.address.state,
    billing_details.address.country,
  ].filter((v) => !!v);

  const businessAddress = [
    business.address_line_1,
    business.address_line_2,
    `${business.postal_code} ${business.city}`.trim(),
    business.state,
    business.country,
    "\n",
  ].filter((v) => !!v);

  // Ensure the customer email ends up on the same line as the business email:
  let customerAddressEmptyLines =
    businessAddress.length - customerAddress.length;

  while (customerAddressEmptyLines--) {
    customerAddress.push("\n");
  }

  return { customerAddress, businessAddress };
}

function createReceipt(charge, receiptNumber) {
  return new Invoice({
    data: {
      invoice: {
        name: "Receipt",
        header: [
          {
            label: "Receipt Number",
            value: receiptNumber,
          },
          {
            label: "Issue Date",
            // @ts-ignore
            value: formatDate(charge.created, true),
          },
          {
            label: "Due Date",
            // @ts-ignore
            value: formatDate(charge.created, true),
          },
        ],

        currency: charge.currency.toUpperCase(),

        details: {
          header: [
            {
              value: "Description",
            },
            {
              value: "Quantity",
            },
            {
              value: "Amount",
            },
          ],
        },
      },
    },
  });
}

// @ts-ignore
async function createAndSaveReceipt(
  charge,
  { receiptNumber, receiptDir },
  config
) {
  debug("createAndSaveReceipt", charge);

  const taxLaw = getTaxLaw(config);
  // const isSmallInvoice =
  //   charge.amount < taxLaw.smallInvoiceLimit && charge.currency === "eur";

  // TODO: Validate if this is correct; I'm not sure as I currently don't charge VAT.
  const hasTax = charge.invoice.total !== charge.invoice.total_excluding_tax;

  const totals = hasTax
    ? [
        {
          label: "Subtotal",
          value: charge.invoice.total_excluding_tax,
          price: true,
        },
        {
          label: "VAT",
          value: charge.invoice.total - charge.invoice.total_excluding_tax,
          price: true,
        },
        {
          label: "Total",
          value: charge.invoice.total,
          price: true,
        },
      ]
    : [
        {
          label: "Total",
          value: charge.invoice.total,
          price: true,
        },
      ];

  const legal = [];
  if (!hasTax) {
    legal.push({
      value: taxLaw.smallBusinessStatement,
      weight: "bold",
      color: "primary",
    });
    // Additional new line:
    legal.push({ value: " " });
  }

  if (charge.invoice.id) {
    legal.push({
      value: `Invoice Reference: ${charge.invoice.id}`,
      weight: "normal",
      color: "primary",
    });
    legal.push({
      value: `To request a copy of the invoice, please email: ${config.business.email}`,
      weight: "normal",
      color: "primary",
    });
  }

  const { businessAddress, customerAddress } = getAddresses(
    charge.billing_details,
    config.business
  );

  return createReceipt(charge, receiptNumber)
    .setBusiness([
      {
        label: config.business.name,
        value: businessAddress,
      },
      {
        label: "Tax Identifier",
        value: config.business.tax_identifier,
      },
    ])
    .setCustomer([
      {
        label: "Customer",
        value: customerAddress,
      },
      {
        label: "Email Address",
        value: charge.billing_details.email,
      },
      // TODO: VAT Info if necessary
    ])
    .generate({
      legal,
      lineItems: charge.invoice.lines.map((lineItem) => {
        return [
          {
            // We add a space after the € sign as otherwise it makes the text hard to read:
            value: lineItem.description.replaceAll("€", "€ "),
            subtext:
              lineItem.period.start !== lineItem.period.end
                ? formatPeriod(lineItem.period, true)
                : "",
          },
          {
            value: 1,
          },
          {
            value: lineItem.amount,
            price: true,
          },
        ];
      }),
      totals,
    })
    .then((pdf) => {
      return writeFile(joinPath(receiptDir, `${receiptNumber}.pdf`), pdf);
    });
}

// @ts-ignore
async function fetchBalanceTransactions(stripe, account, period) {
  // const spinner = ora({
  //   text: "Fetching transactions...",
  //   spinner: "bouncingBar",
  //   color: "yellow",
  // }).start();

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

  const knownTransactionTypes = ["charge", "payout", "stripe_fee", "payment"];

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
      // debug("transaction", transaction);
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
        // debug("charge", charge);

        charges.push(charge);
      } catch (err) {
        console.error(err);
        // debug("transaction", transaction);
      }

      totals.charge_fees += transaction.fee;
      totals.charge_gross += transaction.amount;
      totals.charge_net += transaction.net;
    }
  }

  // console.log("\n\n\n-------------------------------------\n\n\n");

  // console.log(JSON.stringify(rawTransactions, null, 2));

  // spinner.succeed();
  // console.log("\n");
  // console.log(taxesAndFees);
  // console.log(totals);

  // console.log(charges);

  // console.log({ unknownTransactions });

  return {
    rawTransactions,
    unknownTransactions,
    totals,
    taxesAndFees,
    payouts,
    charges,
  };
}

// @ts-ignore
async function downloadChargeInvoices(stripe, accountName, period) {
  // @ts-ignore
  const promises = [];

  for await (const charge of stripe.charges.list({
    created: {
      gte: period.start.valueOf() / 1000,
      lt: period.end.valueOf() / 1000,
    },
    expand: ["data.customer"],
  })) {
    // Skip unsuccessful charges:
    if (charge.status !== "succeeded") {
      continue;
    }

    // Skip any with invoices, as we should capture those from downloadSubscriptionInvoices
    if (charge.invoice !== null) {
      continue;
    }

    console.log(charge);

    // fr-CA produces YYYY-MM-DD format dates:
    // const formattedDate = Intl.DateTimeFormat("fr-CA", {
    //   year: "numeric",
    //   month: "2-digit",
    //   day: "2-digit",
    // }).format(new Date(invoice.created * 1000));
    // Because Ko-fi doesn't collect the darn customer's country:
    // const country =
    //   invoice.customer_address?.country ||
    //   invoice.charge?.billing_details?.address?.country ||
    //   invoice.charge?.payment_method_details?.card?.country;
    // const invoiceUrl = invoice.invoice_pdf;
    // const invoiceFilename = `${formattedDate}-${accountName}-${invoice.number}-${country}.pdf`;
    // const invoicePdf = await fetch(invoiceUrl, { redirect: "follow" });
    // if (
    //   !invoicePdf.ok ||
    //   !invoicePdf.body ||
    //   invoicePdf.headers.get("Content-Type") !== "application/octet-stream"
    // ) {
    //   console.error(`Could not download invoice PDF: ${invoice.id}`);
    //   console.error(invoicePdf);
    //   continue;
    // }
    // const destination = joinPath(process.cwd(), "downloads", invoiceFilename);
    // const fileStream = createWriteStream(destination, { flags: "wx" });
    // promises.push(finished(Readable.fromWeb(invoicePdf.body).pipe(fileStream)));
  }

  // await Promise.allSettled(promises);
}

async function downloadSubscriptionInvoices(stripe, accountName, period) {
  const promises = [];

  for await (const invoice of stripe.invoices.list({
    created: {
      gte: period.start.valueOf() / 1000,
      lt: period.end.valueOf() / 1000,
    },
    expand: ["data.customer", "data.charge"],
    status: "paid",
  })) {
    // fr-CA produces YYYY-MM-DD format dates:
    const formattedDate = Intl.DateTimeFormat("fr-CA", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(invoice.created * 1000));

    // Because Ko-fi doesn't collect the darn customer's country:
    const country =
      invoice.customer_address?.country ||
      invoice.charge?.billing_details?.address?.country ||
      invoice.charge?.payment_method_details?.card?.country;

    const invoiceUrl = invoice.invoice_pdf;
    const invoiceFilename = `${formattedDate}-${accountName}-${invoice.number}-${country}.pdf`;

    const invoicePdf = await fetch(invoiceUrl, { redirect: "follow" });

    if (
      !invoicePdf.ok ||
      !invoicePdf.body ||
      invoicePdf.headers.get("Content-Type") !== "application/octet-stream"
    ) {
      console.error(`Could not download invoice PDF: ${invoice.id}`);
      console.error(invoicePdf);

      continue;
    }

    const destination = joinPath(process.cwd(), "downloads", invoiceFilename);

    const fileStream = createWriteStream(destination, { flags: "wx" });
    // @ts-ignore
    promises.push(finished(Readable.fromWeb(invoicePdf.body).pipe(fileStream)));
  }

  await Promise.allSettled(promises);
}

async function main() {
  // 1. Fetch all STRIPE_TOKEN_XXXX environment variables
  const [stripeClients, stripeAccounts] = getStripeClients();
  const config = configuration.getProperties();

  if (stripeAccounts.length < 1) {
    console.log(
      "No stripe credentials found, please make sure you set them in .env as STRIPE_TOKEN_[name]\nIf you're using 1password, make sure the credential has a value."
    );
    process.exit(1);
  }

  // 2. Prompt for which account and time period to fetch data for:
  const responses = await prompts([
    {
      type: "select",
      name: "period",
      message: "Select the period to create query for?",
      choices: getMonthChoices(),
    },
    {
      type: "select",
      name: "account",
      message: "Please select which Stripe account to use:",
      choices: stripeAccounts.sort().map((account) => ({
        title: account,
        value: account,
      })),
    },
    // {
    //   type: "select",
    //   name: "action",
    //   message: "What would you like to do?",
    //   choices: [
    //     { title: "Download Invoices", value: "downloadSubscriptionInvoices" },
    //     {
    //       title: "Download Charge (Donation) Invoices",
    //       value: "downloadChargeInvoices",
    //     },
    //     {
    //       title: "Fetch Transactions Report",
    //       value: "fetchTransactionsReport",
    //     },
    //   ],
    // },
  ]);

  if (!responses.account || !responses.period) {
    console.log("\nInterrupted, okay, bye!");
    return process.exit(0);
  }

  // Force this action:
  // @ts-ignore
  responses.action = "createAndSaveInvoices";

  console.log(
    `\nOkay we'll fetch from ${responses.account} for ${formatPeriod(
      responses.period
    )}\n`
  );

  const accountName = responses.account;
  const stripe = stripeClients[accountName];
  const account = await stripe.accounts.retrieve();

  // @ts-ignore
  if (responses.action === "createAndSaveInvoices") {
    validateTaxLaw(config);

    const result = await fetchBalanceTransactions(
      stripe,
      account,
      responses.period
    );

    // Ensure the output directory exists:
    const receiptDir = joinPath(process.cwd(), "receipts");
    await mkdirp(receiptDir);

    // For each charge, create a receipt:
    const receipts = result.charges.map((charge, index) => {
      const receiptDate = Intl.DateTimeFormat("fr-CA", {
        year: "numeric",
        month: "2-digit",
      }).format(charge.created);

      const receiptNumber = `${responses.account.toUpperCase()}-${receiptDate}-${String(
        index + 1
      ).padStart(4, "0")}`;

      return createAndSaveReceipt(
        charge,
        {
          receiptDir,
          receiptNumber,
        },
        config
      );
    });

    await Promise.all(receipts);

    // @ts-ignore
  } else if (responses.action === "downloadSubscriptionInvoices") {
    await downloadSubscriptionInvoices(
      stripe,
      responses.account,
      responses.period
    );
    // @ts-ignore
  } else if (responses.action === "downloadChargeInvoices") {
    await downloadChargeInvoices(stripe, responses.account, responses.period);
  }
}

main()
  .then(() => {
    console.log("\nok");
    process.exit(0);
  })
  .catch((error) => {
    if (error.message.startsWith("User force closed the prompt with")) {
      console.log("\nBye!");
      process.exit(0);
    } else {
      console.error("\n");
      console.error(error);
      process.exit(1);
    }
  });
