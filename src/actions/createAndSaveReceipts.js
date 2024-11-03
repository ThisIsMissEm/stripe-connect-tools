import { join as joinPath } from "node:path";
import { writeFile } from "node:fs/promises";
import { mkdirp } from "fs-extra";

import { getTaxLaw, validateTaxLaw } from "../taxation.js";
import Invoice from "../generators/invoice.js";
import { formatDate, formatPeriod } from "../date-fns.js";
import { fetchBalanceTransactions } from "../stripe.js";
import { debug } from "../utils.js";

function getAddresses(billing_details, business) {
  const customerAddress = [
    billing_details.name ?? billing_details.email,
    billing_details.address?.line1,
    billing_details.address?.line2,
    `${billing_details.address?.postal_code ?? ""} ${
      billing_details.address?.city ?? ""
    }`.trim(),
    billing_details.address?.state,
    billing_details.address?.country,
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
            label: "Charge ID",
            value: charge.id,
          },
          {
            label: "Charge Date",
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
          label: "Total Paid",
          value: charge.invoice.total,
          price: true,
        },
      ]
    : [
        {
          label: "Total Paid",
          value: charge.invoice.total,
          price: true,
        },
      ];

  const legal = [];
  if (!hasTax) {
    legal.push({
      value: taxLaw.smallBusinessStatement + "\n",
      weight: "bold",
      color: "primary",
    });
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
export default async function createAndSaveReceipts(
  stripe,
  account,
  period,
  config
) {
  validateTaxLaw(config);

  const balanceTransactions = await fetchBalanceTransactions(stripe, {
    period,
  });

  if (balanceTransactions.totals.errors > 0) {
    balanceTransactions.results.errors.forEach((err) => {
      console.log({ error: err });
    });
    process.exit(1);
    return;
  }

  // Ensure the output directory exists:
  const receiptDir = joinPath(config.output.directory, "receipts");
  await mkdirp(receiptDir);

  // For each charge, create a receipt:
  const receipts = balanceTransactions.results.charges
    // Stripe returns reverse chronological, resulting in incorrect receipt numbers
    .sort((a, b) => {
      if (a.created < b.created) {
        return -1;
      } else if (a.created > b.created) {
        return 1;
      } else {
        return 0;
      }
    })
    .map((charge, index) => {
      const receiptDate = Intl.DateTimeFormat("fr-CA", {
        year: "numeric",
        month: "2-digit",
      }).format(charge.created);

      const receiptNumber = `${account.toUpperCase()}-${receiptDate}-${String(
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
}
