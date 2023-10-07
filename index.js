import prompts from "prompts";

import configuration from "./src/configuration.js";
import { getMonthChoices, formatPeriod } from "./src/date-fns.js";
import { getStripeClients } from "./src/stripe.js";

import downloadSubscriptionInvoices from "./src/actions/downloadSubscriptionInvoices.js";
import createAndSaveReceipts from "./src/actions/createAndSaveReceipts.js";

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
    {
      type: "select",
      name: "action",
      message: "What would you like to do?",
      choices: [
        {
          title: "Create & Save Receipts",
          value: "createAndSaveReceipts",
        },
        {
          title: "Download Subscription Invoices",
          value: "downloadSubscriptionInvoices",
        },
      ],
    },
  ]);

  if (!responses.account || !responses.period) {
    console.log("\nInterrupted, okay, bye!");
    return process.exit(0);
  }

  console.log(
    `\nOkay processing ${responses.account} for ${formatPeriod(
      responses.period
    )}\n`
  );

  const accountName = responses.account;
  const stripe = stripeClients[accountName];

  if (responses.action === "createAndSaveReceipts") {
    await createAndSaveReceipts(
      stripe,
      responses.account,
      responses.period,
      config
    );
  } else if (responses.action === "downloadSubscriptionInvoices") {
    await downloadSubscriptionInvoices(
      stripe,
      responses.account,
      responses.period
    );
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
