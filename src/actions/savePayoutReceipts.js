import { join as joinPath } from "node:path";
import { writeFile } from "node:fs/promises";
import { mkdirp } from "fs-extra";

import { fetchBalanceTransactions, fetchPayouts } from "../stripe.js";
import { debug } from "../utils.js";
import { formatDate, formatIsoDate, sortByCreated } from "../date-fns.js";
import Invoice, { prettyPrice } from "../generators/invoice.js";

function createReceipt(payout, payoutNumber) {
  return new Invoice({
    data: {
      invoice: {
        name: "Payout",
        header: [
          {
            label: "Payout Number",
            value: payoutNumber,
          },
          {
            label: "Payout ID",
            value: payout.id,
          },
          {
            label: "Payout Date",
            value: formatDate(payout.created * 1000, true),
          },
        ],

        currency: payout.currency.toUpperCase(),

        details: {
          header: [
            {
              value: "Description",
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

function subItemFor(tx) {
  if (tx.type === "refund") {
    return {
      description: `Refund: ${tx.charge_id}`,
      date: formatIsoDate(tx.available_on),
      price: tx.amount,
    };
  }
  if (tx.type === "charge") {
    return {
      description: tx.invoice.id
        ? `Subscription: ${tx.customer.name ?? tx.customer.email}, ${
            tx.invoice.number
          }`
        : `Payment: ${tx.customer.name ?? tx.customer.email}`,
      date: formatIsoDate(tx.available_on),
      price: tx.amount,
    };
  } else if (
    tx.type === "application_fee" ||
    tx.type === "passthrough_fee" ||
    tx.type === "stripe_fee"
  ) {
    let description = tx.description.replace(/\sfee$/, " fees");

    return {
      description,
      date: tx.created ? formatIsoDate(tx.created) : null,
      price: tx.amount * -1,
    };
  } else if (tx.type === "stripe_billing_fee") {
    let description = tx.description;

    return {
      description,
      date: tx.created ? formatIsoDate(tx.created) : null,
      price: tx.amount * -1,
    };
  } else {
    console.error(tx);
    process.exit(1);
    return null;
  }
}

function getLineItemType(txType, tx) {
  if (txType === "refund") {
    return "refund";
  } else if (txType === "charge") {
    return "charge";
  } else if (
    txType === "application_fee" ||
    txType === "passthrough_fee" ||
    txType === "stripe_fee"
  ) {
    return "fees";
  } else if (txType === "stripe_billing_fee") {
    return "stripe_billing_fee";
  } else {
    console.error(txType, tx);
    process.exit(1);
  }
}

function payoutLineItems(transactions) {
  return transactions
    .reduce((txs, tx) => {
      console.log(tx);
      if (tx.type === "refund") {
        txs.push(tx);
        return txs;
      }

      if (tx.type === "charge") {
        txs.push(tx);
        return txs;
      }

      if (
        tx.description.startsWith("Billing - Usage Fee") ||
        tx.description.startsWith("Post Payment Invoices")
      ) {
        tx.type = "stripe_billing_fee";
        txs.push(tx);
        return txs;
      }

      if (
        tx.description.startsWith("Billing") &&
        tx.description.includes("Subscriptions")
      ) {
        const date = tx.description.match(/(\d{4}-\d{2}-\d{2})/)[1];
        tx.type = "stripe_billing_fee";
        tx.description = `Billing - Subscriptions (${date})`;
        txs.push(tx);
        return txs;
      }

      if (
        tx.type === "application_fee" ||
        tx.type === "stripe_fee" ||
        tx.type === "passthrough_fee"
      ) {
        const prev = txs.findIndex(
          (stx) => stx.type === tx.type && stx.description === tx.description
        );
        if (prev > -1) {
          txs[prev] = {
            ...txs[prev],
            amount: txs[prev].amount + tx.amount,
          };
          return txs;
        } else {
          txs.push({ ...tx, amount: tx.amount });
          return txs;
        }
      }

      txs.push(tx);

      return txs;
    }, [])
    .reduce((lineItems, tx) => {
      const type = getLineItemType(tx.type, tx);
      const existingIdx = lineItems.findIndex(
        (lineItem) => lineItem.type == type
      );
      const existing = existingIdx !== -1 ? lineItems[existingIdx] : null;

      if (existing) {
        lineItems[existingIdx] = {
          ...lineItems[existingIdx],
          subitems: [...existing.subitems, subItemFor(tx)],
          amount: existing.amount + tx.amount,
        };
      } else {
        let description = "";
        switch (type) {
          case "charge":
            description = "Charge";
            break;
          case "fees":
            description = "Fees";
            break;
          case "stripe_billing_fee":
            description = "Stripe Billing Fees";
            break;
          case "refund":
            description = "Refunds";
            break;
          default:
            description = tx.description;
        }

        const lineItem = {
          type,
          description,
          subitems: [subItemFor(tx)],
          amount: tx.amount,
        };

        lineItems.push(lineItem);
      }

      return lineItems;
    }, [])
    .map((lineItem) => {
      return [
        {
          // We add a space after the € sign as otherwise it makes the text hard to read:
          value: lineItem.description,
          subitems: lineItem.subitems.filter((item) => !!item),
        },
        {
          value:
            lineItem.type === "charge" || lineItem.type === "refund"
              ? lineItem.amount
              : lineItem.amount * -1,
          price: true,
        },
      ];
    });
}

async function savePayoutReceipt(
  payout,
  transactions,
  { payoutsDir, payoutNumber },
  config
) {
  debug(`payout ${payoutNumber}`, payout);
  debug("payout.transactions", transactions);

  return createReceipt(payout, payoutNumber)
    .generate({
      lineItems: payoutLineItems(transactions),
      totals: [
        {
          label: "Payout",
          value: payout.amount,
          price: true,
        },
      ],
    })
    .then((pdf) => {
      return writeFile(joinPath(payoutsDir, `${payoutNumber}.pdf`), pdf);
    });
}

// TODO: Implement this action
//
// This can be handled by doing a payouts list in the time period, and then
// for each payout calling the balance_transactions API and specifying the
// payout with the given Payout ID.
//
// stripe payouts list --api-key $API_KEY
// for each $payout:
//    stripe balance_transactions list --payout $payout.id --api-key $API_KEY
//

export default async function savePayoutReceipts(
  stripe,
  account,
  period,
  config
) {
  // Ensure the output directory exists:
  const payoutsDir = joinPath(config.output.directory, "payouts");
  await mkdirp(payoutsDir);

  const payouts = await fetchPayouts(stripe, period);

  const receipts = payouts.map(async (payout, index) => {
    const payoutDate = Intl.DateTimeFormat("fr-CA", {
      year: "numeric",
      month: "2-digit",
    }).format(payout.created * 1000);

    const payoutNumber = `${payoutDate}-${account.toUpperCase()}-${String(
      index + 1
    ).padStart(4, "0")}`;

    const payoutTransactions = await fetchBalanceTransactions(stripe, {
      filterByPayout: payout.id,
    });

    if (payoutTransactions.totals.errors > 0) {
      payoutTransactions.results.errors.forEach((err) => {
        console.log({ payoutId: payout.id, error: err });
      });
      process.exit(1);
      return;
    }

    // console.log(JSON.stringify(payoutTransactions.results, null, 2));

    const transactions = sortByCreated([
      ...payoutTransactions.results.charges,
      ...payoutTransactions.results.refunds,
      ...payoutTransactions.results.taxes,
      ...payoutTransactions.results.stripe_fees,
      ...payoutTransactions.results.passthrough_fees,
      ...payoutTransactions.results.application_fees,
    ]);

    return await savePayoutReceipt(
      payout,
      transactions,
      {
        payoutsDir,
        payoutNumber,
      },
      config
    );
  });

  await Promise.all(receipts);
}
