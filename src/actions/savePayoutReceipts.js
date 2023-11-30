import { join as joinPath } from "node:path";
import { writeFile } from "node:fs/promises";
import { mkdirp } from "fs-extra";

import { fetchBalanceTransactions } from "../stripe.js";
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
            value: formatDate(payout.created, true),
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
  if (tx.type === "charge") {
    return {
      description: tx.invoice.id
        ? `Subscription: ${tx.customer.name ?? tx.customer.email}`
        : `Payment: ${tx.customer.name ?? tx.customer.email}`,
      date: formatIsoDate(tx.available_on),
      price: tx.amount,
    };
  } else if (tx.type === "stripe_fee" || tx.type === "application_fee") {
    let description = tx.description.replace(/\sfee$/, " fees");

    return {
      description,
      // date: tx.date ? formatIsoDate(tx.date) : null,
      price: tx.amount * -1,
    };
  } else {
    return null;
  }
}

function payoutLineItems(transactions) {
  return transactions
    .reduce((txs, tx) => {
      if (tx.type === "refund") {
        tx.description = "Refunds";
      }

      if (tx.description && tx.description.startsWith("Billing")) {
        tx.description = "Stripe Subscription Fees";
      }

      if (tx.type === "application_fee" || tx.type === "stripe_fee") {
        const prev = txs.findIndex(
          (stx) => stx.type === tx.type && stx.description === tx.description
        );
        if (prev > -1) {
          txs[prev] = {
            ...txs[prev],
            amount: txs[prev].amount + tx.amount,
          };
          return txs;
        }
      }

      txs.push(tx);

      return txs;
    }, [])
    .reduce((lineItems, tx) => {
      const type =
        tx.type === "charge"
          ? "charge"
          : tx.type === "refund"
          ? "refund"
          : "fees";
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
            description = "Stripe Fees";
            break;
          default:
            description = tx.description;
        }

        lineItems.push({
          type,
          description,
          subitems: [subItemFor(tx)],
          amount: tx.amount,
        });
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

  const payoutTransactions = await fetchBalanceTransactions(stripe, {
    filterByType: "payout",
    period,
  });

  // Stripe returns reverse chronological, resulting in incorrect receipt numbers
  const payouts = sortByCreated(payoutTransactions.results.payouts);

  const receipts = payouts.map(async (payout, index) => {
    const payoutDate = Intl.DateTimeFormat("fr-CA", {
      year: "numeric",
      month: "2-digit",
    }).format(payout.created);

    const payoutNumber = `${account.toUpperCase()}-${payoutDate}-${String(
      index + 1
    ).padStart(4, "0")}`;

    const payoutResult = await fetchBalanceTransactions(stripe, {
      filterByPayout: payout.id,
    });

    const transactions = sortByCreated([
      ...payoutResult.results.charges,
      ...payoutResult.results.refunds,
      ...payoutResult.results.taxes,
      ...payoutResult.results.stripe_fees,
      ...payoutResult.results.application_fees,
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
